# Contributing to BOA

BOA is an early macOS project viewer. Keep changes focused and preserve its read-only Git/file behavior.

1. Follow the setup in [README.md](README.md).
2. Reproduce a bug with a disposable folder or Git repository. Never commit application preferences, personal project paths, credentials, generated app bundles or real context exports.
3. Add or update a behavior test, run the quality commands from the README, and describe the observed result in the pull request.
4. For a UI change, explain how it behaves with an empty first launch and with an existing saved project list. Use synthetic data for screenshots.
5. Keep the CLI JSON contract and bounded, owner-only local transport compatible. Document any intentional change.

The desktop UI is React/TypeScript with Monaco; filesystem/Git/configuration/CLI transport live in Rust under `src-tauri/src`. Do not add a model provider, network sync or a Git mutation as an incidental change.

Bug reports should include the macOS version/architecture, BOA revision, reproduction steps and expected/observed behavior. Redact code, paths and repository names that should not be public.
