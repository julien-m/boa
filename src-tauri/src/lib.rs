//! Native command boundary for the BOA project cockpit.
mod cli;
mod context;
#[path = "file-workspace.rs"]
mod file_workspace;
mod files;
mod git;
#[path = "image-comparison.rs"]
mod image_comparison;
mod projects;
mod search;
#[cfg(test)]
mod tests;
mod watch;

use projects::{AppState, Project, Settings, Summary};
use std::{
    path::{Component, Path},
    sync::Arc,
};
use tauri::{Emitter, Manager, State};

type NativeState<'a> = State<'a, Arc<AppState>>;

async fn work<T: Send + 'static>(
    state: Arc<AppState>,
    task: impl FnOnce(&AppState) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    // Background scans have their own permits; interactive reads must never queue behind them.
    tauri::async_runtime::spawn_blocking(move || task(&state))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_projects(state: NativeState<'_>) -> Result<Vec<Project>, String> {
    work(state.inner().clone(), AppState::list_projects).await
}

#[tauri::command]
fn get_settings(state: NativeState<'_>) -> Result<Settings, String> {
    state.settings()
}

#[tauri::command]
async fn set_watch_directory(
    state: NativeState<'_>,
    path: Option<String>,
) -> Result<Settings, String> {
    work(state.inner().clone(), move |state| {
        state.set_watch_directory(path.as_deref().map(Path::new))
    })
    .await
}

#[tauri::command]
fn pin_project(state: NativeState<'_>, project: String, pinned: bool) -> Result<(), String> {
    state.pin_project(&project, pinned).map(|_| ())
}

#[tauri::command]
fn set_language(
    state: NativeState<'_>,
    app: tauri::AppHandle,
    language: String,
) -> Result<Settings, String> {
    let settings = state.set_language(&language)?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(if settings.language == "en" {
            "BOA — Projects & Git"
        } else {
            "BOA — Projets & Git"
        });
    }
    Ok(settings)
}

#[tauri::command]
fn archive_project(state: NativeState<'_>, project: String, archived: bool) -> Result<(), String> {
    state.archive_project(&project, archived)
}

#[tauri::command]
fn add_project(state: NativeState<'_>, path: String) -> Result<Project, String> {
    state.add_project(Path::new(&path))
}

#[tauri::command]
async fn project_summary(state: NativeState<'_>, project: String) -> Result<Summary, String> {
    let _permit = state
        .workers
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| e.to_string())?;
    work(state.inner().clone(), move |state| {
        let root = state.registered(&project)?;
        let (repos, scan_limited) = state.repositories(&root)?;
        let repos: Vec<git::RepoStatus> = repos.iter().map(|path| git::status(path)).collect();
        Ok(Summary {
            updated_at: projects::activity(&repos),
            repos,
            scan_limited,
        })
    })
    .await
}

#[tauri::command]
async fn read_directory(
    state: NativeState<'_>,
    project: String,
    path: String,
) -> Result<Vec<files::Entry>, String> {
    work(state.inner().clone(), move |state| {
        files::directory(&state.registered(&project)?, &path)
    })
    .await
}

#[tauri::command]
async fn repository_web_url(
    state: NativeState<'_>,
    project: String,
    repo: String,
) -> Result<Option<String>, String> {
    work(state.inner().clone(), move |state| {
        git::repository_web_url(&state.repository(&project, &repo)?)
    })
    .await
}

#[tauri::command]
async fn open_repository(
    state: NativeState<'_>,
    project: String,
    repo: String,
) -> Result<(), String> {
    work(state.inner().clone(), move |state| {
        let url = git::repository_web_url(&state.repository(&project, &repo)?)?
            .ok_or("Aucun dépôt distant web configuré")?;
        open_external(&[&url])
    })
    .await
}

#[tauri::command]
async fn open_project_folder(state: NativeState<'_>, project: String) -> Result<(), String> {
    work(state.inner().clone(), move |state| {
        let root = state.registered(&project)?;
        if !root.is_dir() {
            return Err("Sélectionnez un dossier".into());
        }
        open_external(&[
            "-b",
            "com.apple.finder",
            root.to_str().ok_or("Chemin non UTF-8")?,
        ])
    })
    .await
}

fn open_external(args: &[&str]) -> Result<(), String> {
    use wait_timeout::ChildExt;
    let mut child = std::process::Command::new("/usr/bin/open")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("Ouverture impossible : {error}"))?;
    let status = match child
        .wait_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("Ouverture impossible : {error}"))?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Ouverture impossible".into());
        }
    };
    if !status.success() {
        return Err("Ouverture impossible".into());
    }
    Ok(())
}

#[tauri::command]
async fn read_markdown_image(
    state: NativeState<'_>,
    project: String,
    document: String,
    source: String,
) -> Result<String, String> {
    work(state.inner().clone(), move |state| {
        files::markdown_image(&state.registered(&project)?, &document, &source)
    })
    .await
}

#[tauri::command]
async fn read_file(
    state: NativeState<'_>,
    project: String,
    path: String,
) -> Result<files::FilePreview, String> {
    work(state.inner().clone(), move |state| {
        files::file_preview(&state.registered(&project)?, &path)
    })
    .await
}

#[tauri::command]
async fn open_file(state: NativeState<'_>, project: String, path: String) -> Result<(), String> {
    work(state.inner().clone(), move |state| {
        let file = files::regular_file(&state.registered(&project)?, &path)?;
        open_external(&["--", file.to_str().ok_or("Chemin non UTF-8")?])
    })
    .await
}

#[tauri::command]
async fn save_file(
    state: NativeState<'_>,
    project: String,
    path: String,
    original: String,
    content: String,
) -> Result<(), String> {
    work(state.inner().clone(), move |state| {
        files::save(&state.registered(&project)?, &path, &original, &content)
    })
    .await
}

#[tauri::command]
async fn git_history(
    state: NativeState<'_>,
    project: String,
    repo: String,
    offset: u32,
    branch: String,
) -> Result<Vec<git::Commit>, String> {
    work(state.inner().clone(), move |state| {
        git::history(&state.repository(&project, &repo)?, offset, &branch)
    })
    .await
}

#[tauri::command]
async fn git_branches(
    state: NativeState<'_>,
    project: String,
    repo: String,
) -> Result<Vec<git::Branch>, String> {
    work(state.inner().clone(), move |state| {
        git::branches(&state.repository(&project, &repo)?)
    })
    .await
}

#[tauri::command]
async fn git_commit_files(
    state: NativeState<'_>,
    project: String,
    repo: String,
    hash: String,
) -> Result<Vec<git::Change>, String> {
    work(state.inner().clone(), move |state| {
        git::commit_files(&state.repository(&project, &repo)?, &hash)
    })
    .await
}

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
        || path.contains('\0')
    {
        return Err("Chemin Git invalide".into());
    }
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiffRequest {
    project: String,
    repo: String,
    path: String,
    old_path: Option<String>,
    side: String,
    hash: Option<String>,
    base: Option<String>,
    head: Option<String>,
}

#[tauri::command]
async fn git_diff(state: NativeState<'_>, request: DiffRequest) -> Result<files::Preview, String> {
    let DiffRequest {
        project,
        repo,
        path,
        old_path,
        side,
        hash,
        base,
        head,
    } = request;
    work(state.inner().clone(), move |state| {
        validate_path(&path)?;
        if let Some(old) = &old_path {
            validate_path(old)?;
        }
        let repo = state.repository(&project, &repo)?;
        if let (Some(base), Some(head)) = (&base, &head) {
            git::validate_hash(base)?;
            git::validate_hash(head)?;
            return Ok(files::Preview {
                original: files::git_blob(&repo, base, old_path.as_deref().unwrap_or(&path))?,
                modified: files::git_blob(&repo, head, &path)?,
                path,
                label: format!("Branche · {} → {}", &base[..7], &head[..7]),
            });
        }
        match hash {
            Some(hash) => files::commit_diff(&repo, &hash, &path, old_path.as_deref()),
            None => files::local_diff(&repo, &path, old_path.as_deref(), &side),
        }
    })
    .await
}

#[tauri::command]
async fn compare_branch(
    state: NativeState<'_>,
    project: String,
    repo: String,
    base: String,
    head: String,
) -> Result<git::Comparison, String> {
    work(state.inner().clone(), move |state| {
        git::comparison(&state.repository(&project, &repo)?, &base, &head)
    })
    .await
}

#[tauri::command]
async fn export_context(
    app: tauri::AppHandle,
    prompt: String,
    image: String,
) -> Result<context::Export, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("contexts");
    tauri::async_runtime::spawn_blocking(move || context::export(&root, &prompt, &image))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct Navigation {
    project: String,
    path: String,
}

#[tauri::command]
fn resolve_navigation(state: NativeState<'_>, file: String) -> Result<Navigation, String> {
    let file = Path::new(&file);
    if !file.is_absolute()
        || file
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("Chemin de navigation invalide".into());
    }
    if !file.is_file() {
        return Err("Le chemin doit désigner un fichier".into());
    }
    let config = state.config.lock().map_err(|e| e.to_string())?;
    let root = config
        .projects
        .iter()
        .map(|p| p.path.as_str())
        .chain(
            config
                .file_spaces
                .iter()
                .flat_map(|s| s.roots.iter().map(String::as_str)),
        )
        .filter(|root| file.starts_with(root))
        .max_by_key(|root| root.len())
        .ok_or("Importez d’abord ce projet dans BOA")?;
    Ok(Navigation {
        project: root.into(),
        path: file
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into(),
    })
}

#[tauri::command]
async fn search_project(
    state: NativeState<'_>,
    project: String,
    query: String,
) -> Result<search::Results, String> {
    work(state.inner().clone(), move |state| {
        search::search(&state.registered(&project)?, &query)
    })
    .await
}

#[tauri::command]
async fn file_workspace(
    state: NativeState<'_>,
    request: file_workspace::Request,
) -> Result<serde_json::Value, String> {
    work(state.inner().clone(), move |state| {
        file_workspace::execute(state, request)
    })
    .await
}

#[tauri::command]
async fn choose_comparison_image(
    state: NativeState<'_>,
    app: tauri::AppHandle,
    project: Option<String>,
    directory: Option<String>,
) -> Result<Option<image_comparison::ChosenImage>, String> {
    use tauri_plugin_dialog::DialogExt;
    let initial = work(state.inner().clone(), move |state| {
        let root = project
            .as_deref()
            .map(|path| state.registered(path))
            .transpose()?;
        image_comparison::initial_directory(root.as_deref(), directory.as_deref())
    })
    .await?;
    let english = state.settings()?.language == "en";
    let mut picker = app
        .dialog()
        .file()
        .set_title(if english {
            "Choose a second image"
        } else {
            "Choisir une deuxième image"
        })
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "svg"]);
    if let Some(directory) = initial {
        picker = picker.set_directory(directory);
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    picker.pick_file(move |path| {
        let _ = send.send(path);
    });
    let Some(chosen) = receive
        .await
        .map_err(|_| "Ouverture impossible".to_string())?
    else {
        return Ok(None);
    };
    // Only this native picker result authorizes reading a file outside registered projects.
    let path = chosen
        .into_path()
        .map_err(|_| "Chemin non UTF-8".to_string())?;
    tauri::async_runtime::spawn_blocking(move || image_comparison::read_chosen(&path).map(Some))
        .await
        .map_err(|error| error.to_string())?
}

/// Starts the desktop application and registers repository commands.
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let state = Arc::new(
                AppState::new(app.path().app_data_dir()?.join("projects.json"))
                    .map_err(std::io::Error::other)?,
            );
            cli::start(app.handle().clone(), state.clone()).map_err(std::io::Error::other)?;
            let handle = app.handle().clone();
            let service = watch::start(state.clone(), move |update| {
                let _ = handle.emit("boa:filesystem-changed", update);
            });
            match service {
                Ok(service) => {
                    app.manage(service);
                }
                Err(error) => {
                    state.set_watch_service_error(Some(format!(
                        "Surveillance indisponible : {error}"
                    )));
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(
                    if state.settings().map_err(std::io::Error::other)?.language == "en" {
                        "BOA — Projects & Git"
                    } else {
                        "BOA — Projets & Git"
                    },
                );
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            choose_comparison_image,
            get_settings,
            set_watch_directory,
            set_language,
            pin_project,
            archive_project,
            add_project,
            project_summary,
            read_directory,
            repository_web_url,
            open_repository,
            open_project_folder,
            read_file,
            open_file,
            save_file,
            read_markdown_image,
            git_history,
            git_branches,
            git_commit_files,
            git_diff,
            compare_branch,
            export_context,
            resolve_navigation,
            search_project,
            file_workspace
        ])
        .run(tauri::generate_context!());
    if let Err(error) = app {
        eprintln!("BOA n’a pas pu démarrer : {error}");
        std::process::exit(1);
    }
}
