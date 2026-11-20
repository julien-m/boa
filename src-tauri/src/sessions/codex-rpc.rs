//! Bounded JSON-RPC client for the Codex app-server protocol.
//!
//! Two transports carry the same messages:
//! - the shared daemon control socket (`$CODEX_HOME/app-server-control/app-server-control.sock`),
//!   which speaks WebSocket text frames over a Unix socket;
//! - a private `codex app-server` child over stdio (newline-delimited JSON), used only for
//!   read-only history when no daemon runs. It cannot see live state owned by other processes.
use super::model::{SessionError, SessionResult};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{Receiver, RecvTimeoutError, channel},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{Message, WebSocket, client::IntoClientRequest};

/// Matches the CLI client budget; a turn/start answer arrives well under a second when healthy.
pub(crate) const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// Responses beyond 8 MiB indicate an unbounded history request; refuse instead of buffering.
const MAX_MESSAGE: usize = 8 * 1024 * 1024;
const CLIENT_NAME: &str = "boa";

/// One JSON message channel; implementations own their socket or child process.
pub(crate) trait RpcTransport: Send {
    fn write(&mut self, message: &Value) -> SessionResult<()>;
    /// Reads the next message before `deadline`; `Ok(None)` means the deadline passed.
    fn read(&mut self, deadline: Instant) -> SessionResult<Option<Value>>;
}

/// WebSocket over the daemon's Unix control socket.
pub(crate) struct DaemonTransport {
    socket: WebSocket<UnixStream>,
}

impl DaemonTransport {
    /// Connects and performs the WebSocket upgrade. A missing socket is `codex_daemon_not_running`.
    pub(crate) fn connect(socket_path: &Path) -> SessionResult<Self> {
        let stream = UnixStream::connect(socket_path).map_err(|error| {
            SessionError::new(
                "codex_daemon_not_running",
                format!("daemon socket unavailable: {}", error.kind()),
            )
        })?;
        stream
            .set_read_timeout(Some(CALL_TIMEOUT))
            .map_err(SessionError::io)?;
        stream
            .set_write_timeout(Some(CALL_TIMEOUT))
            .map_err(SessionError::io)?;
        let request = "ws://localhost/"
            .into_client_request()
            .map_err(|e| SessionError::new("codex_protocol", e.to_string()))?;
        let (socket, _) = tungstenite::client::client(request, stream)
            .map_err(|e| SessionError::new("codex_protocol", e.to_string()))?;
        Ok(Self { socket })
    }
}

impl RpcTransport for DaemonTransport {
    fn write(&mut self, message: &Value) -> SessionResult<()> {
        self.socket
            .send(Message::text(message.to_string()))
            .map_err(|e| SessionError::new("codex_transport", e.to_string()))
    }

    fn read(&mut self, deadline: Instant) -> SessionResult<Option<Value>> {
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            self.socket
                .get_mut()
                .set_read_timeout(Some(remaining))
                .map_err(SessionError::io)?;
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    if text.len() > MAX_MESSAGE {
                        return Err(SessionError::new("codex_protocol", "message too large"));
                    }
                    return serde_json::from_str(text.as_str())
                        .map(Some)
                        .map_err(|e| SessionError::new("codex_protocol", e.to_string()));
                }
                Ok(Message::Close(_)) => {
                    return Err(SessionError::new("codex_transport", "daemon closed"));
                }
                // Ping/pong are answered by tungstenite; binary frames are not part of the protocol.
                Ok(_) => continue,
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(None);
                }
                Err(error) => return Err(SessionError::new("codex_transport", error.to_string())),
            }
        }
    }
}

impl Drop for DaemonTransport {
    fn drop(&mut self) {
        // Best effort: the daemon tolerates abrupt disconnects; a close frame is courtesy only.
        let _ = self.socket.close(None);
        let _ = self.socket.flush();
    }
}

/// Private `codex app-server` child over stdio. Killed on drop.
pub(crate) struct ChildTransport {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<SessionResult<Value>>,
}

impl ChildTransport {
    /// Spawns `<codex> app-server` with a controlled environment (no shell).
    pub(crate) fn spawn(binary: &Path, path_env: &str, codex_home: &Path) -> SessionResult<Self> {
        let mut child = Command::new(binary)
            .arg("app-server")
            .env("PATH", path_env)
            .env("CODEX_HOME", codex_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| SessionError::new("codex_unavailable", e.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SessionError::new("codex_unavailable", "stdin missing"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SessionError::new("codex_unavailable", "stdout missing"))?;
        let (sender, lines) = channel();
        // The reader thread ends when the child closes stdout (killed on drop of this transport).
        thread::Builder::new()
            .name("boa-codex-stdio".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) if line.len() > MAX_MESSAGE => {
                            let _ = sender.send(Err(SessionError::new(
                                "codex_protocol",
                                "message too large",
                            )));
                            break;
                        }
                        Ok(_) => {
                            let parsed = serde_json::from_str(line.trim())
                                .map_err(|e| SessionError::new("codex_protocol", e.to_string()));
                            if sender.send(parsed).is_err() {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = sender.send(Err(SessionError::io(error)));
                            break;
                        }
                    }
                }
            })
            .map_err(SessionError::io)?;
        Ok(Self {
            child,
            stdin,
            lines,
        })
    }
}

impl RpcTransport for ChildTransport {
    fn write(&mut self, message: &Value) -> SessionResult<()> {
        writeln!(self.stdin, "{message}")
            .and_then(|()| self.stdin.flush())
            .map_err(|e| SessionError::new("codex_transport", e.to_string()))
    }

    fn read(&mut self, deadline: Instant) -> SessionResult<Option<Value>> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match self.lines.recv_timeout(remaining) {
            Ok(result) => result.map(Some),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => {
                Err(SessionError::new("codex_transport", "app-server exited"))
            }
        }
    }
}

impl Drop for ChildTransport {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Request/response correlation over a transport; notifications are buffered for the caller.
pub(crate) struct RpcClient {
    transport: Box<dyn RpcTransport>,
    next_id: u64,
    pub(crate) notifications: Vec<Value>,
}

/// Distinguishes "the request may have been applied" from a clean failure.
#[derive(Debug)]
pub(crate) enum CallError {
    /// The provider rejected the request, or the transport reported a write failure.
    Failed(SessionError),
    /// The request was written but no response was received. Carries the receive failure.
    Unknown(SessionError),
}

impl CallError {
    /// Returns the underlying session error when the caller needs the transport diagnostic.
    pub(crate) fn into_error(self) -> SessionError {
        match self {
            CallError::Failed(error) | CallError::Unknown(error) => error,
        }
    }
}

impl RpcClient {
    /// Performs the protocol handshake. `experimental` opts into the provider queue API.
    pub(crate) fn initialize(
        transport: Box<dyn RpcTransport>,
        experimental: bool,
    ) -> SessionResult<Self> {
        let mut client = Self {
            transport,
            next_id: 0,
            notifications: Vec::new(),
        };
        client
            .call(
                "initialize",
                json!({
                    "clientInfo": {"name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {"experimentalApi": experimental},
                }),
            )
            .map_err(CallError::into_error)?;
        client.transport.write(&json!({"method": "initialized"}))?;
        Ok(client)
    }

    /// Sends one request and waits for its response within `CALL_TIMEOUT`.
    pub(crate) fn call(&mut self, method: &str, params: Value) -> Result<Value, CallError> {
        self.next_id += 1;
        let id = self.next_id;
        self.transport
            .write(&json!({"id": id, "method": method, "params": params}))
            .map_err(CallError::Failed)?;
        let deadline = Instant::now() + CALL_TIMEOUT;
        loop {
            // Once the transport has accepted the write, loss of the reply leaves the result unknown.
            let Some(message) = self.transport.read(deadline).map_err(CallError::Unknown)? else {
                return Err(CallError::Unknown(SessionError::new(
                    "codex_timeout",
                    "no answer in time",
                )));
            };
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    let text = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("codex error");
                    return Err(CallError::Failed(SessionError::new(
                        "codex_rejected",
                        text.chars().take(300).collect::<String>(),
                    )));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            // Server-initiated requests (approvals) are not BOA's to answer; the owning UI decides.
            if message.get("method").is_some()
                && message.get("id").is_none()
                && self.notifications.len() < 256
            {
                self.notifications.push(message);
            }
        }
    }

    /// Waits for the next notification (used by the live subscriber).
    pub(crate) fn next_notification(&mut self, deadline: Instant) -> SessionResult<Option<Value>> {
        if !self.notifications.is_empty() {
            return Ok(Some(self.notifications.remove(0)));
        }
        loop {
            match self.transport.read(deadline)? {
                Some(message) if message.get("method").is_some() && message.get("id").is_none() => {
                    return Ok(Some(message));
                }
                Some(_) => continue,
                None => return Ok(None),
            }
        }
    }
}

/// Default Codex home: `$CODEX_HOME` or `~/.codex`.
pub(crate) fn default_codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
}

pub(crate) fn daemon_socket(codex_home: &Path) -> PathBuf {
    codex_home
        .join("app-server-control")
        .join("app-server-control.sock")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Scripted {
        replies: VecDeque<SessionResult<Value>>,
        written: Vec<Value>,
    }
    impl RpcTransport for Scripted {
        fn write(&mut self, message: &Value) -> SessionResult<()> {
            self.written.push(message.clone());
            Ok(())
        }
        fn read(&mut self, _: Instant) -> SessionResult<Option<Value>> {
            self.replies.pop_front().transpose()
        }
    }

    #[test]
    fn call_matches_responses_and_distinguishes_rejection_from_missing_replies() {
        let transport = Scripted {
            replies: VecDeque::from(vec![
                Ok(json!({"id": 1, "result": {}})),
                Ok(json!({"method": "thread/status/changed", "params": {}})),
                Ok(json!({"id": 2, "result": {"ok": true}})),
                Ok(json!({"id": 3, "error": {"message": "nope"}})),
                Err(SessionError::new("codex_transport", "daemon closed")),
            ]),
            written: vec![],
        };
        let mut client = RpcClient::initialize(Box::new(transport), false).unwrap();
        assert_eq!(client.call("a", json!({})).unwrap()["ok"], true);
        assert_eq!(client.notifications.len(), 1);
        match client.call("b", json!({})) {
            Err(CallError::Failed(error)) => assert_eq!(error.code, "codex_rejected"),
            other => panic!("unexpected {other:?}"),
        }
        for (method, code) in [("c", "codex_transport"), ("d", "codex_timeout")] {
            let error = client.call(method, json!({})).unwrap_err();
            assert!(matches!(error, CallError::Unknown(_)), "{error:?}");
            assert_eq!(error.into_error().code, code);
        }
    }
}
