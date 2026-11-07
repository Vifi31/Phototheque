# Changelog

Toutes les versions notables de Photothèque. Format suivi :
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et
[Versionnement sémantique](https://semver.org/lang/fr/).

## [0.28.0] — 2026-11-07

### Ajouté

- **Tableau de bord** (menu « Tableau de bord », anciennement « Statistiques ») :
  - chiffres clés : photos, fichiers, volume référencé, fichiers indisponibles,
    supports et supports absents, état général du catalogue, couverture des
    originaux, doublons et variantes, mots-clés, albums, collections ;
  - manques documentaires : sans mot-clé, sans légende, sans titre, sans date,
    sans GPS, sans note ;
  - répartitions en barres par année, mois, mois de l'année, format, appareil,
    objectif, note et support ; **une barre cliquée ouvre la Photothèque
    filtrée** ;
  - volumes séparés : originaux, copies, aperçus, exports, sauvegardes,
    instantanés, XMP, documents, catalogue, photos copiées par l'importation ;
  - sauvegardes récentes, échecs des 30 derniers jours, alertes ;
  - historique des importations ;
  - filtres par année, support et format ; export **PDF** et **CSV**.
- Critère de recherche « sans date de prise de vue ».

### Performances

- Le tableau de bord n'est calculé qu'à l'ouverture de la vue, puis gardé en
  cache tant que le catalogue ne change pas (5 minutes au plus ; tailles des
  dossiers : 15 minutes). La navigation n'en dépend pas.

## [0.27.0] — 2026-11-07

### Ajouté

- Sauvegardes :
  - **plusieurs destinations** (autre disque, disque externe, NAS, support
    conservé ailleurs) : chaque sauvegarde y est copiée puis **vérifiée par
    SHA-256**, avec rétention ; un disque débranché donne une alerte, pas une
    erreur bloquante ; bouton « Copier » pour rattraper ;
  - **chiffrement** facultatif des archives (AES-256-GCM, clé dérivée par
    scrypt ; mot de passe jamais enregistré, seulement une empreinte de
    contrôle ; saisi une fois par démarrage pour les sauvegardes programmées) ;
  - **test de restauration** sans rien remplacer (CRC, empreintes SHA-256,
    catalogue ouvert dans un dossier temporaire, intégrité SQLite), manuel ou
    périodique ;
  - **aperçu du contenu** (comparé au catalogue actuel) et **restauration
    sélective** d'albums, de collections et de documents, recréés à côté de
    l'existant ;
  - **alertes** (échec, copie impossible, sauvegarde trop ancienne, test raté),
    bouton « ⚠ Sauvegardes » en haut des pages, **journal** des opérations ;
  - carte **3-2-1** et taux de **couverture des originaux**.
- Rapport **Originaux non couverts** (photos sans copie sur un support de
  sauvegarde ou d'archive), PDF et CSV. Le rapport de sauvegardes reprend tests,
  destinations et journal.
- **Verrouillage** facultatif de l'application : mot de passe au lancement et
  après inactivité, bouton « Verrouiller », attente après 5 erreurs ;
  `scripts/deverrouiller.mjs` en cas d'oubli.

### Corrigé

- La base n'était pas vidée de son journal WAL avant d'être sauvegardée (le
  service recevait `getDb` mais attendait `db`) : une sauvegarde pouvait manquer
  les dernières modifications.
- La restauration complète réécrivait la base pendant qu'elle était ouverte :
  elle est désormais déposée à côté et appliquée au redémarrage.
- L'enregistrement des réglages effaçait ou remettait à une ancienne valeur les
  données rangées par les modules dans la table `config` (profils d'export,
  modèles d'album, profils de prestataire, groupes de doublons écartés).

## [0.26.0] — 2026-11-07

### Ajouté

- Albums :
  - **style de page** : bordure des photos (filet de 0 à 10 mm à l'intérieur des
    cadres), couleur et **alignement** des textes (gauche, centré, droite) ;
  - **modèles graphiques réutilisables** (fond + bordure + textes) : cinq
    fournis, les vôtres enregistrés pour tous les albums, appliqués à une page
    ou à tout l'album (annulable) ; une nouvelle page reprend le style de la
    précédente ;
  - **alignement** d'une photo dans son cadre (bords, coins, centre) dans le
    recadrage ; les **guides** montrent aussi les axes du centre des pages.
- **Préparer l'envoi** d'un album : dossier dans `Exports/` avec PDF unique ou
  JPEG par page / par planche (résolution, fonds perdus, profil ICC), le projet
  et une fiche LISEZ-MOI (spécifications, contrôles, fichiers). **Profils de
  prestataire** enregistrables (format, fonds perdus, zone de sécurité, nombre
  de pages, type de fichier) et contrôles avant préparation. Les profils fournis
  sont génériques ; rien n'est envoyé.
- Export de photos aux **dimensions physiques** : format en mm (10 × 15,
  13 × 18, 20 × 30, A4, personnalisé), résolution inscrite dans le fichier,
  recadrage ou photo entière, orientation suivie, **résolution effective**
  calculée et signalée, fiche de commande LISEZ-MOI. Quatre profils « Tirage ».

### Inchangé

- Format de projet d'album : version 1 (champ `style` ajouté aux pages, ignoré
  par les versions précédentes).

## [0.25.0] — 2026-11-07

### Ajouté

- Retouche :
  - **hautes lumières** et **ombres** (sur la luminance : la teinte est
    conservée) ;
  - **vibrance** (ravive d'abord les couleurs ternes) ;
  - **réduction du bruit** de luminance (filtre bilatéral, contours préservés)
    et de couleur (flou de la chrominance) ;
  - **courbe de tonalité** éditable (points à glisser, interpolation monotone)
    et six courbes prédéfinies ;
  - filtres « Film (fondu) » et « Détails dans les ombres ».
- Export : **profil de couleur** de sortie — sRGB, Display P3, profil de
  l'original, CMJN générique (JPEG / TIFF), ou un profil ICC personnel déposé
  dans le dossier `Profils/`.
- **Ouvrir dans un logiciel externe** (écran Retouche) : le logiciel reçoit une
  copie dans `Edition externe/` (fichier d'origine, RAW compris, ou version
  retouchée en TIFF) ; les fichiers modifiés s'ajoutent à la photothèque en un
  clic. Programme choisi dans Paramètres (sinon l'application associée).

### Inchangé

- Les RAW restent retouchés sur leur aperçu (sharp ne les décode pas) ; le
  guide conseille « Ouvrir dans… » vers un logiciel de développement RAW.
- Les versions existantes s'affichent à l'identique (nouveaux réglages neutres
  par défaut, format de réglages inchangé).

## [0.24.0] — 2026-11-07

### Ajouté

- **Grille** : quatre tailles de vignettes (S, M, L, XL), vignettes carrées ou
  images entières, 60 / 120 / 240 photos par page ; choix mémorisés.
- **Visionneuse** :
  - zoom (double-clic, molette, Z, + / -) sur l'image **pleine définition**
    (original redressé, plafonné à 6 000 px, petit cache de 40 images ; version
    retouchée jusqu'à 3 000 px), déplacement à la souris ;
  - panneau **Informations** (touche I) : note et étiquette cliquables,
    mots-clés avec saisie (K), prise de vue, couleur, lieu, fichiers ;
  - **classement rapide** au clavier : 0–5 note, 6–9 étiquette, Début / Fin.
- **Comparaison côte à côte** de 2 à 4 photos (sélection, visionneuse, outil
  Doublons) : zoom et déplacement synchronisés, note sous chaque photo.
- **Historique de navigation** : boutons ‹ › (et Alt+← / Alt+→) qui rétablissent
  l'écran, les filtres, la recherche et la page.
- **Récemment vues** : les 60 dernières photos ouvertes dans la visionneuse.
- Critère `ids` (liste explicite de photos), jamais enregistré dans une
  recherche ; route `GET /api/photos/:id/full`.

## [0.23.0] — 2026-11-07

### Ajouté

- **Métadonnées en masse** (bouton « Métadonnées… » de la Photothèque, sur la
  sélection ou toute la recherche) : titre, description, auteur, copyright,
  note, étiquette de couleur, lieu (lieu précis, ville, région, pays), mots-clés
  à ajouter / retirer ; modes « Remplacer », « Remplir si vide », « Effacer ».
  **Aperçu** avant / après obligatoire, valeurs remplacées comptées et
  confirmées d'un second clic.
- **Historique et annulation** des modifications en masse : une valeur
  modifiée depuis n'est pas touchée.
- **Relecture des fichiers** : XMP annexe d'abord, puis métadonnées embarquées
  (XMP / IPTC / EXIF) ; par défaut seuls les champs vides sont complétés.
- **Écriture de XMP annexes** (jamais dans l'original) : dans le dossier
  « Metadonnees » de Photothèque ou à côté des photos, nommage
  `IMG.xmp` ou `IMG.jpg.xmp`. Une annexe modifiée par un autre logiciel
  n'est remplacée que sur demande, avec copie .bak.
- **Politique de priorité** documentée et réglable (Paramètres → Métadonnées) :
  à l'indexation, les champs vides des nouvelles photos sont remplis depuis
  leurs fichiers (titre, légende, mots-clés hiérarchiques, note, lieu…).
- **Informations de couleur** lues à l'indexation : espace colorimétrique et
  nom du profil ICC (fiches détaillées).

### Corrigé

- Auteur et copyright lus dans un XMP embarqué (liste ou texte multilingue)
  faisaient échouer l'indexation du fichier.

## [0.22.0] — 2026-11-07

### Ajouté

- **Mots-clés hiérarchiques** dans l'interface : arborescence dépliable,
  « + Dessous », déplacement (« Rangé sous »), boucles refusées. Chercher un
  mot-clé trouve aussi les photos des mots-clés rangés dessous.
- **Synonymes**, **catégorie** et **description** de chaque mot-clé. Un
  synonyme trouve les photos du mot-clé (critères et recherche libre) ; la
  recherche libre trouve aussi les parents (« Saisons » sur une photo « Été »).
- **Doublons de vocabulaire** : même libellé à deux endroits, synonyme d'un
  autre mot-clé, pluriel / tiret / apostrophe, une lettre d'écart. Fusion au
  choix ; les libellés fusionnés deviennent des synonymes.
- **Statistiques d'utilisation** du vocabulaire (inutilisés, plus employés,
  par catégorie, part des photos sans mot-clé).
- Import / export CSV du vocabulaire avec parent, catégorie, synonymes.
- Critères de recherche : **lieu** (IPTC / XMP), lieu renseigné ou non,
  **état de sauvegarde** des originaux (copie sur un support « Sauvegarde » ou
  « Archive », aucune copie, un seul exemplaire), catégorie de mot-clé.

### Modifié

- Affecter un mot-clé par son nom réutilise le mot-clé existant où qu'il soit
  rangé (ou par synonyme) au lieu d'en créer un second à la racine.
- Guide de l'utilisateur mis à jour (mots-clés, recherche avancée).

## [0.21.1] — 2026-11-07

### Modifié

- Guide de l'utilisateur en PDF : **table des matières** avec les numéros de
  page (chapitres et rubriques), calculée d'après la mise en page réelle.
- Aucun élément n'est plus coupé entre deux pages (paragraphes, encadrés,
  figures, cartes, lignes de tableau) ; un long tableau se poursuit sur la
  page suivante avec son en-tête répété.
- Deux schémas retouchés (étiquettes qui chevauchaient un trait).

## [0.21.0] — 2026-11-06

### Ajouté

- **Guide de l'utilisateur** (menu ❓ Aide) : 14 chapitres illustrés de
  captures d'écran et de schémas (principes, prise en main, import,
  supports, recherche, classement, retouche, albums, doublons, documents,
  rapports, sauvegardes, questions fréquentes, glossaire). Consultable dans
  l'application, imprimable, et téléchargeable en PDF.
- `scripts/guide.mjs` : régénère les captures et le PDF à partir d'une
  photothèque d'exemple (jamais vos données).

### Corrigé

- Barre d'actions de la sélection : le mot « null » s'affichait entre les
  boutons hors d'une collection.
- Nombre de photos par mot-clé : il n'était pas mis à jour après la
  modification des mots-clés d'une photo (fiche ou action « Mot-clé… »).

## [0.20.0] — 2026-11-06

### Ajouté

- **Portfolios** (Photothèque → « Planches, catalogues, portfolio… »,
  Document : « Portfolio ») : une page de couverture (première photo, titre,
  sous-titre, auteur, date), puis une photo par page, aussi grande que les
  marges le permettent, avec une légende sobre centrée et un numéro de page
  discret. Fond blanc, gris clair ou noir ; marges réglables (5 à 30 mm) ;
  couverture facultative ; légende au choix (numéro, titre, date, etc.).
- Réglage des **marges** pour tous les documents de la fenêtre.

## [0.19.0] — 2026-11-06

### Ajouté

- **Rapports et inventaires** (nouvelle vue Analyse → Rapports), chacun en
  PDF (avec aperçu) ou en CSV :
  - **Inventaire par support** : identité de chaque support (type, rôle,
    état, marque, n° de série, capacité, emplacement physique), puis ses
    dossiers avec nombre de fichiers, volume et fichiers indisponibles ; pour
    tous les supports ou un seul.
  - **Fichiers manquants** : existence de chaque fichier vérifiée au moment
    du rapport, regroupés par support avec la raison (support non connecté,
    fichier introuvable) et l'existence d'une autre copie ; photos sans
    aucune copie disponible mises en évidence.
  - **Rapport d'intégrité** : contrôle de la base SQLite, puis des fichiers
    (présence et taille, ou contrôle complet par recalcul de l'empreinte
    SHA-256) ; photos sans copie de sécurité.
  - **Rapport de sauvegardes** : sauvegardes présentes, vérification de
    chaque archive, programmation et ancienneté de la dernière.
- Aucun rapport ne modifie le catalogue ni les fichiers.

## [0.18.0] — 2026-11-06

### Ajouté

- **Catalogues thématiques** (Photothèque → « Planches, fiches,
  catalogues… », Document : « Catalogue thématique ») : les photos regroupées
  par année, mois, mot-clé, lieu, dossier, support ou appareil.
  - Un sommaire en tête : chaque groupe, son nombre de photos et sa page.
  - Chaque groupe commence sur une nouvelle page avec un bandeau, puis une
    grille légendée comme la planche-contact (colonnes, lignes, légende,
    format, qualité, version retouchée).
  - Par mot-clé, une photo figure dans chacun de ses mots-clés ; par lieu,
    ville et pays des métadonnées, sinon position GPS ; les photos sans
    date, sans mot-clé ou sans lieu sont réunies dans un dernier groupe.
- **Lieu** (ville, région, pays des métadonnées) dans les fiches détaillées
  et en colonne du CSV.

## [0.17.0] — 2026-11-05

### Ajouté

- **Fiches détaillées** (Photothèque → « Planche-contact, fiches, CSV… »,
  Document : « Fiches détaillées ») : un PDF avec une photo par page, montrée
  entière, suivie de toutes ses informations — titre, description, date,
  auteur, copyright, mots-clés, note, appareil, objectif, exposition,
  dimensions, GPS, version retouchée, notes, emplacements (support, statut,
  taille), empreinte SHA-256. Même choix des photos, du format, de la
  qualité et de la version que les planches-contact ; aperçu avant
  téléchargement.
- **Catalogue CSV** (bouton « Exporter en CSV » de la même fenêtre) : une
  ligne par photo, 33 colonnes, lisible directement par un tableur réglé en
  français (séparateur « ; », virgule décimale, UTF-8). Sans limite de
  nombre de photos.

## [0.16.0] — 2026-11-05

### Ajouté

- **Planches-contact** (Photothèque → « Planche-contact… ») : un PDF de
  vignettes légendées pour la sélection, ou, sans sélection, pour toutes les
  photos de la recherche affichée (filtres, tri, collection, variantes
  compris).
  - Réglages : titre, format (A4 ou A3, portrait ou paysage), colonnes et
    lignes, qualité écran (rapide, aperçus) ou impression (originaux,
    300 ppp), version retouchée ou d'origine.
  - Légende au choix : numéro, nom du fichier, date de prise de vue, titre,
    dimensions, note, appareil, mots-clés, dossier.
  - Aperçu dans l'application avant de télécharger ; réglages mémorisés.
  - Chaque photo est montrée entière, sans recadrage ; pied de page avec
    titre, nombre de photos, date et numéro de page.

### Corrigé

- Titre des PDF (albums et planches) dans les propriétés du document : les
  caractères comme le tiret cadratin « — » s'affichaient mal (« Š »).

## [0.15.0] — 2026-11-05

### Ajouté

- **Supprimer une fiche en double** (page Doublons, bouton « Supprimer la
  fiche… », après confirmation) :
  - sur un **fichier** d'une photo présente en plusieurs fichiers : la photo
    garde ses autres fichiers, ses mots-clés et ses retouches ; si c'était le
    fichier de référence, un autre fichier disponible le devient ;
  - sur une **photo** d'un groupe : sa fiche est retirée du catalogue (avec
    ses mots-clés et ses retouches ; un album qui l'utilisait signale le
    cadre).
- Les fichiers concernés sont **écartés** : une réindexation ne les ramène
  pas, sauf si leur contenu change. « Réautoriser les fichiers écartés (n) »
  annule cet écart.

### Modifié

- Un fichier indexé dont le contenu existe déjà au catalogue est enregistré
  comme copie : le fichier de référence choisi ne change plus après une
  réindexation.

### Sécurité des données

- Aucun fichier n'est jamais effacé ni déplacé sur le disque : seule la
  fiche du catalogue est supprimée. Le dernier fichier d'une photo ne peut
  pas être retiré seul.

## [0.14.0] — 2026-11-05

### Ajouté

- **Réimport d'un projet d'album** (page Albums → « Importer un
  projet… ») : un fichier `.album.json` exporté devient un nouvel album.
  Avant d'importer, un compte rendu indique le format, le nombre de pages,
  les photos retrouvées (par identifiant, par contenu SHA-256 ou par chemin)
  et la liste des photos introuvables.
- Les photos introuvables gardent leur place : leurs cadres sont signalés
  dans les contrôles de l'album, à remplacer dans l'éditeur.
- Les retouches du projet peuvent être recréées comme nouvelles versions
  (« … (import) ») ; une retouche identique déjà présente n'est pas
  dupliquée.
- L'export de projet mémorise aussi la vue en planches.

### Sécurité des données

- L'import crée toujours un nouvel album (nom suffixé « (importé) » si
  besoin) : aucun album ni aucune version de retouche existants ne sont
  modifiés, et une nouvelle version ne devient « par défaut » que si la
  photo n'en avait aucune. Fichiers étrangers, JSON illisible et projets
  d'un format plus récent sont refusés avec un message clair. Chaque champ
  du projet est nettoyé comme dans l'éditeur.

## [0.13.0] — 2026-11-05

### Ajouté

- **Vignettes retouchées** : dans la Photothèque (grille, collections), une
  photo qui a une version retouchée par défaut s'affiche avec cette version ;
  la vignette se met à jour dès qu'on modifie la retouche.
- **Visionneuse** : la version retouchée est montrée d'abord, avec son nom et
  ses dimensions ; « Voir l'original » / « Voir la version retouchée » bascule
  de l'une à l'autre.

### Modifié

- Albums et Photothèque partagent la même règle (`editedCard` dans
  `lib/edits.mjs`) : une version neutre laisse l'original affiché. L'outil
  Doublons continue de montrer les vignettes d'origine.

## [0.12.0] — 2026-11-05

### Ajouté

- **Variantes masquées dans la Photothèque** : les photos désignées comme
  variantes dans l'outil Doublons sont masquées par défaut. Un sélecteur
  propose « Masquer les variantes », « Afficher les variantes » ou
  « Seulement les variantes » (choix mémorisé). Le nombre de variantes
  masquées s'affiche sous les filtres : aucune photo ne disparaît sans
  explication.
- Badge « ⧉ n » sur une photo de référence et « variante » sur une variante ;
  un clic affiche la référence et toutes ses variantes.
- Critères de recherche `hideVariants`, `variants`, `variantsOf` (API
  `/api/photos` et recherches enregistrées), index `ix_photos_variant`.

### Sécurité des données

- Une variante dont la référence a été retirée de l'index n'est plus
  masquée. Dans une collection, toutes les photos qu'on y a mises restent
  visibles. Rien n'est supprimé.

## [0.11.0] — 2026-11-05

Étape 5 de la feuille de route (doublons avancés et outil dédié),
première version.

### Ajouté

- **Doublons et photos similaires** (`lib/duplicates.mjs`), sur quatre
  niveaux :
  - **exacts :** même contenu (SHA-256) — une photo présente en plusieurs
    fichiers (avec leurs emplacements et supports), ou plusieurs fiches de
    même empreinte ;
  - **potentiels :** même nom de fichier et mêmes dimensions, ou même
    instant, même appareil et mêmes dimensions, mais contenu différent —
    à confirmer ;
  - **similaires :** empreinte visuelle (dHash 64 bits + couleur moyenne)
    proche, avec une tolérance réglable (0 à 20, 8 conseillé). Un groupe
    dont les dimensions diffèrent est présenté comme « versions » (réduction,
    recadrage, export…). Recherche par arbre BK, sans comparer chaque paire ;
  - **rafales :** même appareil, prises à quelques secondes d'intervalle
    (réglable).
- **Empreinte visuelle** calculée à l'indexation (sur la vignette) et
  rangée dans `photos.perceptual_hash` ; bouton pour calculer les empreintes
  manquantes (photos indexées avant cette version) ou les recalculer, en
  tâche de fond.
- **Outil de comparaison** (page Doublons) : onglets par niveau avec leur
  nombre, photos côte à côte avec dimensions, poids, format, date, appareil,
  retouches, fichiers (chemin, support, disponibilité), visionneuse.
- **Décisions, jamais de suppression automatique :**
  - « ★ Référence » : la photo choisie devient la référence du groupe, les
    autres sont notées comme ses variantes et conservées ;
  - « Ce ne sont pas des doublons » : le groupe n'est plus proposé (paires
    mémorisées, réversible par « Reproposer les groupes écartés ») ;
  - « Fichier de référence » pour une photo présente en plusieurs fichiers :
    c'est lui qu'utilisent l'affichage, les albums et l'export ; les autres
    restent indexés comme copies ;
  - « Retirer de l'index… » photo par photo, après confirmation : les
    fichiers ne sont jamais supprimés ni déplacés.
- **API :** `GET /api/duplicates/summary`, `GET /api/duplicates?level=`
  (`exact`, `potential`, `similar`, `burst`, avec `threshold`, `seconds`),
  `POST /api/duplicates/hashes`, `…/reference`, `…/ignore`,
  `…/reference-file`.
- **Tests :** 368 vérifications (25 nouvelles, sur des images à motifs :
  versions réduites, copies, homonymes, rafales, aplats de couleur).

### Corrigé

- Une photo présente en deux fichiers avait ses deux fichiers marqués
  « original » : le fichier affiché dépendait de l'ordre de la base. Choisir
  un fichier de référence lève l'ambiguïté.

### Non encore réalisé

- Analyse visuelle plus fine (rotations, recadrages forts : le dHash n'y
  est pas insensible), regroupement des rafales autour d'une meilleure photo,
  masquage des variantes dans la Photothèque.

## [0.10.0] — 2026-11-05

### Ajouté

- **Les albums utilisent la version retouchée par défaut** d'une photo
  (celle marquée ★ dans la Retouche), comme l'export :
  - l'éditeur d'album affiche la version retouchée, avec un repère ✎ sur
    le cadre (l'infobulle nomme la version) ; la couverture de l'album aussi ;
  - les dimensions de la version retouchée (après rotation, redressement et
    recadrage) servent aux contrôles de résolution et au recadrage dans le
    cadre : recadrer une photo dans la Retouche réduit les pixels utiles et
    l'alerte le dit ;
  - le PDF imprime la version retouchée, rendue en pleine définition depuis
    l'original puis cadrée ; le compte rendu indique les photos concernées ;
  - le projet exporté (`*.album.json`) donne, pour chaque photo retouchée,
    la version et ses réglages complets (`photos.<id>.edit`) ;
  - une version neutre (aucun réglage) ou supprimée rend l'original à
    l'album.
- **Tests :** 343 vérifications (8 nouvelles).

### À savoir

- Le recadrage dans le cadre d'album se superpose à celui de la Retouche :
  si la photo est recadrée après coup dans la Retouche, il peut être utile
  de revoir son cadrage dans l'album.

## [0.9.0] — 2026-11-05

Étape 4 de la feuille de route (retouches non destructives + exports),
première version.

### Ajouté

- **Retouche non destructive** (`lib/edits.mjs`) : les réglages sont
  enregistrés dans la table `edits` (JSON versionné, `EDIT_PARAMS_VERSION`
  1), jamais dans les fichiers ; les originaux ne sont lus qu'en lecture.
  - **Géométrie :** rotation par quarts de tour, miroirs horizontal et
    vertical, redressement de −15° à +15° (l'image est recoupée pour ne
    jamais montrer de coin vide), recadrage libre ou à proportion fixe
    (1:1, 4:3, 3:2, 16:9, 4:5, 2:3, proportion d'origine) avec un cadre
    déplaçable et redimensionnable et une grille des tiers.
  - **Lumière et couleur :** exposition, luminosité, contraste, température,
    teinte, saturation, netteté, noir et blanc, sépia.
  - **Filtres :** sept préréglages intégrés (noir et blanc, noir et blanc
    contrasté, sépia, chaud, froid, couleurs vives, doux) ; ils remplacent
    les réglages de lumière et de couleur sans toucher à la géométrie.
  - **Versions** (variantes virtuelles) : plusieurs versions par photo,
    nommées, copiables, supprimables ; une version « par défaut » (★) est
    utilisée par l'export.
  - **Historique par version, conservé en base** : annuler, rétablir
    (boutons et Ctrl+Z / Ctrl+Y), réinitialiser (annulable), 50 étapes.
  - **Avant / après :** maintenir le bouton affiche l'original.
  - Aperçus rendus par le serveur et mis en cache dans `data/thumbs/edits`
    (régénérable) ; ils partent de l'aperçu en cache pour être rapides.
- **Export de photos** (`lib/exports.mjs`) vers le dossier `Exports/`
  (à côté de `Sauvegardes/`) :
  - formats JPEG, PNG, TIFF (LZW) et WebP ; qualité ; plus grand côté en
    pixels (jamais d'agrandissement) ;
  - version retouchée par défaut ou original non retouché ; rendu depuis
    l'original en pleine définition ;
  - métadonnées principales (appareil, date, auteur, copyright, titre) avec
    ou sans GPS, ou aucune ; profil sRGB intégré ;
  - filigrane texte (position, opacité, taille) ;
  - renommage par modèle (`{nom}`, `{titre}`, `{date}`, `{n}`) et
    sous-dossier ; un fichier existant n'est jamais écrasé ;
  - export par lot en tâche de fond avec progression, compte rendu
    (fichiers, taille, erreurs par photo, photos tirées de l'aperçu) et
    consignation dans la table `exports` ;
  - quatre profils intégrés (partage web, réseaux sociaux avec filigrane,
    tirage, archive TIFF) et profils personnels enregistrables.
- **Interface :** bouton « ✎ Retoucher » et « Exporter… » dans la
  visionneuse ; vue de retouche (aperçu, panneau de réglages) ; action de
  lot « Exporter… » dans la Photothèque ; badge ✎ sur les photos qui ont
  une version retouchée.
- **API :** `GET/POST /api/photos/<id>/edits`, `GET /api/photos/<id>/render`
  (`edit`, `params`, `size`, `nocrop`), `GET/PUT/DELETE /api/edits/<id>`,
  `POST /api/edits/<id>/undo|redo|reset`, `GET/POST /api/exports`,
  `GET/POST /api/exports/profiles`, `DELETE /api/exports/profiles/<id>`.
- **Tests :** 335 vérifications (51 nouvelles : réglages, rendu géométrique
  et colorimétrique sur image de contrôle, versions et historique, export,
  métadonnées, profils, intégrité de l'original).

### Non encore réalisé

- **RAW :** sharp (libvips) ne décode pas les fichiers RAW ; leur retouche
  et leur export s'appuient sur l'aperçu en cache (définition réduite,
  signalé). Un moteur RAW (LibRaw…) reste à évaluer.
- Courbes, réduction du bruit, hautes lumières / ombres, vibrance.
- Gestion des couleurs : sortie toujours en sRGB (pas de choix de profil ICC
  ni de conversion CMJN) ; métadonnées réécrites (pas de copie intégrale de
  l'EXIF, IPTC ni XMP d'origine) ; les accents des champs EXIF sont
  ramenés en ASCII (limite du format EXIF).
- Préréglages personnels, densité (ppp) inscrite dans le fichier, ouverture
  dans un logiciel externe.
- Les albums, vignettes et la visionneuse montrent encore l'original non
  retouché.

## [0.8.0] — 2026-11-05

### Ajouté

- **Annuler / rétablir dans l'éditeur d'album** (`lib/albums.mjs`) :
  - boutons « ↶ Annuler » et « ↷ Rétablir » (l'infobulle nomme l'étape,
    par exemple « Pages 4–5 : gabarit ») et raccourcis **Ctrl+Z**,
    **Ctrl+Y** ou **Ctrl+Maj+Z** (hors champs de saisie et fenêtres) ;
  - toutes les modifications d'un album sont annulables : propriétés et
    format, ajout, déplacement, duplication et suppression de pages,
    gabarit, fond, textes, photos, recadrage, remplissage automatique ;
  - une modification sans effet ne crée pas d'étape ; une nouvelle
    modification vide la pile « rétablir » ; 50 étapes au plus par album ;
  - la vue en planches est une préférence d'affichage : elle n'est pas une
    étape et une annulation ne la change pas ;
  - les piles vivent en mémoire le temps de la session du serveur (elles
    sont perdues à son redémarrage) ; chaque annulation est notée dans
    l'historique des opérations.
- **Déplacement d'une photo entre deux cadres en une seule opération**
  (`POST /api/albums/<id>/move-photo`) : photo et recadrage échangés côté
  serveur, même entre deux pages, donc annulables d'un coup (l'interface
  envoyait auparavant deux requêtes).
- **API :** `POST /api/albums/<id>/undo` et `…/redo` ; la fiche d'un album
  porte `history` (libellés de la prochaine annulation et du prochain
  rétablissement, nombre d'étapes).
- **Tests :** 284 vérifications (19 nouvelles pour l'annulation).

## [0.7.0] — 2026-11-05

### Ajouté

- **Doubles pages** (`lib/albums.mjs`) :
  - quatre gabarits sur deux pages en vis-à-vis : panoramique pleine
    planche (fond perdu), panoramique avec marges, 2 photos face à face,
    bandeau panoramique + 4 photos. Leurs cadres respectent les marges de
    sécurité, y compris de part et d'autre du pli pour les photos qui ne le
    traversent pas ;
  - une ligne d'album à gabarit double compte pour deux pages imprimées :
    numérotation (« Pages 4–5 »), nombre de pages de l'album, messages des
    contrôles (`folios`) ;
  - la page 1 étant une page de droite, une double page doit commencer sur
    un numéro pair ; sinon une alerte le signale (le panoramique serait
    coupé au pli) ;
  - la résolution d'un cadre se calcule sur la largeur de la planche ;
    le recadrage manuel fonctionne de la même façon.
- **Vue en planches** dans l'éditeur (case « Vue en planches », enregistrée
  avec l'album) : pages en vis-à-vis comme dans le livre, page 1 seule à
  droite, pli marqué en pointillé, numéros de page au coin extérieur. Hors
  de cette vue, une double page occupe toute la largeur.
- **PDF :** disposition « page par page » (pour l'imprimeur : une double
  page est coupée au pli en deux pages, chacune avec ses fonds perdus) ou
  « planches » (pages en vis-à-vis, pour l'écran ; l'aperçu suit la vue de
  l'éditeur). Paramètre `layout=pages|spreads` de
  `GET /api/albums/<id>/pdf`. Les numéros de page sont au coin extérieur
  (droite pour les pages impaires, gauche pour les paires) ; la légende
  d'une double page est sur la page de droite.
- **Tests :** 265 vérifications (21 nouvelles pour les doubles pages).

### Modifié

- Dans le compte rendu du PDF, les cadres sont désignés par leur numéro de
  page imprimée.

## [0.6.0] — 2026-11-05

### Ajouté

- **Recadrage manuel des photos dans les cadres d'album**
  (`lib/albums.mjs`, `cleanCrop`, `cropWindow`) :
  - bouton ✂ sur chaque cadre garni : on fait glisser la photo pour choisir
    la partie visible et on zoome (molette ou curseur, de × 1 à × 5), avec
    une grille des tiers ; « Réinitialiser » revient au cadrage centré ;
  - la résolution à l'impression est recalculée en direct pendant le
    recadrage (le zoom réduit les pixels utiles) ;
  - le recadrage est enregistré dans la page (centre + zoom, en fractions
    de l'image) : il ne modifie jamais l'original et reste valable si l'on
    change de format ou de gabarit ;
  - il suit la photo quand on la fait glisser vers un autre cadre ; il est
    oublié quand on met une autre photo dans le cadre ;
  - même calcul dans l'éditeur, les contrôles de résolution et l'export
    PDF, qui ne découpe que la partie visible (toujours sans agrandissement) ;
  - un petit ✂ signale les cadres recadrés.
- **Projet d'album :** champ `crops` dans les pages (facultatif, compatible
  avec la version 1 du format).
- **Tests :** 244 vérifications (15 nouvelles : recadrage et orientation).

### Corrigé

- **Contrôle de résolution des photos tournées** : une photo dont l'EXIF
  indique une rotation d'un quart de tour (orientation 5 à 8) était évaluée
  avec largeur et hauteur inversées.

## [0.5.0] — 2026-11-05

### Ajouté

- **Export PDF des albums** (`lib/albumpdf.mjs`, sur un écrivain PDF sans
  dépendance `lib/pdf.mjs`) :
  - une page PDF par page d'album, au format exact de l'album ;
  - deux qualités : **impression** (300 ppp, JPEG 90) et **écran / aperçu**
    (150 ppp, cadres vides grisés) ;
  - option **fonds perdus de 3 mm** : la page est agrandie, les photos
    posées au bord (gabarit pleine page) débordent, et la boîte de coupe
    (`TrimBox`) reste au format de l'album ;
  - photos recadrées et centrées comme dans l'éditeur, rééchantillonnées
    depuis les originaux (lus sans modification) et **jamais agrandies**
    au-delà de leur résolution réelle ; une photo utilisée plusieurs fois
    au même format n'est écrite qu'une fois ;
  - si l'original est indisponible : repli sur une copie de même empreinte,
    puis sur l'aperçu en cache (qualité réduite), toujours signalé ;
  - textes (titre, sous-titre, légende, numéro de page) en Helvetica avec
    accents, couleur adaptée au fond (claire sur fond foncé) ;
  - compte rendu : pages, images, taille, photos prises sur une copie ou
    sur l'aperçu, résolution insuffisante, cadres vides ou illisibles ;
  - chaque export est enregistré dans la table `exports` et l'historique.
- **API :** `GET /api/albums/<id>/pdf?quality=print|screen&bleed=1&inline=1`
  (le PDF est produit dans un fichier temporaire, envoyé puis effacé).
- **Interface :** boutons « Aperçu » (PDF affiché dans la page avec son
  compte rendu) et « Exporter en PDF… » (qualité, fonds perdus, rappel des
  alertes bloquantes) dans l'éditeur d'album. Le texte des pages de
  l'éditeur suit la même règle de contraste que le PDF.
- **Tests :** 229 vérifications (31 nouvelles pour l'export PDF).

### Non encore réalisé

Recadrage manuel, rotation, doubles pages, annulation/rétablissement,
profils de couleur (le PDF est en RVB sRGB, sans conversion CMJN), traits
de coupe, réimport d'un projet exporté.

## [0.4.0] — 2026-11-05

### Ajouté

- **Albums photo** (`lib/albums.mjs`, étape 3 de la feuille de route,
  première version) :
  - **Formats :** six formats prédéfinis (carrés 30 et 20 cm, A4 portrait
    et paysage, 20 × 30 et 30 × 20 cm) ou format personnalisé (50 à
    1000 mm de côté). L'orientation est déduite du format ; changer de
    format conserve la mise en page.
  - **Gabarits :** page de titre, 1 photo pleine page (fond perdu),
    1 photo avec marges, 2 côte à côte, 2 l'une sous l'autre, 3 (1 grande
    + 2), 4 (2 × 2), 6 (3 × 2). Les cadres sont proportionnels à la page et
    respectent une marge de sécurité de 6 %.
  - **Pages :** ajout, gabarit, couleur de fond, titre et légende, numéro
    de page, réordonnancement, duplication, suppression.
  - **Photos :** placement par clic (recherche ou collection),
    glisser-déposer entre cadres (y compris d'une page à l'autre), retrait
    d'un cadre, remplissage automatique depuis la sélection de la
    Photothèque (« Ajouter à un album… ») ou depuis une collection.
  - **Contrôles :** photo plus au catalogue (la référence est conservée
    pour être signalée), photo indisponible, résolution effective
    insuffisante (sous 150 ppp) ou limite (sous 240 ppp), photos hors
    gabarit, cadres vides. Le cadre fautif est entouré de couleur.
  - **Projet :** format versionné (`formatVersion` 1), exporté en
    `*.album.json` avec les références des photos (chemin et empreinte).
    Le format est documenté dans `docs/ARCHITECTURE.md` §9.
  - Un album ne contient que des références : aucun original n'est copié,
    et supprimer un album ne supprime aucune photo.
- **API :** `/api/albums` (liste, création), `/api/albums/<id>` (lecture,
  modification, suppression), `…/pages` et `…/pages/<n>` (ajout,
  modification, suppression, `move`, `duplicate`), `…/fill`, `…/export`.
- **Interface :** page Albums (création, vignettes de couverture, alertes)
  et éditeur de pages avec affichage des marges de sécurité.
- **Tests :** 198 vérifications (44 nouvelles pour les albums).

### Non encore réalisé

Recadrage manuel, rotation, placement libre, bordures, doubles pages,
annulation/rétablissement, aperçu et export d'impression (PDF), modèles
graphiques personnalisés, réimport d'un projet exporté.

## [0.3.1] — 2026-11-05

### Corrigé

- **Recherche après modification d'un mot-clé** (`lib/keywords.mjs`) :
  renommer, fusionner ou supprimer un mot-clé laissait l'ancien nom dans le
  texte cherché des photos concernées (`photos.keywords_text`, index FTS5).
  Ce texte est désormais réécrit pour ces photos ; la fonction de
  réécriture est partagée avec `lib/library.mjs`.
- **Critère « doublons »** (`lib/search.mjs`) : il ne cherchait que plusieurs
  fiches de même empreinte, alors que l'indexation rattache une copie à la
  fiche existante ; il ne trouvait donc presque rien. Il retient maintenant
  aussi les photos présentes en plusieurs fichiers.

### Ajouté

- **Recherche avancée** : choix « Fichiers en double » (seulement les
  doublons).
- **Tests** : 154 vérifications (9 nouvelles).

## [0.3.0] — 2026-11-05

### Ajouté

- **Recherche avancée dans l'interface** : panneau repliable « Recherche
  avancée » dans la Photothèque. Il expose les critères qui n'existaient
  jusqu'ici que côté API :
  - texte : au moins un de ces mots, aucun de ces mots (le texte de la barre
    du haut exige toujours tous ses mots) ;
  - mots-clés : tous, au moins un, aucun, avec ou sans mot-clé ;
  - prise de vue : période (la date de fin inclut toute la journée),
    objectif, auteur ;
  - image : orientation, largeur et hauteur minimales, légende, GPS.
  Un compteur indique le nombre de critères actifs ; « Enregistrer la
  recherche… » emporte ces critères dans une collection.

### Corrigé

- **Mots-clés saisis dans une recherche** (`lib/search.mjs`) : ils étaient
  comparés en minuscules seulement, alors que les mots-clés sont rangés sans
  accents ni espaces doubles. « été » ne trouvait donc pas « Été ». La
  recherche utilise maintenant la même normalisation (`normalizeKeyword`,
  `lib/keywords.mjs`).
- **Tests** : 145 vérifications (3 nouvelles sur les mots-clés accentués).

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
