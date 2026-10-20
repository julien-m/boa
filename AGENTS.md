# BOA — règles du projet

Lis [CLAUDE.md](CLAUDE.md) pour le contexte partagé ; ce fichier porte les règles communes aux agents.

- Préserver l’interface sobre : lecture seule par défaut, édition explicite, sauvegarde/annulation, brouillons et position de lecture conservés lors des changements externes.
- Garder la configuration locale hors Git ; une installation neuve démarre vide. Ne pas coder de chemins personnels en dur ni publier de secrets ou données locales.
- Surveiller les fichiers par événements natifs coalescés et bornés ; éviter les scans Git globaux et les rafraîchissements en boucle. Les espaces de fichiers ne sont pas des projets Git.
- Maintenir le français et l’anglais, le CLI et le README lors des changements d’usage.
- Valider avec les commandes du projet adaptées au changement ; distinguer tests locaux, compilation, installation et comportement réellement observé.
- Signer les installations macOS avec le profil stable local configuré ; conserver le bundle ID et ne pas remplacer une installation par un build ad hoc. Ne jamais exporter la clé privée dans le dépôt ou la CI.
- Après validation, nettoyer les fichiers temporaires, caches et sorties de compilation devenus inutiles pour libérer l’espace disque. Conserver les livrables nécessaires, dépendances réutilisées, sauvegardes utiles et clés ; ne pas vider la Corbeille ni supprimer des données utilisateur sans autorisation.
