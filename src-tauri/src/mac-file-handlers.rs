//! Public macOS APIs, called from the installed GUI application for explicit user setup.
use crate::editor_integrations::{SystemStatus, read_private, write_private};
use block2::RcBlock;
use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSBundle, NSError, NSString, NSURL};
use objc2_uniform_type_identifiers::UTType;
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const BUNDLE_ID: &str = "com.julienm.boa";

#[derive(serde::Serialize)]
pub(crate) struct ExtensionStatus {
    extensions: Vec<String>,
    configured: bool,
}

// Resolve only concrete types advertised by this bundle.
fn extension_types() -> BTreeMap<String, String> {
    autoreleasepool(|_| {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("valid bundle configuration");
        let text = UTType::typeWithIdentifier(&NSString::from_str("public.text"))
            .expect("macOS text type");
        let mut extensions = BTreeMap::new();
        for extension in config["bundle"]["fileAssociations"][0]["ext"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let Some(kind) = UTType::typeWithFilenameExtension(&NSString::from_str(extension))
            else {
                continue;
            };
            let identifier = kind.identifier().to_string();
            if matches!(
                identifier.as_str(),
                "public.text" | "public.data" | "public.content" | "public.source-code"
            ) {
                continue;
            }
            if kind.isDynamic() || kind.conformsToType(&text) || extension == "ts" {
                extensions.insert(extension.to_owned(), identifier);
            }
        }
        extensions
    })
}

fn types(extensions: &[String]) -> Result<Vec<String>, String> {
    let available = extension_types();
    let mut selected = BTreeMap::new();
    for extension in extensions {
        let identifier = available
            .get(extension)
            .ok_or("Unsupported file extension")?;
        selected.insert(identifier.clone(), ());
    }
    Ok(selected.into_keys().collect())
}

fn application(identifier: &str) -> Option<PathBuf> {
    autoreleasepool(|_| {
        let kind = UTType::typeWithIdentifier(&NSString::from_str(identifier))?;
        NSWorkspace::sharedWorkspace()
            .URLForApplicationToOpenContentType(&kind)?
            .path()
            .map(|path| PathBuf::from(path.to_string()))
    })
}

fn bundle_id(path: &Path) -> Option<String> {
    autoreleasepool(|_| {
        NSBundle::bundleWithPath(&NSString::from_str(path.to_str()?))?
            .bundleIdentifier()
            .map(|value| value.to_string())
    })
}

fn matches(path: Option<&Path>, target: Option<&Path>) -> bool {
    match (path, target) {
        (Some(path), Some(target)) => path
            .canonicalize()
            .ok()
            .zip(target.canonicalize().ok())
            .is_some_and(|(a, b)| a == b),
        _ => false,
    }
}

pub(crate) fn available(identifier: &str) -> bool {
    autoreleasepool(|_| {
        NSWorkspace::sharedWorkspace()
            .URLForApplicationWithBundleIdentifier(&NSString::from_str(identifier))
            .is_some()
    })
}

pub(crate) fn status(bundle: Option<&Path>) -> SystemStatus {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (extension, identifier) in extension_types() {
        groups.entry(identifier).or_default().push(extension);
    }
    let mut extensions: Vec<_> = groups
        .into_iter()
        .map(|(identifier, extensions)| ExtensionStatus {
            extensions,
            configured: matches(application(&identifier).as_deref(), bundle),
        })
        .collect();
    extensions.sort_by(|a, b| a.extensions.cmp(&b.extensions));
    SystemStatus { extensions }
}

async fn set_default(
    app: &tauri::AppHandle,
    bundle: &Path,
    identifier: &str,
) -> Result<(), String> {
    let path = bundle
        .to_str()
        .ok_or("Invalid BOA application path")?
        .to_owned();
    let identifier = identifier.to_owned();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        autoreleasepool(|_| {
            let Some(kind) = UTType::typeWithIdentifier(&NSString::from_str(&identifier)) else {
                let _ = send.send(Err("Unknown macOS content type".to_string()));
                return;
            };
            let application = NSURL::fileURLWithPath(&NSString::from_str(&path));
            let send = Mutex::new(Some(send));
            let completion = RcBlock::new(move |error: *mut NSError| {
                let result = if error.is_null() {
                    Ok(())
                } else {
                    // SAFETY: NSWorkspace supplies a live NSError for the duration of this callback.
                    Err(unsafe { &*error }.localizedDescription().to_string())
                };
                if let Some(send) = send.lock().ok().and_then(|mut send| send.take()) {
                    let _ = send.send(result);
                }
            });
            NSWorkspace::sharedWorkspace()
                .setDefaultApplicationAtURL_toOpenContentType_completionHandler(
                    &application,
                    &kind,
                    Some(&completion),
                );
        });
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        // Keep the application event loop free while the OS applies the preference.
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut receive = receive;
        loop {
            match receive.try_recv() {
                Ok(result) => return result,
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                    return Err("macOS setup completion was unavailable".into());
                }
                Err(_) if Instant::now() >= deadline => {
                    return Err(
                        "macOS setup timed out; verify the association before retrying".into(),
                    );
                }
                Err(_) => std::thread::sleep(Duration::from_millis(25)),
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) async fn apply(
    app: &tauri::AppHandle,
    bundle: &Path,
    backup: &Path,
    extensions: &[String],
) -> Result<(usize, Vec<String>), String> {
    if bundle_id(bundle).as_deref() != Some(BUNDLE_ID) {
        return Err("Invalid BOA application identity".into());
    }
    let selected = types(extensions)?;
    let previous = read_private(backup)?;
    let mut originals: Map<String, Value> = if previous.is_empty() {
        Map::new()
    } else {
        serde_json::from_str(&previous).map_err(|_| "Invalid file association backup")?
    };
    let pending: Vec<_> = selected
        .into_iter()
        .filter(|kind| !matches(application(kind).as_deref(), Some(bundle)))
        .collect();
    for identifier in &pending {
        let previous = application(identifier).as_deref().and_then(bundle_id);
        originals
            .entry(identifier.clone())
            .or_insert_with(|| previous.map(Value::String).unwrap_or(Value::Null));
    }
    if !pending.is_empty() {
        let next = serde_json::to_string_pretty(&originals).map_err(|error| error.to_string())?;
        write_private(
            backup,
            &next,
            if backup.exists() {
                Some(&previous)
            } else {
                None
            },
        )?;
    }
    let mut changed = 0;
    let mut failures = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    for identifier in pending {
        if Instant::now() >= deadline {
            failures.push(
                "macOS setup reached its time limit; remaining associations were not changed"
                    .into(),
            );
            break;
        }
        match set_default(app, bundle, &identifier).await {
            Ok(()) if matches(application(&identifier).as_deref(), Some(bundle)) => changed += 1,
            Ok(()) => failures.push(format!(
                "{identifier}: macOS did not confirm BOA as default"
            )),
            Err(error) => {
                failures.push(format!("{identifier}: {error}"));
                // Do not enqueue further changes after an unknown outcome or OS rejection.
                break;
            }
        }
    }
    Ok((changed, failures))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_only_resolves_requested_extensions_and_rejects_unknown_values() {
        let available = extension_types();
        for (extension, identifier) in &available {
            assert_eq!(
                types(std::slice::from_ref(extension)).unwrap(),
                vec![identifier.clone()]
            );
        }
        assert!(types(&[]).unwrap().is_empty());
        assert!(types(&["not-a-supported-extension".into()]).is_err());
        let all: Vec<_> = available.keys().cloned().collect();
        let resolved = types(&all).unwrap();
        assert_eq!(
            resolved
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            resolved.len()
        );
    }
}
