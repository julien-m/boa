# BOA

Application macOS légère : React/TypeScript, Monaco et Tauri/Rust, pour consulter projets, fichiers et Git.

Lis et applique [AGENTS.md](AGENTS.md) avant de modifier le projet ; les règles communes y sont centralisées pour éviter les divergences.
Lis [README.md](README.md) pour l’usage, le CLI, la compilation et la signature locale.

Validation courante : `bun run verify`, `bun run check:public`, tests Rust et smoke UI selon la portée. Nettoyer après validation les fichiers temporaires et sorties de compilation inutiles, conformément aux règles communes.
