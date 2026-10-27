//! Explicit setup of installed-app integrations; nothing changes at application startup.
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

static SETUP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const MAX_CONFIG: u64 = 4 * 1024 * 1024;

fn uid() -> u32 {
    // SAFETY: geteuid has no pointer arguments.
    unsafe { libc::geteuid() }
}

fn check_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.uid() != uid() || metadata.mode() & 0o022 != 0 {
        return Err("Integration configuration directory is not safe".into());
    }
    Ok(())
}

pub(crate) fn read_private(path: &Path) -> Result<String, String> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error.to_string()),
    };
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file()
        || metadata.uid() != uid()
        || metadata.mode() & 0o022 != 0
        || metadata.len() > MAX_CONFIG
    {
        return Err("Integration configuration file is not safe".into());
    }
    use std::io::Read;
    let mut text = String::new();
    file.take(MAX_CONFIG + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() as u64 > MAX_CONFIG {
        return Err("Integration configuration file is too large".into());
    }
    Ok(text)
}

pub(crate) fn write_private(path: &Path, text: &str, expected: Option<&str>) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or("Missing integration configuration directory")?;
    if !directory.exists() {
        // Only one new private directory is created; its existing parent is verified first.
        check_directory(directory.parent().ok_or("Missing configuration parent")?)?;
        fs::create_dir(directory).map_err(|e| e.to_string())?;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    check_directory(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    temporary
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    if let Some(expected) = expected {
        if read_private(path)? != expected {
            return Err("Integration configuration changed; try again".into());
        }
        temporary.persist(path).map_err(|e| e.to_string())?;
    } else {
        // Backups retain the first original state, including absent defaults.
        temporary
            .persist_noclobber(path)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn codex_path() -> Result<PathBuf, String> {
    let directory = match std::env::var_os("CODEX_HOME") {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => home()?.join(".codex"),
    };
    if !directory.is_absolute() {
        return Err("CODEX_HOME must be an absolute path".into());
    }
    if directory.exists() {
        check_directory(&directory)?;
    }
    Ok(directory.join("config.toml"))
}

fn home() -> Result<PathBuf, String> {
    let path = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Missing home directory")?;
    if !path.is_absolute() {
        return Err("Invalid home directory".into());
    }
    Ok(path)
}

fn installed() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let bundle = crate::codex_handler::installed_bundle(&executable).ok()?;
    let parent = bundle.parent()?;
    (parent == Path::new("/Applications") || parent == home().ok()?.join("Applications"))
        .then_some(bundle)
}

#[derive(Serialize)]
pub(crate) struct SystemStatus {
    pub extensions: Vec<crate::mac_file_handlers::ExtensionStatus>,
}

#[derive(Serialize)]
struct CodexStatus {
    available: bool,
    configured: bool,
}
#[derive(Serialize)]
struct ClaudeStatus {
    available: bool,
    supported: bool,
}
#[derive(Serialize)]
pub(crate) struct Status {
    installed: bool,
    system: SystemStatus,
    codex: CodexStatus,
    claude: ClaudeStatus,
}

#[cfg(target_os = "macos")]
fn status() -> Result<Status, String> {
    let bundle = installed();
    let executable = bundle.as_ref().map(|path| path.join("Contents/MacOS/boa"));
    let path = codex_path()?;
    Ok(Status {
        installed: bundle.is_some(),
        system: crate::mac_file_handlers::status(bundle.as_deref()),
        codex: CodexStatus {
            available: path.exists() || crate::mac_file_handlers::available("com.openai.codex"),
            configured: match executable {
                Some(executable) => crate::codex_config::configured(&path, &executable)?,
                None => false,
            },
        },
        claude: ClaudeStatus {
            available: crate::mac_file_handlers::available("com.anthropic.claudefordesktop"),
            supported: false,
        },
    })
}

#[cfg(target_os = "macos")]
pub(crate) async fn execute(
    app: tauri::AppHandle,
    action: String,
    extensions: Vec<String>,
) -> Result<Value, String> {
    if !matches!(action.as_str(), "status" | "system" | "codex") {
        return Err("Unknown integration action".into());
    }
    if action == "status" {
        return serde_json::to_value(status()?).map_err(|e| e.to_string());
    }
    let _guard = SETUP
        .try_lock()
        .map_err(|_| "Integration setup is already running")?;
    let bundle = installed().ok_or("Install BOA in Applications first")?;
    let backup = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (changed, failures) = if action == "codex" {
        let changed = crate::codex_config::apply(
            &codex_path()?,
            &bundle.join("Contents/MacOS/boa"),
            &backup.join("codex-integration-before.toml"),
        )?;
        (usize::from(changed), vec![])
    } else {
        crate::mac_file_handlers::apply(
            &app,
            &bundle,
            &backup.join("file-handlers-backup.json"),
            &extensions,
        )
        .await?
    };
    Ok(
        json!({"status":status()?,"restartRequired":action=="codex","changed":changed,"failures":failures}),
    )
}

use tauri::Manager;

#[cfg(not(target_os = "macos"))]
pub(crate) async fn execute(
    _app: tauri::AppHandle,
    _action: String,
    _extensions: Vec<String>,
) -> Result<Value, String> {
    Err("Editor integrations require macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_updates_refuse_symlinks_and_concurrent_changes_and_keep_backup() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config");
        write_private(&path, "first", None).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert!(write_private(&path, "overwrite backup", None).is_err());
        assert!(write_private(&path, "changed", Some("outdated")).is_err());
        assert_eq!(read_private(&path).unwrap(), "first");
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(read_private(&link).is_err());
        assert!(write_private(&link, "changed", Some("first")).is_err());
        write_private(&path, "next", Some("first")).unwrap();
        assert_eq!(read_private(&path).unwrap(), "next");
    }
}
