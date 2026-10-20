# Latence de navigation CLI

Étude locale du 19 octobre 2026, sans contrôle UI ni mesure du rendu de l’app installée.

## Chemin observé dans le code

- Lis [le CLI](../scripts/boa.ts) pour la validation du fichier, la génération de l’URL et l’appel synchrone à `/usr/bin/open`.
- Lis [le traitement du deep link](../src/boa-app.tsx) pour la résolution du dossier, la lecture des espaces et, hors espace, l’appel `api.add`, l’attente d’invalidation des projets, puis la publication de la sélection avec un nouvel identifiant.
- Lis [le lecteur](../src/code-viewer.tsx) pour le chargement du contenu et [l’aperçu](../src/markdown-preview.tsx) pour le rendu puis le ciblage des blocs.
- Lis [la résolution native](../src-tauri/src/lib.rs) pour la recherche du projet enregistré. Lis [la gestion des projets](../src-tauri/src/projects.rs) : ajouter un projet déjà actif ne réécrit pas la configuration ; restaurer un projet archivé la modifie.

Le code 0 de `open` confirme l’acceptation de l’envoi par macOS. Il ne confirme ni réception du deep link, ni chargement, ni rendu, ni position visible. Un guidage suspendu ignore la demande. Les commandes de projets ont un accusé RPC distinct ; elles ne constituent pas un accusé d’affichage.

## Mesure réellement effectuée

Dix processus indépendants `bun scripts/boa.ts open README.md --line 21 --end-line 28 --source Codex --dry-run`, chronométrés avec une horloge monotone, timeout individuel de 5 s. Aucun envoi à macOS ou à BOA.

| Mesure | Résultat |
| --- | --- |
| Durées en ms | 21,4 ; 17,9 ; 17,8 ; 18,2 ; 18,6 ; 17,6 ; 17,5 ; 17,9 ; 17,7 ; 17,3 |
| Médiane | 17,85 ms |
| Maximum observé | 21,4 ms |
| Inclus | Démarrage Bun, validation du fichier, construction et impression de l’URL |
| Non mesuré | Transport macOS, app froide/chaude, IPC Tauri, requêtes, rendu, défilement, chaîne vocale |

La commande réelle précédente a été rapportée comme terminée en moins d’une seconde dans le contexte de la demande ; ce n’est pas une nouvelle mesure effectuée ici. La recherche du fichier, le raisonnement et les échanges entre chats ajoutent une latence distincte. Leurs durées ne sont pas quantifiées par ce benchmark.

## Recommandations, sans implémentation MCP

1. Réutiliser le fichier et les coordonnées déjà connus tant que le contenu ne change pas ; rechercher uniquement dans ce fichier au besoin. Envoyer directement une commande depuis le chat qui conduit la discussion réduit les échanges intermédiaires.
2. Pour une mesure utile, ajouter ultérieurement un identifiant partagé et des horodatages : commande, réception BOA, contenu prêt, ciblage effectué. Un accusé « ciblage effectué » reste distinct d’une observation humaine de l’écran. Le CLI peut fournir ce protocole sans imposer MCP.
3. Étudier une voie rapide pour les projets déjà actifs : le traitement attend actuellement `api.add` puis l’invalidation de la liste des projets avant la sélection. Leur coût n’a pas été mesuré ; préserver la restauration des archives et les règles de guidage avant tout changement.
4. Comparer ensuite CLI et MCP sur les mêmes scénarios froid/chaud, même fichier, même plage et mêmes points de mesure. MCP pourrait fournir des arguments structurés et une connexion persistante ; le CLI peut également utiliser le RPC existant. Aucun gain chiffré ni serveur MCP BOA n’est établi par cette étude. Les quelque 18 ms du dry-run ne mesurent pas la latence totale et ne justifient pas seuls un nouveau transport.
