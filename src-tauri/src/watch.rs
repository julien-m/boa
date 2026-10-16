//! Native notifications, grouped before invalidating only affected projects.
use crate::projects::AppState;
use notify::{
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
    event::{CreateKind, ModifyKind, RemoveKind},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

pub(crate) enum Message {
    Configure,
    Event(notify::Result<Event>),
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

#[derive(Default)]
struct Targets {
    discovery: Option<PathBuf>,
    known_directories: BTreeSet<PathBuf>,
    projects: BTreeMap<String, Vec<(PathBuf, bool)>>,
}

fn targets(state: &AppState) -> Targets {
    let config = state
        .config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let cache = state.repo_cache.lock().unwrap_or_else(|e| e.into_inner());
    let mut result = Targets {
        discovery: config.watch_directory.map(PathBuf::from),
        ..Targets::default()
    };
    result.known_directories.extend(
        config
            .projects
            .iter()
            .map(|project| PathBuf::from(&project.path)),
    );
    for project in config.projects.iter().filter(|project| !project.archived) {
        let root = PathBuf::from(&project.path);
        let mut roots = vec![(root.clone(), false)];
        if let Some((_, repos, _)) = cache.get(&root) {
            roots.extend(repos.iter().cloned().map(|path| (path, false)));
        }
        for (path, _) in roots.clone() {
            // Worktree/submodule metadata can live outside the selected project.
            if let Ok(link) = std::fs::read_to_string(path.join(".git"))
                && let Some(gitdir) = link.trim().strip_prefix("gitdir: ")
                && let Ok(gitdir) = path.join(gitdir).canonicalize()
            {
                if let Ok(common) = std::fs::read_to_string(gitdir.join("commondir"))
                    && let Ok(common) = gitdir.join(common.trim()).canonicalize()
                {
                    roots.push((common, true));
                }
                roots.push((gitdir, true));
            }
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
    watcher: &mut RecommendedWatcher,
    watched: &mut BTreeMap<PathBuf, bool>,
    targets: &Targets,
) -> Option<String> {
    let desired = desired_paths(targets);
    let mut error = None;
    for (path, recursive) in watched.clone() {
        if desired.get(&path) != Some(&recursive) {
            let _ = watcher.unwatch(&path);
            watched.remove(&path);
        }
    }
    for (path, recursive) in desired {
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
    watcher: &mut RecommendedWatcher,
    watched: &mut BTreeMap<PathBuf, bool>,
    current: &mut Targets,
) -> Update {
    let next = targets(state);
    let desired = desired_paths(&next);
    let root_changed = current.discovery != next.discovery;
    let watch_changed = next
        .discovery
        .as_ref()
        .is_some_and(|root| watched.get(root) != desired.get(root));
    *current = next;
    let mut update = Update {
        settings: state.set_watch_service_error(configure(watcher, watched, current)),
        ..Update::default()
    };
    let discovery = current.discovery.as_ref().is_some_and(|root| {
        root_changed || watch_changed && watched.get(root) == desired.get(root)
    });
    if discovery {
        // Scan after installing the root watch: subsequent creations now produce events.
        let _ = state.list_projects();
        *current = targets(state);
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
            let directory_event = matches!(
                event.kind,
                EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder)
            ) || path.is_dir()
                && matches!(event.kind, EventKind::Create(_) | EventKind::Remove(_));
            let directory_event = directory_event
                || matches!(
                    event.kind,
                    EventKind::Modify(ModifyKind::Name(_)) | EventKind::Any
                ) && (path.is_dir() || targets.known_directories.contains(path));
            update.discovery |= path == root || child && directory_event;
        }
        for (project, roots) in &targets.projects {
            if roots
                .iter()
                .any(|(root, metadata)| relevant_file(root, *metadata, path))
            {
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

pub(crate) struct Service {
    sender: mpsc::Sender<Message>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.sender.send(Message::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub(crate) fn start(
    state: Arc<AppState>,
    emit: impl Fn(Update) + Send + 'static,
) -> Result<Service, String> {
    let (sender, receiver) = mpsc::channel();
    let events = sender.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        if event
            .as_ref()
            .is_ok_and(|event| matches!(event.kind, EventKind::Access(_)))
        {
            return;
        }
        let _ = events.send(Message::Event(event));
    })
    .map_err(|e| e.to_string())?;
    let _ = state.list_projects()?;
    let mut current = Targets::default();
    let mut watched = BTreeMap::new();
    let initial = configure_state(&state, &mut watcher, &mut watched, &mut current);
    if initial.discovery || initial.settings {
        emit(initial);
    }
    *state.watch_control.lock().map_err(|e| e.to_string())? = Some(sender.clone());
    let thread = thread::spawn(move || {
        while let Ok(message) = receiver.recv() {
            match message {
                Message::Stop => break,
                Message::Configure => {
                    let update = configure_state(&state, &mut watcher, &mut watched, &mut current);
                    if update.discovery || update.settings {
                        emit(update);
                    }
                }
                Message::Event(event) => {
                    let mut update = Update::default();
                    absorb(event, &current, &state, &mut update);
                    // Fixed window groups a burst without starving updates during continuous writes.
                    let deadline = Instant::now() + Duration::from_millis(750);
                    let mut reconfigure = false;
                    while let Ok(message) =
                        receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    {
                        match message {
                            Message::Stop => return,
                            Message::Configure => {
                                reconfigure = true;
                            }
                            Message::Event(event) => absorb(event, &current, &state, &mut update),
                        }
                        if Instant::now() >= deadline {
                            break;
                        }
                    }
                    if update.discovery {
                        let _ = state.list_projects();
                        reconfigure = true;
                    }
                    if reconfigure {
                        let configured =
                            configure_state(&state, &mut watcher, &mut watched, &mut current);
                        update.discovery |= configured.discovery;
                        update.settings |= configured.settings;
                    }
                    if !update.rescan.is_empty() {
                        let mut cache = state.repo_cache.lock().unwrap_or_else(|e| e.into_inner());
                        for project in &update.rescan {
                            cache.remove(Path::new(project));
                        }
                    }
                    if update.discovery || update.settings || !update.projects.is_empty() {
                        emit(update);
                    }
                }
            }
        }
    });
    Ok(Service {
        sender,
        thread: Some(thread),
    })
}

fn absorb(event: notify::Result<Event>, targets: &Targets, state: &AppState, update: &mut Update) {
    match event {
        Ok(event) => classify(&event, targets, update),
        Err(error) => {
            state.set_watch_service_error(Some(format!("Surveillance indisponible : {error}")));
            update.settings = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, DataChange, RenameMode};

    #[test]
    fn configuring_discovery_reconciles_folders_created_after_the_initial_scan() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("projects");
        std::fs::create_dir(&root).unwrap();
        let state = AppState::new(temp.path().join("config.json")).unwrap();
        let mut watcher = notify::recommended_watcher(|_| {}).unwrap();
        let mut watched = BTreeMap::new();
        let mut current = Targets::default();
        configure_state(&state, &mut watcher, &mut watched, &mut current);
        // Reproduce the gap: the preference scan finished, but Configure has not run.
        state.set_watch_directory(Some(&root)).unwrap();
        std::fs::create_dir(root.join("late-project")).unwrap();
        let update = configure_state(&state, &mut watcher, &mut watched, &mut current);
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
        assert!(!configure_state(&state, &mut watcher, &mut watched, &mut current).discovery);
    }

    #[test]
    fn routes_only_direct_directories_and_relevant_project_writes() {
        let root = PathBuf::from("/projects");
        let project = root.join("app");
        let targets = Targets {
            discovery: Some(root.clone()),
            known_directories: BTreeSet::from([project.clone()]),
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
        state.archive_project(&project, true).unwrap();
        let current = targets(&state);
        assert!(!current.projects.contains_key(&project));
        state.set_watch_directory(None).unwrap();
        assert!(targets(&state).discovery.is_none());
        drop(service);
    }
}
