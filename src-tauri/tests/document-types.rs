#[path = "../document-types.rs"]
mod document_types;

#[test]
fn bundle_declares_each_supported_extension_without_default_or_shared_type_claims() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let original =
        plist::Value::from_reader_xml(include_bytes!("../info.plist").as_slice()).unwrap();
    let generated =
        serde_json::to_value(document_types::generate(&config, original.clone()).unwrap()).unwrap();
    let original_json = serde_json::to_value(&original).unwrap();
    assert_eq!(
        generated["NSAppTransportSecurity"],
        original_json["NSAppTransportSecurity"]
    );
    let imports = generated["UTImportedTypeDeclarations"].as_array().unwrap();
    let documents = generated["CFBundleDocumentTypes"].as_array().unwrap();
    for (source, document) in config["bundle"]["fileAssociations"]
        .as_array()
        .unwrap()
        .iter()
        .zip(documents)
    {
        assert_eq!(document["LSHandlerRank"].as_str(), source["rank"].as_str());
        for extension in source["ext"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(serde_json::Value::as_str)
        {
            let expected = format!(
                "{}.source.{extension}",
                config["identifier"].as_str().unwrap()
            );
            let declaration = imports
                .iter()
                .find(|value| value["UTTypeIdentifier"].as_str() == Some(expected.as_str()))
                .unwrap();
            assert_eq!(
                declaration["UTTypeTagSpecification"]["public.filename-extension"]
                    .as_array()
                    .unwrap(),
                &[serde_json::Value::String(extension.into())]
            );
            assert!(
                document["LSItemContentTypes"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::Value::String(expected))
            );
        }
    }
    // A different caller-provided extension is declared too, without changing existing keys.
    let mut other = config.clone();
    other["bundle"]["fileAssociations"][0]["ext"] = serde_json::json!(["caller-source"]);
    let generated =
        serde_json::to_value(document_types::generate(&other, original).unwrap()).unwrap();
    let id = format!(
        "{}.source.caller-source",
        other["identifier"].as_str().unwrap()
    );
    assert!(
        generated["UTImportedTypeDeclarations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value["UTTypeIdentifier"].as_str() == Some(id.as_str()))
    );
}
