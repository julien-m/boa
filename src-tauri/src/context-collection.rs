//! One private draft shared by file excerpts and image annotations, plus explicit exports.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::{Cursor, Read, Write},
    path::Path,
};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_ITEMS: usize = 100;
const MAX_IMAGE: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Image {
    pub name: String,
    pub data_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Export {
    directory: String,
    markdown_path: String,
    image_paths: Vec<String>,
}

fn validate_draft(draft: &Value) -> Result<(), String> {
    let object = draft.as_object().ok_or("Invalid context draft")?;
    if object.get("version").and_then(Value::as_u64) != Some(1)
        || object.get("active").and_then(Value::as_bool).is_none()
        || object
            .get("instruction")
            .and_then(Value::as_str)
            .is_none_or(|text| text.len() > 100_000)
        || object
            .get("items")
            .and_then(Value::as_array)
            .is_none_or(|items| {
                items.len() > MAX_ITEMS || items.iter().any(|item| !item.is_object())
            })
    {
        return Err("Invalid or oversized context draft".into());
    }
    Ok(())
}

pub(crate) fn load(path: &Path) -> Result<Option<Value>, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES as u64 {
        return Err("Invalid or oversized context draft".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("Context draft is too large".into());
    }
    let draft = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    validate_draft(&draft)?;
    Ok(Some(draft))
}

pub(crate) fn save(path: &Path, draft: &Value) -> Result<(), String> {
    validate_draft(draft)?;
    let bytes = serde_json::to_vec(draft).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("Context draft is too large".into());
    }
    let parent = path.parent().ok_or("Missing app data folder")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    temporary
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) struct PreparedExport {
    prompt: String,
    images: Vec<(String, Vec<u8>)>,
}

pub(crate) fn prepare(prompt: String, images: Vec<Image>) -> Result<PreparedExport, String> {
    if prompt.len() > MAX_BYTES || images.len() > MAX_ITEMS {
        return Err("Context export is too large".into());
    }
    let mut total = prompt.len();
    let mut names = HashSet::new();
    let mut prepared = Vec::with_capacity(images.len());
    for image in images {
        let stem = image
            .name
            .strip_suffix(".png")
            .ok_or("PNG filename required")?;
        if stem.is_empty()
            || stem.len() > 120
            || !stem
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || !names.insert(image.name.to_ascii_lowercase())
        {
            return Err("Invalid or duplicate context image filename".into());
        }
        total = total
            .checked_add(image.data_url.len())
            .ok_or("Context export is too large")?;
        if image.data_url.len() > MAX_IMAGE || total > MAX_BYTES {
            return Err("Context export is too large".into());
        }
        let raw = image
            .data_url
            .strip_prefix("data:image/png;base64,")
            .ok_or("PNG snapshot required")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw)
            .map_err(|_| "Invalid context PNG snapshot".to_string())?;
        let mut reader =
            image::ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Png);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(8192);
        limits.max_image_height = Some(8192);
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        // Decode, rather than trusting only a PNG signature or attacker-controlled dimensions.
        reader
            .decode()
            .map_err(|_| "Invalid or oversized context PNG snapshot".to_string())?;
        prepared.push((image.name, bytes));
    }
    Ok(PreparedExport {
        prompt,
        images: prepared,
    })
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

pub(crate) fn export_to(parent: &Path, prepared: PreparedExport) -> Result<Export, String> {
    let parent = parent.canonicalize().map_err(|error| error.to_string())?;
    if !parent.is_dir() {
        return Err("Choose an export folder".into());
    }
    // A unique staging directory is deleted automatically if any write fails.
    let directory = tempfile::Builder::new()
        .prefix("context-")
        .tempdir_in(parent)
        .map_err(|error| error.to_string())?;
    let markdown = directory.path().join("context.md");
    write_private(&markdown, prepared.prompt.as_bytes())?;
    let mut image_paths = Vec::with_capacity(prepared.images.len());
    for (name, bytes) in prepared.images {
        let path = directory.path().join(name);
        write_private(&path, &bytes)?;
        image_paths.push(path.to_string_lossy().into_owned());
    }
    Ok(Export {
        directory: directory.keep().to_string_lossy().into_owned(),
        markdown_path: markdown.to_string_lossy().into_owned(),
        image_paths,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(name: &str, width: u32, height: u32) -> Image {
        let image = image::RgbaImage::new(width, height);
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        Image {
            name: name.into(),
            data_url: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
            ),
        }
    }

    #[test]
    fn draft_round_trip_and_invalid_updates_preserve_previous_draft() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("context-collection.json");
        assert_eq!(load(&path).unwrap(), None);
        let draft = json!({"version": 1, "active": true, "instruction": "Review", "items": [{"type":"file", "path":"src/main.ts"}, {"type":"image", "annotations":[{"x":0.4,"y":0.3}]}]});
        save(&path, &draft).unwrap();
        assert_eq!(load(&path).unwrap(), Some(draft.clone()));
        assert!(save(&path, &json!({"version": 2, "items": []})).is_err());
        assert_eq!(load(&path).unwrap(), Some(draft));
        fs::write(&path, b"broken draft").unwrap();
        assert!(load(&path).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn exports_multiple_images_without_overwriting_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let first = snapshot("image-1.png", 5, 3);
        let second = snapshot("image-2.png", 3, 7);
        let prompt = "Review image-1.png and image-2.png";
        let output = export_to(
            root.path(),
            prepare(prompt.into(), vec![first, second]).unwrap(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&output.markdown_path).unwrap(), prompt);
        assert_eq!(output.image_paths.len(), 2);
        for (path, dimensions) in output.image_paths.iter().zip([(5, 3), (3, 7)]) {
            assert_eq!(image::image_dimensions(path).unwrap(), dimensions);
            assert!(Path::new(path).starts_with(&output.directory));
        }
        let other = export_to(
            root.path(),
            prepare("Other context".into(), vec![]).unwrap(),
        )
        .unwrap();
        assert_ne!(other.directory, output.directory);
        assert_eq!(fs::read_to_string(&output.markdown_path).unwrap(), prompt);
    }

    #[test]
    fn exports_text_collections_larger_than_the_single_file_preview_limit() {
        // Several valid excerpts together can exceed the preview limit of one source file.
        let prompt = "Collected text\n".repeat((3 * 1024 * 1024) / 15);
        assert!(prompt.len() > 2 * 1024 * 1024);
        let root = tempfile::tempdir().unwrap();
        let output = export_to(root.path(), prepare(prompt.clone(), vec![]).unwrap()).unwrap();
        assert_eq!(fs::read_to_string(output.markdown_path).unwrap(), prompt);
    }

    #[test]
    fn rejects_unsafe_duplicate_and_fake_pngs_before_creating_any_export() {
        for name in [
            "../escape.png",
            "nested/file.png",
            ".png",
            "file.jpg",
            "file.name.png",
            "file\\name.png",
        ] {
            assert!(
                prepare("Review".into(), vec![snapshot(name, 2, 2)]).is_err(),
                "{name}"
            );
        }
        assert!(
            prepare(
                "Review".into(),
                vec![snapshot("a.png", 2, 2), snapshot("A.png", 3, 3)]
            )
            .is_err()
        );
        let mut invalid = snapshot("a.png", 2, 2);
        invalid.data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nnot-png")
        );
        assert!(prepare("Review".into(), vec![invalid]).is_err());
        let root = tempfile::tempdir().unwrap();
        assert!(
            export_to(
                &root.path().join("missing"),
                prepare("Review".into(), vec![]).unwrap()
            )
            .is_err()
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn failed_export_removes_its_partial_files() {
        let root = tempfile::tempdir().unwrap();
        let existing = root.path().join("keep.txt");
        fs::write(&existing, "Keep existing files").unwrap();
        // Exercise a write failure after context.md has already been created.
        let prepared = PreparedExport {
            prompt: "Review".into(),
            images: vec![("context.md".into(), Vec::new())],
        };
        assert!(export_to(root.path(), prepared).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
        assert_eq!(fs::read_to_string(existing).unwrap(), "Keep existing files");
    }
}
