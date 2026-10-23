//! Lazy reads through registered project entries, including their explicit symlinks.
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

pub(crate) const FILE_LIMIT: u64 = 2 * 1024 * 1024;
pub(crate) const IMAGE_LIMIT: u64 = 32 * 1024 * 1024;

pub(crate) fn markdown_image(root: &Path, document: &str, source: &str) -> Result<String, String> {
    let document = confined(root, document)?;
    if source.starts_with('/') || source.starts_with('\\') {
        return Err("Chemin hors du projet".into());
    }
    let base = tauri::Url::from_file_path(document).map_err(|_| "Chemin hors du projet")?;
    let path = base
        .join(source)
        .map_err(|_| "Chemin hors du projet")?
        .to_file_path()
        .map_err(|_| "Chemin hors du projet")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("Chemin hors du projet".into());
    }
    image_data(&path)
}

fn image_data(path: &Path) -> Result<String, String> {
    use base64::Engine;
    if !fs::metadata(path).map_err(|e| e.to_string())?.is_file() {
        return Err("Ce chemin ne désigne pas un fichier régulier".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(IMAGE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > IMAGE_LIMIT {
        return Err("Image trop volumineuse (32 Mo maximum).".into());
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
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

pub(crate) fn confined(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Chemin hors du projet".into());
    }
    if root.is_file() {
        if relative.is_empty() || root.file_name().is_some_and(|name| path == Path::new(name)) {
            return Ok(root.to_path_buf());
        }
        return Err("Chemin hors du projet".into());
    }
    let canonical = root.join(path).canonicalize().map_err(|e| e.to_string())?;
    // The user explicitly requested browsing project symlinks, including external skill folders.
    // Absolute paths and lexical parent traversal stay rejected; a link must exist under the registered root.
    Ok(canonical)
}

pub(crate) fn text(path: &Path) -> Result<String, String> {
    // Reject devices and FIFOs before opening; opening a FIFO could block indefinitely.
    if !fs::metadata(path).map_err(|e| e.to_string())?.is_file() {
        return Err("Ce chemin ne désigne pas un fichier régulier".into());
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Ce chemin ne désigne pas un fichier régulier".into());
    }
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    decode(bytes)
}

pub(crate) fn decode(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() as u64 > FILE_LIMIT {
        return Err("Fichier trop volumineux pour l’aperçu (2 Mo maximum).".into());
    }
    if bytes.contains(&0) {
        return Err("Fichier binaire : aperçu texte indisponible.".into());
    }
    String::from_utf8(bytes).map_err(|_| "Ce fichier n’est pas encodé en UTF-8.".into())
}

/// macOS records when an item was added to its containing directory separately from birth time.
/// Unsupported filesystems return None; do not substitute creation or modification dates.
pub(crate) fn added_time(path: &Path) -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let path = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut attributes = libc::attrlist {
            bitmapcount: libc::ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: libc::ATTR_CMN_ADDEDTIME,
            volattr: 0,
            dirattr: 0,
            fileattr: 0,
            forkattr: 0,
        };
        // getattrlist packs its u32 length followed by a timespec at 4-byte alignment.
        let mut buffer = [0u8; size_of::<u32>() + size_of::<libc::timespec>()];
        // SAFETY: the path is NUL-terminated and both buffers are valid for the declared sizes.
        let status = unsafe {
            libc::getattrlist(
                path.as_ptr(),
                (&mut attributes as *mut libc::attrlist).cast(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                libc::FSOPT_NOFOLLOW,
            )
        };
        if status != 0 || u32::from_ne_bytes(buffer[..4].try_into().ok()?) as usize != buffer.len()
        {
            return None;
        }
        // SAFETY: the returned buffer contains a complete, potentially unaligned timespec.
        let time = unsafe {
            buffer
                .as_ptr()
                .add(4)
                .cast::<libc::timespec>()
                .read_unaligned()
        };
        if time.tv_sec <= 0 || !(0..1_000_000_000).contains(&time.tv_nsec) {
            return None;
        }
        Some(time.tv_sec as u64 * 1000 + time.tv_nsec as u64 / 1_000_000)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        None
    }
}

pub(crate) fn created_time(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .created()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|t| t.as_millis() as u64)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub symlink: bool,
    pub repository: bool,
    pub modified: u64,
    pub added: Option<u64>,
    pub created: Option<u64>,
    pub size: Option<u64>,
}

pub(crate) fn directory(root: &Path, relative: &str) -> Result<Vec<Entry>, String> {
    confined(root, relative)?;
    if root.is_file() {
        let name = root
            .file_name()
            .ok_or("Nom de fichier invalide")?
            .to_string_lossy()
            .to_string();
        let metadata = fs::metadata(root).ok();
        return Ok(vec![Entry {
            added: added_time(root),
            created: metadata.as_ref().and_then(created_time),
            size: metadata.as_ref().map(|m| m.len()),
            name: name.clone(),
            path: name,
            directory: false,
            symlink: false,
            repository: false,
            modified: fs::metadata(root)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |t| t.as_secs()),
        }]);
    }
    // Retain the logical project path so children of an external link remain addressable through it.
    let directory = root.join(relative);
    let entries = fs::read_dir(&directory).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Nom de fichier non UTF-8")?;
        if name == ".git" {
            continue;
        }
        if result.len() >= 3000 {
            return Err(
                "Dossier contenant plus de 3 000 éléments : ouvrez un sous-dossier.".into(),
            );
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let is_directory = kind.is_dir()
            || (kind.is_symlink() && entry.path().canonicalize().is_ok_and(|path| path.is_dir()));
        let metadata = entry.metadata().ok();
        result.push(Entry {
            added: added_time(&entry.path()),
            created: metadata.as_ref().and_then(created_time),
            size: if is_directory {
                None
            } else {
                metadata.as_ref().map(|m| m.len())
            },
            modified: entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |t| t.as_secs()),
            name,
            path: entry
                .path()
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into(),
            directory: is_directory,
            symlink: kind.is_symlink(),
            repository: is_directory && entry.path().join(".git").exists(),
        });
    }
    result.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    pub original: String,
    pub modified: String,
    pub path: String,
    pub label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilePreview {
    #[serde(flatten)]
    pub preview: Preview,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub(crate) fn regular_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = confined(root, relative)?;
    if !fs::metadata(&path).map_err(|e| e.to_string())?.is_file() {
        return Err("Ce chemin ne désigne pas un fichier régulier".into());
    }
    Ok(path)
}

pub(crate) fn file_preview(root: &Path, relative: &str) -> Result<FilePreview, String> {
    let path = regular_file(root, relative)?;
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let image = matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
    );
    let mut result = FilePreview {
        preview: Preview {
            original: String::new(),
            modified: String::new(),
            path: relative.into(),
            label: "Lecture seule".into(),
        },
        kind: "unsupported",
        data_url: None,
        reason: None,
    };
    // Known binary formats are handed to macOS without loading their bytes.
    if matches!(
        extension.as_str(),
        "mp4"
            | "mov"
            | "m4v"
            | "mkv"
            | "avi"
            | "webm"
            | "mp3"
            | "wav"
            | "m4a"
            | "flac"
            | "ogg"
            | "pdf"
            | "zip"
            | "dmg"
            | "heic"
            | "heif"
            | "tif"
            | "tiff"
    ) {
        return Ok(result);
    }
    if image {
        match image_data(&path) {
            Ok(data) => {
                result.kind = "image";
                result.data_url = Some(data);
                // SVG retains its explicit source/editing path within the text limit.
                if extension == "svg" {
                    result.preview.modified = text(&path).unwrap_or_default();
                }
            }
            Err(error) => result.reason = Some(error),
        }
    } else {
        match text(&path) {
            Ok(content) => {
                result.kind = "text";
                result.preview.modified = content;
            }
            Err(error) => result.reason = Some(error),
        }
    }
    Ok(result)
}

pub(crate) fn git_blob(repo: &Path, revision: &str, path: &str) -> Result<String, String> {
    // Resolve the tree first; an absent entry is a legitimate empty side of a diff.
    let tree = crate::git::git(repo, &["ls-tree", "-z", revision, "--", path])?;
    if tree.is_empty() {
        return Ok(String::new());
    }
    let header = tree
        .split(|b| *b == b'\t')
        .next()
        .ok_or("Entrée Git invalide")?;
    let header = String::from_utf8_lossy(header);
    if !header.contains(" blob ") {
        return Err("Sous-module : sélectionnez son dépôt pour voir les fichiers.".into());
    }
    let spec = format!("{revision}:{path}");
    decode(crate::git::git(
        repo,
        &["show", "--no-ext-diff", "--no-textconv", &spec],
    )?)
}

fn index_snapshot(repo: &Path, path: &str) -> Result<(String, bool), String> {
    let tree = crate::git::git(repo, &["ls-files", "--stage", "-z", "--", path])?;
    let mut normal = false;
    let mut ours = false;
    let mut conflicted = false;
    for entry in tree
        .split(|b| *b == b'\0')
        .filter(|entry| !entry.is_empty())
    {
        // Parse only the header: paths may contain spaces, tabs and newlines.
        let header = entry.split(|b| *b == b'\t').next().unwrap_or_default();
        match header.rsplit(|b| *b == b' ').next() {
            Some(b"0") => normal = true,
            Some(b"2") => {
                ours = true;
                conflicted = true;
            }
            Some(b"1" | b"3") => conflicted = true,
            _ => return Err("Entrée d’index Git invalide".into()),
        }
    }
    let stage = if conflicted {
        if !ours {
            // Deleted on our side: the correct baseline is empty, not the ancestor.
            return Ok((String::new(), true));
        }
        "2"
    } else if normal {
        "0"
    } else {
        return Ok((String::new(), false));
    };
    let content = decode(crate::git::git(
        repo,
        &[
            "show",
            "--no-ext-diff",
            "--no-textconv",
            &format!(":{stage}:{path}"),
        ],
    )?)?;
    Ok((content, conflicted))
}

pub(crate) fn local_diff(
    repo: &Path,
    path: &str,
    old_path: Option<&str>,
    side: &str,
) -> Result<Preview, String> {
    let old_path = old_path.unwrap_or(path);
    let (index, conflicted) = index_snapshot(repo, path)?;
    let (original, modified, label) = match side {
        "staged" if !conflicted => {
            let original = match crate::git::git(repo, &["rev-parse", "--verify", "HEAD"]) {
                Ok(_) => git_blob(repo, "HEAD", old_path)?,
                Err(_) => String::new(),
            };
            (original, index, "HEAD → index")
        }
        "working" | "staged" => {
            let original = index;
            let target = repo.join(path);
            let modified = if target
                .symlink_metadata()
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                // Git versions the link target, not the file content the link points at.
                let parent = target
                    .parent()
                    .ok_or("Chemin de lien invalide")?
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                if !parent.starts_with(repo) {
                    return Err("Lien situé hors du dépôt".into());
                }
                fs::read_link(&target)
                    .map_err(|e| e.to_string())?
                    .into_os_string()
                    .into_string()
                    .map_err(|_| "Cible de lien non UTF-8")?
            } else if target.symlink_metadata().is_ok() {
                text(&confined(repo, path)?)?
            } else {
                String::new()
            };
            let label = if conflicted {
                "Conflit · notre version → fichiers locaux"
            } else {
                "Index → fichiers locaux"
            };
            (original, modified, label)
        }
        _ => return Err("Type de diff inconnu".into()),
    };
    Ok(Preview {
        original,
        modified,
        path: path.into(),
        label: label.into(),
    })
}

pub(crate) fn commit_diff(
    repo: &Path,
    hash: &str,
    path: &str,
    old_path: Option<&str>,
) -> Result<Preview, String> {
    crate::git::validate_hash(hash)?;
    let parents = crate::git::text(repo, &["rev-list", "--parents", "-n", "1", hash, "--"])?;
    let parent = parents.split_whitespace().nth(1);
    let original = match parent {
        Some(parent) => git_blob(repo, parent, old_path.unwrap_or(path))?,
        None => String::new(),
    };
    Ok(Preview {
        original,
        modified: git_blob(repo, hash, path)?,
        path: path.into(),
        label: format!("Commit {} · premier parent", &hash[..7]),
    })
}

/// Save only existing local project files; publish complete contents with an atomic rename.
pub(crate) fn save(
    root: &Path,
    relative: &str,
    original: &str,
    content: &str,
) -> Result<(), String> {
    use std::io::Write;
    static SAVES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = SAVES.lock().map_err(|e| e.to_string())?;
    decode(content.as_bytes().to_vec())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let target = confined(&root, relative)?;
    if !target.starts_with(&root)
        || target
            .strip_prefix(&root)
            .is_ok_and(|p| p.components().any(|c| c.as_os_str() == ".git"))
    {
        return Err("Édition limitée aux fichiers du projet, hors métadonnées Git.".into());
    }
    let permissions = fs::metadata(&target)
        .map_err(|e| e.to_string())?
        .permissions();
    if permissions.readonly() {
        return Err("Ce fichier est en lecture seule.".into());
    }
    let mut temp = tempfile::NamedTempFile::new_in(target.parent().ok_or("Chemin hors du projet")?)
        .map_err(|e| e.to_string())?;
    temp.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    preserve_save_metadata(&target, temp.as_file())?;
    temp.as_file()
        .set_modified(std::time::SystemTime::now())
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    if confined(&root, relative)? != target || text(&target)? != original {
        return Err("Le fichier a changé sur le disque. Annulez puis rouvrez l’édition pour repartir de sa version actuelle.".into());
    }
    temp.persist(&target).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn preserve_save_metadata(source: &Path, destination: &fs::File) -> Result<(), String> {
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    let source = fs::File::open(source).map_err(|e| e.to_string())?;
    // Both descriptors are owned, open regular files. No data is copied over the new contents.
    if unsafe {
        libc::fcopyfile(
            source.as_raw_fd(),
            destination.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_METADATA,
        )
    } != 0
    {
        return Err(format!(
            "Conservation des métadonnées impossible : {}",
            std::io::Error::last_os_error()
        ));
    }
    let original = source.metadata().map_err(|e| e.to_string())?;
    let copied = destination.metadata().map_err(|e| e.to_string())?;
    if original.uid() != copied.uid()
        || original.gid() != copied.gid()
        || original.permissions() != copied.permissions()
    {
        return Err(
            "La sauvegarde modifierait le propriétaire, le groupe ou les permissions du fichier."
                .into(),
        );
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn preserve_save_metadata(source: &Path, destination: &fs::File) -> Result<(), String> {
    destination
        .set_permissions(
            fs::metadata(source)
                .map_err(|e| e.to_string())?
                .permissions(),
        )
        .map_err(|e| e.to_string())
}
