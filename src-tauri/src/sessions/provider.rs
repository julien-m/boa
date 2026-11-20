//! Capability contract implemented by each coding-agent provider adapter.
//!
//! Adapters translate native protocols into these types; callers never branch on the provider.
use super::model::{
    Capabilities, ConversationEntry, CreateSessionReceipt, Provider, SendReceipt, SessionResult,
    SessionState, StateEvidence,
};
use serde::Serialize;
use std::path::PathBuf;

/// A session as reported by its provider, before BOA adds project and pin information.
#[derive(Debug, Clone)]
pub(crate) struct ProviderSession {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub recorded_branch: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub state: SessionState,
    pub evidence: StateEvidence,
    pub capabilities: Capabilities,
}

/// Provider-wide availability shown in settings and the CLI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderStatus {
    pub provider: Provider,
    pub available: bool,
    /// Stable reason code when unavailable or degraded (e.g. `codex_daemon_not_running`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// True when live state and mutations go through a shared owner.
    pub live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// One page of sessions for the requested working directories.
#[derive(Debug, Clone, Default)]
pub(crate) struct ProviderListing {
    pub sessions: Vec<ProviderSession>,
    /// True when the provider had more results than the requested bound.
    pub truncated: bool,
}

/// Contract for a provider adapter. Implementations own their processes and connections,
/// bound every call with a timeout, and never write provider storage directly.
pub(crate) trait SessionProvider: Send + Sync {
    fn status(&self) -> ProviderStatus;

    /// Lists sessions whose recorded working directory is one of `cwds`, newest first.
    fn list(&self, cwds: &[PathBuf], limit: usize) -> SessionResult<ProviderListing>;

    /// Reads at most `limit` most recent conversation entries, oldest first.
    fn conversation(
        &self,
        id: &str,
        cwd: &str,
        limit: usize,
    ) -> SessionResult<Vec<ConversationEntry>>;

    /// Renames the session in the provider's own storage through its supported API.
    fn rename(&self, id: &str, cwd: &str, title: &str) -> SessionResult<()>;

    /// Transmits text now; the provider's own follow-up policy decides steer or queue.
    fn send(&self, id: &str, cwd: &str, text: &str) -> SessionResult<SendReceipt>;

    /// Starts a new native session in `cwd` with a first message.
    fn create(
        &self,
        cwd: &str,
        text: &str,
        title: Option<&str>,
    ) -> SessionResult<CreateSessionReceipt>;

    /// Explicitly resumes a native session under the shared/BOA owner.
    fn resume(&self, id: &str, cwd: &str) -> SessionResult<()>;
}
