//! Persistent pseudo-terminals owned by the BOA backend for coding sessions.
//!
//! A terminal survives view changes, dock collapse and window detachment: the UI only
//! attaches to it (snapshot + live output). One terminal per session at most; it is the
//! session's only BOA-side owner (Codex TUIs attach to the shared daemon instead).
use super::model::{SessionError, SessionKey, SessionResult};
use base64::Engine;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::{Read, Write},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

/// Interactive TUIs are few; four bounds memory and processes while covering parallel work.
const MAX_TERMINALS: usize = 4;
/// Scrollback replayed when a view (re)attaches: 256 KiB covers several screens of output.
const SCROLLBACK_BYTES: usize = 256 * 1024;
const MAX_INPUT: usize = 64 * 1024;

pub(crate) type OutputSink = Arc<dyn Fn(Value) + Send + Sync>;
/// Called once per terminal when its process has exited (explicit stop or spontaneous exit).
pub(crate) type ExitHook = Arc<dyn Fn(&SessionKey) + Send + Sync>;

/// What to run for a session: an absolute program, its arguments and working directory.
pub(crate) struct TerminalCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub path_env: String,
}

/// Output stream state. Snapshots and events are produced under this one lock, so every
/// byte has a stable offset: a snapshot ends at `total`, later events start at or after it.
#[derive(Default)]
struct Output {
    scrollback: VecDeque<u8>,
    /// Bytes produced since the terminal started (offset of the next byte).
    total: u64,
}

struct Terminal {
    key: SessionKey,
    master: Mutex<File>,
    child: Mutex<Child>,
    output: Mutex<Output>,
    exited: AtomicBool,
    /// The child (process-group leader) has been waited for; its pid may be reused.
    reaped: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalInfo {
    pub terminal_id: String,
    pub session: SessionKey,
    pub running: bool,
    /// Base64 scrollback so a newly attached view shows the current screen.
    pub snapshot: String,
    /// Stream offset just after the snapshot's last byte.
    pub snapshot_end: u64,
}

#[derive(Default)]
pub(crate) struct TerminalHost {
    terminals: Mutex<HashMap<String, Arc<Terminal>>>,
    sink: Mutex<Option<OutputSink>>,
    exit_hook: Mutex<Option<ExitHook>>,
}

fn lock<T>(mutex: &Mutex<T>) -> SessionResult<std::sync::MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| SessionError::new("state_poisoned", "terminal lock"))
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize {
        ws_row: rows.clamp(5, 500),
        ws_col: cols.clamp(20, 1000),
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

impl TerminalHost {
    pub(crate) fn set_sink(&self, sink: OutputSink) {
        if let Ok(mut current) = self.sink.lock() {
            *current = Some(sink);
        }
    }

    pub(crate) fn set_exit_hook(&self, hook: ExitHook) {
        if let Ok(mut current) = self.exit_hook.lock() {
            *current = Some(hook);
        }
    }

    /// Running terminals and their sessions (no output, no process details).
    pub(crate) fn running(&self) -> SessionResult<Vec<Value>> {
        let terminals = lock(&self.terminals)?;
        let mut running: Vec<Value> = terminals
            .iter()
            .filter(|(_, t)| !t.exited.load(Ordering::Relaxed))
            .map(|(id, t)| json!({"terminalId": id, "session": t.key}))
            .collect();
        running.sort_by(|a, b| a["terminalId"].as_str().cmp(&b["terminalId"].as_str()));
        Ok(running)
    }

    /// Running terminal for `key`, if any.
    pub(crate) fn running_for(&self, key: &SessionKey) -> Option<String> {
        let terminals = self.terminals.lock().ok()?;
        terminals
            .iter()
            .find(|(_, t)| &t.key == key && !t.exited.load(Ordering::Relaxed))
            .map(|(id, _)| id.clone())
    }

    fn info(id: &str, terminal: &Terminal) -> SessionResult<TerminalInfo> {
        let output = lock(&terminal.output)?;
        let bytes: Vec<u8> = output.scrollback.iter().copied().collect();
        Ok(TerminalInfo {
            terminal_id: id.to_string(),
            session: terminal.key.clone(),
            running: !terminal.exited.load(Ordering::Relaxed),
            snapshot: base64::engine::general_purpose::STANDARD.encode(bytes),
            snapshot_end: output.total,
        })
    }

    /// Attaches to the session's running terminal or starts `command` in a new PTY.
    pub(crate) fn open(
        &self,
        key: &SessionKey,
        command: impl FnOnce() -> SessionResult<TerminalCommand>,
        cols: u16,
        rows: u16,
    ) -> SessionResult<TerminalInfo> {
        let mut terminals = lock(&self.terminals)?;
        terminals.retain(|_, t| !t.exited.load(Ordering::Relaxed) || &t.key == key);
        if let Some((id, terminal)) = terminals
            .iter()
            .find(|(_, t)| &t.key == key && !t.exited.load(Ordering::Relaxed))
        {
            return Self::info(id, terminal);
        }
        terminals.retain(|_, t| &t.key != key);
        if terminals.len() >= MAX_TERMINALS {
            return Err(SessionError::new(
                "limit_reached",
                "too many open terminals",
            ));
        }
        let command = command()?;
        let (master, child) = spawn_pty(&command, cols, rows)?;
        let id = format!("term-{}-{}", key.id, super::store::now_ms());
        let terminal = Arc::new(Terminal {
            key: key.clone(),
            master: Mutex::new(master),
            child: Mutex::new(child),
            output: Mutex::new(Output::default()),
            exited: AtomicBool::new(false),
            reaped: AtomicBool::new(false),
        });
        // Partial initialization never leaks a process: any failure below stops the group.
        let reader = match lock(&terminal.master).and_then(|master| {
            master
                .try_clone()
                .map_err(|e| SessionError::new("terminal_failed", e.to_string()))
        }) {
            Ok(reader) => reader,
            Err(error) => {
                stop_group(&terminal);
                return Err(error);
            }
        };
        let sink = self.sink.lock().ok().and_then(|s| s.clone());
        let exit_hook = self.exit_hook.lock().ok().and_then(|h| h.clone());
        let thread_id = id.clone();
        let pumped = Arc::clone(&terminal);
        // Owned reader: forwards output until the child closes the PTY, then reaps it.
        if let Err(error) = thread::Builder::new()
            .name("boa-terminal".into())
            .spawn(move || pump(thread_id, pumped, reader, sink, exit_hook))
        {
            stop_group(&terminal);
            return Err(SessionError::new("terminal_failed", error.to_string()));
        }
        terminals.insert(id.clone(), Arc::clone(&terminal));
        let terminal = terminals
            .get(&id)
            .ok_or_else(|| SessionError::new("terminal_failed", "terminal vanished"))?;
        eprintln!(
            "{}",
            json!({"event": "terminal_opened", "provider": key.provider.as_str(), "sessionId": key.id})
        );
        Self::info(&id, terminal)
    }

    fn get(&self, id: &str) -> SessionResult<Arc<Terminal>> {
        lock(&self.terminals)?
            .get(id)
            .cloned()
            .ok_or_else(|| SessionError::new("terminal_not_found", id))
    }

    /// Writes user keystrokes (UTF-8) to the terminal.
    pub(crate) fn write(&self, id: &str, data: &str) -> SessionResult<()> {
        if data.len() > MAX_INPUT {
            return Err(SessionError::invalid("data", "input too large"));
        }
        let terminal = self.get(id)?;
        if terminal.exited.load(Ordering::Relaxed) {
            return Err(SessionError::new("terminal_exited", id));
        }
        let mut master = lock(&terminal.master)?;
        master
            .write_all(data.as_bytes())
            .and_then(|()| master.flush())
            .map_err(|e| SessionError::new("terminal_failed", e.to_string()))
    }

    pub(crate) fn resize(&self, id: &str, cols: u16, rows: u16) -> SessionResult<()> {
        let terminal = self.get(id)?;
        let master = lock(&terminal.master)?;
        let size = winsize(cols, rows);
        // SAFETY: valid open PTY master fd and a properly initialized winsize struct.
        let result = unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &size) };
        if result != 0 {
            return Err(SessionError::new("terminal_failed", "resize failed"));
        }
        Ok(())
    }

    /// Stops the terminal process (the provider keeps the session history).
    pub(crate) fn close(&self, id: &str) -> SessionResult<()> {
        let terminal = lock(&self.terminals)?
            .remove(id)
            .ok_or_else(|| SessionError::new("terminal_not_found", id))?;
        stop_group(&terminal);
        Ok(())
    }
}

impl Drop for TerminalHost {
    fn drop(&mut self) {
        if let Ok(terminals) = self.terminals.get_mut() {
            for terminal in terminals.values() {
                stop_group(terminal);
            }
        }
    }
}

/// Stops the terminal's own process group (the child is its session/group leader, so other
/// processes are never targeted): SIGHUP+SIGTERM, a short grace period, then SIGKILL, then reap.
/// The group is signalled only while the leader is unreaped, so its pid cannot have been reused.
fn stop_group(terminal: &Terminal) {
    let Ok(mut child) = terminal.child.lock() else {
        return;
    };
    if !terminal.reaped.load(Ordering::Relaxed) {
        let group = child.id() as libc::pid_t;
        // SAFETY: plain signal syscalls on our own unreaped child's process group.
        unsafe {
            libc::killpg(group, libc::SIGHUP);
            libc::killpg(group, libc::SIGTERM);
        }
        // Grace period for TUIs to restore the tty; 300 ms is enough for an orderly exit.
        thread::sleep(std::time::Duration::from_millis(300));
        // SAFETY: as above; the leader is still unreaped (zombie at worst).
        unsafe {
            libc::killpg(group, libc::SIGKILL);
        }
        let _ = child.wait();
        terminal.reaped.store(true, Ordering::Relaxed);
    }
    terminal.exited.store(true, Ordering::Relaxed);
}

fn emit(sink: &Option<OutputSink>, terminal: &Terminal, id: &str, mut payload: Value) {
    if let Some(sink) = sink {
        payload["terminalId"] = json!(id);
        payload["provider"] = json!(terminal.key.provider.as_str());
        payload["sessionId"] = json!(terminal.key.id);
        sink(payload);
    }
}

fn pump(
    id: String,
    terminal: Arc<Terminal>,
    mut reader: File,
    sink: Option<OutputSink>,
    exit_hook: Option<ExitHook>,
) {
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                let chunk = &buffer[..count];
                let Ok(mut output) = terminal.output.lock() else {
                    break;
                };
                let offset = output.total;
                output.scrollback.extend(chunk);
                let excess = output.scrollback.len().saturating_sub(SCROLLBACK_BYTES);
                output.scrollback.drain(..excess);
                output.total += count as u64;
                // Emitted while holding the lock: ordering matches snapshot offsets.
                emit(
                    &sink,
                    &terminal,
                    &id,
                    json!({"event": "output", "offset": offset,
                        "data": base64::engine::general_purpose::STANDARD.encode(chunk)}),
                );
            }
        }
    }
    if let Ok(mut child) = terminal.child.lock()
        && !terminal.reaped.load(Ordering::Relaxed)
    {
        let _ = child.wait();
        terminal.reaped.store(true, Ordering::Relaxed);
    }
    if let Ok(output) = terminal.output.lock() {
        terminal.exited.store(true, Ordering::Relaxed);
        emit(
            &sink,
            &terminal,
            &id,
            json!({"event": "exit", "end": output.total}),
        );
    }
    // After `exited` is set: listeners re-reading the catalog no longer see the terminal holder.
    if let Some(hook) = exit_hook {
        hook(&terminal.key);
    }
}

/// Opens a PTY pair and starts `command` as session leader with the PTY as controlling tty.
fn spawn_pty(command: &TerminalCommand, cols: u16, rows: u16) -> SessionResult<(File, Child)> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let size = winsize(cols, rows);
    // SAFETY: out-pointers are valid; termios is null (defaults) and winsize is initialized.
    let result = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &size as *const libc::winsize as *mut libc::winsize,
        )
    };
    if result != 0 {
        return Err(SessionError::new("terminal_failed", "openpty failed"));
    }
    // SAFETY: openpty returned two fresh descriptors that we now own exclusively.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    let stdio = |fd: &OwnedFd| -> SessionResult<Stdio> {
        fd.try_clone()
            .map(Stdio::from)
            .map_err(|e| SessionError::new("terminal_failed", e.to_string()))
    };
    let mut process = Command::new(&command.program);
    process
        .args(&command.args)
        .current_dir(&command.cwd)
        .env("PATH", &command.path_env)
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .stdin(stdio(&slave)?)
        .stdout(stdio(&slave)?)
        .stderr(stdio(&slave)?);
    // SAFETY: only async-signal-safe calls between fork and exec: new session, then adopt
    // stdin (the PTY slave) as controlling terminal so the TUI receives job-control signals.
    unsafe {
        process.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = process
        .spawn()
        .map_err(|e| SessionError::new("terminal_failed", e.to_string()))?;
    drop(slave);
    Ok((File::from(master), child))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::model::Provider;
    use std::time::{Duration, Instant};

    #[test]
    fn terminal_runs_a_real_pty_keeps_scrollback_reattaches_and_closes() {
        let host = TerminalHost::default();
        let key = SessionKey::new(Provider::Claude, "test-session").unwrap();
        let start = || {
            Ok(TerminalCommand {
                program: PathBuf::from("/bin/cat"),
                args: vec![],
                cwd: std::env::temp_dir(),
                path_env: "/usr/bin:/bin".into(),
            })
        };
        let first = host.open(&key, start, 80, 24).unwrap();
        let first_pid = host
            .get(&first.terminal_id)
            .unwrap()
            .child
            .lock()
            .unwrap()
            .id();
        host.write(&first.terminal_id, "hello-pty\n").unwrap();
        host.resize(&first.terminal_id, 100, 30).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = String::new();
        while Instant::now() < deadline && !seen.contains("hello-pty") {
            thread::sleep(Duration::from_millis(50));
            let again = host
                .open(
                    &key,
                    || Err(SessionError::new("unexpected", "must reattach")),
                    80,
                    24,
                )
                .unwrap();
            assert_eq!(
                again.terminal_id, first.terminal_id,
                "one terminal per session"
            );
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(again.snapshot)
                .unwrap();
            assert_eq!(
                again.snapshot_end,
                bytes.len() as u64,
                "offset counts every byte"
            );
            seen = String::from_utf8_lossy(&bytes).into_owned();
        }
        assert!(seen.contains("hello-pty"), "echo through the PTY: {seen:?}");
        assert_eq!(
            host.running_for(&key).as_deref(),
            Some(first.terminal_id.as_str())
        );
        host.close(&first.terminal_id).unwrap();
        assert!(host.running_for(&key).is_none());
        // The whole group is gone: a stopped terminal leaves no live process behind.
        let alive = Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", &first_pid.to_string()])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&alive.stdout).trim().is_empty()
                || String::from_utf8_lossy(&alive.stdout).contains('Z')
        );
        assert_eq!(
            host.write(&first.terminal_id, "x").unwrap_err().code,
            "terminal_not_found"
        );
    }

    #[test]
    fn running_lists_each_live_terminal_independently_and_forgets_stopped_ones() {
        let host = TerminalHost::default();
        let cat = || {
            Ok(TerminalCommand {
                program: PathBuf::from("/bin/cat"),
                args: vec![],
                cwd: std::env::temp_dir(),
                path_env: "/usr/bin:/bin".into(),
            })
        };
        let a = SessionKey::new(Provider::Claude, "run-a").unwrap();
        let b = SessionKey::new(Provider::Codex, "run-b").unwrap();
        let first = host.open(&a, cat, 80, 24).unwrap();
        let second = host.open(&b, cat, 80, 24).unwrap();
        assert_ne!(first.terminal_id, second.terminal_id);
        let sessions = |host: &TerminalHost| -> Vec<String> {
            host.running()
                .unwrap()
                .iter()
                .map(|t| t["session"]["id"].as_str().unwrap().to_string())
                .collect()
        };
        let mut both = sessions(&host);
        both.sort();
        assert_eq!(both, ["run-a", "run-b"]);
        host.close(&first.terminal_id).unwrap();
        assert_eq!(
            sessions(&host),
            ["run-b"],
            "stopping one PTY leaves the other running"
        );
        host.close(&second.terminal_id).unwrap();
        assert!(host.running().unwrap().is_empty());
    }

    #[test]
    fn snapshot_taken_during_output_reconciles_with_events_without_loss_or_duplicates() {
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let host = TerminalHost::default();
        let collected = Arc::clone(&events);
        host.set_sink(Arc::new(move |event| collected.lock().unwrap().push(event)));
        let key = SessionKey::new(Provider::Codex, "overlap").unwrap();
        let script = "i=0; while [ $i -lt 3000 ]; do echo line-$i; i=$((i+1)); done";
        let info = host
            .open(
                &key,
                || {
                    Ok(TerminalCommand {
                        program: PathBuf::from("/bin/sh"),
                        args: vec!["-c".into(), script.into()],
                        cwd: std::env::temp_dir(),
                        path_env: "/usr/bin:/bin".into(),
                    })
                },
                80,
                24,
            )
            .unwrap();
        // Re-attach while output is still streaming, like a view opening mid-turn.
        thread::sleep(Duration::from_millis(5));
        let middle = host
            .open(
                &key,
                || Err(SessionError::new("unexpected", "reattach")),
                80,
                24,
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline
            && !events.lock().unwrap().iter().any(|e| e["event"] == "exit")
        {
            thread::sleep(Duration::from_millis(20));
        }
        let decode = |text: &str| {
            base64::engine::general_purpose::STANDARD
                .decode(text)
                .unwrap()
        };
        let events = events.lock().unwrap().clone();
        let mut full = Vec::new();
        for event in events.iter().filter(|e| e["event"] == "output") {
            assert_eq!(
                event["offset"].as_u64().unwrap(),
                full.len() as u64,
                "contiguous offsets"
            );
            full.extend(decode(event["data"].as_str().unwrap()));
        }
        let exit = events
            .iter()
            .find(|e| e["event"] == "exit")
            .expect("exit event");
        assert_eq!(exit["end"].as_u64().unwrap(), full.len() as u64);
        assert_eq!(exit["sessionId"], "overlap");
        // Reconcile exactly like the UI: snapshot, then only bytes at or after its end.
        for snapshot in [&info, &middle] {
            let mut view = decode(&snapshot.snapshot);
            let start = snapshot.snapshot_end - view.len() as u64;
            for event in events.iter().filter(|e| e["event"] == "output") {
                let offset = event["offset"].as_u64().unwrap();
                let data = decode(event["data"].as_str().unwrap());
                let end = offset + data.len() as u64;
                if end > snapshot.snapshot_end {
                    let skip = snapshot.snapshot_end.saturating_sub(offset) as usize;
                    view.extend(&data[skip..]);
                }
            }
            assert_eq!(&full[start as usize..], &view[..]);
        }
        assert!(String::from_utf8_lossy(&full).contains("line-2999"));
    }
}
