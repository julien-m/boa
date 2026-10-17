//! Project registration, persistent pins and bounded repository discovery.
use crate::git;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const MAX_SCAN_DIRS: usize = 4000;
const MAX_DEPTH: usize = 6;
const SKIP: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    ".next",
    ".cache",
    "uv-cache",
    ".uv-cache",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".Trash",
    ".worktrees",
    ".claude",
    ".codex",
    ".idea",
];

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Project {
    pub path: String,
    pub name: String,
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Config {
    pub projects: Vec<Project>,
    #[serde(default)]
    pub watch_directory: Option<String>,
    #[serde(default = "default_language")]
    pub language: String,
}

fn default_language() -> String {
    "fr".into()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            projects: Vec::new(),
            watch_directory: None,
            language: default_language(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    pub watch_directory: Option<String>,
    pub watch_error: Option<String>,
    pub language: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    pub repos: Vec<git::RepoStatus>,
    pub scan_limited: bool,
    pub updated_at: Option<u64>,
}

pub(crate) fn activity(repos: &[git::RepoStatus]) -> Option<u64> {
    let mut latest = None;
    for repo in repos {
        let path = Path::new(&repo.path);
        if let Ok(output) = git::text(path, &["log", "-1", "--format=%ct", "--"])
            && let Ok(timestamp) = output.trim().parse::<u64>()
        {
            latest = Some(latest.unwrap_or(0).max(timestamp));
        }
        for change in &repo.changes {
            if let Ok(metadata) = path.join(&change.path).symlink_metadata()
                && let Ok(modified) = metadata.modified()
                && let Ok(elapsed) = modified.duration_since(std::time::UNIX_EPOCH)
            {
                latest = Some(latest.unwrap_or(0).max(elapsed.as_secs()));
            }
        }
    }
    latest
}

type RepoCache = HashMap<PathBuf, (Instant, Vec<PathBuf>, bool)>;
pub(crate) struct AppState {
    pub config: Mutex<Config>,
    pub config_path: PathBuf,
    pub repo_cache: Mutex<RepoCache>,
    repo_generations: Mutex<HashMap<PathBuf, u64>>,
    pub workers: std::sync::Arc<tokio::sync::Semaphore>,
    watch_error: Mutex<Option<String>>,
    watch_service_error: Mutex<Option<String>>,
    pub watch_control: Mutex<Option<crate::watch::Control>>,
}

impl AppState {
    pub fn new(config_path: PathBuf) -> Result<Self, String> {
        let mut config: Config = if config_path.exists() {
            serde_json::from_slice(&fs::read(&config_path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("Configuration BOA illisible : {e}"))?
        } else {
            Config::default()
        };
        config.projects.sort_by_key(|p| p.name.to_lowercase());
        let state = Self {
            config: Mutex::new(config),
            config_path,
            repo_cache: Mutex::new(HashMap::new()),
            repo_generations: Mutex::new(HashMap::new()),
            workers: std::sync::Arc::new(tokio::sync::Semaphore::new(4)),
            watch_error: Mutex::new(None),
            watch_service_error: Mutex::new(None),
            watch_control: Mutex::new(None),
        };
        state.save()?;
        Ok(state)
    }

    pub fn settings(&self) -> Result<Settings, String> {
        let config = self.config.lock().map_err(|e| e.to_string())?;
        Ok(Settings {
            watch_directory: config.watch_directory.clone(),
            watch_error: self
                .watch_error
                .lock()
                .map_err(|e| e.to_string())?
                .clone()
                .or_else(|| {
                    self.watch_service_error
                        .lock()
                        .ok()
                        .and_then(|error| error.clone())
                }),
            language: config.language.clone(),
        })
    }

    pub fn notify_watchers(&self) {
        if let Ok(control) = self.watch_control.lock()
            && let Some(control) = control.as_ref()
        {
            control.send(crate::watch::Message::Configure);
        }
    }

    pub fn set_watch_service_error(&self, error: Option<String>) -> bool {
        let mut current = self
            .watch_service_error
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let changed = *current != error;
        *current = error;
        changed
    }

    /// Refresh on startup, native notifications or an explicit user request.
    pub fn list_projects(&self) -> Result<Vec<Project>, String> {
        let mut config = self.config.lock().map_err(|e| e.to_string())?;
        let mut candidate = config.clone();
        let refresh = discover_project_folders(&mut candidate).and_then(|()| {
            if candidate.projects.len() != config.projects.len() {
                self.write_config(&candidate)?;
                *config = candidate;
            }
            Ok(())
        });
        *self.watch_error.lock().map_err(|e| e.to_string())? = refresh.err();
        self.notify_watchers();
        Ok(config.projects.clone())
    }

    pub fn set_watch_directory(&self, directory: Option<&Path>) -> Result<Settings, String> {
        let directory = directory
            .map(|path| -> Result<String, String> {
                let path = path.canonicalize().map_err(|e| e.to_string())?;
                if !path.is_dir() {
                    return Err("Sélectionnez un dossier".into());
                }
                path.into_os_string()
                    .into_string()
                    .map_err(|_| "Chemin non UTF-8".into())
            })
            .transpose()?;
        let mut config = self.config.lock().map_err(|e| e.to_string())?;
        let mut candidate = config.clone();
        candidate.watch_directory = directory;
        discover_project_folders(&mut candidate)?;
        self.write_config(&candidate)?;
        *config = candidate;
        *self.watch_error.lock().map_err(|e| e.to_string())? = None;
        self.notify_watchers();
        Ok(Settings {
            watch_directory: config.watch_directory.clone(),
            watch_error: None,
            language: config.language.clone(),
        })
    }

    pub fn set_language(&self, language: &str) -> Result<Settings, String> {
        if !["fr", "en"].contains(&language) {
            return Err("Langue non prise en charge".into());
        }
        let mut config = self.config.lock().map_err(|e| e.to_string())?;
        let mut candidate = config.clone();
        candidate.language = language.to_owned();
        self.write_config(&candidate)?;
        *config = candidate;
        Ok(Settings {
            watch_directory: config.watch_directory.clone(),
            watch_error: self.watch_error.lock().map_err(|e| e.to_string())?.clone(),
            language: config.language.clone(),
        })
    }

    /// Register only an explicit user/CLI choice; first launch never scans the home folder.
    pub fn add_project(&self, path: &Path) -> Result<Project, String> {
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        if !path.is_dir() {
            return Err("Sélectionnez un dossier".into());
        }
        let mut config = self.config.lock().map_err(|e| e.to_string())?;
        let canonical = path.to_string_lossy().into_owned();
        if let Some(index) = config.projects.iter().position(|p| p.path == canonical) {
            if config.projects[index].archived {
                let mut candidate = config.clone();
                candidate.projects[index].archived = false;
                self.write_config(&candidate)?;
                *config = candidate;
                self.invalidate_repositories(&path);
                self.notify_watchers();
            }
            return Ok(config.projects[index].clone());
        }
        let project = Project {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: canonical,
            pinned: false,
            archived: false,
        };
        let mut candidate = config.clone();
        candidate.projects.push(project.clone());
        candidate.projects.sort_by_key(|p| p.name.to_lowercase());
        self.write_config(&candidate)?;
        *config = candidate;
        self.notify_watchers();
        Ok(project)
    }

    pub fn pin_project(&self, path: &str, pinned: bool) -> Result<Project, String> {
        let canonical = Path::new(path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(path));
        let mut config = self.config.lock().map_err(|e| e.to_string())?;
        let mut candidate = config.clone();
        let project = candidate
            .projects
            .iter_mut()
            .find(|p| Path::new(&p.path) == canonical)
            .ok_or("Projet non enregistré dans BOA")?;
        project.pinned = pinned;
        let result = project.clone();
        self.write_config(&candidate)?;
        *config = candidate;
        Ok(result)
    }

    pub fn archive_project(&self, path: &str, archived: bool) -> Result<(), String> {
        let mut config = self.config.lock().map_err(|e| e.to_string())?;
        let mut candidate = config.clone();
        candidate
            .projects
            .iter_mut()
            .find(|project| project.path == path)
            .ok_or("Projet non enregistré dans BOA")?
            .archived = archived;
        self.write_config(&candidate)?;
        *config = candidate;
        // Archived trees are not watched; both restoration routes must rediscover topology.
        self.invalidate_repositories(Path::new(path));
        self.notify_watchers();
        Ok(())
    }

    pub fn save(&self) -> Result<(), String> {
        let config = self.config.lock().map_err(|e| e.to_string())?;
        self.write_config(&config)
    }

    pub fn write_config(&self, config: &Config) -> Result<(), String> {
        if let Some(parent) = self.config_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temp = self.config_path.with_extension("json.tmp");
        fs::write(
            &temp,
            serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        // Rename only after a successful write to keep the previous preferences intact.
        fs::rename(temp, &self.config_path).map_err(|e| e.to_string())
    }

    pub fn registered(&self, project: &str) -> Result<PathBuf, String> {
        let config = self.config.lock().map_err(|e| e.to_string())?;
        if !config.projects.iter().any(|p| p.path == project) {
            return Err("Projet non enregistré dans BOA".into());
        }
        Path::new(project)
            .canonicalize()
            .map_err(|e| format!("Projet inaccessible : {e}"))
    }

    pub fn repositories(&self, project: &Path) -> Result<(Vec<PathBuf>, bool), String> {
        let generation = self.repository_generation(project);
        if let Some((time, repos, limited)) = self
            .repo_cache
            .lock()
            .map_err(|e| e.to_string())?
            .get(project)
            && time.elapsed() < Duration::from_secs(60)
        {
            return Ok((repos.clone(), *limited));
        }
        let (mut repos, limited) = discover_repositories(project)?;
        let roots = repos.clone();
        for root in roots {
            // A broken repository is still reported by status(); it must not hide healthy siblings.
            let output = match git::text(&root, &["worktree", "list", "--porcelain", "-z"]) {
                Ok(output) => output,
                Err(_) => continue,
            };
            for record in output.split('\0') {
                if let Some(path) = record.strip_prefix("worktree ")
                    && let Ok(path) = Path::new(path).canonicalize()
                    && !repos.contains(&path)
                {
                    repos.push(path);
                }
            }
        }
        if self.store_repositories(project, generation, &repos, limited)? {
            self.notify_watchers();
        }
        Ok((repos, limited))
    }

    fn repository_generation(&self, project: &Path) -> u64 {
        self.repo_generations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(project)
            .copied()
            .unwrap_or(0)
    }

    pub fn invalidate_repositories(&self, project: &Path) {
        let mut cache = self.repo_cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut versions = self
            .repo_generations
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let generation = versions.entry(project.to_path_buf()).or_default();
        *generation = generation.wrapping_add(1);
        cache.remove(project);
    }

    fn store_repositories(
        &self,
        project: &Path,
        generation: u64,
        repos: &[PathBuf],
        limited: bool,
    ) -> Result<bool, String> {
        let mut cache = self.repo_cache.lock().map_err(|e| e.to_string())?;
        // Publication and invalidation share the cache lock, then the version lock.
        if self.repository_generation(project) != generation {
            return Ok(false);
        }
        cache.insert(
            project.to_path_buf(),
            (Instant::now(), repos.to_vec(), limited),
        );
        Ok(true)
    }

    pub fn repository(&self, project: &str, repo: &str) -> Result<PathBuf, String> {
        let project = self.registered(project)?;
        let repo = Path::new(repo).canonicalize().map_err(|e| e.to_string())?;
        // Cached membership remains valid while discovery refreshes; validating a known checkout must stay fast.
        let known = self
            .repo_cache
            .lock()
            .map_err(|e| e.to_string())?
            .get(&project)
            .is_some_and(|(_, repos, _)| repos.contains(&repo));
        if !known && !self.repositories(&project)?.0.contains(&repo) {
            return Err("Dépôt non rattaché à ce projet".into());
        }
        Ok(repo)
    }
}

fn discover_project_folders(config: &mut Config) -> Result<(), String> {
    let Some(root) = &config.watch_directory else {
        return Ok(());
    };
    let entries =
        fs::read_dir(root).map_err(|e| format!("Dossier surveillé inaccessible : {e}"))?;
    let mut known: BTreeSet<String> = config
        .projects
        .iter()
        .map(|project| project.path.clone())
        .collect();
    for entry in entries {
        let entry = entry.map_err(|e| format!("Lecture du dossier surveillé : {e}"))?;
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') || !entry.path().is_dir() {
            continue;
        }
        let Ok(path) = entry.path().canonicalize() else {
            continue;
        };
        let Some(path) = path.to_str() else {
            continue;
        };
        if known.insert(path.to_owned()) {
            config.projects.push(Project {
                name: path_name(Path::new(path)),
                path: path.to_owned(),
                pinned: false,
                archived: false,
            });
        }
    }
    config
        .projects
        .sort_by_key(|project| project.name.to_lowercase());
    Ok(())
}

fn path_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

pub(crate) fn discover_repositories(root: &Path) -> Result<(Vec<PathBuf>, bool), String> {
    let mut repos = BTreeSet::new();
    let mut stack = vec![(root.to_path_buf(), 0)];
    let mut visited = 0;
    let mut limited = false;
    while let Some((path, depth)) = stack.pop() {
        visited += 1;
        if visited > MAX_SCAN_DIRS {
            limited = true;
            break;
        }
        if path.join(".git").exists() {
            match path.canonicalize() {
                Ok(path) => {
                    repos.insert(path);
                }
                Err(_) => {
                    limited = true;
                }
            }
        }
        if depth >= MAX_DEPTH {
            limited = true;
            continue;
        }
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) if path == root => {
                return Err(format!("Lecture de {} : {error}", path.display()));
            }
            Err(_) => {
                limited = true;
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    limited = true;
                    continue;
                }
            };
            let name = entry.file_name();
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(_) => {
                    limited = true;
                    continue;
                }
            };
            if kind.is_dir() && !SKIP.contains(&name.to_string_lossy().as_ref()) {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    Ok((repos.into_iter().collect(), limited))
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn invalidated_scan_cannot_repopulate_topology_but_other_cached_projects_stay_valid() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("app");
        let other = temp.path().join("other");
        let state = AppState::new(temp.path().join("config.json")).unwrap();
        let generation = state.repository_generation(&root);
        state
            .store_repositories(&other, generation, &[], false)
            .unwrap();
        // Simulate a traversal paused before cache publication, then a directory event.
        state.invalidate_repositories(&root);
        assert!(
            state
                .store_repositories(&other, generation, &[], false)
                .unwrap()
        );
        state
            .store_repositories(&root, generation, &[], false)
            .unwrap();
        let cache = state.repo_cache.lock().unwrap();
        assert!(
            !cache.contains_key(&root),
            "a stale traversal must not repopulate the cache"
        );
        assert!(
            cache.contains_key(&other),
            "unrelated cached projects remain valid"
        );
        drop(cache);
        let generation = state.repository_generation(&root);
        state
            .store_repositories(&root, generation, &[], false)
            .unwrap();
        assert!(state.repo_cache.lock().unwrap().contains_key(&root));
    }
}
