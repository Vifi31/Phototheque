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
  imports.mjs      Importation physique (copie / déplacement vérifié) + détection de doublons
  drives.mjs       Détection des lecteurs branchés (cartes, clés, disques) pour l'écran Importation
  phones.mjs       Téléphones / appareils photo en MTP (Windows, Shell.Application via PowerShell) : détection, liste, copie
  supports.mjs     Inventaire des supports, détection/reconnexion
  keywords.mjs     Mots-clés (hiérarchie, synonymes, catégories, fusion, doublons de vocabulaire)
  xmp.mjs          Champs documentaires, lecture / écriture XMP, profil ICC (pur)
  metadata.mjs     Métadonnées en masse : aperçu, relecture, XMP annexes, annulation
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
| Perte d'un original | Irrémplaçable | Ne jamais supprimer la source sans confirmation ; avertir qu'un fichier présent sur un 2ᵉ support n'est pas une sauvegarde vérifiée. Import « Déplacer » : suppression seulement après copie vérifiée par SHA-256, confirmation et rappel de sauvegarde (§29). |
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
* **Suppression d'une fiche (v0.15.0)** : `removeFile(fileId)` retire la
  fiche d'un fichier d'une photo qui en a plusieurs (refus pour le dernier ;
  si c'était le fichier de référence, le premier fichier disponible le
  devient) ; `removePhoto(photoId)` retire la fiche d'une photo
  (`library.removeFromIndex`). Dans les deux cas, aucun fichier n'est effacé
  ni déplacé : les chemins sont notés dans la table `excluded_files`
  (`path`, `sha256`) et `indexFile` renvoie `'excluded'` tant que le contenu
  n'a pas changé. `resetExcluded()` réautorise. Route `POST
  /api/duplicates/remove` (`{ fileId }` | `{ photoId }` | `{ reset: true }`).
  Depuis cette version, un fichier rattaché à une photo existante à
  l'indexation est enregistré en `copy` (le fichier de référence ne change
  plus au gré des réindexations).
* **Variantes dans la Photothèque (v0.12.0)** : critères de recherche
  `hideVariants`, `variants` et `variantsOf` (`lib/search.mjs`, expression
  `VARIANT_OF` = `json_extract(p.data, '$.duplicate.reference')`, indexée par
  `ix_photos_variant` dans `lib/db.mjs`). Une variante n'est masquée que si sa
  référence est encore indexée. `search()` renvoie `hiddenVariants` quand le
  masquage est actif ; chaque carte porte `variantOf` et `variants` (nombre de
  variantes d'une référence). Le choix masquer / afficher / seulement est une
  préférence d'affichage de l'interface (`localStorage`), hors critères
  enregistrés, sans effet dans une collection.

## 13. Planches-contact (v0.16.0)

`lib/contactsheet.mjs` (`createContactSheets(db, library, edits)`) produit
un PDF de vignettes légendées avec `lib/pdf.mjs` (cahier des charges §14).

* Photos : liste d'identifiants (sélection, dans l'ordre) ou critères de la
  grille au format des paramètres de `/api/photos` (tri, filtres,
  collection, variantes ; lus par `filtersFrom()` dans `server.mjs`, commun
  aux deux routes). 3000 photos au plus (`MAX_SHEET_PHOTOS`).
* Options (`cleanSheetOptions`) : format `SHEET_PAGES` (A4 / A3, portrait /
  paysage), colonnes 1–12, lignes 1–16, champs de légende `SHEET_FIELDS`
  (numéro, nom, date, titre, dimensions, note, appareil, mots-clés,
  dossier), titre, qualité `SHEET_QUALITIES` (`screen` : aperçus en cache,
  150 ppp ; `print` : originaux, 300 ppp), version retouchée (oui / non).
  Une grille trop dense pour la page est refusée avec un message.
* Chaque photo est montrée entière (« contenir »), centrée sur un fond gris
  clair ; version retouchée par défaut rendue par `edits.preview()` (cache) ;
  sinon aperçu ou original selon la qualité, avec repli ; une photo
  illisible garde sa case, marquée « illisible ». Légendes coupées à la
  largeur (`fitText`), pied de page : titre, nombre de photos, date,
  « Page n / N ».
* Route `GET /api/contactsheet` (formats, champs, valeurs par défaut) et
  `POST /api/contactsheet` (`{ ids | query, label, options, inline }`) :
  PDF dans un fichier temporaire, envoyé puis effacé, compte rendu dans
  `X-Pdf-Report`, consigné dans `exports` (`kind = 'contact-sheet'`).
* Depuis cette version, les métadonnées du PDF (`/Title`, `/Producer`) sont
  écrites en UTF-16BE : le WinAnsi des pages ne vaut pas pour elles.
## 14. Fiches détaillées et catalogue CSV (v0.17.0)

`lib/catalog.mjs` (`createCatalog(db)`) lit une fois la fiche complète
d'une photo (`record` : colonnes de `photos`, fichiers avec support et
statut, mots-clés, version retouchée par défaut) et la met en forme :

* `detailLines(record)` : lignes « libellé / valeur » des fiches détaillées
  (titre, description, date, auteur, copyright, mots-clés, note, étiquette,
  appareil, objectif, exposition, dimensions, GPS, version retouchée, notes,
  chaque emplacement, empreinte SHA-256, date d'indexation, identifiant) ;
  les valeurs vides sont omises.
* `csv(ids)` : une ligne par photo, colonnes `CSV_COLUMNS` (33). UTF-8 avec
  BOM, séparateur « ; », virgule décimale, fins de ligne CRLF ; un texte qui
  commence par `= + - @` est préfixé d'une apostrophe (pas de formule dans le
  tableur). Consigné dans `exports` (`kind = 'catalog-csv'`).

Les fiches détaillées sont une mise en page du moteur des planches-contact
(`layout: 'detail'` dans `cleanSheetOptions`, `SHEET_LAYOUTS`) : une photo
par page, image entière en haut (55 % de la hauteur utile, 62 % en
paysage), puis le tableau (`wrapText` replie les valeurs, chemins compris ;
3 lignes par valeur, 6 pour description et notes). Ce qui ne tient pas sur
la page est signalé sur la fiche et dans le compte rendu (`truncated`).
Colonnes, lignes et champs de légende ne s'appliquent pas. Consigné dans
`exports` (`kind = 'detail-sheets'`).

Routes : `POST /api/contactsheet` avec `options.layout = 'detail'`, et
`POST /api/catalog/csv` (`{ ids | query, label }`, sans la limite de 3000
photos du PDF). Les deux résolvent les photos par `photoIdsFrom()` dans
`server.mjs` (sélection explicite ou recherche de la grille, tri compris).

## 15. Catalogues thématiques (v0.18.0)

Troisième mise en page du moteur des planches-contact
(`layout: 'catalog'`, option `groupBy`) : les photos sont réparties en
groupes, chacun commençant sur une nouvelle page avec un bandeau (nom,
nombre de photos, « suite » sur les pages suivantes), en grille légendée
comme la planche-contact (mêmes colonnes, lignes, champs). Une ou plusieurs
pages de **sommaire** ouvrent le document : chaque groupe, son nombre de
photos et sa page de début (calculée avant le rendu). La numérotation des
cases est continue sur tout le catalogue.

Regroupements (`GROUP_BY` et `groupsOf()` dans `lib/catalog.mjs`) :

| Clé | Groupe | Sans valeur |
| --- | --- | --- |
| `year` / `month` | année / « juin 2022 » de la prise de vue | Sans date |
| `keyword` | chaque mot-clé (une photo figure dans chacun) | Sans mot-clé |
| `place` | `placeOf()` : Sublocation, City, State, Country (IPTC / XMP, dans `photos.data`), sinon « Position GPS 43,6 ; 1,4 » (dixième de degré) | Lieu non renseigné |
| `folder` / `support` / `camera` | dossier du fichier principal / support / appareil | Aucun fichier / Support inconnu / Appareil inconnu |

Ordre des groupes (`compareGroups`) : chronologique ou alphabétique
(français, nombres naturels), positions GPS après les lieux nommés, groupes
« sans … » à la fin. Dans un groupe, l'ordre est celui de la recherche (tri
de la grille). Le total des cases reste borné à `MAX_SHEET_PHOTOS`
(compte rendu `capped`). Le compte rendu donne `groups` (nom, photos, page)
et `cells` ; consigné dans `exports` (`kind = 'catalog'`).

Le lieu est aussi ajouté aux fiches détaillées et au CSV (colonne `lieu`,
34 colonnes).

## 16. Inventaires et rapports (v0.19.0)

Vue **Rapports** (groupe Analyse). `lib/reports.mjs` (`createReports(db,
{ backups, backupSettings })`) calcule chaque rapport en un modèle commun
— `title`, `subtitle`, `sections` (indicateurs, blocs libellé / valeur,
tableaux), `summary` (compte rendu chiffré), `csv` (colonnes + lignes) —
rendu ensuite en PDF par `lib/reportdoc.mjs` (`renderTableDoc` : tableaux
paginés, en-tête de colonnes répété, section « (suite) », pied de page
« Page n / N » ; composition puis écriture) ou en CSV (mêmes conventions
que le catalogue : BOM, « ; », CRLF, anti-formule).

| Rapport | Contenu |
| --- | --- |
| `inventory` | vue d'ensemble des supports, puis une page par support : identité (type, rôle, état, marque, n° de série, volume, système de fichiers, capacité, chemin, emplacement physique), indicateurs, tableau par dossier (chemin relatif au support). Option `supportId`. Fichiers sans support à part. CSV : une ligne par fichier. |
| `missing` | constat immédiat (`fs.existsSync`), sans écriture en base : « Support non connecté », « Fichier introuvable », « Erreur de lecture ». Pour chaque fichier, autre copie disponible de la même photo ; photos sans aucune copie disponible. Fichiers marqués indisponibles mais présents : « retrouvés ». |
| `integrity` | `PRAGMA integrity_check` et `foreign_key_check` ; fichiers : présence, taille (`quick`), plus empreinte SHA-256 recalculée (`full`) comparée à `files.sha256` (à défaut `photos.sha256`) ; photos sans fichier, en un seul exemplaire, ou dont toutes les copies sont sur le même support. |
| `backups` | liste des sauvegardes (`lib/backup.mjs` : `list`, `verify` CRC de chaque entrée si `verify`), programmation (`store.backup`), ancienneté de la dernière sauvegarde des données (alerte au-delà de deux périodes, au moins 7 jours). |

Aucun rapport ne modifie le catalogue ni les fichiers (les statuts restent
ceux de la dernière indexation ou du dernier rafraîchissement des
supports). Routes : `GET /api/reports` (rapports, supports) et
`POST /api/reports/<kind>/pdf|csv` (`{ options, inline }`), compte rendu
dans l'en-tête `X-Report` (JSON en base64) ; chaque rapport est consigné
dans `exports` (`kind = 'report-<kind>'`) et l'historique.

## 17. Portfolios (v0.20.0)

Quatrième mise en page du moteur des planches-contact
(`layout: 'portfolio'`, `renderPortfolio` dans `lib/contactsheet.mjs`) :

* couverture facultative (`cover`) : la première photo (58 % de la hauteur
  utile), le titre (24 pt, deux lignes au plus), le sous-titre (`subtitle`),
  un filet, l'auteur (`author`), le nombre de photographies et la date ;
* puis une photo par page, la plus grande possible dans les marges
  (`margin`, 5 à 30 mm), centrée, jamais recadrée ; légende centrée sous
  l'image : numéro et titre (à défaut nom du fichier) en gras, puis les
  autres champs cochés sur une ligne (« sans date » omis) ; folio discret
  en bas de page (la couverture compte pour la page 1) ;
* fonds `SHEET_BACKGROUNDS` : blanc, gris clair, noir (couleurs de page, de
  texte principal et secondaire, du filet).

Colonnes et lignes ne s'appliquent pas. Consigné dans `exports`
(`kind = 'portfolio'`). La police reste Helvetica (polices standard de
`lib/pdf.mjs`).

## 18. Guide de l'utilisateur (v0.21.0)

`public/aide/index.html` : guide autonome (HTML + CSS intégrés, schémas en
SVG dans la page, aucune ressource externe), servi par l'application sous
`/aide/` (un dossier de `public/` sert son `index.html`) et ouvert par le
menu **Aide** dans un nouvel onglet. Mise en page écran (sommaire latéral)
et impression A4 (`@media print` : une page par chapitre, couverture sans
marge, sommaire imprimé).

`scripts/guide.mjs` régénère les captures (`public/aide/img/*.jpg`) et le
PDF (`public/aide/Guide-utilisateur-Phototheque.pdf`) :

1. photothèque d'exemple dans `%TEMP%/phototheque-guide` (paysages de
   synthèse en SVG rendus par sharp, EXIF date / appareil, une copie pour
   l'outil Doublons) ; les vraies données ne sont jamais lues ;
2. serveur de démonstration (port 3298) alimenté par l'API : support,
   dossier indexé, titres, notes, mots-clés, collections, version
   retouchée, album, empreintes visuelles, sauvegarde ;
3. Microsoft Edge (ou Chrome) sans fenêtre, piloté par le protocole
   DevTools (WebSocket natif de Node) : une capture par écran
   (`SHOTS`), puis `Page.printToPDF` (pied de page « Page n / N »,
   signets du sommaire).

**Table des matières paginée** : la page `#table` est remplie au chargement
(une ligne par `h2.ch` et par `h3` des chapitres). `printPdf` imprime une
première fois, lit les signets du PDF (`pdfOutline` : arbre `/Outlines`,
`/Dest` → rang de la page dans l'arbre `/Pages`), associe chaque titre à
sa page, pose les numéros (`setTocPages`) et imprime à nouveau ; il vérifie
que la pagination n'a pas bougé entre les deux impressions.

**Pas de coupure** : en impression, `break-inside: avoid` sur paragraphes,
listes, encadrés, figures, cartes, lignes de tableau ; titres collés à ce
qui suit (`break-after: avoid`) ; tableaux coupés entre deux lignes avec
en-tête répété (`thead`, créé au chargement depuis la ligne de `th`).

Options : `--pdf` (PDF seul), `--serve` (photothèque d'exemple laissée
ouverte), `--apercu` (capture du rendu impression dans `%TEMP%`),
`--controle` (chaque page du PDF photographiée, planches dans `%TEMP%`).

## 19. Vocabulaire hiérarchique et critères lieu / sauvegarde (v0.22.0)

`lib/keywords.mjs` :

* **Hiérarchie** : `keywords.parent_id`. `update` refuse un parent inconnu, un
  déplacement sous un descendant (boucle) et deux libellés identiques au même
  niveau. `KEYWORD_TREE_SQL` / `KEYWORD_ID_TREE_SQL` (CTE récursives) donnent un
  mot-clé et tous ses descendants : `lib/search.mjs` s'en sert pour `keywords`,
  `anyKeywords`, `excludeKeywords` et `keywordId`.
* **Champs documentaires** dans `keywords.data` (pas de migration) :
  `description`, `category`, `synonyms` et `synonymsNorm` (formes normalisées,
  lues par `json_each` dans la recherche). `cleanKeywordData` les nettoie.
* **Texte d'appui** : `photos.keywords_text` = « mot1 | mot2 ¦ parent | synonyme ».
  La partie après `KW_EXTRA` (« ¦ ») rend parents et synonymes trouvables par
  FTS5 ; `keywordNamesOf` n'en garde que les noms (planches, catalogue). Tout
  renommage, déplacement, changement de synonymes, fusion ou suppression recalcule
  le texte des photos de la branche (`photosOfTree`).
* **Affectation par nom** (`attachNames` → `resolve`) : libellé à la racine,
  sinon ailleurs dans l'arbre, sinon synonyme ; création à la racine en dernier.
* **Fusion** : refusée si la cible est sous une source ; les libellés des
  sources deviennent synonymes de la cible.
* **Doublons de vocabulaire** (`vocabularyDuplicates`, lecture seule) : même forme
  normalisée, libellé = synonyme d'un autre, forme « lâche » (pluriel s/x/aux,
  tirets, apostrophes), distance d'édition 1 (≥ 5 lettres, ≤ 5 000 mots-clés) ;
  paires regroupées par union-find. `usage()` : statistiques.

Routes : `GET /api/keywords` (+ `categories`), `GET /api/keywords/duplicates`,
`GET /api/keywords/usage` ; `POST`/`PUT` acceptent `category`, `synonyms`,
`description`.

Critères ajoutés à `buildQuery` (et aux recherches enregistrées) : `place`
(LIKE échappé sur `Sublocation`, `City`, `State`, `Country` de `photos.data`),
`hasPlace`, `backup` (`covered` : un fichier sur un support de rôle `backup` ou
`archive` ; `uncovered` ; `single` : au plus un support disponible),
`keywordCategory`.

## 20. Métadonnées : priorité, XMP annexes, modifications en masse (v0.23.0)

**Politique de priorité** (cahier §8) :

1. La fiche (base) est la référence ; aucune valeur n'y est remplacée sans
   aperçu et confirmation.
2. Lecture des fichiers : XMP annexe d'abord (à côté de l'original, nommages
   `IMG.xmp` puis `IMG.jpg.xmp`, puis dossier `Metadonnees/`), sinon
   métadonnées embarquées (exifr : XMP > IPTC > EXIF), champ par champ
   (`library.fileDoc`). À l'indexation d'une **nouvelle** photo, seuls ses
   champs vides sont remplis (`fillFromFile`, réglage `metadata.readOnIndex`).
3. Écriture : uniquement dans des XMP annexes (`metadata.destination` =
   `folder` → `HOME/Metadonnees/<chemin complet>/`, ou `beside`), jamais
   dans l'original.

`lib/xmp.mjs` (pur) : `DOC_FIELDS`, `cleanDoc`, `docFromExifr` (décode les
entités qu'exifr laisse), `buildXmp` (dc:title/description/creator/rights/
subject, lr:hierarchicalSubject, xmp:Rating/Label, photoshop:City/State/Country/
DateCreated, Iptc4xmpCore:Location), `parseXmp` (attributs ou éléments,
x-default d'abord ; préfixes usuels seulement), `sidecarPath`, `findSidecars`,
`iccDescription` (étiquette desc / mluc). Étiquettes : 1 à 5 ↔ Red, Yellow,
Green, Blue, Purple.

`lib/metadata.mjs` : `docOf` (mots-clés en chemins `Parent|Enfant`),
`planEdit` / `applyEdit`, `planRead` / `applyRead` (modes `fill` /
`replace`), `planWrite` / `applyWrite`. L'application recalcule toujours le
plan côté serveur. États d'écriture : create, update (annexe écrite par
Photothèque et inchangée : empreinte dans `photos.data.xmp`), same,
conflict (modifiée ailleurs : laissée, ou remplacée avec copie
`.<date>.xmp.bak`), unavailable, collision. Chaque application de fiches est un
lot `history.kind = 'metadata.batch'` (avant / après par champ) ; `undo`
ne rétablit une valeur que si la fiche porte encore celle du lot. Lots limités à
20 000 photos.

Routes : `GET /api/metadata`, `PUT /api/metadata/settings`,
`GET /api/metadata/doc?id=`, `POST /api/metadata/edit|read|write` (`ids` ou
`query`, `apply: true` pour écrire ; sinon aperçu limité à 300 lignes),
`POST /api/metadata/undo`.

Interface : une seule fenêtre modale à la fois (`ui.js`) — dans le dialogue,
les confirmations se font par un second clic sur le bouton, pas par
`confirmDialog` (qui fermerait le dialogue).

## 21. Navigation : grille, visionneuse, comparaison, historique (v0.24.0)

* **Grille** : `state.grid` (`size` s/m/l/xl → variable CSS `--thumb`, `fit`
  cover/contain, `pageSize` 60/120/240), gardé dans `localStorage`
  (`phototheque.grid`). La pagination reste côté serveur (`limit` / `offset`) :
  jamais plus de 240 vignettes dans la page.
* **Visionneuse** (`ui.js`) : `lightboxOpen(list, i, onNav, actions, opts)` ;
  `opts.fullUrl(p, showOriginal)` (image du zoom), `opts.info(p)` (panneau),
  `opts.onKey(e, p)` (touches propres à l'appelant), `opts.onClose()`.
  `app.js` fournit `viewerOpts()` : notes et étiquettes par `PUT /api/photos`,
  mot-clé par `POST /api/metadata/edit` (lot annulable). Le zoom charge
  `/api/photos/:id/full` (`library.fullImage` : original non RAW, redressé,
  ≤ 6 000 px, JPEG dans `data/thumbs/full/`, 40 fichiers au plus ; sinon
  l'aperçu) ou, pour la version retouchée, `render?edit=…&size=3000`.
  Piège : `HTMLImageElement.decode()` peut ne jamais aboutir dans une page
  masquée → `UI.loadImage` (événements load / error).
  Centrage d'une image agrandie : marges automatiques dans un conteneur flex
  (`place-items: safe center` rognait le débord).
* **Comparaison** (`compareView(ids)`, 2 à 4 photos) : facteur de zoom commun
  relatif à l'affichage ajusté de chaque photo, défilement recopié en
  proportion (verrou `lock` contre les boucles), image pleine définition
  chargée au-delà de ×1,5.
* **Historique** : `pushNav()` après chaque `go()` et chaque recherche de la
  Photothèque, `history.pushState` d'un instantané (vue, filtres, texte, tri,
  page, album, photo en retouche) ; `popstate` le rétablit sans réempiler.
  `_i` numérote les états pour griser ‹ ›.
* **Récemment vues** : `localStorage` `phototheque.recent` (60 ids), affichées
  via le critère `ids` (`lib/search.mjs`, 500 au plus, exclu des recherches
  enregistrées) dans l'ordre de consultation.

## 22. Retouche avancée, profils de couleur, logiciel externe (v0.25.0)

* **Nouveaux réglages** (`lib/edits.mjs`, format `v: 1` inchangé, valeurs neutres
  par défaut) : `highlights`, `shadows`, `vibrance`, `noise`, `colorNoise`,
  `curve` (2 à 16 points [x, y] 0–255, `cleanCurve` ; identité → `null`).
  `TONE_KEYS` (exporté, lu par l'interface) = réglages remplacés par un filtre.
* **Étape pixel par pixel** `applyPixelOps(buf, w, h, canaux, params)`, appelée
  par `pipeline` seulement si l'un de ces réglages est actif : le résultat
  intermédiaire est matérialisé (`raw()`), traité en JS, puis repris par sharp
  (saturation, noir et blanc, netteté). Ordre : bruit (YCbCr ; Y : bilatéral
  rayon 1 ou 2, Cb/Cr : flou en boîte séparable 2 passes), hautes lumières /
  ombres (`toneCurve` sur la luminance, rapport appliqué aux 3 canaux),
  courbe (`curveLut`, Fritsch-Carlson, recopiée dans `app.js` pour l'affichage
  seulement), vibrance. Mesuré : 6 Mpx, bruit fort + couleur ≈ 1,7 s ; aperçu
  1 400 px ≈ 0,3 s.
* **Profil de sortie** (`lib/exports.mjs`, `colorProfile` du profil d'export) :
  rendu en sRGB puis `withIccProfile` (`srgb`, `p3`, `cmyk` — JPEG / TIFF
  seulement, sinon sRGB —, profil embarqué de l'original écrit dans
  `data/thumbs/icc/`, ou `file:<nom>` dans `HOME/Profils/`, nom sans chemin).
* **Logiciel externe** (`lib/external.mjs`) : `prepare` copie l'original
  (`COPYFILE_EXCL`, RAW compris) ou rend la version par défaut en TIFF dans
  `HOME/Edition externe/` ; `launch` n'accepte qu'un fichier de ce dossier et
  un programme .exe/.bat/.cmd/.app existant (`store.external.editor`), sinon
  `explorer.exe` (application associée) ; `index` crée au besoin la fiche du
  dossier et l'indexe. Une copie non modifiée a la même empreinte que
  l'original : l'indexation la rattache à la même photo comme copie.
  Routes : `POST /api/photos/:id/external`, `GET|PUT /api/external`,
  `POST /api/external/index`.

## 23. Albums : styles, modèles, envoi au prestataire ; tirages aux dimensions physiques (v0.26.0)

* **Style de page** (`lib/albums.mjs`, `cleanStyle`) : `album_pages.data.style =
  { border: { width (mm, 0–10), color }, textColor (null = selon le fond), align }`.
  La bordure est un filet intérieur au cadre, à sa position nominale (hors fonds
  perdus), omis sur les gabarits `fullBleed`. Même calcul dans l'éditeur (largeur
  en `cqw`, la feuille est un conteneur `inline-size`), le PDF et le JPEG.
  `updatePage` accepte un style partiel (`mergeStyle`). Le champ voyage dans le
  projet exporté (format 1 inchangé) et est nettoyé au réimport.
* **Modèles graphiques** : `STYLE_PRESETS` (5) + modèles enregistrés (table config,
  clé `album.styles`) ; `applyStyle(id, clé | modèle, { page })` passe par
  `mutate()` (annulable). `blankPage` reprend fond et style de la page précédente.
  Routes : `POST /api/albums/styles`, `DELETE /api/albums/styles/<clé>`,
  `POST /api/albums/<id>/style`.
* **Rendu raster** (`lib/raster.mjs`, `RasterCanvas`) : même interface que
  `PageContent` ; aplats et textes regroupés en calques SVG, images en calques
  rognés au clip, composés par sharp. `albumpdf.render` accepte `output: 'jpeg'`,
  `dir`, `dpi`, `jpeg`, `bleedMm`, `colorProfile`, `onProgress`, `record`.
* **Prestataires** (`lib/albumpdf.mjs`) : `BUILTIN_SERVICES` génériques,
  `cleanService`, `checkService` (format, pages min / max / multiple, zone de
  sécurité comparée aux distances au bord des cadres — 6 % —, des légendes et des
  folios, profil ICC présent). `sendFolder` → `Exports/Envoi <album> <date>/` :
  `album.pdf` ou `pages/`, `album.json`, `LISEZ-MOI.txt` (UTF-8 avec BOM, fins de
  ligne Windows). Routes : `POST|DELETE /api/albums/services…`,
  `POST /api/albums/<id>/send/check`, `POST /api/albums/<id>/send` (travail suivi
  par `/api/jobs`).
* **Tirages** (`lib/exports.mjs`) : `print = { width_mm, height_mm, dpi, fit:
  fill|fit, rotate }` (`cleanPrint`). Le rendu est repris d'un tampon brut avant le
  redimensionnement exact (un second `resize` sur la même chaîne remplacerait le
  premier ; le tampon ne porte aucune métadonnée, donc `withMetadata({ density })`
  ne ramène pas le GPS de l'original). Résolution effective = dpi / échelle,
  `bad` sous 150 ppp, `warn` sous 80 % du dpi visé. Fiche `LISEZ-MOI.txt` (nom
  unique, jamais écrasée).

## 24. Sauvegardes et sécurité (v0.27.0)

* **Réglages** `store.backup` (`backupSettings`) : programmation (`every`
  daily | weekly), `keep`, `verifyEvery`, `maxAgeDays`, `destinations[]`
  ({ id, name, path, kind, enabled, last }), `encrypt` + `verifier` (sel +
  empreinte scrypt, jamais le mot de passe), `events` (100 dernières opérations,
  `ack` pour les échecs vus), `tests` (résultat par archive).
* **Archives** (`lib/backup.mjs`) : ZIP avec `manifest.json` (désormais avec
  `sha256` par fichier). Chiffrée : fichier `.enc` = « PHTQENC1 » | longueur |
  en-tête JSON en clair (manifeste public, authentifié en AAD) | sel | iv |
  étiquette | ZIP chiffré en AES-256-GCM (clé scrypt N = 2^15). Le mot de passe
  vit en mémoire le temps de la session (`unlockEncryption`). Les sauvegardes de
  sécurité (avant restauration) restent possibles sans mot de passe
  (`allowPlain`) : elles ne quittent pas le dossier Sauvegardes.
* **Destinations** : copie dans `<chemin>/Phototheque - sauvegardes/` via un
  fichier temporaire, comparaison SHA-256, renommage ; rétention des seules
  sauvegardes programmées de l'application.
* **Test de restauration** (`testRestore`) : CRC, déchiffrement authentifié,
  SHA-256 du manifeste, `store.json` lisible, base extraite dans un dossier
  temporaire privé (`withArchiveDb`, nettoyé en `finally`) puis ouverte en lecture
  seule : `PRAGMA integrity_check`, tables essentielles. Périodique dans
  `autoTick` (`lib/extra.mjs`).
* **Restauration complète** : sauvegarde de sécurité, base écrite dans
  `data/phototheque.db.restauration` (`STAGED_DB`), appliquée par
  `applyStagedRestore` (`lib/store.mjs`) avant l'ouverture de la base au démarrage
  (fichiers -wal / -shm écartés) ; l'interface relance le serveur.
  **Sélective** (`lib/restore.mjs`) : albums reconstruits en projet puis
  `albums.importProject` (photos retrouvées par id / SHA-256 / chemin),
  collections recréées (statiques : photos retrouvées ; dynamiques : critères),
  documents rendus ; toujours de nouveaux éléments.
* **Alertes** (`alerts`) et **3-2-1** (`rule321`) calculées à la demande ;
  nombre d'alertes dans `/api/state` (`backupAlerts`). Liste des archives : manifestes
  en cache (nom, taille, date) pour ne pas relire chaque archive.
* **Couverture des originaux** : `BACKED_UP` (`lib/search.mjs`) ; rapport
  `coverage` (`lib/reports.mjs`).
* **Verrouillage** (`lib/lock.mjs`) : `store.security.lock` = { enabled, salt, hash
  (scrypt), idleMinutes }. Jetons de session en mémoire, cookie HttpOnly
  SameSite=Strict ; `server.mjs` répond 401 `{ locked: true }` à toute route
  `/api/*` sauf `/api/lock*` et `/api/ping`. L'interface (`api()`) affiche l'écran de
  verrouillage puis rejoue la requête. Oubli : `node scripts/deverrouiller.mjs`.
* **Correctif `config`** (`lib/db.mjs`) : les clés contenant un point
  (`export.profiles`, `album.styles`, `album.services`, `duplicates.ignored`)
  appartiennent à leurs modules ; `saveAdminToDb` ne les efface ni ne les
  réécrit plus, `loadAdminFromDb` ne les charge plus dans le store.

## 25. Tableau de bord (v0.28.0)

* `lib/dashboard.mjs` : `compute(filtres, { refresh })` regroupe les chiffres en
  quelques requêtes agrégées (photos, fichiers, manques, couverture `BACKED_UP`,
  variantes `VARIANT_OF`, répartitions `GROUP BY`, supports), plus
  `PRAGMA quick_check`, l'historique `imports` et l'état des sauvegardes (service
  de `lib/backup.mjs` : liste, journal, alertes, destinations).
* **Cache** : résultat gardé tant que la signature du catalogue (nombres de photos,
  de fichiers, d'associations mots-clés, dernière ligne d'historique, photos
  manquantes) et les filtres sont identiques, 5 minutes au plus ; tailles des
  dossiers (`dirSize`, parcours récursif) gardées 15 minutes. `refresh=1` force.
* **Filtres** : année, support, format (`cleanDashFilters`) ; les volumes de
  dossiers ne dépendent pas des filtres.
* Routes : `GET /api/dashboard` (avec listes d'années, supports, formats pour les
  filtres), `/api/dashboard/csv` (sections successives, UTF-8 avec BOM),
  `/api/dashboard/pdf` (`dashboardDoc` dans `server.mjs` → `renderTableDoc`).
* Interface : barres HTML/CSS (`hbars`, `vbars` dans `public/app.js`) ; une barre
  porte des critères de recherche (`year`, `from`/`to` pour un mois, `format`,
  `camera`, `lens`, `rating`, `supportId`, `noKeyword`, `noCaption`, `noDate`,
  `hasGps=0`) et ouvre la Photothèque filtrée.
* Nouveau critère de recherche `noDate` (`p.captured_at IS NULL`).

## 26. Assistant IA facultatif et local (v0.29.0)

* **Extension retirable** : `lib/ai.mjs` (logique + `aiRoutes`), `public/ia.js` (vue), une
  ligne de création et une ligne de routage dans `server.mjs`, une entrée de menu dans
  `public/app.js`. Le module crée ses tables (`ai_features` : descripteur 128 octets en base64
  + couleurs, lumière, scènes ; `ai_results` : réponse de chaque moteur externe ;
  `ai_suggestions` : `pending` / `accepted` / `rejected`, unique par photo, type, valeur),
  toutes en `ON DELETE CASCADE` sur `photos`. Réglages dans la clé `ai.settings` de
  `config` (clé de module).
* **Descripteur** (`imageFeatures`, sharp, image 64 × 64) : histogramme RGB 4×4×4 en racines
  carrées (64 octets), couleurs moyennes d'une grille 4×4 (48), textures d'une grille 4×4 (16).
  `similarity` = 0,4 coefficient de Bhattacharyya + 0,45 composition + 0,15 textures ; seuil
  « proche » réglable (0,82 par défaut).
* **Suggestions** (`refreshSuggestions`) : les `pending` sont recalculées ; acceptées et
  refusées sont gardées (un refus bloque la réinsertion). Sources : `scene`, `similar`
  (vote pondéré des 8 voisins), `session` (séances coupées à `sessionHours`), `gps`
  (photo située à moins de 2 km), `engine:<id>`, `faces`. Un mot déjà porté (nom, parent,
  synonyme) n'est pas proposé.
* **Acceptation** : `metadata.applyEdit` (lots annulables ; lieu en mode « remplir si vide ») ;
  `undoAccept` annule les lots et remet en attente. `autoAccept` ne s'applique qu'au-delà
  de `autoThreshold` et est tracé dans l'historique.
* **Moteurs externes** : fiches `data/ia/moteurs/<id>.json` (`cleanEngine`) ; `command`
  (arguments `{image}`, `{lang}`, `{gpu}`, réponse JSON lue après d'éventuelles lignes de
  journal, priorité basse via `os.setPriority`) ou `ollama` (`/api/generate`, `format: json`,
  `num_gpu: 0` sans autorisation). Activation impossible sans licence déclarée et acceptée
  (`engineIssues`) ; adresse non locale refusée sans `allowRemote` (consentement daté).
  Modifier une fiche retire l'acceptation de la licence.
* **Analyse** : un travail à la fois (`startAnalysis`, `control` pause / reprise / arrêt),
  une photo à la fois, pause `pauseMs` ; image transmise aux moteurs réduite à `maxSide`
  (fichier temporaire supprimé). Les originaux ne sont lus qu'en lecture.
* Routes `/api/ai` (état), `/settings`, `/engines` (+ `/<id>/test`), `/ollama/models`,
  `/analyse` (+ `/control`), `/suggestions` (+ `accept`, `reject`, `undo`, `forget`,
  `refresh`), `/similar`, `/groups`, `/events`, `/collection`, `/describe`, `/photo`, `/clear`.

## 27. Distribution, signature, installation (v0.30.0)

* `lib/dist.mjs` : liste des fichiers livrés (`DIST_FILES`, `DIST_DIRS`, `DIST_SCRIPTS` —
  jamais data/, Sauvegardes/, Versions/, Exports/, .env, tests), `makeSums` (format
  sha256sum), signature Ed25519 (`signText` / `checkSignature`, `node:crypto`),
  `verifyDist` (modifiés, manquants, ajoutés, signature ; `installation.json`, `.env`,
  `MANIFEST.json` exclus des empreintes car écrits après coup).
* `scripts/build.mjs` : copie dans `dist/Phototheque-<v>/`, Node.js livré (`node/node.exe`,
  signé Authenticode par l'OpenJS Foundation), `MANIFEST.json`, `SHA256SUMS` (+ `.sig` si la
  clé privée est présente), ZIP (`lib/zip.mjs`), installateur IExpress (fichier SED en
  latin1 : `installer.ps1`, le paquet, `paquet.sha256` ; commande
  `powershell -ExecutionPolicy Bypass -File installer.ps1`), paquet multiplateforme,
  `SHA256SUMS` des livrables. Authenticode : `PHOTOTHEQUE_CERT_PFX` /
  `PHOTOTHEQUE_CERT_THUMBPRINT` → signtool (scripts .ps1 avant les empreintes, .exe après).
* Clés : `scripts/cles.mjs` ; privée dans `%USERPROFILE%\.phototheque\signature\` (ou
  `PHOTOTHEQUE_SIGN_KEY`), publique livrée dans `distribution/cle-publique.pem`.
* `distribution/installer.ps1` (PowerShell 5.1, **UTF-8 avec BOM** sinon les accents sont
  lus en ANSI) : empreinte du paquet, extraction (.NET ZipFile) dans %TEMP%, vérification par
  `node\node.exe scripts\verifier.mjs` — avec `--cle <clé installée> --signature-obligatoire`
  si la version installée était signée —, refus si l'application répond sur son port,
  `programme` → `programme.precedent`, `.env` (PHOTOTHEQUE_HOME, PHOTOTHEQUE_PORT) et
  `installation.json`, raccourcis (WScript.Shell), clé
  `HKCU\…\Uninstall\Phototheque`. Options `-SansRaccourcis -SansRegistre -NePasLancer -Silencieux`.
* `distribution/desinstaller.ps1` : se relance depuis une copie temporaire, retire
  raccourcis (seulement s'ils pointent vers ce programme), inscription, `programme` et
  `programme.precedent` ; jamais le dossier des données.
* `distribution/Phototheque.cmd` → `scripts/lancer.mjs` : ouvre le navigateur si le serveur
  répond déjà, sinon importe `server.mjs` puis ouvre le navigateur.
* Routes `GET /api/install` (installé, dossiers, signature) et `POST /api/install/verify`.

## 28. Filtre « Mots-clés » de la Photothèque (v0.31.0)

* Aucun nouveau critère de recherche : le filtre de la barre (`kwFilterSel`, `public/app.js`)
  écrit `noKeyword`, `hasKeyword` ou `keywordId` dans `state.facet` (un seul à la fois) ; la
  recherche (`lib/search.mjs`) les connaissait déjà. `keywordId` inclut les descendants
  (`KEYWORD_ID_TREE_SQL`).
* `library.keywordFacets()` (`GET /api/facets` → `keywords`) : `none` / `any` (photos sans / avec
  mot-clé), `counts` (photos distinctes par mot-clé), `branch` (photos distinctes de la branche, pour
  les seuls mots-clés qui ont des enfants). Comptage en direct : `keywords.photo_count` peut être
  périmé hors `recount()`.
* Synchronisation avec la recherche avancée : `advancedPanel()` expose `syncKeyword()` (liste
  « Présence ») ; en sens inverse, son rappel `onApply` relit `kwCurrent()`. Si `noKeyword` et
  `keywordId` sont présents ensemble (recherche avancée), la liste de la barre affiche « Sans mot-clé ».
* **Saisie assistée** : `UI.keywordInput(input, { source, multi })` (`public/ui.js`) enveloppe un champ
  texte dans `div.kw-ac` avec une liste `.suggest`. `UI.keywordMatches(list, terme, { exclude, limit })` est la
  fonction pure de classement : début du libellé, début d'un mot, synonyme, contient, synonyme contenant
  (comparaison repliée : accents, casse, `-'’_.`). Source : `kwSource` (`GET /api/keywords`, relue au focus).
  L'écouteur `keydown` est en phase de capture : avec une proposition choisie il bloque Entrée / Échap pour les
  gestionnaires de la fenêtre modale et de la visionneuse ; sans choix, Entrée garde son rôle (valider la
  saisie). Un chemin saisi à la main (`Lieux|Montagne`) n'est pas proposé. Testé dans `scripts/test.mjs`
  (`ui.js` chargé dans un contexte `vm`).

## 29. Importation : supports détectés, choix des photos, copie ou déplacement (v0.32.0)

* `lib/drives.mjs` : `detectDrives()` (Windows : `Get-CimInstance Win32_LogicalDisk` via PowerShell, ~2 s ; repli sur
  les lettres existantes ; macOS / Linux : `/Volumes`, `/media`, `/run/media`, `/mnt`). `parseWindowsDisks` et
  `classifyDrive` sont purs et testés : les lecteurs sans volume (lecteur de cartes vide) sont ignorés ;
  amovible + `DCIM` = carte (`sd`), amovible sans `DCIM` = clé (`usb`), fixe = disque, réseau = NAS (jamais sondé).
  `likelyImport` (amovible ou `DCIM`, hors disque système) range le lecteur en tête.
* `imports.drives()` : détection mise en cache 4 s (appels simultanés regroupés) + rapprochement avec les supports
  enregistrés (point de montage ou empreinte). Interface : actualisation toutes les 10 s tant que l'écran est affiché.
* `imports.scan(dossier)` : liste récursive des images (sans dossiers cachés / corbeilles), triée ; `known` = un
  fichier de même nom et de même taille est déjà dans `files` (indication, le doublon exact reste décidé par
  SHA-256). Le dossier est mémorisé comme **analysé** : `imports.preview()` (vignette JPEG, cache mémoire) et le
  mode « move » n'acceptent que des fichiers sous un dossier analysé.
* `imports.importFiles(sources, { mode, verify, removeDuplicateSources, shouldStop, copyFile, removeFile })` :
  - copie → contrôle de taille → (en move, ou `verify`) SHA-256 de la copie → dates reportées → indexation ;
  - **move** : suppression de la source seulement si copie identique **et** indexation réussie ; sinon la copie
    ratée est retirée et la source reste. `dropFileRow` retire la ligne `files` de la source (indexée sur place) et
    promeut la copie en « original » ;
  - doublon + `removeDuplicateSources` : source supprimée si un exemplaire **hors du support source** existe,
    de même taille et de même empreinte (recalculée) ; sinon conservée avec la raison ;
  - `checkMovable` refuse : dossier non analysé, fichier dans la photothèque, dans `data/` ou dans le programme ;
  - `copyFile` / `removeFile` sont injectables (tests : copie altérée, suppression impossible).
* Serveur : `POST /api/import/start` crée un travail (`JOBS`, `kind: 'import'`) ; un seul à la fois (409) ;
  `onProgress` ne touche que `done / total / current / phase` (le `status` du travail ne doit jamais être écrasé :
  l'interface l'interroge). `POST /api/import/cancel` positionne `job.cancel`.
* Table `imports` : `mode` (`copy` | `move`) et `data` (compteurs, `removedSources` plafonné à 500). Historique :
  `import.copy` / `import.move`.
* Non couvert : XMP annexes voisins, lecteurs sans lettre (MTP : téléphones), détection macOS / Linux non essayée.

## 30. Téléphones branchés (v0.33.0)

* **Pourquoi un module à part** : un téléphone en MTP / PTP n'a ni lettre de lecteur ni chemin pour `node:fs`. Windows le
  montre comme « appareil portable » dans « Ce PC » et ne l'expose qu'à l'interface Shell. `lib/phones.mjs` lance donc
  un script PowerShell constant (`-EncodedCommand`, Windows PowerShell 5.1) qui utilise `Shell.Application` :
  `NameSpace(17).Items()` pour les appareils, `GetFolder.Items()` pour parcourir, `CopyHere` pour copier.
* **Opérations** (une par exécution, requête JSON dans un fichier temporaire désigné par `PT_REQ`, réponses en lignes
  JSON UTF-8 ; une erreur non prévue sort en `{fatal}`) : `detect` (nom, chemin Shell, `vid` USB, stockages),
  `list` (images de `DCIM` et `Pictures`, profondeur ≤ 10, limite), `copy` (un dossier de destination par fichier).
  Les appareils sont repérés par leur chemin Shell (`usb#vid_…`, `wpdbusenum`, GUID WPD) : ce filtre écarte les
  lecteurs (`C:\`) et les dossiers système (« Photos iCloud »).
* **Pièges Shell** : l'Explorateur peut masquer les extensions (nom `IMG_0001` sans `.jpg`) : le type affiché
  (« Fichier JPG ») sert alors à décider et le fichier copié est renommé avec le nom attendu. `CopyHere` est
  asynchrone : on attend un fichier de taille stable, au moins égale à la taille annoncée, et libéré (ouverture
  exclusive). `NameSpace` exige des antislashs. Pas de `2>&1` / progression : `$ProgressPreference` est coupé.
* **Un seul accès à la fois** (file `serial`) : un appareil MTP ne tolère pas les sessions simultanées.
* `imports.scanPhone(id)` mémorise les photos listées (`phoneScans`) : seules celles-ci peuvent être prévisualisées ou
  importées (403 sinon). `previewPhone` copie la photo dans un dossier temporaire, fait la vignette, efface.
  `importFromPhone(id, rels)` : lots de 20 → `phones.copy` vers un dossier temporaire → `processOne` sur chaque
  fichier copié → effacement ; une seule ligne `imports` (`data.phone`). **Copie seulement** (le serveur refuse
  `mode: 'move'` avec `phone`).
* Ligne « supports détectés » : `root: 'phone:<id>'`, `kind` `phone` | `camera`, `phone: { id, name, brand, ready,
  storages }`. Un appareil sans stockage est « verrouillé ou non autorisé ».
* `createDemoPhones(dossier)` (`PHOTOTHEQUE_DEMO_PHONE`) : un dossier joue le téléphone, avec le même code Shell.
* Testé : classement USB, analyse des réponses, détection simulée, liste / copie / arrêt / limite sur un vrai dossier
  via PowerShell, import complet avec un appareil simulé. **Non essayé avec un vrai téléphone.**
