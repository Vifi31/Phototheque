# Photothèque — inventaire des dépendances et licences

La version à jour de cette liste est produite par l'application elle-même :

- *Administration → Manifeste*, carte *Composants* ;
- le fichier `NOTICE`.

La liste est relevée dans `node_modules` (`thirdParty` dans `lib/license.mjs`).

## Composants livrés

| Composant | Version | Licence | Rôle |
| --- | --- | --- | --- |
| Node.js | 24.x (livré dans `node/` sous Windows) | MIT | Environnement d'exécution, `node:sqlite` (SQLite intégré), `node:crypto`, `node:zlib`, `node:http` |
| sharp | 0.34.5 | Apache-2.0 | Lecture des images, vignettes, retouche, exports, descripteurs de l'assistant IA |
| @img/sharp-win32-x64 | 0.34.5 | Apache-2.0 **et** LGPL-3.0-or-later | Binaires natifs de sharp : libvips et ses bibliothèques |
| @img/colour | 1.1.0 | MIT | Conversion des couleurs (sharp) |
| detect-libc | 2.1.2 | Apache-2.0 | Détection de la plateforme (sharp) |
| semver | 7.8.5 | ISC | Comparaison de versions (sharp) |
| exifr | 7.1.3 | MIT | Lecture des métadonnées EXIF / IPTC / XMP / GPS |

**libvips** est distribuée sous licence LGPL-3.0-or-later, dans le paquet
`@img/sharp-win32-x64` :

- elle reste une bibliothèque dynamique séparée, remplaçable ;
- ses avis de licence sont livrés dans `node_modules/@img/sharp-win32-x64/`.

## Outils utilisés sans être livrés

| Outil | Fourni par | Usage |
| --- | --- | --- |
| IExpress (`iexpress.exe`) | Windows | Construction de l'installateur auto-extractible |
| PowerShell 5.1 | Windows | Scripts d'installation et de désinstallation |
| signtool.exe | Windows SDK (facultatif) | Signature Authenticode, si un certificat est fourni |
| Microsoft Edge (sans fenêtre) | Windows | Captures et PDF du guide (`scripts/guide.mjs`) |

## Composants facultatifs choisis par l'utilisateur

Les moteurs externes de l'assistant IA, par exemple Ollama et ses modèles :

- ne sont ni livrés ni téléchargés par Photothèque ;
- doivent déclarer leur licence, que l'utilisateur accepte avant de les
  activer.

## Code propre

Les modules suivants sont écrits pour Photothèque et n'utilisent aucune
bibliothèque :

- ZIP (`lib/zip.mjs`) ;
- PDF (`lib/pdf.mjs`) ;
- signatures (`lib/dist.mjs`, Ed25519 de `node:crypto`) ;
- chiffrement des sauvegardes (AES-256-GCM, scrypt).
