//! Versioned local store `sessions.json`: discovery opt-in, session pins and action buttons.
//!
//! Single writer (the app process) guarded by a mutex; every write goes temp file → fsync →
//! atomic rename so a crash leaves either the old or the new file, never a torn one.
use super::actions::ActionsConfig;
use super::model::{Provider, SessionError, SessionKey, SessionResult};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub(crate) const STORE_VERSION: u32 = 1;
/// A user pins a handful of active sessions; 500 bounds the file without real constraint.
const MAX_PINS: usize = 500;
/// Dismissals only stop auto-pin from returning; oldest entries can safely age out.
const MAX_DISMISSED: usize = 2000;
const MAX_STORE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PinOrigin {
    Auto,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Pin {
    pub provider: Provider,
    pub id: String,
    pub pinned_at: i64,
    pub origin: PinOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderToggles {
    pub codex: bool,
    pub claude: bool,
}

impl ProviderToggles {
    pub(crate) fn enabled(&self, provider: Provider) -> bool {
        match provider {
            Provider::Codex => self.codex,
            Provider::Claude => self.claude,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Discovery {
    pub enabled: bool,
    pub enabled_at: Option<i64>,
    pub providers: ProviderToggles,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoreData {
    pub version: u32,
    pub revision: u64,
    pub discovery: Discovery,
    pub auto_pin_new: bool,
    pub pins: Vec<Pin>,
    pub dismissed: Vec<SessionKey>,
    pub actions: ActionsConfig,
}

impl StoreData {
    /// Fresh-install defaults: discovery off, auto-pin on, localized example actions.
    pub(crate) fn fresh(language: &str) -> Self {
        Self {
            version: STORE_VERSION,
            revision: 0,
            discovery: Discovery {
                enabled: false,
                enabled_at: None,
                providers: ProviderToggles {
                    codex: true,
                    claude: true,
                },
            },
            auto_pin_new: true,
            pins: Vec::new(),
            dismissed: Vec::new(),
            actions: ActionsConfig {
                global: super::default_actions::defaults(language),
                projects: Default::default(),
            },
        }
    }

    fn validate(&self) -> SessionResult<()> {
        if self.version != STORE_VERSION {
            return Err(SessionError::new(
                "unsupported_store_version",
                format!("sessions store version {}", self.version),
            ));
        }
        if self.pins.len() > MAX_PINS || self.dismissed.len() > MAX_DISMISSED {
            return Err(SessionError::new(
                "limit_reached",
                "too many session entries",
            ));
        }
        let mut keys = BTreeSet::new();
        for pin in &self.pins {
            let key = SessionKey::new(pin.provider, &pin.id)?;
            if !keys.insert(key) {
                return Err(SessionError::invalid("pins", "duplicate session pin"));
            }
        }
        for key in &self.dismissed {
            SessionKey::new(key.provider, &key.id)?;
        }
        self.actions.validate()
    }

    pub(crate) fn is_pinned(&self, key: &SessionKey) -> bool {
        self.pins
            .iter()
            .any(|p| p.provider == key.provider && p.id == key.id)
    }

    /// Pins explicitly; also clears a previous dismissal.
    pub(crate) fn pin(&mut self, key: &SessionKey, now: i64) -> SessionResult<bool> {
        self.dismissed.retain(|d| d != key);
        if self.is_pinned(key) {
            return Ok(false);
        }
        if self.pins.len() >= MAX_PINS {
            return Err(SessionError::new(
                "limit_reached",
                "too many pinned sessions",
            ));
        }
        self.pins.push(Pin {
            provider: key.provider,
            id: key.id.clone(),
            pinned_at: now,
            origin: PinOrigin::Manual,
        });
        Ok(true)
    }

    /// Unpins (hides from the pinned view only) and remembers the choice against auto-pin.
    pub(crate) fn unpin(&mut self, key: &SessionKey) -> bool {
        let before = self.pins.len();
        self.pins
            .retain(|p| !(p.provider == key.provider && p.id == key.id));
        if !self.dismissed.contains(key) {
            self.dismissed.push(key.clone());
            if self.dismissed.len() > MAX_DISMISSED {
                self.dismissed.remove(0);
            }
        }
        before != self.pins.len()
    }

    /// Auto-pins a session created after the opt-in, unless the user unpinned it before.
    pub(crate) fn auto_pin(&mut self, key: &SessionKey, created_at: Option<i64>, now: i64) -> bool {
        let is_new = match (self.discovery.enabled_at, created_at) {
            (Some(since), Some(created)) => created >= since,
            _ => false,
        };
        if !self.auto_pin_new
            || !is_new
            || self.is_pinned(key)
            || self.dismissed.contains(key)
            || self.pins.len() >= MAX_PINS
        {
            return false;
        }
        self.pins.push(Pin {
            provider: key.provider,
            id: key.id.clone(),
            pinned_at: now,
            origin: PinOrigin::Auto,
        });
        true
    }

    /// Auto-pins a session BOA itself created, regardless of discovery timestamps.
    pub(crate) fn auto_pin_created(&mut self, key: &SessionKey, now: i64) -> bool {
        if !self.auto_pin_new || self.is_pinned(key) || self.pins.len() >= MAX_PINS {
            return false;
        }
        self.pins.push(Pin {
            provider: key.provider,
            id: key.id.clone(),
            pinned_at: now,
            origin: PinOrigin::Auto,
        });
        true
    }
}

/// Owner of `sessions.json`; cheap clones of the data are handed to readers.
pub(crate) struct SessionStore {
    path: PathBuf,
    data: Mutex<StoreData>,
    /// Set when an unreadable file was moved aside during load.
    pub(crate) recovered_from: Option<PathBuf>,
}

impl SessionStore {
    /// Loads the store, moving an unreadable file aside instead of failing the whole app.
    pub(crate) fn load(path: PathBuf, language: &str) -> SessionResult<Self> {
        let mut recovered_from = None;
        let data = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<StoreData>(&bytes)
                .map_err(|e| SessionError::new("store_unreadable", e.to_string()))
                .and_then(|data| data.validate().map(|()| data))
            {
                Ok(data) => data,
                Err(error) if error.code == "unsupported_store_version" => return Err(error),
                Err(error) => {
                    let aside = path.with_extension(format!("json.corrupt-{}", now_ms()));
                    fs::rename(&path, &aside).map_err(SessionError::io)?;
                    eprintln!(
                        "{}",
                        serde_json::json!({"event":"sessions_store_recovered","errorCode":error.code})
                    );
                    recovered_from = Some(aside);
                    StoreData::fresh(language)
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                StoreData::fresh(language)
            }
            Err(error) => return Err(SessionError::io(error)),
        };
        Ok(Self {
            path,
            data: Mutex::new(data),
            recovered_from,
        })
    }

    pub(crate) fn snapshot(&self) -> SessionResult<StoreData> {
        Ok(self
            .data
            .lock()
            .map_err(|_| SessionError::new("store_poisoned", "sessions store lock"))?
            .clone())
    }

    /// Applies a validated mutation atomically. `expected` guards against concurrent edits.
    /// The closure returns whether anything changed; unchanged data is not rewritten.
    pub(crate) fn mutate<T>(
        &self,
        expected: Option<u64>,
        change: impl FnOnce(&mut StoreData) -> SessionResult<(T, bool)>,
    ) -> SessionResult<(T, StoreData)> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| SessionError::new("store_poisoned", "sessions store lock"))?;
        if expected.is_some_and(|revision| revision != data.revision) {
            return Err(SessionError::new(
                "revision_conflict",
                "sessions settings changed; reload before saving",
            ));
        }
        let mut candidate = data.clone();
        let (value, changed) = change(&mut candidate)?;
        if !changed {
            return Ok((value, candidate));
        }
        candidate.revision = candidate
            .revision
            .checked_add(1)
            .ok_or_else(|| SessionError::new("limit_reached", "revision exhausted"))?;
        candidate.validate()?;
        write_atomic(&self.path, &candidate)?;
        *data = candidate.clone();
        Ok((value, candidate))
    }
}

fn write_atomic(path: &Path, data: &StoreData) -> SessionResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| SessionError::io("missing app data folder"))?;
    fs::create_dir_all(parent).map_err(SessionError::io)?;
    let bytes = serde_json::to_vec_pretty(data).map_err(SessionError::io)?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err(SessionError::new(
            "limit_reached",
            "sessions store too large",
        ));
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(SessionError::io)?;
    temp.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(SessionError::io)?;
    temp.write_all(&bytes).map_err(SessionError::io)?;
    // fsync before rename: the rename must publish complete bytes.
    temp.as_file().sync_all().map_err(SessionError::io)?;
    temp.persist(path).map_err(SessionError::io)?;
    Ok(())
}

/// Wall clock in Unix milliseconds; the single time source of the sessions domain.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: &str) -> SessionKey {
        SessionKey::new(Provider::Codex, id).unwrap()
    }

    #[test]
    fn fresh_store_is_empty_opt_out_and_persists_atomically_with_private_mode() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sessions.json");
        let store = SessionStore::load(path.clone(), "fr").unwrap();
        let data = store.snapshot().unwrap();
        assert!(!data.discovery.enabled && data.auto_pin_new && data.pins.is_empty());
        assert!(!path.exists(), "nothing is written before a change");
        store
            .mutate(Some(0), |d| d.pin(&key("a"), 1).map(|c| ((), c)))
            .unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let reloaded = SessionStore::load(path, "fr").unwrap().snapshot().unwrap();
        assert_eq!(reloaded.revision, 1);
        assert!(reloaded.is_pinned(&key("a")));
    }

    #[test]
    fn stale_revision_is_rejected_without_writing() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::load(temp.path().join("s.json"), "en").unwrap();
        store
            .mutate(None, |d| d.pin(&key("a"), 1).map(|c| ((), c)))
            .unwrap();
        let error = store
            .mutate(Some(0), |d| d.pin(&key("b"), 1).map(|c| ((), c)))
            .unwrap_err();
        assert_eq!(error.code, "revision_conflict");
        assert!(!store.snapshot().unwrap().is_pinned(&key("b")));
    }

    #[test]
    fn unpin_hides_without_deleting_and_blocks_auto_pin_until_manual_pin() {
        let mut data = StoreData::fresh("fr");
        data.discovery.enabled = true;
        data.discovery.enabled_at = Some(100);
        assert!(
            !data.auto_pin(&key("old"), Some(50), 200),
            "pre-opt-in history stays unpinned"
        );
        assert!(data.auto_pin(&key("new"), Some(150), 200));
        assert!(data.unpin(&key("new")));
        assert!(!data.auto_pin(&key("new"), Some(150), 300));
        assert!(data.pin(&key("new"), 400).unwrap());
        assert!(data.dismissed.is_empty());
        data.auto_pin_new = false;
        assert!(!data.auto_pin(&key("later"), Some(500), 600));
    }

    #[test]
    fn unreadable_store_is_moved_aside_and_newer_versions_are_refused() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sessions.json");
        fs::write(&path, b"{broken").unwrap();
        let store = SessionStore::load(path.clone(), "fr").unwrap();
        assert!(store.recovered_from.as_ref().unwrap().exists());
        let mut future = StoreData::fresh("fr");
        future.version = 2;
        fs::write(&path, serde_json::to_vec(&future).unwrap()).unwrap();
        assert_eq!(
            SessionStore::load(path, "fr").err().unwrap().code,
            "unsupported_store_version"
        );
    }
}
