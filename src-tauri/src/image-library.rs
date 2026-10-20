//! On-demand image discovery; no persistent index and no traversal through links.
use crate::{files, projects::AppState};
use base64::Engine;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant, UNIX_EPOCH},
};

fn format(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some("jpeg".into()),
        "png" | "gif" | "webp" | "svg" => Some(ext),
        _ => None,
    }
}

fn confined(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = files::confined(root, relative)?;
    if !path.starts_with(root) {
        return Err("Chemin hors du projet".into());
    }
    Ok(path)
}

pub(super) fn list(state: &AppState, root: &str, folder: &str) -> Result<Value, String> {
    let base = state.registered(root)?;
    let root_key = base.to_string_lossy().into_owned();
    let start = confined(&base, folder)?;
    if !start.is_dir() {
        return Err("Sélectionnez un dossier".into());
    }
    let preferences = state
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .file_preferences
        .get(&root_key)
        .cloned()
        .unwrap_or_default();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut stack = vec![(start, 0)];
    let mut images = Vec::new();
    let mut visited = 0;
    let mut limited = false;
    'scan: while let Some((directory, depth)) = stack.pop() {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => {
                limited = true;
                continue;
            }
        };
        for entry in entries {
            visited += 1;
            if visited > 10000 || images.len() >= 500 || Instant::now() > deadline {
                limited = true;
                break 'scan;
            }
            let Ok(entry) = entry else {
                limited = true;
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
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
                .into_owned();
            if !super::visible(&relative, &preferences) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                limited = true;
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if depth < 24 {
                    stack.push((path, depth + 1));
                } else {
                    limited = true;
                }
                continue;
            }
            if !kind.is_file() || !super::selected(&relative, &preferences) {
                continue;
            }
            let Some(format) = format(&path) else {
                continue;
            };
            let Ok(metadata) = entry.metadata() else {
                limited = true;
                continue;
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| t.as_millis() as u64)
                .unwrap_or(0);
            images.push(json!({"path":relative,"name":name,"format":format,"size":metadata.len(),"modified":modified}));
        }
    }
    images.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(json!({"images":images,"limited":limited}))
}

pub(super) fn thumbnail(state: &AppState, root: &str, relative: &str) -> Result<Value, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let root = state.registered(root)?;
    let path = confined(&root, relative)?;
    let kind = format(&path).ok_or("Format d’image non pris en charge.")?;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(&path)
        .map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Ce chemin ne désigne pas un fichier régulier".into());
    }
    let cap = if kind == "svg" {
        128 * 1024
    } else {
        8 * 1024 * 1024
    };
    let mut bytes = Vec::new();
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > cap {
        return Err("Miniature indisponible".into());
    }
    let mime = if kind == "svg" {
        if !std::str::from_utf8(&bytes).is_ok_and(|s| s.contains("<svg")) {
            return Err("Miniature indisponible".into());
        }
        "image/svg+xml"
    } else {
        let mut reader = image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let decoded = reader.decode().map_err(|_| "Miniature indisponible")?;
        let mut output = Cursor::new(Vec::new());
        decoded
            .thumbnail(160, 160)
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        bytes = output.into_inner();
        "image/png"
    };
    Ok(json!(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_workspace::{Preferences, Request, execute};
    use std::os::unix::fs::symlink;
    #[test]
    fn reports_partial_lists_and_rejects_oversized_svg_thumbnails() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("images");
        fs::create_dir(&root).unwrap();
        let state = AppState::new(temp.path().join("config.json")).unwrap();
        let root_name = root.to_string_lossy().into_owned();
        execute(
            &state,
            Request::SaveSpace {
                id: "images".into(),
                name: "Images".into(),
                roots: vec![root_name.clone()],
            },
        )
        .unwrap();
        for i in 0..501 {
            fs::write(root.join(format!("{i}.png")), []).unwrap();
        }
        let result = list(&state, &root_name, "").unwrap();
        assert_eq!(result["images"].as_array().unwrap().len(), 500);
        assert_eq!(result["limited"], true);
        fs::File::create(root.join("large.svg"))
            .unwrap()
            .set_len(128 * 1024 + 1)
            .unwrap();
        assert!(thumbnail(&state, &root_name, "large.svg").is_err());
    }
    #[test]
    fn lists_scoped_images_and_bounds_thumbnails_without_following_external_links() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("images");
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        let state = AppState::new(temp.path().join("config.json")).unwrap();
        let root_name = root.to_string_lossy().into_owned();
        execute(
            &state,
            Request::SaveSpace {
                id: "images".into(),
                name: "Images".into(),
                roots: vec![root_name.clone()],
            },
        )
        .unwrap();
        image::RgbaImage::new(320, 80)
            .save(root.join("nested/sample.PNG"))
            .unwrap();
        fs::write(
            root.join("other.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        fs::write(root.join("bad.jpg"), "broken").unwrap();
        fs::write(root.join("notes.md"), "text").unwrap();
        fs::write(root.join("node_modules/ignored.png"), "ignored").unwrap();
        fs::write(temp.path().join("outside.svg"), "<svg/>").unwrap();
        symlink(temp.path().join("outside.svg"), root.join("link.svg")).unwrap();
        let result = list(&state, &root_name, "").unwrap();
        assert_eq!(result["images"].as_array().unwrap().len(), 3);
        assert_eq!(
            list(&state, &root_name, "nested").unwrap()["images"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(list(&state, &root_name, "../").is_err());
        assert!(thumbnail(&state, &root_name, "link.svg").is_err());
        assert!(thumbnail(&state, &root_name, "bad.jpg").is_err());
        let data = thumbnail(&state, &root_name, "nested/sample.PNG").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                data.as_str()
                    .unwrap()
                    .strip_prefix("data:image/png;base64,")
                    .unwrap(),
            )
            .unwrap();
        let thumb = image::load_from_memory(&bytes).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (160, 40));
        execute(
            &state,
            Request::SetPreferences {
                root: root_name.clone(),
                preferences: Preferences {
                    filtered: true,
                    included: vec!["nested".into()],
                    ..Default::default()
                },
            },
        )
        .unwrap();
        assert_eq!(
            list(&state, &root_name, "").unwrap()["images"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
