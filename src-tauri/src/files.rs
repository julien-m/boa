//! Lazy reads through registered project entries, including their explicit symlinks.
use serde::Serialize;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

pub(crate) const FILE_LIMIT: u64 = 2 * 1024 * 1024;

pub(crate) fn confined(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub symlink: bool,
    pub repository: bool,
}

pub(crate) fn directory(root: &Path, relative: &str) -> Result<Vec<Entry>, String> {
    confined(root, relative)?;
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
        result.push(Entry {
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

pub(crate) fn index_blob(repo: &Path, path: &str) -> Result<String, String> {
    let tree = crate::git::git(repo, &["ls-files", "--stage", "-z", "--", path])?;
    if tree.is_empty() {
        return Ok(String::new());
    }
    decode(crate::git::git(
        repo,
        &[
            "show",
            "--no-ext-diff",
            "--no-textconv",
            &format!(":{path}"),
        ],
    )?)
}

pub(crate) fn local_diff(
    repo: &Path,
    path: &str,
    old_path: Option<&str>,
    side: &str,
) -> Result<Preview, String> {
    let old_path = old_path.unwrap_or(path);
    let (original, modified, label) = match side {
        "staged" => {
            let original = match crate::git::git(repo, &["rev-parse", "--verify", "HEAD"]) {
                Ok(_) => git_blob(repo, "HEAD", old_path)?,
                Err(_) => String::new(),
            };
            (original, index_blob(repo, path)?, "HEAD → index")
        }
        "working" => {
            let original = index_blob(repo, path)?;
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
            (original, modified, "Index → fichiers locaux")
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
