//! Session use cases shared by the Tauri commands and the CLI RPC (one service, two transports).
use super::actions::{ActionDef, ActionPatch, ResolvedAction, TemplateValues, render};
use super::branch::{self, BranchFacts};
use super::claude::ClaudeProvider;
use super::codex::CodexProvider;
use super::model::{
    CreateSessionReceipt, Provider, SendReceipt, SessionError, SessionKey, SessionResult,
    SessionState, SessionSummary,
};
use super::provider::{ProviderStatus, SessionProvider};
use super::store::{SessionStore, StoreData, now_ms};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// Upper bound per provider listing; the UI pages within this window.
pub(crate) const MAX_LIST: usize = 200;
const MAX_CONVERSATION: usize = 200;

/// Registered BOA projects as seen by the sessions domain (injected, never read globally).
#[derive(Debug, Clone)]
pub(crate) struct ProjectScope {
    pub roots: Vec<ProjectRoot>,
    pub language: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ProjectRoot {
    pub path: PathBuf,
    pub name: String,
}

/// Receives `(event name, payload)` for the UI; installed by the Tauri composition root.
pub(crate) type Emitter = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Scope {
    Pinned,
    All,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListQuery {
    pub scope: Scope,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub provider: Option<Provider>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub state: Option<SessionState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderIssue {
    pub provider: Provider,
    pub code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listing {
    pub discovery_enabled: bool,
    pub sessions: Vec<SessionSummary>,
    pub pinned_count: usize,
    pub total_count: usize,
    pub truncated: bool,
    pub issues: Vec<ProviderIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsView {
    pub revision: u64,
    pub discovery_enabled: bool,
    pub discovery_providers: super::store::ProviderToggles,
    pub auto_pin_new: bool,
    pub providers: Vec<ProviderStatus>,
    pub store_recovered: bool,
}

/// A branch change requested from the agent and not yet observed in the working tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingBranch {
    pub target: String,
    pub previous: Option<String>,
    pub requested_at: i64,
    /// Derived on each read, never a guess of the agent's answer.
    pub status: PendingStatus,
}

/// A branch request is `Awaiting` while the agent may still act on it, `Unconfirmed` once its
/// turn ended (or the bound elapsed) without the branch being observed in the working tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PendingStatus {
    Awaiting,
    Unconfirmed,
}

/// Grace before a finished turn counts: status signals can lag the request by a few seconds.
const PENDING_GRACE_MS: i64 = 20_000;
/// Upper bound even if the session keeps working: 10 minutes covers a slow checkout with hooks.
const PENDING_LIMIT_MS: i64 = 10 * 60_000;

fn pending_status(elapsed_ms: i64, state: Option<SessionState>) -> PendingStatus {
    let turn_running = matches!(
        state,
        Some(SessionState::Working | SessionState::AwaitingInput)
    );
    if elapsed_ms >= PENDING_LIMIT_MS || (elapsed_ms >= PENDING_GRACE_MS && !turn_running) {
        PendingStatus::Unconfirmed
    } else {
        PendingStatus::Awaiting
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionBranch {
    #[serde(flatten)]
    pub facts: BranchFacts,
    pub pending: Option<PendingBranch>,
    /// Other live sessions working in the same working tree.
    pub shared_with: Vec<SessionKey>,
}

pub(crate) struct SessionService {
    store: SessionStore,
    codex: Arc<CodexProvider>,
    claude: Arc<ClaudeProvider>,
    catalog: Mutex<HashMap<SessionKey, SessionSummary>>,
    pending_branches: Mutex<HashMap<SessionKey, PendingBranch>>,
    emitter: Mutex<Option<Emitter>>,
    /// Daemon notification follower: one thread at most, stopped when the service drops.
    codex_watch: Mutex<Option<std::thread::JoinHandle<()>>>,
    stop_watch: Arc<std::sync::atomic::AtomicBool>,
    terminals: super::terminal::TerminalHost,
}

impl Drop for SessionService {
    fn drop(&mut self) {
        self.stop_watch
            .store(true, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut handle) = self.codex_watch.lock()
            && let Some(handle) = handle.take()
        {
            let _ = handle.join();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> SessionResult<std::sync::MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| SessionError::new("state_poisoned", "sessions state lock"))
}

fn is_live(state: SessionState) -> bool {
    matches!(
        state,
        SessionState::Working | SessionState::AwaitingInput | SessionState::Idle
    )
}

impl SessionService {
    /// Composition: adapters are chosen here once; callers only see the provider contract.
    pub(crate) fn new(store: SessionStore, codex: CodexProvider, claude: ClaudeProvider) -> Self {
        Self {
            store,
            codex: Arc::new(codex),
            claude: Arc::new(claude),
            catalog: Mutex::new(HashMap::new()),
            pending_branches: Mutex::new(HashMap::new()),
            emitter: Mutex::new(None),
            codex_watch: Mutex::new(None),
            stop_watch: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            terminals: super::terminal::TerminalHost::default(),
        }
    }

    pub(crate) fn terminals(&self) -> &super::terminal::TerminalHost {
        &self.terminals
    }

    /// Opens (or re-attaches to) the session's persistent BOA terminal. With `attach_only`
    /// (a restored view), it only attaches: the check and the attach share the host lock, so a
    /// PTY that just ended is reported as `terminal_not_running`, never restarted.
    pub(crate) fn open_terminal(
        &self,
        scope: &ProjectScope,
        key: &SessionKey,
        cols: u16,
        rows: u16,
        attach_only: bool,
    ) -> SessionResult<super::terminal::TerminalInfo> {
        let codex = Arc::clone(&self.codex);
        let claude = Arc::clone(&self.claude);
        let session = if attach_only || self.terminals.running_for(key).is_some() {
            None
        } else {
            Some(self.get(scope, key)?)
        };
        let info = self.terminals.open(
            key,
            move || {
                if attach_only {
                    return Err(SessionError::new(
                        "terminal_not_running",
                        "no BOA terminal runs for this session",
                    ));
                }
                let session =
                    session.ok_or_else(|| SessionError::new("session_not_found", "session"))?;
                match key.provider {
                    Provider::Codex => codex.terminal_command(&key.id, &session.cwd),
                    Provider::Claude => claude.terminal_command(&key.id, &session.cwd),
                }
            },
            cols,
            rows,
        )?;
        self.emit_changed("terminal");
        Ok(info)
    }

    pub(crate) fn claude(&self) -> &ClaudeProvider {
        &self.claude
    }

    pub(crate) fn set_emitter(&self, emitter: Emitter) {
        // One event per terminal end (stop or spontaneous exit): views re-read the catalog,
        // whose holder state is derived live from the terminal host, never cached.
        let on_exit = emitter.clone();
        self.terminals.set_exit_hook(Arc::new(move |key: &SessionKey| {
            on_exit(
                "boa:sessions-changed",
                json!({"reason": "terminal-exit", "provider": key.provider.as_str(), "sessionId": key.id}),
            );
        }));
        if let Ok(mut current) = self.emitter.lock() {
            *current = Some(emitter);
        }
    }

    /// Provider facts plus BOA's live terminal holder state (derived on read, never cached).
    fn with_hold(&self, mut summary: SessionSummary) -> SessionSummary {
        let held = self.terminals.running_for(&summary.key).is_some();
        apply_terminal_hold(&mut summary, held);
        summary
    }

    fn emit_changed(&self, reason: &str) {
        if let Ok(emitter) = self.emitter.lock()
            && let Some(emitter) = emitter.as_ref()
        {
            emitter("boa:sessions-changed", json!({"reason": reason}));
        }
    }

    /// Follows the Codex daemon when it runs and the UI is wired; restarted by the next listing
    /// after a disconnect instead of polling for the daemon.
    fn ensure_codex_watch(&self) {
        let Ok(emitter) = self.emitter.lock().map(|e| e.clone()) else {
            return;
        };
        let Some(emitter) = emitter else {
            return;
        };
        let Ok(mut slot) = self.codex_watch.lock() else {
            return;
        };
        if slot.as_ref().is_some_and(|handle| !handle.is_finished()) {
            return;
        }
        let codex = Arc::clone(&self.codex);
        let stop = Arc::clone(&self.stop_watch);
        *slot = std::thread::Builder::new()
            .name("boa-codex-watch".into())
            .spawn(move || {
                let notify = || emitter("boa:sessions-changed", json!({"reason": "codex-daemon"}));
                if let Err(error) = codex.watch(&stop, &notify) {
                    eprintln!(
                        "{}",
                        json!({"event": "codex_watch_ended", "errorCode": error.code})
                    );
                }
            })
            .ok();
    }

    fn provider(&self, provider: Provider) -> &dyn SessionProvider {
        match provider {
            Provider::Codex => self.codex.as_ref(),
            Provider::Claude => self.claude.as_ref(),
        }
    }

    pub(crate) fn settings(&self) -> SessionResult<SettingsView> {
        let data = self.store.snapshot()?;
        Ok(SettingsView {
            revision: data.revision,
            discovery_enabled: data.discovery.enabled,
            discovery_providers: data.discovery.providers.clone(),
            auto_pin_new: data.auto_pin_new,
            providers: Provider::ALL
                .iter()
                .map(|p| self.provider(*p).status())
                .collect(),
            store_recovered: self.store.recovered_from.is_some(),
        })
    }

    /// Opt-in/out of local history discovery. Turning it off keeps pins and actions.
    pub(crate) fn set_discovery(
        &self,
        enabled: bool,
        providers: Option<super::store::ProviderToggles>,
        expected: Option<u64>,
    ) -> SessionResult<StoreData> {
        let (_, data) = self.store.mutate(expected, |data| {
            let before = data.discovery.clone();
            if enabled && !data.discovery.enabled {
                data.discovery.enabled_at = Some(now_ms());
            }
            data.discovery.enabled = enabled;
            if let Some(providers) = providers {
                data.discovery.providers = providers;
            }
            Ok(((), before != data.discovery))
        })?;
        if !enabled {
            lock(&self.catalog)?.clear();
        }
        self.emit_changed("discovery");
        Ok(data)
    }

    pub(crate) fn set_auto_pin(
        &self,
        enabled: bool,
        expected: Option<u64>,
    ) -> SessionResult<StoreData> {
        let (_, data) = self.store.mutate(expected, |data| {
            let changed = data.auto_pin_new != enabled;
            data.auto_pin_new = enabled;
            Ok(((), changed))
        })?;
        self.emit_changed("auto-pin");
        Ok(data)
    }

    /// Provider cwd filter: each registered root plus its linked Git worktrees.
    fn cwds(scope: &ProjectScope) -> Vec<PathBuf> {
        let mut cwds: Vec<PathBuf> = Vec::new();
        for root in &scope.roots {
            for path in std::iter::once(root.path.to_string_lossy().into_owned())
                .chain(branch::worktree_paths(&root.path))
            {
                let path = PathBuf::from(path);
                if !cwds.contains(&path) {
                    cwds.push(path);
                }
            }
        }
        cwds
    }

    /// Longest registered root containing `cwd` (worktrees resolve through their main repo).
    fn project_of(
        scope: &ProjectScope,
        cwd: &str,
        worktrees: &HashMap<PathBuf, PathBuf>,
    ) -> Option<String> {
        let cwd = Path::new(cwd);
        let real = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
        let main = worktrees.get(&real).cloned().unwrap_or(real);
        scope
            .roots
            .iter()
            .filter(|root| main.starts_with(&root.path))
            .max_by_key(|root| root.path.as_os_str().len())
            .map(|root| root.path.to_string_lossy().into_owned())
    }

    /// Lists sessions of registered projects. Auto-pins new sessions; never scans outside them.
    pub(crate) fn list(&self, scope: &ProjectScope, query: &ListQuery) -> SessionResult<Listing> {
        let data = self.store.snapshot()?;
        if !data.discovery.enabled {
            return Ok(Listing {
                discovery_enabled: false,
                sessions: Vec::new(),
                pinned_count: data.pins.len(),
                total_count: 0,
                truncated: false,
                issues: Vec::new(),
            });
        }
        let cwds = Self::cwds(scope);
        let mut worktrees = HashMap::new();
        for root in &scope.roots {
            for path in branch::worktree_paths(&root.path) {
                let path = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(path));
                worktrees.insert(path, root.path.clone());
            }
        }
        let mut sessions = Vec::new();
        let mut issues = Vec::new();
        let mut truncated = false;
        for provider in Provider::ALL {
            if !data.discovery.providers.enabled(provider) {
                continue;
            }
            match self.provider(provider).list(&cwds, MAX_LIST) {
                Ok(listing) => {
                    truncated |= listing.truncated;
                    sessions.extend(listing.sessions.into_iter().map(|s| (provider, s)));
                }
                Err(error) => issues.push(ProviderIssue {
                    provider,
                    code: error.code,
                }),
            }
        }
        let now = now_ms();
        let keys: Vec<(SessionKey, Option<i64>)> = sessions
            .iter()
            .filter_map(|(p, s)| SessionKey::new(*p, &s.id).ok().map(|k| (k, s.created_at)))
            .collect();
        let (_, data) = self.store.mutate(None, |data| {
            let mut changed = false;
            for (key, created) in &keys {
                changed |= data.auto_pin(key, *created, now);
            }
            Ok(((), changed))
        })?;
        let mut summaries: Vec<SessionSummary> = sessions
            .into_iter()
            .filter_map(|(provider, s)| {
                let key = SessionKey::new(provider, &s.id).ok()?;
                Some(SessionSummary {
                    pinned: data.is_pinned(&key),
                    project: Self::project_of(scope, &s.cwd, &worktrees),
                    key,
                    title: s.title,
                    cwd: s.cwd,
                    recorded_branch: s.recorded_branch,
                    created_at: s.created_at,
                    updated_at: s.updated_at,
                    state: s.state,
                    evidence: s.evidence,
                    capabilities: s.capabilities,
                })
            })
            .collect();
        summaries.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
        {
            // The catalog keeps provider facts only; the terminal hold is applied on read.
            let mut catalog = lock(&self.catalog)?;
            catalog.clear();
            catalog.extend(summaries.iter().map(|s| (s.key.clone(), s.clone())));
        }
        let summaries: Vec<SessionSummary> =
            summaries.into_iter().map(|s| self.with_hold(s)).collect();
        if summaries
            .iter()
            .any(|s| s.evidence == super::model::StateEvidence::CodexDaemon)
            || self.codex.status().live
        {
            self.ensure_codex_watch();
        }
        let pinned_count = summaries.iter().filter(|s| s.pinned).count();
        let total_count = summaries.len();
        let filtered = summaries
            .into_iter()
            .filter(|s| matches(s, query))
            .collect();
        Ok(Listing {
            discovery_enabled: true,
            sessions: filtered,
            pinned_count,
            total_count,
            truncated,
            issues,
        })
    }

    /// Catalog entry with the current terminal hold.
    pub(crate) fn get(
        &self,
        scope: &ProjectScope,
        key: &SessionKey,
    ) -> SessionResult<SessionSummary> {
        self.cached(scope, key).map(|s| self.with_hold(s))
    }

    /// Provider facts from the catalog, refreshing the listing once when the key is unknown.
    fn cached(&self, scope: &ProjectScope, key: &SessionKey) -> SessionResult<SessionSummary> {
        if let Some(found) = lock(&self.catalog)?.get(key).cloned() {
            return Ok(found);
        }
        self.list(
            scope,
            &ListQuery {
                scope: Scope::All,
                search: None,
                provider: Some(key.provider),
                project: None,
                state: None,
            },
        )?;
        lock(&self.catalog)?
            .get(key)
            .cloned()
            .ok_or_else(|| SessionError::new("session_not_found", key.to_string()))
    }

    pub(crate) fn pin(&self, key: &SessionKey, pinned: bool) -> SessionResult<bool> {
        let (changed, _) = self.store.mutate(None, |data| {
            let changed = if pinned {
                data.pin(key, now_ms())?
            } else {
                data.unpin(key)
            };
            Ok((changed, true))
        })?;
        if let Ok(mut catalog) = self.catalog.lock()
            && let Some(entry) = catalog.get_mut(key)
        {
            entry.pinned = pinned;
        }
        self.emit_changed("pins");
        Ok(changed)
    }

    pub(crate) fn conversation(
        &self,
        scope: &ProjectScope,
        key: &SessionKey,
        limit: usize,
    ) -> SessionResult<Vec<super::model::ConversationEntry>> {
        let session = self.get(scope, key)?;
        self.provider(key.provider).conversation(
            &key.id,
            &session.cwd,
            limit.clamp(1, MAX_CONVERSATION),
        )
    }

    /// Renames in the provider source; the catalog changes only after source confirmation.
    pub(crate) fn rename(
        &self,
        scope: &ProjectScope,
        key: &SessionKey,
        title: &str,
    ) -> SessionResult<SessionSummary> {
        let session = self.cached(scope, key)?;
        if !session.capabilities.rename.available {
            return Err(SessionError::new(
                session
                    .capabilities
                    .rename
                    .reason
                    .as_deref()
                    .unwrap_or("unsupported"),
                "rename unavailable",
            ));
        }
        self.provider(key.provider)
            .rename(&key.id, &session.cwd, title)?;
        log_event("session_renamed", key, None);
        let mut updated = session;
        updated.title = title.trim().to_string();
        lock(&self.catalog)?.insert(key.clone(), updated.clone());
        self.emit_changed("rename");
        Ok(self.with_hold(updated))
    }

    /// Transmits now. Unknown outcomes are reported, never retried here.
    pub(crate) fn send(
        &self,
        scope: &ProjectScope,
        key: &SessionKey,
        text: &str,
    ) -> SessionResult<SendReceipt> {
        if key.provider == Provider::Claude && self.terminals.running_for(key).is_some() {
            return Err(held_by_terminal());
        }
        let session = self.get(scope, key)?;
        let result = self
            .provider(key.provider)
            .send(&key.id, &session.cwd, text);
        log_event(
            "session_message_sent",
            key,
            Some(match &result {
                Ok(receipt) => serde_json::to_value(receipt)
                    .ok()
                    .and_then(|v| v.get("status").cloned())
                    .unwrap_or_default(),
                Err(error) => json!(error.code),
            }),
        );
        self.emit_changed("send");
        result
    }

    /// Starts a new native session in a registered project and auto-pins it per preference.
    pub(crate) fn create(
        &self,
        scope: &ProjectScope,
        provider: Provider,
        project: &str,
        text: &str,
        title: Option<&str>,
    ) -> SessionResult<CreateSessionReceipt> {
        let root = scope
            .roots
            .iter()
            .find(|root| root.path == Path::new(project))
            .ok_or_else(|| SessionError::new("project_not_registered", project))?;
        let created = self
            .provider(provider)
            .create(&root.path.to_string_lossy(), text, title)?;
        self.store.mutate(None, |data| {
            Ok(((), data.auto_pin_created(&created.session, now_ms())))
        })?;
        log_event(
            "session_created",
            &created.session,
            created.title_warning.map(|warning| json!(warning)),
        );
        self.emit_changed("create");
        Ok(created)
    }

    pub(crate) fn resume(&self, scope: &ProjectScope, key: &SessionKey) -> SessionResult<()> {
        let session = self.get(scope, key)?;
        self.provider(key.provider).resume(&key.id, &session.cwd)?;
        self.emit_changed("resume");
        Ok(())
    }

    /// Opens the session in its provider's app through a documented link, when one exists.
    pub(crate) fn open_in_app(
        &self,
        scope: &ProjectScope,
        key: &SessionKey,
    ) -> SessionResult<super::app_link::OpenReceipt> {
        let session = self.get(scope, key)?;
        if !session.capabilities.open_in_app.available {
            return Err(SessionError::new(
                session
                    .capabilities
                    .open_in_app
                    .reason
                    .as_deref()
                    .unwrap_or("unsupported"),
                "open in app unavailable",
            ));
        }
        let receipt = super::app_link::open_codex_thread(key)?;
        log_event("session_open_in_app_requested", key, None);
        Ok(receipt)
    }

    pub(crate) fn start_codex_daemon(&self) -> SessionResult<()> {
        self.codex.start_daemon()?;
        self.emit_changed("codex-daemon");
        Ok(())
    }

    /// Live branch of the session's real cwd plus a pending request, cleared once observed.
    pub(crate) fn branch(
        &self,
        scope: &ProjectScope,
        key: &SessionKey,
    ) -> SessionResult<SessionBranch> {
        let session = self.get(scope, key)?;
        let facts = branch::facts(Path::new(&session.cwd))?;
        let shared_with = self.sharing_worktree(key, &session.cwd)?;
        let mut pending = lock(&self.pending_branches)?;
        if let Some(request) = pending.get(key)
            && facts.current.as_deref() == Some(request.target.as_str())
        {
            pending.remove(key);
            log_event("session_branch_confirmed", key, None);
        }
        let pending = pending.get(key).cloned().map(|mut request| {
            request.status = pending_status(now_ms() - request.requested_at, Some(session.state));
            request
        });
        // `facts.current` stays the branch really read now, whatever the request status.
        Ok(SessionBranch {
            pending,
            facts,
            shared_with,
        })
    }

    /// Explicitly drops a branch request (it did not happen, or the user changed their mind).
    pub(crate) fn clear_branch_request(&self, key: &SessionKey) -> SessionResult<bool> {
        let removed = lock(&self.pending_branches)?.remove(key).is_some();
        if removed {
            log_event("session_branch_request_cleared", key, None);
            self.emit_changed("branch");
        }
        Ok(removed)
    }

    fn sharing_worktree(&self, key: &SessionKey, cwd: &str) -> SessionResult<Vec<SessionKey>> {
        let root = branch::worktree_root(Path::new(cwd))?;
        // Snapshot before invoking Git, which can take time on a busy filesystem.
        let others: Vec<_> = lock(&self.catalog)?
            .values()
            .filter(|other| &other.key != key && is_live(other.state))
            .map(|other| (other.key.clone(), other.cwd.clone()))
            .collect();
        let mut checked = HashMap::new();
        let mut shared = Vec::new();
        // Stop starting Git probes on slow filesystems. One in-flight probe is bounded by git.rs.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        for (key, cwd) in others {
            let path = std::fs::canonicalize(&cwd).unwrap_or_else(|_| PathBuf::from(cwd));
            if !path.starts_with(&root) {
                continue;
            }
            let shares_root = checked.entry(path).or_insert_with_key(|path| {
                // If Git cannot inspect a directory under this checkout, block the switch.
                path == &root
                    || std::time::Instant::now() >= deadline
                    || branch::worktree_root(path).map_or(true, |candidate| candidate == root)
            });
            if *shares_root {
                shared.push(key);
            }
        }
        Ok(shared)
    }

    /// Asks the agent to switch branch. Refuses when another live owner shares the worktree.
    pub(crate) fn request_branch(
        &self,
        scope: &ProjectScope,
        key: &SessionKey,
        target: &str,
    ) -> SessionResult<SendReceipt> {
        let current = self.branch(scope, key)?;
        let option = current
            .facts
            .options
            .iter()
            .find(|option| option.name == target)
            .ok_or_else(|| SessionError::new("branch_not_found", target))?;
        if current.facts.current.as_deref() == Some(target) {
            return Err(SessionError::new("branch_already_active", target));
        }
        if !current.shared_with.is_empty() {
            return Err(SessionError::new(
                "worktree_shared",
                "another live session works in this working tree",
            ));
        }
        let text = branch::switch_instruction(&scope.language, target, option.worktree.as_deref());
        let receipt = self.send(scope, key, &text)?;
        if option.worktree.is_none() {
            lock(&self.pending_branches)?.insert(
                key.clone(),
                PendingBranch {
                    target: target.to_string(),
                    previous: current.facts.current.clone(),
                    requested_at: now_ms(),
                    status: PendingStatus::Awaiting,
                },
            );
        }
        Ok(receipt)
    }

    pub(crate) fn answer_permission(
        &self,
        key: &SessionKey,
        request_id: &str,
        allow: bool,
    ) -> SessionResult<()> {
        if key.provider != Provider::Claude {
            return Err(SessionError::new(
                "unsupported",
                "permission relay is Claude-only",
            ));
        }
        self.claude.answer_permission(&key.id, request_id, allow)
    }

    // ---- Actions -------------------------------------------------------------------------

    pub(crate) fn actions(
        &self,
        project: Option<&str>,
    ) -> SessionResult<(u64, Vec<ResolvedAction>)> {
        let data = self.store.snapshot()?;
        Ok((data.revision, data.actions.resolve(project)))
    }

    /// Applies one action configuration change under optimistic concurrency.
    pub(crate) fn change_actions(
        &self,
        expected: Option<u64>,
        change: ActionChange,
    ) -> SessionResult<u64> {
        let (_, data) = self.store.mutate(expected, |data| {
            let actions = &mut data.actions;
            match change {
                ActionChange::Add { project, action } => actions.add(project.as_deref(), action)?,
                ActionChange::Update { project, id, patch } => {
                    actions.update(project.as_deref(), &id, patch)?
                }
                ActionChange::Remove { project, id } => actions.remove(project.as_deref(), &id)?,
                ActionChange::Reorder { project, ids } => {
                    actions.reorder(project.as_deref(), ids)?
                }
                ActionChange::Reset { project, id } => actions.reset(&project, id.as_deref())?,
                ActionChange::Replace {
                    project,
                    actions: next,
                } => replace_level(actions, project.as_deref(), next)?,
            }
            Ok(((), true))
        })?;
        self.emit_changed("actions");
        Ok(data.revision)
    }

    /// Renders an action for a session with live values (branch read now from the session cwd).
    pub(crate) fn render_action(
        &self,
        scope: &ProjectScope,
        key: &SessionKey,
        action_id: &str,
        file: Option<String>,
        selection: Option<String>,
    ) -> SessionResult<RenderedAction> {
        let session = self.get(scope, key)?;
        let (_, actions) = self.actions(session.project.as_deref())?;
        let action = actions
            .into_iter()
            .find(|a| a.action.id == action_id)
            .ok_or_else(|| SessionError::new("action_not_found", action_id))?
            .action;
        if !action.enabled || !action.providers.contains(&key.provider) {
            return Err(SessionError::new("action_unavailable", action_id));
        }
        let branch = branch::facts(Path::new(&session.cwd))
            .ok()
            .and_then(|f| f.current);
        let project = session.project.as_deref().and_then(|p| {
            scope
                .roots
                .iter()
                .find(|root| root.path == Path::new(p))
                .map(|root| root.name.clone())
        });
        let text = render(
            &action.template,
            &TemplateValues {
                project,
                branch,
                file,
                selection,
            },
        )?;
        Ok(RenderedAction {
            text,
            mode: action.mode,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderedAction {
    pub text: String,
    pub mode: super::actions::ActionMode,
}

/// One edit of the action configuration; `project: None` targets global values.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "change", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum ActionChange {
    Add {
        #[serde(default)]
        project: Option<String>,
        action: ActionDef,
    },
    Update {
        #[serde(default)]
        project: Option<String>,
        id: String,
        patch: ActionPatch,
    },
    Remove {
        #[serde(default)]
        project: Option<String>,
        id: String,
    },
    Reorder {
        #[serde(default)]
        project: Option<String>,
        ids: Vec<String>,
    },
    Reset {
        project: String,
        #[serde(default)]
        id: Option<String>,
    },
    /// Saves an edited list from the settings form in one atomic step.
    Replace {
        #[serde(default)]
        project: Option<String>,
        actions: Vec<ActionDef>,
    },
}

/// Replaces a level with an edited list: globals directly; for a project, actions equal to
/// global values drop their patch, differing fields become patches, new ids become project actions.
fn replace_level(
    config: &mut super::actions::ActionsConfig,
    project: Option<&str>,
    next: Vec<ActionDef>,
) -> SessionResult<()> {
    let Some(project) = project else {
        config.global = next;
        return config.validate();
    };
    let mut level = super::actions::ProjectActions {
        order: Some(next.iter().map(|a| a.id.clone()).collect()),
        ..Default::default()
    };
    for action in next {
        match config.global.iter().find(|g| g.id == action.id) {
            Some(global) => {
                let patch = ActionPatch {
                    label: (global.label != action.label).then(|| action.label.clone()),
                    template: (global.template != action.template).then(|| action.template.clone()),
                    mode: (global.mode != action.mode).then_some(action.mode),
                    providers: (global.providers != action.providers)
                        .then(|| action.providers.clone()),
                    enabled: (global.enabled != action.enabled).then_some(action.enabled),
                };
                if patch != ActionPatch::default() {
                    level.patches.insert(action.id.clone(), patch);
                }
            }
            None => level.added.push(action),
        }
    }
    let globals_present = config
        .global
        .iter()
        .all(|g| level.order.as_ref().is_some_and(|o| o.contains(&g.id)));
    if !globals_present {
        return Err(SessionError::new(
            "action_not_project_owned",
            "global actions are disabled per project, not removed",
        ));
    }
    let default_order: Vec<String> = config
        .global
        .iter()
        .map(|g| g.id.clone())
        .chain(level.added.iter().map(|a| a.id.clone()))
        .collect();
    if level.order.as_ref() == Some(&default_order) {
        level.order = None;
    }
    if level.is_empty() {
        config.projects.remove(project);
    } else {
        config.projects.insert(project.to_string(), level);
    }
    config.validate()
}

/// A Claude session held by BOA's interactive terminal has one owner: that TUI. There is no
/// documented, safe way to inject a message into it (raw keystrokes could answer a modal prompt
/// or run a shortcut), so conversation sending is refused with a reason; the user types in the
/// Terminal tab. Codex terminals are daemon clients, so Codex sending is unaffected.
fn apply_terminal_hold(summary: &mut SessionSummary, held: bool) {
    if !held {
        return;
    }
    summary.capabilities.terminal = super::model::Capability::yes();
    if summary.key.provider == Provider::Claude {
        let reason = super::model::Capability::no("claude_held_by_boa_terminal");
        summary.capabilities.send = reason.clone();
        summary.capabilities.resume = reason;
        summary.evidence = super::model::StateEvidence::BoaOwned;
    }
}

fn held_by_terminal() -> SessionError {
    SessionError::new(
        "claude_held_by_boa_terminal",
        "BOA's Claude terminal holds this session; type in the terminal",
    )
}

fn matches(session: &SessionSummary, query: &ListQuery) -> bool {
    if query.scope == Scope::Pinned && !session.pinned {
        return false;
    }
    if query.provider.is_some_and(|p| p != session.key.provider)
        || query.state.is_some_and(|s| s != session.state)
        || query
            .project
            .as_deref()
            .is_some_and(|p| session.project.as_deref() != Some(p))
    {
        return false;
    }
    match query
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        None => true,
        Some(search) => {
            let needle = search.to_lowercase();
            [
                Some(session.title.as_str()),
                session.recorded_branch.as_deref(),
                session.project.as_deref(),
                Some(session.cwd.as_str()),
                Some(session.key.id.as_str()),
            ]
            .into_iter()
            .flatten()
            .any(|field| field.to_lowercase().contains(&needle))
        }
    }
}

/// Structured boundary log: identifiers and outcome only, never message content or titles.
fn log_event(event: &str, key: &SessionKey, outcome: Option<Value>) {
    eprintln!(
        "{}",
        json!({"event": event, "provider": key.provider.as_str(), "sessionId": key.id, "outcome": outcome})
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::actions::{ActionMode, ActionsConfig};
    use crate::sessions::model::{Capabilities, Capability, StateEvidence};

    fn summary(id: &str, pinned: bool) -> SessionSummary {
        SessionSummary {
            key: SessionKey::new(Provider::Codex, id).unwrap(),
            title: format!("Fix {id}"),
            project: Some("/p".into()),
            cwd: "/p".into(),
            recorded_branch: Some("feature/x".into()),
            created_at: None,
            updated_at: None,
            state: SessionState::Idle,
            evidence: StateEvidence::CodexDaemon,
            capabilities: Capabilities {
                rename: Capability::yes(),
                send: Capability::yes(),
                resume: Capability::yes(),
                open_in_app: Capability::no("x"),
                terminal: Capability::no("x"),
            },
            pinned,
        }
    }

    /// Test service with no provider tools; the catalog is seeded directly.
    fn offline_service(dir: &std::path::Path) -> SessionService {
        let store = SessionStore::load(dir.join("sessions.json"), "fr").unwrap();
        SessionService::new(
            store,
            CodexProvider::new(None, String::new(), None, false),
            ClaudeProvider::new(None, None, String::new()),
        )
    }

    #[test]
    fn live_sessions_share_a_git_worktree_across_subdirectories() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let nested = repo.join("nested");
        let linked = repo.join("linked");
        std::fs::create_dir_all(&nested).unwrap();
        let git = |args: &[&str]| crate::git::text(&repo, args).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&[
            "-c",
            "user.name=BOA tests",
            "-c",
            "user.email=boa@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "initial",
        ]);
        git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "linked",
            linked.to_str().unwrap(),
        ]);
        let service = offline_service(temp.path());
        let target = summary("target", false).key;
        let mut shared = summary("shared", false);
        shared.cwd = nested.to_str().unwrap().into();
        let mut separate = summary("separate", false);
        separate.cwd = linked.to_str().unwrap().into();
        let mut inactive = summary("inactive", false);
        inactive.cwd = nested.to_str().unwrap().into();
        inactive.state = SessionState::Inactive;
        let expected = shared.key.clone();
        for entry in [shared, separate, inactive] {
            lock(&service.catalog)
                .unwrap()
                .insert(entry.key.clone(), entry);
        }
        assert_eq!(
            service
                .sharing_worktree(&target, repo.to_str().unwrap())
                .unwrap(),
            vec![expected],
        );
    }

    fn shell(script: &str) -> SessionResult<super::super::terminal::TerminalCommand> {
        Ok(super::super::terminal::TerminalCommand {
            program: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), script.into()],
            cwd: std::env::temp_dir(),
            path_env: "/usr/bin:/bin".into(),
        })
    }

    fn wait_for(events: &Mutex<Vec<Value>>, reason: &str) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if events.lock().unwrap().iter().any(|e| e["reason"] == reason) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn claude_terminal_hold_ends_with_the_terminal_on_stop_and_on_spontaneous_exit() {
        let dir = std::env::temp_dir().join(format!("boa-hold-{}", super::super::store::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let service = offline_service(&dir);
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let collected = Arc::clone(&events);
        service.set_emitter(Arc::new(move |name: &str, payload: Value| {
            collected
                .lock()
                .unwrap()
                .push(json!({"name": name, "reason": payload["reason"]}));
        }));
        let scope = ProjectScope {
            roots: vec![],
            language: "fr".into(),
        };
        let mut provider_facts = summary("c", true);
        provider_facts.key = SessionKey::new(Provider::Claude, "c").unwrap();
        provider_facts.evidence = StateEvidence::ClaudeLiveProcess;
        let key = provider_facts.key.clone();
        lock(&service.catalog)
            .unwrap()
            .insert(key.clone(), provider_facts);

        // Explicit stop: refused while the terminal runs, restored once it is stopped.
        let opened = service
            .terminals()
            .open(&key, || shell("sleep 30"), 80, 24)
            .unwrap();
        let held = service.get(&scope, &key).unwrap();
        assert_eq!(
            held.capabilities.send.reason.as_deref(),
            Some("claude_held_by_boa_terminal")
        );
        assert_eq!(
            service.send(&scope, &key, "x").unwrap_err().code,
            "claude_held_by_boa_terminal"
        );
        assert!(
            lock(&service.catalog).unwrap()[&key]
                .capabilities
                .send
                .available,
            "the catalog keeps provider facts; the hold is derived on read"
        );
        service.terminals().close(&opened.terminal_id).unwrap();
        let free = service.get(&scope, &key).unwrap();
        assert!(free.capabilities.send.available, "stale holder after stop");
        assert!(free.capabilities.resume.available);
        assert_eq!(free.evidence, StateEvidence::ClaudeLiveProcess);
        assert!(
            wait_for(&events, "terminal-exit"),
            "stop must publish a change"
        );

        // Spontaneous exit: the process quits on its own; one change event, no stale holder.
        events.lock().unwrap().clear();
        service
            .terminals()
            .open(&key, || shell("sleep 0.2"), 80, 24)
            .unwrap();
        assert!(
            !service
                .get(&scope, &key)
                .unwrap()
                .capabilities
                .send
                .available
        );
        assert!(
            wait_for(&events, "terminal-exit"),
            "exit must publish a change"
        );
        assert!(
            service
                .get(&scope, &key)
                .unwrap()
                .capabilities
                .send
                .available
        );
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e["reason"] == "terminal-exit")
                .count(),
            1
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restored_terminal_view_attaches_to_a_running_pty_but_never_starts_one() {
        let dir =
            std::env::temp_dir().join(format!("boa-attach-{}", super::super::store::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let service = offline_service(&dir);
        let scope = ProjectScope {
            roots: vec![],
            language: "fr".into(),
        };
        // Not in the catalog on purpose: attaching relies on the terminal registry only.
        let key = SessionKey::new(Provider::Claude, "attach").unwrap();
        let refused = service
            .open_terminal(&scope, &key, 80, 24, true)
            .unwrap_err();
        assert_eq!(refused.code, "terminal_not_running");
        assert!(
            service.terminals().running().unwrap().is_empty(),
            "nothing started"
        );
        let started = service
            .terminals()
            .open(&key, || shell("sleep 30"), 80, 24)
            .unwrap();
        let attached = service.open_terminal(&scope, &key, 80, 24, true).unwrap();
        assert_eq!(attached.terminal_id, started.terminal_id);
        service.terminals().close(&started.terminal_id).unwrap();
        assert_eq!(
            service
                .open_terminal(&scope, &key, 80, 24, true)
                .unwrap_err()
                .code,
            "terminal_not_running",
            "a stopped PTY is not restarted by a restored view"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claude_session_held_by_boa_terminal_refuses_conversation_send_but_codex_keeps_it() {
        let mut claude = summary("c", true);
        claude.key = SessionKey::new(Provider::Claude, "c").unwrap();
        apply_terminal_hold(&mut claude, true);
        assert!(claude.capabilities.terminal.available);
        assert_eq!(
            claude.capabilities.send.reason.as_deref(),
            Some("claude_held_by_boa_terminal")
        );
        assert!(!claude.capabilities.resume.available);
        let mut codex = summary("x", true);
        apply_terminal_hold(&mut codex, true);
        assert!(
            codex.capabilities.send.available,
            "Codex TUI is a daemon client"
        );
        let mut free = summary("f", true);
        free.key = SessionKey::new(Provider::Claude, "f").unwrap();
        apply_terminal_hold(&mut free, false);
        assert!(free.capabilities.send.available);
        assert_eq!(held_by_terminal().code, "claude_held_by_boa_terminal");
    }

    #[test]
    fn branch_request_becomes_unconfirmed_after_the_turn_or_the_bound_never_confirmed() {
        assert_eq!(
            pending_status(5_000, Some(SessionState::Idle)),
            PendingStatus::Awaiting,
            "grace for lagging status"
        );
        assert_eq!(
            pending_status(25_000, Some(SessionState::Working)),
            PendingStatus::Awaiting
        );
        assert_eq!(
            pending_status(25_000, Some(SessionState::Idle)),
            PendingStatus::Unconfirmed
        );
        assert_eq!(
            pending_status(25_000, Some(SessionState::Unknown)),
            PendingStatus::Unconfirmed
        );
        assert_eq!(
            pending_status(PENDING_LIMIT_MS, Some(SessionState::Working)),
            PendingStatus::Unconfirmed
        );
    }

    #[test]
    fn filters_respect_scope_search_and_facets() {
        let query = |scope, search: &str| ListQuery {
            scope,
            search: Some(search.into()),
            provider: None,
            project: None,
            state: None,
        };
        assert!(!matches(&summary("a", false), &query(Scope::Pinned, "")));
        assert!(matches(
            &summary("a", false),
            &query(Scope::All, "FEATURE/x")
        ));
        assert!(!matches(&summary("a", true), &query(Scope::All, "nothing")));
    }

    #[test]
    fn replace_project_level_stores_only_differences_and_refuses_dropping_globals() {
        let review = ActionDef {
            id: "review".into(),
            label: "Review".into(),
            template: "Review {branch}".into(),
            mode: ActionMode::Prepare,
            providers: Provider::ALL.into_iter().collect(),
            enabled: true,
        };
        let mut config = ActionsConfig {
            global: vec![review.clone()],
            projects: Default::default(),
        };
        let mut edited = review.clone();
        edited.mode = ActionMode::Send;
        let mut extra = review.clone();
        extra.id = "extra".into();
        replace_level(&mut config, Some("/p"), vec![edited, extra]).unwrap();
        let level = &config.projects["/p"];
        assert_eq!(level.patches["review"].mode, Some(ActionMode::Send));
        assert!(level.patches["review"].label.is_none());
        assert_eq!(level.added.len(), 1);
        assert!(level.order.is_none(), "default order is not stored");
        replace_level(&mut config, Some("/p"), vec![review.clone()]).unwrap();
        assert!(config.projects.is_empty(), "identical values inherit again");
        assert_eq!(
            replace_level(&mut config, Some("/p"), vec![])
                .unwrap_err()
                .code,
            "action_not_project_owned"
        );
    }
}
