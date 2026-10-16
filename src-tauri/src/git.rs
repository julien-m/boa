//! Read-only Git queries with bounded subprocesses and NUL-delimited paths.
use serde::Serialize;
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::Duration,
};
use wait_timeout::ChildExt;

const OUTPUT_LIMIT: u64 = 12 * 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn git(path: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    // Never invoke a shell or external diff/textconv/fsmonitor helpers from repository config.
    let mut child = Command::new("/usr/bin/git")
        .arg("--no-optional-locks")
        .args(["-c", "core.fsmonitor=false", "-c", "core.quotePath=false"])
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("LC_ALL", "en_US.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Git ne démarre pas : {error}"))?;
    let stdout = child.stdout.take().ok_or("Sortie Git indisponible")?;
    let stderr = child.stderr.take().ok_or("Erreurs Git indisponibles")?;
    // Drain both pipes while waiting; otherwise large diffs can block before the timeout.
    let output_thread = thread::spawn(move || read_bounded(stdout));
    let error_thread = thread::spawn(move || read_bounded(stderr));
    let status = match child
        .wait_timeout(COMMAND_TIMEOUT)
        .map_err(|e| e.to_string())?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "Git a dépassé 20 secondes ; réessayez sur un dépôt moins volumineux.".into(),
            );
        }
    };
    let stdout = output_thread
        .join()
        .map_err(|_| "Lecture Git interrompue")??;
    let stderr = error_thread
        .join()
        .map_err(|_| "Lecture Git interrompue")??;
    if !status.success() {
        return Err(String::from_utf8_lossy(&stderr).trim().to_owned());
    }
    Ok(stdout)
}

pub(crate) fn read_bounded(mut stream: impl Read) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::new();
    stream
        .by_ref()
        .take(OUTPUT_LIMIT + 1)
        .read_to_end(&mut buffer)
        .map_err(|e| e.to_string())?;
    if buffer.len() as u64 > OUTPUT_LIMIT {
        // Keep draining the pipe so the child can finish, without retaining more data.
        std::io::copy(&mut stream, &mut std::io::sink()).map_err(|e| e.to_string())?;
        return Err("Résultat trop volumineux (12 Mo maximum).".into());
    }
    Ok(buffer)
}

pub(crate) fn text(path: &Path, args: &[&str]) -> Result<String, String> {
    String::from_utf8(git(path, args)?)
        .map_err(|_| "Git renvoie des noms de fichiers non UTF-8.".into())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Change {
    pub path: String,
    pub old_path: Option<String>,
    pub index: String,
    pub worktree: String,
    pub conflict: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoStatus {
    pub path: String,
    pub name: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub changes: Vec<Change>,
    pub operation: Option<String>,
    pub error: Option<String>,
}

pub(crate) fn status(path: &Path) -> RepoStatus {
    let mut result = RepoStatus {
        path: path.to_string_lossy().into(),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        ..RepoStatus::default()
    };
    match text(
        path,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
    ) {
        Ok(output) => {
            parse_status(&output, &mut result);
            result.operation = operation(path);
        }
        Err(error) => result.error = Some(error),
    }
    result
}

fn operation(path: &Path) -> Option<String> {
    let git_dir = text(path, &["rev-parse", "--absolute-git-dir"]).ok()?;
    let git_dir = Path::new(git_dir.trim());
    [
        ("MERGE_HEAD", "Merge en cours"),
        ("rebase-merge", "Rebase en cours"),
        ("rebase-apply", "Rebase en cours"),
        ("CHERRY_PICK_HEAD", "Cherry-pick en cours"),
        ("REVERT_HEAD", "Revert en cours"),
    ]
    .into_iter()
    .find_map(|(file, label)| git_dir.join(file).exists().then(|| label.into()))
}

fn parse_status(output: &str, result: &mut RepoStatus) {
    let mut records = output.split('\0');
    while let Some(record) = records.next() {
        if let Some(branch) = record.strip_prefix("# branch.head ") {
            result.branch = branch.to_owned();
        } else if let Some(upstream) = record.strip_prefix("# branch.upstream ") {
            result.upstream = Some(upstream.to_owned());
        } else if let Some(counts) = record.strip_prefix("# branch.ab ") {
            let mut values = counts.split_whitespace();
            result.ahead = values
                .next()
                .and_then(|v| v.trim_start_matches('+').parse().ok());
            result.behind = values
                .next()
                .and_then(|v| v.trim_start_matches('-').parse().ok());
        } else if let Some(name) = record.strip_prefix("? ") {
            result.changes.push(Change {
                path: name.into(),
                old_path: None,
                index: "?".into(),
                worktree: "?".into(),
                conflict: false,
            });
        } else if record.starts_with("1 ") || record.starts_with("2 ") || record.starts_with("u ") {
            let count = if record.starts_with("1 ") {
                9
            } else if record.starts_with("2 ") {
                10
            } else {
                11
            };
            let fields: Vec<&str> = record.splitn(count, ' ').collect();
            if fields.len() == count {
                let xy = fields[1].as_bytes();
                if xy.len() != 2 {
                    continue;
                }
                result.changes.push(Change {
                    path: fields[count - 1].into(),
                    old_path: if count == 10 {
                        records.next().map(str::to_owned)
                    } else {
                        None
                    },
                    index: char::from(xy[0]).to_string(),
                    worktree: char::from(xy[1]).to_string(),
                    conflict: count == 11,
                });
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub refs: String,
}

pub(crate) fn history(path: &Path, offset: u32, branch: &str) -> Result<Vec<Commit>, String> {
    let mut args = vec![
        "log",
        "--topo-order",
        "--date=iso-strict",
        "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D",
        "-z",
        "--max-count=100",
    ];
    let skip = format!("--skip={}", offset.min(100_000));
    args.push(&skip);
    if branch.is_empty() {
        args.push("--all");
    } else {
        validate_revision(branch)?;
        args.push(branch);
    }
    args.push("--");
    let output = match text(path, &args) {
        Ok(output) => output,
        Err(error)
            if error.contains("does not have any commits")
                || error.contains("bad default revision") =>
        {
            return Ok(vec![]);
        }
        Err(error) => return Err(error),
    };
    let fields: Vec<&str> = output.split('\0').collect();
    Ok(fields
        .chunks(6)
        .filter(|row| row.len() == 6 && !row[0].is_empty())
        .map(|row| Commit {
            hash: row[0].into(),
            parents: row[1].split_whitespace().map(str::to_owned).collect(),
            author: row[2].into(),
            date: row[3].into(),
            subject: row[4].into(),
            refs: row[5].into(),
        })
        .collect())
}

pub(crate) fn validate_revision(revision: &str) -> Result<(), String> {
    if revision.starts_with('-') || revision.contains(['\0', '\n', '\r']) || revision.len() > 512 {
        return Err("Révision Git invalide".into());
    }
    Ok(())
}

pub(crate) fn validate_hash(hash: &str) -> Result<(), String> {
    if ![40, 64].contains(&hash.len()) || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Hash de commit invalide".into());
    }
    Ok(())
}

#[derive(Serialize)]
pub(crate) struct Branch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
}

pub(crate) fn branches(path: &Path) -> Result<Vec<Branch>, String> {
    let output = text(
        path,
        &[
            "for-each-ref",
            "--format=%(HEAD)%00%(refname:short)%00%(refname)",
            "refs/heads/",
            "refs/remotes/",
        ],
    )?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\0').collect();
            (fields.len() == 3).then(|| Branch {
                name: fields[1].into(),
                current: fields[0] == "*",
                remote: fields[2].starts_with("refs/remotes/"),
            })
        })
        .collect())
}

pub(crate) fn commit_files(path: &Path, hash: &str) -> Result<Vec<Change>, String> {
    validate_hash(hash)?;
    let output = text(
        path,
        &[
            "diff-tree",
            "--root",
            "--first-parent",
            "--diff-merges=first-parent",
            "--no-commit-id",
            "--name-status",
            "-r",
            "-z",
            hash,
            "--",
        ],
    )?;
    let mut fields = output.split('\0');
    let mut changes = Vec::new();
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let old = fields.next().ok_or("Liste Git incomplète")?;
        let (name, old_path) = if status.starts_with(['R', 'C']) {
            (
                fields.next().ok_or("Renommage Git incomplet")?,
                Some(old.into()),
            )
        } else {
            (old, None)
        };
        if !changes.iter().any(|c: &Change| c.path == name) {
            changes.push(Change {
                path: name.into(),
                old_path,
                index: status.into(),
                worktree: ".".into(),
                conflict: false,
            });
        }
    }
    Ok(changes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Comparison {
    pub base: String,
    pub head: String,
    pub merge_base: String,
    pub changes: Vec<Change>,
}

pub(crate) fn comparison(repo: &Path, base: &str, head: &str) -> Result<Comparison, String> {
    validate_revision(base)?;
    validate_revision(head)?;
    let base_hash = text(
        repo,
        &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
    )?
    .trim()
    .to_owned();
    let head_hash = text(
        repo,
        &["rev-parse", "--verify", &format!("{head}^{{commit}}")],
    )?
    .trim()
    .to_owned();
    validate_hash(&base_hash)?;
    validate_hash(&head_hash)?;
    let merge_base = text(repo, &["merge-base", &base_hash, &head_hash])?
        .trim()
        .to_owned();
    let output = text(
        repo,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-status",
            "--find-renames",
            "-z",
            &merge_base,
            &head_hash,
            "--",
        ],
    )?;
    let mut fields = output.split('\0');
    let mut changes = Vec::new();
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let first = fields.next().ok_or("Comparaison Git incomplète")?;
        let (path, old_path) = if status.starts_with(['R', 'C']) {
            (
                fields.next().ok_or("Renommage incomplet")?,
                Some(first.into()),
            )
        } else {
            (first, None)
        };
        changes.push(Change {
            path: path.into(),
            old_path,
            index: status.into(),
            worktree: ".".into(),
            conflict: false,
        });
    }
    Ok(Comparison {
        base: base.into(),
        head: head_hash,
        merge_base,
        changes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_renames_spaces_and_upstream_counts() {
        let mut result = RepoStatus::default();
        parse_status(
            "# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\x002 R. N... 100644 100644 100644 a b R100 new name.ts\0old name.ts\0? line\nbreak.txt\0",
            &mut result,
        );
        assert_eq!(result.ahead, Some(2));
        assert_eq!(result.behind, Some(1));
        assert_eq!(result.changes[0].path, "new name.ts");
        assert_eq!(result.changes[0].old_path.as_deref(), Some("old name.ts"));
        assert_eq!(result.changes[1].path, "line\nbreak.txt");
    }
    #[test]
    fn rejects_git_option_injection() {
        assert!(validate_revision("--output=/tmp/a").is_err());
        assert!(validate_hash("HEAD").is_err());
    }
}
