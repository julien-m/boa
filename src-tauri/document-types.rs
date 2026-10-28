//! Bundle-time fallback types keep source extensions concrete on a clean macOS account.
use plist::{Dictionary, Value};
use serde_json::Value as Json;
use std::collections::BTreeSet;

pub fn generate(config: &Json, original: Value) -> Result<Value, String> {
    let identifier = config["identifier"]
        .as_str()
        .ok_or("Missing bundle identifier")?;
    let mut properties = original
        .into_dictionary()
        .ok_or("Expected macOS property dictionary")?;
    let mut imported = properties
        .remove("UTImportedTypeDeclarations")
        .map(|item| item.into_array().ok_or("Expected imported type array"))
        .transpose()?
        .unwrap_or_default();
    let mut documents = Vec::new();
    for association in config["bundle"]["fileAssociations"]
        .as_array()
        .ok_or("Missing file associations")?
    {
        let mut document = Dictionary::new();
        for (source, target) in [
            ("name", "CFBundleTypeName"),
            ("role", "CFBundleTypeRole"),
            ("rank", "LSHandlerRank"),
        ] {
            if let Some(value) = association[source].as_str() {
                document.insert(target.into(), Value::String(value.into()));
            }
        }
        let extensions: Vec<_> = association["ext"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Json::as_str)
            .collect();
        let mut types: BTreeSet<String> = association["contentTypes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Json::as_str)
            .map(str::to_owned)
            .collect();
        if !extensions.is_empty() {
            // Code editors can receive arbitrary file data; defaults still change only for
            // explicitly selected extensions. This is an Alternate claim, not a default.
            types.insert("public.data".into());
            document.insert(
                "CFBundleTypeExtensions".into(),
                Value::Array(
                    extensions
                        .iter()
                        .map(|extension| Value::String((*extension).into()))
                        .collect(),
                ),
            );
        }
        for extension in extensions {
            if extension.is_empty()
                || !extension
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            {
                return Err("Invalid source extension in bundle configuration".into());
            }
            let kind = format!("{identifier}.source.{extension}");
            let mut tags = Dictionary::new();
            tags.insert(
                "public.filename-extension".into(),
                Value::Array(vec![Value::String(extension.into())]),
            );
            let mut declaration = Dictionary::new();
            declaration.insert("UTTypeIdentifier".into(), Value::String(kind.clone()));
            declaration.insert(
                "UTTypeDescription".into(),
                Value::String(format!("{} source", extension.to_uppercase())),
            );
            declaration.insert(
                "UTTypeConformsTo".into(),
                Value::Array(vec![Value::String("public.source-code".into())]),
            );
            declaration.insert("UTTypeTagSpecification".into(), Value::Dictionary(tags));
            // Imports are fallback descriptions, so system/vendor types keep their priority.
            imported.push(Value::Dictionary(declaration));
            types.insert(kind);
        }
        document.insert(
            "LSItemContentTypes".into(),
            Value::Array(types.into_iter().map(Value::String).collect()),
        );
        documents.push(Value::Dictionary(document));
    }
    properties.insert("UTImportedTypeDeclarations".into(), Value::Array(imported));
    properties.insert("CFBundleDocumentTypes".into(), Value::Array(documents));
    Ok(Value::Dictionary(properties))
}
