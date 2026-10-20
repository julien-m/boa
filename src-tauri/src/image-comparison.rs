//! The native picker grants access only to its selected comparison image.
use base64::Engine;
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChosenImage {
    data_url: String,
    name: String,
    size: u64,
}

pub(crate) fn initial_directory(
    root: Option<&Path>,
    directory: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let Some(root) = root else {
        return Ok(None);
    };
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let directory = Path::new(directory.unwrap_or(""));
    if directory.is_absolute()
        || directory
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Chemin hors du projet".into());
    }
    let candidate = root.join(directory).canonicalize().ok();
    Ok(Some(
        candidate
            .filter(|path| path.starts_with(&root) && path.is_dir())
            .unwrap_or(root),
    ))
}

pub(crate) fn read_chosen(path: &Path) -> Result<ChosenImage, String> {
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    if !fs::metadata(&path).map_err(|e| e.to_string())?.is_file() {
        return Err("Ce chemin ne désigne pas un fichier régulier".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(&path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Ce chemin ne désigne pas un fichier régulier".into());
    }
    if metadata.len() > LIMIT {
        return Err("Image trop volumineuse (8 Mo maximum).".into());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT {
        return Err("Image trop volumineuse (8 Mo maximum).".into());
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
        && std::str::from_utf8(&bytes).is_ok_and(|text| text.contains("<svg"))
    {
        "image/svg+xml"
    } else {
        return Err("Format d’image non pris en charge.".into());
    };
    Ok(ChosenImage {
        name: path
            .file_name()
            .ok_or("Nom de fichier non UTF-8")?
            .to_string_lossy()
            .into_owned(),
        size: bytes.len() as u64,
        data_url: format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn initial_folder_is_confined_and_missing_folder_falls_back() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        fs::create_dir(base.join("images")).unwrap();
        assert_eq!(
            initial_directory(Some(&base), Some("images")).unwrap(),
            Some(base.join("images"))
        );
        assert_eq!(
            initial_directory(Some(&base), Some("missing")).unwrap(),
            Some(base.clone())
        );
        assert_eq!(
            initial_directory(Some(&base), Some("")).unwrap(),
            Some(base.clone())
        );
        assert!(initial_directory(Some(&base), Some("../other")).is_err());
        assert!(initial_directory(Some(&base), Some("/tmp")).is_err());
        assert_eq!(initial_directory(None, None).unwrap(), None);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/tmp", base.join("outside")).unwrap();
            assert_eq!(
                initial_directory(Some(&base), Some("outside")).unwrap(),
                Some(base)
            );
        }
    }
    #[test]
    fn selected_file_is_bounded_and_sniffed() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("image.png");
        fs::write(&path, b"\x89PNG\r\n\x1a\nfixture").unwrap();
        let image = read_chosen(&path).unwrap();
        assert_eq!(image.name, "image.png");
        assert_eq!(image.size, 15);
        assert!(image.data_url.starts_with("data:image/png;base64,"));
        fs::write(&path, b"not an image").unwrap();
        assert_eq!(
            read_chosen(&path).err().unwrap(),
            "Format d’image non pris en charge."
        );
        fs::File::create(&path).unwrap().set_len(LIMIT + 1).unwrap();
        assert!(read_chosen(&path).err().unwrap().contains("8 Mo"));
    }
    #[cfg(unix)]
    #[test]
    fn selected_fifo_is_rejected_without_opening() {
        use std::os::unix::ffi::OsStrExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("pipe.png");
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(
            read_chosen(&path)
                .err()
                .unwrap()
                .contains("fichier régulier")
        );
    }
}
