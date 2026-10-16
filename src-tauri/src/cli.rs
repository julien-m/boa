//! Private, bounded local RPC for the agent-friendly CLI. No shell or arbitrary commands.
use crate::projects::AppState;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::Emitter;

const MAX_REQUEST: u64 = 65_536;
const IO_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "lowercase", deny_unknown_fields)]
enum Request {
    List {},
    Add {
        path: String,
        #[serde(default)]
        pin: bool,
    },
    Pin {
        path: String,
    },
    Unpin {
        path: String,
    },
}

fn uid() -> u32 {
    // SAFETY: geteuid has no arguments and no memory access contract.
    unsafe { libc::geteuid() }
}

fn socket_path() -> PathBuf {
    PathBuf::from(format!("/tmp/boa-cli-{}/rpc.sock", uid()))
}

fn bind(path: &Path) -> Result<UnixListener, String> {
    let parent = path.parent().ok_or("Dossier RPC manquant")?;
    match fs::create_dir(parent) {
        Ok(()) => fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error.to_string()),
    }
    let metadata = fs::symlink_metadata(parent).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.uid() != uid() || metadata.mode() & 0o077 != 0 {
        return Err("Dossier RPC non privé ou propriétaire incorrect".into());
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.file_type().is_socket() || metadata.uid() != uid() {
            return Err("Chemin RPC non sûr".into());
        }
        if UnixStream::connect(path).is_ok() {
            return Err("Une instance RPC BOA est déjà active".into());
        }
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    let listener = UnixListener::bind(path).map_err(|e| e.to_string())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    Ok(listener)
}

fn execute(state: &AppState, request: Request) -> Result<(Value, bool), String> {
    match request {
        Request::List {} => Ok((json!(state.list_projects()?), false)),
        Request::Add { path, pin } => {
            let project = state.add_project(Path::new(&path))?;
            let project = if pin {
                state.pin_project(&project.path, true)?
            } else {
                project
            };
            Ok((json!(project), true))
        }
        Request::Pin { path } => Ok((json!(state.pin_project(&path, true)?), true)),
        Request::Unpin { path } => Ok((json!(state.pin_project(&path, false)?), true)),
    }
}

fn serve(mut stream: UnixStream, state: &AppState, changed: impl FnOnce()) -> Result<(), String> {
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    let read = BufReader::new((&stream).take(MAX_REQUEST + 1)).read_until(b'\n', &mut bytes);
    let result = match read {
        Ok(_) if bytes.len() as u64 > MAX_REQUEST => Err("Requête RPC trop grande".into()),
        Ok(_) if bytes.last() != Some(&b'\n') => Err("Requête RPC incomplète".into()),
        Ok(_) => serde_json::from_slice::<Request>(&bytes)
            .map_err(|e| format!("Requête RPC invalide : {e}"))
            .and_then(|request| execute(state, request)),
        Err(error) => Err(format!("Lecture RPC : {error}")),
    };
    let response = match result {
        Ok((value, did_change)) => {
            if did_change {
                changed();
            }
            json!({"ok": true, "result": value})
        }
        Err(error) => json!({"ok": false, "error": error}),
    };
    let mut encoded = serde_json::to_vec(&response).map_err(|e| e.to_string())?;
    encoded.push(b'\n');
    stream.write_all(&encoded).map_err(|e| e.to_string())
}

pub(crate) fn start(app: tauri::AppHandle, state: Arc<AppState>) -> Result<(), String> {
    let listener = bind(&socket_path())?;
    std::thread::Builder::new()
        .name("boa-cli".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = serve(stream, &state, || {
                    let _ = app.emit("boa:projects-changed", ());
                });
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn rpc(state: &AppState, text: &[u8]) -> Value {
        let (mut client, server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client.write_all(text).unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();
        serve(server, state, || ()).unwrap();
        let mut response = String::new();
        BufReader::new(client).read_line(&mut response).unwrap();
        serde_json::from_str(&response).unwrap()
    }

    #[test]
    fn rpc_lists_adds_and_pins_only_explicit_projects() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        fs::create_dir(&project).unwrap();
        let state = AppState::new(temp.path().join("config.json")).unwrap();
        assert_eq!(
            rpc(&state, b"{\"command\":\"list\"}\n")["result"],
            json!([])
        );
        let request = json!({"command":"add", "path":project, "pin":true});
        let added = rpc(&state, format!("{request}\n").as_bytes());
        assert_eq!(added["result"]["pinned"], true);
        let path = added["result"]["path"].as_str().unwrap();
        let unpin = json!({"command":"unpin", "path":path});
        assert_eq!(
            rpc(&state, format!("{unpin}\n").as_bytes())["result"]["pinned"],
            false
        );
        assert_eq!(
            rpc(&state, b"{\"command\":\"exec\",\"shell\":\"pwd\"}\n")["ok"],
            false
        );
        assert_eq!(
            rpc(&state, b"{\"command\":\"list\",\"extra\":true}\n")["ok"],
            false
        );
        assert_eq!(rpc(&state, b"{} ")["ok"], false);
    }

    #[test]
    fn rpc_change_event_follows_success_and_persistence() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path().join("config.json")).unwrap();
        let (mut client, server) = UnixStream::pair().unwrap();
        let changed = AtomicBool::new(false);
        let request = json!({"command":"add", "path":temp.path()});
        client.write_all(format!("{request}\n").as_bytes()).unwrap();
        serve(server, &state, || {
            changed.store(true, Ordering::SeqCst);
        })
        .unwrap();
        assert!(changed.load(Ordering::SeqCst));
        let restored = AppState::new(temp.path().join("config.json")).unwrap();
        assert_eq!(restored.config.lock().unwrap().projects.len(), 1);
    }

    #[test]
    fn socket_is_private_rejects_symlinks_and_serves_real_connections() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("private/rpc.sock");
        let listener = bind(&path).unwrap();
        assert_eq!(
            fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777,
            0o700
        );
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        let state = AppState::new(temp.path().join("config.json")).unwrap();
        let thread = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve(stream, &state, || ()).unwrap();
        });
        let mut client = UnixStream::connect(&path).unwrap();
        client.write_all(b"{\"command\":\"list\"}\n").unwrap();
        let mut response = String::new();
        BufReader::new(client).read_line(&mut response).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap()["ok"],
            true
        );
        thread.join().unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(temp.path().join("other"), &path).unwrap();
        assert!(bind(&path).is_err());
    }

    #[test]
    fn rpc_rejects_oversized_requests() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(temp.path().join("config.json")).unwrap());
        let (mut client, server) = UnixStream::pair().unwrap();
        let thread = std::thread::spawn(move || serve(server, &state, || ()).unwrap());
        client
            .write_all(&vec![b'x'; MAX_REQUEST as usize + 1])
            .unwrap();
        let mut response = String::new();
        BufReader::new(client).read_line(&mut response).unwrap();
        assert!(response.contains("trop grande"));
        thread.join().unwrap();
    }
}
