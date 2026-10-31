# Changelog

Toutes les versions notables de Photothèque. Format suivi :
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et
[Versionnement sémantique](https://semver.org/lang/fr/).

## [0.1.1] — 2026-10-31

### Corrigé

- **Lanceur Windows** (`Phototheque.bat`) : la variable `PHOTOTHEQUE_PORT`
  était lue sous un nom erroné (`PHOTOTHE_PORT`) ; un port personnalisé
  ouvrait le navigateur sur une adresse sans serveur.

### Divers

- Projet placé sous contrôle de version (git).

## [0.1.0] — 2026-10-28

Premier socle fonctionnel et testé.

### Ajouté

- **Base SQLite** (`node:sqlite`) : schéma complet (`photos`, `files`,
  `supports`, `folders`, `keywords`, `photo_keywords`, `albums`,
  `album_photos`, `album_pages`, `collections`, `collection_photos`, `edits`,
  `imports`, `exports`, `history`, `people`, `subjects`, `places`) + tables
  d'administration (`config`, `settings`, `prompt_journal`, `meta`). Migrations
  et contrôle d'intégrité inclus.
- **Indexation sans copie** : scan récursif des dossiers, lecture des
  métadonnées (EXIF/IPTC/XMP/GPS via `exifr`), génération de vignettes et
  aperçus (via `sharp`) en cache. Les originaux ne sont jamais modifiés.
- **Détection de doublons** par empreinte SHA-256 : un fichier de contenu
  identique est rattaché à la fiche photo existante.
- **Mots-clés arborescents** : création, hiérarchie, suggestions,
  fusion, export CSV.
- **Supports de stockage** : empreinte de reconnexion, statut présent/absent
  (un support absent rend ses photos « indisponibles », jamais supprimées).
- **Import physique** : copie vers la bibliothèque avec détection de doublons
  et renommage unique en cas de collision ; la source n'est jamais supprimée.
- **Moteur de recherche** : mots-clés, appareil, année, format, note,
  disponibilité, tri et pagination.
- **Sauvegardes** : archives ZIP « données » / « programme » / « complète »
  avec vérification d'intégrité et restauration (sauvegarde de sécurité
  automatique avant restauration).
- **Administration** : sauvegardes, versions (publication d'instantanés),
  inspection de la base, licence/copyright, manifeste d'intégrité du
  programme, journal des prompts, export/import de modèle de paramétrage.
- **Interface web** (vanilla JS, sombre par défaut, palette bleu
  profond/turquoise/gris) : barre latérale, recherche globale, grille de
  photos avec vignettes, visionneuse plein écran, barre d'état.
- **Tests automatisés** (`npm test`) : 69 vérifications couvrant mots-clés,
  supports, indexation sans copie, intégrité des originaux, doublons, import,
  sauvegardes, ZIP, licence et reconnaissance des formats.
- **Documentation** : `README.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`,
  `CLAUDE.md`, `.env.example`, `NOTICE`.

### Notes techniques

- Port par défaut **3212** (3210 = Comptes, 3211 = Interets).
- Variables d'environnement `PHOTOTHEQUE_HOME`, `PHOTOTHEQUE_PORT`,
  `PHOTOTHEQUE_HOST`.
- Double persistance : la base SQLite fait foi ; `data/store.json` sert de
  miroir lisible pour les sauvegardes « données ».
- Les vignettes (`data/thumbs/`) sont un cache régénérable, non inclus dans
  les sauvegardes.
