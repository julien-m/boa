//! Localized example actions seeded once into a fresh store; users edit or delete them freely.
use super::actions::{ActionDef, ActionMode};
use super::model::Provider;

struct Example {
    id: &'static str,
    label_fr: &'static str,
    label_en: &'static str,
    template_fr: &'static str,
    template_en: &'static str,
}

/// Examples only reference variables resolved at trigger time; no branch name is hardcoded.
const EXAMPLES: [Example; 4] = [
    Example {
        id: "review",
        label_fr: "Review",
        label_en: "Review",
        template_fr: "Relis les changements de {projet} sur la branche {branche} : signale les bugs, régressions et tests manquants, sans modifier les fichiers.",
        template_en: "Review the changes in {project} on branch {branch}: report bugs, regressions and missing tests without modifying files.",
    },
    Example {
        id: "tests",
        label_fr: "Tests",
        label_en: "Tests",
        template_fr: "Lance les tests pertinents de {projet} sur la branche {branche} et résume les échecs avec leur cause probable.",
        template_en: "Run the relevant tests of {project} on branch {branch} and summarize failures with their likely cause.",
    },
    Example {
        id: "summary",
        label_fr: "Résumer",
        label_en: "Summarize",
        template_fr: "Résume où en est cette session : ce qui est fait, ce qui reste, et les décisions en attente.",
        template_en: "Summarize where this session stands: what is done, what remains and pending decisions.",
    },
    Example {
        id: "commit-push",
        label_fr: "Commit & push",
        label_en: "Commit & push",
        template_fr: "Sur {projet}, branche {branche} :\n1. Lance les vérifications du projet. Arrête-toi si l'une échoue.\n2. Montre-moi le résultat et le message de commit proposé.\n3. Après mon accord, commit puis push vers {branche}. Ne pousse vers aucune autre branche.",
        template_en: "On {project}, branch {branch}:\n1. Run the project checks. Stop if one fails.\n2. Show me the result and the proposed commit message.\n3. After my approval, commit then push to {branch}. Do not push to any other branch.",
    },
];

/// Returns the example actions in the interface language (`fr` default, otherwise English).
pub(crate) fn defaults(language: &str) -> Vec<ActionDef> {
    let french = language != "en";
    EXAMPLES
        .iter()
        .map(|example| ActionDef {
            id: example.id.into(),
            label: if french {
                example.label_fr
            } else {
                example.label_en
            }
            .into(),
            template: if french {
                example.template_fr
            } else {
                example.template_en
            }
            .into(),
            mode: ActionMode::Prepare,
            providers: Provider::ALL.into_iter().collect(),
            enabled: true,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn examples_are_valid_in_both_languages() {
        for language in ["fr", "en"] {
            let actions = super::defaults(language);
            assert_eq!(actions.len(), 4);
            for action in actions {
                action.validate().unwrap();
            }
        }
    }
}
