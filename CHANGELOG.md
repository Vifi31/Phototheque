# Changelog

Toutes les versions notables de Photothèque. Format suivi :
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et
[Versionnement sémantique](https://semver.org/lang/fr/).

## [0.2.1] — 2026-11-05

### Corrigé

- **Suivi de l'indexation** (`server.mjs`) : la liste des travaux était
  recréée à chaque requête, si bien que `/api/jobs/<id>` répondait toujours
  « Travail inconnu ». L'indexation avait bien lieu, mais l'interface
  n'affichait ni la progression ni le message de fin. La liste vit désormais
  aussi longtemps que le serveur.
- **Filtre GPS** (`lib/search.mjs`) : `hasGps=0` (ou `false`) dans l'URL de
  `GET /api/photos` sélectionnait les photos *avec* GPS ; il sélectionne
  maintenant les photos sans GPS.
- **Tests** : 142 vérifications (4 nouvelles pour le filtre GPS).

## [0.2.0] — 2026-11-05

### Ajouté

- **Collections** (`lib/collections.mjs`, étape 2 de la feuille de route) :
  - **sélections** : listes de photos choisies à la main, dans l'ordre
    d'ajout ; ajouter une photo déjà présente n'a aucun effet ;
  - **recherches enregistrées** : critères sauvegardés dont le contenu est
    recalculé à chaque consultation (les photos indexées plus tard y
    apparaissent si elles correspondent). Seuls les critères connus du
    moteur sont enregistrés (`cleanFilters` dans `lib/search.mjs`).
  - Supprimer une collection ou en retirer une photo ne touche jamais aux
    photos ni aux originaux ; une photo retirée de l'index disparaît des
    sélections.
- **API** : `GET/POST /api/collections`, `GET/PUT/DELETE /api/collections/<id>`,
  `POST /api/collections/<id>/photos` (ajout) et `…/photos/remove` (retrait).
  `GET /api/photos?collectionId=<id>` fonctionne pour les deux types et se
  combine avec les autres filtres.
- **Interface** : page Collections (création, consultation, renommage,
  suppression) ; dans la Photothèque, « Ajouter à une collection… » sur la
  sélection, « Retirer de la collection » et « Enregistrer la recherche… ».
- **Tests** : 138 vérifications (110 en 0.1.1), dont 28 pour les collections.

## [0.1.1] — 2026-10-31

### Ajouté

- **Recherche plein texte FTS5** (`lib/search.mjs`) : index `photos_fts`
  insensible à la casse et aux accents, adapté aux gros volumes, tenu à jour
  par trois déclencheurs. Les saisies contenant de la syntaxe FTS5 (`"`, `*`,
  `(`, `:`…) sont neutralisées au lieu de provoquer une erreur. Repli `LIKE`
  si le SQLite fourni n'a pas FTS5.
- **Critères de recherche avancés** sur `GET /api/photos` : ET / OU / NON sur
  le texte (`q`, `anyText`, `excludeText`) et les mots-clés (`keywords`,
  `anyKeywords`, `excludeKeywords`), avec ou sans mot-clé, avec ou sans
  légende, orientation, dimensions, objectif, auteur, intégrité du fichier,
  doublons, GPS. Ces critères ne sont pas encore proposés dans l'interface.
- **Tests** : 110 vérifications (69 en 0.1.0), dont l'index FTS5, les
  accents, les saisies hostiles, la synchronisation de l'index et les
  critères avancés.

### Modifié

- **Schéma de la base en version 2** : la migration crée l'index FTS5 et y
  reverse les photos existantes. La base d'avant migration a été conservée
  dans `data/phototheque.avant-migration-v2.db`.

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
