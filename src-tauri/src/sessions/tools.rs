//! Resolves provider executables once at composition time (GUI apps lack a login-shell PATH).
use super::model::{SessionError, SessionResult};
use std::path::{Path, PathBuf};

/// Absolute executables used by provider adapters plus the PATH handed to their children.
#[derive(Debug, Clone, Default)]
pub(crate) struct ToolPaths {
    pub codex: Option<PathBuf>,
    pub claude: Option<PathBuf>,
    pub node: Option<PathBuf>,
    /// Minimal PATH: directories of resolved tools then system directories.
    pub child_path: String,
}

const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Search order: explicit `BOA_<TOOL>_BIN` override, user/Homebrew install dirs, then `PATH`.
/// Known directories come first so editor/terminal shims earlier in PATH are not preferred.
fn find(
    name: &str,
    override_var: &str,
    home: Option<&Path>,
    path_var: Option<&str>,
) -> Option<PathBuf> {
    if let Some(value) = std::env::var_os(override_var) {
        let path = PathBuf::from(value);
        return executable(&path).then_some(path);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = home {
        candidates.push(home.join(".local/bin").join(name));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin").join(name));
    candidates.push(PathBuf::from("/usr/local/bin").join(name));
    if let Some(path_var) = path_var {
        candidates.extend(
            path_var
                .split(':')
                .filter(|dir| !dir.is_empty())
                .map(|dir| PathBuf::from(dir).join(name)),
        );
    }
    candidates
        .into_iter()
        .find(|candidate| executable(candidate))
}

impl ToolPaths {
    /// Resolves the tools from the current process environment.
    pub(crate) fn discover() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let path_var = std::env::var("PATH").ok();
        let codex = find(
            "codex",
            "BOA_CODEX_BIN",
            home.as_deref(),
            path_var.as_deref(),
        );
        let claude = find(
            "claude",
            "BOA_CLAUDE_BIN",
            home.as_deref(),
            path_var.as_deref(),
        );
        let node = find("node", "BOA_NODE_BIN", home.as_deref(), path_var.as_deref());
        let mut dirs: Vec<String> = Vec::new();
        for tool in [&codex, &claude, &node].into_iter().flatten() {
            if let Some(dir) = tool.parent().and_then(Path::to_str)
                && !dirs.iter().any(|d| d == dir)
            {
                dirs.push(dir.to_string());
            }
        }
        dirs.push(SYSTEM_PATH.to_string());
        Self {
            codex,
            claude,
            node,
            child_path: dirs.join(":"),
        }
    }
}

/// Captured result of a bounded command.
pub(crate) struct BoundedOutput {
    pub success: bool,
    pub stdout: Vec<u8>,
    /// Last 400 characters of stderr, enough for a diagnostic without dumping content.
    pub stderr_tail: String,
}

/// Runs a command without shell, stdin closed, pipes drained concurrently (12 MB cap each),
/// killed and reaped when `timeout` elapses.
pub(crate) fn run_bounded(
    command: &mut std::process::Command,
    timeout: std::time::Duration,
) -> SessionResult<BoundedOutput> {
    use std::process::Stdio;
    use wait_timeout::ChildExt;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| SessionError::new("tool_unavailable", e.to_string()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out = std::thread::spawn(move || stdout.map(crate::git::read_bounded));
    let err = std::thread::spawn(move || stderr.map(crate::git::read_bounded));
    let status = match child.wait_timeout(timeout).map_err(SessionError::io)? {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SessionError::new("timeout", "command timed out"));
        }
    };
    let collect = |handle: std::thread::JoinHandle<Option<Result<Vec<u8>, String>>>| {
        handle
            .join()
            .ok()
            .flatten()
            .and_then(Result::ok)
            .unwrap_or_default()
    };
    let stdout = collect(out);
    let stderr = String::from_utf8_lossy(&collect(err)).trim().to_string();
    let skip = stderr.chars().count().saturating_sub(400);
    Ok(BoundedOutput {
        success: status.success(),
        stdout,
        stderr_tail: stderr.chars().skip(skip).collect(),
    })
}
