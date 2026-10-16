<p align="center"><img src="public/boa.svg" width="76" alt="BOA logo"></p>
<h1 align="center">BOA</h1>
<p align="center">A local macOS cockpit for your projects, files and Git changes.</p>
<p align="center"><a href="https://github.com/julien-m/boa/actions/workflows/quality.yaml"><img src="https://github.com/julien-m/boa/actions/workflows/quality.yaml/badge.svg" alt="Quality checks"></a> <a href="LICENSE">MIT license</a></p>

![BOA dashboard showing project status, pinned projects and Git counters](docs/images/dashboard.png)

![BOA project view with a file tree, highlighted diff and Git history](docs/images/project.png)

BOA helps you see which projects need attention and understand what changed without opening a full IDE. It combines a project dashboard, a read-only file viewer and Git review panes inspired by WebStorm. The interface supports French (default) and English, selectable in Settings.

**A fresh installation starts empty.** BOA does not discover your home folder, import someone else's projects or scan any directory before you choose one. Previously added projects stay on your own Mac.

These screenshots show BOA's actual interface with fictional projects, paths, code and commits. No personal workspace data is included. To regenerate them, start `bun run dev`, then run `bun scripts/capture-demo.ts` with Chrome installed. The capture script supplies in-memory demo data and does not connect to the native app or read its preferences.

## What you can do

- Add folders explicitly, pin projects and sort the dashboard by name, activity or changed files.
- Distinguish files to commit from commits to push; a `?` means the branch has no upstream.
- Browse files, nested repositories and Git worktrees. Read code with local syntax highlighting, including JSON/JSONC, YAML, XML/SVG and TOML/Wrangler configurations.
- Preview Markdown documents or switch to their source.
- Inspect staged/local changes, commit history and a branch's changes since its common ancestor with a base. Compare before/after and jump between changed blocks.
- Use Files, Git or a combined layout; resize the Git panels and hide the file tree.
- Search in a file or across a selected project.
- Open the selected repository in your browser (HTTP(S) and common SSH remotes), or open the project folder in Finder. The web button prefers `origin`, then the first supported remote; it is disabled when none is available. Credentials, query strings and fragments are removed from browser URLs.
- Prepare a small AI context: selected text plus your comment, or just the file path plus your comment. Copy it to an assistant of your choice. No conversation history, model backend or automatic AI submission.
- Let a CLI or coding agent add/pin projects and open a file at exact lines.

BOA is a viewer: it does not edit source files, stage changes, commit, push or check out branches. Remote counters use existing local tracking references; BOA does not run `git fetch` automatically.

## Settings and archives

Open **Réglages / Settings** from the sidebar to optionally select your main projects folder. Its visible direct child directories, including folders without Git, are added at startup and on native filesystem notifications while BOA is open. Symlink aliases are deduplicated by canonical path; pins and existing projects are preserved. No folder is selected by default. Changing or disabling discovery stops additions from the old location and keeps projects already registered. An inaccessible watched folder shows a warning without hiding existing projects.

Use a project's **Archive** button to move it out of the overview and pinned navigation. **Archives** lists those projects and lets you restore them. Automatic discovery keeps them archived; explicitly adding the same project again restores it. Archiving only changes BOA's local list: it never moves, deletes or edits the project folder. Archived projects have no background Git monitoring. Active projects refresh their status on relevant native file notifications, grouped over 750 ms; Git object/log/lock traffic and common dependency caches are filtered. There are no periodic project or Git scans. Returning to BOA or using Refresh performs a reconciliation for missed notifications. Discovery reacts only to changes of direct child directories. Filesystems that do not support native notifications can be refreshed manually; monitoring errors appear in Settings.

Choose **Français** or **English** in Settings to switch immediately. The preference is stored locally; translations and plural rules use i18next/react-i18next with bundled catalogues in [src/locales](src/locales). To add a language, provide matching namespace keys and interpolation parameters, extend the supported language codes and update the language selector and native preference validation.

## Install from source

BOA currently targets **macOS**. CI builds and tests macOS 15 on Apple Silicon and Intel. Windows is not supported by the current Unix CLI implementation; Linux is not a supported desktop target yet.

Requirements:

| Tool | Used for |
| --- | --- |
| Xcode Command Line Tools | Native compiler/SDK and system Git; install with `xcode-select --install` |
| Rust 1.94+ with Cargo | Desktop backend; install through [rustup](https://rustup.rs/) |
| Bun 1.3.9+ | Frontend, build commands and optional CLI; see [Bun installation](https://bun.sh/docs/installation) |
| ripgrep | Project-wide search; with Homebrew: `brew install ripgrep` |

The packaged app does not need Bun or Rust at runtime. It does use system Git, and project search requires ripgrep. BOA checks `PATH` and the usual Apple Silicon/Intel Homebrew locations for ripgrep.

```bash
git clone https://github.com/julien-m/boa.git
cd boa
bun install --frozen-lockfile
bun run mac:build
```

The bundle is generated at `src-tauri/target/release/bundle/macos/BOA.app`. Copy it to `/Applications` or `~/Applications`, then open it. Click **Ajouter un dossier** to choose your first project. Adding a folder does not pin it automatically; use its pin button if you want it in the sidebar.

There is no Apple Developer-signed or notarized public installer yet. CI archives are development artifacts; building from source is the documented installation route. See [Tauri's macOS prerequisites](https://tauri.app/start/prerequisites/#macos) for environment setup.

For local development:

```bash
bun run tauri dev
```

## CLI and coding agents

Install/open BOA.app first. From the source checkout, install the optional command:

```bash
bun link
boa --help
```

Or run `bun scripts/boa.ts ...` without a global link.

```bash
boa projects list --json
boa projects add "$HOME/Projects/my-app" --pin --json
boa projects pin "$HOME/Projects/my-app" --json
boa projects unpin "$HOME/Projects/my-app" --json
boa projects favorite "$HOME/Projects/my-app" --json
boa open "$HOME/Projects/my-app/src/main.ts" --line 12 --end-line 24 --source Codex
```

`favorite`/`unfavorite` are aliases for `pin`/`unpin`: there is one preference, not two competing lists. Short forms such as `boa add <folder>` and `boa pin <folder>` are also available. Use `--dry-run` on navigation or mutation commands to inspect a request without applying it.

Project commands return `{ "ok": true, "result": ... }` with `--json`; failures return `{ "ok": false, "error": ... }` and a nonzero exit code. They launch the installed app if needed and communicate through a per-user Unix socket with owner-only permissions, bounded messages and timeouts. The app owns configuration updates and immediately refreshes its view. The CLI never edits the preferences file behind the app's back.

`open` uses the `boa://open` URL scheme. Its source label can be Codex, Claude, Cursor or CLI; it records a declared sender, not an authenticated AI session. **Reprendre la main** suspends incoming navigation. The file must belong to a registered project.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘F` / `Ctrl+F` | Find in the file; Markdown switches to Source |
| `⌘⇧F` / `Ctrl+⇧F` | Search the selected project |
| `⌘⇧B` / `Ctrl+⇧B` | Open the context dialog |
| `Enter` / `Shift+Enter` in the dialog | Copy context / insert a newline |
| `Escape` or a click outside the dialog | Close the dialog |
| Arrow keys on a panel separator | Resize the corresponding panel |

## Local data and privacy

- The project list is stored in the current user's application-data directory, in `com.julienm.boa/projects.json` (on macOS: `~/Library/Application Support/com.julienm.boa/projects.json`). Layout preferences stay in the app's local webview storage. Neither is bundled with the app or committed to this repository.
- An empty first launch performs no project scan. BOA reads registered projects and an optional explicitly configured discovery folder. Imported configuration from an earlier BOA version remains intact.
- A selected project can contain nested repositories and external Git worktrees. Explicit symbolic links in its file tree can lead outside the project; BOA follows these when you browse them. File contents remain on the Mac until you explicitly copy and share them.
- BOA has no telemetry, hosted project service, embedded AI provider or credential configuration. It runs system Git with argument arrays rather than a shell. Browsing and Git review do not modify the selected repositories.
- The current context dialog stores no history and creates no export files. Older prototypes may have left exports in the local application-data directory; those are not distributed.

## Limits

Text preview supports UTF-8 files up to 2 MiB. Repository discovery inside an explicitly selected project is bounded to 6 levels / 4,000 directories, with dependency/cache directories excluded. History loads 100 commits per page. Project search is literal, respects ignore files, does not follow symbolic links and is limited to 300 results, 20 matches per file and 10 seconds. Bounds and errors are shown in the interface.

Unreadable descendants are skipped during discovery and the scan is marked partial; an unreadable project root still reports an error. Merge commit file lists and previews both compare against the first parent. During a Git conflict, both change sections show our index version (empty when deleted on our side) against the current working file, including any conflict markers.

## Quality and contributions

```bash
bun run check:public
bun run verify
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

For browser UI contracts, start `bun run dev` in another terminal, then run:

```bash
bun run test:ui
```

The UI test uses Chrome by default. For a clean environment, run `bunx playwright install chromium` and `BOA_TEST_BROWSER=chromium bun run test:ui`. It uses a mocked Tauri transport with the real Monaco viewer; native Rust tests exercise real disposable Git repositories, configuration and Unix sockets. No ordinary test needs personal projects, credentials or a GitHub account.

The optional ignored live smoke test reads only a folder you explicitly provide through `BOA_SMOKE_PROJECT`. Do not use personal folders to reproduce a bug when a disposable repository is sufficient.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes and [SECURITY.md](SECURITY.md) for reporting a vulnerability. CI runs locked installs, frontend checks/tests, Rust format/tests/Clippy, browser contracts and desktop builds on both Mac architectures. Passing CI is build/test evidence, not proof of notarization or exhaustive native UI certification.

## License

BOA is available under the [MIT License](LICENSE).
