# Photothèque — guide d'installation

Ce guide couvre l'installation sous Windows, la mise à jour, la désinstallation,
la vérification des distributions et la construction des livrables.

---

## 1. Ce qui est livré

`node scripts/build.mjs` produit, dans `dist/` :

| Fichier | Pour qui | Contenu |
| --- | --- | --- |
| `Phototheque-<v>-installation.exe` | Windows 10 / 11 (x64) | Installateur auto-extractible : contrôle, installe, crée les raccourcis. |
| `Phototheque-<v>-windows-x64.zip` | Windows, version portable | Programme et Node.js 24 livré (`node\node.exe`), sans installation. |
| `Phototheque-<v>-multiplateforme.zip` | macOS, Linux | Programme seul. Il faut Node.js 24 installé. |
| `SHA256SUMS` (+ `SHA256SUMS.sig`) | tous | Empreintes des trois fichiers, signées par l'éditeur. |

Aucun de ces fichiers ne contient de données personnelles : catalogue,
sauvegardes, exports et réglages restent dans le dossier des données.

---

## 2. Installer sous Windows

1. Double-cliquez sur `Phototheque-<v>-installation.exe`.
   - Si l'installateur n'est pas signé par un certificat Authenticode, Windows
     SmartScreen affiche « Windows a protégé votre ordinateur ».
   - Avant de continuer, vérifiez l'empreinte du fichier (§ 5). Cliquez ensuite
     *Informations complémentaires → Exécuter quand même*.
2. Une fenêtre s'ouvre et vérifie le paquet :
   - empreinte SHA-256 du paquet ;
   - empreinte de chacun des fichiers du programme ;
   - signature de l'éditeur.
3. Indiquez les deux dossiers ou validez les dossiers proposés :
   - **Programme** : `%LOCALAPPDATA%\Programs\Phototheque\programme`. Aucun
     droit d'administrateur n'est demandé.
   - **Données** : `Documents\Photothèque`, qui reçoit le catalogue, les
     vignettes, les sauvegardes, les instantanés de version et les exports.
4. Répondez `O`. L'installateur :
   - crée les raccourcis *Photothèque* dans le menu Démarrer et sur le Bureau ;
   - inscrit le programme dans *Paramètres → Applications installées* ;
   - lance l'application.

L'application s'ouvre dans le navigateur, à l'adresse http://localhost:3212.
La petite fenêtre noire est le serveur local. Fermez-la pour arrêter
Photothèque.

### Installation silencieuse ou personnalisée

```powershell
Phototheque-0.30.0-installation.exe /Q            # silencieuse, dossiers par défaut
```

Pour choisir les dossiers, extrayez d'abord le contenu de l'installateur
(`/T:dossier /C`), puis lancez le script :

```powershell
powershell -ExecutionPolicy Bypass -File installer.ps1 -Destination D:\Applis\Phototheque -Donnees D:\Photos\Catalogue -Port 3212
```

Options du script :

- `-SansRaccourcis` : ne crée pas les raccourcis ;
- `-SansRegistre` : n'inscrit pas le programme dans *Applications installées* ;
- `-NePasLancer` : ne lance pas l'application à la fin ;
- `-Silencieux` : ne pose aucune question.

### Version portable

1. Décompressez `Phototheque-<v>-windows-x64.zip` où vous voulez, par exemple
   sur une clé USB.
2. Lancez `distribution\Phototheque.cmd`.

Sans fichier `.env`, les données sont rangées dans le dossier décompressé, à
côté du programme. Pour les mettre ailleurs, créez un fichier `.env` à la
racine :

```
PHOTOTHEQUE_HOME=D:\Photos\Catalogue
PHOTOTHEQUE_PORT=3212
```

### macOS et Linux

Il faut [Node.js](https://nodejs.org/) 24 ou plus récent.

1. Décompressez `Phototheque-<v>-multiplateforme.zip`.
2. Lancez `sh distribution/phototheque.sh`. Au premier lancement, le script
   installe les dépendances : `npm install` télécharge `sharp` pour votre
   système.

Ce paquet n'a pas été essayé sur macOS ni sur Linux. Seules les parties
communes (Node.js, SQLite, sharp) sont multiplateformes.

---

## 3. Mettre à jour

1. Fermez Photothèque : fermez sa fenêtre noire. L'installateur refuse de
   continuer si l'application répond encore.
2. Lancez l'installateur de la nouvelle version. Il reprend automatiquement le
   dossier du programme, le dossier des données et le port.
3. L'installateur vérifie la nouvelle version **avec la clé de la version déjà
   installée**. Un paquet modifié est refusé, même s'il contient une autre clé
   et une signature recalculée. Rien n'est alors remplacé.
4. L'ancienne version est gardée dans `programme.precedent` jusqu'à la mise à
   jour suivante. Pour revenir en arrière :
   1. renommez `programme` en `programme.ko` ;
   2. renommez `programme.precedent` en `programme`.

Au premier démarrage d'une nouvelle version, la base est migrée
automatiquement. Les migrations sont versionnées : `meta.schema_version`, et
`MIGRATIONS` dans `lib/db.mjs`. Avant une mise à jour importante, faites une
sauvegarde *Complète* (Administration → Sauvegardes).

---

## 4. Désinstaller

Passez par *Paramètres → Applications installées → Photothèque →
Désinstaller*, ou lancez `programme\distribution\desinstaller.ps1`.

- Sont supprimés : le programme, la version précédente, les raccourcis et
  l'inscription.
- **Vos données ne sont jamais effacées.** Leur dossier est indiqué à la fin.
  Supprimez-le vous-même si vous n'en avez plus besoin.

---

## 5. Vérifier une distribution

### Avant d'installer

Calculez l'empreinte du fichier téléchargé, puis comparez-la à la ligne
correspondante de `SHA256SUMS` :

```powershell
Get-FileHash .\Phototheque-0.30.0-installation.exe
```

La signature de `SHA256SUMS` se contrôle avec la clé publique de l'éditeur
(`distribution/cle-publique.pem`, empreinte `8a7326434bffe515`), à partir d'un
dossier contenant le programme :

```powershell
node scripts\verifier.mjs dossier-extrait --signature-obligatoire
```

### Une installation existante

Deux façons :

- **Administration → Manifeste → Installation**, puis *Vérifier l'installation* ;
- en ligne de commande :

  ```powershell
  programme\node\node.exe programme\scripts\verifier.mjs programme
  ```

La vérification signale chaque fichier modifié, manquant ou ajouté, ainsi
qu'une signature invalide.

### Signature Authenticode

C'est la signature des exécutables reconnue par Windows. Elle demande un
certificat de signature de code, délivré par une autorité de certification.

Sans ce certificat, les distributions sont signées seulement avec la clé
Ed25519 de l'éditeur, ci-dessus. Cette signature est vérifiée par
l'installateur et par l'application, mais pas par Windows. SmartScreen
avertit donc au premier lancement.

---

## 6. Construire les livrables

```powershell
npm install                     # dépendances
npm test                        # tests automatisés
node scripts/cles.mjs           # une seule fois : paire de clés de signature
node scripts/build.mjs          # → dist/
```

### Clé de signature

- La **clé privée** est dans `%USERPROFILE%\.phototheque\signature\cle-privee.pem`,
  hors du dépôt. Un autre emplacement peut être indiqué avec
  `PHOTOTHEQUE_SIGN_KEY`.
- Sauvegardez-la hors de cet ordinateur. Sans elle, une nouvelle clé serait
  nécessaire, et les installations existantes refuseraient les mises à jour
  signées avec cette nouvelle clé. Il faudrait alors désinstaller puis
  réinstaller ; les données sont conservées.
- Sans clé privée, `scripts/build.mjs` produit des distributions non signées.
  Les empreintes sont tout de même calculées.

### Authenticode

Si vous disposez d'un certificat de signature de code, indiquez-le avant de
lancer la construction :

- `PHOTOTHEQUE_CERT_PFX`, avec `PHOTOTHEQUE_CERT_PASSWORD` si le fichier est
  protégé ;
- ou `PHOTOTHEQUE_CERT_THUMBPRINT`, pour un certificat du magasin Windows.

`signtool.exe`, fourni avec le Windows SDK, signe alors les scripts
d'installation et l'installateur, avec horodatage. L'adresse d'horodatage se
règle avec `PHOTOTHEQUE_TIMESTAMP_URL`.

### Options de construction

- `--sortie dossier` : écrit les livrables ailleurs que dans `dist/` ;
- `--sans-exe` : ne produit pas l'installateur ;
- `--sans-node` : n'embarque pas Node.js ;
- `--sans-multiplateforme` : ne produit pas le paquet macOS / Linux.

L'installateur est produit par **IExpress**, fourni avec Windows. Aucun outil
tiers n'est nécessaire.
