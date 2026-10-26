---
name: boa
description: Use the BOA CLI to manage registered projects and file spaces, prepare persistent context views, and reveal code passages with optional display receipts. CLI only; no UI control, installation or MCP server.
---

# BOA CLI

Use `$boa` in Codex or `/boa` in Claude Code after cc-hub generation. Resolve the real skill path before following relative links through a generated symlink. Read [the user guide and CLI contract](../../../README.md#cli-and-coding-agents) when transport or version is uncertain.

- Run `boa --help` for the linked version; from the checkout, `bun scripts/boa.ts` is equivalent. Bun is required for the CLI. Updating the checkout does not update the installed BOA.app.
- Relative CLI paths resolve from cwd. Quote paths and shell arguments. `--source Codex|Claude|Cursor|CLI` is a declared label, not authenticated identity or Markdown Source mode.
- Registered projects, file-space folders and individual files bound navigation. Use the longest matching registered root; on an exact project/space-root tie, the first matching space in saved order wins. An individually registered file is more specific than a folder; source labels do not alter routing. Visibility filters are browsing preferences, not access controls. No cookie, secret, repository or application configuration is edited outside its owning API.

## Registered folders

| Command | Contract |
| --- | --- |
| `boa projects list --json` | Read app-owned projects |
| `boa projects add ROOT [--pin] [--json] [--dry-run]` | Register explicitly; restore if archived |
| `boa projects pin\|unpin ROOT [--json] [--dry-run]` | Change the pin preference |
| `boa projects favorite\|unfavorite ROOT` | Aliases for pin/unpin; one preference |
| `boa add\|pin\|unpin\|favorite\|unfavorite ROOT` | Short forms |
| `boa spaces list [--json]` | List spaces, separate from Git projects |
| `boa spaces save ID --name NAME [--root ROOT] [--file FILE] [--json] [--dry-run]` | Create/replace; at least one root/file; canonicalize/deduplicate paths |
| `boa spaces remove ID [--json] [--dry-run]` | Remove the entry, never files |
| `boa files preferences ROOT [--json]` | Read folder preferences |
| `boa files configure ROOT [--include RELATIVE] [--pin RELATIVE] [--sort SORT] [--all] [--json] [--dry-run]` | Replace complete visibility/pin order/sort; repeat include/pin; all disables filtering |

Spaces accept folders and individual files and do not run Git scans. Sort values: `name`, `name-desc`, `added`, `added-asc`, `modified`, `modified-asc`, `created`, `created-asc`, `type`, `type-desc`, `size`, `size-asc`; shared with the Library toolbar. Dates/size default descending; name/type default ascending; unavailable dates remain last. Pins retain manual order. Includes/pins are relative, without `.` or `..` segments. Opening the visible-item chooser does not change selection until an item is chosen.

## Open a passage

`boa open FILE [--line N] [--end-line N] [--source Codex|Claude|Cursor|CLI] [--wait] [--json] [--wait-ms 10000] [--dry-run]`

- The file must exist in a registered root. Lines default to 1 and to the start line respectively; inclusive increasing integers, 1–1,000,000.
- Plain open sends a `boa://open` deep link through macOS. Exit 0 means sent, not displayed. Its dry run prints the URL without launching BOA.
- `--wait` or `--json` uses socket navigation and waits for a reader acknowledgement. `--json` waits by default; `--wait-ms` accepts 100–15,000 ms. Use this path when the task requires evidence of loaded/revealed/highlighted code.
- Acknowledged open exits 0 only for `displayed`, 2 for an unconfirmed/non-displayed result, 1 for command/RPC failure. Do not turn timeout or `pending` into success or blindly replay a mutation.
- `boa receipt REQUEST_ID --json` reads a receipt; `boa contexts status REQUEST_ID --json` is equivalent. Receipts are session-local, bounded to 128; pending requests fail after 30 seconds. Restart/eviction loses receipts.
- Receipt states: `pending`, `displayed`, `paused`, `missing`, `needs-review`, `failed`. Displayed means the app confirmed file load, reveal and highlight; it does not prove the person read it.
- **Take control** pauses incoming navigation; the CLI cannot resume it. A visible editing draft also pauses guidance. Parked drafts remain preserved.

### Markdown

- Local Markdown links resolve relative paths and heading anchors in BOA within registered folders/files; external URLs retain the copy-link behavior.
- Legacy deep links open `.md`/`.markdown` in Preview; source lines reveal/highlight rendered blocks, including table rows. A line without a rendered element uses the containing/nearest block, or the final block past EOF. This is block highlighting, not native character selection.
- Acknowledged exact line/context navigation uses Source. Find also switches to Source. Explicit editing and Git diffs retain their own behavior.

## Persistent context views

Read [the context schema and examples](../../../README.md#persistent-contexts-from-the-cli) before preparing JSON. Use source-derived coordinates and distinctive anchor text, never a fixed example as production evidence.

| Command | Contract |
| --- | --- |
| `boa contexts list --project ROOT --json` | List views for one registered root |
| `boa contexts get ID --project ROOT --json` | Read full view and revision |
| `boa contexts save [ID] --project ROOT --file view.json [--revision N] --json` | Create/replace full view; revision 0 requires new |
| `boa contexts update ID --project ROOT --file patch.json --revision N --json` | Patch title/description/kind/full steps array |
| `boa contexts reorder ID --project ROOT --steps FIRST,NEXT --revision N --json` | Every existing step ID exactly once |
| `boa contexts remove ID --project ROOT --json` | Remove metadata, never source files |
| `boa contexts open ID --project ROOT [--step ID] [--passage ID] [--wait] [--json] [--wait-ms 10000]` | Open specified/first step and passage; acknowledged with wait/json |

- JSON view: stable `id`, `project`, `title`, `description`, `kind` (`walkthrough` or `findings`), `steps`. Steps have stable `id`, `title`, `description`, optional `group`, and `passages`. Passages have stable `id`, relative `path`, `startLine`, `endLine`, optional `label`, `role`, `symbol`, `text`.
- IDs are unique within their owning view/step. Paths exclude absolute paths, `.`/`..` and Git metadata. Saved views live in app-owned local `context-views.json`, never source files.
- Save without revision explicitly replaces. Prefer get → reconcile → save/update with returned revision. A conflict requires reload, not an unconditional overwrite. A full steps update can add/remove/edit/reorder steps and passages.
- Preparing/updating a view never moves the reader. Open is separate. Preserve the user's active view, reading position and drafts.
- Unique exact text can relocate a passage. Missing/repeated anchors are uncertain and must not claim `displayed`; the file can open unhighlighted with `needs-review`. Coordinates without text can be stale; use anchors for durable references.
- Bounds: 256 views/1 MiB store, 48 KiB/view, 256 steps/view, 32 passages/step; text/description lengths are also bounded. Input is rejected, never silently truncated.

## Transport and evidence

Read [the dated CLI latency study](../../../docs/cli-latency.md) for preparation-only measurements; it predates reader receipts and does not establish current display latency or an MCP speedup.

- Projects/spaces/preferences/contexts and acknowledged navigation use a private per-user Unix socket. JSON replies are `{ok:true,result:...}` or `{ok:false,error:...}`. The app owns persistence; the CLI never edits preferences behind its back.
- RPC deadline: 4.5 seconds; cold-start connection wait: up to 10 seconds after launch. `--dry-run` does not launch the app or apply a mutation.
- A CLI duration does not measure rendered UI latency. Keep request IDs, actual receipts and observed source coordinates in the conversation. Do not claim screenshot verification from a receipt.
- No BOA MCP server is provided. This skill performs no browser/Computer Use actions, captures, signing, installation or Keychain changes.
