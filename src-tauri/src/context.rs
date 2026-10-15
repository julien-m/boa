//! Persist user-created context packages for native file drag-and-drop.
use base64::Engine;
use serde::Serialize;
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Export {
    pub markdown_path: String,
    pub image_path: String,
}

pub(crate) fn export(root: &Path, prompt: &str, image: &str) -> Result<Export, String> {
    if prompt.len() > 200_000 || image.len() > 12_000_000 {
        return Err("Bulle trop volumineuse pour l’export".into());
    }
    let raw = image
        .strip_prefix("data:image/png;base64,")
        .ok_or("Capture PNG requise")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("Capture PNG invalide".into());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let directory = root.join(format!("context-{id}"));
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let markdown = directory.join("contexte.md");
    let png = directory.join("code.png");
    fs::write(&markdown, prompt).map_err(|e| e.to_string())?;
    fs::write(&png, bytes).map_err(|e| e.to_string())?;
    Ok(Export {
        markdown_path: markdown.to_string_lossy().into(),
        image_path: png.to_string_lossy().into(),
    })
}
