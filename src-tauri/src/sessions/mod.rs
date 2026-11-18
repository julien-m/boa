//! Coding-session cockpit domain: catalog, pins, actions and provider adapters.
//!
//! Public surface: [`SessionService`] (composed once) and the shared [`rpc`] request
//! vocabulary used by both Tauri commands and the CLI socket.
pub(crate) mod actions;
#[path = "app-link.rs"]
pub(crate) mod app_link;
pub(crate) mod branch;
pub(crate) mod claude;
pub(crate) mod codex;
#[path = "codex-rpc.rs"]
pub(crate) mod codex_rpc;
#[path = "default-actions.rs"]
pub(crate) mod default_actions;
pub(crate) mod model;
pub(crate) mod provider;
pub(crate) mod rpc;
pub(crate) mod service;
pub(crate) mod store;
pub(crate) mod terminal;
pub(crate) mod tools;

pub(crate) use service::SessionService;

use std::path::Path;

/// Composition root for the sessions domain: resolves tools once and wires adapters.
pub(crate) fn compose(config_path: &Path, language: &str) -> Result<SessionService, String> {
    let tools = tools::ToolPaths::discover();
    let store = store::SessionStore::load(config_path.with_file_name("sessions.json"), language)
        .map_err(|e| e.to_string())?;
    let codex = codex::CodexProvider::new(
        tools.codex.clone(),
        tools.child_path.clone(),
        codex_rpc::default_codex_home(),
        app_link::codex_handler().is_some(),
    );
    let claude = claude::ClaudeProvider::new(tools.claude, tools.node, tools.child_path);
    Ok(SessionService::new(store, codex, claude))
}

#[cfg(test)]
#[path = "live-tests.rs"]
mod live_tests;
