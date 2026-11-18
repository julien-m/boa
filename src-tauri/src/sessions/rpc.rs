//! Single request vocabulary for the sessions domain, shared by Tauri commands and the CLI.
use super::model::{Provider, SessionKey, SessionResult};
use super::provider::ProviderStatus;
use super::service::{ActionChange, ListQuery, ProjectRoot, ProjectScope};
use super::store::ProviderToggles;
use crate::projects::AppState;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KeyInput {
    pub provider: Provider,
    pub id: String,
}

impl KeyInput {
    fn key(&self) -> SessionResult<SessionKey> {
        SessionKey::new(self.provider, &self.id)
    }
}

#[derive(Debug, Clone, Deserialize)]
// Variant names and their fields are camelCase on the wire (`renderAction { actionId }`).
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Settings,
    SetDiscovery {
        enabled: bool,
        #[serde(default)]
        providers: Option<ProviderToggles>,
        #[serde(default)]
        revision: Option<u64>,
    },
    SetAutoPin {
        enabled: bool,
        #[serde(default)]
        revision: Option<u64>,
    },
    List {
        query: ListQuery,
    },
    Show {
        session: KeyInput,
    },
    Conversation {
        session: KeyInput,
        #[serde(default)]
        limit: Option<usize>,
    },
    Pin {
        session: KeyInput,
    },
    Unpin {
        session: KeyInput,
    },
    Rename {
        session: KeyInput,
        title: String,
    },
    Send {
        session: KeyInput,
        text: String,
    },
    Create {
        provider: Provider,
        project: String,
        text: String,
        #[serde(default)]
        title: Option<String>,
    },
    Resume {
        session: KeyInput,
    },
    Branch {
        session: KeyInput,
    },
    #[serde(rename = "requestBranch")]
    SwitchBranch {
        session: KeyInput,
        target: String,
    },
    #[serde(rename = "clearBranchRequest")]
    ClearPendingBranch {
        session: KeyInput,
    },
    Permission {
        session: KeyInput,
        request_id: String,
        allow: bool,
    },
    StartCodexDaemon,
    OpenTerminal {
        session: KeyInput,
        cols: u16,
        rows: u16,
        /// Restoring a view: attach to a running PTY only, never start one.
        #[serde(default)]
        attach_only: bool,
    },
    TerminalWrite {
        terminal_id: String,
        data: String,
    },
    TerminalResize {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    CloseTerminal {
        terminal_id: String,
    },
    /// Read-only: BOA terminals still running, for views whose tab was closed.
    Terminals,
    OpenInApp {
        session: KeyInput,
    },
    Actions {
        #[serde(default)]
        project: Option<String>,
    },
    ChangeActions {
        #[serde(default)]
        revision: Option<u64>,
        change: ActionChange,
    },
    RenderAction {
        session: KeyInput,
        action_id: String,
        #[serde(default)]
        file: Option<String>,
        #[serde(default)]
        selection: Option<String>,
    },
}

/// Registered, non-archived projects plus the interface language, read once per request.
pub(crate) fn project_scope(state: &AppState) -> SessionResult<ProjectScope> {
    let config = state
        .config
        .lock()
        .map_err(|_| super::model::SessionError::new("state_poisoned", "config lock"))?;
    Ok(ProjectScope {
        roots: config
            .projects
            .iter()
            .filter(|p| !p.archived)
            .map(|p| ProjectRoot {
                path: std::fs::canonicalize(&p.path).unwrap_or_else(|_| PathBuf::from(&p.path)),
                name: p.name.clone(),
            })
            .collect(),
        language: config.language.clone(),
    })
}

/// Canonical registered project path, or `project_not_registered`.
fn registered_project(scope: &ProjectScope, project: &str) -> SessionResult<String> {
    let path = std::fs::canonicalize(project).unwrap_or_else(|_| PathBuf::from(project));
    scope
        .roots
        .iter()
        .find(|root| root.path == path)
        .map(|root| root.path.to_string_lossy().into_owned())
        .ok_or_else(|| super::model::SessionError::new("project_not_registered", project))
}

/// Serializes a domain result; failure is reported, never replaced by null.
fn to_json<T: serde::Serialize>(value: &T) -> SessionResult<Value> {
    serde_json::to_value(value).map_err(super::model::SessionError::io)
}

fn statuses(value: Vec<ProviderStatus>) -> Value {
    json!(value)
}

/// Executes one request against the shared service.
pub(crate) fn execute(state: &AppState, request: Request) -> SessionResult<Value> {
    let service = &state.sessions;
    let scope = project_scope(state)?;
    Ok(match request {
        Request::Settings => to_json(&service.settings()?)?,
        Request::SetDiscovery {
            enabled,
            providers,
            revision,
        } => {
            service.set_discovery(enabled, providers, revision)?;
            to_json(&service.settings()?)?
        }
        Request::SetAutoPin { enabled, revision } => {
            service.set_auto_pin(enabled, revision)?;
            to_json(&service.settings()?)?
        }
        Request::List { query } => to_json(&service.list(&scope, &query)?)?,
        Request::Show { session } => to_json(&service.get(&scope, &session.key()?)?)?,
        Request::Conversation { session, limit } => {
            to_json(&service.conversation(&scope, &session.key()?, limit.unwrap_or(60))?)?
        }
        Request::Pin { session } => json!({"changed": service.pin(&session.key()?, true)?}),
        Request::Unpin { session } => json!({"changed": service.pin(&session.key()?, false)?}),
        Request::Rename { session, title } => {
            to_json(&service.rename(&scope, &session.key()?, &title)?)?
        }
        Request::Send { session, text } => {
            to_json(&service.send(&scope, &session.key()?, &text)?)?
        }
        Request::Create {
            provider,
            project,
            text,
            title,
        } => {
            let project = registered_project(&scope, &project)?;
            let (key, receipt) =
                service.create(&scope, provider, &project, &text, title.as_deref())?;
            json!({"session": key, "receipt": receipt})
        }
        Request::Resume { session } => {
            service.resume(&scope, &session.key()?)?;
            json!({"resumed": true})
        }
        Request::Branch { session } => to_json(&service.branch(&scope, &session.key()?)?)?,
        Request::SwitchBranch { session, target } => {
            to_json(&service.request_branch(&scope, &session.key()?, &target)?)?
        }
        Request::ClearPendingBranch { session } => {
            json!({"cleared": service.clear_branch_request(&session.key()?)?})
        }
        Request::Permission {
            session,
            request_id,
            allow,
        } => {
            service.answer_permission(&session.key()?, &request_id, allow)?;
            json!({"answered": true})
        }
        Request::StartCodexDaemon => {
            service.start_codex_daemon()?;
            statuses(service.settings()?.providers)
        }
        Request::OpenTerminal {
            session,
            cols,
            rows,
            attach_only,
        } => to_json(&service.open_terminal(&scope, &session.key()?, cols, rows, attach_only)?)?,
        Request::TerminalWrite { terminal_id, data } => {
            service.terminals().write(&terminal_id, &data)?;
            json!({"written": true})
        }
        Request::TerminalResize {
            terminal_id,
            cols,
            rows,
        } => {
            service.terminals().resize(&terminal_id, cols, rows)?;
            json!({"resized": true})
        }
        Request::CloseTerminal { terminal_id } => {
            service.terminals().close(&terminal_id)?;
            json!({"closed": true})
        }
        Request::Terminals => json!({"terminals": service.terminals().running()?}),
        Request::OpenInApp { session } => to_json(&service.open_in_app(&scope, &session.key()?)?)?,
        Request::Actions { project } => {
            let project = project
                .map(|p| registered_project(&scope, &p))
                .transpose()?;
            let (revision, actions) = service.actions(project.as_deref())?;
            json!({"revision": revision, "project": project, "actions": actions})
        }
        Request::ChangeActions { revision, change } => {
            let change = canonical_change(&scope, change)?;
            json!({"revision": service.change_actions(revision, change)?})
        }
        Request::RenderAction {
            session,
            action_id,
            file,
            selection,
        } => to_json(&service.render_action(
            &scope,
            &session.key()?,
            &action_id,
            file,
            selection,
        )?)?,
    })
}

/// Project keys are stored canonical so UI and CLI paths address the same override.
fn canonical_change(scope: &ProjectScope, change: ActionChange) -> SessionResult<ActionChange> {
    let canonical = |p: Option<String>| p.map(|p| registered_project(scope, &p)).transpose();
    Ok(match change {
        ActionChange::Add { project, action } => ActionChange::Add {
            project: canonical(project)?,
            action,
        },
        ActionChange::Update { project, id, patch } => ActionChange::Update {
            project: canonical(project)?,
            id,
            patch,
        },
        ActionChange::Remove { project, id } => ActionChange::Remove {
            project: canonical(project)?,
            id,
        },
        ActionChange::Reorder { project, ids } => ActionChange::Reorder {
            project: canonical(project)?,
            ids,
        },
        ActionChange::Reset { project, id } => ActionChange::Reset {
            project: registered_project(scope, &project)?,
            id,
        },
        ActionChange::Replace { project, actions } => ActionChange::Replace {
            project: canonical(project)?,
            actions,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Exact payloads sent by `sessions-api.ts` and `sessions-cli.ts`.
    #[test]
    fn ui_and_cli_payloads_deserialize_with_camel_case_fields() {
        let session = json!({"provider": "claude", "id": "abc"});
        for payload in [
            json!({"action": "renderAction", "session": session, "actionId": "tests", "file": "a.ts", "selection": "x"}),
            json!({"action": "permission", "session": session, "requestId": "perm-1", "allow": true}),
            json!({"action": "openTerminal", "session": session, "cols": 80, "rows": 24}),
            json!({"action": "terminalWrite", "terminalId": "t", "data": "ls"}),
            json!({"action": "terminalResize", "terminalId": "t", "cols": 80, "rows": 24}),
            json!({"action": "closeTerminal", "terminalId": "t"}),
            json!({"action": "requestBranch", "session": session, "target": "dev"}),
            json!({"action": "clearBranchRequest", "session": session}),
            json!({"action": "setDiscovery", "enabled": true, "providers": {"codex": true, "claude": false}, "revision": 2}),
            json!({"action": "list", "query": {"scope": "all", "search": "x", "provider": "codex", "state": "awaitingInput"}}),
            json!({"action": "create", "provider": "codex", "project": "/p", "text": "t", "title": "T"}),
            json!({"action": "changeActions", "revision": 1, "change": {"change": "reset", "project": "/p", "id": "tests"}}),
            json!({"action": "openInApp", "session": session}),
            json!({"action": "startCodexDaemon"}),
        ] {
            serde_json::from_value::<Request>(payload.clone())
                .unwrap_or_else(|error| panic!("{payload}: {error}"));
        }
        assert!(
            serde_json::from_value::<Request>(json!({"action": "permission", "session": session, "request_id": "p", "allow": true}))
                .is_err(),
            "snake_case fields are rejected, not silently ignored"
        );
    }
}
