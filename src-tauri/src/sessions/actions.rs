//! Configurable session action buttons: validation, global/project resolution and templates.
//!
//! Actions only build an instruction for the agent; they never run Git or a shell themselves.
use super::model::{Provider, SessionError, SessionResult};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const MAX_ACTIONS: usize = 50;
const MAX_LABEL: usize = 60;
/// Prompts are instructions, not documents; 8000 chars keeps previews and CLI JSON small.
const MAX_TEMPLATE: usize = 8000;
const MAX_ACTION_ID: usize = 40;

/// What an action button does with its rendered instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ActionMode {
    /// Fill the session composer for review before sending.
    Prepare,
    /// Transmit immediately to the selected session.
    Send,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionDef {
    pub id: String,
    pub label: String,
    pub template: String,
    pub mode: ActionMode,
    pub providers: BTreeSet<Provider>,
    pub enabled: bool,
}

/// Project-level partial override of one inherited action.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<ActionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<BTreeSet<Provider>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

impl ActionPatch {
    fn is_empty(&self) -> bool {
        self == &ActionPatch::default()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProjectActions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
    #[serde(default)]
    pub patches: BTreeMap<String, ActionPatch>,
    #[serde(default)]
    pub added: Vec<ActionDef>,
}

impl ProjectActions {
    pub(crate) fn is_empty(&self) -> bool {
        self.order.is_none() && self.patches.is_empty() && self.added.is_empty()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionsConfig {
    pub global: Vec<ActionDef>,
    #[serde(default)]
    pub projects: BTreeMap<String, ProjectActions>,
}

/// Where a resolved action's effective values come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ActionOrigin {
    Global,
    /// Inherited from global with project-specific changes.
    Overridden,
    /// Exists only in this project.
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedAction {
    #[serde(flatten)]
    pub action: ActionDef,
    pub origin: ActionOrigin,
}

fn validate_id(id: &str) -> SessionResult<()> {
    let valid = !id.is_empty()
        && id.len() <= MAX_ACTION_ID
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(SessionError::invalid(
            "id",
            "use 1-40 lowercase letters, digits or dashes",
        ))
    }
}

fn validate_label(label: &str) -> SessionResult<()> {
    let count = label.trim().chars().count();
    if count == 0 || count > MAX_LABEL {
        return Err(SessionError::invalid("label", "1-60 characters required"));
    }
    Ok(())
}

fn validate_template(template: &str) -> SessionResult<()> {
    let count = template.trim().chars().count();
    if count == 0 || count > MAX_TEMPLATE {
        return Err(SessionError::invalid(
            "template",
            "1-8000 characters required",
        ));
    }
    parse_template(template).map(|_| ())
}

fn validate_providers(providers: &BTreeSet<Provider>) -> SessionResult<()> {
    if providers.is_empty() {
        return Err(SessionError::invalid(
            "providers",
            "select at least one provider",
        ));
    }
    Ok(())
}

impl ActionDef {
    /// Validates every invariant of a stored action.
    pub(crate) fn validate(&self) -> SessionResult<()> {
        validate_id(&self.id)?;
        validate_label(&self.label)?;
        validate_template(&self.template)?;
        validate_providers(&self.providers)
    }

    fn apply(&mut self, patch: &ActionPatch) {
        if let Some(label) = &patch.label {
            self.label = label.clone();
        }
        if let Some(template) = &patch.template {
            self.template = template.clone();
        }
        if let Some(mode) = patch.mode {
            self.mode = mode;
        }
        if let Some(providers) = &patch.providers {
            self.providers = providers.clone();
        }
        if let Some(enabled) = patch.enabled {
            self.enabled = enabled;
        }
    }
}

impl ActionsConfig {
    /// Validates the whole configuration, including uniqueness per level and bounds.
    pub(crate) fn validate(&self) -> SessionResult<()> {
        let global_ids = unique_ids(&self.global)?;
        for (project, overrides) in &self.projects {
            if project.is_empty() {
                return Err(SessionError::invalid("project", "empty project key"));
            }
            let added_ids = unique_ids(&overrides.added)?;
            if let Some(clash) = added_ids.intersection(&global_ids).next() {
                return Err(SessionError::new(
                    "duplicate_action",
                    format!("project action {clash} shadows a global action"),
                ));
            }
            for (id, patch) in &overrides.patches {
                if !global_ids.contains(id) {
                    return Err(SessionError::new(
                        "action_not_found",
                        format!("patch for unknown global action {id}"),
                    ));
                }
                let mut probe = self
                    .global
                    .iter()
                    .find(|a| &a.id == id)
                    .cloned()
                    .ok_or_else(|| SessionError::new("action_not_found", id.clone()))?;
                probe.apply(patch);
                probe.validate()?;
            }
            if self.global.len() + overrides.added.len() > MAX_ACTIONS {
                return Err(SessionError::new("limit_reached", "too many actions"));
            }
        }
        Ok(())
    }

    /// Effective ordered actions for a project (or global when `project` is None).
    pub(crate) fn resolve(&self, project: Option<&str>) -> Vec<ResolvedAction> {
        let overrides = project.and_then(|p| self.projects.get(p));
        let mut resolved: Vec<ResolvedAction> = self
            .global
            .iter()
            .map(|action| {
                let mut action = action.clone();
                let patch = overrides.and_then(|o| o.patches.get(&action.id));
                if let Some(patch) = patch {
                    action.apply(patch);
                }
                ResolvedAction {
                    action,
                    origin: if patch.is_some() {
                        ActionOrigin::Overridden
                    } else {
                        ActionOrigin::Global
                    },
                }
            })
            .collect();
        if let Some(overrides) = overrides {
            resolved.extend(overrides.added.iter().map(|action| ResolvedAction {
                action: action.clone(),
                origin: ActionOrigin::Project,
            }));
            if let Some(order) = &overrides.order {
                // Listed ids first in the chosen order; anything new since then keeps its default slot after them.
                resolved.sort_by_key(|item| {
                    order
                        .iter()
                        .position(|id| id == &item.action.id)
                        .unwrap_or(usize::MAX)
                });
            }
        }
        resolved
    }

    fn level_mut(&mut self, project: Option<&str>) -> Option<&mut ProjectActions> {
        project.map(|p| self.projects.entry(p.to_string()).or_default())
    }

    /// Adds a new action at the global level or as a project-only action.
    pub(crate) fn add(&mut self, project: Option<&str>, action: ActionDef) -> SessionResult<()> {
        action.validate()?;
        if self
            .resolve(project)
            .iter()
            .any(|a| a.action.id == action.id)
            || self.global.iter().any(|a| a.id == action.id)
        {
            return Err(SessionError::new(
                "duplicate_action",
                format!("action {} already exists", action.id),
            ));
        }
        match self.level_mut(project) {
            Some(level) => level.added.push(action),
            None => self.global.push(action),
        }
        self.validate()
    }

    /// Updates an action. At project level, global actions receive a patch; project actions change in place.
    pub(crate) fn update(
        &mut self,
        project: Option<&str>,
        id: &str,
        patch: ActionPatch,
    ) -> SessionResult<()> {
        match project {
            None => {
                let action = self
                    .global
                    .iter_mut()
                    .find(|a| a.id == id)
                    .ok_or_else(|| SessionError::new("action_not_found", id))?;
                action.apply(&patch);
            }
            Some(p) => {
                let is_global = self.global.iter().any(|a| a.id == id);
                let level = self.projects.entry(p.to_string()).or_default();
                if let Some(action) = level.added.iter_mut().find(|a| a.id == id) {
                    action.apply(&patch);
                } else if is_global {
                    let current = level.patches.entry(id.to_string()).or_default();
                    merge_patch(current, patch);
                } else {
                    return Err(SessionError::new("action_not_found", id));
                }
            }
        }
        self.prune();
        self.validate()
    }

    /// Removes a global action (and its project patches) or a project-only action.
    pub(crate) fn remove(&mut self, project: Option<&str>, id: &str) -> SessionResult<()> {
        match project {
            None => {
                let before = self.global.len();
                self.global.retain(|a| a.id != id);
                if before == self.global.len() {
                    return Err(SessionError::new("action_not_found", id));
                }
                remove_global_references(&mut self.projects, |item| item == id);
            }
            Some(p) => {
                let level = self
                    .projects
                    .get_mut(p)
                    .ok_or_else(|| SessionError::new("action_not_found", id))?;
                let before = level.added.len();
                level.added.retain(|a| a.id != id);
                if before == level.added.len() {
                    return Err(SessionError::new(
                        "action_not_project_owned",
                        "global actions are disabled per project, not removed",
                    ));
                }
                if let Some(order) = level.order.as_mut() {
                    order.retain(|item| item != id);
                }
            }
        }
        self.prune();
        self.validate()
    }

    /// Replaces the global actions and drops project references to deleted global IDs.
    /// Invalid replacements are rejected by validation before the store commits them.
    pub(crate) fn replace_global(&mut self, next: Vec<ActionDef>) -> SessionResult<()> {
        // Compare the old and new global IDs so project-owned actions and retained overrides survive.
        let retained_ids: BTreeSet<_> = next.iter().map(|action| action.id.as_str()).collect();
        let removed_ids: BTreeSet<_> = self
            .global
            .iter()
            .map(|action| action.id.as_str())
            .filter(|id| !retained_ids.contains(id))
            .collect();
        if !removed_ids.is_empty() {
            remove_global_references(&mut self.projects, |id| removed_ids.contains(id));
        }
        self.global = next;
        self.validate()
    }

    /// Sets the complete order; every effective id must appear exactly once.
    pub(crate) fn reorder(&mut self, project: Option<&str>, ids: Vec<String>) -> SessionResult<()> {
        let current: BTreeSet<String> = self
            .resolve(project)
            .into_iter()
            .map(|a| a.action.id)
            .collect();
        let requested: BTreeSet<String> = ids.iter().cloned().collect();
        if requested.len() != ids.len() || requested != current {
            return Err(SessionError::invalid(
                "order",
                "list every action exactly once",
            ));
        }
        match self.level_mut(project) {
            Some(level) => level.order = Some(ids),
            None => {
                let mut by_id: BTreeMap<String, ActionDef> =
                    self.global.drain(..).map(|a| (a.id.clone(), a)).collect();
                self.global = ids.iter().filter_map(|id| by_id.remove(id)).collect();
            }
        }
        self.validate()
    }

    /// Drops one project's overrides (all, or only one action's patch) to inherit global values again.
    pub(crate) fn reset(&mut self, project: &str, id: Option<&str>) -> SessionResult<()> {
        match id {
            None => {
                self.projects.remove(project);
            }
            Some(id) => {
                let level = self
                    .projects
                    .get_mut(project)
                    .ok_or_else(|| SessionError::new("action_not_found", id))?;
                if level.patches.remove(id).is_none() {
                    return Err(SessionError::new("action_not_found", id));
                }
            }
        }
        self.prune();
        self.validate()
    }

    fn prune(&mut self) {
        for level in self.projects.values_mut() {
            level.patches.retain(|_, patch| !patch.is_empty());
        }
        self.projects.retain(|_, level| !level.is_empty());
    }
}

fn remove_global_references(
    projects: &mut BTreeMap<String, ProjectActions>,
    is_removed: impl Fn(&str) -> bool,
) {
    projects.retain(|_, level| {
        let was_empty = level.is_empty();
        level.patches.retain(|id, _| !is_removed(id));
        if let Some(order) = &mut level.order {
            order.retain(|id| !is_removed(id));
        }
        was_empty || !level.is_empty()
    });
}

fn merge_patch(current: &mut ActionPatch, next: ActionPatch) {
    if next.label.is_some() {
        current.label = next.label;
    }
    if next.template.is_some() {
        current.template = next.template;
    }
    if next.mode.is_some() {
        current.mode = next.mode;
    }
    if next.providers.is_some() {
        current.providers = next.providers;
    }
    if next.enabled.is_some() {
        current.enabled = next.enabled;
    }
}

fn unique_ids(actions: &[ActionDef]) -> SessionResult<BTreeSet<String>> {
    if actions.len() > MAX_ACTIONS {
        return Err(SessionError::new("limit_reached", "too many actions"));
    }
    let mut ids = BTreeSet::new();
    for action in actions {
        action.validate()?;
        if !ids.insert(action.id.clone()) {
            return Err(SessionError::new(
                "duplicate_action",
                format!("duplicate action {}", action.id),
            ));
        }
    }
    Ok(ids)
}

/// Template variables. French and English spellings are equivalent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TemplateVariable {
    Project,
    Branch,
    File,
    Selection,
}

impl TemplateVariable {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "projet" | "project" => Some(Self::Project),
            "branche" | "branch" => Some(Self::Branch),
            "fichier" | "file" => Some(Self::File),
            "sélection" | "selection" => Some(Self::Selection),
            _ => None,
        }
    }
}

enum Segment<'a> {
    Text(&'a str),
    Variable(TemplateVariable),
}

/// Splits a template into literal text and `{variable}` placeholders. `{{` and `}}` escape braces.
fn parse_template(template: &str) -> SessionResult<Vec<Segment<'_>>> {
    let mut segments = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find(['{', '}']) {
        let (before, tail) = rest.split_at(start);
        if !before.is_empty() {
            segments.push(Segment::Text(before));
        }
        if tail.starts_with("{{") || tail.starts_with("}}") {
            segments.push(Segment::Text(&tail[..1]));
            rest = &tail[2..];
            continue;
        }
        if tail.starts_with('}') {
            return Err(SessionError::invalid("template", "unmatched }"));
        }
        let end = tail
            .find('}')
            .ok_or_else(|| SessionError::invalid("template", "unclosed {"))?;
        let name = &tail[1..end];
        let variable = TemplateVariable::parse(name).ok_or_else(|| {
            SessionError::new("unknown_variable", format!("unknown variable {{{name}}}"))
        })?;
        segments.push(Segment::Variable(variable));
        rest = &tail[end + 1..];
    }
    if !rest.is_empty() {
        segments.push(Segment::Text(rest));
    }
    Ok(segments)
}

/// Values available when an action is triggered; absent values stay absent, never invented.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TemplateValues {
    pub project: Option<String>,
    pub branch: Option<String>,
    pub file: Option<String>,
    pub selection: Option<String>,
}

impl TemplateValues {
    fn get(&self, variable: TemplateVariable) -> Option<&str> {
        match variable {
            TemplateVariable::Project => self.project.as_deref(),
            TemplateVariable::Branch => self.branch.as_deref(),
            TemplateVariable::File => self.file.as_deref(),
            TemplateVariable::Selection => self.selection.as_deref(),
        }
    }
}

/// Renders a template, failing with every missing variable instead of emitting an empty slot.
pub(crate) fn render(template: &str, values: &TemplateValues) -> SessionResult<String> {
    let mut output = String::with_capacity(template.len());
    let mut missing = BTreeSet::new();
    for segment in parse_template(template)? {
        match segment {
            Segment::Text(text) => output.push_str(text),
            Segment::Variable(variable) => match values.get(variable) {
                Some(value) => output.push_str(value),
                None => {
                    missing.insert(variable);
                }
            },
        }
    }
    if !missing.is_empty() {
        let names: Vec<&str> = missing
            .iter()
            .map(|v| match v {
                TemplateVariable::Project => "project",
                TemplateVariable::Branch => "branch",
                TemplateVariable::File => "file",
                TemplateVariable::Selection => "selection",
            })
            .collect();
        return Err(SessionError::new("missing_variable", names.join(",")));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(id: &str) -> ActionDef {
        ActionDef {
            id: id.into(),
            label: id.to_uppercase(),
            template: format!("Do {id} on {{branch}}"),
            mode: ActionMode::Prepare,
            providers: Provider::ALL.into_iter().collect(),
            enabled: true,
        }
    }

    fn config() -> ActionsConfig {
        ActionsConfig {
            global: vec![action("review"), action("tests")],
            projects: BTreeMap::new(),
        }
    }

    #[test]
    fn project_patch_overrides_only_that_project_and_reset_restores_inheritance() {
        let mut cfg = config();
        cfg.update(
            Some("/p"),
            "tests",
            ActionPatch {
                mode: Some(ActionMode::Send),
                ..Default::default()
            },
        )
        .unwrap();
        let project = cfg.resolve(Some("/p"));
        assert_eq!(project[1].action.mode, ActionMode::Send);
        assert_eq!(project[1].origin, ActionOrigin::Overridden);
        assert_eq!(cfg.resolve(None)[1].action.mode, ActionMode::Prepare);
        assert_eq!(
            cfg.resolve(Some("/other"))[1].action.mode,
            ActionMode::Prepare
        );
        cfg.reset("/p", Some("tests")).unwrap();
        assert!(cfg.projects.is_empty());
        assert_eq!(cfg.resolve(Some("/p"))[1].origin, ActionOrigin::Global);
    }

    #[test]
    fn global_changes_propagate_to_projects_without_patch() {
        let mut cfg = config();
        cfg.add(Some("/p"), action("changelog")).unwrap();
        cfg.update(
            None,
            "review",
            ActionPatch {
                label: Some("Revue".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let resolved = cfg.resolve(Some("/p"));
        assert_eq!(resolved[0].action.label, "Revue");
        assert_eq!(resolved[2].origin, ActionOrigin::Project);
    }

    #[test]
    fn reorder_requires_each_effective_action_once() {
        let mut cfg = config();
        assert!(cfg.reorder(None, vec!["tests".into()]).is_err());
        assert!(
            cfg.reorder(None, vec!["tests".into(), "tests".into()])
                .is_err()
        );
        cfg.reorder(Some("/p"), vec!["tests".into(), "review".into()])
            .unwrap();
        assert_eq!(cfg.resolve(Some("/p"))[0].action.id, "tests");
        assert_eq!(cfg.resolve(None)[0].action.id, "review");
    }

    #[test]
    fn duplicate_ids_invalid_values_and_global_removal_from_project_are_rejected() {
        let mut cfg = config();
        assert_eq!(
            cfg.add(Some("/p"), action("review")).unwrap_err().code,
            "duplicate_action"
        );
        let mut bad = action("x");
        bad.providers.clear();
        assert!(cfg.add(None, bad).is_err());
        assert_eq!(
            cfg.remove(Some("/p"), "review").unwrap_err().code,
            "action_not_found"
        );
        cfg.update(
            Some("/p"),
            "review",
            ActionPatch {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            cfg.remove(Some("/p"), "review").unwrap_err().code,
            "action_not_project_owned"
        );
        cfg.remove(None, "review").unwrap();
        assert!(cfg.projects.is_empty());
    }

    #[test]
    fn templates_render_bilingual_variables_and_report_missing_values() {
        let values = TemplateValues {
            project: Some("cedar".into()),
            branch: Some("feature/x".into()),
            ..Default::default()
        };
        assert_eq!(
            render("Sur {projet}, branche {branch} {{ok}}", &values).unwrap(),
            "Sur cedar, branche feature/x {ok}"
        );
        let missing = render("{fichier} {sélection}", &values).unwrap_err();
        assert_eq!(missing.code, "missing_variable");
        assert_eq!(missing.message, "file,selection");
        assert_eq!(
            render("{nope}", &values).unwrap_err().code,
            "unknown_variable"
        );
        assert!(render("open {", &values).is_err());
    }
}
