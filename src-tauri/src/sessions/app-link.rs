//! Documented deep link to a local Codex chat: `codex://threads/<thread-id>`
//! (https://learn.chatgpt.com/docs/reference/commands#deep-links, "Chats").
//!
//! BOA only asks macOS to open the link with the registered handler. It can observe that the
//! request was accepted and that the handler app runs, not that the chat is displayed.
use super::model::{SessionError, SessionKey, SessionResult};
use serde::Serialize;
use std::path::PathBuf;

const CODEX_THREAD_PREFIX: &str = "codex://threads/";

/// Builds the link from a validated session key (ids are `[A-Za-z0-9_-]`, so no encoding needed).
pub(crate) fn codex_thread_url(key: &SessionKey) -> String {
    format!("{CODEX_THREAD_PREFIX}{}", key.id)
}

/// Application registered for `codex://` links, resolved through LaunchServices.
#[cfg(target_os = "macos")]
pub(crate) fn codex_handler() -> Option<PathBuf> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    autoreleasepool(|_| {
        let url = NSURL::URLWithString(&NSString::from_str("codex://threads/probe"))?;
        NSWorkspace::sharedWorkspace()
            .URLForApplicationToOpenURL(&url)?
            .path()
            .map(|path| PathBuf::from(path.to_string()))
    })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn codex_handler() -> Option<PathBuf> {
    None
}

/// Codex Desktop's bundle identifier (verified with the installed app's Info.plist).
const CODEX_DESKTOP_BUNDLE: &str = "com.openai.codex";

/// Whether Codex Desktop runs now. Desktop keeps its own app-server unless it uses the shared
/// daemon, and Codex documents no cross-process lock for a thread, so a thread it may hold must
/// not be resumed elsewhere. Read-only LaunchServices query; checked at each listing.
#[cfg(target_os = "macos")]
pub(crate) fn codex_desktop_running() -> bool {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSRunningApplication;
    use objc2_foundation::NSString;
    autoreleasepool(|_| {
        NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(
            CODEX_DESKTOP_BUNDLE,
        ))
        .count()
            > 0
    })
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn codex_desktop_running() -> bool {
    false
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenReceipt {
    pub url: String,
    pub handler: String,
    /// macOS accepted the open request (`open` exited 0).
    pub requested: bool,
    /// Displaying the chat itself is not observable from BOA.
    pub display_confirmed: bool,
}

/// Asks macOS to open the chat in the registered Codex app.
pub(crate) fn open_codex_thread(key: &SessionKey) -> SessionResult<OpenReceipt> {
    let handler = codex_handler()
        .ok_or_else(|| SessionError::new("codex_app_missing", "no handler for codex:// links"))?;
    let url = codex_thread_url(key);
    // Contract: /usr/bin/open hands the URL to LaunchServices and exits 0 once accepted.
    let output = super::tools::run_bounded(
        std::process::Command::new("/usr/bin/open").arg(&url),
        std::time::Duration::from_secs(10),
    )?;
    if !output.success {
        return Err(SessionError::new("open_failed", output.stderr_tail));
    }
    Ok(OpenReceipt {
        url,
        handler: handler.to_string_lossy().into_owned(),
        requested: true,
        display_confirmed: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::model::Provider;

    #[test]
    fn link_uses_the_documented_thread_form_for_a_validated_id() {
        let key = SessionKey::new(Provider::Codex, "01a1eac5-5d9d-7aa3-a4cb-2cf1f1294744").unwrap();
        assert_eq!(
            codex_thread_url(&key),
            "codex://threads/01a1eac5-5d9d-7aa3-a4cb-2cf1f1294744"
        );
        assert!(SessionKey::new(Provider::Codex, "x/../../y").is_err());
    }

    #[test]
    fn handler_lookup_is_read_only_and_never_panics() {
        // Resolves the registered app if any; opening is not exercised here.
        let _ = codex_handler();
        let _ = codex_desktop_running();
    }
}
