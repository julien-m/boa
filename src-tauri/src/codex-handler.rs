//! Installed-app file handler. This mode runs before Tauri's application lifecycle.
use crate::context_views::Receipt;
use serde_json::{Value, json};
use std::{
    ffi::OsString,
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt},
        net::UnixStream,
    },
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use wait_timeout::ChildExt;

const MAX_INPUT: usize = 65_536;
const MAX_RESPONSE: u64 = 2 * 1024 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug)]
struct Target {
    file: String,
    line: u32,
}

fn parse(input: &str) -> Result<Target, String> {
    if input.len() > MAX_INPUT {
        return Err("File-handler input is too large".into());
    }
    let value: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let object = value
        .as_object()
        .ok_or("Expected a desktop file-handler JSON object")?;
    if ["hostConfig", "remotePath", "remoteWorkspaceRoot"]
        .iter()
        .any(|key| object.get(*key).is_some_and(|value| !value.is_null()))
    {
        return Err("Remote files are not supported by the BOA handler".into());
    }
    let file = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or("Expected an absolute local file path")?;
    let path = Path::new(file);
    let invalid_path = "Expected an existing absolute local file or folder";
    if !path.is_absolute()
        || file.contains('\0')
        || path.components().any(|p| matches!(p, Component::ParentDir))
    {
        return Err(invalid_path.into());
    }
    let file = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() || metadata.is_dir() => file,
        Ok(metadata) if metadata.is_symlink() && (path.is_file() || path.is_dir()) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            recover_codex_absolute_path(file).ok_or(invalid_path)?
        }
        _ => return Err(invalid_path.into()),
    };
    let line = match object.get("location").filter(|value| !value.is_null()) {
        None => 1,
        Some(location) => location
            .as_object()
            .and_then(|location| location.get("line"))
            .and_then(Value::as_f64)
            .filter(|line| line.fract() == 0.0 && (1.0..=1_000_000.0).contains(line))
            .ok_or("Expected a 1-based line between 1 and 1000000")?
            as u32,
    };
    Ok(Target {
        file: file.to_string(),
        line,
    })
}

fn recover_codex_absolute_path(file: &str) -> Option<&str> {
    // Codex can prepend the chat directory when a link starts with U+200B.
    let separator = file.find("/\u{200b}/")?;
    let (workspace, marked_path) = file.split_at(separator + 1);
    let absolute = marked_path.strip_prefix('\u{200b}')?;
    let path = Path::new(absolute);
    (Path::new(workspace).is_dir() && (path.is_file() || path.is_dir())).then_some(absolute)
}

/// A directly invoked installed executable must launch its own bundle, never a name lookup.
pub(crate) fn installed_bundle(executable: &Path) -> Result<PathBuf, String> {
    let macos = executable
        .parent()
        .ok_or("Missing application executable")?;
    let contents = macos.parent().ok_or("Missing application Contents")?;
    let bundle = contents.parent().ok_or("Missing application bundle")?;
    if executable.file_name().and_then(|s| s.to_str()) != Some("boa")
        || macos.file_name().and_then(|s| s.to_str()) != Some("MacOS")
        || contents.file_name().and_then(|s| s.to_str()) != Some("Contents")
        || bundle.extension().and_then(|s| s.to_str()) != Some("app")
        || !contents.join("Info.plist").is_file()
    {
        return Err("Install BOA.app before configuring the Codex file handler".into());
    }
    let mut child = Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(contents.join("Info.plist"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let status = child
        .wait_timeout(Duration::from_secs(1))
        .map_err(|e| e.to_string())?;
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Application identity check timed out".into());
    }
    let mut identifier = String::new();
    child
        .stdout
        .take()
        .ok_or("Missing application identity")?
        .take(256)
        .read_to_string(&mut identifier)
        .map_err(|e| e.to_string())?;
    if !status.is_some_and(|status| status.success()) || identifier.trim() != "com.julienm.boa" {
        return Err("Expected the installed BOA application bundle".into());
    }
    Ok(bundle.to_path_buf())
}

fn launch(bundle: &Path, folder: Option<&str>) -> Result<(), String> {
    // The OS routes the selected folder as a local file URL to this exact installed bundle.
    let mut command = Command::new("/usr/bin/open");
    command.arg("-a").arg(bundle);
    if let Some(folder) = folder {
        command.arg(folder);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not launch BOA: {e}"))?;
    match child
        .wait_timeout(Duration::from_secs(3))
        .map_err(|e| e.to_string())?
    {
        Some(status) if status.success() => Ok(()),
        Some(status) => Err(format!("BOA launch failed: {status}")),
        None => {
            let _ = child.kill();
            let _ = child.wait();
            Err("BOA launch timed out".into())
        }
    }
}

fn uid() -> u32 {
    // SAFETY: geteuid has no arguments or memory-access contract.
    unsafe { libc::geteuid() }
}

fn connect(path: &Path) -> Result<UnixStream, String> {
    let parent = path.parent().ok_or("Missing RPC directory")?;
    let directory = fs::symlink_metadata(parent).map_err(|e| e.to_string())?;
    let socket = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !directory.is_dir()
        || directory.uid() != uid()
        || directory.mode() & 0o077 != 0
        || !socket.file_type().is_socket()
        || socket.uid() != uid()
        || socket.mode() & 0o077 != 0
    {
        return Err("BOA RPC path is not private or has the wrong owner".into());
    }
    // Unix-domain connect has no std timeout API and can block behind a full backlog.
    // This short-lived handler process bounds that wait too; late streams are dropped.
    let path = path.to_path_buf();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    thread::Builder::new()
        .name("boa-handler-connect".into())
        .spawn(move || {
            let _ = sender.send(UnixStream::connect(path));
        })
        .map_err(|e| e.to_string())?;
    receiver
        .recv_timeout(IO_TIMEOUT)
        .map_err(|_| "BOA RPC connection timed out".to_string())?
        .map_err(|e| e.to_string())
}

fn request(mut stream: UnixStream, value: &Value, timeout: Duration) -> Result<Receipt, String> {
    stream
        .set_read_timeout(Some(timeout.min(IO_TIMEOUT)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(timeout.min(IO_TIMEOUT)))
        .map_err(|e| e.to_string())?;
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_INPUT {
        return Err("File-handler RPC request is too large".into());
    }
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    BufReader::new(stream.take(MAX_RESPONSE + 1))
        .read_until(b'\n', &mut response)
        .map_err(|e| e.to_string())?;
    if response.len() as u64 > MAX_RESPONSE || response.last() != Some(&b'\n') {
        return Err("Invalid or oversized BOA RPC response".into());
    }
    let response: Value = serde_json::from_slice(&response).map_err(|e| e.to_string())?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("BOA rejected the file-handler request")
            .to_string());
    }
    serde_json::from_value(response["result"].clone()).map_err(|e| e.to_string())
}

fn open(target: Target, bundle: &Path) -> Result<Receipt, String> {
    launch(bundle, None)?;
    let socket = PathBuf::from(format!("/tmp/boa-cli-{}/rpc.sock", uid()));
    let startup = Instant::now() + Duration::from_secs(8);
    let stream = loop {
        match connect(&socket) {
            Ok(stream) => break stream,
            Err(error) if Instant::now() >= startup => {
                return Err(format!("Could not connect to BOA: {error}"));
            }
            Err(_) => thread::sleep(Duration::from_millis(100)),
        }
    };
    let mut receipt = request(
        stream,
        &json!({
            "command":"reader-open", "file":target.file, "line":target.line,
            "endLine":target.line, "source":"Codex", "register":true
        }),
        IO_TIMEOUT,
    )?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while receipt.status == "pending" {
        thread::sleep(Duration::from_millis(100));
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        receipt = request(
            connect(&socket)?,
            &json!({"command":"reader-status", "requestId":receipt.request_id}),
            remaining,
        )?;
    }
    Ok(receipt)
}

enum OpenOutcome {
    Reader(Box<Receipt>),
    FolderRequested(String),
}

fn run(args: &[OsString]) -> Result<OpenOutcome, String> {
    if args.len() != 2 {
        return Err("Usage: boa --codex-open '<handler-json>'".into());
    }
    let input = args[1].to_str().ok_or("Invalid file-handler encoding")?;
    let target = parse(input)?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = installed_bundle(&executable)?;
    // A folder has no reader passage to acknowledge; navigation is handed to the native URL route.
    if Path::new(&target.file).is_dir() {
        launch(&bundle, Some(&target.file))?;
        return Ok(OpenOutcome::FolderRequested(target.file));
    }
    open(target, &bundle).map(|receipt| OpenOutcome::Reader(Box::new(receipt)))
}

/// Return `None` for the normal GUI launch; this entry never starts a second Tauri instance.
pub fn codex_open_entry() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().and_then(|arg| arg.to_str()) != Some("--codex-open") {
        return None;
    }
    Some(match run(&args) {
        Ok(OpenOutcome::Reader(receipt)) => {
            println!("{}", json!({"ok":true,"result":receipt}));
            if receipt.status == "displayed" { 0 } else { 2 }
        }
        Ok(OpenOutcome::FolderRequested(file)) => {
            println!(
                "{}",
                json!({"ok":true,"result":{"status":"requested","file":file}})
            );
            0
        }
        Err(error) => {
            eprintln!("{}", json!({"ok":false,"error":error}));
            1
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::{PermissionsExt, symlink},
        os::unix::net::UnixListener,
    };

    #[test]
    fn native_payload_preserves_line_and_defaults_null_locations() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("notes.md");
        fs::write(&file, "# Notes\n").unwrap();
        let payload = json!({"path":file,"location":{"line":16,"column":3},"target":"custom:boa"});
        let target = parse(&payload.to_string()).unwrap();
        assert_eq!(Path::new(&target.file), file);
        assert_eq!(target.line, 16);
        let payload = json!({"path":file,"location":null});
        assert_eq!(parse(&payload.to_string()).unwrap().line, 1);
        let payload = json!({"path":file,"location":{"line":2.0}});
        assert_eq!(parse(&payload.to_string()).unwrap().line, 2);
        for location in [
            json!({"line":0}),
            json!({"line":1.5}),
            json!({"line":1_000_001}),
            json!([]),
        ] {
            assert!(parse(&json!({"path":file,"location":location}).to_string()).is_err());
        }
        assert!(parse(&json!({"path":file,"remotePath":"/remote"}).to_string()).is_err());
        assert_eq!(
            Path::new(
                &parse(&json!({"path":temp.path()}).to_string())
                    .unwrap()
                    .file
            ),
            temp.path()
        );
        assert!(parse(&json!({"path":temp.path().join("missing")}).to_string()).is_err());
    }

    #[test]
    fn native_payload_recovers_marked_absolute_paths_only_when_needed() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("chat");
        fs::create_dir(&workspace).unwrap();
        let file = temp.path().join("notes.md");
        fs::write(&file, "# Notes\n").unwrap();
        let marked = format!("{}/\u{200b}{}", workspace.display(), file.display());
        let payload = json!({"path":marked,"location":{"line":3}});
        let target = parse(&payload.to_string()).unwrap();
        assert_eq!(Path::new(&target.file), file);
        assert_eq!(target.line, 3);
        let unmarked = format!("{}{}", workspace.display(), file.display());
        let traversal = format!("{}/../chat/\u{200b}{}", workspace.display(), file.display());
        for path in [unmarked, traversal, format!("{marked}.missing")] {
            assert!(parse(&json!({"path":path}).to_string()).is_err());
        }
        assert!(parse(&json!({"path":marked,"remotePath":"/remote"}).to_string()).is_err());

        let literal = Path::new(&marked);
        fs::create_dir_all(literal.parent().unwrap()).unwrap();
        symlink(file.with_extension("missing"), literal).unwrap();
        assert!(parse(&payload.to_string()).is_err());
        fs::remove_file(literal).unwrap();
        symlink(&file, literal).unwrap();
        assert_eq!(parse(&payload.to_string()).unwrap().file, marked);
        fs::remove_file(literal).unwrap();
        fs::write(literal, "# Local notes\n").unwrap();
        assert_eq!(parse(&payload.to_string()).unwrap().file, marked);
    }

    #[test]
    fn bundle_lookup_rejects_uninstalled_executables() {
        let temp = tempfile::tempdir().unwrap();
        let bundle = temp.path().join("BOA.app");
        let executable = bundle.join("Contents/MacOS/boa");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        assert!(installed_bundle(&executable).is_err());
        fs::write(bundle.join("Contents/Info.plist"), "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>com.julienm.boa</string></dict></plist>").unwrap();
        assert_eq!(installed_bundle(&executable).unwrap(), bundle);
        assert!(installed_bundle(&temp.path().join("boa")).is_err());
        fs::write(bundle.join("Contents/Info.plist"), "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>").unwrap();
        assert!(installed_bundle(&executable).is_err());
    }

    #[test]
    fn native_client_checks_private_paths_and_accepts_bounded_receipts() {
        let temp = tempfile::tempdir().unwrap();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let socket = temp.path().join("rpc.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = String::new();
            BufReader::new(&stream).read_line(&mut bytes).unwrap();
            let request: Value = serde_json::from_str(&bytes).unwrap();
            assert_eq!(request["command"], "reader-status");
            let response = json!({"ok":true,"result":{
                "requestId":"request", "status":"displayed",
                "request":{"requestId":"request","file":"/source.ts","line":2,"endLine":2,"source":"Codex"}
            }});
            writeln!(stream, "{response}").unwrap();
        });
        let receipt = request(
            connect(&socket).unwrap(),
            &json!({"command":"reader-status"}),
            IO_TIMEOUT,
        )
        .unwrap();
        assert_eq!(receipt.status, "displayed");
        worker.join().unwrap();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(connect(&socket).is_err());
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let alias = temp.path().join("alias.sock");
        std::os::unix::fs::symlink(&socket, &alias).unwrap();
        assert!(connect(&alias).is_err());
    }
}
