//! Targeted, comment-preserving edits to the user's desktop handler configuration.
use base64::{Engine, engine::general_purpose::STANDARD};
use std::path::Path;
use toml_edit::{Array, Document, Item, Table, value};

fn table<'a>(item: &'a mut Item, name: &str) -> Result<&'a mut Item, String> {
    if item.is_none() {
        *item = Item::Table(Table::new());
    }
    if item.as_inline_table().is_some() {
        // A TOML table cannot be inserted into an InlineTable: it would disappear on display.
        // Expand only tables BOA edits; preserve their existing keys and values.
        *item = Item::Table(
            std::mem::take(item)
                .into_table()
                .map_err(|_| format!("Invalid Codex configuration table: {name}"))?,
        );
    }
    if item.as_table_like().is_none() {
        return Err(format!("Invalid Codex configuration table: {name}"));
    }
    Ok(item)
}

fn icon() -> String {
    format!(
        "data:image/png;base64,{}",
        STANDARD.encode(include_bytes!("../icons/128x128.png"))
    )
}

fn parse(text: &str) -> Result<Document, String> {
    text.parse()
        .map_err(|_| "Invalid Codex TOML configuration".into())
}

fn at<'a>(document: &'a Document, keys: &[&str]) -> &'a Item {
    keys.iter()
        .try_fold(document.as_item(), |item, key| item.get(*key))
        .unwrap_or(&Item::None)
}

fn field<'a>(item: &'a Item, key: &str) -> &'a Item {
    item.get(key).unwrap_or(&Item::None)
}

fn configure(text: &str, executable: &Path) -> Result<String, String> {
    let mut document = parse(text)?;
    let desktop = table(&mut document["desktop"], "desktop")?;
    let handlers = table(&mut desktop["custom_file_handlers"], "custom_file_handlers")?;
    // BOA owns only its handler. Other handlers and desktop options stay intact.
    let mut handler = Table::new();
    handler["label"] = value("BOA");
    handler["icon"] = value(icon());
    handler["command"] = value(executable.to_str().ok_or("Invalid BOA application path")?);
    let mut args = Array::new();
    args.push("--codex-open");
    handler["args"] = value(args);
    handler["input"] = value("json_argument");
    handler["supports_ssh"] = value(false);
    handlers["boa"] = Item::Table(handler);
    let preferences = table(
        &mut desktop["open-in-target-preferences"],
        "open-in-target-preferences",
    )?;
    preferences["global"] = value("custom:boa");
    if preferences.get("perPath").is_some() {
        let paths = table(&mut preferences["perPath"], "perPath")?;
        for (_, target) in paths.as_table_like_mut().unwrap().iter_mut() {
            if target.as_str().is_none() {
                return Err("Invalid Codex per-project editor preference".into());
            }
            *target = value("custom:boa");
        }
    }
    Ok(document.to_string())
}

pub(crate) fn configured(path: &Path, executable: &Path) -> Result<bool, String> {
    let text = crate::editor_integrations::read_private(path)?;
    let document = parse(&text)?;
    let handler = at(&document, &["desktop", "custom_file_handlers", "boa"]);
    let preferences = at(&document, &["desktop", "open-in-target-preferences"]);
    Ok(field(handler, "label").as_str() == Some("BOA")
        && field(handler, "command").as_str() == executable.to_str()
        && field(handler, "icon").as_str() == Some(icon().as_str())
        && field(handler, "args").as_array().is_some_and(|args| {
            args.len() == 1 && args.get(0).and_then(|v| v.as_str()) == Some("--codex-open")
        })
        && field(handler, "input").as_str() == Some("json_argument")
        && field(handler, "supports_ssh").as_bool() == Some(false)
        && field(preferences, "global").as_str() == Some("custom:boa")
        && (field(preferences, "perPath").is_none()
            || field(preferences, "perPath")
                .as_table_like()
                .is_some_and(|paths| {
                    paths
                        .iter()
                        .all(|(_, target)| target.as_str() == Some("custom:boa"))
                })))
}

pub(crate) fn apply(path: &Path, executable: &Path, backup: &Path) -> Result<bool, String> {
    let previous = crate::editor_integrations::read_private(path)?;
    let next = configure(&previous, executable)?;
    if configured(path, executable)? {
        return Ok(false);
    }
    // Save only settings that this operation replaces, never unrelated configuration secrets.
    if !backup.exists() {
        let original = parse(&previous)?;
        let mut saved = Document::new();
        let desktop = table(&mut saved["desktop"], "desktop")?;
        let handler = at(&original, &["desktop", "custom_file_handlers", "boa"]);
        if !handler.is_none() {
            let handlers = table(&mut desktop["custom_file_handlers"], "custom_file_handlers")?;
            handlers["boa"] = handler.clone();
        }
        let preferences = at(&original, &["desktop", "open-in-target-preferences"]);
        if !preferences.is_none() {
            desktop["open-in-target-preferences"] = preferences.clone();
        }
        crate::editor_integrations::write_private(backup, &saved.to_string(), None)?;
    }
    crate::editor_integrations::write_private(path, &next, Some(&previous))?;
    if !configured(path, executable)? {
        return Err("Codex configuration could not be verified".into());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn setup_preserves_other_settings_comments_and_handlers_and_is_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        let backup = temp.path().join("backup.toml");
        let original = "# Keep this comment\nmodel = 'example'\n[desktop.custom_file_handlers.other]\nlabel = 'Other'\ncommand = '/other'\n[desktop.open-in-target-preferences]\nglobal = 'webstorm'\n[desktop.open-in-target-preferences.perPath]\n'/project' = 'zed'\n";
        fs::write(&path, original).unwrap();
        let executable = temp
            .path()
            .join("Application With Spaces.app/Contents/MacOS/boa");
        assert!(apply(&path, &executable, &backup).unwrap());
        let result = fs::read_to_string(&path).unwrap();
        assert!(result.contains("# Keep this comment"));
        let document = parse(&result).unwrap();
        assert_eq!(document["model"].as_str(), Some("example"));
        assert_eq!(
            document["desktop"]["custom_file_handlers"]["other"]["label"].as_str(),
            Some("Other")
        );
        assert!(configured(&path, &executable).unwrap());
        assert!(!apply(&path, &executable, &backup).unwrap());
        let saved = fs::read_to_string(backup).unwrap();
        assert!(
            saved.contains("webstorm") && !saved.contains("model"),
            "{saved}"
        );
        let empty = temp.path().join("empty.toml");
        assert!(!configured(&empty, &executable).unwrap());
        assert!(apply(&empty, &executable, &temp.path().join("empty-before.toml")).unwrap());
        assert!(configured(&empty, &executable).unwrap());
        assert!(configure("desktop = 'broken'", &executable).is_err());
        assert!(
            configure(
                "[desktop.open-in-target-preferences]\nperPath = 42",
                &executable
            )
            .is_err()
        );
    }

    #[test]
    fn setup_keeps_handlers_in_inline_desktop_configuration() {
        let executable = Path::new("/Applications/BOA.app/Contents/MacOS/boa");
        for text in [
            "[desktop]\ncustom_file_handlers = {other = {label = 'Other', command='/other'}}\n",
            "desktop = {custom_file_handlers = {other = {label = 'Other', command='/other'}}, open-in-target-preferences = {global='zed', perPath = {'/project'='zed'}}}\n",
        ] {
            let next = configure(text, executable).unwrap();
            let parsed = parse(&next).unwrap();
            assert_eq!(
                at(
                    &parsed,
                    &["desktop", "custom_file_handlers", "boa", "command"]
                )
                .as_str(),
                executable.to_str()
            );
            assert_eq!(
                at(
                    &parsed,
                    &["desktop", "custom_file_handlers", "other", "command"]
                )
                .as_str(),
                Some("/other")
            );
            assert_eq!(
                at(
                    &parsed,
                    &["desktop", "open-in-target-preferences", "global"]
                )
                .as_str(),
                Some("custom:boa")
            );
        }
    }
}
