# Photothèque — Architecture technique

> Document de référence. Les choix techniques importants y sont justifiés et les
> risques majeurs listés. Ce document évolue à chaque étape validée.

## 1. Positionnement

Application **locale de bureau**, mono-utilisateur, pour un particulier. Les
originaux restent sur les disques de l'utilisateur ; l'application n'est qu'un
**catalogue intellectuel et documentaire** (index, métadonnées, vignettes,
liens) plus un ensemble d'outils (import, recherche, albums, sauvegardes).

Aucune fonction essentielle ne dépend d'Internet. Aucune donnée (photo ou
métadonnée) n'est envoyée vers un service distant.

## 2. Pile technique retenue

| Couche | Choix | Justification |
|---|---|---|
| Exécution | **Node.js 24** (module `node:sqlite`, `node:crypto`, `node:fs`) | Déjà présent sur la machine ; un seul runtime à installer ; `node:sqlite` évite toute base externe ; cohérent avec les applications voisines (Comptes, Intérêts). |
| Base de données | **SQLite** (module intégré, fichier unique) | Parfait pour un usage mono-utilisateur local, zéro administration, sauvegarde par simple copie de fichier, migrable vers PostgreSQL plus tard si besoin réel. |
| Serveur HTTP | **`node:http`** natif, sans framework | Un seul fichier `server.mjs`, aucune dépendance serveur, démarrage instantané. |
| Traitement d'images | **`sharp`** (libvips) | Génération de vignettes/aperçus rapide et de qualité, lecture des dimensions et orientation. Binaire natif précompilé. |
| Métadonnées | **`exifr`** | Lecture EXIF/IPTC/XMP fiable, léger, sans dépendance native. |
| Interface | **JavaScript vanilla + CSS**, servie par le serveur | Zéro build, zéro framework, une seule page, chargement rapide. Cohérent avec le reste de l'écosystème. |
| Chiffrement sauvegardes | **`node:crypto`** (AES-256-GCM) | Intégrité + confidentialité, sans dépendance. |

### Alternatives étudiées et écartées

* **Tauri (Rust)** : meilleure intégration native et distribution, mais exige
  une chaîne de compilation Rust + WebView2, et complexifie considérablement
  la maintenance et les tests. *Reconsidérer si une distribution packagée
  (.exe signé) devient un vrai besoin.*
* **Electron** : lourd (~200 Mo), consommation mémoire élevée, pour un usage
  local la fenêtre navigateur suffit.
* **Client lourd Python (Pillow/RawPy)** : excellente lecture RAW mais ajoute un
  second runtime à installer et maintenir.

## 3. Architecture logicielle (modulaire)

```
public/            Interface (HTML/CSS/JS vanilla) — aucune logique métier lourde
server.mjs         Point d'entrée : routage HTTP, service des fichiers statiques
lib/
  paths.mjs        Emplacements (ROOT, HOME, data, sauvegardes, versions…)
  appinfo.mjs      Identité lue dans app.config.json
  db.mjs           Base SQLite : schéma, migrations, transactions, intégrité
  store.mjs        Persistance (chargement/enregistrement du store)
  library.mjs      Moteur : scan, indexation, métadonnées, vignettes, recherche
  imports.mjs      Importation physique (copie) + détection de doublons
  supports.mjs     Inventaire des supports, détection/reconnexion
  keywords.mjs     Gestionnaire de mots-clés (hiérarchie, fusion, suggestions)
  collections.mjs  Sélections statiques et recherches enregistrées (dynamiques)
  albums.mjs       Albums : formats, pages à gabarits, contrôles, export du projet (§9)
  search.mjs       Moteur de recherche (FTS5, critères avancés, critères enregistrés)
  duplicates.mjs   Doublons exacts (empreintes) et similaires (empreintes visuelles)
  backup.mjs       Sauvegardes / vérification / restauration
  zip.mjs          Mini ZIP sans dépendance
  versions.mjs     Versions du programme, instantanés, retour arrière
  license.mjs      Copyright, licence, composants tiers
  admin.mjs        Journal des prompts, licence (routes d'administration)
  extra.mjs        Sauvegardes, versions, manifeste, modèles (routes)
  dbadmin.mjs      Administration de la base (lecture, contrôle, export)
  manifest.mjs     Manifeste : empreintes SHA-256 des fichiers du programme
  model.mjs        Modèles de paramétrage réutilisables
  seed-prompts.mjs Journal et modèles de prompt initiaux
scripts/
  test.mjs         Suite de tests (unitaires, intégration, parcours)
  journal.mjs      Gestion du journal des prompts et des versions (CLI)
data/              Base SQLite, store.json, cache de vignettes (non versionné)
```

**Séparation stricte** : l'interface n'accède jamais directement aux fichiers ;
tout passe par l'API `/api/*`. La sécurité (validation des chemins, limites
d'accès) est appliquée dans la logique métier (`lib/library.mjs`,
`lib/supports.mjs`), jamais seulement dans l'interface.

## 4. Modèle de données (schéma SQLite)

Schéma complet versionné dans `lib/db.mjs` (`SCHEMA` + `SCHEMA_VERSION`).
Entités principales :

* `photos` — la **photo logique** (identité, métadonnées enrichies, notes,
  évaluation, couleur, mots-clés aplatys pour la recherche plein texte).
* `files` — les **fichiers physiques** d'une photo (original, variante, copie),
  chacun avec son chemin, support, dossier, empreinte et statut de disponibilité.
* `supports` — les supports de stockage (disques, cartes, NAS…), leur rôle,
  leur statut, leur empreinte de reconnexion.
* `folders` — les dossiers indexés, rattachés à un support.
* `keywords` + `photo_keywords` — arborescence de mots-clés et affectations.
* `albums`, `album_photos`, `album_pages` — albums et mises en page.
* `collections`, `collection_photos` — sélections statiques ou **requêtes
  enregistrées** (collections dynamiques).
* `edits` — réglages de retouche non destructifs (paramètres JSON).
* `imports`, `exports` — historique des travaux d'import/export.
* `history` — journal des opérations (audit).
* `settings`, `license`, `prompt_journal`, `meta`, `config` — réglages et
  administration (schéma identique aux applications voisines).

**Principe** : la base n'est jamais le seul endroit d'une information
irremplaçable. Les originaux sont chez l'utilisateur ; les vignettes sont un
cache régénérable ; les sauvegardes emportent la base + les exports utiles.

## 5. Flux d'indexation (sans copie)

```
dossier source → scan (récursif, extensions image)
   → pour chaque fichier : taille, mtime, empreinte SHA-256 (optionnelle)
   → lecture métadonnées (exifr) + dimensions/orientation (sharp)
   → génération vignette + aperçu (sharp) dans data/thumbs (cache)
   → écriture en base (transaction par lot)
   → le fichier source n'est JAMAIS modifié ni déplacé
```

Si le support est absent, la fiche photo est conservée, marquée
`disponible = non` ; elle n'est jamais confondue avec une photo supprimée.

## 6. Sécurité

* Le serveur n'écoute que sur `127.0.0.1` par défaut.
* Toute opération sur les fichiers valide que le chemin cible reste dans les
  répertoires autorisés (bibliothèque, imports) — protection contre les
  chemins malveillants (`..`, liens symboliques) et les chemins hors périmètre.
* Aucune écriture dans les fichiers originaux ; les retouches sont non
  destructives (paramètres séparés).
* Sauvegardes chiffrables (AES-256-GCM) ; clés protégées dans `data/secrets.json`.
* Journalisation des opérations importantes (`history`).

## 7. Risques majeurs

| Risque | Impact | Atténuation |
|---|---|---|
| Support déconnecté → fichiers manquants | Catalogue inutilisable si mal géré | Statut de disponibilité, détection, procédure de reconnexion par empreinte/chemin relatif. |
| Changement de lettre de lecteur (Windows) | Chemins invalides | Recherche par empreinte de volume + chemin relatif + noms de fichiers. |
| Volume important (centaines de milliers de photos) | Lenteur | Indexation par lots, en arrière-plan ; vignettes générées progressivement ; index SQL sur les colonnes recherchées. |
| Corruption de la base | Perte du catalogue | WAL, sauvegardes régulières, `PRAGMA integrity_check`, export JSON. |
| Perte d'un original | Irrémplaçable | Ne jamais supprimer la source sans confirmation ; avertir qu'un fichier présent sur un 2ᵉ support n'est pas une sauvegarde vérifiée. |
| Dépendances natives (sharp) | Problème d'installation | Binaires précompilés ; repli : lecture des dimensions sans vignette. |

## 8. Étapes de réalisation (méthode)

1. ✅ Architecture, schéma, décisions (ce document).
2. **Socle** : base, navigation, indexation sans copie, gestion des supports,
   recherche, vignettes. → *cette étape*
3. Métadonnées enrichies, mots-clés avancés, collections, doublons.
4. Retouches non destructives, albums, catalogues, exports.
5. Sauvegardes, restauration, statistiques, versions.
6. Sécurité, tests, performances, documentation, installation.

Chaque étape produit une version exécutable et testable, sans supprimer les
fonctions déjà validées.

## 9. Albums : format de projet (version 1)

Un album est enregistré dans la base (`albums`, `album_pages`) et ne contient
que des **références** aux photos : aucun original n'est copié. L'index
`album_photos` (quelles photos utilise quel album) est reconstruit à chaque
enregistrement ; il sert au filtre `albumId` de la recherche.

* `albums.format` : format prédéfini (`carre-30`, `carre-20`, `a4-portrait`,
  `a4-paysage`, `20x30-portrait`, `30x20-paysage`) ou `custom` ;
  `albums.data` : `{ formatVersion, width_mm, height_mm }`.
* `album_pages` : une ligne par page (`page` = ordre, à partir de 1),
  `layout` (gabarit), `background` (couleur `#rrggbb`), `data` :
  `{ slots: [photoId | null, …], title, caption }`.
* Gabarits (`LAYOUTS`, `lib/albums.mjs`) : cadres en fractions de la page
  (`x`, `y`, `w`, `h` entre 0 et 1), donc valables pour tout format. Marge
  de sécurité 6 %, gouttière 3 %, bande de légende 6 % en bas ; seul le
  gabarit `plein` va jusqu'au bord (fond perdu).
* Contrôles : photo introuvable (retirée du catalogue, la référence est
  conservée pour être signalée), photo indisponible, résolution effective
  sous 150 ppp (bloquant) ou 240 ppp (limite), photos hors gabarit, cadres
  vides.

L'export (`GET /api/albums/<id>/export`, fichier `*.album.json`) produit :

```json
{
  "format": "phototheque-album", "formatVersion": 1, "exportedAt": "…",
  "album": { "id", "name", "description", "format", "orientation", "width_mm", "height_mm", "created_at", "updated_at" },
  "layouts": { "<gabarit>": { "label", "frames": [{ "x", "y", "w", "h" }], "fullBleed?" } },
  "pages": [{ "page", "layout", "background", "title", "caption", "slots" }],
  "photos": { "<photoId>": { "path", "sha256", "title", "width", "height" } }
}
```

Toute évolution incompatible de cette structure incrémente
`ALBUM_FORMAT_VERSION`.

Non encore réalisé (cahier des charges §13) : recadrage manuel dans les
cadres, rotation, placement libre, bordures, doubles pages, fonds perdus
au-delà du gabarit `plein`, annulation/rétablissement, aperçu et export
d'impression (PDF), modèles graphiques personnalisés, réimport d'un projet.
