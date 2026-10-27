// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = boa_lib::codex_open_entry() {
        std::process::exit(code);
    }
    boa_lib::run()
}
