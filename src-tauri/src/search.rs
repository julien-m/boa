//! Literal project search via ripgrep, with timeout and result/output limits.
use serde::Serialize;
use std::{
    path::Path,
    process::{Command, Stdio},
    thread,
    time::Duration,
};
use wait_timeout::ChildExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Match {
    path: String,
    line: u64,
    text: String,
}
#[derive(Serialize)]
pub(crate) struct Results {
    matches: Vec<Match>,
    limited: bool,
    warning: Option<String>,
}

pub(crate) fn search(root: &Path, query: &str) -> Result<Results, String> {
    if query.trim().is_empty() || query.len() > 1000 || query.contains('\0') {
        return Err("Saisissez une recherche de 1 à 1 000 caractères.".into());
    }
    let mut candidates = std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .map(|path| path.join("rg"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // Finder launches often omit Homebrew from PATH on Apple Silicon and Intel Macs.
    candidates.extend(
        ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"].map(std::path::PathBuf::from),
    );
    let binary = candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or("Installez ripgrep pour rechercher dans les projets (brew install ripgrep).")?;
    // Literal query after --; Git ignores are respected, dependencies and Git metadata are excluded.
    let mut child = Command::new(binary)
        .current_dir(root)
        .args([
            "--json",
            "--fixed-strings",
            "--hidden",
            "--max-count=20",
            "--max-filesize=2M",
            "--glob=!.git/**",
            "--glob=!node_modules/**",
            "--glob=!target/**",
            "--glob=!.venv/**",
            "--glob=!dist/**",
            "--",
            query,
            ".",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("Sortie recherche indisponible")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Erreurs recherche indisponibles")?;
    let output_thread = thread::spawn(move || crate::git::read_bounded(stdout));
    let error_thread = thread::spawn(move || crate::git::read_bounded(stderr));
    let status = match child
        .wait_timeout(Duration::from_secs(10))
        .map_err(|e| e.to_string())?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Recherche interrompue après 10 secondes ; précisez votre requête.".into());
        }
    };
    let output = output_thread
        .join()
        .map_err(|_| "Recherche interrompue")??;
    let errors = error_thread.join().map_err(|_| "Recherche interrompue")??;
    let mut matches = Vec::new();
    let mut limited = false;
    for record in output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let event: serde_json::Value = serde_json::from_slice(record).map_err(|e| e.to_string())?;
        if event["type"] != "match" {
            continue;
        }
        let data = &event["data"];
        if let (Some(path), Some(line), Some(text)) = (
            data["path"]["text"].as_str(),
            data["line_number"].as_u64(),
            data["lines"]["text"].as_str(),
        ) {
            if matches.len() >= 300 {
                limited = true;
                break;
            }
            matches.push(Match {
                path: path.trim_start_matches("./").into(),
                line,
                text: text
                    .trim_end_matches(['\r', '\n'])
                    .chars()
                    .take(500)
                    .collect(),
            });
        }
    }
    let warning = if status.code().is_some_and(|code| code > 1) {
        Some(String::from_utf8_lossy(&errors).trim().to_owned())
    } else {
        None
    };
    Ok(Results {
        matches,
        limited,
        warning,
    })
}
