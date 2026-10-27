//! Finder opens authorize only the selected file, never discovery of its parent.
use crate::{Navigation, file_workspace::Space, navigation_target, projects::AppState};
use std::path::{Component, Path};

pub(crate) fn open(state: &AppState, file: &str) -> Result<Navigation, String> {
    let path = Path::new(file);
    if !path.is_absolute()
        || path.components().any(|p| matches!(p, Component::ParentDir))
        || !path.is_file()
    {
        return Err("Expected an existing absolute local file".into());
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
    let index = match next.file_spaces.iter().position(|s| s.id == "opened-files") {
        Some(index) => index,
        None => {
            next.file_spaces.push(Space {
                id: "opened-files".into(),
                name: if next.language == "en" {
                    "Opened files"
                } else {
                    "Fichiers ouverts"
                }
                .into(),
                roots: vec![],
                files: vec![],
            });
            next.file_spaces.len() - 1
        }
    };
    let space = &mut next.file_spaces[index];
    if !space.files.contains(&file) {
        if space.files.len() + space.roots.len() >= 64 {
            return Err(
                "Opened files is full; remove an entry or register its project first".into(),
            );
        }
        space.files.push(file);
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
        assert!(open(&state, root.to_str().unwrap()).is_err());
        state.add_project(&root).unwrap();
        let other = root.join("sibling.html");
        let target = open(&state, other.to_str().unwrap()).unwrap();
        assert_eq!(Path::new(&target.project), root.canonicalize().unwrap());
        assert_eq!(state.config.lock().unwrap().file_spaces[0].files.len(), 1);
    }
}
