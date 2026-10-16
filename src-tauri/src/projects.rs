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
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Config {
    pub projects: Vec<Project>,
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
    pub workers: std::sync::Arc<tokio::sync::Semaphore>,
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
            workers: std::sync::Arc::new(tokio::sync::Semaphore::new(4)),
        };
        state.save()?;
        Ok(state)
    }

    /// Register only an explicit user/CLI choice; first launch never scans the home folder.
    pub fn add_project(&self, path: &Path) -> Result<Project, String> {
        let path = path.canonicalize().map_err(|e| e.to_string())?;
        if !path.is_dir() {
            return Err("Sélectionnez un dossier".into());
        }
        let mut config = self.config.lock().map_err(|e| e.to_string())?;
        let canonical = path.to_string_lossy().into_owned();
        if let Some(existing) = config.projects.iter().find(|p| p.path == canonical) {
            return Ok(existing.clone());
        }
        let project = Project {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path: canonical,
            pinned: false,
        };
        let mut candidate = config.clone();
        candidate.projects.push(project.clone());
        candidate.projects.sort_by_key(|p| p.name.to_lowercase());
        self.write_config(&candidate)?;
        *config = candidate;
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
        self.repo_cache.lock().map_err(|e| e.to_string())?.insert(
            project.to_path_buf(),
            (Instant::now(), repos.clone(), limited),
        );
        Ok((repos, limited))
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
