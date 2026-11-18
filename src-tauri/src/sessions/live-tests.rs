//! Opt-in tests against the real providers: ignored by default, run with
//! `BOA_PROVIDER_TESTS=1 cargo test provider_live -- --ignored --test-threads=1`.
//!
//! They only create identified test sessions in isolated places:
//! - Codex: a private `CODEX_HOME` under `/tmp/boa-cx-live` (short path: AF_UNIX limit) with its
//!   own daemon, stopped at the end. Turn tests need model access: they run only with
//!   `BOA_TEST_CODEX_AUTH=1`, which links (never copies) `~/.codex/auth.json` into that home
//!   and removes the link afterwards.
//! - Claude: sessions created through the official SDK in `/tmp/boa-cl-live`.
use super::claude::ClaudeProvider;
use super::codex::CodexProvider;
use super::model::{SendReceipt, SessionState};
use super::provider::SessionProvider;
use super::tools::ToolPaths;
use std::{
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

fn enabled(var: &str) -> bool {
    std::env::var(var).as_deref() == Ok("1")
}

fn git_repo(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    if !path.join(".git").exists() {
        assert!(
            Command::new("/usr/bin/git")
                .arg("-C")
                .arg(path)
                .args(["init", "-q"])
                .status()
                .unwrap()
                .success()
        );
    }
}

struct CodexHome {
    home: PathBuf,
    binary: PathBuf,
    path: String,
    auth_link: Option<PathBuf>,
}

impl Drop for CodexHome {
    fn drop(&mut self) {
        let _ = Command::new(&self.binary)
            .args(["app-server", "daemon", "stop"])
            .env("CODEX_HOME", &self.home)
            .env("PATH", &self.path)
            .output();
        // `daemon stop` can leave its pid-update loop behind in a private home.
        let _ = Command::new("/usr/bin/pkill")
            .args([
                "-f",
                &format!("{}/packages/app-server-daemon", self.home.display()),
            ])
            .status();
        if let Some(link) = &self.auth_link {
            let _ = std::fs::remove_file(link);
        }
    }
}

fn wait_until(timeout: Duration, mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

#[test]
#[ignore = "creates real provider test sessions; see module docs"]
fn provider_live_codex_daemon_rename_and_follow_up_modes() {
    if !enabled("BOA_PROVIDER_TESTS") {
        return;
    }
    let tools = ToolPaths::discover();
    let binary = tools.codex.clone().expect("codex installed");
    let home = PathBuf::from(format!("/tmp/boa-cx-live-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let with_turns = enabled("BOA_TEST_CODEX_AUTH");
    let auth_link = with_turns.then(|| {
        let link = home.join("auth.json");
        let real = PathBuf::from(std::env::var("HOME").unwrap()).join(".codex/auth.json");
        std::os::unix::fs::symlink(real, &link).unwrap();
        link
    });
    let guard = CodexHome {
        home: home.clone(),
        binary: binary.clone(),
        path: tools.child_path.clone(),
        auth_link,
    };
    let work = home.join("work");
    git_repo(&work);
    let codex = CodexProvider::new(
        Some(binary),
        tools.child_path.clone(),
        Some(home.clone()),
        false,
    );
    let status = codex.status();
    assert_eq!(status.reason.as_deref(), Some("codex_daemon_not_running"));
    assert_eq!(
        codex.rename("x", "", "t").unwrap_err().code,
        "codex_daemon_not_running",
        "no mutation without the shared owner"
    );
    codex.start_daemon().unwrap();
    assert!(codex.status().live);
    if !with_turns {
        drop(guard);
        return;
    }
    let cwd = work.to_string_lossy().into_owned();
    let (id, receipt) = codex
        .create(
            &cwd,
            "BOA live test session. Run `sleep 8`, then reply DONE.",
            Some("BOA live test"),
        )
        .unwrap();
    assert!(matches!(receipt, SendReceipt::Started { .. }));
    // Steer mode is the server default without a configured follow-up mode.
    let steered = codex.send(&id, &cwd, "Also say STEER.").unwrap();
    assert!(
        matches!(steered, SendReceipt::Steered { .. }),
        "{steered:?}"
    );
    codex.rename(&id, &cwd, "BOA live test renamed").unwrap();
    assert!(wait_until(Duration::from_secs(90), || {
        codex
            .list(std::slice::from_ref(&work), 10)
            .ok()
            .and_then(|l| l.sessions.into_iter().find(|s| s.id == id))
            .is_some_and(|s| s.state == SessionState::Idle && s.title == "BOA live test renamed")
    }));
    std::fs::write(
        home.join("config.toml"),
        "[desktop]\nfollowUpQueueMode = \"queue\"\n",
    )
    .unwrap();
    codex
        .send(&id, &cwd, "Run `sleep 6`, then reply ONE.")
        .unwrap();
    let queued = codex.send(&id, &cwd, "Reply QUEUED.").unwrap();
    assert!(
        matches!(queued, SendReceipt::QueuedByProvider { .. }),
        "{queued:?}"
    );
    let conversation = codex.conversation(&id, &cwd, 20).unwrap();
    assert!(
        conversation
            .iter()
            .any(|entry| entry.text.contains("Also say STEER"))
    );
    assert!(wait_until(Duration::from_secs(90), || {
        codex.conversation(&id, &cwd, 40).is_ok_and(|entries| {
            entries.iter().any(|e| {
                e.text.contains("QUEUED") && e.role == super::model::ConversationRole::Agent
            })
        })
    }));
    drop(guard);
}

#[test]
#[ignore = "creates real provider test sessions; see module docs"]
fn provider_live_claude_sdk_create_rename_send_and_owner_guard() {
    if !enabled("BOA_PROVIDER_TESTS") {
        return;
    }
    let tools = ToolPaths::discover();
    let claude = ClaudeProvider::new(
        tools.claude.clone(),
        tools.node.clone(),
        tools.child_path.clone(),
    );
    let work = PathBuf::from("/tmp/boa-cl-live");
    git_repo(&work);
    let cwd = std::fs::canonicalize(&work)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let (id, receipt) = claude
        .create(
            &cwd,
            "BOA live test session. Reply with the single word OK.",
            Some("BOA live test"),
        )
        .unwrap();
    assert!(
        matches!(receipt, SendReceipt::Accepted { .. }),
        "{receipt:?}"
    );
    let listed = claude.list(std::slice::from_ref(&work), 20).unwrap();
    let session = listed
        .sessions
        .iter()
        .find(|s| s.id == id)
        .expect("created session listed");
    assert_eq!(session.title, "BOA live test");
    assert_eq!(session.evidence, super::model::StateEvidence::BoaOwned);
    claude.rename(&id, &cwd, "BOA live test renamed").unwrap();
    assert!(wait_until(Duration::from_secs(60), || {
        claude.conversation(&id, &cwd, 10).is_ok_and(|entries| {
            entries
                .iter()
                .any(|e| e.role == super::model::ConversationRole::Agent)
        })
    }));
    claude
        .send(&id, &cwd, "Reply with the single word AGAIN.")
        .unwrap();
    let listed = claude.list(std::slice::from_ref(&work), 20).unwrap();
    assert!(
        listed
            .sessions
            .iter()
            .any(|s| s.id == id && s.title == "BOA live test renamed")
    );
    assert!(wait_until(Duration::from_secs(60), || {
        claude.conversation(&id, &cwd, 10).is_ok_and(|entries| {
            entries.iter().any(|e| {
                e.text.contains("AGAIN") && e.role == super::model::ConversationRole::Agent
            })
        })
    }));
}

#[test]
#[ignore = "creates real provider test sessions; see module docs"]
fn provider_live_claude_existing_session_keeps_its_id_through_a_fresh_bridge() {
    if !enabled("BOA_PROVIDER_TESTS") {
        return;
    }
    let tools = ToolPaths::discover();
    let work = PathBuf::from("/tmp/boa-cl-live-existing");
    git_repo(&work);
    let cwd = std::fs::canonicalize(&work)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let id = {
        let first = ClaudeProvider::new(
            tools.claude.clone(),
            tools.node.clone(),
            tools.child_path.clone(),
        );
        let (id, _) = first
            .create(
                &cwd,
                "BOA live test session. Reply with the single word FIRST.",
                None,
            )
            .unwrap();
        assert!(wait_until(Duration::from_secs(60), || {
            first.conversation(&id, &cwd, 10).is_ok_and(|entries| {
                entries
                    .iter()
                    .any(|e| e.role == super::model::ConversationRole::Agent)
            })
        }));
        id
        // `first` drops here: its bridge process ends, as after an app restart.
    };
    let fresh = ClaudeProvider::new(
        tools.claude.clone(),
        tools.node.clone(),
        tools.child_path.clone(),
    );
    let before = fresh
        .list(std::slice::from_ref(&work), 50)
        .unwrap()
        .sessions
        .len();
    let listed = fresh.list(std::slice::from_ref(&work), 50).unwrap();
    let existing = listed
        .sessions
        .iter()
        .find(|s| s.id == id)
        .expect("existing session listed");
    assert_eq!(
        existing.evidence,
        super::model::StateEvidence::ClaudeNoProcess
    );
    let receipt = fresh
        .send(&id, &cwd, "Reply with the single word SECOND.")
        .unwrap();
    assert_eq!(
        receipt,
        SendReceipt::Started {
            turn_id: Some(id.clone())
        },
        "same session id"
    );
    assert!(wait_until(Duration::from_secs(60), || {
        fresh.conversation(&id, &cwd, 10).is_ok_and(|entries| {
            entries.iter().any(|e| {
                e.role == super::model::ConversationRole::Agent && e.text.contains("SECOND")
            })
        })
    }));
    let after = fresh
        .list(std::slice::from_ref(&work), 50)
        .unwrap()
        .sessions
        .len();
    assert_eq!(after, before, "resuming created no new session");
}

/// Read-only history listing on the default Codex home, without starting the shared daemon:
/// `BOA_PROVIDER_TESTS=1 BOA_TEST_CODEX_HISTORY_CWD=<dir> [BOA_TEST_CODEX_HISTORY_ID=<thread>]
/// cargo test provider_live_codex_history -- --ignored`.
#[test]
#[ignore = "reads the real Codex history; see module docs"]
fn provider_live_codex_history_lists_quickly_without_daemon() {
    let Ok(cwd) = std::env::var("BOA_TEST_CODEX_HISTORY_CWD") else {
        return;
    };
    if !enabled("BOA_PROVIDER_TESTS") {
        return;
    }
    let tools = ToolPaths::discover();
    let codex = CodexProvider::new(
        tools.codex.clone(),
        tools.child_path.clone(),
        super::codex_rpc::default_codex_home(),
        false,
    );
    let started = Instant::now();
    let listing = codex.list(&[PathBuf::from(&cwd)], 200).unwrap();
    let elapsed = started.elapsed();
    eprintln!(
        "codex history: {} sessions in {:?} for {cwd}",
        listing.sessions.len(),
        elapsed
    );
    assert!(elapsed < Duration::from_secs(10), "{elapsed:?}");
    if let Ok(id) = std::env::var("BOA_TEST_CODEX_HISTORY_ID") {
        assert!(
            listing.sessions.iter().any(|s| s.id == id),
            "{id} not listed"
        );
    }
}
