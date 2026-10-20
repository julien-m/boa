//! Explicit file collections. No implicit discovery, indexing or Git scans.
use crate::projects::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Component, Path},
    time::{Duration, Instant},
};

#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Space {
    pub id: String,
    pub name: String,
    pub roots: Vec<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Preferences {
    pub filtered: bool,
    pub included: Vec<String>,
    pub pins: Vec<String>,
    pub sort: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Shortcuts {
    pub contextual: String,
    pub global: String,
}
impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            contextual: "Mod+F".into(),
            global: "Mod+Shift+F".into(),
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum Request {
    List,
    SaveSpace {
        id: String,
        name: String,
        roots: Vec<String>,
    },
    RemoveSpace {
        id: String,
    },
    Preferences {
        root: String,
    },
    SetPreferences {
        root: String,
        preferences: Preferences,
    },
    SetShortcuts {
        shortcuts: Shortcuts,
    },
    Search {
        roots: Vec<String>,
        query: String,
        mode: String,
    },
}
fn valid_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\0')
        && !Path::new(path).is_absolute()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
pub(crate) fn visible(path: &str, prefs: &Preferences) -> bool {
    !prefs.filtered
        || prefs.included.iter().chain(&prefs.pins).any(|p| {
            path == p || path.starts_with(&format!("{p}/")) || p.starts_with(&format!("{path}/"))
        })
}
fn selected(path: &str, prefs: &Preferences) -> bool {
    !prefs.filtered
        || prefs
            .included
            .iter()
            .chain(&prefs.pins)
            .any(|p| path == p || path.starts_with(&format!("{p}/")))
}
fn valid_shortcut(s: &str) -> bool {
    let parts: Vec<_> = s.split('+').collect();
    (2..=4).contains(&parts.len())
        && parts[0] == "Mod"
        && parts[..parts.len() - 1]
            .iter()
            .skip(1)
            .all(|v| ["Shift", "Alt"].contains(v))
        && parts
            .last()
            .is_some_and(|v| v.len() == 1 && v.as_bytes()[0].is_ascii_alphabetic())
}
pub(crate) fn execute(state: &AppState, request: Request) -> Result<Value, String> {
    match request {
        Request::List => {
            let c = state.config.lock().map_err(|e| e.to_string())?;
            Ok(json!({"spaces":c.file_spaces,"shortcuts":c.shortcuts}))
        }
        Request::Preferences { root } => {
            let root = state.registered(&root)?.to_string_lossy().into_owned();
            let c = state.config.lock().map_err(|e| e.to_string())?;
            Ok(json!(
                c.file_preferences.get(&root).cloned().unwrap_or_default()
            ))
        }
        Request::Search { roots, query, mode } => search(state, roots, &query, &mode),
        other => {
            // Validate filesystem paths before acquiring the shared configuration lock.
            let other = if let Request::SaveSpace { id, name, roots } = other {
                if id.is_empty()
                    || id.len() > 100
                    || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                    || name.trim().is_empty()
                    || name.len() > 100
                    || roots.is_empty()
                    || roots.len() > 64
                {
                    return Err("Invalid file space".into());
                }
                let mut canonical = BTreeSet::new();
                for root in roots {
                    let path = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
                    if !path.is_dir() {
                        return Err("Select a folder".into());
                    }
                    canonical.insert(path.to_string_lossy().to_string());
                }
                Request::SaveSpace {
                    id,
                    name: name.trim().into(),
                    roots: canonical.into_iter().collect(),
                }
            } else {
                other
            };
            let other = if let Request::SetPreferences { root, preferences } = other {
                Request::SetPreferences {
                    root: state.registered(&root)?.to_string_lossy().into_owned(),
                    preferences,
                }
            } else {
                other
            };
            if let Request::SetPreferences { root, preferences } = &other {
                state.registered(root)?;
                if preferences.included.len() > 1000
                    || preferences.pins.len() > 1000
                    || !["", "name", "modified"].contains(&preferences.sort.as_str())
                    || preferences
                        .included
                        .iter()
                        .chain(&preferences.pins)
                        .any(|p| !valid_relative(p))
                {
                    return Err("Invalid file preferences".into());
                }
            }
            let mut c = state.config.lock().map_err(|e| e.to_string())?;
            let mut next = c.clone();
            let result = match other {
                Request::SaveSpace { id, name, roots } => {
                    let s = Space { id, name, roots };
                    next.file_spaces.retain(|x| x.id != s.id);
                    next.file_spaces.push(s.clone());
                    json!(s)
                }
                Request::RemoveSpace { id } => {
                    next.file_spaces.retain(|s| s.id != id);
                    json!(true)
                }
                Request::SetPreferences {
                    root,
                    mut preferences,
                } => {
                    let normalized = |p: &String| {
                        Path::new(p)
                            .components()
                            .collect::<std::path::PathBuf>()
                            .to_string_lossy()
                            .into_owned()
                    };
                    preferences.included = preferences.included.iter().map(normalized).collect();
                    preferences.pins = preferences.pins.iter().map(normalized).collect();
                    let mut included = std::collections::BTreeSet::new();
                    preferences.included.retain(|p| included.insert(p.clone()));

                    let mut seen = BTreeSet::new();
                    preferences.pins.retain(|p| seen.insert(p.clone()));
                    next.file_preferences.insert(root, preferences.clone());
                    json!(preferences)
                }
                Request::SetShortcuts { shortcuts } => {
                    if !valid_shortcut(&shortcuts.contextual)
                        || !valid_shortcut(&shortcuts.global)
                        || shortcuts.contextual.eq_ignore_ascii_case(&shortcuts.global)
                    {
                        return Err("Invalid or duplicate shortcuts".into());
                    }
                    next.shortcuts = shortcuts.clone();
                    json!(shortcuts)
                }
                _ => unreachable!(),
            };
            state.write_config(&next)?;
            *c = next;
            drop(c);
            state.notify_watchers();
            Ok(result)
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Hit {
    project: String,
    path: String,
    line: usize,
    text: String,
    directory: bool,
    kind: &'static str,
}
fn search(state: &AppState, roots: Vec<String>, query: &str, mode: &str) -> Result<Value, String> {
    if query.trim().is_empty()
        || query.len() > 1000
        || query.contains('\0')
        || !["paths", "content", "all"].contains(&mode)
        || roots.len() > 64
    {
        return Err("Invalid search request".into());
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let needle = query.to_lowercase();
    let mut hits = Vec::new();
    let mut visited = 0;
    let mut limited = false;
    let mut seen = BTreeSet::new();
    let mut warnings = BTreeSet::new();
    let prefs = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .file_preferences
        .clone();
    let mut unique = BTreeSet::new();
    for root in roots {
        let scan = Path::new(&root).canonicalize().map_err(|e| e.to_string())?;
        let allowed = {
            let c = state.config.lock().map_err(|e| e.to_string())?;
            c.projects
                .iter()
                .map(|p| p.path.clone())
                .chain(c.file_spaces.iter().flat_map(|s| s.roots.clone()))
                .filter(|r| scan.starts_with(r))
                .max_by_key(|r| r.len())
                .ok_or("Unregistered search root")?
        };
        let root = allowed;
        let base = state.registered(&root)?;
        if !unique.insert(scan.clone()) {
            continue;
        }
        let pref = prefs.get(&root).cloned().unwrap_or_default();
        let mut stack = vec![(scan, 0usize)];
        while let Some((directory, depth)) = stack.pop() {
            if Instant::now() > deadline || visited >= 10000 || hits.len() >= 300 {
                limited = true;
                break;
            }
            let entries = match fs::read_dir(&directory) {
                Ok(v) => v,
                Err(e) => {
                    warnings.insert(e.to_string());
                    continue;
                }
            };
            for entry in entries {
                visited += 1;
                if Instant::now() > deadline || visited > 10000 || hits.len() >= 300 {
                    limited = true;
                    break;
                }
                let entry = match entry {
                    Ok(v) => v,
                    Err(e) => {
                        warnings.insert(e.to_string());
                        continue;
                    }
                };
                let name = entry.file_name().to_string_lossy().to_string();
                if [
                    ".git",
                    "node_modules",
                    "target",
                    "dist",
                    ".venv",
                    ".cache",
                    ".Trash",
                    "__pycache__",
                ]
                .contains(&name.as_str())
                {
                    continue;
                }
                let path = entry.path();
                let relative = path
                    .strip_prefix(&base)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string();
                if !visible(&relative, &pref) {
                    continue;
                }
                let kind = match entry.file_type() {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if kind.is_symlink() {
                    continue;
                } // No unbounded traversal outside an explicit search root.
                if kind.is_dir() {
                    if depth < 32 {
                        stack.push((path.clone(), depth + 1))
                    } else {
                        limited = true
                    }
                }
                if !selected(&relative, &pref) {
                    continue;
                }
                if !seen.insert(path.clone()) {
                    continue;
                }
                if mode != "content" && relative.to_lowercase().contains(&needle) {
                    hits.push(Hit {
                        project: root.clone(),
                        path: relative.clone(),
                        line: 0,
                        text: String::new(),
                        directory: kind.is_dir(),
                        kind: "path",
                    })
                }
                if mode != "paths" && kind.is_file() && hits.len() < 300 {
                    if !path.metadata().is_ok_and(|m| m.len() <= 2 * 1024 * 1024) {
                        continue;
                    }
                    let mut bytes = Vec::new();
                    if {
                        use std::os::unix::fs::OpenOptionsExt;
                        fs::OpenOptions::new()
                            .read(true)
                            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
                            .open(&path)
                            .and_then(|f| {
                                if !f.metadata()?.is_file() {
                                    return Ok(0);
                                }
                                f.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes)
                            })
                    }
                    .is_err()
                    {
                        continue;
                    }
                    if bytes.len() > 2 * 1024 * 1024 || bytes.contains(&0) {
                        continue;
                    }
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        for (i, line) in text
                            .lines()
                            .enumerate()
                            .filter(|(_, s)| s.to_lowercase().contains(&needle))
                            .take(20)
                        {
                            if hits.len() >= 300 {
                                limited = true;
                                break;
                            }
                            hits.push(Hit {
                                project: root.clone(),
                                path: relative.clone(),
                                line: i + 1,
                                text: line.chars().take(500).collect(),
                                directory: false,
                                kind: "content",
                            });
                        }
                    }
                }
            }
            if limited && (visited >= 10000 || hits.len() >= 300 || Instant::now() > deadline) {
                break;
            }
        }
        if Instant::now() > deadline || visited >= 10000 || hits.len() >= 300 {
            limited = true;
            break;
        }
    }
    Ok(
        json!({"matches":hits,"limited":limited,"warning":warnings.into_iter().collect::<Vec<_>>().join("\n")}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_preserves_ancestors_and_hides_siblings() {
        let p = Preferences {
            filtered: true,
            included: vec!["a/b".into()],
            ..Default::default()
        };
        assert!(visible("a", &p));
        assert!(visible("a/b/c", &p));
        assert!(!visible("a/c", &p));
        assert!(!selected("a", &p));
        assert!(!valid_relative("../a"));
        assert!(!valid_relative("/tmp"));
    }
    #[test]
    fn shortcuts_reject_browser_unsafe_shapes() {
        assert!(valid_shortcut("Mod+Shift+F"));
        assert!(!valid_shortcut("F"));
        assert!(!valid_shortcut("Mod+Delete"));
    }
    #[test]
    fn spaces_persist_without_adding_git_projects_and_search_obeys_selection() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("files");
        fs::create_dir_all(root.join(".codex/skills")).unwrap();
        fs::create_dir_all(root.join("hidden")).unwrap();
        fs::write(root.join(".codex/skills/a.md"), "needle here").unwrap();
        fs::write(root.join("hidden/secret.md"), "needle hidden").unwrap();
        let config = temp.path().join("settings.json");
        let state = AppState::new(config.clone()).unwrap();
        let r = root.to_string_lossy().to_string();
        execute(
            &state,
            Request::SaveSpace {
                id: "tools".into(),
                name: "Tools".into(),
                roots: vec![r.clone(), r.clone()],
            },
        )
        .unwrap();
        assert!(state.config.lock().unwrap().projects.is_empty());
        assert_eq!(state.config.lock().unwrap().file_spaces[0].roots.len(), 1);
        execute(
            &state,
            Request::SetPreferences {
                root: r.clone(),
                preferences: Preferences {
                    filtered: true,
                    included: vec![".codex//skills/".into()],
                    pins: vec![".codex//skills/a.md".into()],
                    sort: "modified".into(),
                },
            },
        )
        .unwrap();
        let result = execute(
            &state,
            Request::Search {
                roots: vec![r.clone()],
                query: "needle".into(),
                mode: "all".into(),
            },
        )
        .unwrap();
        assert_eq!(result["matches"].as_array().unwrap().len(), 1);
        assert_eq!(result["matches"][0]["path"], ".codex/skills/a.md");
        let child = execute(
            &state,
            Request::Search {
                roots: vec![root.join(".codex").to_string_lossy().into()],
                query: "a.md".into(),
                mode: "paths".into(),
            },
        )
        .unwrap();
        assert_eq!(
            child["matches"][0]["project"],
            root.canonicalize().unwrap().to_string_lossy().to_string()
        );
        assert!(
            execute(
                &state,
                Request::SetPreferences {
                    root: r.clone(),
                    preferences: Preferences {
                        pins: vec!["../escape".into()],
                        ..Default::default()
                    }
                }
            )
            .is_err()
        );
        assert!(
            execute(
                &state,
                Request::Search {
                    roots: vec![temp.path().to_string_lossy().into()],
                    query: "needle".into(),
                    mode: "all".into()
                }
            )
            .is_err()
        );
        let restored = AppState::new(config).unwrap();
        assert_eq!(restored.config.lock().unwrap().file_spaces[0].name, "Tools");
        assert_eq!(
            restored.config.lock().unwrap().file_preferences
                [&root.canonicalize().unwrap().to_string_lossy().to_string()]
                .pins
                .len(),
            1
        );
    }
}
