# Security

BOA is a local application that reads folders you explicitly register. It follows symbolic links when browsing selected projects and inspects external Git worktrees. Its CLI can change BOA's local project list and pin preferences; it cannot execute arbitrary shell commands or perform Git writes.

Please report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/julien-m/boa/security/advisories/new). Do not publish private source code, credentials or personal paths in a public issue. If private reporting is unavailable, open a minimal issue asking for a private contact, without exploit details or sensitive data.

Only the current development branch is maintained. There is no supported, notarized production release yet. See [README.md](README.md) for the current platform scope and validation limits.
