//! Explicit OS opens authorize the selected file or folder, never discovery of its parent.
use crate::{Navigation, file_workspace::Space, navigation_target, projects::AppState};
use std::path::{Component, Path};

pub(crate) fn open(state: &AppState, file: &str) -> Result<Navigation, String> {
    let path = Path::new(file);
    if !path.is_absolute()
        || path.components().any(|p| matches!(p, Component::ParentDir))
        || (!path.is_file() && !path.is_dir())
    {
        return Err("Expected an existing absolute local file or folder".into());
    }
    if let Ok(target) = navigation_target(state, path) {
        return Ok(target);
    }
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if let Ok(target) = navigation_target(state, &path) {
        return Ok(target);
    }
    let file = path.to_str().ok_or("Invalid file path")?.to_string();
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let mut next = config.clone();
    // Group explicit entries by directory without granting access to unselected siblings.
    let directory = if path.is_dir() {
        path.as_path()
    } else {
        path.parent().ok_or("Missing parent directory")?
    };
    let index = match next.file_spaces.iter().position(|space| {
        !space.files.is_empty()
            && space.roots.is_empty()
            && space
                .files
                .iter()
                .all(|file| Path::new(file).parent() == Some(directory))
    }) {
        Some(index) => index,
        None => {
            let mut suffix = 1;
            let id = loop {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos();
                let candidate = format!("opened-files-{stamp}-{suffix}");
                if !next.file_spaces.iter().any(|space| space.id == candidate) {
                    break candidate;
                }
                suffix += 1;
            };
            let label = if next.language == "en" {
                "Opened files"
            } else {
                "Fichiers ouverts"
            };
            let name = directory
                .file_name()
                .unwrap_or(directory.as_os_str())
                .to_string_lossy();
            next.file_spaces.push(Space {
                id,
                name: format!("{label} · {name}"),
                roots: vec![],
                files: vec![],
            });
            next.file_spaces.len() - 1
        }
    };
    let space = &mut next.file_spaces[index];
    let entry_count = space.files.len() + space.roots.len();
    let entries = if path.is_dir() {
        &mut space.roots
    } else {
        &mut space.files
    };
    if !entries.contains(&file) {
        // Keep the same per-space bound for explicit opens as manual file-space imports.
        if entry_count >= 64 {
            return Err(
                "Opened files is full; remove an entry or register its project first".into(),
            );
        }
        entries.push(file);
        state.write_config(&next)?;
        *config = next;
    }
    drop(config);
    state.notify_watchers();
    navigation_target(state, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn explicit_folders_register_only_the_selected_root_and_reuse_it() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path().join("settings.json")).unwrap();
        let root = temp.path().join("captures");
        fs::create_dir_all(root.join("first-pass")).unwrap();
        fs::write(root.join("index.md"), "[First pass](first-pass/)").unwrap();
        let target = open(&state, root.to_str().unwrap()).unwrap();
        assert_eq!(Path::new(&target.project), root.canonicalize().unwrap());
        assert_eq!(target.path, "/");
        open(&state, root.to_str().unwrap()).unwrap();
        let nested = open(&state, root.join("first-pass").to_str().unwrap()).unwrap();
        assert_eq!(nested.project, target.project);
        assert_eq!(nested.path, "first-pass/");
        let config = state.config.lock().unwrap();
        assert_eq!(config.file_spaces[0].roots, vec![target.project]);
        assert!(config.file_spaces[0].files.is_empty());
        assert!(config.projects.is_empty());
        drop(config);
        let reloaded = AppState::new(temp.path().join("settings.json")).unwrap();
        assert_eq!(open(&reloaded, root.to_str().unwrap()).unwrap().path, "/");
        assert!(open(&state, temp.path().join("missing").to_str().unwrap()).is_err());
    }

    #[test]
    fn explicit_documents_register_only_the_file_and_reuse_registered_projects() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path().join("settings.json")).unwrap();
        let root = temp.path().join("source");
        fs::create_dir(&root).unwrap();
        let file = root.join("page.html");
        fs::write(&file, "<h1>Source</h1>").unwrap();
        fs::write(root.join("sibling.html"), "private sibling").unwrap();
        let selected = file.canonicalize().unwrap();
        let target = open(&state, file.to_str().unwrap()).unwrap();
        assert_eq!(Path::new(&target.project), selected);
        assert!(state.registered(root.to_str().unwrap()).is_err());
        open(&state, file.to_str().unwrap()).unwrap();
        assert_eq!(state.config.lock().unwrap().file_spaces[0].files.len(), 1);
        assert!(state.config.lock().unwrap().projects.is_empty());
        assert!(open(&state, root.join("missing").to_str().unwrap()).is_err());
        state.add_project(&root).unwrap();
        let other = root.join("sibling.html");
        let target = open(&state, other.to_str().unwrap()).unwrap();
        assert_eq!(Path::new(&target.project), root.canonicalize().unwrap());
        assert_eq!(state.config.lock().unwrap().file_spaces[0].files.len(), 1);
    }
}

#[cfg(test)]
mod grouping_tests {
    use super::*;
    use std::fs;

    #[test]
    fn explicit_files_share_a_space_only_with_their_directory_and_survive_reload() {
        let temp = tempfile::tempdir().unwrap();
        let settings = temp.path().join("settings.json");
        let state = AppState::new(settings.clone()).unwrap();
        let mut files = Vec::new();
        for folder in ["first", "second"] {
            let root = temp.path().join(folder);
            fs::create_dir(&root).unwrap();
            for name in ["one.md", "two.md"] {
                let file = root.join(name);
                fs::write(&file, name).unwrap();
                open(&state, file.to_str().unwrap()).unwrap();
                files.push(file.canonicalize().unwrap().to_str().unwrap().to_string());
            }
        }
        let reloaded = AppState::new(settings).unwrap();
        open(&reloaded, &files[0]).unwrap();
        let config = reloaded.config.lock().unwrap();
        assert_eq!(config.file_spaces.len(), 2);
        for (space, files) in config.file_spaces.iter().zip(files.chunks(2)) {
            assert_eq!(space.files, files);
            assert!(space.roots.is_empty());
        }
        assert!(config.projects.is_empty());
    }
}
