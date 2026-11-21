//! Claude Code adapter: official Agent SDK through the bundled Node bridge, plus
//! `claude agents --json` (documented for scripts) for live process status.
//!
//! Ownership rules (verified against Claude Code 2.1.326 / SDK 0.3.326):
//! - A session listed by `claude agents --json` is held by another process. BOA does not
//!   resume it (that would create a second owner) and refuses to send to it.
//! - Any other session can be resumed by BOA through `query({resume})`; BOA then owns it
//!   until the bridge closes it, and its state is exact.
use super::model::{
    Capabilities, Capability, ConversationEntry, ConversationRole, CreateSessionReceipt, Provider,
    SendReceipt, SessionError, SessionKey, SessionResult, SessionState, StateEvidence,
    TitleWarning,
};
use super::provider::{ProviderListing, ProviderSession, ProviderStatus, SessionProvider};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        mpsc::{Sender, channel},
    },
    thread,
    time::Duration,
};

/// Catalog/history/rename calls answer within seconds; 60 s bounds a stuck bridge.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// A send waits for Claude Code's per-message acknowledgement (bridge deadline 120 s, cold start
/// ≈42 s observed); 130 s lets the bridge report its own unknown result first.
const SEND_TIMEOUT: Duration = Duration::from_secs(130);
const AGENTS_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_LINE: usize = 8 * 1024 * 1024;
/// Matches the rename input limit in scripts/claude-bridge.ts.
const MAX_TITLE_UTF16: usize = 200;

/// Receives bridge events (`sessionStarted`, `permissionRequest`, `turnCompleted`, ...).
pub(crate) type EventSink = Arc<dyn Fn(Value) + Send + Sync>;

/// The short prompt shown in BOA, retained only while this bridge awaits a decision.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionPrompt {
    session_id: String,
    request_id: String,
    tool_name: String,
    summary: String,
}

fn update_permissions(prompts: &mut Vec<PermissionPrompt>, event: &Value) {
    let session_id = event.get("sessionId").and_then(Value::as_str);
    let request_id = event.get("requestId").and_then(Value::as_str);
    match event.get("event").and_then(Value::as_str) {
        Some("permissionRequest") => {
            if let Ok(prompt) = PermissionPrompt::deserialize(event)
                && !prompts.iter().any(|active| {
                    active.session_id == prompt.session_id && active.request_id == prompt.request_id
                })
            {
                prompts.push(prompt);
            }
        }
        Some("permissionResolved") => prompts.retain(|prompt| {
            Some(prompt.session_id.as_str()) != session_id
                || Some(prompt.request_id.as_str()) != request_id
        }),
        Some("turnCompleted" | "sessionClosed") => {
            prompts.retain(|prompt| Some(prompt.session_id.as_str()) != session_id);
        }
        _ => {}
    }
}

struct Bridge {
    child: Child,
    stdin: ChildStdin,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    permissions: Arc<Mutex<Vec<PermissionPrompt>>>,
    next_id: u64,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) struct ClaudeProvider {
    claude: Option<PathBuf>,
    node: Option<PathBuf>,
    child_path: String,
    bridge_script: Mutex<Option<PathBuf>>,
    bridge: Mutex<Option<Bridge>>,
    events: Mutex<Option<EventSink>>,
}

impl ClaudeProvider {
    pub(crate) fn new(claude: Option<PathBuf>, node: Option<PathBuf>, child_path: String) -> Self {
        Self {
            claude,
            node,
            child_path,
            bridge_script: Mutex::new(default_bridge_script()),
            bridge: Mutex::new(None),
            events: Mutex::new(None),
        }
    }

    /// Composition hook: the packaged app passes its resource path; dev keeps the build output.
    pub(crate) fn set_bridge_script(&self, path: PathBuf) {
        if let Ok(mut current) = self.bridge_script.lock() {
            *current = Some(path);
        }
    }

    pub(crate) fn set_event_sink(&self, sink: EventSink) {
        if let Ok(mut current) = self.events.lock() {
            *current = Some(sink);
        }
    }

    fn spawn_bridge(&self) -> SessionResult<Bridge> {
        let node = self.node.as_deref().ok_or_else(|| {
            SessionError::new("claude_runtime_missing", "node executable not found")
        })?;
        let claude = self.claude.as_deref().ok_or_else(|| {
            SessionError::new("claude_unavailable", "claude executable not found")
        })?;
        let script = self
            .bridge_script
            .lock()
            .map_err(|_| SessionError::new("claude_unavailable", "bridge lock"))?
            .clone()
            .filter(|path| path.is_file())
            .ok_or_else(|| SessionError::new("claude_bridge_missing", "bridge script missing"))?;
        // Contract: node runs the bundled bridge; NDJSON on stdio; exits when stdin closes.
        let mut child = Command::new(node)
            .arg(script)
            .env("PATH", &self.child_path)
            .env("BOA_CLAUDE_BIN", claude)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| SessionError::new("claude_unavailable", e.to_string()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SessionError::new("claude_unavailable", "stdin missing"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SessionError::new("claude_unavailable", "stdout missing"))?;
        let pending: Arc<Mutex<HashMap<u64, Sender<Value>>>> = Arc::default();
        let routes = Arc::clone(&pending);
        let events = self.events.lock().ok().and_then(|sink| sink.clone());
        let permissions: Arc<Mutex<Vec<PermissionPrompt>>> = Arc::default();
        let prompts = Arc::clone(&permissions);
        // Owned reader: routes responses by id and forwards events; ends with the child.
        thread::Builder::new()
            .name("boa-claude-bridge".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                while matches!(reader.read_line(&mut line), Ok(n) if n > 0) {
                    if line.len() <= MAX_LINE
                        && let Ok(message) = serde_json::from_str::<Value>(line.trim())
                    {
                        match message.get("id").and_then(Value::as_u64) {
                            Some(id) => {
                                if let Some(sender) =
                                    routes.lock().ok().and_then(|mut p| p.remove(&id))
                                {
                                    let _ = sender.send(message);
                                }
                            }
                            None => {
                                // Update the snapshot before notifying webviews so a late listener
                                // can read the same state as one that saw the original event.
                                if let Ok(mut current) = prompts.lock() {
                                    update_permissions(&mut current, &message);
                                }
                                if let Some(sink) = &events {
                                    sink(message);
                                }
                            }
                        }
                    }
                    line.clear();
                }
                if let Ok(mut routes) = routes.lock() {
                    routes.clear();
                }
                let had_permissions = prompts.lock().is_ok_and(|mut current| {
                    let had_permissions = !current.is_empty();
                    current.clear();
                    had_permissions
                });
                if had_permissions && let Some(sink) = &events {
                    sink(json!({"event": "claudeBridgeClosed"}));
                }
            })
            .map_err(SessionError::io)?;
        Ok(Bridge {
            child,
            stdin,
            pending,
            permissions,
            next_id: 0,
        })
    }

    /// One request to the bridge, spawning it on demand and replacing it if it died.
    fn request(&self, op: &str, mut params: Value) -> SessionResult<Value> {
        let (receiver, id) = {
            let mut guard = self
                .bridge
                .lock()
                .map_err(|_| SessionError::new("claude_unavailable", "bridge lock"))?;
            let alive = guard
                .as_mut()
                .is_some_and(|bridge| matches!(bridge.child.try_wait(), Ok(None)));
            if !alive {
                *guard = Some(self.spawn_bridge()?);
            }
            let bridge = guard
                .as_mut()
                .ok_or_else(|| SessionError::new("claude_unavailable", "bridge missing"))?;
            bridge.next_id += 1;
            let id = bridge.next_id;
            let (sender, receiver) = channel();
            bridge
                .pending
                .lock()
                .map_err(|_| SessionError::new("claude_unavailable", "bridge lock"))?
                .insert(id, sender);
            params["id"] = json!(id);
            params["op"] = json!(op);
            writeln!(bridge.stdin, "{params}")
                .and_then(|()| bridge.stdin.flush())
                .map_err(|e| SessionError::new("claude_transport", e.to_string()))?;
            (receiver, id)
        };
        let timeout = if op == "send" {
            SEND_TIMEOUT
        } else {
            REQUEST_TIMEOUT
        };
        let reply = receiver.recv_timeout(timeout).map_err(|_| {
            if let Ok(guard) = self.bridge.lock()
                && let Some(bridge) = guard.as_ref()
                && let Ok(mut pending) = bridge.pending.lock()
            {
                pending.remove(&id);
            }
            SessionError::new("result_unknown", format!("{op} sent without answer"))
        })?;
        if reply.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
        }
        let code = reply
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("claude_failed");
        let message = reply
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        Err(SessionError::new(code, message))
    }

    /// Live interactive/background sessions reported by Claude Code: id → busy.
    fn live_sessions(&self) -> SessionResult<HashMap<String, bool>> {
        let claude = self.claude.as_deref().ok_or_else(|| {
            SessionError::new("claude_unavailable", "claude executable not found")
        })?;
        let output = super::tools::run_bounded(
            Command::new(claude)
                .args(["agents", "--json"])
                .env("PATH", &self.child_path),
            AGENTS_TIMEOUT,
        )?;
        if !output.success {
            return Err(SessionError::new(
                "claude_status_failed",
                output.stderr_tail,
            ));
        }
        let entries: Vec<Value> = serde_json::from_slice(&output.stdout)
            .map_err(|e| SessionError::new("claude_protocol", e.to_string()))?;
        Ok(entries
            .iter()
            .filter_map(|entry| {
                let id = entry.get("sessionId").and_then(Value::as_str)?;
                let busy = entry.get("status").and_then(Value::as_str) == Some("busy");
                Some((id.to_string(), busy))
            })
            .collect())
    }

    fn owned_states(&self) -> HashMap<String, String> {
        // Only an already-running bridge can own sessions; do not spawn one just to ask.
        let running = self.bridge.lock().ok().is_some_and(|guard| guard.is_some());
        if !running {
            return HashMap::new();
        }
        self.request("owned", json!({}))
            .ok()
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|entry| {
                Some((
                    entry.get("sessionId")?.as_str()?.to_string(),
                    entry.get("state")?.as_str()?.to_string(),
                ))
            })
            .collect()
    }

    fn ensure_not_owned_elsewhere(&self, id: &str) -> SessionResult<()> {
        if self.owned_states().contains_key(id) {
            return Ok(());
        }
        if self.live_sessions()?.contains_key(id) {
            return Err(SessionError::new(
                "claude_session_owned_elsewhere",
                "a live Claude Code process holds this session",
            ));
        }
        Ok(())
    }

    /// Interactive `claude --resume <id>` for the BOA terminal; refused when another process
    /// or BOA's own SDK driver already holds the session.
    pub(crate) fn terminal_command(
        &self,
        id: &str,
        cwd: &str,
    ) -> SessionResult<super::terminal::TerminalCommand> {
        if self.owned_states().contains_key(id) {
            return Err(SessionError::new(
                "claude_driven_in_conversation",
                "BOA already drives this session through the SDK",
            ));
        }
        if self.live_sessions()?.contains_key(id) {
            return Err(SessionError::new(
                "claude_session_owned_elsewhere",
                "a live Claude Code process holds this session",
            ));
        }
        let claude = self.claude.clone().ok_or_else(|| {
            SessionError::new("claude_unavailable", "claude executable not found")
        })?;
        Ok(super::terminal::TerminalCommand {
            program: claude,
            args: vec!["--resume".into(), id.into()],
            cwd: PathBuf::from(cwd),
            path_env: self.child_path.clone(),
        })
    }

    /// Answers a permission prompt raised by a BOA-owned session.
    pub(crate) fn answer_permission(
        &self,
        id: &str,
        request_id: &str,
        allow: bool,
    ) -> SessionResult<()> {
        self.request(
            "permission",
            json!({"sessionId": id, "requestId": request_id, "allow": allow}),
        )
        .map(|_| ())
    }

    /// Returns prompts for newly mounted windows without starting Claude or touching disk.
    pub(crate) fn pending_permissions(&self) -> SessionResult<Vec<PermissionPrompt>> {
        let bridge = self
            .bridge
            .lock()
            .map_err(|_| SessionError::new("claude_unavailable", "bridge lock"))?;
        let Some(bridge) = bridge.as_ref() else {
            return Ok(Vec::new());
        };
        let current = bridge
            .permissions
            .lock()
            .map_err(|_| SessionError::new("claude_unavailable", "permission lock"))?;
        Ok(current.clone())
    }
}

/// Receipt correlated to the bridge's per-message acknowledgement (never a turn id).
fn accepted(result: &Value) -> SessionResult<SendReceipt> {
    let message_id = result
        .get("messageId")
        .and_then(Value::as_str)
        .ok_or_else(|| SessionError::new("claude_protocol", "missing message acknowledgement"))?;
    Ok(SendReceipt::Accepted {
        message_id: message_id.to_string(),
    })
}

fn validate_title(title: &str) -> SessionResult<()> {
    // The bridge checks String.length before trimming and uses ECMAScript whitespace.
    if title.encode_utf16().take(MAX_TITLE_UTF16 + 1).count() > MAX_TITLE_UTF16
        || title
            .trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
            .is_empty()
    {
        return Err(SessionError::invalid(
            "title",
            "1-200 UTF-16 code units required",
        ));
    }
    Ok(())
}

/// Dev/test default: the build output next to the crate. Packaged apps override it.
fn default_bridge_script() -> Option<PathBuf> {
    std::env::var_os("BOA_CLAUDE_BRIDGE")
        .map(PathBuf::from)
        .or_else(|| {
            Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/claude-bridge.mjs"))
        })
}

fn state_for(
    id: &str,
    owned: &HashMap<String, String>,
    live: Option<&HashMap<String, bool>>,
) -> (SessionState, StateEvidence) {
    if let Some(state) = owned.get(id) {
        let state = match state.as_str() {
            "working" => SessionState::Working,
            "awaitingInput" => SessionState::AwaitingInput,
            _ => SessionState::Idle,
        };
        return (state, StateEvidence::BoaOwned);
    }
    match live {
        None => (SessionState::Unknown, StateEvidence::Unavailable),
        Some(live) => match live.get(id) {
            Some(true) => (SessionState::Working, StateEvidence::ClaudeLiveProcess),
            Some(false) => (SessionState::Idle, StateEvidence::ClaudeLiveProcess),
            None => (SessionState::Inactive, StateEvidence::ClaudeNoProcess),
        },
    }
}

fn capabilities_for(evidence: StateEvidence) -> Capabilities {
    let send = match evidence {
        StateEvidence::ClaudeLiveProcess => Capability::no("claude_session_owned_elsewhere"),
        StateEvidence::Unavailable => Capability::no("claude_status_failed"),
        _ => Capability::yes(),
    };
    // An interactive `claude --resume` would be a second owner of a session BOA already drives.
    let terminal = match evidence {
        StateEvidence::BoaOwned => Capability::no("claude_driven_in_conversation"),
        _ => send.clone(),
    };
    Capabilities {
        rename: Capability::yes(),
        resume: send.clone(),
        send,
        open_in_app: Capability::no("claude_no_session_link"),
        terminal,
    }
}

impl SessionProvider for ClaudeProvider {
    fn status(&self) -> ProviderStatus {
        let reason = if self.claude.is_none() {
            Some("claude_unavailable")
        } else if self.node.is_none() {
            Some("claude_runtime_missing")
        } else {
            None
        };
        ProviderStatus {
            provider: Provider::Claude,
            available: reason.is_none(),
            reason: reason.map(str::to_string),
            live: reason.is_none(),
            version: None,
        }
    }

    fn list(&self, cwds: &[PathBuf], limit: usize) -> SessionResult<ProviderListing> {
        if cwds.is_empty() {
            return Ok(ProviderListing::default());
        }
        let dirs: Vec<String> = cwds
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let rows = self.request("list", json!({"dirs": dirs, "limit": limit}))?;
        let owned = self.owned_states();
        // A failed status probe degrades states to unknown instead of hiding the history.
        let live = self.live_sessions().ok();
        let rows = rows.as_array().cloned().unwrap_or_default();
        let truncated = rows.len() >= limit;
        let sessions = rows
            .iter()
            .filter(|row| row.get("archived").and_then(Value::as_bool) != Some(true))
            .filter_map(|row| {
                let id = row.get("sessionId")?.as_str()?.to_string();
                let (state, evidence) = state_for(&id, &owned, live.as_ref());
                Some(ProviderSession {
                    title: row
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .chars()
                        .take(200)
                        .collect(),
                    cwd: row
                        .get("cwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    recorded_branch: row
                        .get("gitBranch")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    created_at: row.get("createdAt").and_then(Value::as_i64),
                    updated_at: row.get("lastModified").and_then(Value::as_i64),
                    capabilities: capabilities_for(evidence),
                    state,
                    evidence,
                    id,
                })
            })
            .collect();
        Ok(ProviderListing {
            sessions,
            truncated,
        })
    }

    fn conversation(
        &self,
        id: &str,
        cwd: &str,
        limit: usize,
    ) -> SessionResult<Vec<ConversationEntry>> {
        let rows = self.request(
            "messages",
            json!({"sessionId": id, "dir": cwd, "limit": limit}),
        )?;
        Ok(rows
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                let text = row.get("text")?.as_str()?.trim();
                (!text.is_empty()).then(|| ConversationEntry {
                    role: match row.get("role").and_then(Value::as_str) {
                        Some("user") => ConversationRole::User,
                        Some("tool") => ConversationRole::Tool,
                        _ => ConversationRole::Agent,
                    },
                    text: text.to_string(),
                    at: None,
                })
            })
            .collect())
    }

    fn rename(&self, id: &str, cwd: &str, title: &str) -> SessionResult<()> {
        self.request(
            "rename",
            json!({"sessionId": id, "dir": cwd, "title": title}),
        )
        .map(|_| ())
    }

    fn send(&self, id: &str, cwd: &str, text: &str) -> SessionResult<SendReceipt> {
        self.ensure_not_owned_elsewhere(id)?;
        let result = self.request("send", json!({"sessionId": id, "cwd": cwd, "text": text}))?;
        // Claude Code consumes streaming input itself: mid-turn messages follow its native policy.
        Ok(SendReceipt::Started {
            turn_id: result
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    fn create(
        &self,
        cwd: &str,
        text: &str,
        title: Option<&str>,
    ) -> SessionResult<CreateSessionReceipt> {
        if let Some(title) = title {
            validate_title(title)?;
        }
        let result = self.request("send", json!({"cwd": cwd, "text": text}))?;
        let id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| SessionError::new("claude_protocol", "missing session id"))?;
        let session = SessionKey::new(Provider::Claude, id)?;
        let receipt = accepted(&result)?;
        // Acknowledgement establishes creation before the separate, fallible rename.
        let title_warning = if let Some(title) = title
            && self.rename(id, cwd, title).is_err()
        {
            Some(TitleWarning::Unconfirmed)
        } else {
            None
        };
        Ok(CreateSessionReceipt {
            session,
            receipt,
            title_warning,
        })
    }

    fn resume(&self, id: &str, _cwd: &str) -> SessionResult<()> {
        // Resuming without a message has no SDK primitive; the first send resumes under BOA.
        self.ensure_not_owned_elsewhere(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_title_is_rejected_before_starting_the_bridge() {
        let provider = ClaudeProvider::new(None, None, String::new());
        // Supplementary-plane characters count as two UTF-16 code units in the bridge.
        for title in [
            "😀".repeat(MAX_TITLE_UTF16 / 2 + 1),
            format!("{} ", "a".repeat(MAX_TITLE_UTF16)),
            "\u{feff}".into(),
        ] {
            let error = provider
                .create("/project", "First message", Some(&title))
                .unwrap_err();
            assert_eq!(error.code, "invalid_input");
        }
        assert!(validate_title(&"😀".repeat(MAX_TITLE_UTF16 / 2)).is_ok());
        assert!(validate_title("\u{85}").is_ok());
        assert!(provider.bridge.lock().unwrap().is_none());
    }

    #[test]
    fn unconfirmed_title_preserves_the_created_session_and_accepted_message() {
        let mut script = tempfile::NamedTempFile::new().unwrap();
        writeln!(
            script,
            r#"while IFS= read -r request; do
  case "$request" in
    *'"op":"send"'*) printf '%s\n' '{{"id":1,"ok":true,"result":{{"sessionId":"test-native-id","messageId":"test-message-id"}}}}' ;;
    *'"op":"rename"'*) printf '%s\n' '{{"id":2,"ok":false,"error":{{"code":"rename_not_confirmed"}}}}' ;;
    *) exit 1 ;;
  esac
done"#
        )
        .unwrap();
        let provider = ClaudeProvider::new(
            Some(PathBuf::from("/unused-claude")),
            Some(PathBuf::from("/bin/sh")),
            String::new(),
        );
        provider.set_bridge_script(script.path().into());

        let created = provider
            .create("/project", "First message", Some("Requested title"))
            .unwrap();
        assert_eq!(
            created.session,
            SessionKey::new(Provider::Claude, "test-native-id").unwrap()
        );
        assert_eq!(
            created.receipt,
            SendReceipt::Accepted {
                message_id: "test-message-id".into(),
            },
        );
        assert_eq!(
            serde_json::to_value(&created).unwrap()["titleWarning"],
            "title_unconfirmed"
        );
    }

    #[test]
    fn permission_snapshot_starts_empty_without_a_bridge() {
        let provider = ClaudeProvider::new(None, None, String::new());
        assert!(provider.pending_permissions().unwrap().is_empty());
        assert!(provider.bridge.lock().unwrap().is_none());
    }

    #[test]
    fn permission_projection_removes_only_the_answered_request_or_closed_session() {
        let mut prompts = Vec::new();
        let request = |session_id: &str, request_id: &str| {
            json!({
                "event": "permissionRequest", "sessionId": session_id, "requestId": request_id,
                "toolName": "Read", "summary": "notes.txt"
            })
        };
        let first = request("a", "shared");
        update_permissions(&mut prompts, &first);
        update_permissions(&mut prompts, &first);
        update_permissions(&mut prompts, &request("a", "another"));
        update_permissions(&mut prompts, &request("b", "shared"));
        assert_eq!(prompts.len(), 3);

        update_permissions(
            &mut prompts,
            &json!({"event": "permissionResolved", "sessionId": "a", "requestId": "shared"}),
        );
        assert_eq!(prompts.len(), 2);
        assert_eq!(prompts[0].request_id, "another");
        assert_eq!(prompts[1].session_id, "b");

        update_permissions(
            &mut prompts,
            &json!({"event": "sessionClosed", "sessionId": "a"}),
        );
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].session_id, "b");

        update_permissions(
            &mut prompts,
            &json!({"event": "turnCompleted", "sessionId": "b"}),
        );
        assert!(prompts.is_empty());
    }

    #[test]
    fn live_elsewhere_blocks_sending_while_owned_or_absent_sessions_can_be_driven() {
        let owned = HashMap::from([("mine".to_string(), "awaitingInput".to_string())]);
        let live = HashMap::from([("other".to_string(), true), ("mine".to_string(), false)]);
        assert_eq!(
            state_for("mine", &owned, Some(&live)),
            (SessionState::AwaitingInput, StateEvidence::BoaOwned)
        );
        let (state, evidence) = state_for("other", &owned, Some(&live));
        assert_eq!(
            (state, evidence),
            (SessionState::Working, StateEvidence::ClaudeLiveProcess)
        );
        assert_eq!(
            capabilities_for(evidence).send.reason.as_deref(),
            Some("claude_session_owned_elsewhere")
        );
        assert_eq!(
            state_for("past", &owned, Some(&live)),
            (SessionState::Inactive, StateEvidence::ClaudeNoProcess)
        );
        assert_eq!(state_for("x", &owned, None).0, SessionState::Unknown);
    }
}
