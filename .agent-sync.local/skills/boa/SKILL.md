---
name: boa
description: Utiliser le CLI BOA pour lister, ajouter ou épingler des projets et montrer un fichier ou un passage pendant une discussion ou une démo vocale. Référence des échanges avec BOA, sans contrôle UI, installation ni MCP.
---

# BOA CLI

Invocation après génération cc-hub : `$boa` dans Codex, `/boa` dans Claude Code. Résous le chemin réel du skill avant de suivre ses liens relatifs à travers un lien généré.

Lis [le contrat CLI](../../../README.md#cli-and-coding-agents) si la version ou le transport est incertain. La source de ce skill est versionnée dans le dossier AgentSync local de BOA ; cc-hub produit les liens Claude/Codex depuis un checkout stable avec la racine canonique personnalisée décrite dans le README.

## Référence des commandes

`boa --help` donne l’aide de la version liée. Depuis le checkout BOA, `bun scripts/boa.ts` remplace `boa` sans installation globale. Le CLI exige Bun ; BOA.app installée fournit le traitement natif. Un nouveau checkout ne met pas l’app à jour.

| Commande | Effet et options |
| --- | --- |
| `boa projects list --json` | Liste actuelle détenue par l’app ; lecture seule |
| `boa projects add <dossier> [--pin] [--json] [--dry-run]` | Ajout explicite, restaure aussi un projet archivé |
| `boa projects pin\|unpin <dossier> [--json] [--dry-run]` | Modifie la préférence épinglée |
| `boa projects favorite\|unfavorite <dossier> [--json] [--dry-run]` | Alias de pin/unpin, même préférence |
| `boa add\|pin\|unpin\|favorite\|unfavorite <dossier>` | Formes courtes, mêmes options |
| `boa spaces list [--json]` | Liste les espaces de fichiers, distincts des projets Git |
| `boa spaces save <id> --name <nom> --root <dossier> [--root <autre-dossier>] [--json] [--dry-run]` | Crée ou remplace un espace ; racines répétables, canonisées et dédupliquées |
| `boa spaces remove <id> [--json] [--dry-run]` | Retire uniquement l’entrée BOA, jamais les fichiers |
| `boa files preferences <dossier> [--json]` | Lit les préférences du dossier enregistré |
| `boa files configure <dossier> [--include <relatif>] [--pin <relatif>] [--sort name\|modified\|modified-asc] [--all] [--json] [--dry-run]` | Remplace toute la sélection, l’ordre des pins et le tri ; include/pin répétables ; all désactive le filtre |
| `boa open <fichier> [--line 42] [--end-line 50] [--source Codex\|Claude\|Cursor\|CLI] [--dry-run]` | Ouvre un fichier et cible une plage de lignes inclusives |

- Chemins relatifs résolus depuis le répertoire courant ; protège espaces et caractères shell avec des guillemets.
- `open` exige un fichier existant appartenant à un projet enregistré ou à une racine d’espace de fichiers. Ligne par défaut : 1 ; fin par défaut : ligne de départ ; plage entière croissante entre 1 et 1 000 000. Émetteur par défaut : CLI.
- `--source` est une étiquette déclarée d’émetteur, sans authentification, et ne demande pas le mode Source du Markdown.
- `--dry-run` ne lance pas l’app. `open` imprime une URL ; les commandes de projets impriment du JSON. `open --json` n’est pas pris en charge.
- Les commandes de projets, espaces et préférences répondent via un socket Unix privé à l’utilisateur : JSON `{ok:true,result:...}` ou `{ok:false,error:...}` avec `--json`. Échec : code non nul. Délai RPC : 4,5 s ; lancement à froid : attente de connexion jusqu’à 10 s après lancement. Le CLI n’édite pas directement la configuration.
- `open` envoie une URL `boa://open` à macOS avec fichier, lignes, émetteur et identifiant de requête. Code 0 : demande envoyée ; aucun accusé de traitement, d’affichage ou de position visible. Les erreurs ultérieures de BOA ne reviennent pas au CLI.

## Passages Markdown

- Le tri `modified` place les modifications récentes en premier ; `modified-asc`, les anciennes.
- Les liens Markdown locaux suivent les chemins relatifs et les ancres dans BOA, dans les dossiers enregistrés ; les URL externes conservent la copie de lien.
- Les fichiers `.md` et `.markdown`, insensibles à la casse, s’ouvrent en aperçu par défaut. Les lignes ciblées révèlent le premier bloc correspondant et surlignent les blocs rendus les plus précis, dont les lignes de tableaux. Une nouvelle demande remplace le surlignage et révèle à nouveau la cible.
- Une ligne sans élément rendu vise le bloc contenant ou le plus proche ; après la fin du fichier, le dernier bloc visible. Le surlignage porte sur les blocs, pas sur une sélection native de caractères. Un passage trop long peut dépasser la fenêtre.
- Source et édition explicites restent disponibles ; un brouillon actif reste en édition. Find bascule vers Source ; les diffs Git gardent leur lecteur de diff.
- **Reprendre la main** suspend le guidage entrant dans l’app ; aucune commande CLI ne change cet état. Aucune lecture de l’écran ni confirmation d’affichage n’est disponible par ce CLI. Une confirmation humaine constitue une observation distincte de l’envoi.

## Coordonnées utiles pendant une démo

Le contexte réutilisable est : chemin absolu du fichier, section ou symbole, début/fin de ligne, émetteur, dernière commande et résultat observé. Ces informations restent dans la conversation, sans mémoire persistante ni écriture dans le document. Un fichier modifié nécessite de retrouver les lignes ; les anciennes coordonnées peuvent être périmées.

```bash
rg --files "$project" -g '*.md' -g '*.MD' -g '*.markdown'
rg -n -F 'Purchase' "$file"
sed -n '120,140p' "$file"
boa open "$file" --line 120 --end-line 132 --source Codex
```

Les variables représentent les chemins déjà identifiés dans la conversation. Une recherche bornée dans le fichier connu réduit la redécouverte ; une navigation suivante peut réutiliser ses coordonnées si le contenu est inchangé. L’ajout et l’épinglage sont des mutations de la liste BOA, distinctes de l’ouverture. Les espaces ne déclenchent pas de scan Git ; leurs préférences de visibilité ne sont pas une frontière de sécurité. Les chemins include/pin sont relatifs, sans segments `.` ou `..`.

## Latence et limites

Le trajet est : demande vocale → identification du passage → CLI/Bun → macOS/deep link → résolution native du dossier → lecture des espaces → rafraîchissement des projets → chargement et rendu → défilement. Un temps de commande ne mesure pas le rendu. Aucun MCP BOA n’est fourni ici ; un gain de transport nécessite un benchmark comparable. CLI uniquement : aucun navigateur, Computer Use, clic ou capture ; aucune signature, installation ou modification du Keychain.
