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
  albumpdf.mjs     Albums : export PDF d'impression / d'aperçu (§9)
  pdf.mjs          Écriture PDF minimale sans dépendance (JPEG, Helvetica WinAnsi)
  edits.mjs        Retouche non destructive : réglages versionnés, versions, historique, rendu (§10)
  exports.mjs      Export de photos : formats, métadonnées, filigrane, profils, lots (§11)
  search.mjs       Moteur de recherche (FTS5, critères avancés, critères enregistrés)
  duplicates.mjs   Doublons : exacts, potentiels, similaires (empreintes visuelles), rafales (§12)
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
  `{ slots: [photoId | null, …], crops: [crop | null, …], title, caption }`.
* Recadrage (`crops`, v0.6.0, facultatif) : pour chaque cadre,
  `{ x, y, zoom }` — centre de la partie visible en fractions de l'image
  orientée (0,5 ; 0,5 = centré) et zoom de 1 (la photo couvre juste le
  cadre) à 5 ; `null` = cadrage centré par défaut. `cropWindow` (dans
  `lib/albums.mjs`) en déduit la partie visible ; l'éditeur
  (`public/app.js`, `cropBox`), les contrôles de résolution et l'export PDF
  font le même calcul. Un cadre perd son recadrage quand sa photo change.
* Gabarits (`LAYOUTS`, `lib/albums.mjs`) : cadres en fractions de la page
  (`x`, `y`, `w`, `h` entre 0 et 1), donc valables pour tout format. Marge
  de sécurité 6 %, gouttière 3 %, bande de légende 6 % en bas ; seul le
  gabarit `plein` va jusqu'au bord (fond perdu).
* Doubles pages (v0.7.0) : un gabarit marqué `spread: true` couvre deux
  pages en vis-à-vis ; ses cadres sont en fractions de la **planche**
  (largeur = 2 × largeur de page). Une ligne `album_pages` à gabarit double
  compte pour deux pages imprimées (`folios()` : `{ folio, span }`). La
  page 1 est une page de droite ; une double page doit commencer sur un
  numéro pair (sinon alerte). `albums.data.spreads` = vue en planches dans
  l'éditeur (préférence d'affichage seulement).
* Annuler / rétablir (v0.8.0) : chaque modification passe par `mutate()`,
  qui mémorise l'état précédent (album + pages, hors préférence `spreads`)
  si l'album a réellement changé. Piles en mémoire, 50 étapes par album,
  perdues au redémarrage du serveur (choix délibéré : pas de migration de
  schéma, et l'annulation sert pendant l'édition). Routes
  `POST …/undo`, `…/redo` ; `…/move-photo` échange deux cadres en une
  étape.
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
  "pages": [{ "page", "layout", "background", "title", "caption", "slots", "crops" }],
  "photos": { "<photoId>": { "path", "sha256", "title", "width", "height" } }
}
```

Toute évolution incompatible de cette structure incrémente
`ALBUM_FORMAT_VERSION`.

### Export PDF (v0.5.0)

`GET /api/albums/<id>/pdf?quality=print|screen&bleed=1` produit le PDF
(`lib/albumpdf.mjs`) avec un écrivain PDF 1.4 maison (`lib/pdf.mjs`) :
images JPEG insérées telles quelles (`DCTDecode`), polices standard
Helvetica / Helvetica-Bold en `WinAnsiEncoding` (pas de police embarquée),
objets écrits au fil de l'eau dans un fichier temporaire pour ne pas garder
les images en mémoire.

* Disposition `layout` : `pages` (une page PDF par page imprimée ; une
  double page est dessinée deux fois, décalée et découpée au pli, chaque
  moitié gardant ses fonds perdus) ou `spreads` (planches de deux pages,
  page 1 seule à droite). L'image d'un cadre n'est écrite qu'une fois.
* Profils `PDF_PROFILES` : `print` 300 ppp / JPEG 90, `screen` 150 ppp /
  JPEG 80 (cadres vides grisés).
* Recadrage « couvrir » centré, comme l'éditeur ; une image plus petite que
  le cadre à la résolution visée est gardée à sa résolution réelle (le
  lecteur PDF l'agrandit, le compte rendu le signale).
* Fonds perdus (`BLEED_MM` = 3) : `MediaBox` et `BleedBox` agrandies,
  `TrimBox` au format ; un bord de cadre posé sur le bord de la page déborde.
* Source d'une photo : premier fichier de la fiche (original), sinon autre
  fichier de même empreinte, sinon aperçu en cache (1600 px).
* Compte rendu renvoyé dans l'en-tête `X-Pdf-Report` (JSON en base64) et
  enregistré dans `exports` (`kind = 'album-pdf'`).

### Réimport d'un projet (v0.14.0)

`analyseProject(project)` (sans écriture) puis `importProject(project,
{ name, withEdits })` dans `lib/albums.mjs` ; routes `POST
/api/albums/import/analyse` et `POST /api/albums/import` (corps
`{ project, name?, withEdits? }`, non passé par `sanitize()` qui tronquerait
les gros albums : chaque champ est relu et nettoyé comme dans l'éditeur).

* Refus clairs : autre format que `phototheque-album`, version de format
  absente ou plus récente que `ALBUM_FORMAT_VERSION`, aucune page, plus de
  500 pages ou de 5000 photos.
* Toujours un **nouvel** album (`data.imported = { at, from, originalId,
  missing }`) ; nom déjà pris → « (importé) », « (importé 2) »…
* Photos retrouvées dans l'ordre : même `id` (et même `sha256` s'il est
  connu des deux côtés), même `sha256`, même chemin de fichier. Une photo
  introuvable garde sa référence dans le cadre et apparaît dans les
  contrôles (« n'est plus au catalogue ») ; l'analyse en donne la liste.
* Retouches (`photos.<id>.edit.params`) : réglages identiques à une version
  existante → rien ; sinon nouvelle version « <nom> (import) », par défaut
  seulement si la photo n'en avait aucune. Une version existante n'est
  jamais modifiée.
* L'export porte désormais `album.spreads` (vue en planches), champ
  facultatif : le format reste en version 1.

Non encore réalisé (cahier des charges §13) : rotation, placement libre, bordures,
gestion des couleurs (CMJN, profils ICC), traits
de coupe, modèles graphiques personnalisés.

## 10. Retouche non destructive (v0.9.0)

Les réglages vivent dans la table `edits` (une ligne par **version** d'une
photo) ; aucun fichier n'est jamais réécrit. `edits.params` est un JSON
versionné (`EDIT_PARAMS_VERSION` = 1) :

```json
{ "v": 1, "rotate": 0, "flipH": false, "flipV": false, "straighten": 0,
  "crop": { "x": 0, "y": 0, "w": 1, "h": 1 } | null,
  "exposure": 0, "brightness": 0, "contrast": 0, "temperature": 0, "tint": 0,
  "saturation": 0, "sharpen": 0, "mono": null | "bw" | "sepia" }
```

* `edits.is_default` désigne la version utilisée par l'export ;
  `edits.data` = `{ v, history: [params…], future: [params…] }` (annuler /
  rétablir persistants, 50 étapes).
* Rendu (`pipeline()`, sharp) : orientation EXIF → quarts de tour +
  redressement → découpe (plus grand rectangle sans coin vide, puis
  recadrage) → miroirs → redimensionnement → lumière et couleur. La géométrie
  passe par un tampon intermédiaire pour garantir l'ordre ; comme sharp
  retourne toujours après la découpe, le recadrage (exprimé dans l'image
  affichée, en fractions) est converti en coordonnées non retournées.
* Couleur : une seule opération linéaire par canal
  `v' = v·2^IL·wb·c + (lum − 128)·c + 128` (wb = balance des blancs par
  température et teinte), puis saturation, noir et blanc ou sépia, netteté.
* Aperçus : `GET /api/photos/<id>/render`, mis en cache dans
  `data/thumbs/edits/` (clé = photo + source + réglages + taille), calculés
  depuis l'aperçu en cache pour la vitesse. L'export, lui, part de
  l'original en pleine définition.
* Albums (v0.10.0) : `albums.get()` remplace, pour une photo qui a une
  version par défaut non neutre, l'aperçu par son rendu et ses dimensions par
  celles de la version (`geometry()`) ; le PDF rend la version en pleine
  définition (`pipeline()`) avant le cadrage du cadre ; le projet exporté
  porte `photos.<id>.edit = { id, name, params }`.
* Grille et visionneuse (v0.13.0) : `editedCard(card, ed)` (`lib/edits.mjs`)
  est la règle commune aux albums et à `library.search()` (via
  `retouchedView`) : vignette `render?size=400` et aperçu `render?size=1200`,
  dimensions de la version, `original` et `edit`. Le paramètre `v` de l'URL
  est une empreinte des réglages (le cache navigateur se renouvelle à chaque
  retouche). La visionneuse (`public/ui.js`) bascule « Voir l'original » /
  « Voir la version retouchée ». L'outil Doublons garde les vignettes
  d'origine (`cardView`) : il compare des fichiers.
* Limites : sharp ne décode pas les RAW (repli sur l'aperçu, signalé) ;
  sortie en sRGB uniquement.

## 11. Export de photos (v0.9.0)

`lib/exports.mjs` exporte vers `Exports/<sous-dossier>` (par défaut
`Exports/Export <date heure>`), jamais ailleurs (le sous-dossier est nettoyé
et contrôlé), sans jamais écraser un fichier (`uniqueName`).

* Profil : `{ name, format: jpeg|png|tiff|webp, quality, maxSide, version:
  default|original, metadata: keep|nogps|none, watermark: { text, position,
  opacity, size }, naming, folder }`. Profils intégrés (`BUILTIN_PROFILES`)
  et profils personnels dans `config` (clé `export.profiles`).
* Métadonnées : réécrites depuis la fiche (appareil, date, auteur,
  copyright, titre, et GPS en mode `keep`) ; l'orientation est appliquée aux
  pixels ; profil ICC sRGB intégré.
* Lot en tâche de fond : `POST /api/exports` → `jobId`, progression par
  `GET /api/jobs/<id>` ; compte rendu consigné dans `exports`
  (`kind = 'photos'`) et l'historique.

## 12. Doublons et photos similaires (v0.11.0)

`lib/duplicates.mjs` calcule les groupes à la demande (rien n'est stocké en
dehors des décisions de l'utilisateur) :

* **Exacts** : `files` groupés par photo (plusieurs fichiers de même
  empreinte, rattachés par l'indexation) et `photos` de même `sha256`.
* **Potentiels** : même `lower(file_name)` et mêmes dimensions, ou même
  `captured_at` + `camera_model` + dimensions, contenu différent.
* **Similaires** : `photos.perceptual_hash` = dHash 64 bits (16 hex) +
  couleur moyenne (6 hex), calculé sur la vignette à l'indexation. Voisins
  par arbre BK (distance de Hamming ≤ tolérance), puis écart de couleur
  moyenne ≤ 48 ; composantes connexes (union-find). Les anciennes empreintes
  de 16 caractères restent comparables (sans contrôle de couleur).
* **Rafales** : même `camera_model`, écart de `captured_at` ≤ N s entre
  photos consécutives.
* Décisions : `photos.data.duplicate` = `{ isReference }` ou
  `{ reference: <id> }` ; paires « pas des doublons » dans `config`
  (clé `duplicates.ignored`) ; fichier de référence = `files.kind`
  `original` pour lui, `copy` pour les autres.
* **Variantes dans la Photothèque (v0.12.0)** : critères de recherche
  `hideVariants`, `variants` et `variantsOf` (`lib/search.mjs`, expression
  `VARIANT_OF` = `json_extract(p.data, '$.duplicate.reference')`, indexée par
  `ix_photos_variant` dans `lib/db.mjs`). Une variante n'est masquée que si sa
  référence est encore indexée. `search()` renvoie `hiddenVariants` quand le
  masquage est actif ; chaque carte porte `variantOf` et `variants` (nombre de
  variantes d'une référence). Le choix masquer / afficher / seulement est une
  préférence d'affichage de l'interface (`localStorage`), hors critères
  enregistrés, sans effet dans une collection.
