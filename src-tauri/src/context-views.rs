//! Persistent, explicit reading guides and bounded display acknowledgements.
use crate::projects::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, VecDeque},
    fs,
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
    path::{Component, Path},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_STORE: usize = 1024 * 1024;
const MAX_VIEW: usize = 48 * 1024;
const MAX_RECEIPTS: usize = 128;
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Passage {
    pub id: String,
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Step {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub passages: Vec<Passage>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct View {
    pub id: String,
    pub project: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub kind: String,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub updated_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContextTarget {
    pub project: String,
    pub view_id: String,
    pub step_id: String,
    pub passage_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReaderRequest {
    pub request_id: String,
    pub file: String,
    pub line: u32,
    pub end_line: u32,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextTarget>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    pub request_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub request: ReaderRequest,
    #[serde(skip)]
    created_at: u64,
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    List {
        project: String,
    },
    Get {
        project: String,
        id: String,
    },
    Save {
        view: View,
        expected_revision: Option<u64>,
    },
    Remove {
        project: String,
        id: String,
    },
    Update {
        project: String,
        id: String,
        patch: Value,
        expected_revision: u64,
    },
    Reorder {
        project: String,
        id: String,
        step_ids: Vec<String>,
        expected_revision: u64,
    },
    Open {
        project: String,
        id: String,
        step_id: Option<String>,
        passage_id: Option<String>,
    },
}
impl Request {
    pub(crate) fn mutates(&self) -> bool {
        matches!(
            self,
            Self::Save { .. } | Self::Remove { .. } | Self::Update { .. } | Self::Reorder { .. }
        )
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
}
fn relative(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains('\0')
        && !Path::new(value).is_absolute()
        && Path::new(value)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        && value
            .split('/')
            .all(|c| c != "." && c != ".." && c != ".git")
}
fn validate(view: &View) -> Result<(), String> {
    if !id(&view.id)
        || view.title.trim().is_empty()
        || view.title.len() > 200
        || view.description.len() > 8000
        || !["walkthrough", "findings"].contains(&view.kind.as_str())
        || view.steps.len() > 256
        || serde_json::to_vec(view).map_err(|e| e.to_string())?.len() > MAX_VIEW
    {
        return Err("Invalid or oversized context view".into());
    }
    let mut steps = BTreeSet::new();
    for step in &view.steps {
        if !id(&step.id)
            || !steps.insert(&step.id)
            || step.title.trim().is_empty()
            || step.title.len() > 200
            || step.description.len() > 8000
            || step.group.as_ref().is_some_and(|s| s.len() > 200)
            || step.passages.len() > 32
        {
            return Err("Invalid context step".into());
        }
        let mut passages = BTreeSet::new();
        for p in &step.passages {
            if !id(&p.id)
                || !passages.insert(&p.id)
                || !relative(&p.path)
                || p.start_line == 0
                || p.end_line < p.start_line
                || p.end_line > 1_000_000
                || [&p.label, &p.role, &p.symbol]
                    .iter()
                    .any(|v| v.as_ref().is_some_and(|s| s.len() > 200))
                || p.text.as_ref().is_some_and(|s| s.len() > 8000)
            {
                return Err("Invalid context passage".into());
            }
        }
    }
    Ok(())
}
pub(crate) fn load(path: &Path) -> Result<Vec<View>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() as usize > MAX_STORE {
        return Err("Invalid context store".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_STORE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let views: Vec<View> =
        serde_json::from_slice(&bytes).map_err(|e| format!("Unreadable context store: {e}"))?;
    if views.len() > 256 {
        return Err("Too many context views".into());
    }
    let mut keys = BTreeSet::new();
    for view in &views {
        validate(view)?;
        if !keys.insert((&view.project, &view.id)) {
            return Err("Duplicate context view".into());
        }
    }
    Ok(views)
}
fn persist(state: &AppState, views: &[View]) -> Result<(), String> {
    let path = state.config_path.with_file_name("context-views.json");
    let parent = path.parent().ok_or("Missing app data folder")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(views).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_STORE || views.len() > 256 {
        return Err("Context store limit reached".into());
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    temp.write_all(&bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn project(state: &AppState, value: &str) -> Result<String, String> {
    Ok(state.registered(value)?.to_string_lossy().into_owned())
}
fn get(state: &AppState, root: &str, view_id: &str) -> Result<View, String> {
    let root = project(state, root)?;
    let views = state.context_views.lock().map_err(|e| e.to_string())?;
    views
        .iter()
        .find(|v| v.project == root && v.id == view_id)
        .cloned()
        .ok_or("Context view not found".into())
}
fn save(state: &AppState, mut view: View, expected: Option<u64>) -> Result<View, String> {
    view.project = project(state, &view.project)?;
    validate(&view)?;
    if Path::new(&view.project).is_file() {
        for passage in view.steps.iter().flat_map(|step| &step.passages) {
            passage_file(Path::new(&view.project), &passage.path)?;
        }
    }
    let mut views = state.context_views.lock().map_err(|e| e.to_string())?;
    let existing = views
        .iter()
        .position(|v| v.project == view.project && v.id == view.id);
    let revision = existing.map(|i| views[i].revision).unwrap_or(0);
    if expected.is_some_and(|r| r != revision) {
        return Err("Context revision conflict; reload before updating".into());
    }
    view.revision = revision
        .checked_add(1)
        .ok_or("Context revision exhausted")?;
    view.updated_at = now();
    let mut next = views.clone();
    if let Some(i) = existing {
        next[i] = view.clone()
    } else {
        next.push(view.clone())
    };
    persist(state, &next)?;
    *views = next;
    Ok(view)
}
fn passage_file(root: &Path, relative: &str) -> Result<std::path::PathBuf, String> {
    if root.is_file() {
        if root.file_name() != Some(std::ffi::OsStr::new(relative)) {
            return Err("A single-file context can reference only its registered file".into());
        }
        Ok(root.to_path_buf())
    } else {
        Ok(root.join(relative))
    }
}
pub(crate) fn execute(state: &AppState, request: Request) -> Result<Value, String> {
    match request {
        Request::List { project: p } => {
            let root = project(state, &p)?;
            Ok(json!(
                state
                    .context_views
                    .lock()
                    .map_err(|e| e.to_string())?
                    .iter()
                    .filter(|v| v.project == root)
                    .cloned()
                    .collect::<Vec<_>>()
            ))
        }
        Request::Get { project: p, id } => Ok(json!(get(state, &project(state, &p)?, &id)?)),
        Request::Save {
            view,
            expected_revision,
        } => Ok(json!(save(state, view, expected_revision)?)),
        Request::Remove { project: p, id } => {
            let root = project(state, &p)?;
            let mut views = state.context_views.lock().map_err(|e| e.to_string())?;
            let next: Vec<_> = views
                .iter()
                .filter(|v| !(v.project == root && v.id == id))
                .cloned()
                .collect();
            if next.len() == views.len() {
                return Err("Context view not found".into());
            }
            persist(state, &next)?;
            *views = next;
            Ok(Value::Null)
        }
        Request::Update {
            project: p,
            id,
            patch,
            expected_revision,
        } => {
            let root = project(state, &p)?;
            let view = get(state, &root, &id)?;
            let object = patch.as_object().ok_or("Context patch must be an object")?;
            if object.is_empty()
                || object
                    .keys()
                    .any(|k| !["title", "description", "kind", "steps"].contains(&k.as_str()))
            {
                return Err("Invalid context patch fields".into());
            }
            let mut value = json!(view);
            for (k, v) in object {
                value[k] = v.clone()
            }
            let next: View = serde_json::from_value(value).map_err(|e| e.to_string())?;
            Ok(json!(save(state, next, Some(expected_revision))?))
        }
        Request::Reorder {
            project: p,
            id,
            step_ids,
            expected_revision,
        } => {
            let root = project(state, &p)?;
            let mut view = get(state, &root, &id)?;
            let mut seen = BTreeSet::new();
            if step_ids.len() != view.steps.len() || step_ids.iter().any(|id| !seen.insert(id)) {
                return Err("Reorder must include every step exactly once".into());
            }
            let mut steps = Vec::new();
            for id in step_ids {
                steps.push(
                    view.steps
                        .iter()
                        .find(|s| s.id == id)
                        .cloned()
                        .ok_or("Unknown step in reorder")?,
                )
            }
            view.steps = steps;
            Ok(json!(save(state, view, Some(expected_revision))?))
        }
        Request::Open {
            project: p,
            id,
            step_id,
            passage_id,
        } => {
            let root = project(state, &p)?;
            let view = get(state, &root, &id)?;
            let step = match step_id {
                Some(id) => view.steps.iter().find(|s| s.id == id),
                None => view.steps.first(),
            }
            .ok_or("Context step not found")?;
            let passage = match passage_id {
                Some(id) => step.passages.iter().find(|p| p.id == id),
                None => step.passages.first(),
            }
            .ok_or("Context passage not found")?;
            let target = ContextTarget {
                project: root.clone(),
                view_id: view.id,
                step_id: step.id.clone(),
                passage_id: passage.id.clone(),
            };
            Ok(json!(open(
                state,
                passage_file(Path::new(&root), &passage.path)?
                    .to_string_lossy()
                    .into_owned(),
                passage.start_line,
                passage.end_line,
                "CLI".into(),
                Some(target)
            )?))
        }
    }
}
pub(crate) fn open(
    state: &AppState,
    file: String,
    line: u32,
    end_line: u32,
    source: String,
    context: Option<ContextTarget>,
) -> Result<Receipt, String> {
    let path = Path::new(&file);
    if !path.is_absolute()
        || path.components().any(|c| matches!(c, Component::ParentDir))
        || file.contains('\0')
        || line == 0
        || end_line < line
        || end_line > 1_000_000
        || !["Codex", "Claude", "Cursor", "CLI", "BOA"].contains(&source.as_str())
    {
        return Err("Invalid reader navigation request".into());
    }
    let (roots, files): (Vec<String>, Vec<String>) = {
        let config = state.config.lock().map_err(|e| e.to_string())?;
        let roots = config
            .projects
            .iter()
            .map(|p| p.path.clone())
            .chain(
                config
                    .file_spaces
                    .iter()
                    .flat_map(|s| s.roots.iter().cloned()),
            )
            .collect();
        let files = config
            .file_spaces
            .iter()
            .flat_map(|s| s.files.iter().cloned())
            .collect();
        (roots, files)
    };
    let authorized = |path: &Path| {
        roots.iter().any(|root| path.starts_with(root))
            || files.iter().any(|file| path == Path::new(file))
    };
    let mut file = file;
    if !authorized(Path::new(&file)) {
        // Resolve filesystem aliases such as /var -> /private/var, including missing files.
        // Already registered lexical paths retain the reader's explicit symlink browsing behavior.
        let path = Path::new(&file);
        let mut ancestor = path;
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or("No existing navigation ancestor")?;
        }
        let canonical = ancestor.canonicalize().map_err(|e| e.to_string())?;
        let suffix = path.strip_prefix(ancestor).map_err(|e| e.to_string())?;
        let resolved = if suffix.as_os_str().is_empty() {
            canonical
        } else {
            canonical.join(suffix)
        };
        if !authorized(&resolved) {
            return Err("Register this folder in BOA before opening its files".into());
        }
        file = resolved.to_string_lossy().into_owned();
    }
    let request_id = format!(
        "{}-{}",
        now(),
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let request = ReaderRequest {
        request_id: request_id.clone(),
        file,
        line,
        end_line,
        source,
        context,
    };
    let receipt = Receipt {
        request_id,
        status: "pending".into(),
        message: None,
        request,
        created_at: now(),
    };
    let mut receipts = state.reader_receipts.lock().map_err(|e| e.to_string())?;
    if receipts.len() >= MAX_RECEIPTS {
        receipts.pop_front();
    }
    receipts.push_back(receipt.clone());
    Ok(receipt)
}
pub(crate) fn status(state: &AppState, request_id: &str) -> Result<Receipt, String> {
    let mut receipts = state.reader_receipts.lock().map_err(|e| e.to_string())?;
    let receipt = receipts
        .iter_mut()
        .find(|r| r.request_id == request_id)
        .ok_or("Reader receipt expired or unknown")?;
    if receipt.status == "pending" && now().saturating_sub(receipt.created_at) > 30_000 {
        receipt.status = "failed".into();
        receipt.message = Some("Reader did not acknowledge before the deadline".into())
    }
    Ok(receipt.clone())
}
pub(crate) fn pending(state: &AppState) -> Result<Vec<ReaderRequest>, String> {
    let receipts = state.reader_receipts.lock().map_err(|e| e.to_string())?;
    Ok(receipts
        .iter()
        .filter(|r| r.status == "pending" && now().saturating_sub(r.created_at) <= 30_000)
        .map(|r| r.request.clone())
        .collect())
}
pub(crate) fn acknowledge(
    state: &AppState,
    request_id: &str,
    status: &str,
    message: Option<String>,
) -> Result<Receipt, String> {
    if !["displayed", "paused", "missing", "needs-review", "failed"].contains(&status)
        || message.as_ref().is_some_and(|m| m.len() > 1000)
    {
        return Err("Invalid reader acknowledgement".into());
    }
    let mut receipts = state.reader_receipts.lock().map_err(|e| e.to_string())?;
    let receipt = receipts
        .iter_mut()
        .find(|r| r.request_id == request_id)
        .ok_or("Reader receipt expired or unknown")?;
    if receipt.status != "pending" {
        return Ok(receipt.clone());
    }
    if now().saturating_sub(receipt.created_at) > 30_000 {
        receipt.status = "failed".into();
        receipt.message = Some("Reader acknowledgement arrived after its deadline".into());
        return Ok(receipt.clone());
    }
    receipt.status = status.into();
    receipt.message = message;
    Ok(receipt.clone())
}

pub(crate) type Receipts = VecDeque<Receipt>;

#[cfg(test)]
mod tests {
    use super::*;
    fn view(root: &Path) -> View {
        serde_json::from_value(json!({"id":"flow","project":root,"title":"A flow","description":"","kind":"walkthrough","steps":[{"id":"one","title":"Entry","passages":[{"id":"code","path":"src/main.ts","startLine":2,"endLine":4}]}]})).unwrap()
    }
    #[test]
    fn persists_revisions_and_rejects_conflicting_or_unsafe_updates() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path().join("projects.json")).unwrap();
        state.add_project(temp.path()).unwrap();
        let first = save(&state, view(temp.path()), Some(0)).unwrap();
        assert_eq!(first.revision, 1);
        assert!(save(&state, first.clone(), Some(0)).is_err());
        let restored = AppState::new(temp.path().join("projects.json")).unwrap();
        assert_eq!(
            get(&restored, temp.path().to_str().unwrap(), "flow")
                .unwrap()
                .revision,
            1
        );
        let mut bad = first.clone();
        bad.steps[0].passages[0].path = "../escape".into();
        assert!(save(&state, bad, Some(1)).is_err());
        let mut duplicate = first;
        duplicate.steps.push(duplicate.steps[0].clone());
        assert!(save(&state, duplicate, Some(1)).is_err());
        assert!(
            execute(
                &state,
                Request::Update {
                    project: temp.path().to_string_lossy().into(),
                    id: "flow".into(),
                    patch: json!({"project":"/tmp"}),
                    expected_revision: 1
                }
            )
            .is_err()
        );
    }
    #[test]
    fn guarded_patch_reorder_remove_and_failed_writes_preserve_committed_state() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path().join("projects.json")).unwrap();
        state.add_project(temp.path()).unwrap();
        let mut input = view(temp.path());
        let mut second = input.steps[0].clone();
        second.id = "second".into();
        input.steps.push(second);
        let first = save(&state, input, Some(0)).unwrap();
        let updated = execute(
            &state,
            Request::Update {
                project: first.project.clone(),
                id: first.id.clone(),
                patch: json!({"title":"Revised explanation"}),
                expected_revision: 1,
            },
        )
        .unwrap();
        assert_eq!(updated["revision"], 2);
        assert_eq!(updated["steps"][0]["id"], "one");
        let reordered = execute(
            &state,
            Request::Reorder {
                project: first.project.clone(),
                id: first.id.clone(),
                step_ids: vec!["second".into(), "one".into()],
                expected_revision: 2,
            },
        )
        .unwrap();
        assert_eq!(reordered["steps"][0]["id"], "second");
        assert!(
            execute(
                &state,
                Request::Reorder {
                    project: first.project.clone(),
                    id: first.id.clone(),
                    step_ids: vec!["one".into(), "one".into()],
                    expected_revision: 3
                }
            )
            .is_err()
        );
        let path = state.config_path.with_file_name("context-views.json");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(save(&state, first.clone(), Some(3)).is_err());
        assert_eq!(get(&state, &first.project, &first.id).unwrap().revision, 3);
        fs::remove_dir(&path).unwrap();
        execute(
            &state,
            Request::Remove {
                project: first.project.clone(),
                id: first.id,
            },
        )
        .unwrap();
        assert_eq!(
            execute(
                &state,
                Request::List {
                    project: first.project
                }
            )
            .unwrap(),
            json!([])
        );
    }
    #[test]
    fn isolated_file_context_opens_the_registered_file_and_never_its_siblings() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("entry.ts");
        let sibling = temp.path().join("sibling.ts");
        fs::write(&file, "one\ntwo\nthree").unwrap();
        fs::write(&sibling, "unrelated").unwrap();
        let state = AppState::new(temp.path().join("projects.json")).unwrap();
        crate::file_workspace::execute(
            &state,
            crate::file_workspace::Request::SaveSpace {
                id: "isolated".into(),
                name: "Isolated".into(),
                roots: Vec::new(),
                files: vec![file.to_string_lossy().into_owned()],
            },
        )
        .unwrap();
        let mut input = view(&file);
        input.steps[0].passages[0].path = file.file_name().unwrap().to_string_lossy().into_owned();
        let saved = save(&state, input, Some(0)).unwrap();
        let result = execute(
            &state,
            Request::Open {
                project: saved.project.clone(),
                id: saved.id.clone(),
                step_id: None,
                passage_id: None,
            },
        )
        .unwrap();
        let canonical = file.canonicalize().unwrap().to_string_lossy().into_owned();
        assert_eq!(result["request"]["file"], canonical);
        let mut bad = saved.clone();
        bad.steps[0].passages[0].path = sibling.file_name().unwrap().to_string_lossy().into_owned();
        assert!(save(&state, bad, Some(1)).is_err());
        assert!(
            open(
                &state,
                sibling.to_string_lossy().into_owned(),
                1,
                1,
                "CLI".into(),
                None
            )
            .is_err()
        );
        assert!(
            open(
                &state,
                format!("{}/entry.ts", saved.project),
                1,
                1,
                "CLI".into(),
                None
            )
            .is_err()
        );
        assert_eq!(
            open(
                &state,
                file.to_string_lossy().into_owned(),
                1,
                1,
                "CLI".into(),
                None
            )
            .unwrap()
            .request
            .file,
            canonical
        );
    }
    #[test]
    fn registration_boundaries_and_receipts_do_not_claim_display_before_reader_ack() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path().join("projects.json")).unwrap();
        state.add_project(temp.path()).unwrap();
        let file = temp
            .path()
            .join("missing.ts")
            .to_string_lossy()
            .into_owned();
        let receipt = open(&state, file, 1, 2, "CLI".into(), None).unwrap();
        assert_eq!(receipt.status, "pending");
        assert_eq!(pending(&state).unwrap().len(), 1);
        assert_eq!(
            acknowledge(&state, &receipt.request_id, "missing", None)
                .unwrap()
                .status,
            "missing"
        );
        assert_eq!(
            acknowledge(&state, &receipt.request_id, "displayed", None)
                .unwrap()
                .status,
            "missing"
        );
        assert!(pending(&state).unwrap().is_empty());
        assert!(
            open(
                &state,
                "/unregistered/file".into(),
                1,
                1,
                "CLI".into(),
                None
            )
            .is_err()
        );
    }
}
