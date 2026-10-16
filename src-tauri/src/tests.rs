//! End-to-end Git/filesystem contracts using disposable real repositories.
use crate::{
    files, git,
    projects::{AppState, discover_repositories},
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;

fn run(path: &Path, args: &[&str]) {
    let output = Command::new("/usr/bin/git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{:?}: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}
fn repo(path: &Path) {
    fs::create_dir_all(path).unwrap();
    run(path, &["init", "-b", "main"]);
    run(path, &["config", "user.email", "test@example.invalid"]);
    run(path, &["config", "user.name", "BOA test"]);
}
fn commit(path: &Path, message: &str) {
    run(path, &["add", "."]);
    run(path, &["commit", "-m", message]);
}
fn fixture() -> (TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("project");
    repo(&path);
    (temp, path.canonicalize().unwrap())
}

#[test]
fn reports_unborn_staged_unstaged_untracked_and_deleted_files() {
    let (_temp, path) = fixture();
    fs::write(path.join("new file.ts"), "one\n").unwrap();
    assert_eq!(git::status(&path).changes.len(), 1);
    assert!(git::status(&path).ahead.is_none());
    run(&path, &["add", "new file.ts"]);
    let preview = files::local_diff(&path, "new file.ts", None, "staged").unwrap();
    assert_eq!(preview.original, "");
    assert_eq!(preview.modified, "one\n");
    commit(&path, "first");
    fs::write(path.join("new file.ts"), "two\n").unwrap();
    let status = git::status(&path);
    assert_eq!(status.changes[0].worktree, "M");
    let preview = files::local_diff(&path, "new file.ts", None, "working").unwrap();
    assert_eq!(preview.original, "one\n");
    assert_eq!(preview.modified, "two\n");
    fs::remove_file(path.join("new file.ts")).unwrap();
    assert_eq!(
        files::local_diff(&path, "new file.ts", None, "working")
            .unwrap()
            .modified,
        ""
    );
}

#[test]
fn reads_initial_commit_history_and_diffs_with_newline_paths() {
    let (_temp, path) = fixture();
    let filename = "file\nname.ts";
    fs::write(path.join(filename), "hello\n").unwrap();
    commit(&path, "initial");
    let history = git::history(&path, 0, "").unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].subject, "initial");
    let changes = git::commit_files(&path, &history[0].hash).unwrap();
    assert_eq!(changes[0].path, filename);
    let preview = files::commit_diff(&path, &history[0].hash, filename, None).unwrap();
    assert_eq!(preview.original, "");
    assert_eq!(preview.modified, "hello\n");
    fs::write(path.join(filename), "updated\n").unwrap();
    commit(&path, "second");
    let history = git::history(&path, 0, "main").unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].subject, "second");
    assert_eq!(
        files::commit_diff(&path, &history[0].hash, filename, None)
            .unwrap()
            .original,
        "hello\n"
    );
}

#[test]
fn discovers_nested_repos_and_external_worktrees() {
    let (temp, path) = fixture();
    fs::write(path.join("a"), "a").unwrap();
    commit(&path, "first");
    let nested = path.join("packages/inner");
    repo(&nested);
    let dependency = path.join("node_modules/ignored");
    repo(&dependency);
    let external = temp.path().join("worktree");
    run(
        &path,
        &[
            "worktree",
            "add",
            "-b",
            "feature/test",
            external.to_str().unwrap(),
        ],
    );
    assert_eq!(discover_repositories(&path).unwrap().0.len(), 2);
    assert_eq!(discover_repositories(&external).unwrap().0.len(), 1);
    let state = AppState::new(temp.path().join("settings/projects.json")).unwrap();
    let repositories = state.repositories(&path).unwrap().0;
    assert!(repositories.contains(&external.canonicalize().unwrap()));
    assert!(!repositories.contains(&dependency));
}

#[test]
fn rejects_path_escape_allows_explicit_symlinks_and_bounds_text() {
    let (temp, path) = fixture();
    fs::write(temp.path().join("outside"), "secret").unwrap();
    assert!(files::confined(&path, "../outside").is_err());
    assert!(files::confined(&path, "/etc/passwd").is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(temp.path().join("outside"), path.join("link")).unwrap();
        assert_eq!(
            files::text(&files::confined(&path, "link").unwrap()).unwrap(),
            "secret"
        );
    }
    assert!(files::decode(vec![0, 1]).is_err());
    assert!(files::decode(vec![b'a'; files::FILE_LIMIT as usize + 1]).is_err());
    assert!(files::decode(vec![0xff]).is_err());
}

#[test]
fn reports_ahead_behind_against_local_tracking_reference() {
    let (temp, path) = fixture();
    fs::write(path.join("a"), "a").unwrap();
    commit(&path, "first");
    let remote = temp.path().join("remote.git");
    run(&path, &["init", "--bare", remote.to_str().unwrap()]);
    run(
        &path,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    run(&path, &["push", "-u", "origin", "main"]);
    fs::write(path.join("a"), "b").unwrap();
    commit(&path, "second");
    let status = git::status(&path);
    assert_eq!(status.ahead, Some(1));
    assert_eq!(status.behind, Some(0));
}

#[test]
fn preserves_saved_pins_and_rejects_unregistered_roots() {
    let (temp, path) = fixture();
    let config_path = temp.path().join("data/settings.json");
    let state = AppState::new(config_path.clone()).unwrap();
    state.add_project(&path).unwrap();
    assert!(state.registered("/").is_err());
    {
        let mut config = state.config.lock().unwrap();
        let project = config
            .projects
            .iter_mut()
            .find(|p| p.path == path.to_str().unwrap())
            .unwrap();
        project.pinned = true;
        state.write_config(&config).unwrap();
    }
    let next = AppState::new(config_path).unwrap();
    assert!(
        next.config
            .lock()
            .unwrap()
            .projects
            .iter()
            .find(|p| p.path == path.to_str().unwrap())
            .unwrap()
            .pinned
    );
}

#[test]
fn compares_a_branch_since_its_common_ancestor_including_renames() {
    let (_temp, path) = fixture();
    fs::write(path.join("old.ts"), "before\n").unwrap();
    commit(&path, "base");
    run(&path, &["checkout", "-b", "feature/impact"]);
    run(&path, &["mv", "old.ts", "new.ts"]);
    commit(&path, "rename");
    let comparison = git::comparison(&path, "main", "feature/impact").unwrap();
    assert_eq!(comparison.changes.len(), 1);
    assert_eq!(comparison.changes[0].old_path.as_deref(), Some("old.ts"));
    assert_eq!(
        files::git_blob(&path, &comparison.merge_base, "old.ts").unwrap(),
        "before\n"
    );
    assert_eq!(
        files::git_blob(&path, &comparison.head, "new.ts").unwrap(),
        "before\n"
    );
    assert_eq!(git::status(&path).branch, "feature/impact");
}

#[test]
fn exports_context_to_two_local_attachments_and_rejects_invalid_images() {
    let temp = tempfile::tempdir().unwrap();
    let image = "data:image/png;base64,iVBORw0KGgo=";
    let package = crate::context::export(temp.path(), "Question\n\nCode", image).unwrap();
    assert_eq!(
        fs::read_to_string(package.markdown_path).unwrap(),
        "Question\n\nCode"
    );
    assert!(
        fs::read(package.image_path)
            .unwrap()
            .starts_with(b"\x89PNG")
    );
    assert!(crate::context::export(temp.path(), "q", "data:text/html;base64,AA==").is_err());
}

#[test]
#[ignore = "requires BOA_SMOKE_PROJECT; never used by ordinary tests or CI"]
fn inspects_an_explicit_live_project_without_modifying_it() {
    let root = PathBuf::from(
        std::env::var("BOA_SMOKE_PROJECT").expect("Set BOA_SMOKE_PROJECT explicitly"),
    );
    let temp = tempfile::tempdir().unwrap();
    let state = AppState::new(temp.path().join("config.json")).unwrap();
    let project = state.add_project(&root).unwrap();
    let (repos, limited) = state.repositories(Path::new(&project.path)).unwrap();
    let summary = crate::projects::Summary {
        repos: repos.iter().map(|path| git::status(path)).collect(),
        scan_limited: limited,
        updated_at: None,
    };
    if let Ok(destination) = std::env::var("BOA_QA_OUTPUT") {
        fs::write(destination, serde_json::to_vec_pretty(&summary).unwrap()).unwrap();
    }
    println!("Explicit read-only project smoke passed");
}

#[test]
#[cfg(unix)]
fn git_diff_versions_a_symlink_target_without_reading_the_target_file() {
    let (_temp, path) = fixture();
    fs::write(path.join("a.txt"), "first contents").unwrap();
    fs::write(path.join("b.txt"), "second contents").unwrap();
    std::os::unix::fs::symlink("a.txt", path.join("link.txt")).unwrap();
    commit(&path, "symlink");
    fs::remove_file(path.join("link.txt")).unwrap();
    std::os::unix::fs::symlink("b.txt", path.join("link.txt")).unwrap();
    let preview = files::local_diff(&path, "link.txt", None, "working").unwrap();
    assert_eq!(preview.original, "a.txt");
    assert_eq!(preview.modified, "b.txt");
}

#[test]
#[cfg(unix)]
fn refuses_fifo_without_blocking_and_expands_internal_directory_links() {
    let (_temp, path) = fixture();
    let fifo = path.join("pipe");
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || sender.send(files::text(&fifo)).unwrap());
    assert!(
        receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .is_err()
    );
    fs::create_dir(path.join("folder")).unwrap();
    std::os::unix::fs::symlink("folder", path.join("folder-link")).unwrap();
    assert!(
        files::directory(&path, "")
            .unwrap()
            .iter()
            .find(|entry| entry.name == "folder-link")
            .unwrap()
            .directory
    );
}

#[test]
fn ignores_uv_cache_gitfiles_and_keeps_valid_siblings_of_a_broken_repo() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let valid = root.join("valid");
    repo(&valid);
    let cache = root.join("uv-cache/sdists-v9");
    fs::create_dir_all(&cache).unwrap();
    fs::write(cache.join(".git"), "not a gitdir").unwrap();
    let broken = root.join("broken");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join(".git"), "not a gitdir").unwrap();
    let state = AppState::new(root.join("config/settings.json")).unwrap();
    let (repos, _) = state.repositories(&root).unwrap();
    assert!(repos.contains(&valid));
    assert!(repos.contains(&broken));
    assert!(!repos.contains(&cache));
    assert!(git::status(&valid).error.is_none());
    assert!(git::status(&broken).error.is_some());
}

#[test]
fn follows_external_directory_links_using_their_logical_project_path() {
    let (temp, root) = fixture();
    let external = temp.path().join("skills");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("SKILL.md"), "external skill content").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&external, root.join("skill-link")).unwrap();
    let entries = files::directory(&root, "skill-link").unwrap();
    assert_eq!(entries[0].path, "skill-link/SKILL.md");
    assert_eq!(
        files::text(&files::confined(&root, &entries[0].path).unwrap()).unwrap(),
        "external skill content"
    );
}

#[test]
fn project_search_finds_literal_text_at_its_line_without_shell_interpolation() {
    let (_temp, root) = fixture();
    fs::write(
        root.join("search.ts"),
        "first\nvalue = '$(`literal`)';\nthird\n",
    )
    .unwrap();
    let results = crate::search::search(&root, "$(`literal`)").unwrap();
    let result = serde_json::to_value(results).unwrap();
    assert_eq!(result["matches"][0]["path"], "search.ts");
    assert_eq!(result["matches"][0]["line"], 2);
    assert!(crate::search::search(&root, "").is_err());
}

#[test]
fn interactive_work_completes_while_all_background_scan_permits_are_held() {
    let (temp, _) = fixture();
    let state = std::sync::Arc::new(AppState::new(temp.path().join("config.json")).unwrap());
    let permits = state.workers.clone().try_acquire_many_owned(4).unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        sender
            .send(tauri::async_runtime::block_on(crate::work(state, |_| {
                Ok(7)
            })))
            .unwrap();
    });
    assert_eq!(
        receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap()
            .unwrap(),
        7
    );
    drop(permits);
    worker.join().unwrap();
}

#[test]
fn first_launch_stays_empty_even_when_a_projects_folder_exists() {
    let temp = tempfile::tempdir().unwrap();
    let projects = temp.path().join("projects");
    fs::create_dir_all(projects.join("example-app")).unwrap();
    let state = AppState::new(temp.path().join("preferences/projects.json")).unwrap();
    assert!(state.config.lock().unwrap().projects.is_empty());
}

#[test]
fn explicit_project_registration_and_pins_are_portable_and_persisted() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("my projects/été project");
    fs::create_dir_all(&root).unwrap();
    let config_path = temp.path().join("preferences/projects.json");
    let state = AppState::new(config_path.clone()).unwrap();
    assert!(state.config.lock().unwrap().projects.is_empty());
    assert!(state.registered(root.to_str().unwrap()).is_err());
    let project = state.add_project(&root).unwrap();
    assert!(!project.pinned);
    assert_eq!(project.path, root.canonicalize().unwrap().to_string_lossy());
    state.add_project(&root).unwrap();
    assert_eq!(state.config.lock().unwrap().projects.len(), 1);
    state.pin_project(&project.path, true).unwrap();
    let next = AppState::new(config_path).unwrap();
    assert!(next.config.lock().unwrap().projects[0].pinned);
    next.pin_project(&project.path, false).unwrap();
    assert!(!next.config.lock().unwrap().projects[0].pinned);
    let file = root.join("file.txt");
    fs::write(&file, "text").unwrap();
    assert!(next.add_project(&file).is_err());
    assert!(
        next.pin_project(temp.path().to_str().unwrap(), true)
            .is_err()
    );
}

#[test]
fn failed_preference_writes_do_not_publish_changes_or_report_false_success() {
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("project");
    fs::create_dir(&folder).unwrap();
    let config_path = temp.path().join("config.json");
    let state = AppState::new(config_path.clone()).unwrap();
    let blocker = config_path.with_extension("json.tmp");
    fs::create_dir(&blocker).unwrap();
    assert!(state.add_project(&folder).is_err());
    assert!(state.add_project(&folder).is_err());
    assert!(state.config.lock().unwrap().projects.is_empty());
    assert!(
        serde_json::from_slice::<crate::projects::Config>(&fs::read(&config_path).unwrap())
            .unwrap()
            .projects
            .is_empty()
    );
    fs::remove_dir(&blocker).unwrap();
    let project = state.add_project(&folder).unwrap();
    fs::create_dir(&blocker).unwrap();
    assert!(state.pin_project(&project.path, true).is_err());
    assert!(!state.config.lock().unwrap().projects[0].pinned);
    assert!(
        !serde_json::from_slice::<crate::projects::Config>(&fs::read(&config_path).unwrap())
            .unwrap()
            .projects[0]
            .pinned
    );
    fs::remove_dir(&blocker).unwrap();
    state.pin_project(&project.path, true).unwrap();
    fs::remove_dir(&folder).unwrap();
    // A missing folder must not trap an old pin in the sidebar.
    state.pin_project(&project.path, false).unwrap();
    assert!(
        !AppState::new(config_path)
            .unwrap()
            .config
            .lock()
            .unwrap()
            .projects[0]
            .pinned
    );
}

#[test]
fn merge_file_list_uses_the_same_first_parent_as_the_preview() {
    let (_temp, path) = fixture();
    fs::write(path.join("ours.txt"), "base\n").unwrap();
    fs::write(path.join("theirs.txt"), "base\n").unwrap();
    commit(&path, "base");
    run(&path, &["checkout", "-b", "feature"]);
    fs::write(path.join("theirs.txt"), "feature\n").unwrap();
    commit(&path, "feature");
    run(&path, &["checkout", "main"]);
    fs::write(path.join("ours.txt"), "main\n").unwrap();
    commit(&path, "main");
    run(&path, &["merge", "--no-ff", "feature", "-m", "merge"]);
    let hash = git::text(&path, &["rev-parse", "HEAD"]).unwrap();
    let changes = git::commit_files(&path, hash.trim()).unwrap();
    assert_eq!(
        changes.iter().map(|c| c.path.as_str()).collect::<Vec<_>>(),
        vec!["theirs.txt"]
    );
    let preview = files::commit_diff(&path, hash.trim(), "theirs.txt", None).unwrap();
    assert_eq!(preview.original, "base\n");
    assert_eq!(preview.modified, "feature\n");
}

#[test]
fn conflicted_files_preview_our_stage_against_the_working_file_in_both_sections() {
    for (ours, theirs) in [
        (Some("ours\n"), Some("theirs\n")),
        (None, Some("theirs\n")),
        (Some("ours\n"), None),
    ] {
        let (_temp, path) = fixture();
        let filename = "conflict\nfile.txt";
        fs::write(path.join(filename), "base\n").unwrap();
        commit(&path, "base");
        run(&path, &["checkout", "-b", "feature"]);
        match theirs {
            Some(content) => fs::write(path.join(filename), content).unwrap(),
            None => fs::remove_file(path.join(filename)).unwrap(),
        }
        commit(&path, "theirs");
        run(&path, &["checkout", "main"]);
        match ours {
            Some(content) => fs::write(path.join(filename), content).unwrap(),
            None => fs::remove_file(path.join(filename)).unwrap(),
        }
        commit(&path, "ours");
        assert!(
            !Command::new("/usr/bin/git")
                .arg("-C")
                .arg(&path)
                .args(["merge", "feature"])
                .output()
                .unwrap()
                .status
                .success()
        );
        assert!(
            git::status(&path)
                .changes
                .iter()
                .any(|change| change.conflict)
        );
        let working = fs::read_to_string(path.join(filename)).unwrap();
        for side in ["working", "staged"] {
            let preview = files::local_diff(&path, filename, None, side).unwrap();
            assert_eq!(preview.original, ours.unwrap_or(""));
            assert_eq!(preview.modified, working);
            assert!(preview.label.contains("Conflit"));
        }
        fs::write(path.join(filename), "resolved\n").unwrap();
        run(&path, &["add", filename]);
        let preview = files::local_diff(&path, filename, None, "staged").unwrap();
        assert_eq!(preview.original, ours.unwrap_or(""));
        assert_eq!(preview.modified, "resolved\n");
        assert_eq!(preview.label, "HEAD → index");
    }
}

#[test]
#[cfg(unix)]
fn discovery_keeps_healthy_siblings_when_a_descendant_is_unreadable() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let healthy = root.join("healthy");
    repo(&healthy);
    let blocked = root.join("blocked");
    fs::create_dir(&blocked).unwrap();
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();
    let inaccessible = fs::read_dir(&blocked).is_err();
    let result = discover_repositories(&root);
    let root_result = discover_repositories(&blocked);
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        inaccessible,
        "Test requires an unprivileged user to exercise EACCES"
    );
    let (repos, limited) = result.unwrap();
    assert!(repos.contains(&healthy));
    assert!(limited);
    assert!(root_result.is_err());
    assert!(discover_repositories(&root.join("missing")).is_err());
}
