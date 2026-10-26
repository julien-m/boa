<p align="center"><img src="public/boa.svg" width="76" alt="BOA logo"></p>
<h1 align="center">BOA</h1>
<p align="center">A local macOS cockpit for your projects, files and Git changes.</p>
<p align="center"><a href="https://github.com/julien-m/boa/actions/workflows/quality.yaml"><img src="https://github.com/julien-m/boa/actions/workflows/quality.yaml/badge.svg" alt="Quality checks"></a> <a href="LICENSE">MIT license</a></p>

![BOA dashboard showing project status, pinned projects and Git counters](docs/images/dashboard.png)

![BOA project view with a file tree, highlighted diff and Git history](docs/images/project.png)

BOA helps you see which projects need attention and understand what changed without opening a full IDE. It combines a project dashboard, a file viewer with an explicit editing mode and Git review panes inspired by WebStorm. The interface supports French (default) and English, selectable in Settings.

**A fresh installation starts empty.** BOA does not discover your home folder, import someone else's projects or scan any directory before you choose one. Previously added projects stay on your own Mac.

These screenshots show BOA's actual interface with fictional projects, paths, code and commits. No personal workspace data is included. To regenerate them, start `bun run dev`, then run `bun scripts/capture-demo.ts` with Chrome installed. The capture script supplies in-memory demo data and does not connect to the native app or read its preferences.

## User guide

- [Start with an empty workspace](#quick-start)
- [Projects, dashboard and layouts](#projects-dashboard-and-layouts)
- [Read files and Markdown](#reading-files-and-markdown)
- [Browse and inspect images](#images-library-and-comparison)
- [Use context menus and navigation history](#context-menus-and-navigation-history)
- [Find text and go to a line](#finding-text-and-going-to-a-line)
- [Edit, save and recover a draft](#editing-saving-and-drafts)
- [Follow a persistent context view](#context-views-and-bookmarks)
- [Review Git changes and history](#reviewing-git)
- [Configure discovery, archives and language](#settings-and-archives)
- [Install, sign and update BOA](#install-from-source)
- [Use BOA from a CLI or coding agent](#cli-and-coding-agents)
- [Organize file spaces and search across folders](#file-spaces-and-focused-browsing)
- [Look up keyboard shortcuts](#keyboard-shortcuts)
- [Understand local data, privacy and limits](#local-data-and-privacy)
- [Build and test the project](#quality-and-contributions)

## Quick start

1. Install and open BOA using the [source installation instructions](#install-from-source).
2. Choose **Add a project** and select an existing folder. Any folder can be registered; Git is optional. Nothing is scanned before you choose a folder.
3. Open its project card. Single-click a file for a preview, or double-click to retain its tab. Reading is the default.
4. Click inside the reader and type a word to find it, or type a number to reveal that source line. Press **Escape** to close the navigation bar and keep the reached position.
5. Choose **Files**, **Git** or **Mixed** for the task at hand. Use **Context** to read a prepared explanation spanning several passages and files.
6. To change a file, explicitly click **Read-only** to enter editing, then save with **Cmd/Ctrl+S** or cancel. A read-only search never changes the file.

For folders that should be browsed together without Git discovery, create a [file space](#file-spaces-and-focused-browsing) instead of registering a parent directory as a project.

## What you can do

- Add folders explicitly, pin projects and sort the dashboard by name, activity or changed files.
- Distinguish files to commit from commits to push; a `?` means the branch has no upstream.
- Browse files, nested repositories and Git worktrees. Read code with local syntax highlighting, including JavaScript ES modules (`.mjs`), JSON/JSONC, YAML, XML/SVG and TOML/Wrangler configurations.
- Preview Markdown documents with local PNG, JPEG, GIF, WebP and SVG images, or switch to their source. Local image paths resolve relative to the document, stay within the registered project and are limited to 32 MiB each. HTTP(S) images and badges load directly from their URLs when previewing a document, without sending a referrer. Sanitized HTML supports embedded `<img>` tags and their dimensions; scripts and active HTML are removed. Failed images fall back to their descriptions.
- Inspect staged/local changes, commit history and a branch's changes since its common ancestor with a base. Compare before/after and jump between changed blocks.
- Click the **Read-only** label to edit in place, preserving the editor position; save explicitly (Cmd/Ctrl+S), undo/redo, or cancel. Edits stay in the same editor. Cancel asks before discarding changes. Unsaved drafts survive tab/project navigation during the session and remain reachable from the Drafts menu. Files changed externally are not silently overwritten. Git diffs stay read-only; editing is restricted to existing UTF-8 files inside the project (2 MB maximum), excluding Git metadata and external symlink targets. On macOS, atomic saves retain extended attributes, ACLs, owner/group and permissions; an inability to preserve metadata aborts the save.
- Use Files, Git or a combined layout; resize the file tree and Git panels, and hide the file tree. Single-click a file for a temporary preview; double-click to keep it in a tab. Switch between open tabs or close them individually. Retained source tabs preserve their cursor, scroll position and undo history; editing keeps a preview tab open.
- Search in a file or across a selected project.
- Type directly in a read-only reader to search text or jump to a source line, with explicit find and line shortcuts available in editing too.
- Follow persistent context views: an ordered code walkthrough or a set of findings, with descriptions, highlighted passages and a return to the previous reading position.
- Open the selected repository in your browser (HTTP(S) and common SSH remotes), or open the project folder in Finder. The web button prefers `origin`, then the first supported remote; it is disabled when none is available. Credentials, query strings and fragments are removed from browser URLs.
- Prepare a small AI context: selected text plus your comment, or just the file path plus your comment. Copy it to an assistant of your choice. No conversation history, model backend or automatic AI submission.
- Let a CLI or coding agent add/pin projects and open a file at exact lines.

Source files can be edited only after explicitly switching out of Read-only mode. Git views do not stage changes, commit, push or check out branches. Remote counters use existing local tracking references; BOA does not run `git fetch` automatically.

## Projects, dashboard and layouts

The overview lists active projects and their local Git state. Sort by name, recent activity or changed files, switch the display layout, search project names, or show only projects needing review. Pin a project to keep it in the sidebar; adding a folder alone does not pin it. Projects with the same physical path are deduplicated.

The counters distinguish **files to commit** from **commits to push**. An upstream-less branch has an unknown remote count, shown as `?`; it does not mean zero changes. On Overview, typing outside inputs, menus and dialogs focuses **Search projects** and includes the first character in the filter. A folder may contain more than one repository or Git worktree. Select the relevant repository in the Git panel before interpreting its branch or changes.

Inside a project, choose **Files** for reading, **Git** for review, or **Mixed** for both. Drag the panel separators to resize them, or focus a separator and use the arrow keys. The file tree can be hidden; a dedicated reopen button stays accessible. Collapsing keeps expanded folders and the reader mounted, with a short transition that respects reduced-motion preferences. The selected layout is remembered locally. **Finder** opens the project folder. **Open repository** opens a supported remote in the default browser, preferring `origin`; it is disabled when there is no supported remote. BOA strips credentials, query strings and fragments from that URL.

## Reading files and Markdown

Single-click opens a temporary preview tab. Opening another file can replace that preview; double-click retains it. Editing also retains a preview tab. Retained source tabs preserve their cursor, scroll position and undo history during the session. Closing a tab does not delete the file.

Source files use local syntax highlighting and soft wrapping. The copy controls can copy a selected passage or the complete displayed file with its location. Select a passage before using **Copy selection**. Git diffs offer before/after display and previous/next changed-block controls.

Markdown files normally open as a rendered preview. **Source / Preview** switches representations; editing uses source. Markdown previews sanitize HTML and support local PNG, JPEG, GIF, WebP and SVG images. Local image references resolve relative to the document, must stay inside its registered root and are limited to 32 MiB each. HTTP(S) images and badges load from their original URLs without a referrer; unavailable images fall back to their descriptions. Scripts and active HTML are removed.

Markdown links to local files open inside BOA, relative to the current document. Heading anchors work within the document and across linked files; repeated titles receive distinct anchors. A target outside the current root must belong to another registered project or space; an archived target project is restored before its file opens. Existing drafts are preserved. External URLs retain the copy-link action.

Wide Markdown tables use intrinsic column widths in a separate, keyboard-focusable horizontal scroll area. Hover or focus a table, fenced code/diagram block or image to reveal **Expand**. It opens that block in a modal filling the BOA window. **Expand** above the preview opens the entire document at full available width. Escape or Close returns to the same reader position, including table scrolling. Diagram fences remain code unless their source already renders an image; expansion does not add a diagram renderer.

External changes refresh open files through native filesystem notifications. BOA tries to keep the same visible passage using a text anchor when lines are inserted above it; if the passage disappears, it retains a nearby position. Editing drafts remain intact and report a conflict instead of being replaced.

## Images, Library and comparison

Select a PNG, JPEG, GIF, WebP or SVG file in a project or file-space tree to preview it. Full-image previews accept files up to 32 MiB. SVG retains explicit Source/editing access within the 2 MiB text limit. Unknown extensions containing valid UTF-8 text keep the text reader. Unsupported formats, including videos, and invalid or oversized images offer **Open with macOS**; the associated application opens only after you choose that action.

### Zoom, fullscreen and pixel inspection

Image previews and individually expanded Markdown images share the same controls:

| Control | Use |
| --- | --- |
| **− / +** and zoom slider | Choose a manual scale between 25% and 1600%; large images remain scrollable |
| Percentage | Click to return to intrinsic 100% size |
| **Fit** | Enlarge or reduce the image to fill the available viewport without cropping, even beyond the manual zoom limit |
| Fullscreen icon | Expand the image within the BOA window; Escape or Close restores the reader and focus |
| Background | Select the default background, transparency checkerboard, white, black or a custom color; reset when finished |
| Eyedropper | Sample an intrinsic image pixel and copy HEX, including alpha when needed, with an RGBA confirmation |
| Pixel grid | At 400% and above, show a grid with crisp pixels for inspection |

Numeric zoom is independent of window size. Fit recalculates when its viewport changes. The fullscreen view shares zoom/Fit with the reader. Dimensions and file size are shown; remote images without reliable size metadata show that size as unavailable. Browser restrictions can prevent eyedropper access to remote pixels; BOA reports the limitation instead of inventing a color. These tools change only the view, never the file's dimensions, pixels or metadata.

### Browse a folder's image library

Open **Library** next to Files to list images in the current root or chosen folder and its descendants. The library follows the folder selected in the tree; use its breadcrumbs to move back to a parent. Choose a format and filter filename/path using words separated by spaces or `+`: every word must match, ignoring case and accents. The Library toolbar shares its saved root sort with the file tree.

Click a thumbnail to open an overlay above the grid. Browse the filtered images with **Previous / Next**, **Left / Right** or **Page Up / Page Down**. The viewer retains the chosen zoom, including the precise percentage computed by Fit, when moving between images; choose Fit again to adapt the next image. Background and grid choices also remain with the library browsing session. Escape returns to the same grid. **Open in Files** opens the main reader explicitly. **Reveal in file tree** opens the containing folder, selects the image and focuses it. Returning to Library preserves filters and scroll position.

Thumbnails load progressively in batches of 48. **Load all** displays every image returned by the bounded scan while retaining lazy thumbnail loading, including new results after refresh. Changing the folder, format or name filter resets the batch size. An unavailable thumbnail remains openable in the viewer. Right-click a thumbnail or enlarged preview, or press **Shift+F10**, to reveal its image in Finder without leaving the gallery.

Library discovery respects visibility preferences, skips technical folders and links, and reports partial results. It is bounded to 500 images, 10,000 visited entries, 24 levels and three seconds. Raster thumbnail sources are limited to 32 MiB, 8,192 pixels per side and 128 MiB of decode allocations. Thumbnails are at most 160 pixels; large or unsupported thumbnail sources fall back to an icon. Full-image preview limits still apply separately. Library browsing creates no persistent filesystem index.

### Compare two images

Choose **Compare two images** in an image preview or its context menu, then select the second local image with the native picker. The picker starts in the current image's project folder, falling back to the project root. The second image is limited to 8 MiB. Compare side by side or with a wipe slider, using a common scale that preserves each image's aspect ratio. The comparison is a separate view; neither original is modified.

## Context menus and navigation history

Right-click a file, folder or pinned item, or focus it and press **Shift+F10**, for BOA actions: reveal in Finder, open with the associated application, open in BOA, keep a tab, copy its name/relative path/absolute path, pin or prepare a context message. Images add fullscreen and comparison; folders add their library and search. Menus and hover/keyboard hints follow the selected application language. Tree selection remains visible when focus leaves the tree. These menus do not rename, move or delete files.

**Add to a file space…** creates a space prefilled with the selected item's name and path, or appends it to an existing space. Confirm the proposed name or edit it. Adding one file registers that individual file without its siblings. Existing entries are preserved and duplicate paths ignored.

Use the mouse back/forward buttons, **Alt+Left / Alt+Right**, or **Cmd+[ / Cmd+]** outside editing controls to revisit a view, file, folder or Files/Library view. Native horizontal swipe navigation on macOS, including Logitech Back/Forward actions, feeds the same history even when the file viewer has focus. The listener is local to BOA; vertical gestures and other windows are unaffected. No navigation buttons are added to the title bar.

Navigation history belongs to the current app session and retains up to 100 visits. Going back and opening something different replaces forward history. Drafts remain available. Changing filters or zoom does not add history entries. This history is distinct from **Back to my reading** inside a context walkthrough and from the Git commit-history panel.

## Finding text and going to a line

The reader has one small navigation bar at the upper right. It stays hidden until requested. With the read-only reader focused, ordinary typing starts navigation immediately:

| Input | Result |
| --- | --- |
| `annual` | Find text, ignoring case by default |
| `1`, then `1`, then `5` | Reveal line 1, then 11, then 115; no Enter is needed |
| A leading space, then `115` | Find the text `115`; the first space is a command prefix and is consumed |
| **Cmd/Ctrl+F** | Force text search, including a digits-only query; spaces typed into this explicit search remain literal |
| **Cmd/Ctrl+L** | Force source-line navigation |

Text search highlights occurrences and shows a match counter. Use its previous/next arrows or **Enter / Shift+Enter** to move between matches. Use the case control when a case-sensitive match is needed. An empty query or no matches does not require a dialog or confirmation.

**Escape clears and closes the reader bar in one press.** It leaves the reader at the reached passage, and the next typing starts with an empty query. An invalid or nonexistent line leaves the current position unchanged; a subtle field state may indicate the invalid value, without a popup.

In editing, ordinary typing always edits the draft. Use **Cmd/Ctrl+F** or **Cmd/Ctrl+L** to open navigation explicitly. Direct typing applies only to the focused reader: comments, other inputs, modifier shortcuts and IME composition keep their normal behavior. Markdown text find uses source; line numbers refer to source lines. Acknowledged CLI and context-passage navigation use Source for exact line highlighting; legacy deep links can reveal rendered Markdown blocks instead.

File-tree, project and global search are separate from this reader bar. Focus the tree and start typing to filter names immediately, or use the contextual search shortcut. Open project search to search file contents within one project. Use **Cmd/Ctrl+Shift+F** for names, contents or both across selected projects and file spaces. Read [the file-space search behavior](#file-spaces-and-focused-browsing) for scope, limits and its two-stage Escape behavior.

## Editing, saving and drafts

1. Open a source file and click **Read-only** to enter editing in the same reader and at the same position.
2. Make changes. Normal undo/redo stays available; typing text or numbers does not trigger automatic find or line navigation in this mode.
3. Choose **Save** or press **Cmd/Ctrl+S**. Choose **Cancel** to leave editing; discarding a changed draft asks for confirmation.

Drafts survive tab and project navigation while BOA remains open. A changed tab is marked, and the **Drafts** menu can reopen a draft. Do not rely on drafts as a persistent backup across application exit. Save or deliberately discard them before updating or quitting BOA; the application warns when closing with unsaved work.

If the file changes on disk while a draft is open, BOA preserves the draft and reports the external change. Saving compares against the original file instead of silently overwriting a newer version. Inspect and reconcile the two versions before retrying. Save failures leave the draft available.

Editing is restricted to existing UTF-8 files inside the registered root, up to 2 MiB, excluding Git metadata and external symlink targets. Git diffs remain read-only. On macOS, atomic saves preserve extended attributes, ACLs, owner/group and permissions; failure to preserve metadata aborts the save.

## Context views and bookmarks

A context view is a local, persistent explanation attached to a registered project or file-space root. It can be a **walkthrough**, which explains a workflow in ordered steps, or **findings**, which groups issues with their evidence. A view has a title and introduction; each step has an explanation and one or more named passages in files. Several views can coexist for the same root.

Open **Context** beside **Files** in the file sidebar. Selecting a view shows its introduction and steps; opening a step reveals its passage in the reader. The explanation appears above the code and can be collapsed. Use **Previous / Next** to follow the order, or click a specific step or associated passage. A findings step can link a cause, consequence and missing protection across different files without requiring three simultaneous readers.

The file tree shares the sidebar with Context rather than adding a permanent extra column. Switch back to **Files** when browsing normally. **Back to my reading** returns to the file and reading position used before the guided passage. Existing drafts are kept. Saving, updating or replacing a prepared view does not itself move the reader.

To add a bookmark, select a passage in a source file, choose **Bookmark** and give it a name. With no selection, the current line is used. The bookmark is added to **Bookmarks**, a context view for that root that can itself be renamed. Bookmarks store file coordinates and an optional anchor excerpt; they do not edit source files. A coding agent can prepare, update, reorder or remove complete views and individual steps through the [context CLI](#persistent-contexts-from-the-cli). Removing a view removes its local explanation, never its source files.

Passages can carry an exact text anchor and an optional symbol. When the file changes, BOA uses those anchors conservatively to recover the passage. An ambiguous or missing anchor is marked **Needs review** instead of being represented as a confirmed match. File and line coordinates alone can become stale: include a distinctive text anchor in agent-generated views when reliable relocation matters.

The guidance indicator is deliberately small. The CLI distinguishes a view being stored from a passage actually displayed; a saved view is not evidence that the user has seen it. **Take control** pauses incoming agent navigation. Read [the acknowledgement contract](#navigation-acknowledgements) before using automated navigation as a verification step.

## Reviewing Git

Choose a repository or worktree in the Git panel, then select one of its three tabs:

| Tab | How to use it |
| --- | --- |
| **Changes** | Expand staged and working-tree file lists, then select a file to compare it with the appropriate index or committed version. Modified, added, deleted, renamed, type-changed, untracked and conflicted files retain their status indicators. |
| **History** | Filter by branch, select a commit in the parent graph/list, then choose one of its changed files. More history loads in pages of 100 commits. |
| **Compare branches** | Choose a base and the branch to review. BOA shows changes from their common ancestor to the review head, rather than unrelated changes made only on the base. Select a file for its diff. |

Use the diff's previous/next controls to jump between changed blocks, and switch between inline and side-by-side comparison when useful. Merge commits compare against their first parent. During a conflict, BOA compares our index version (empty if deleted on our side) with the working file including conflict markers.

Git review is read-only: it never stages, commits, pushes, fetches, merges or checks out a branch. Ahead/behind values come from existing local tracking references. Refresh if native notifications were missed; run Git operations in your usual terminal or Git client.

## Settings and archives

Open **Réglages / Settings** from the sidebar to optionally select your main projects folder. Its visible direct child directories, including folders without Git, are added at startup and on native filesystem notifications while BOA is open. Symlink aliases are deduplicated by canonical path; pins and existing projects are preserved. No folder is selected by default. Changing or disabling discovery stops additions from the old location and keeps projects already registered. An inaccessible watched folder shows a warning without hiding existing projects.

Use a project's **Archive** button to move it out of the overview and pinned navigation. **Archives** lists those projects and lets you restore them. Automatic discovery keeps them archived; explicitly adding the same project again restores it. Archiving only changes BOA's local list: it never moves, deletes or edits the project folder. Archived projects have no background Git monitoring; restoring one starts a fresh Git scan. Active projects refresh their status on relevant native file notifications, coalesced over 750 ms and limited to one refresh batch every three seconds during continuous writes. A bounded mailbox keeps one pending notification per affected project instead of retaining every filesystem event; Git object/log/lock traffic and common build/dependency caches are filtered. Open files update on these events. The code viewer and Markdown preview try to keep the same visible passage using a text anchor when content is inserted above it; when that passage disappears, the viewer keeps a nearby position. An active editing draft is preserved and external changes are reported. There are no periodic project or Git scans. Returning to BOA does not rescan all projects. Use Refresh to reconcile missed notifications manually. Discovery reacts only to changes of direct child directories. Filesystems that do not support native notifications can be refreshed manually; monitoring errors appear in Settings.

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
```

### Stable local signing and updates

macOS privacy permissions are associated with an application's signing identity. An ad-hoc signature changes with the code and can cause Documents access to be requested again after updates. Use the same valid Keychain signing identity and the same bundle identifier for installed updates. See [Apple's signing requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).

List the available identities, then replace `CERTIFICATE_SHA1` below with the exact fingerprint of your existing Apple Development or Developer ID Application certificate:

```bash
security find-identity -v -p codesigning
bun run mac:signing -- CERTIFICATE_SHA1
bun run mac:build
bun run mac:install
```

The shared local profile stores only the certificate fingerprint in `~/Library/Application Support/local-app-signing/identity.json`, outside the repository. The private key stays in Keychain. This identity can be reused for other locally built apps; each must retain its own bundle identifier and permissions. Missing or expired certificates fail explicitly instead of falling back to ad-hoc signing. Unlock your login Keychain if macOS refuses access to the signing key. Keep private keys in Keychain and never export them into the repository or CI.

The bundle is generated at `src-tauri/target/release/bundle/macos/BOA.app`. Quit BOA before updating, preserving unsaved edits. `mac:install` signs a staged copy, verifies the bundle, checks that an existing certificate signature's designated requirement remains mutually compatible, then replaces `~/Applications/BOA.app`. It preserves user settings and moves the previous bundle to Trash. If a legacy copy exists at `/Applications/BOA.app`, installation stops before changing either app: quit BOA, use Finder to move that copy to `~/Applications/BOA.app` (keep a backup if both locations already exist), remove the duplicate from `/Applications`, and update Dock shortcuts before retrying. Incompatible signers are rejected before replacement. Switching from an ad-hoc build to a stable certificate may require one final authorization. At certificate renewal, configure the renewed identity and keep the same signing class/team; incompatible requirements remain blocked.

To install an extracted CI artifact with your local identity, use `bun run mac:install -- /path/to/BOA.app`. Avoid overwriting the installed app directly with an ad-hoc CI build: that discards the stable identity. For disposable unsigned-identity development artifacts only, use `bun run mac:build -- --adhoc`; CI explicitly uses that mode and never receives your private key. Ad-hoc artifacts are not accepted by the installer without re-signing.

There is no Developer ID-signed, notarized public installer yet. Local Apple Development signing is not public distribution or notarization. See [Tauri's macOS prerequisites](https://tauri.app/start/prerequisites/#macos) for environment setup. Open BOA after installation and click **Ajouter un dossier** to choose your first project. Adding a folder does not pin it automatically; use its pin button if you want it in the sidebar.

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
boa open "$HOME/Projects/my-app/src/main.ts" --line 12 --end-line 24 --source Codex --wait --json
```

`favorite`/`unfavorite` are aliases for `pin`/`unpin`: there is one preference, not two competing lists. Short forms such as `boa add <folder>` and `boa pin <folder>` are also available. Use `--dry-run` on navigation or mutation commands to inspect a request without applying it.

Project commands return `{ "ok": true, "result": ... }` with `--json`; failures return `{ "ok": false, "error": ... }` and a nonzero exit code. They launch the installed app if needed and communicate through a per-user Unix socket with owner-only permissions, bounded messages and timeouts. The app owns configuration updates and immediately refreshes its view. The CLI never edits the preferences file behind the app's back.

Plain `open` retains the `boa://open` URL scheme for compatibility. It sends a navigation request to macOS; exit 0 alone does not confirm that a passage was displayed. Add `--wait` or `--json` to use the app's acknowledged socket navigation instead. The source label can be Codex, Claude, Cursor or CLI; it is a declared sender, not an authenticated AI session. **Take control** suspends incoming navigation. The file must belong to a registered project or file-space root. Relative CLI paths resolve from the current working directory; quote paths containing spaces.

For file navigation, BOA chooses the longest registered root containing the file. If that same root is both a project and a file-space entry, the first matching file space in saved order wins. An individually registered file is more specific than a containing folder; a parent space does not override a more specific registered project root. The declared source label does not change this routing.

Read [the BOA agent skill](.agent-sync.local/skills/boa/SKILL.md) for the CLI reference and voice-demo navigation contract. Its canonical source is versioned here. With cc-hub installed, generate provider links from a **stable checkout**:

```bash
cc-hub skill link ./.agent-sync.local/skills/boa --agent-sync-root ./.agent-sync.local --scope global --targets all --json
cc-hub skill status --agent-sync-root ./.agent-sync.local --scope global --targets all --name boa --json
```

The custom root keeps the skill canonical in this repository and lets cc-hub manage provider links. Do not link from a temporary worktree whose deletion would break them. The skill documents the CLI; it does not update BOA.app. Read [the dated CLI latency study](docs/cli-latency.md) for request-preparation measurements and a CLI/MCP comparison plan. That study predates acknowledged navigation: its historical no-acknowledgement limitation applies to plain deep links, while the current `--wait`/`--json` contract is described below. Its dry-run measurements do not measure current end-to-end display latency.

### Persistent contexts from the CLI

Register the root first. Use a stable view ID so an assistant can update one explanation rather than adding duplicates. `--project` accepts either a registered project directory or an individual registered file-space root.

| Command | Effect |
| --- | --- |
| `boa contexts list --project ROOT --json` | List saved views for one root |
| `boa contexts get ID --project ROOT --json` | Read a view, including its revision |
| `boa contexts save ID --project ROOT --file view.json --json` | Create or explicitly replace a complete view |
| `boa contexts save ID --project ROOT --file view.json --revision N --json` | Save only if the current revision is N; use 0 to require a new view |
| `boa contexts update ID --project ROOT --file patch.json --revision N --json` | Change the supplied title, description, kind or complete steps array |
| `boa contexts reorder ID --project ROOT --steps first-step,next-step --revision N --json` | Set the complete step order using every existing step ID once |
| `boa contexts remove ID --project ROOT --json` | Remove the saved view, leaving source files untouched |
| `boa contexts open ID --project ROOT --step STEP --passage PASSAGE --wait --json` | Reveal one passage and wait for its display receipt |
| `boa receipt REQUEST_ID --json` | Read the current receipt; `boa contexts status REQUEST_ID --json` is an alias |

`save` without `--revision` is a deliberate replacement. To avoid overwriting another assistant's or user's update, read the view first and send the returned revision with `save`, `update` or `reorder`. A revision conflict is an error: reload, reconcile, and retry deliberately. For a partial step change, edit the retrieved `steps` array and send that full array in an update; omitting a step or passage removes it. Updating or deleting context metadata never edits its source files.

Create `view.json` from your own project analysis, using this fictional example as a schema guide. Replace the project path, source coordinates and anchor text with the actual values; the file is CLI input, not application source or a repository preference:

```json
{
  "id": "save-flow",
  "project": "/Users/example/Projects/my-app",
  "title": "How saving works",
  "description": "Follow the request from the action to the write boundary.",
  "kind": "walkthrough",
  "steps": [
    {
      "id": "entry",
      "title": "Start the save",
      "description": "This action passes the draft to the save operation.",
      "group": "Request",
      "passages": [
        {
          "id": "action",
          "path": "src/actions.ts",
          "startLine": 12,
          "endLine": 14,
          "label": "Save action",
          "role": "cause",
          "symbol": "saveDraft",
          "text": "export async function saveDraft() {\n  await writeDraft();\n}"
        }
      ]
    }
  ]
}
```

Use `"kind": "findings"` for an issue review. Add passages to a step to connect its cause, consequence, test or other relevant locations; labels and roles are supplied by the author. Passage paths are relative to the registered root, with no `.` or `..` segments, absolute paths or Git metadata. Lines are inclusive positive integers; `endLine` must not precede `startLine`. IDs must be stable and unique within their view/step. Text anchors should be distinctive excerpts of the referenced file, not an invented expected result.

For example, after creating the JSON above with real values:

```bash
boa contexts save save-flow --project "$HOME/Projects/my-app" --file view.json --revision 0 --json
boa contexts get save-flow --project "$HOME/Projects/my-app" --json
boa contexts open save-flow --project "$HOME/Projects/my-app" --step entry --passage action --wait --json
```

When `--step` or `--passage` is omitted, opening uses the first available step or passage. Preparation and navigation are separate operations: saving a view stores it, while `contexts open` requests an actual reader change. A missing file or uncertain anchor is not reported as a confirmed display.

### Navigation acknowledgements

Use acknowledged navigation when an automation needs evidence that BOA loaded and revealed a passage. `--json` on file/context opening waits for that evidence by default; `--wait` requests the same acknowledgement without requiring `--json`. `--wait-ms 10000` sets the bounded waiting period in milliseconds; accepted values range from 100 to 15,000 ms.

| Receipt status | Meaning |
| --- | --- |
| `pending` | The request exists, but display has not been confirmed |
| `displayed` | The reader reports the requested file loaded, target passage revealed and highlight applied |
| `paused` | Incoming guidance is suspended, or editing prevents the requested guided change |
| `missing` | The target cannot be found |
| `needs-review` | The saved anchor cannot be resolved confidently |
| `failed` | The request failed; inspect its message |

For acknowledged opening, the CLI exits 0 for a confirmed `displayed` result, 2 when a wait ends without confirmed display, and 1 for command/RPC errors. A timeout or `pending` receipt is an unknown display result, not permission to assume success or replay a mutation. Receipts are local, temporary and bounded to 128 recent requests. Unacknowledged requests fail after 30 seconds; receipts are also lost when BOA restarts or when newer requests evict them. They are not a persistent reading history. A display receipt reports application state, not proof that a person read the passage.

Saved views persist across restarts; receipts do not. Neither creating nor updating a view automatically resumes paused guidance. BOA has a CLI, not a bundled MCP server; assistants can call the same CLI contract.

## File spaces and focused browsing

Use **Settings → File spaces** to create a named collection of existing folders and individual files. Spaces appear separately in the sidebar and never run Git discovery or status scans. Files stay in their original locations. Each folder has an on-demand visibility/sort menu: choose the files and subfolders to show, temporarily show everything, or sort by name, date added, modification date, creation date, file type or size in either direction. These sort choices are shared with the Library toolbar and saved per root. Date added is the macOS date when an item entered its containing directory, independently of its creation date; unavailable dates sort last in either direction. Name, type and size sorts keep folders first, while pins keep their manual order. Selecting a folder includes its descendants; ancestors remain traversable. Pinned files and folders stay accessible even when excluded from the visible selection. Pins stay above the tree and can be reordered by drag-and-drop or the arrow buttons. Visibility and pins are local preferences, not access-control boundaries.

```bash
boa spaces save ai-tools --name "AI tools" --root "$HOME/.claude" --root "$HOME/.codex"
boa spaces list --json
boa files configure "$HOME/.codex" --include skills --include AGENTS.md --pin AGENTS.md --sort modified
boa files preferences "$HOME/.codex" --json
boa spaces remove ai-tools --dry-run
```

`spaces save` creates or replaces the space with that ID; repeat `--root` for folders and `--file` for individual files. At least one is required. Paths are canonicalized and deduplicated. `--sort` accepts `name`, `name-desc`, `added`, `added-asc`, `modified`, `modified-asc`, `created`, `created-asc`, `type`, `type-desc`, `size` and `size-asc`. Dates default to newest first and size to largest first; `-asc` reverses them. Name/type default to A–Z; `-desc` reverses them. `files configure` replaces that folder's complete visibility, pin order and sort preferences. Repeat `--include` and `--pin` as needed; `--all` disables filtering. Removing a space only removes its BOA entry, never its files. Registered space folders and individual files support `boa open` just like project folders.

Search fields stay hidden until requested. With the tree focused, start typing to open a temporary path filter; results update after a short pause without pressing Enter. Escape in an empty filter or Close restores the same tree. Cmd/Ctrl+F searches names under the focused file tree, or opens text find when the reader has focus. Cmd/Ctrl+Shift+F opens a temporary global panel for names, contents or both across active projects and file spaces. Enter starts global search; Escape clears a nonempty focused search field. With an empty field, Escape closes the panel; clicking the overlay background also closes the global panel. Change the contextual and global shortcuts in Settings. Global/tree search observes explicit folder selections, skips Git metadata and common dependency/cache directories, does not traverse symlinks, and is bounded to 10 seconds, 10,000 visited entries, 32 nested levels, 300 results and 2 MiB per text file. It does not create a background index. Project content search retains its existing ripgrep/ignore behavior.

For maintenance instructions, read [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md). Remove obsolete temporary/build outputs after validation while retaining needed deliverables and recovery data.

Opening the visible-item chooser keeps the current filter unchanged until an item is selected. If an empty selection was previously saved, use **Show all** directly in the empty tree to restore all files permanently.

Tree/project/global search fields show a clear button while nonempty. Escape clears their text and results while keeping focus; a second Escape closes contextual/global search panels. The in-file reader bar differs: a single Escape clears and hides it while retaining the reached position.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Typing in a focused read-only reader | Find text immediately; digits-only input reveals that source line |
| A leading space in a read-only reader | Force text search and consume the prefix space, including when searching digits |
| `⌘F` / `Ctrl+F` | Explicit text find in a focused reader, also during editing; Markdown switches to Source. With a focused file tree, search names instead |
| `⌘L` / `Ctrl+L` | Explicit source-line navigation in a focused reader, also during editing |
| `Enter` / `Shift+Enter` in reader find | Next / previous occurrence |
| `Escape` in reader navigation | Clear and hide the bar in one press, keeping the reached position |
| Typing with the file tree focused | Filter file/folder names after a short pause, without Enter |
| Typing on Overview outside controls | Focus Search projects and filter from the first character |
| `⌘⇧F` / `Ctrl+⇧F` | Search names and contents across projects and spaces |
| `Alt+Left` / `Alt+Right`, `Cmd+[` / `Cmd+]`, mouse back/forward | Revisit app navigation history outside editing controls |
| `Shift+F10` on a tree item or library image | Open the corresponding context menu |
| `Left` / `Right`, `Page Up` / `Page Down` in Library preview | Previous / next filtered image |
| `Escape` in an expanded Markdown block/image or Library viewer | Close the expansion/viewer and restore the prior reader/grid |
| `⌘S` / `Ctrl+S` in editing | Save the current draft explicitly |
| `⌘⇧B` / `Ctrl+⇧B` | Open the context dialog |
| `Enter` / `Shift+Enter` in the dialog | Copy context / insert a newline |
| `Escape` or a click outside the dialog | Close the dialog |
| Arrow keys on a panel separator | Resize the corresponding panel |

## Local data and privacy

- The project list, file spaces and folder preferences are stored in the current user's application-data directory, in `com.julienm.boa/projects.json` (on macOS: `~/Library/Application Support/com.julienm.boa/projects.json`). Persistent context views and bookmarks use the adjacent `context-views.json`. Layout preferences stay in the app's local webview storage. None of these local values are bundled with the app or committed to this repository.
- An empty first launch performs no project scan. BOA reads registered projects and an optional explicitly configured discovery folder. Imported configuration from an earlier BOA version remains intact.
- A selected project can contain nested repositories and external Git worktrees. Explicit symbolic links in its file tree can lead outside the project; BOA follows these when you browse them. File contents remain on the Mac until you explicitly copy and share them.
- BOA has no telemetry, hosted project service, embedded AI provider or credential configuration. It runs system Git with argument arrays rather than a shell. Browsing and Git review do not modify the selected repositories.
- The macOS bundle permits HTTP loads in its webview so cleartext image URLs also work. The content security policy allows these remote loads only for images; remote scripts and other remote connections remain blocked.
- **Context bubble** is an ephemeral copy composer: select text or choose a file-path reference, add a comment, then copy the package to the clipboard. It has no conversation history, creates no export files and does not automatically send anything to an AI. Persistent **Context views** are a separate local navigation feature. Their saved descriptions and optional anchor excerpts can contain source content; keep exported CLI JSON private when the project is private. Older prototypes may have left exports in the local application-data directory; those are not distributed.

## Limits

Text preview supports UTF-8 files up to 2 MiB. Full-image and Markdown-image previews support up to 32 MiB; comparison inputs remain separately limited to 8 MiB. Repository discovery inside an explicitly selected project is bounded to 6 levels / 4,000 directories, with dependency/cache directories excluded. History loads 100 commits per page. Project search is literal, respects ignore files, does not follow symbolic links and is limited to 300 results, 20 matches per file and 10 seconds. Bounds and errors are shown in the interface.

Context storage is bounded: 256 views and 1 MiB in total, 48 KiB per view, up to 256 steps per view and 32 passages per step, and bounded descriptions and anchor excerpts. Source-line coordinates stop at 1,000,000. Oversized or invalid input is rejected rather than silently truncated. Context views explain and reveal source; they do not execute code, build a complete dependency graph or provide a live relationship map.

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
