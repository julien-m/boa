//! Native notifications, grouped before invalidating only affected projects.
use crate::projects::AppState;
use notify::{
    Event, EventKind, RecursiveMode, Watcher,
    event::{CreateKind, ModifyKind, RemoveKind},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock, mpsc},
    thread,
    time::{Duration, Instant},
};

pub(crate) enum Message {
    Configure,
    Stop,
}

#[derive(Clone, Default, Serialize)]
pub(crate) struct Update {
    pub discovery: bool,
    pub settings: bool,
    pub projects: BTreeSet<String>,
    #[serde(skip)]
    rescan: BTreeSet<String>,
}

#[derive(Clone, Default)]
struct Targets {
    discovery: Option<PathBuf>,
    discovery_identity: Option<(u64, u64)>,
    known_directories: BTreeSet<PathBuf>,
    directory_identities: BTreeMap<PathBuf, Option<(u64, u64)>>,
    projects: BTreeMap<String, Vec<(PathBuf, bool)>>,
}

fn directory_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = path.metadata().ok()?;
    metadata.is_dir().then(|| (metadata.dev(), metadata.ino()))
}

fn targets(state: &AppState) -> Targets {
    let config = state
        .config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    // Never hold the shared cache lock across filesystem I/O.
    let cache = state
        .repo_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mut result = Targets {
        discovery: config.watch_directory.map(PathBuf::from),
        ..Targets::default()
    };
    result.discovery_identity = result.discovery.as_deref().and_then(directory_identity);
    result.known_directories.extend(
        config
            .projects
            .iter()
            .map(|project| PathBuf::from(&project.path)),
    );
    result.directory_identities = result
        .known_directories
        .iter()
        .map(|path| (path.clone(), directory_identity(path)))
        .collect();
    for project in config.projects.iter().filter(|project| !project.archived) {
        let root = PathBuf::from(&project.path);
        let mut roots = vec![(root.clone(), false)];
        if let Some(snapshot) = cache.get(&root) {
            roots.extend(snapshot.repos.iter().cloned().map(|path| (path, false)));
            roots.extend(snapshot.metadata.iter().cloned().map(|path| (path, true)));
        }
        result.projects.insert(project.path.clone(), roots);
    }
    result
}

fn desired_paths(targets: &Targets) -> BTreeMap<PathBuf, bool> {
    let mut desired = BTreeMap::new();
    for path in targets.discovery.iter() {
        desired.entry(path.clone()).or_insert(false);
        if let Some(parent) = path.parent() {
            desired.entry(parent.to_path_buf()).or_insert(false);
        }
    }
    for roots in targets.projects.values() {
        for (path, _) in roots {
            desired.insert(path.clone(), true);
            if let Some(parent) = path.parent() {
                desired.entry(parent.to_path_buf()).or_insert(false);
            }
        }
    }
    desired
}

fn configure(
    watcher: &mut impl Watcher,
    watched: &mut BTreeMap<PathBuf, bool>,
    targets: &Targets,
) -> Option<String> {
    let desired = desired_paths(targets);
    let mut error = None;
    for (path, recursive) in watched.clone() {
        if desired.get(&path) != Some(&recursive) || !path.exists() {
            let _ = watcher.unwatch(&path);
            watched.remove(&path);
        }
    }
    for (path, recursive) in desired {
        if !path.exists() {
            error = Some(format!(
                "Surveillance indisponible : {} : {}",
                path.display(),
                std::io::Error::from(std::io::ErrorKind::NotFound)
            ));
            continue;
        }
        if watched.get(&path) == Some(&recursive) {
            continue;
        }
        match watcher.watch(
            &path,
            if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            },
        ) {
            Ok(()) => {
                watched.insert(path, recursive);
            }
            Err(reason) => {
                error = Some(format!(
                    "Surveillance indisponible : {} : {reason}",
                    path.display()
                ))
            }
        }
    }
    error
}

fn relevant_file(root: &Path, metadata: bool, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let parts: Vec<_> = relative.iter().map(|part| part.to_string_lossy()).collect();
    if parts.iter().any(|part| {
        matches!(
            part.as_ref(),
            "node_modules"
                | "target"
                | ".cache"
                | ".venv"
                | "__pycache__"
                | "uv-cache"
                | ".uv-cache"
                | ".next"
                | ".turbo"
                | ".pytest_cache"
                | ".mypy_cache"
                | ".ruff_cache"
        )
    }) {
        return false;
    }
    let git = if metadata {
        Some(parts.as_slice())
    } else {
        parts
            .iter()
            .position(|part| part == ".git")
            .map(|index| &parts[index + 1..])
    };
    if let Some(git) = git {
        if git
            .first()
            .is_some_and(|part| matches!(part.as_ref(), "objects" | "logs"))
        {
            return false;
        }
        if git
            .last()
            .is_some_and(|part| part.ends_with(".lock") || part == "COMMIT_EDITMSG")
        {
            return false;
        }
    }
    true
}

fn configure_state(
    state: &AppState,
    watcher: &mut impl Watcher,
    watched: &mut BTreeMap<PathBuf, bool>,
    current: &mut Targets,
    routing: &RwLock<Targets>,
) -> Update {
    let next = targets(state);
    let desired = desired_paths(&next);
    let root_changed = current.discovery != next.discovery;
    let identity_changed = current.discovery_identity != next.discovery_identity;
    if !root_changed
        && identity_changed
        && let Some(root) = &next.discovery
    {
        // Rebind descendant watches too if replacement happened between notifications.
        for path in watched
            .keys()
            .filter(|path| path.starts_with(root))
            .cloned()
            .collect::<Vec<_>>()
        {
            let _ = watcher.unwatch(&path);
            watched.remove(&path);
        }
    }
    for (path, identity) in &next.directory_identities {
        if current
            .directory_identities
            .get(path)
            .is_some_and(|previous| previous != identity)
        {
            for watched_path in watched
                .keys()
                .filter(|watched_path| watched_path.starts_with(path))
                .cloned()
                .collect::<Vec<_>>()
            {
                let _ = watcher.unwatch(&watched_path);
                watched.remove(&watched_path);
            }
        }
    }
    let watch_changed = next
        .discovery
        .as_ref()
        .is_some_and(|root| watched.get(root) != desired.get(root));
    *current = next;
    // watch() may immediately deliver an event on the callback thread.
    *routing.write().unwrap_or_else(|e| e.into_inner()) = current.clone();
    let mut update = Update {
        settings: state.set_watch_service_error(configure(watcher, watched, current)),
        ..Update::default()
    };
    let discovery = current.discovery.as_ref().is_some_and(|root| {
        root_changed
            || (watch_changed || identity_changed) && watched.get(root) == desired.get(root)
    });
    if discovery {
        // Scan after installing the root watch: subsequent creations now produce events.
        let _ = state.list_projects();
        *current = targets(state);
        *routing.write().unwrap_or_else(|e| e.into_inner()) = current.clone();
        update.settings |= state.set_watch_service_error(configure(watcher, watched, current));
        update.discovery = true;
    }
    update
}

fn classify(event: &Event, targets: &Targets, update: &mut Update) {
    if matches!(event.kind, EventKind::Access(_)) {
        return;
    }
    if event.need_rescan() {
        update.discovery |= targets.discovery.is_some();
        update.projects.extend(targets.projects.keys().cloned());
        update.rescan.extend(targets.projects.keys().cloned());
        return;
    }
    for path in &event.paths {
        if let Some(root) = &targets.discovery {
            let child = path.parent() == Some(root.as_path());
            let child_lifecycle = child
                && targets
                    .directory_identities
                    .get(path)
                    .is_some_and(|previous| *previous != directory_identity(path));
            if child_lifecycle
                && targets
                    .projects
                    .contains_key(&path.to_string_lossy().into_owned())
            {
                let project = path.to_string_lossy().into_owned();
                update.projects.insert(project.clone());
                update.rescan.insert(project);
            }
            let directory_event = matches!(
                event.kind,
                EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder)
            ) || path.is_dir()
                && matches!(event.kind, EventKind::Create(_) | EventKind::Remove(_));
            let directory_event = directory_event
                || matches!(event.kind, EventKind::Modify(ModifyKind::Name(_)))
                    && (path.is_dir() || targets.known_directories.contains(path));
            let directory_event = directory_event
                || matches!(event.kind, EventKind::Any)
                    && ((path.is_dir() && !targets.known_directories.contains(path))
                        || child_lifecycle);
            let root_lifecycle = path == root
                && (matches!(
                    event.kind,
                    EventKind::Create(_)
                        | EventKind::Remove(_)
                        | EventKind::Modify(ModifyKind::Name(_))
                ) || matches!(event.kind, EventKind::Any)
                    && directory_identity(root) != targets.discovery_identity);
            if root_lifecycle {
                for project in targets
                    .projects
                    .keys()
                    .filter(|project| Path::new(project).starts_with(root))
                {
                    update.projects.insert(project.clone());
                    update.rescan.insert(project.clone());
                }
            }
            update.discovery |= root_lifecycle || child && directory_event;
        }
        for (project, roots) in &targets.projects {
            if roots.iter().any(|(root, metadata)| {
                relevant_file(root, *metadata, path)
                    && !(path.is_dir()
                        && matches!(
                            event.kind,
                            EventKind::Modify(ModifyKind::Metadata(_))
                                | EventKind::Modify(ModifyKind::Data(_))
                                | EventKind::Any
                        ))
            }) {
                update.projects.insert(project.clone());
                if matches!(
                    event.kind,
                    EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder)
                ) || path.file_name().is_some_and(|name| name == ".git")
                    || matches!(event.kind, EventKind::Modify(ModifyKind::Name(_)))
                        && (path.is_dir() || roots.iter().any(|(root, _)| root.starts_with(path)))
                    || path
                        .components()
                        .any(|part| part.as_os_str() == "worktrees")
                {
                    update.rescan.insert(project.clone());
                }
            }
        }
    }
}

// Only one wake-up is queued. Events merge into sets of registered projects,
// so a producer cannot allocate an unbounded queue of paths while Git is busy.
#[derive(Default)]
struct Pending {
    update: Update,
    error: Option<String>,
    configure: bool,
    stop: bool,
}

#[derive(Clone)]
pub(crate) struct Control {
    pending: Arc<Mutex<Pending>>,
    wake: mpsc::SyncSender<()>,
}
impl Control {
    fn event(&self, event: notify::Result<Event>, targets: &Targets) {
        let mut update = Update::default();
        let error = match event {
            Ok(event) => {
                classify(&event, targets, &mut update);
                None
            }
            Err(error) => Some(format!("Surveillance indisponible : {error}")),
        };
        if !update.changed() && error.is_none() {
            return;
        }
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.update.merge(update);
        if error.is_some() {
            pending.error = error;
        }
        drop(pending);
        let _ = self.wake.try_send(());
    }

    pub fn send(&self, message: Message) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        match message {
            Message::Configure => pending.configure = true,
            Message::Stop => pending.stop = true,
        }
        drop(pending);
        let _ = self.wake.try_send(());
    }
}

impl Update {
    fn changed(&self) -> bool {
        self.discovery || self.settings || !self.projects.is_empty()
    }
    fn merge(&mut self, other: Self) {
        self.discovery |= other.discovery;
        self.settings |= other.settings;
        self.projects.extend(other.projects);
        self.rescan.extend(other.rescan);
    }
}

const GROUP_WINDOW: Duration = Duration::from_millis(750);
const REFRESH_INTERVAL: Duration = Duration::from_secs(3);

// A fixed deadline ensures the last event is delivered even if writes never stop.
fn refresh_deadline(now: Instant, last_emit: Option<Instant>) -> Instant {
    let grouped = now + GROUP_WINDOW;
    last_emit.map_or(grouped, |last| grouped.max(last + REFRESH_INTERVAL))
}

pub(crate) struct Service {
    control: Control,
    thread: Option<thread::JoinHandle<()>>,
}
impl Drop for Service {
    fn drop(&mut self) {
        self.control.send(Message::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub(crate) fn start(
    state: Arc<AppState>,
    emit: impl Fn(Update) + Send + 'static,
) -> Result<Service, String> {
    let (wake, receiver) = mpsc::sync_channel(1);
    let control = Control {
        pending: Arc::new(Mutex::new(Pending::default())),
        wake,
    };
    let pending_events = control.clone();
    let routing = Arc::new(RwLock::new(Targets::default()));
    let event_targets = routing.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        pending_events.event(
            event,
            &event_targets.read().unwrap_or_else(|e| e.into_inner()),
        );
    })
    .map_err(|e| e.to_string())?;
    let _ = state.list_projects()?;
    let mut current = Targets::default();
    let mut watched = BTreeMap::new();
    let initial = configure_state(&state, &mut watcher, &mut watched, &mut current, &routing);
    if initial.changed() {
        emit(initial);
    }
    *state.watch_control.lock().map_err(|e| e.to_string())? = Some(control.clone());
    let worker = control.clone();
    let thread = thread::spawn(move || {
        let mut update = Update::default();
        let mut deadline: Option<Instant> = None;
        let mut last_emit = None;
        loop {
            let received = match deadline {
                Some(end) => receiver.recv_timeout(end.saturating_duration_since(Instant::now())),
                None => receiver
                    .recv()
                    .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
            };
            if matches!(received, Err(mpsc::RecvTimeoutError::Disconnected)) {
                break;
            }
            let pending =
                std::mem::take(&mut *worker.pending.lock().unwrap_or_else(|e| e.into_inner()));
            if pending.stop {
                break;
            }
            update.merge(pending.update);
            if let Some(error) = pending.error {
                update.settings |= state.set_watch_service_error(Some(error));
            }
            if pending.configure {
                let mut next = routing.read().unwrap_or_else(|e| e.into_inner()).clone();
                update.merge(configure_state(
                    &state,
                    &mut watcher,
                    &mut watched,
                    &mut next,
                    &routing,
                ));
            }
            if update.changed() && deadline.is_none() {
                deadline = Some(refresh_deadline(Instant::now(), last_emit));
            }
            if deadline.is_some_and(|end| Instant::now() >= end) {
                if update.discovery {
                    let _ = state.list_projects();
                    let mut next = routing.read().unwrap_or_else(|e| e.into_inner()).clone();
                    update.merge(configure_state(
                        &state,
                        &mut watcher,
                        &mut watched,
                        &mut next,
                        &routing,
                    ));
                }
                if !update.rescan.is_empty() {
                    for project in &update.rescan {
                        state.invalidate_repositories(Path::new(project));
                    }
                }
                if update.changed() {
                    emit(std::mem::take(&mut update));
                    last_emit = Some(Instant::now());
                }
                deadline = None;
            }
        }
    });
    Ok(Service {
        control,
        thread: Some(thread),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, DataChange, RenameMode};

    #[test]
    fn event_storm_keeps_one_wakeup_and_one_project_without_postponing_deadlines() {
        let (wake, receiver) = mpsc::sync_channel(1);
        let control = Control {
            pending: Arc::new(Mutex::new(Pending::default())),
            wake,
        };
        let root = PathBuf::from("/projects/app");
        let targets = Targets {
            projects: BTreeMap::from([("/projects/app".into(), vec![(root.clone(), false)])]),
            ..Targets::default()
        };
        for index in 0..10_000 {
            control.event(
                Ok(Event::new(EventKind::Create(CreateKind::File))
                    .add_path(root.join(format!("source-{index}.ts")))),
                &targets,
            );
        }
        assert_eq!(control.pending.lock().unwrap().update.projects.len(), 1);
        assert!(receiver.try_recv().is_ok());
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        control.event(
            Ok(Event::new(EventKind::Create(CreateKind::File))
                .add_path(root.join("node_modules/ignored.js"))),
            &targets,
        );
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        control.send(Message::Configure);
        control.send(Message::Stop);
        let pending = control.pending.lock().unwrap();
        assert!(pending.stop && pending.configure); // Control messages survive a full wake queue.
        let now = Instant::now();
        assert_eq!(refresh_deadline(now, None), now + GROUP_WINDOW);
        assert_eq!(refresh_deadline(now, Some(now)), now + REFRESH_INTERVAL);
    }

    #[test]
    fn routing_is_visible_to_events_during_watch_registration() {
        struct EarlyWatcher {
            root: PathBuf,
            routing: Arc<RwLock<Targets>>,
            control: Control,
        }
        impl Watcher for EarlyWatcher {
            fn new<F: notify::EventHandler>(_: F, _: notify::Config) -> notify::Result<Self> {
                unreachable!()
            }
            fn watch(&mut self, path: &Path, _: RecursiveMode) -> notify::Result<()> {
                if path == self.root {
                    self.control.event(
                        Ok(Event::new(EventKind::Create(CreateKind::File))
                            .add_path(self.root.join("raced.ts"))),
                        &self.routing.read().unwrap(),
                    );
                }
                Ok(())
            }
            fn unwatch(&mut self, _: &Path) -> notify::Result<()> {
                Ok(())
            }
            fn kind() -> notify::WatcherKind {
                notify::WatcherKind::NullWatcher
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("app");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let state = AppState::new(temp.path().join("config.json")).unwrap();
        state.add_project(&root).unwrap();
        let routing = Arc::new(RwLock::new(Targets::default()));
        let (wake, _) = mpsc::sync_channel(1);
        let control = Control {
            pending: Arc::new(Mutex::new(Pending::default())),
            wake,
        };
        let mut watcher = EarlyWatcher {
            root: root.clone(),
            routing: routing.clone(),
            control: control.clone(),
        };
        configure_state(
            &state,
            &mut watcher,
            &mut BTreeMap::new(),
            &mut Targets::default(),
            &routing,
        );
        assert!(
            control
                .pending
                .lock()
                .unwrap()
                .update
                .projects
                .contains(root.to_str().unwrap()),
            "an event delivered during watch registration must not be lost"
        );
    }

    #[test]
    fn special_git_metadata_cannot_block_target_configuration() {
        use std::{
            ffi::CString,
            io::Write,
            os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("app");
        std::fs::create_dir(&root).unwrap();
        let state = Arc::new(AppState::new(temp.path().join("config.json")).unwrap());
        state.add_project(&root).unwrap();
        let fifo = root.join(".git");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        // Keep a writer present so the old blocking reader can be rescued after measurement.
        let mut rescue = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&fifo)
            .unwrap();
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = targets(&state);
            sender.send(()).unwrap();
        });
        let completed = receiver.recv_timeout(Duration::from_millis(250)).is_ok();
        rescue.write_all(b"not a git directory").unwrap();
        drop(rescue);
        worker.join().unwrap();
        assert!(
            completed,
            "a FIFO Git metadata entry must not block the watcher"
        );
    }

    #[test]
    fn ambiguous_discovery_root_recreation_reinstalls_watching_and_clears_the_warning() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("projects");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let state = AppState::new(temp.path().join("config.json")).unwrap();
        state.set_watch_directory(Some(&root)).unwrap();
        let mut watcher = notify::recommended_watcher(|_| {}).unwrap();
        let mut watched = BTreeMap::new();
        let mut current = Targets::default();
        let routing = RwLock::new(Targets::default());
        configure_state(&state, &mut watcher, &mut watched, &mut current, &routing);
        std::fs::remove_dir(&root).unwrap();
        let _ = state.list_projects();
        configure_state(&state, &mut watcher, &mut watched, &mut current, &routing);
        assert!(state.settings().unwrap().watch_error.is_some());
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("new-project")).unwrap();
        let mut update = Update::default();
        classify(
            &Event::new(EventKind::Any).add_path(root.clone()),
            &current,
            &mut update,
        );
        assert!(
            update.discovery,
            "an ambiguously recreated root must be reconciled"
        );
        let update = configure_state(&state, &mut watcher, &mut watched, &mut current, &routing);
        assert!(update.discovery);
        assert_eq!(watched.get(&root), Some(&false));
        assert!(state.settings().unwrap().watch_error.is_none());
        assert!(
            state
                .config
                .lock()
                .unwrap()
                .projects
                .iter()
                .any(|p| p.name == "new-project")
        );
    }

    #[test]
    fn ambiguous_known_child_recreation_reinstalls_its_recursive_watch() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let child = root.join("app");
        std::fs::create_dir(&child).unwrap();
        let state = AppState::new(root.join("config.json")).unwrap();
        state.set_watch_directory(Some(&root)).unwrap();
        let mut watcher = notify::recommended_watcher(|_| {}).unwrap();
        let mut watched = BTreeMap::new();
        let mut current = Targets::default();
        let routing = RwLock::new(Targets::default());
        configure_state(&state, &mut watcher, &mut watched, &mut current, &routing);
        std::fs::remove_dir(&child).unwrap();
        let mut removed = Update::default();
        classify(
            &Event::new(EventKind::Any).add_path(child.clone()),
            &current,
            &mut removed,
        );
        assert!(removed.discovery);
        configure_state(&state, &mut watcher, &mut watched, &mut current, &routing);
        assert!(!watched.contains_key(&child));
        std::fs::create_dir(&child).unwrap();
        let mut recreated = Update::default();
        classify(
            &Event::new(EventKind::Any).add_path(child.clone()),
            &current,
            &mut recreated,
        );
        assert!(
            recreated.discovery,
            "a known child must be rediscovered after recreation"
        );
        assert!(
            recreated
                .rescan
                .contains(&child.to_string_lossy().into_owned())
        );
        configure_state(&state, &mut watcher, &mut watched, &mut current, &routing);
        assert_eq!(watched.get(&child), Some(&true));
        let mut written = Update::default();
        classify(
            &Event::new(EventKind::Any).add_path(child.join("new.ts")),
            &current,
            &mut written,
        );
        assert!(
            written
                .projects
                .contains(&child.to_string_lossy().into_owned())
        );
    }

    #[test]
    fn target_configuration_uses_cached_metadata_instead_of_opening_git_pointer_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("app");
        let trusted = temp.path().join("cached-admin");
        let unverified = temp.path().join("unverified-admin");
        for path in [&root, &trusted, &unverified] {
            std::fs::create_dir(path).unwrap();
        }
        let root = root.canonicalize().unwrap();
        let trusted = trusted.canonicalize().unwrap();
        let unverified = unverified.canonicalize().unwrap();
        std::fs::write(
            root.join(".git"),
            format!("gitdir: {}", unverified.display()),
        )
        .unwrap();
        let state = AppState::new(temp.path().join("config.json")).unwrap();
        let project = state.add_project(&root).unwrap();
        state.repo_cache.lock().unwrap().insert(
            root.clone(),
            crate::projects::RepositorySnapshot {
                captured_at: Instant::now(),
                repos: vec![root.clone()],
                limited: false,
                metadata: vec![trusted.clone()],
            },
        );
        let targets = targets(&state);
        let roots = targets.projects.get(&project.path).unwrap();
        assert!(
            roots.contains(&(trusted, true)),
            "use metadata resolved by bounded Git commands"
        );
        assert!(
            !roots.iter().any(|(path, _)| path == &unverified),
            "do not open or parse pointer files on the watch thread"
        );
    }

    #[test]
    fn configuring_discovery_reconciles_folders_created_after_the_initial_scan() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("projects");
        std::fs::create_dir(&root).unwrap();
        let state = AppState::new(temp.path().join("config.json")).unwrap();
        let mut watcher = notify::recommended_watcher(|_| {}).unwrap();
        let mut watched = BTreeMap::new();
        let mut current = Targets::default();
        let routing = RwLock::new(Targets::default());
        configure_state(&state, &mut watcher, &mut watched, &mut current, &routing);
        // Reproduce the gap: the preference scan finished, but Configure has not run.
        state.set_watch_directory(Some(&root)).unwrap();
        std::fs::create_dir(root.join("late-project")).unwrap();
        let update = configure_state(&state, &mut watcher, &mut watched, &mut current, &routing);
        assert!(
            state
                .config
                .lock()
                .unwrap()
                .projects
                .iter()
                .any(|p| p.name == "late-project")
        );
        assert!(update.discovery);
        // Repeated Configure messages must not trigger a reconciliation loop.
        assert!(
            !configure_state(&state, &mut watcher, &mut watched, &mut current, &routing).discovery
        );
    }

    #[test]
    fn routes_only_direct_directories_and_relevant_project_writes() {
        let root = PathBuf::from("/projects");
        let project = root.join("app");
        let targets = Targets {
            discovery: Some(root.clone()),
            discovery_identity: directory_identity(&root),
            known_directories: BTreeSet::from([project.clone()]),
            directory_identities: BTreeMap::from([(project.clone(), directory_identity(&project))]),
            projects: BTreeMap::from([(
                project.to_string_lossy().into_owned(),
                vec![
                    (project.clone(), false),
                    (PathBuf::from("/external/gitdir"), true),
                ],
            )]),
        };
        for (kind, path, discovery, dirty) in [
            (
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                root.clone(),
                false,
                false,
            ),
            (
                EventKind::Create(CreateKind::Folder),
                root.join("new"),
                true,
                false,
            ),
            (
                EventKind::Create(CreateKind::Folder),
                project.join("nested"),
                false,
                true,
            ),
            (
                EventKind::Create(CreateKind::File),
                root.join("note.md"),
                false,
                false,
            ),
            (
                EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                root.join("note.md"),
                false,
                false,
            ),
            (
                EventKind::Modify(ModifyKind::Name(RenameMode::From)),
                project.clone(),
                true,
                true,
            ),
            (
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                project.join("src/file.ts"),
                false,
                true,
            ),
            (
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                project.join("src/build/config.ts"),
                false,
                true,
            ),
            (
                EventKind::Access(AccessKind::Read),
                project.join("src/file.ts"),
                false,
                false,
            ),
            (
                EventKind::Create(CreateKind::File),
                project.join("node_modules/package/file.js"),
                false,
                false,
            ),
            (
                EventKind::Create(CreateKind::File),
                project.join(".git/index.lock"),
                false,
                false,
            ),
            (
                EventKind::Create(CreateKind::File),
                project.join(".git/objects/ab/hash"),
                false,
                false,
            ),
            (
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                project.join(".git/refs/heads/main"),
                false,
                true,
            ),
            (
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                PathBuf::from("/external/gitdir/HEAD"),
                false,
                true,
            ),
        ] {
            let mut update = Update::default();
            classify(
                &Event::new(kind).add_path(path.clone()),
                &targets,
                &mut update,
            );
            assert_eq!(update.discovery, discovery, "{path:?}");
            assert_eq!(!update.projects.is_empty(), dirty, "{path:?}");
        }
    }

    #[test]
    fn directory_metadata_and_build_output_do_not_refresh_projects() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let project = root.join("app");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        let targets = Targets {
            discovery: Some(root.to_path_buf()),
            discovery_identity: directory_identity(root),
            known_directories: BTreeSet::from([project.clone()]),
            directory_identities: BTreeMap::from([(project.clone(), directory_identity(&project))]),
            projects: BTreeMap::from([(
                project.to_string_lossy().into_owned(),
                vec![(project.clone(), false)],
            )]),
        };
        for path in [
            root.to_path_buf(),
            project.clone(),
            project.join(".git"),
            project.join("target/bundle.js"),
        ] {
            let mut update = Update::default();
            classify(
                &Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)))
                    .add_path(path.clone()),
                &targets,
                &mut update,
            );
            assert!(!update.changed(), "{path:?}");
            classify(
                &Event::new(EventKind::Any).add_path(path.clone()),
                &targets,
                &mut update,
            );
            assert!(
                !update.changed(),
                "ambiguous directory notification: {path:?}"
            );
        }
        std::fs::remove_dir(project.join(".git")).unwrap();
        std::fs::remove_dir(&project).unwrap();
        std::fs::remove_dir(root).unwrap();
        let mut update = Update::default();
        classify(
            &Event::new(EventKind::Any).add_path(root.to_path_buf()),
            &targets,
            &mut update,
        );
        assert!(
            update.discovery,
            "a missing discovery root must be reconciled"
        );
        assert!(update.projects.contains(project.to_str().unwrap()));
        assert!(update.rescan.contains(project.to_str().unwrap()));
    }

    #[test]
    fn renaming_a_cached_nested_repository_requires_rediscovery() {
        let project = PathBuf::from("/projects/app");
        let nested = project.join("nested-repo");
        let targets = Targets {
            projects: BTreeMap::from([(
                project.to_string_lossy().into_owned(),
                vec![(project.clone(), false), (nested.clone(), false)],
            )]),
            ..Targets::default()
        };
        let mut update = Update::default();
        classify(
            &Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any))).add_path(nested),
            &targets,
            &mut update,
        );
        assert!(update.rescan.contains(project.to_str().unwrap()));
    }

    // Native integration, bounded to 8 seconds including both event waits.
    #[test]
    fn native_events_discover_folders_and_group_writes_without_polling() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("projects");
        let project = root.join("app");
        std::fs::create_dir_all(&project).unwrap();
        let state = Arc::new(AppState::new(temp.path().join("config.json")).unwrap());
        state.set_watch_directory(Some(&root)).unwrap();
        let project = project
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let (sender, receiver) = mpsc::channel();
        let service = start(state.clone(), move |update| {
            let _ = sender.send(update);
        })
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        std::fs::create_dir(root.join("new-project")).unwrap();
        for index in 0..8 {
            std::fs::write(
                Path::new(&project).join(format!("file-{index}.ts")),
                "changed",
            )
            .unwrap();
        }
        let mut discovery = false;
        let mut dirty = false;
        while !(discovery && dirty) {
            let update = receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            discovery |= update.discovery;
            dirty |= update.projects.contains(&project);
        }
        assert!(
            state
                .config
                .lock()
                .unwrap()
                .projects
                .iter()
                .any(|project| project.name == "new-project")
        );
        let first = Instant::now();
        std::fs::write(Path::new(&project).join("final.ts"), "last write").unwrap();
        loop {
            let update = receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if update.projects.contains(&project) {
                break;
            }
        }
        assert!(first.elapsed() >= Duration::from_millis(2_900));
        state.archive_project(&project, true).unwrap();
        let current = targets(&state);
        assert!(!current.projects.contains_key(&project));
        state.set_watch_directory(None).unwrap();
        assert!(targets(&state).discovery.is_none());
        drop(service);
    }
}
