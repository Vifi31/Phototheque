# Photothèque — sauvegarde, restauration, récupération après incident, migration

Le guide de l'utilisateur, au chapitre « Sauvegarder et administrer », montre les
écrans. Ce document rassemble les procédures.

---

## 1. Ce qu'il faut protéger

| Élément | Où | Protégé par |
| --- | --- | --- |
| **Vos photos originales** | Vos disques (supports) | **Vous** : copies sur d'autres disques (règle 3-2-1). Photothèque ne les copie pas dans ses sauvegardes. |
| Catalogue (fiches, mots-clés, albums, collections, retouches, suggestions de l'IA) | `data/phototheque.db` | Sauvegarde *Données* ou *Complète* |
| Réglages | `data/store.json` + table `config` | Sauvegarde *Données* ou *Complète* |
| Documents de travail | `Documents/` | Sauvegarde *Données* ou *Complète* |
| Vignettes et aperçus | `data/thumbs/` | Rien : ils sont **régénérables** |
| Programme | dossier du programme | Installateur (ou sauvegarde *Programme*) |
| Clé privée de signature (éditeur seulement) | `%USERPROFILE%\.phototheque\signature\` | Copie hors de l'ordinateur |

Les chemins du tableau sont relatifs au **dossier des données**. Par défaut,
c'est `Documents\Photothèque` pour une version installée et le dossier du
programme en développement.

Ce dossier est indiqué à deux endroits :

- dans *Administration → Manifeste → Installation* ;
- dans le fichier `.env` du programme (`PHOTOTHEQUE_HOME`).

---

## 2. Sauvegarder

1. Ouvrez **Administration → Sauvegardes**.
2. Cliquez *Créer* et choisissez le type : *Données* (le plus fréquent) ou
   *Complète*.
3. Ajoutez au moins une **destination** sur un autre support : disque externe,
   NAS, ou disque conservé ailleurs.
   - Chaque sauvegarde y est copiée puis relue (SHA-256).
   - La carte *Stratégie 3-2-1* indique ce qui manque.
4. Activez la **programmation** (quotidienne ou hebdomadaire) et le **test de
   restauration automatique**. Par défaut, ce test a lieu tous les 7 jours.
5. Facultatif : **chiffrement** des archives (AES-256-GCM, mot de passe).
   - **Le mot de passe n'est enregistré nulle part.** Si vous le perdez, les
     archives chiffrées sont illisibles.
   - Notez-le dans un gestionnaire de mots de passe.
6. Pour les **originaux** :
   1. ouvrez le rapport *Originaux non couverts* (menu Rapports) ;
   2. copiez les photos listées sur un support de rôle « Sauvegarde » ou
      « Archive » ;
   3. indexez ce support. La couverture remonte dans le tableau de bord.

> Une synchronisation (OneDrive, copie miroir) n'est pas une sauvegarde : une
> suppression ou un fichier abîmé s'y propagent.

---

## 3. Restaurer

| Besoin | Procédure |
| --- | --- |
| Vérifier qu'une archive est bonne | *Tester* : rien n'est remplacé. |
| Récupérer un album, une collection, un document | *Contenu…* → cocher → *Restaurer la sélection*. Les éléments reviennent sous le nom « … (restauré) », sans rien écraser. |
| Revenir entièrement à une date | *Tout restaurer…* : une sauvegarde de sécurité de l'état actuel est créée, la base restaurée est préparée, puis l'application redémarre et l'applique avant d'ouvrir la base. |
| Archive sur un autre ordinateur | *Importer une archive…* (fichier `.zip` ou `.enc`), puis *Tester* et *Restaurer…*. |

Une sauvegarde *Programme* ne se restaure pas depuis l'application.
Réinstallez plutôt la version voulue avec son installateur.

---

## 4. Récupération après incident

### L'application ne démarre plus

1. Lisez le message de la fenêtre noire. Lancez `distribution\Phototheque.cmd`
   depuis une invite de commandes pour le garder affiché.
2. **Port déjà utilisé** :
   - une autre Photothèque est peut-être ouverte : fermez-la ;
   - ou changez `PHOTOTHEQUE_PORT` dans le `.env` du programme.
3. **Programme abîmé** : *Administration → Manifeste → Vérifier l'installation*,
   ou `node\node.exe scripts\verifier.mjs .` dans le dossier du programme.
   - Si des fichiers sont modifiés ou manquants, relancez l'installateur de la
     même version.
   - Ou revenez à `programme.precedent` (docs/INSTALLATION.md, § 3).
4. **Base illisible**, message *database disk image is malformed* :
   1. arrêtez l'application ;
   2. copiez de côté le dossier `data/` en entier (gardez la base abîmée) ;
   3. supprimez `data/phototheque.db`, `phototheque.db-wal` et
      `phototheque.db-shm` ;
   4. démarrez l'application ;
   5. *Importer une archive…* si besoin, puis *Tout restaurer…* la dernière
      sauvegarde qui passe le test.

### Le catalogue est cohérent mais des photos sont « indisponibles »

Leur disque est débranché ou a changé de lettre. Ce n'est pas une perte.

1. Rebranchez le disque.
2. *Supports → Actualiser*.
3. Le rapport *Fichiers manquants* indique où chercher.

### Une manipulation est à annuler

- Métadonnées modifiées en masse, ou suggestions de l'IA acceptées : annulez le
  lot (fenêtre *Métadonnées…* de la Photothèque, onglet
  *Historique*, ou le bouton proposé après l'acceptation).
- Retouches : historique de la photo.
- Album : *Annuler* dans l'éditeur.
- Sinon : restauration sélective (§ 3).

### Le mot de passe de verrouillage est oublié

1. Arrêtez l'application.
2. Dans le dossier du programme, lancez :

   ```powershell
   node\node.exe scripts\deverrouiller.mjs
   ```

   En développement, la commande est `node scripts\deverrouiller.mjs`.

Seul le verrouillage de l'interface est désactivé.

### Le mot de passe des sauvegardes chiffrées est perdu

Ces archives ne peuvent plus être ouvertes : c'est voulu. Pour repartir :

1. désactivez puis réactivez le chiffrement avec un nouveau mot de passe ;
2. faites tout de suite une nouvelle sauvegarde.

### L'ordinateur est perdu ou en panne

1. Installez Photothèque sur le nouvel ordinateur (§ 5).
2. Restaurez la dernière sauvegarde depuis une destination externe.
3. Rebranchez les disques de photos. Ils sont reconnus par leur empreinte.

---

## 5. Migrer vers un nouvel ordinateur

1. Sur l'ancien ordinateur :
   1. faites une sauvegarde *Complète* ;
   2. copiez-la sur un disque externe (destination, ou *Télécharger*).
2. Sur le nouvel ordinateur :
   1. installez Photothèque (docs/INSTALLATION.md) ;
   2. ouvrez *Administration → Sauvegardes → Importer une archive…* ;
   3. lancez *Tout restaurer…*. L'application redémarre.
3. Rebranchez les supports de photos, puis *Supports → Actualiser*.
   - Les disques sont reconnus par leur empreinte, même si leur lettre a changé.
   - Les chemins restés invalides apparaissent dans le rapport *Fichiers
     manquants*.
   - Un dossier déplacé se réindexe : les fiches sont rattachées par
     l'empreinte SHA-256 des fichiers.
4. Si vous utilisiez l'assistant IA avec des moteurs externes :
   - réinstallez ces moteurs, par exemple Ollama et son modèle ;
   - leurs fiches de déclaration sont dans `data/ia/moteurs/` ;
   - acceptez de nouveau leur licence dans *Assistant IA → Réglages*.

### Déplacer seulement le dossier des données

1. Arrêtez l'application.
2. Déplacez le dossier.
3. Corrigez `PHOTOTHEQUE_HOME` dans le fichier `.env` du programme. Ou relancez
   l'installateur, qui demande le dossier des données.
