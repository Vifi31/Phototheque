# Photothèque — notes de travail (CLAUDE.md)

Application de bureau locale (Windows) de gestion d'un fonds photographique
personnel. Node.js + SQLite (`node:sqlite`), sans connexion permanente à
Internet. Interface web vanilla JS servie par un serveur `node:http` local.

Ce fichier reprend les conventions des projets frères (`C:\DVP\Interets`,
`C:\DVP\Comptes`) : `lib/` pour la logique, `public/` pour l'interface,
`scripts/` pour les tests et le journal, `data/` pour les données.

---

## Commandes

```powershell
npm install          # dépendances (sharp, exifr)
npm start            # démarre le serveur → http://localhost:3212
npm test             # lance scripts/test.mjs (tests automatisés)
node scripts/journal.mjs "texte du prompt" [statut] [version]
```

Sous Windows, `.\Phototheque.bat` installe les dépendances si besoin, ouvre le
navigateur et lance le serveur.

**PowerShell :** utiliser `;` comme séparateur (pas de `&&`), pas de `tail`
(utiliser `Select-Object -Last n`), pas de `which` (utiliser `Get-Command`).
Écrire les fichiers en UTF-8 sans BOM (les accents doivent être propres).

---

## Architecture en une phrase

`server.mjs` (routes API + statique) délègue à `lib/*.mjs` (logique métier +
`node:sqlite`) ; l'interface `public/*.js` appelle les routes `/api/*` et
n'a aucune logique métier.

### Couches

| Couche | Fichiers | Rôle |
| --- | --- | --- |
| Serveur | `server.mjs` | `node:http`, routage `/api/*`, fichiers statiques, sanitisation des chemins. |
| Logique | `lib/*.mjs` | Moteur d'indexation, recherche, mots-clés, supports, imports, sauvegardes, admin. |
| Base | `lib/db.mjs` | Schéma SQLite + migrations + intégrité + journal d'historique. |
| Interface | `public/*.js` | Vanilla JS, aucun framework ; `ui.js` (helpers), `app.js` (contrôleur), `admin.js` (administration). |
| Scripts | `scripts/*.mjs` | `test.mjs` (tests), `journal.mjs` (journal des prompts). |

---

## Conventions

- **Pas de suppression de source.** Ni l'indexation ni l'import ne suppriment,
  déplacent ni écrasent un fichier d'origine. En cas de collision de nom à
  l'import, générer un nom unique.
- **Support absent ≠ supprimé.** Un support déconnecté rend ses photos
  « indisponibles » ; la reconnexion est détectée par empreinte.
- **Indexation sans copie** = lecture seule des originaux + vignettes en cache
  (`data/thumbs/`, régénérable, hors sauvegardes).
- **Ne jamais présenter une fonction comme terminée tant qu'elle n'a pas été
  implémentée et vérifiée.**
- **Écrire en UTF-8 propre**, sans accents mal encodés.
- **Journal des prompts** : enregistrer chaque demande via
  `node scripts/journal.mjs` (convention des projets frères).

---

## Données

Tout est sous `./data` (déplaçable via `PHOTOTHEQUE_HOME`) :

```
data/
├── phototheque.db   # base SQLite (référence)
├── store.json       # miroir lisible des paramètres (sauvegardes « données »)
└── thumbs/          # vignettes + aperçus (cache régénérable)
```

Sauvegardes → `Sauvegardes/` ; instantanés de version → `Versions/`.

Base SQLite ouverte avec `PRAGMA foreign_keys=ON`, mode WAL,
`busy_timeout=5000`.

---

## Configuration

`.env` (cf. `.env.example`) : `PHOTOTHEQUE_HOME`, `PHOTOTHEQUE_PORT` (3212),
`PHOTOTHEQUE_HOST` (127.0.0.1).

---

## Dépendances

| Paquet | Usage | Licence |
| --- | --- | --- |
| `sharp` | Lecture des métadonnées image, vignettes et aperçus | Apache-2.0 |
| `exifr` | Métadonnées EXIF / IPTC / XMP / GPS | MIT |

Aucune autre dépendance externe. `node:sqlite`, `node:crypto`, `node:zlib`,
`node:http` sont utilisés nativement (le ZIP est géré par `lib/zip.mjs` sans
bibliothèque).

---

## Points de vigilance

- `sharp` et `exifr` se chargent **en `await import(...)`** (modules ESM
  lourds) — ne pas les importer en haut de fichier si le module peut être
  chargé sans eux.
- La recherche plein texte (`q`) passe par l'index FTS5 `photos_fts`
  (schéma v2, `lib/search.mjs`) : insensible à la casse et aux accents. La
  saisie n'est jamais injectée brute dans `MATCH` (`toMatch`). Repli `LIKE`
  seulement si le SQLite fourni n'a pas FTS5. L'index est tenu à jour par
  trois déclencheurs `photos_fts_*`.
- `indexFile` rattache un fichier de même empreinte à la fiche photo existante
  (doublon) au lieu d'en créer une nouvelle.
- Avant toute restauration, `lib/backup.mjs` crée une sauvegarde de sécurité.

---

## Étapes de réalisation

1. ✅ Socle : base, indexation sans copie, recherche, mots-clés, supports,
   import, sauvegardes, administration, interface, tests — **livré (v0.1.0)**.
2. ✅ Collections (sélections statiques + recherches sauvegardées) —
   **livré (v0.2.0)**, `lib/collections.mjs`.
3. Albums et mises en page (gabarits portrait/paysage).
4. Retouches non destructives + exports.
5. Détection de doublons avancée (similitude perceptuelle) et outil dédié.
