//! Codex adapter over the app-server protocol.
//!
//! Ownership rules (verified against codex-cli 0.166.0):
//! - Mutations (rename, send, resume, create) go only through the shared daemon, the single
//!   owner every client can observe. Without it they fail with `codex_daemon_not_running`.
//! - Without the daemon, a private child app-server reads history only; live state is unknown.
//! - `notLoaded` in the daemon means no client loaded it there; another app may still own it,
//!   so it maps to `Unknown`, never `Idle`, and sending requires an explicit resume first.
use super::codex_rpc::{CallError, ChildTransport, DaemonTransport, RpcClient, daemon_socket};
use super::model::{
    Capabilities, Capability, ConversationEntry, ConversationRole, Provider, SendReceipt,
    SessionError, SessionResult, SessionState, StateEvidence,
};
use super::provider::{ProviderListing, ProviderSession, ProviderStatus, SessionProvider};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// Codex's own page size ceiling is not documented; 100 per page keeps responses small.
const PAGE_LIMIT: usize = 100;
const MAX_TITLE: usize = 200;
const MAX_MESSAGE_CHARS: usize = 100_000;

pub(crate) struct CodexProvider {
    /// A `codex://` handler is registered (resolved once at composition).
    app_available: bool,
    binary: Option<PathBuf>,
    child_path: String,
    home: Option<PathBuf>,
}

/// Follow-up policy configured by the user in Codex (`[desktop] followUpQueueMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FollowUpMode {
    Steer,
    Queue,
    /// Not configured: BOA uses `turn/start`, which the server itself applies as a steer.
    ServerDefault,
}

impl CodexProvider {
    pub(crate) fn new(
        binary: Option<PathBuf>,
        child_path: String,
        home: Option<PathBuf>,
        app_available: bool,
    ) -> Self {
        Self {
            app_available,
            binary,
            child_path,
            home,
        }
    }

    fn home(&self) -> SessionResult<&Path> {
        self.home
            .as_deref()
            .ok_or_else(|| SessionError::new("codex_unavailable", "no Codex home"))
    }

    fn daemon(&self, experimental: bool) -> SessionResult<RpcClient> {
        let transport = DaemonTransport::connect(&daemon_socket(self.home()?))?;
        RpcClient::initialize(Box::new(transport), experimental)
    }

    fn history_reader(&self) -> SessionResult<RpcClient> {
        let binary = self
            .binary
            .as_deref()
            .ok_or_else(|| SessionError::new("codex_unavailable", "codex executable not found"))?;
        let transport = ChildTransport::spawn(binary, &self.child_path, self.home()?)?;
        RpcClient::initialize(Box::new(transport), false)
    }

    /// Reader for history: the daemon when it runs, otherwise a private child.
    fn reader(&self) -> SessionResult<(RpcClient, bool)> {
        match self.daemon(false) {
            Ok(client) => Ok((client, true)),
            Err(error) if error.code == "codex_daemon_not_running" => {
                Ok((self.history_reader()?, false))
            }
            Err(error) => Err(error),
        }
    }

    /// Follows daemon notifications until `stop` is set or the daemon disconnects.
    /// Calls `on_change` at most every 500 ms for status, name, turn and queue events.
    /// Owned by the caller's thread; returns on disconnect (no reconnect loop, no polling).
    pub(crate) fn watch(
        &self,
        stop: &std::sync::atomic::AtomicBool,
        on_change: &dyn Fn(),
    ) -> SessionResult<()> {
        use std::sync::atomic::Ordering;
        use std::time::{Duration, Instant};
        const RELEVANT: [&str; 6] = [
            "thread/status/changed",
            "thread/name/updated",
            "thread/started",
            "turn/completed",
            "thread/queue/changed",
            "thread/archived",
        ];
        let mut client = self.daemon(false)?;
        let mut pending_since: Option<Instant> = None;
        while !stop.load(Ordering::Relaxed) {
            let deadline = Instant::now() + Duration::from_millis(500);
            if let Some(message) = client.next_notification(deadline)?
                && message
                    .get("method")
                    .and_then(Value::as_str)
                    .is_some_and(|method| RELEVANT.contains(&method))
            {
                pending_since.get_or_insert_with(Instant::now);
            }
            // Coalesce bursts (deltas of one turn) into one UI refresh per 500 ms window.
            if pending_since.is_some_and(|since| since.elapsed() >= Duration::from_millis(500)) {
                pending_since = None;
                on_change();
            }
        }
        Ok(())
    }

    /// TUI command attached to the shared daemon for the BOA terminal.
    pub(crate) fn terminal_command(
        &self,
        id: &str,
        cwd: &str,
    ) -> SessionResult<super::terminal::TerminalCommand> {
        let binary = self
            .binary
            .clone()
            .ok_or_else(|| SessionError::new("codex_unavailable", "codex executable not found"))?;
        let socket = daemon_socket(self.home()?);
        // Confirms the daemon is reachable before launching a TUI that would otherwise fail,
        // and that Codex Desktop cannot be holding a thread the daemon would now load.
        let mut client =
            RpcClient::initialize(Box::new(DaemonTransport::connect(&socket)?), false)?;
        ensure_desktop_cannot_own(&mut client, id)?;
        Ok(super::terminal::TerminalCommand {
            program: binary,
            args: vec![
                "resume".into(),
                id.into(),
                "--remote".into(),
                format!("unix://{}", socket.display()),
            ],
            cwd: PathBuf::from(cwd),
            path_env: self.child_path.clone(),
        })
    }

    /// Starts the shared daemon on explicit user request only.
    pub(crate) fn start_daemon(&self) -> SessionResult<()> {
        let binary = self
            .binary
            .as_deref()
            .ok_or_else(|| SessionError::new("codex_unavailable", "codex executable not found"))?;
        // `codex app-server daemon start` returns once the daemon publishes its socket (JSON line on stdout).
        let output = super::tools::run_bounded(
            std::process::Command::new(binary)
                .args(["app-server", "daemon", "start"])
                .env("PATH", &self.child_path)
                .env("CODEX_HOME", self.home()?),
            std::time::Duration::from_secs(45),
        )?;
        if !output.success {
            return Err(SessionError::new(
                "codex_daemon_start_failed",
                output.stderr_tail,
            ));
        }
        DaemonTransport::connect(&daemon_socket(self.home()?)).map(|_| ())
    }

    fn follow_up_mode(client: &mut RpcClient, cwd: &str) -> SessionResult<FollowUpMode> {
        let config = client
            .call("config/read", json!({"cwd": cwd}))
            .map_err(CallError::into_error)?;
        Ok(
            match config
                .pointer("/config/desktop/followUpQueueMode")
                .and_then(Value::as_str)
            {
                Some("steer") => FollowUpMode::Steer,
                Some("queue") => FollowUpMode::Queue,
                _ => FollowUpMode::ServerDefault,
            },
        )
    }

    fn active_turn(client: &mut RpcClient, id: &str) -> SessionResult<Option<String>> {
        let turns = client
            .call(
                "thread/turns/list",
                json!({"threadId": id, "limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"}),
            )
            .map_err(CallError::into_error)?;
        Ok(turns
            .get("data")
            .and_then(Value::as_array)
            .and_then(|turns| turns.first())
            .filter(|turn| turn.get("status").and_then(Value::as_str) == Some("inProgress"))
            .and_then(|turn| turn.get("id").and_then(Value::as_str))
            .map(str::to_string))
    }

    /// The in-progress turn is authoritative. Right after `turn/start`, status and turn listing
    /// can lag each other; when the thread reports activity, re-read for up to 2 s (4 × 500 ms).
    fn running_turn(client: &mut RpcClient, id: &str, busy: bool) -> SessionResult<Option<String>> {
        let attempts = if busy { 4 } else { 1 };
        for attempt in 0..attempts {
            if let Some(turn) = Self::active_turn(client, id)? {
                return Ok(Some(turn));
            }
            if attempt + 1 < attempts {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }
        Ok(None)
    }

    fn thread_state(client: &mut RpcClient, id: &str) -> SessionResult<SessionState> {
        let thread = client
            .call("thread/read", json!({"threadId": id}))
            .map_err(CallError::into_error)?;
        Ok(map_status(thread.pointer("/thread/status"), true))
    }
}

fn text_input(text: &str) -> Value {
    json!([{"type": "text", "text": text}])
}

fn validate_message(text: &str) -> SessionResult<()> {
    if text.trim().is_empty() || text.chars().count() > MAX_MESSAGE_CHARS {
        return Err(SessionError::invalid(
            "message",
            "1-100000 characters required",
        ));
    }
    Ok(())
}

fn validate_title(title: &str) -> SessionResult<String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE {
        return Err(SessionError::invalid("title", "1-200 characters required"));
    }
    Ok(title.to_string())
}

/// Maps the native status. Without the daemon, any status is history-only and unknown.
fn map_status(status: Option<&Value>, from_daemon: bool) -> SessionState {
    if !from_daemon {
        return SessionState::Unknown;
    }
    match status.and_then(|s| s.get("type")).and_then(Value::as_str) {
        Some("idle") => SessionState::Idle,
        Some("systemError") => SessionState::Failed,
        Some("active") => {
            let waiting = status
                .and_then(|s| s.get("activeFlags"))
                .and_then(Value::as_array)
                .is_some_and(|flags| !flags.is_empty());
            if waiting {
                SessionState::AwaitingInput
            } else {
                SessionState::Working
            }
        }
        // notLoaded and unrecognized future values: no reliable owner signal.
        _ => SessionState::Unknown,
    }
}

fn capabilities(
    from_daemon: bool,
    state: SessionState,
    app_available: bool,
    desktop_running: bool,
) -> Capabilities {
    let mutations = if from_daemon {
        Capability::yes()
    } else {
        Capability::no("codex_daemon_not_running")
    };
    let send = if !from_daemon {
        Capability::no("codex_daemon_not_running")
    } else if state == SessionState::Unknown {
        Capability::no("codex_not_loaded")
    } else {
        Capability::yes()
    };
    // Loading a thread the daemon does not hold while Codex Desktop runs could give it a second
    // owner (Desktop uses its own app-server; no documented cross-process lock): refuse resume
    // and terminal for such threads only. Threads already loaded in the daemon are unaffected.
    let desktop_may_own = desktop_running && state == SessionState::Unknown;
    let guarded = |capability: Capability| {
        if desktop_may_own && capability.available {
            Capability::no("codex_desktop_may_own")
        } else {
            capability
        }
    };
    Capabilities {
        rename: mutations.clone(),
        send,
        resume: guarded(mutations),
        open_in_app: if app_available {
            Capability::yes()
        } else {
            Capability::no("codex_app_missing")
        },
        // The Codex TUI attaches to the shared daemon (`--remote`), never as a second owner.
        terminal: guarded(mutations_for_terminal(from_daemon)),
    }
}

/// Action-time guard for resume/terminal (capabilities may be stale).
fn ensure_desktop_cannot_own(client: &mut RpcClient, id: &str) -> SessionResult<()> {
    if super::app_link::codex_desktop_running()
        && CodexProvider::thread_state(client, id)? == SessionState::Unknown
    {
        return Err(SessionError::new(
            "codex_desktop_may_own",
            "Codex Desktop runs outside the shared daemon and may hold this thread",
        ));
    }
    Ok(())
}

fn mutations_for_terminal(from_daemon: bool) -> Capability {
    if from_daemon {
        Capability::yes()
    } else {
        Capability::no("codex_daemon_not_running")
    }
}

fn seconds_to_ms(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_i64)
        .map(|s| s.saturating_mul(1000))
}

/// Converts a native thread object into the provider-neutral session model.
fn map_thread(
    thread: &Value,
    from_daemon: bool,
    app_available: bool,
    desktop_running: bool,
) -> Option<ProviderSession> {
    let id = thread.get("id").and_then(Value::as_str)?.to_string();
    let title = thread
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .or_else(|| thread.get("preview").and_then(Value::as_str))
        .unwrap_or_default()
        .chars()
        .take(MAX_TITLE)
        .collect::<String>();
    let state = map_status(thread.get("status"), from_daemon);
    Some(ProviderSession {
        id,
        title,
        cwd: thread
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        recorded_branch: thread
            .pointer("/gitInfo/branch")
            .and_then(Value::as_str)
            .map(str::to_string),
        created_at: seconds_to_ms(thread.get("createdAt")),
        updated_at: seconds_to_ms(thread.get("updatedAt")),
        state,
        evidence: if from_daemon {
            StateEvidence::CodexDaemon
        } else {
            StateEvidence::CodexHistoryOnly
        },
        capabilities: capabilities(from_daemon, state, app_available, desktop_running),
    })
}

/// Maps native items to conversation entries; tool calls keep only a short label.
fn map_item(item: &Value) -> Option<ConversationEntry> {
    let at = item.get("startedAtMs").and_then(Value::as_i64);
    match item.get("type").and_then(Value::as_str)? {
        "userMessage" => {
            let text = item
                .get("content")
                .and_then(Value::as_array)?
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            Some(ConversationEntry {
                role: ConversationRole::User,
                text,
                at,
            })
        }
        "agentMessage" => Some(ConversationEntry {
            role: ConversationRole::Agent,
            text: item.get("text").and_then(Value::as_str)?.to_string(),
            at,
        }),
        "commandExecution" => Some(ConversationEntry {
            role: ConversationRole::Tool,
            text: item
                .get("command")
                .and_then(Value::as_str)?
                .chars()
                .take(300)
                .collect(),
            at,
        }),
        _ => None,
    }
}

impl SessionProvider for CodexProvider {
    fn status(&self) -> ProviderStatus {
        let unavailable = |reason: &str| ProviderStatus {
            provider: Provider::Codex,
            available: false,
            reason: Some(reason.into()),
            live: false,
            version: None,
        };
        if self.binary.is_none() {
            return unavailable("codex_unavailable");
        }
        match self.daemon(false) {
            Ok(_) => ProviderStatus {
                provider: Provider::Codex,
                available: true,
                reason: None,
                live: true,
                version: None,
            },
            Err(error) => ProviderStatus {
                provider: Provider::Codex,
                available: true,
                reason: Some(error.code),
                live: false,
                version: None,
            },
        }
    }

    fn list(&self, cwds: &[PathBuf], limit: usize) -> SessionResult<ProviderListing> {
        if cwds.is_empty() {
            return Ok(ProviderListing::default());
        }
        let (mut client, from_daemon) = self.reader()?;
        let desktop_running = super::app_link::codex_desktop_running();
        let cwd_filter: Vec<String> = cwds
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let mut listing = ProviderListing::default();
        let mut cursor: Option<String> = None;
        // Page until `limit` sessions or no cursor; each page is a bounded request.
        loop {
            let page = client
                .call(
                    "thread/list",
                    list_params(
                        &cwd_filter,
                        PAGE_LIMIT.min(limit - listing.sessions.len()),
                        cursor.as_deref(),
                    ),
                )
                .map_err(CallError::into_error)?;
            listing.sessions.extend(
                page.get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|thread| {
                        map_thread(thread, from_daemon, self.app_available, desktop_running)
                    }),
            );
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
            if listing.sessions.len() >= limit {
                listing.truncated = true;
                break;
            }
        }
        Ok(listing)
    }

    fn conversation(
        &self,
        id: &str,
        _cwd: &str,
        limit: usize,
    ) -> SessionResult<Vec<ConversationEntry>> {
        let (mut client, _) = self.reader()?;
        let page = client
            .call(
                "thread/items/list",
                json!({"threadId": id, "limit": limit, "sortDirection": "desc"}),
            )
            .map_err(CallError::into_error)?;
        let mut entries: Vec<ConversationEntry> = page
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                // Entries wrap the item with turn and timing metadata.
                let mut mapped = map_item(entry.get("item")?)?;
                mapped.at = mapped
                    .at
                    .or_else(|| entry.get("startedAtMs").and_then(Value::as_i64));
                Some(mapped)
            })
            .collect();
        entries.reverse();
        Ok(entries)
    }

    fn rename(&self, id: &str, _cwd: &str, title: &str) -> SessionResult<()> {
        let title = validate_title(title)?;
        let mut client = self.daemon(false)?;
        client
            .call("thread/name/set", json!({"threadId": id, "name": title}))
            .map_err(|error| match error {
                CallError::Failed(error) => error,
                CallError::Unknown => {
                    SessionError::new("result_unknown", "rename sent without answer")
                }
            })?;
        // Confirm from the source rather than trusting the empty acknowledgement.
        let thread = client
            .call("thread/read", json!({"threadId": id}))
            .map_err(CallError::into_error)?;
        if thread.pointer("/thread/name").and_then(Value::as_str) != Some(title.as_str()) {
            return Err(SessionError::new(
                "rename_not_confirmed",
                "source kept another title",
            ));
        }
        Ok(())
    }

    fn send(&self, id: &str, cwd: &str, text: &str) -> SessionResult<SendReceipt> {
        validate_message(text)?;
        let mut client = self.daemon(true)?;
        let unknown = |error: CallError| match error {
            CallError::Failed(error) => error,
            CallError::Unknown => {
                SessionError::new("result_unknown", "message sent without answer")
            }
        };
        let state = Self::thread_state(&mut client, id)?;
        if state == SessionState::Unknown {
            return Err(SessionError::new(
                "codex_not_loaded",
                "resume the session in the shared daemon before sending",
            ));
        }
        let busy = matches!(state, SessionState::Working | SessionState::AwaitingInput);
        let Some(turn) = Self::running_turn(&mut client, id, busy)? else {
            let result = client
                .call(
                    "turn/start",
                    json!({"threadId": id, "input": text_input(text)}),
                )
                .map_err(unknown)?;
            return Ok(SendReceipt::Started {
                turn_id: result
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        };
        match Self::follow_up_mode(&mut client, cwd)? {
            FollowUpMode::Queue => {
                let result = client
                    .call(
                        "thread/queue/add",
                        json!({"threadId": id, "clientUserMessageId": client_message_id(), "input": text_input(text)}),
                    )
                    .map_err(unknown)?;
                let submission = result
                    .pointer("/queuedSubmission/id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        SessionError::new("codex_protocol", "missing queued submission")
                    })?;
                Ok(SendReceipt::QueuedByProvider {
                    submission_id: submission.to_string(),
                })
            }
            FollowUpMode::Steer => {
                let result = client
                    .call(
                        "turn/steer",
                        json!({"threadId": id, "expectedTurnId": turn, "input": text_input(text)}),
                    )
                    .map_err(unknown)?;
                Ok(SendReceipt::Steered {
                    turn_id: result
                        .get("turnId")
                        .and_then(Value::as_str)
                        .unwrap_or(&turn)
                        .to_string(),
                })
            }
            // No configured mode: `turn/start` lets the server decide; report what it did.
            FollowUpMode::ServerDefault => {
                let result = client
                    .call(
                        "turn/start",
                        json!({"threadId": id, "input": text_input(text)}),
                    )
                    .map_err(unknown)?;
                let started = result
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                Ok(match started {
                    Some(id) if id == turn => SendReceipt::Steered { turn_id: id },
                    other => SendReceipt::Started { turn_id: other },
                })
            }
        }
    }

    fn create(
        &self,
        cwd: &str,
        text: &str,
        title: Option<&str>,
    ) -> SessionResult<(String, SendReceipt)> {
        validate_message(text)?;
        let title = title.map(validate_title).transpose()?;
        let mut client = self.daemon(false)?;
        let thread = client
            .call("thread/start", json!({"cwd": cwd}))
            .map_err(CallError::into_error)?;
        let id = thread
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or_else(|| SessionError::new("codex_protocol", "missing thread id"))?
            .to_string();
        if let Some(title) = title {
            client
                .call("thread/name/set", json!({"threadId": id, "name": title}))
                .map_err(CallError::into_error)?;
        }
        let receipt = match client.call(
            "turn/start",
            json!({"threadId": id, "input": text_input(text)}),
        ) {
            Ok(result) => SendReceipt::Started {
                turn_id: result
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
            Err(CallError::Unknown) => SendReceipt::Unknown,
            Err(CallError::Failed(error)) => return Err(error),
        };
        Ok((id, receipt))
    }

    fn resume(&self, id: &str, _cwd: &str) -> SessionResult<()> {
        let mut client = self.daemon(false)?;
        ensure_desktop_cannot_own(&mut client, id)?;
        client
            .call(
                "thread/resume",
                json!({"threadId": id, "excludeTurns": true}),
            )
            .map_err(CallError::into_error)?;
        Ok(())
    }
}

fn client_message_id() -> String {
    format!("boa-{}", super::store::now_ms())
}

/// Session sources listed by BOA (ThreadSourceKind); every `subAgent*` kind is left out.
const LISTED_SOURCES: [&str; 4] = ["cli", "vscode", "exec", "appServer"];

/// `thread/list` page request (schema: `codex app-server generate-json-schema`, ThreadListParams).
/// - `useStateDbOnly`: answer from Codex's state DB instead of scanning every JSONL rollout to
///   repair metadata. The scan costs tens of seconds on a large history and writes repairs into
///   the user's Codex home; BOA's history reading stays read-only and bounded.
/// - `sourceKinds`: the user's full coding-session inventory, i.e. interactive CLI, IDE, Desktop
///   and app-server threads plus resumable `codex exec` runs. Omitting it would mean Codex's
///   interactive-only default, which hides exec sessions. Internal sub-agents stay excluded.
/// - `cwd`: exact match on the recorded session cwd; the server resolves `/tmp` vs `/private/tmp`.
fn list_params(cwds: &[String], limit: usize, cursor: Option<&str>) -> Value {
    json!({
        "cwd": cwds,
        "limit": limit,
        "cursor": cursor,
        "sortKey": "updated_at",
        "sourceKinds": LISTED_SOURCES,
        "useStateDbOnly": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_listing_reads_the_state_db_and_lists_user_sources_without_sub_agents() {
        let params = list_params(&["/p".into()], 50, Some("next"));
        assert_eq!(params["useStateDbOnly"], json!(true));
        let sources: Vec<&str> = params["sourceKinds"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for user_source in ["cli", "vscode", "exec", "appServer"] {
            assert!(sources.contains(&user_source), "{user_source} missing");
        }
        assert!(
            sources.iter().all(|s| !s.starts_with("subAgent")),
            "internal sub-agents must stay hidden"
        );
        assert_eq!(params["cwd"], json!(["/p"]));
        assert_eq!(params["cursor"], json!("next"));
        assert_eq!(params["sortKey"], json!("updated_at"));
        assert_eq!(list_params(&[], 1, None)["cursor"], Value::Null);
    }

    #[test]
    fn status_mapping_never_turns_not_loaded_or_history_into_idle() {
        assert_eq!(
            map_status(Some(&json!({"type": "notLoaded"})), true),
            SessionState::Unknown
        );
        assert_eq!(
            map_status(Some(&json!({"type": "idle"})), false),
            SessionState::Unknown
        );
        assert_eq!(
            map_status(Some(&json!({"type": "idle"})), true),
            SessionState::Idle
        );
        assert_eq!(
            map_status(
                Some(&json!({"type": "active", "activeFlags": ["waitingOnApproval"]})),
                true
            ),
            SessionState::AwaitingInput
        );
        assert_eq!(
            map_status(Some(&json!({"type": "active", "activeFlags": []})), true),
            SessionState::Working
        );
    }

    #[test]
    fn thread_mapping_prefers_name_and_exposes_capability_reasons() {
        let thread = json!({"id": "t1", "name": "Renamed", "preview": "first", "cwd": "/p",
            "gitInfo": {"branch": "dev"}, "createdAt": 10, "updatedAt": 20, "status": {"type": "notLoaded"}});
        let session = map_thread(&thread, true, true, false).unwrap();
        assert!(session.capabilities.open_in_app.available);
        assert_eq!(session.title, "Renamed");
        assert_eq!(session.updated_at, Some(20_000));
        assert_eq!(
            session.capabilities.send.reason.as_deref(),
            Some("codex_not_loaded")
        );
        assert!(session.capabilities.rename.available);
        let history = map_thread(&thread, false, false, false).unwrap();
        let guarded = map_thread(&thread, true, true, true).unwrap();
        assert_eq!(
            guarded.capabilities.resume.reason.as_deref(),
            Some("codex_desktop_may_own")
        );
        assert_eq!(
            guarded.capabilities.terminal.reason.as_deref(),
            Some("codex_desktop_may_own")
        );
        assert!(
            guarded.capabilities.rename.available,
            "reading and rename stay available"
        );
        let loaded = json!({"id": "t2", "cwd": "/p", "status": {"type": "idle"}});
        let loaded = map_thread(&loaded, true, true, true).unwrap();
        assert!(
            loaded.capabilities.resume.available && loaded.capabilities.terminal.available,
            "threads held by the shared daemon are unaffected"
        );
        assert_eq!(
            history.capabilities.open_in_app.reason.as_deref(),
            Some("codex_app_missing")
        );
        assert_eq!(history.evidence, StateEvidence::CodexHistoryOnly);
        assert_eq!(
            history.capabilities.rename.reason.as_deref(),
            Some("codex_daemon_not_running")
        );
    }
}
