#[path = "document-types.rs"]
mod document_types;

fn main() {
    println!("cargo:rerun-if-changed=info.plist");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=document-types.rs");
    let config =
        serde_json::from_slice(&std::fs::read("tauri.conf.json").expect("bundle configuration"))
            .expect("valid bundle configuration");
    let original = plist::Value::from_file("info.plist").expect("additional macOS properties");
    let generated =
        document_types::generate(&config, original).expect("macOS document declarations");
    std::fs::create_dir_all("target").expect("build output directory");
    // Cargo can build multiple profiles concurrently. Replace a complete plist atomically.
    let path = std::path::Path::new("target/editor-integrations.plist");
    let mut bytes = Vec::new();
    generated
        .to_writer_xml(&mut bytes)
        .expect("encode macOS properties");
    if std::fs::read(path).ok().as_deref() != Some(bytes.as_slice()) {
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&temporary, bytes).expect("write macOS properties");
        std::fs::rename(temporary, path).expect("publish macOS properties");
    }
    ensure_claude_bridge();
    tauri_build::build()
}

/// The Claude Code bridge is generated from `scripts/claude-bridge.ts` (`bun run build:bridge`,
/// part of `bun run build`). A fresh checkout running Cargo first generates it here, because the
/// bundle declares it as a resource. Contract: `bun build` exits 0 and writes the file.
fn ensure_claude_bridge() {
    let bridge = std::path::Path::new("resources/claude-bridge.mjs");
    println!("cargo:rerun-if-changed=../scripts/claude-bridge.ts");
    println!("cargo:rerun-if-changed=resources/claude-bridge.mjs");
    if bridge.is_file() {
        return;
    }
    let status = std::process::Command::new("bun")
        .args(["run", "build:bridge"])
        .current_dir("..")
        .status();
    if !matches!(status, Ok(status) if status.success()) || !bridge.is_file() {
        panic!(
            "Missing resources/claude-bridge.mjs: run `bun install && bun run build:bridge` first."
        );
    }
}
