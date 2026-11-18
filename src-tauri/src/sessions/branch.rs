//! Live branch facts for a session's real working tree, read at action time (never cached).
use super::model::{SessionError, SessionResult};
use serde::Serialize;
use std::path::Path;

/// One local branch or linked worktree really present in the repository.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchOption {
    pub name: String,
    /// Path of the worktree where this branch is checked out, if any.
    pub worktree: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchFacts {
    /// Branch checked out in the session cwd now; None for a detached HEAD.
    pub current: Option<String>,
    pub detached: bool,
    pub options: Vec<BranchOption>,
}

/// Bounded branch listing: users rarely keep more than a few hundred local branches.
const MAX_BRANCHES: usize = 300;

/// Reads the live branch and the real local branches/worktrees of `cwd`'s repository.
pub(crate) fn facts(cwd: &Path) -> SessionResult<BranchFacts> {
    if !cwd.is_dir() {
        return Err(SessionError::new(
            "cwd_missing",
            "session working directory is gone",
        ));
    }
    let head = crate::git::text(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map_err(|e| SessionError::new("git_failed", e))?;
    let head = head.trim();
    let detached = head == "HEAD";
    let worktrees = crate::git::text(cwd, &["worktree", "list", "--porcelain"])
        .map_err(|e| SessionError::new("git_failed", e))?;
    let checked_out = parse_worktrees(&worktrees);
    let names = crate::git::text(
        cwd,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )
    .map_err(|e| SessionError::new("git_failed", e))?;
    let options = names
        .lines()
        .filter(|name| !name.is_empty())
        .take(MAX_BRANCHES)
        .map(|name| BranchOption {
            name: name.to_string(),
            worktree: checked_out
                .iter()
                .find(|(_, branch)| branch == name)
                .map(|(path, _)| path.clone()),
        })
        .collect();
    Ok(BranchFacts {
        current: (!detached).then(|| head.to_string()),
        detached,
        options,
    })
}

/// Parses `git worktree list --porcelain` into (path, short branch) pairs.
fn parse_worktrees(output: &str) -> Vec<(String, String)> {
    let mut result = Vec::new();
    let mut path: Option<&str> = None;
    for line in output.lines() {
        if let Some(value) = line.strip_prefix("worktree ") {
            path = Some(value);
        } else if let Some(reference) = line.strip_prefix("branch ")
            && let Some(path) = path
        {
            result.push((
                path.to_string(),
                reference.trim_start_matches("refs/heads/").to_string(),
            ));
        }
    }
    result
}

/// Worktree paths of the repository containing `root`, for provider cwd filters.
pub(crate) fn worktree_paths(root: &Path) -> Vec<String> {
    crate::git::text(root, &["worktree", "list", "--porcelain"])
        .map(|output| parse_worktrees_all(&output))
        .unwrap_or_default()
}

fn parse_worktrees_all(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix("worktree ").map(str::to_string))
        .collect()
}

/// Localized instruction asking the agent to change branch; BOA never checks out itself.
pub(crate) fn switch_instruction(language: &str, target: &str, worktree: Option<&str>) -> String {
    match (language == "en", worktree) {
        (false, None) => format!(
            "Passe le working tree de cette session sur la branche existante `{target}` (git switch {target}). \
             Ne crée pas de branche, ne pousse rien. S'il y a des changements non commités ou un conflit, \
             arrête-toi et explique-moi la situation sans rien forcer. Confirme ensuite la branche active."
        ),
        (false, Some(path)) => format!(
            "La branche `{target}` est déjà extraite dans le worktree `{path}`. Ne la réextrais pas ici : \
             dis-moi si tu dois travailler dans ce worktree, sans rien modifier pour l'instant."
        ),
        (true, None) => format!(
            "Switch this session's working tree to the existing branch `{target}` (git switch {target}). \
             Do not create a branch or push anything. If there are uncommitted changes or a conflict, \
             stop and explain without forcing anything. Then confirm the active branch."
        ),
        (true, Some(path)) => format!(
            "Branch `{target}` is already checked out in worktree `{path}`. Do not check it out here: \
             tell me whether you should work in that worktree, without changing anything yet."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        assert!(
            Command::new("/usr/bin/git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .status()
                .unwrap()
                .success()
        );
    }

    #[test]
    fn facts_read_live_head_branches_and_worktrees_from_a_real_repository() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "dev"]);
        git(
            &repo,
            &[
                "-c",
                "user.email=t@e",
                "-c",
                "user.name=t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "x",
            ],
        );
        git(&repo, &["branch", "feature/a"]);
        let linked = temp.path().join("linked");
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                linked.to_str().unwrap(),
                "feature/a",
            ],
        );
        let facts = facts(&repo).unwrap();
        assert_eq!(facts.current.as_deref(), Some("dev"));
        let feature = facts
            .options
            .iter()
            .find(|o| o.name == "feature/a")
            .unwrap();
        assert!(feature.worktree.as_deref().unwrap().ends_with("linked"));
        git(&repo, &["switch", "-q", "--detach"]);
        assert!(super::facts(&repo).unwrap().detached);
        assert_eq!(worktree_paths(&repo).len(), 2);
    }
}
