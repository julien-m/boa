//! Domain types shared by the session catalog, providers, CLI and UI boundaries.
use serde::{Deserialize, Serialize};
use std::fmt;

/// Upper bound for provider-issued identifiers (Codex UUIDv7, Claude UUID); rejects junk early.
const MAX_SESSION_ID: usize = 128;

/// Coding-agent provider owning a session's native history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Provider {
    Codex,
    Claude,
}

impl Provider {
    pub(crate) const ALL: [Provider; 2] = [Provider::Codex, Provider::Claude];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Provider::Codex => "codex",
            Provider::Claude => "claude",
        }
    }
}

/// Stable identity of a session: the provider plus its native identifier.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub(crate) struct SessionKey {
    pub provider: Provider,
    pub id: String,
}

impl SessionKey {
    /// Validated construction: ids are printable ASCII without separators or path syntax.
    pub(crate) fn new(provider: Provider, id: &str) -> Result<Self, SessionError> {
        let valid = !id.is_empty()
            && id.len() <= MAX_SESSION_ID
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
        if !valid {
            return Err(SessionError::invalid("id", "invalid session identifier"));
        }
        Ok(Self {
            provider,
            id: id.to_string(),
        })
    }
}

impl fmt::Display for SessionKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.provider.as_str(), self.id)
    }
}

/// Observable activity, never inferred from file timestamps alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionState {
    /// A turn is running according to the provider's live status.
    Working,
    /// The provider reports it waits for an approval or user input.
    AwaitingInput,
    /// A live owner reports no running turn.
    Idle,
    /// No live process owns the session; history remains resumable.
    Inactive,
    /// The provider reports a terminal failure state.
    Failed,
    /// No reliable live signal is available (for example no shared daemon).
    Unknown,
}

/// Where the displayed state came from, so the UI never over-claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StateEvidence {
    /// Codex shared app-server daemon status/notifications.
    CodexDaemon,
    /// Codex private app-server: history only, live state unknowable.
    CodexHistoryOnly,
    /// `claude agents --json` lists the session as a live process.
    ClaudeLiveProcess,
    /// Not listed by `claude agents --json`: no live process.
    ClaudeNoProcess,
    /// The session is driven by BOA itself; state is exact.
    BoaOwned,
    /// The provider could not be queried.
    Unavailable,
}

/// Per-session capability flags with a reason code when an action is unavailable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capability {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Capability {
    pub(crate) fn yes() -> Self {
        Self {
            available: true,
            reason: None,
        }
    }
    pub(crate) fn no(reason: &str) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capabilities {
    pub rename: Capability,
    pub send: Capability,
    pub resume: Capability,
    pub open_in_app: Capability,
    pub terminal: Capability,
}

/// Catalog entry returned to the UI and CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSummary {
    pub key: SessionKey,
    pub title: String,
    /// Registered BOA project containing `cwd`, if any.
    pub project: Option<String>,
    pub cwd: String,
    /// Branch snapshot recorded by the provider; never used for actions.
    pub recorded_branch: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub state: SessionState,
    pub evidence: StateEvidence,
    pub capabilities: Capabilities,
    pub pinned: bool,
}

/// One conversation entry read from the provider history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationEntry {
    pub role: ConversationRole,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConversationRole {
    User,
    Agent,
    Tool,
}

/// Outcome of a transmission. `Unknown` must never be retried automatically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub(crate) enum SendReceipt {
    /// The provider accepted the message into a new turn.
    Started { turn_id: Option<String> },
    /// The provider steered the message into the running turn.
    Steered { turn_id: String },
    /// The provider queued the message by its own follow-up policy.
    QueuedByProvider { submission_id: String },
    /// The provider acknowledged this exact message (Claude Code replays its uuid). How it is
    /// processed (now, mid-turn or later) follows the tool's own policy.
    Accepted { message_id: String },
    /// The transport timed out after writing; the provider may or may not have it.
    Unknown,
}

/// Typed failure with a stable code for presentation-layer localization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SessionError {
    pub code: String,
    /// Internal English diagnostic; never shown raw when a catalog entry exists.
    pub message: String,
}

impl SessionError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub(crate) fn invalid(field: &str, message: &str) -> Self {
        Self::new("invalid_input", format!("{field}: {message}"))
    }
    pub(crate) fn io(error: impl fmt::Display) -> Self {
        Self::new("io_error", error.to_string())
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub(crate) type SessionResult<T> = Result<T, SessionError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_key_rejects_path_syntax_and_accepts_provider_ids() {
        assert!(SessionKey::new(Provider::Codex, "01a1eac5-5d9d-7aa3-a4cb-2cf1f1294744").is_ok());
        for bad in ["", "../x", "a/b", "a b", &"x".repeat(129)] {
            assert_eq!(
                SessionKey::new(Provider::Claude, bad).unwrap_err().code,
                "invalid_input"
            );
        }
    }

    #[test]
    fn receipts_keep_provider_queue_distinct_from_steer_and_unknown() {
        let queued = serde_json::to_value(SendReceipt::QueuedByProvider {
            submission_id: "q".into(),
        })
        .unwrap();
        assert_eq!(queued["status"], "queuedByProvider");
        assert_eq!(
            queued["submissionId"], "q",
            "fields match the TypeScript receipt type"
        );
        let steered = serde_json::to_value(SendReceipt::Steered {
            turn_id: "t".into(),
        })
        .unwrap();
        assert_eq!(steered["turnId"], "t");
        assert_eq!(
            serde_json::to_value(SendReceipt::Unknown).unwrap()["status"],
            "unknown"
        );
    }
}
