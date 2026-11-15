# Photothèque — fonctionnalités terminées et limitations connues

État en version 0.30.0. Le détail version par version est dans `CHANGELOG.md`,
la conception dans `docs/ARCHITECTURE.md` et l'usage dans le guide de
l'utilisateur (menu Aide).

Une fonction figure ici seulement si elle est implémentée **et** couverte par
les tests automatisés (`npm test`) ou vérifiée dans l'application.

---

## Fonctionnalités terminées

| Domaine | Fonctions |
| --- | --- |
| **Catalogue** | <ul><li>Base SQLite avec migrations versionnées</li><li>Indexation sans copie (originaux en lecture seule)</li><li>Importation par copie ou déplacement vérifié (SHA-256), avec détection des supports branchés, choix des photos, détection des doublons et noms uniques</li><li>Vignettes et aperçus en cache</li><li>Supports de stockage, avec détection des supports absents et reconnexion par empreinte</li></ul> |
| **Métadonnées** | <ul><li>EXIF, IPTC et XMP (fichier et annexe), avec règle de priorité</li><li>Modification en masse, avec aperçu et lots annulables</li><li>Écriture d'annexes XMP</li><li>Lecture du profil ICC</li></ul> |
| **Classement** | <ul><li>Notes et étiquettes de couleur</li><li>Mots-clés hiérarchiques, synonymes et catégories</li><li>Doublons de vocabulaire</li><li>Collections : sélections et recherches enregistrées</li></ul> |
| **Recherche** | <ul><li>Plein texte FTS5, insensible aux accents</li><li>Critères avancés : dates, appareil, objectif, lieu, GPS, état de sauvegarde, manques…</li><li>Variantes masquables</li></ul> |
| **Navigation** | <ul><li>Grille à tailles variables</li><li>Visionneuse avec zoom pleine définition et panneau d'informations</li><li>Classement au clavier</li><li>Comparaison de photos</li><li>Historique de navigation et photos récemment vues</li></ul> |
| **Retouche** | <ul><li>Retouche non destructive : réglages versionnés, historique, préréglages</li><li>Tonalité, courbe, vibrance, réduction du bruit, recadrage</li><li>Ouverture dans un logiciel externe</li></ul> |
| **Exports** | <ul><li>Formats et métadonnées choisis, filigrane</li><li>Profils d'export et de couleur (ICC)</li><li>Tirages aux dimensions physiques</li><li>Exports par lot</li></ul> |
| **Albums** | <ul><li>Formats et gabarits, doubles pages, recadrage</li><li>Textes, styles et modèles graphiques</li><li>Annuler / rétablir</li><li>Contrôles avant impression</li><li>Export en PDF et en JPEG par page</li><li>Dossier prêt à envoyer à un imprimeur</li><li>Export et réimport du projet (JSON)</li></ul> |
| **Documents** | <ul><li>Planches-contact et fiches détaillées</li><li>Catalogues thématiques et portfolios</li><li>Catalogue CSV</li><li>Inventaires et rapports (PDF / CSV)</li></ul> |
| **Doublons** | <ul><li>Doublons exacts et potentiels</li><li>Photos similaires (empreinte visuelle) et rafales</li><li>Choix d'une référence et de ses variantes</li><li>Aucune suppression automatique</li></ul> |
| **Tableau de bord** | <ul><li>Chiffres clés et manques documentaires</li><li>Répartitions en barres cliquables</li><li>Volumes</li><li>Export PDF et CSV</li></ul> |
| **Sauvegardes** | <ul><li>Types Données, Programme et Complète, programmation</li><li>Destinations multiples, règle 3-2-1</li><li>Chiffrement AES-256-GCM</li><li>Test de restauration</li><li>Restauration sélective et complète (appliquée au démarrage)</li><li>Import d'une archive</li><li>Alertes et journal</li><li>Rapport des originaux non couverts</li></ul> |
| **Sécurité** | <ul><li>Verrouillage de l'interface (mot de passe, inactivité)</li><li>Serveur limité à cet ordinateur (127.0.0.1)</li><li>Validation des chemins</li><li>Manifeste d'intégrité du programme</li></ul> |
| **Assistant IA (facultatif)** | <ul><li>Moteur intégré local</li><li>Suggestions de mots-clés et de lieux à valider</li><li>Recherche par description, photos proches, regroupements, séances</li><li>Moteurs externes : programme local ou Ollama, avec licence acceptée ; envoi distant seulement avec consentement</li></ul> |
| **Distribution** | <ul><li>Installateur Windows sans droits d'administrateur</li><li>Version portable</li><li>Paquet multiplateforme</li><li>Empreintes SHA-256 et signature Ed25519, vérifiées à l'installation et depuis l'application</li><li>Mises à jour vérifiées avec la clé installée, retour à la version précédente</li><li>Désinstallation qui garde les données</li></ul> |
| **Documentation** | <ul><li>Guide de l'utilisateur (HTML + PDF)</li><li>Installation ; sauvegarde, récupération et migration</li><li>Architecture et formats de projets</li><li>Dépendances et licences</li><li>Journal des versions</li></ul> |

---

## Limitations connues

### Formats et traitement

- **RAW** : `sharp` (libvips) ne décode pas les fichiers RAW.
  - Leur affichage et leur retouche utilisent l'aperçu intégré au fichier.
  - Pour développer un RAW, passez par *Ouvrir dans…* un logiciel spécialisé.
- **Assistant IA, moteur intégré** :
  - les indices de scène (ciel, végétation, nuit, coucher de soleil, noir et
    blanc) sont des règles simples sur les couleurs et les textures, qui se
    trompent parfois ;
  - il ne reconnaît pas les objets. La reconnaissance d'objets et la détection
    de visages demandent un moteur externe ;
  - la comparaison des photos proches passe en revue tout le catalogue. Elle
    reste rapide pour une photothèque personnelle, jusqu'à quelques dizaines de
    milliers de photos.
- **Assistant IA, moteurs externes** :
  - l'échange avec Ollama est testé avec un serveur simulé ;
  - Ollama est installé sur la machine de développement, mais sans modèle de
    vision. Il n'a donc pas été essayé avec un vrai modèle de vision.

### Importation

- **Déplacement** : la source n'est effacée qu'après une copie identique (SHA-256) et indexée ; la
  photothèque détient ensuite le seul exemplaire, à sauvegarder.
- **Détection des supports** : testée sous Windows (cartes et clés non essayées sur un vrai lecteur :
  les tests couvrent l'analyse de la sortie système). macOS et Linux : points de montage usuels, sans essai réel.
- **Filtres de la Photothèque** : années, appareils, formats et mots-clés à choix multiples (ou logique) ; notes et
  disponibilité à choix unique. Importation : filtre « pas encore importées / déjà importées ».
- **Téléphones** (MTP, Windows) : détectés, photos de `DCIM` et `Pictures` listées, copiées ou déplacées (le déplacement
  supprime la photo de l'appareil après copie vérifiée). **Non essayé avec un vrai téléphone** : testé sur un dossier lu par la même
  interface Shell. Pas de vidéos ; vignettes lentes (chaque photo est copiée).
- Les fichiers annexes XMP voisins d'une photo ne sont ni copiés ni déplacés.

### Distribution

- **Signature Authenticode** :
  - la procédure de signature (signtool) est prête, mais elle demande un
    certificat de signature de code. Elle n'a pas été exercée faute de
    certificat ;
  - sans ce certificat, Windows SmartScreen avertit au premier lancement de
    l'installateur ;
  - les distributions restent signées avec la clé Ed25519 de l'éditeur, que
    l'installateur et l'application vérifient.
- **macOS et Linux** : le paquet multiplateforme n'a pas été essayé sur ces
  systèmes. Il demande Node.js 24, et `npm install` y installe `sharp`. Il
  n'existe pas d'application macOS empaquetée (.app / .dmg) ni de paquet Linux
  (.deb / .rpm).
- **Installateur** :
  - il fonctionne dans une fenêtre console (IExpress + PowerShell), sans
    assistant graphique ;
  - les étapes vérifiées sont :
    - l'extraction de l'exécutable ;
    - l'installation, la mise à jour et la désinstallation en mode silencieux,
      dans un dossier de test ;
    - le refus d'un paquet falsifié ;
    - le refus d'une mise à jour pendant que l'application est ouverte.
  - le parcours interactif complet (double-clic, raccourcis, inscription dans
    *Applications installées*) n'a pas été exécuté sur le poste de
    développement, pour ne pas modifier sa configuration.

### Utilisation

- **Application locale mono-utilisateur** :
  - l'interface s'ouvre dans le navigateur, servie par un serveur local
    (127.0.0.1) ;
  - il n'y a ni accès réseau partagé, ni comptes multiples.
- **Envoi à un imprimeur** : Photothèque prépare un dossier à déposer sur le
  site du prestataire. Aucune intégration directe avec un service d'impression
  n'existe.
- **Sauvegardes** :
  - la copie vers un vrai disque externe ou un NAS, ainsi que le redémarrage
    automatique après une restauration complète, sont testés sur des dossiers
    locaux ;
  - ils n'ont pas été essayés sur ces matériels.
- **Tests de performance et de sécurité** :
  - les tests automatisés couvrent le fonctionnement, l'intégrité et les
    contrôles d'accès (verrou, chemins, signature) ;
  - il n'existe pas de campagne de mesure de performance sur un très grand
    fonds (plus de 100 000 photos) ;
  - aucun audit de sécurité externe n'a été mené.
