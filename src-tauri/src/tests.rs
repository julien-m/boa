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

#[test]
fn markdown_images_resolve_relative_paths_and_refuse_external_or_oversized_data() {
    use base64::Engine;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::create_dir(root.join("images")).unwrap();
    fs::write(root.join("docs/README.md"), "# Guide").unwrap();
    let png = b"\x89PNG\r\n\x1a\nexample";
    fs::write(root.join("images/plan one.png"), png).unwrap();
    let value = files::markdown_image(&root, "docs/README.md", "../images/plan%20one.png").unwrap();
    assert_eq!(
        value,
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        )
    );
    fs::write(temp.path().join("private.png"), png).unwrap();
    std::os::unix::fs::symlink(
        temp.path().join("private.png"),
        root.join("images/outside.png"),
    )
    .unwrap();
    for source in [
        "../../private.png",
        "../images/outside.png",
        "https://example.com/image.png",
        "file:///etc/passwd",
        "//example.com/image.png",
        "data:image/png;base64,AAAA",
        "/etc/passwd",
    ] {
        assert!(
            files::markdown_image(&root, "docs/README.md", source).is_err(),
            "{source}"
        );
    }
    fs::write(root.join("images/not-image.png"), "private text").unwrap();
    assert!(files::markdown_image(&root, "docs/README.md", "../images/not-image.png").is_err());
    let large = fs::File::create(root.join("images/large.png")).unwrap();
    large.set_len(8 * 1024 * 1024 + 1).unwrap();
    assert!(
        files::markdown_image(&root, "docs/README.md", "../images/large.png")
            .unwrap_err()
            .contains("8 Mo")
    );
}

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

#[test]
fn configured_directory_discovers_direct_children_without_duplicates_and_preserves_archives() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("projects");
    fs::create_dir_all(root.join("alpha/nested")).unwrap();
    fs::create_dir(root.join(".hidden")).unwrap();
    fs::write(root.join("file.txt"), "not a directory").unwrap();
    let config = temp.path().join("settings.json");
    let state = AppState::new(config.clone()).unwrap();
    assert!(state.list_projects().unwrap().is_empty());
    let alpha = state.add_project(&root.join("alpha")).unwrap();
    state.pin_project(&alpha.path, true).unwrap();
    state.set_watch_directory(Some(&root)).unwrap();
    let projects = state.list_projects().unwrap();
    assert_eq!(projects.len(), 1);
    assert!(projects[0].pinned);
    fs::create_dir(root.join("beta")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("alpha"), root.join("alias")).unwrap();
    assert_eq!(state.list_projects().unwrap().len(), 2);
    state.archive_project(&alpha.path, true).unwrap();
    assert!(
        state
            .list_projects()
            .unwrap()
            .iter()
            .find(|p| p.path == alpha.path)
            .unwrap()
            .archived
    );
    let next = AppState::new(config).unwrap();
    assert!(next.settings().unwrap().watch_directory.is_some());
    assert!(next.list_projects().unwrap()[0].archived);
    assert!(!next.add_project(&root.join("alpha")).unwrap().archived);
    assert!(next.list_projects().unwrap()[0].pinned);
    next.archive_project(&alpha.path, true).unwrap();
    next.archive_project(&alpha.path, false).unwrap();
    assert!(!next.list_projects().unwrap()[0].archived);
    next.set_watch_directory(None).unwrap();
    fs::create_dir(root.join("gamma")).unwrap();
    assert_eq!(next.list_projects().unwrap().len(), 2);
}

#[test]
fn restoring_projects_rediscovers_repositories_changed_while_archived() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let state = AppState::new(temp.path().join("config.json")).unwrap();
    let project = state.add_project(&root).unwrap();
    assert!(state.repositories(&root).unwrap().0.is_empty());
    state.archive_project(&project.path, true).unwrap();
    let nested = root.join("nested");
    fs::create_dir(&nested).unwrap();
    run(&nested, &["init", "-q"]);
    state.archive_project(&project.path, false).unwrap();
    assert_eq!(state.repositories(&root).unwrap().0, vec![nested.clone()]);
    state.archive_project(&project.path, true).unwrap();
    let moved = temp.path().join("moved");
    fs::rename(&nested, moved).unwrap();
    state.add_project(&root).unwrap();
    assert!(state.repositories(&root).unwrap().0.is_empty());
}

#[test]
fn settings_migrate_old_configuration_and_do_not_publish_failed_writes() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config.json");
    fs::write(&config, r#"{"projects":[]}"#).unwrap();
    let state = AppState::new(config.clone()).unwrap();
    assert!(state.settings().unwrap().watch_directory.is_none());
    let root = temp.path().join("projects");
    fs::create_dir_all(root.join("first")).unwrap();
    let blocker = config.with_extension("json.tmp");
    fs::create_dir(&blocker).unwrap();
    assert!(state.set_watch_directory(Some(&root)).is_err());
    assert!(state.settings().unwrap().watch_directory.is_none());
    assert!(state.list_projects().unwrap().is_empty());
    fs::remove_dir(&blocker).unwrap();
    state.set_watch_directory(Some(&root)).unwrap();
    fs::create_dir(root.join("second")).unwrap();
    fs::create_dir(&blocker).unwrap();
    assert_eq!(state.list_projects().unwrap().len(), 1);
    assert!(state.settings().unwrap().watch_error.is_some());
    let project = state.list_projects().unwrap()[0].clone();
    assert!(state.archive_project(&project.path, true).is_err());
    assert!(!state.list_projects().unwrap()[0].archived);
    fs::remove_dir(&blocker).unwrap();
    assert_eq!(state.list_projects().unwrap().len(), 2);
    assert!(state.settings().unwrap().watch_error.is_none());
    fs::rename(&root, temp.path().join("moved")).unwrap();
    assert_eq!(state.list_projects().unwrap().len(), 2);
    assert!(state.settings().unwrap().watch_error.is_some());
    state.set_watch_directory(None).unwrap();
    assert!(state.settings().unwrap().watch_error.is_none());
}

#[test]
fn interface_language_is_validated_persisted_and_independent_of_project_settings() {
    let temp = tempfile::tempdir().unwrap();
    let config = temp.path().join("config.json");
    let state = AppState::new(config.clone()).unwrap();
    assert_eq!(state.settings().unwrap().language, "fr");
    assert!(state.set_language("de").is_err());
    let root = temp.path().join("projects");
    fs::create_dir_all(root.join("one")).unwrap();
    state.set_watch_directory(Some(&root)).unwrap();
    state.set_language("en").unwrap();
    let next = AppState::new(config.clone()).unwrap();
    assert_eq!(next.settings().unwrap().language, "en");
    assert!(next.settings().unwrap().watch_directory.is_some());
    assert_eq!(next.list_projects().unwrap().len(), 1);
    fs::create_dir(config.with_extension("json.tmp")).unwrap();
    assert!(next.set_language("fr").is_err());
    assert_eq!(next.settings().unwrap().language, "en");
}

#[test]
fn repository_links_normalize_git_transports_without_credentials_or_unsafe_schemes() {
    for (remote, expected) in [
        (
            "https://git.example.org:8443/team/app.git?token=example#readme",
            "https://git.example.org:8443/team/app",
        ),
        (
            "git@gitlab.example.org:group/subgroup/app.git",
            "https://gitlab.example.org/group/subgroup/app",
        ),
        (
            "github.com:example/project.git",
            "https://github.com/example/project",
        ),
        (
            "ssh://git@git.example.org:2222/team/app.git",
            "https://git.example.org/team/app",
        ),
        (
            "http://localhost:3000/team/app.git/",
            "http://localhost:3000/team/app",
        ),
    ] {
        assert_eq!(git::web_url(remote).as_deref(), Some(expected));
    }
    let mut authenticated = tauri::Url::parse("https://git.example.org/team/app.git").unwrap();
    authenticated.set_username("example-user").unwrap();
    authenticated
        .set_password(Some("example-password"))
        .unwrap();
    assert_eq!(
        git::web_url(authenticated.as_str()).as_deref(),
        Some("https://git.example.org/team/app")
    );
    for remote in [
        "file:///tmp/repo",
        "/tmp/repo.git",
        "javascript:alert(1)",
        "https://example.org/",
        "https://example.org/team/app\nextra",
        "",
    ] {
        assert!(git::web_url(remote).is_none(), "{remote}");
    }
}

#[test]
fn repository_link_prefers_origin_and_falls_back_to_a_supported_remote() {
    let (_temp, path) = fixture();
    assert!(git::repository_web_url(&path).unwrap().is_none());
    run(&path, &["remote", "add", "origin", "/tmp/local.git"]);
    assert!(git::repository_web_url(&path).unwrap().is_none());
    run(
        &path,
        &[
            "remote",
            "add",
            "upstream",
            "git@gitlab.example.org:team/app.git",
        ],
    );
    assert_eq!(
        git::repository_web_url(&path).unwrap().as_deref(),
        Some("https://gitlab.example.org/team/app")
    );
    run(
        &path,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/example/project.git",
        ],
    );
    assert_eq!(
        git::repository_web_url(&path).unwrap().as_deref(),
        Some("https://github.com/example/project")
    );
}

#[test]
fn saves_existing_text_atomically_and_rejects_conflicts_and_unsafe_paths() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let file = root.join("note.md");
    fs::write(&file, "before\r\n").unwrap();
    files::save(root, "note.md", "before\r\n", "after\r\n").unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "after\r\n");
    fs::write(&file, "external change").unwrap();
    assert!(files::save(root, "note.md", "after\r\n", "lost").is_err());
    assert_eq!(fs::read_to_string(&file).unwrap(), "external change");
    assert!(files::save(root, "../note.md", "", "bad").is_err());
    assert!(files::save(root, "missing.md", "", "bad").is_err());
    assert!(files::save(root, "", "", "bad").is_err());
    assert!(files::save(root, "note.md", "external change", "\0binary").is_err());
    assert!(
        files::save(
            root,
            "note.md",
            "external change",
            &"x".repeat(files::FILE_LIMIT as usize + 1)
        )
        .is_err()
    );
    fs::create_dir(root.join(".git")).unwrap();
    fs::write(root.join(".git/config"), "private").unwrap();
    assert!(files::save(root, ".git/config", "private", "bad").is_err());
    #[cfg(unix)]
    {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), "outside").unwrap();
        symlink(outside.path(), root.join("linked.md")).unwrap();
        assert!(files::save(root, "linked.md", "outside", "bad").is_err());
        assert_eq!(fs::read_to_string(outside.path()).unwrap(), "outside");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
        files::save(root, "note.md", "external change", "saved").unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}

#[cfg(target_os = "macos")]
#[test]
fn saves_preserve_macos_xattrs_acl_owner_group_and_mode() {
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("tagged.txt");
    fs::write(&file, "before").unwrap();
    // Exercise a distinct group when this account belongs to more than one group.
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if count > 0 {
        let mut groups = vec![0; count as usize];
        assert!(unsafe { libc::getgroups(count, groups.as_mut_ptr()) } >= 0);
        if let Some(group) = groups
            .into_iter()
            .find(|gid| *gid != fs::metadata(&file).unwrap().gid())
        {
            let handle = fs::File::open(&file).unwrap();
            assert_eq!(
                unsafe { libc::fchown(handle.as_raw_fd(), u32::MAX, group) },
                0
            );
        }
    }
    assert!(
        Command::new("/usr/bin/xattr")
            .args(["-w", "com.example.boa-test", "retained"])
            .arg(&file)
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new("/bin/chmod")
            .args([
                "+a",
                "everyone allow read,readattr,readextattr,readsecurity"
            ])
            .arg(&file)
            .status()
            .unwrap()
            .success()
    );
    let acl = |file: &Path| {
        let output = Command::new("/bin/ls")
            .arg("-le")
            .arg(file)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .skip(1)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let before_acl = acl(&file);
    assert!(!before_acl.is_empty());
    let before = fs::metadata(&file).unwrap();
    files::save(dir.path(), "tagged.txt", "before", "after").unwrap();
    let after = fs::metadata(&file).unwrap();
    assert_eq!(
        (before.uid(), before.gid(), before.mode()),
        (after.uid(), after.gid(), after.mode())
    );
    assert_eq!(before_acl, acl(&file));
    let tag = Command::new("/usr/bin/xattr")
        .args(["-p", "com.example.boa-test"])
        .arg(&file)
        .output()
        .unwrap();
    assert!(tag.status.success());
    assert_eq!(String::from_utf8(tag.stdout).unwrap().trim(), "retained");
    assert_eq!(fs::read_to_string(file).unwrap(), "after");
}
