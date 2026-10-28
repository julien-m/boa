//! Public macOS APIs, called from the installed GUI application for explicit user setup.
use crate::editor_integrations::{SystemStatus, read_private, write_private};
use block2::RcBlock;
use objc2::rc::{Retained, autoreleasepool};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSBundle, NSError, NSString, NSURL};
use objc2_uniform_type_identifiers::UTType;
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    ffi::c_void,
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const BUNDLE_ID: &str = "com.julienm.boa";

type Completion = Box<dyn FnOnce(Result<(), String>) + Send>;
static CONFIRMATIONS: LazyLock<Arc<ConfirmationGate>> =
    LazyLock::new(|| Arc::new(ConfirmationGate::default()));

#[derive(Default)]
struct ConfirmationGate {
    pending: AtomicBool,
}

impl ConfirmationGate {
    fn begin(
        self: &Arc<Self>,
    ) -> Result<
        (
            Completion,
            tokio::sync::oneshot::Receiver<Result<(), String>>,
        ),
        String,
    > {
        self.pending
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(
                |_| "A macOS confirmation is still pending; answer it before applying again",
            )?;
        let (send, receive) = tokio::sync::oneshot::channel();
        let gate = Arc::clone(self);
        // Only the OS completion releases this reservation. Dropping the receiver after
        // a timeout must not permit another request while the first dialog is pending.
        Ok((
            Box::new(move |result| {
                gate.pending.store(false, Ordering::SeqCst);
                let _ = send.send(result);
            }),
            receive,
        ))
    }
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn LSRegisterURL(url: *const c_void, update: u8) -> i32;
}

fn register(bundle: &Path) -> Result<(), String> {
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(
            bundle.to_str().ok_or("Invalid BOA application path")?,
        ));
        // SAFETY: NSURL and CFURL are toll-free bridged. The retained URL lives through
        // the synchronous public Launch Services registration call.
        let result = unsafe { LSRegisterURL(Retained::as_ptr(&url).cast(), 1) };
        if result == 0 {
            Ok(())
        } else {
            Err(format!(
                "macOS could not register the installed BOA application ({result})"
            ))
        }
    })
}

struct Probes {
    _directory: tempfile::TempDir,
    paths: BTreeMap<String, PathBuf>,
}

impl Probes {
    fn new(extensions: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("boa-file-defaults-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let mut paths = BTreeMap::new();
        for extension in extensions {
            let path = directory.path().join(format!("document.{extension}"));
            std::fs::write(&path, []).map_err(|e| e.to_string())?;
            paths.insert(extension, path);
        }
        Ok(Self {
            _directory: directory,
            paths,
        })
    }
}

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

// File URL lookup also respects extension overrides written while a type was dynamic.
// A type-only query can report BOA even when a real document still opens elsewhere.
fn application(file: &Path) -> Option<PathBuf> {
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(file.to_str()?));
        NSWorkspace::sharedWorkspace()
            .URLForApplicationToOpenURL(&url)?
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

pub(crate) fn status(bundle: Option<&Path>) -> Result<SystemStatus, String> {
    let available = extension_types();
    let probes = Probes::new(available.keys().cloned())?;
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (extension, identifier) in available {
        groups.entry(identifier).or_default().push(extension);
    }
    let mut extensions: Vec<_> = groups
        .into_values()
        .map(|extensions| {
            let configured = extensions
                .iter()
                .all(|extension| matches(application(&probes.paths[extension]).as_deref(), bundle));
            ExtensionStatus {
                extensions,
                configured,
            }
        })
        .collect();
    extensions.sort_by(|a, b| a.extensions.cmp(&b.extensions));
    Ok(SystemStatus { extensions })
}

async fn set_default(
    app: &tauri::AppHandle,
    bundle: &Path,
    identifier: &str,
    timeout: Duration,
) -> Result<(), String> {
    let path = bundle
        .to_str()
        .ok_or("Invalid BOA application path")?
        .to_owned();
    let identifier = identifier.to_owned();
    let (complete, receive) = CONFIRMATIONS.begin()?;
    let dispatched = app.run_on_main_thread(move || {
        autoreleasepool(|_| {
            let Some(kind) = UTType::typeWithIdentifier(&NSString::from_str(&identifier)) else {
                complete(Err("Unknown macOS content type".to_string()));
                return;
            };
            let application = NSURL::fileURLWithPath(&NSString::from_str(&path));
            let complete = Mutex::new(Some(complete));
            let completion = RcBlock::new(move |error: *mut NSError| {
                let result = if error.is_null() {
                    Ok(())
                } else {
                    // SAFETY: NSWorkspace supplies a live NSError for the duration of this callback.
                    Err(unsafe { &*error }.localizedDescription().to_string())
                };
                if let Some(complete) = complete
                    .lock()
                    .ok()
                    .and_then(|mut complete| complete.take())
                {
                    complete(result);
                }
            });
            NSWorkspace::sharedWorkspace()
                .setDefaultApplicationAtURL_toOpenContentType_completionHandler(
                    &application,
                    &kind,
                    Some(&completion),
                );
        });
    });
    if let Err(error) = dispatched {
        // Dispatch failed before NSWorkspace was called, so no OS dialog is outstanding.
        CONFIRMATIONS.pending.store(false, Ordering::SeqCst);
        return Err(error.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Keep the application event loop free while the OS applies the preference.
        let deadline = Instant::now() + timeout.min(Duration::from_secs(15));
        let mut receive = receive;
        loop {
            match receive.try_recv() {
                Ok(result) => return result,
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                    return Err("macOS setup completion was unavailable".into());
                }
                Err(_) if Instant::now() >= deadline => {
                    return Err(
                        "macOS confirmation is still pending; answer it before applying again"
                            .into(),
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
    // Registration makes the bundled imported fallback types available on first launch.
    // Validate selection before this call; no defaults are changed by registration.
    types(extensions)?;
    let probes = Probes::new(extensions.iter().cloned())?;
    if extensions.iter().all(|extension| {
        matches(
            application(&probes.paths[extension]).as_deref(),
            Some(bundle),
        )
    }) {
        return Ok((0, vec![]));
    }
    // Do not register the bundle or enqueue more consent while an earlier request
    // is unresolved, even if its RPC already timed out.
    if CONFIRMATIONS.pending.load(Ordering::SeqCst) {
        return Err(
            "A macOS confirmation is still pending; answer it before applying again".into(),
        );
    }
    register(bundle)?;
    let available = extension_types();
    let mut selected: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for extension in extensions {
        selected
            .entry(
                available
                    .get(extension)
                    .ok_or("File type availability changed; refresh Settings")?
                    .clone(),
            )
            .or_default()
            .push(extension.clone());
    }
    let previous = read_private(backup)?;
    let mut originals: Map<String, Value> = if previous.is_empty() {
        Map::new()
    } else {
        serde_json::from_str(&previous).map_err(|_| "Invalid file association backup")?
    };
    let pending: Vec<_> = selected
        .into_iter()
        .filter(|(_, aliases)| {
            aliases.iter().any(|extension| {
                !matches(
                    application(&probes.paths[extension]).as_deref(),
                    Some(bundle),
                )
            })
        })
        .collect();
    for (identifier, aliases) in &pending {
        for extension in aliases {
            let prior = application(&probes.paths[extension])
                .as_deref()
                .and_then(bundle_id);
            let value = prior.map(Value::String).unwrap_or(Value::Null);
            originals
                .entry(format!("extension:{extension}"))
                .or_insert_with(|| value.clone());
            originals.entry(identifier.clone()).or_insert(value);
        }
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
    for (identifier, aliases) in pending {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            failures.push(
                "macOS setup reached its time limit; remaining associations were not changed"
                    .into(),
            );
            break;
        };
        // Earlier confirmations or another application may have changed the defaults
        // while this batch was waiting. Re-read before requesting consent.
        if aliases.iter().all(|extension| {
            matches(
                application(&probes.paths[extension]).as_deref(),
                Some(bundle),
            )
        }) {
            continue;
        }
        let kind = UTType::typeWithIdentifier(&NSString::from_str(&identifier));
        if kind.is_none_or(|kind| kind.isDynamic()) {
            failures.push(format!(
                "{}: macOS has not registered the installed document declarations",
                aliases
                    .iter()
                    .map(|extension| format!(".{extension}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            break;
        }
        let result = set_default(app, bundle, &identifier, remaining).await;
        let verified = aliases.iter().all(|extension| {
            matches(
                application(&probes.paths[extension]).as_deref(),
                Some(bundle),
            )
        });
        match result {
            Ok(()) if verified => changed += 1,
            Ok(()) => failures.push(format!(
                "{}: macOS did not confirm BOA as default",
                aliases.join(", ")
            )),
            Err(error) => {
                failures.push(format!("{}: {error}", aliases.join(", ")));
                // Never retry an unknown outcome or OS rejection through another mechanism.
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
    fn timeout_does_not_release_an_outstanding_os_confirmation() {
        let gate = Arc::new(ConfirmationGate::default());
        let (complete, receiver) = gate.begin().unwrap();
        // The RPC waiter can go away while the user has not answered the OS dialog.
        drop(receiver);
        assert!(gate.begin().is_err());
        complete(Ok(()));
        let (complete, receiver) = gate.begin().unwrap();
        complete(Err("User declined".into()));
        assert!(receiver.blocking_recv().unwrap().is_err());
        let (complete, _) = gate.begin().unwrap();
        complete(Ok(()));
    }

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
