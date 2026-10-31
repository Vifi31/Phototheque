# Photothèque

Application de bureau locale (Windows) pour gérer un fonds photographique
personnel : indexation **sans copie** des originaux, détection de doublons par
empreinte, recherche multicritère, mots-clés, albums, retouches, exports et
sauvegardes. Aucune connexion permanente à Internet n'est requise.

> **Principe fondateur :** vos originaux ne sont **jamais** modifiés, déplacés
> ni supprimés par l'application. L'indexation lit les fichiers, extrait les
> métadonnées et génère des vignettes en cache ; le fichier d'origine reste
> intact à son emplacement.

---

## Démarrage rapide

Prérequis : [Node.js](https://nodejs.org/) 18 ou plus récent.

```powershell
# 1. Installer les dépendances (sharp + exifr)
npm install

# 2. Lancer l'application
npm start
#    ou, sous Windows :
.\Phototheque.bat
```

L'application s'ouvre sur **http://localhost:3212**.

Lancer les tests :

```powershell
npm test
```

---

## Premiers pas

1. **Supports** — enregistrez vos disques, cartes mémoire ou NAS pour suivre
   d'où viennent vos originaux et lesquels sont actuellement connectés.
2. **Importation** — indiquez le chemin d'un dossier à *indexer* (lecture seule,
   sans copie) ou *importer* (copie vers la bibliothèque avec détection de
   doublons).
3. **Photothèque** — parcourez la grille, cherchez par mot-clés, appareil,
   année, format ou note.
4. **Administration** — sauvegardes, versions, base de données, licence et
   manifeste d'intégrité.

---

## Ce que fait chaque module

| Dossier / fichier | Rôle |
| --- | --- |
| `server.mjs` | Serveur HTTP local (`node:http`) + routes API `/api/*` + fichiers statiques. |
| `lib/db.mjs` | Schéma SQLite complet (`node:sqlite`), migrations, intégrité, journal d'historique. |
| `lib/library.mjs` | Cœur métier : scan, indexation sans copie, métadonnées (EXIF/IPTC/XMP), vignettes (sharp), moteur de recherche. |
| `lib/keywords.mjs` | Mots-clés arborescents, suggestions, fusion, export CSV. |
| `lib/supports.mjs` | Supports de stockage, empreinte de reconnexion, statut présent/absent. |
| `lib/imports.mjs` | Import physique (copie), détection de doublons, gestion des collisions de nom. |
| `lib/backup.mjs` | Sauvegardes (données / programme / complète) avec vérification et restauration. |
| `lib/zip.mjs` | Lecture/écriture ZIP sans dépendance externe. |
| `lib/store.mjs` | Double persistance : base SQLite (référence) + miroir `data/store.json`. |
| `lib/license.mjs` | Copyright et licence d'utilisation. |
| `lib/manifest.mjs` | Manifeste d'intégrité du programme (empreintes SHA-256). |
| `lib/versions.mjs` | Publication d'instantanés de version. |
| `lib/model.mjs` | Export/import de modèle de paramétrage (sans données personnelles). |
| `lib/paths.mjs` | Chemins de l'application + lecture du `.env`. |
| `public/` | Interface web (HTML/CSS/JS vanilla, aucun framework). |
| `scripts/test.mjs` | Tests automatisés (mots-clés, supports, indexation, doublons, import, sauvegardes, ZIP). |
| `scripts/journal.mjs` | Journal des prompts (convention des projets frères). |

---

## Structure des données

Tout est écrit sous le dossier de données (par défaut `./data`) :

```
data/
├── phototheque.db      # base SQLite (référence)
├── store.json          # miroir lisible des paramètres (sauvegardes « données »)
└── thumbs/             # vignettes + aperçus (cache, régénérable)
```

Sauvegardes et versions sont écrites dans `Sauvegardes/` et `Versions/` à la
racine du projet.

Pour déplacer le stockage, définissez `PHOTOTHEQUE_HOME` (voir `.env.example`).

---

## Configuration

Variables lues depuis `.env` (copiez `.env.example`) :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PHOTOTHEQUE_HOME` | `./data` | Dossier de données (base, vignettes…). |
| `PHOTOTHEQUE_PORT` | `3212` | Port HTTP local. |
| `PHOTOTHEQUE_HOST` | `127.0.0.1` | Adresse d'écoute (local uniquement par défaut). |

---

## Garanties de sécurité

- **Aucune suppression de source.** Ni l'indexation ni l'import ne suppriment,
  déplacent ni écrasent un fichier d'origine. En cas de collision de nom à
  l'import, un nom unique est généré.
- **Support absent ≠ supprimé.** Un support déconnecté rend ses photos
  « indisponibles », jamais supprimées. La reconnexion est détectée par
  empreinte.
- **Restauration sûre.** Avant toute restauration, une sauvegarde de sécurité
  est créée automatiquement.

---

## Technologies

- **Node.js** (natif : `node:http`, `node:sqlite`, `node:crypto`, `node:zlib`)
- **sharp** — lecture des métadonnées et génération de vignettes/aperçus
- **exifr** — métadonnées EXIF / IPTC / XMP / GPS

Aucune base de données serveur, aucun framework front-end, aucune dépendance
au-delà de `sharp` et `exifr`.

---

## Licence

Voir `LICENSE` et `NOTICE`. Composants tiers : `sharp` et `exifr` (leurs
licences sont détaillées dans l'écran Administration → Licence).
