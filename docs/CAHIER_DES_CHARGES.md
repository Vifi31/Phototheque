# CAHIER DES CHARGES ET PROMPT MAÎTRE
# PHOTOTHÈQUE — Application personnelle de gestion, d'archivage et de valorisation photographique

## 1. MISSION ET RÔLE

Agis comme une équipe pluridisciplinaire composée de :

- Un architecte logiciel senior spécialisé dans les applications de bureau multiplateformes.
- Un développeur full-stack maîtrisant Rust, TypeScript et les bases de données.
- Un spécialiste des systèmes de fichiers, du stockage réseau et des archives numériques.
- Un expert en photographie numérique, métadonnées, fichiers RAW et développement photographique.
- Un concepteur UX/UI spécialisé dans les logiciels créatifs.
- Un expert en cybersécurité, sauvegardes et conservation à long terme.
- Un spécialiste de l'édition de livres photo, de la mise en page et des exports pour impression.

Ta mission est de concevoir et développer une application réellement utilisable, destinée à un particulier qui souhaite gérer, documenter, retrouver, retoucher, valoriser et préserver durablement un fonds photographique personnel.

Le produit ne doit pas être une simple maquette ni une démonstration visuelle. Il doit devenir un logiciel cohérent, fonctionnel, testable, documenté et distribuable.

Tu dois distinguer explicitement les fonctionnalités réellement implémentées, celles qui sont partiellement opérationnelles et celles qui restent à développer.

Ne simule jamais une fonctionnalité en présentant une interface sans fonctionnement réel.

---

## 2. VISION DU PRODUIT

Nom provisoire : Photothèque.

Créer une application de bureau permettant de gérer entre 100 000 et 500 000 photographies, avec une architecture conçue pour pouvoir dépasser ce volume si le matériel et les conditions de stockage le permettent.

L'application doit réunir les fonctions d'un gestionnaire de photothèque, d'un catalogueur documentaire, d'un outil de retouche non destructive, d'un créateur d'albums photo et d'un système de préservation numérique.

Elle doit fonctionner sur :

- Windows, plateforme prioritaire.
- macOS, avec prise en charge des architectures matérielles pertinentes.
- Linux, si la compatibilité peut être obtenue sans compromettre la stabilité du produit.

Les données et les originaux restent sous le contrôle de l'utilisateur.

Aucun abonnement, compte en ligne ou service cloud ne doit être nécessaire pour les fonctions essentielles.

L'intelligence artificielle doit être facultative et privilégier le traitement local. Aucun fichier photographique, aucune vignette et aucune métadonnée ne doivent être envoyés à un service distant sans consentement explicite.

### Objectifs prioritaires

1. Indexer les photographies sans les copier.
2. Importer et organiser des photographies provenant de différentes sources.
3. Gérer les supports physiques et réseau.
4. Retrouver rapidement les images grâce aux métadonnées et aux mots-clés.
5. Effectuer des retouches non destructives, y compris sur les fichiers RAW compatibles.
6. Créer des albums, des catalogues et des documents photographiques.
7. Produire des fichiers adaptés à l'impression.
8. Sauvegarder et restaurer les données de façon vérifiable.
9. Détecter les anomalies, les fichiers manquants et les risques de perte.
10. Conserver une maîtrise complète des données, des versions et des licences.

---

## 3. PRINCIPES FONDAMENTAUX

Respecter impérativement les règles suivantes.

### 3.1 Protection des originaux

Ne jamais modifier, déplacer, renommer ou supprimer un original sans une action explicite de l'utilisateur.

Les opérations d'indexation, de création de vignettes, de retouche et d'export doivent être séparées des fichiers sources.

Toutes les opérations risquées doivent être précédées d'une explication claire et, si nécessaire, d'une confirmation.

### 3.2 Séparation entre catalogue et fichiers

Le catalogue contient les informations nécessaires pour retrouver et organiser les photographies. Il ne doit pas être confondu avec le stockage des originaux.

Une photographie peut avoir plusieurs emplacements physiques, plusieurs versions dérivées et plusieurs utilisations dans des albums.

L'absence d'un disque ne doit pas entraîner la suppression des métadonnées, des mots-clés, des évaluations ou des projets associés.

### 3.3 Fonctionnement local

Le logiciel doit pouvoir être utilisé hors ligne pour toutes les fonctions essentielles.

Les mises à jour, l'installation de modèles d'IA et les éventuelles intégrations externes doivent être indépendantes de l'utilisation courante de la photothèque.

### 3.4 Fiabilité avant sophistication

Privilégier une indexation fiable, une base de données cohérente, une bonne gestion des supports et des sauvegardes testées avant d'ajouter des fonctions avancées coûteuses.

### 3.5 Formats ouverts et pérennité

Favoriser les formats documentés pour les métadonnées, les projets, les sauvegardes et les exports.

Éviter qu'une bibliothèque ne puisse être récupérée qu'à travers une version particulière du logiciel.

---

## 4. ARCHITECTURE TECHNIQUE CIBLE

Proposer une architecture multiplateforme avec les technologies suivantes comme point de départ.

### 4.1 Application de bureau

- Tauri pour l'enveloppe de l'application et l'accès contrôlé aux fonctions natives.
- Rust pour le cœur métier, la gestion des fichiers, l'indexation et les opérations critiques.
- TypeScript et React pour l'interface.
- Une bibliothèque de composants accessible et maintenable pour construire l'interface graphique.
- Un système de tâches asynchrones pour l'indexation, les vignettes, les exports et les sauvegardes.

Cette architecture doit être comparée à des alternatives pertinentes uniquement si celles-ci apportent un avantage concret en matière de coût, de performances, de maintenance ou de compatibilité.

Ne pas multiplier inutilement les technologies ou les services.

### 4.2 Base de données

Utiliser SQLite comme base principale pour une installation personnelle.

Configurer la base pour une utilisation fiable avec plusieurs tâches de lecture et une gestion contrôlée des écritures.

Étudier notamment :

- WAL lorsque le fonctionnement retenu le permet.
- Transactions pour les opérations critiques.
- Index adaptés aux recherches.
- Contraintes d'intégrité.
- Recherche textuelle avec FTS5.
- Migrations versionnées.
- Contrôle de cohérence.
- Sauvegardes cohérentes à l'aide des mécanismes SQLite appropriés.

Centraliser les écritures sensibles dans une couche d'accès aux données clairement définie.

Ne pas effectuer des écritures concurrentes non coordonnées depuis plusieurs modules.

Les performances doivent être mesurées sur des jeux de données représentatifs de 100 000 à 500 000 photographies.

### 4.3 Organisation des fichiers applicatifs

Séparer les emplacements suivants :

1. Base de données et configuration.
2. Cache de vignettes et d'aperçus.
3. Fichiers temporaires de traitement.
4. Projets d'albums et documents.
5. Exports produits.
6. Sauvegardes du catalogue.
7. Sauvegardes éventuelles des originaux.
8. Journaux et rapports.

Permettre à l'utilisateur de choisir les emplacements des caches, des projets et des sauvegardes.

Le cache doit pouvoir être supprimé et reconstruit sans perdre les données documentaires.

### 4.4 Architecture modulaire

Séparer au minimum les modules suivants :

- Gestion de la photothèque.
- Importation.
- Indexation sans copie.
- Gestion des supports.
- Métadonnées.
- Mots-clés.
- Recherche.
- Vignettes et aperçus.
- Détection des doublons.
- Retouche.
- Traitement RAW.
- Albums.
- Catalogues et documents.
- Export et impression.
- Sauvegarde et restauration.
- Statistiques.
- Intelligence artificielle facultative.
- Sécurité.
- Gestion des versions.
- Licence.
- Paramètres et préférences.

Définir des interfaces entre ces modules afin de pouvoir remplacer un moteur de traitement sans réécrire l'ensemble du logiciel.

---

## 5. GESTION DES SUPPORTS ET INDEXATION SANS COPIE

Ce module est prioritaire.

### 5.1 Types de supports

Gérer :

- Disques internes.
- Disques durs externes.
- SSD externes.
- Clés USB.
- Cartes mémoire.
- Dossiers locaux.
- Partages réseau SMB et, lorsque pertinent, NFS.
- NAS.
- Dossiers synchronisés.
- Supports d'archives hors ligne.

Pour chaque support, enregistrer un identifiant interne stable et, lorsque disponible, des identifiants techniques utiles.

Ne pas se fier uniquement à la lettre de lecteur Windows ou au nom du volume, qui peuvent changer.

### 5.2 Indexation sans copie

Permettre de sélectionner un disque, un partage réseau ou un dossier et d'indexer son contenu sans copier ni modifier les fichiers sources.

Lors de l'indexation :

- Parcourir les répertoires autorisés.
- Reconnaître les formats pris en charge.
- Extraire les métadonnées.
- Calculer les dimensions.
- Générer des vignettes et aperçus séparés.
- Enregistrer le chemin d'origine.
- Enregistrer le support associé.
- Enregistrer la taille du fichier.
- Enregistrer les dates disponibles en distinguant leur signification.
- Calculer une empreinte cryptographique selon une stratégie documentée.
- Afficher la progression et les erreurs.
- Autoriser l'annulation et la reprise.
- Ne pas bloquer l'interface.

Prévoir une politique configurable pour les dossiers exclus, les fichiers cachés et les répertoires déjà indexés.

Éviter de recalculer systématiquement les empreintes de tous les fichiers lors de chaque ouverture. Réutiliser les informations fiables déjà enregistrées et détecter les changements à partir des caractéristiques du fichier et des contrôles nécessaires.

### 5.3 Supports absents

Si un support est déconnecté :

- Conserver l'ensemble du catalogue.
- Marquer les emplacements concernés comme indisponibles.
- Continuer à afficher les vignettes et métadonnées locales disponibles.
- Permettre les recherches.
- Empêcher les actions qui nécessitent un original absent.
- Proposer une procédure de reconnexion.

Ne jamais interpréter automatiquement une indisponibilité comme une suppression.

### 5.4 Reconnexion

Proposer un assistant qui :

- Identifie le support reconnecté.
- Compare ses caractéristiques avec l'inventaire.
- Recherche les dossiers déplacés.
- Utilise les chemins relatifs et les empreintes disponibles.
- Signale les ambiguïtés.
- Permet une validation avant de réassocier les fichiers.

Ne jamais réassocier silencieusement deux fichiers uniquement parce qu'ils portent le même nom.

### 5.5 Surveillance des supports

Afficher :

- Le dernier accès réussi.
- La dernière indexation.
- Le nombre de fichiers référencés.
- Les fichiers devenus indisponibles.
- Les erreurs de lecture.
- Les contrôles d'intégrité effectués.
- Le statut de sauvegarde.
- L'emplacement physique du support.
- Les commentaires de l'utilisateur.

Lorsque le système d'exploitation expose des données de santé du disque, les présenter avec leur origine et leurs limites. Ne pas promettre une prédiction certaine des pannes.

---

## 6. IMPORTATION DES PHOTOGRAPHIES

Créer un assistant d'importation compatible avec les sources courantes :

- Dossiers Windows et macOS.
- Appareils photo.
- Cartes SD.
- Smartphones Android.
- iPhone et iPad.
- Disques externes.
- NAS et partages réseau.

Proposer deux modes explicites :

**Importer par copie :** copier les originaux vers une destination choisie et enregistrer leur emplacement.

**Indexer sans copie :** référencer les originaux à leur emplacement actuel.

Prévoir :

- Détection des doublons.
- Gestion des noms identiques.
- Préservation des métadonnées.
- Renommage facultatif.
- Organisation facultative par date.
- Reprise après interruption.
- Journal d'importation.
- Rapport des fichiers ignorés et en erreur.
- Contrôle du nombre de fichiers avant et après l'opération.

Les transferts depuis les smartphones doivent utiliser des méthodes compatibles avec les contraintes réelles de chaque système. Ne pas promettre un accès direct à toutes les photos d'un téléphone si le système impose une autorisation ou un protocole particulier.

Aucune suppression de la source ne doit être proposée par défaut.

---

## 7. MODÈLE DE DONNÉES

Concevoir un modèle relationnel documenté.

### 7.1 Entités principales

Créer au minimum les tables ou entités suivantes :

**Photo**
- Identifiant unique.
- Nom documentaire.
- Date de prise de vue normalisée, si connue.
- Précision et provenance de la date.
- Dimensions.
- Orientation.
- Type de média.
- Note et classement.
- Couleur de sélection.
- Légende.
- Description.
- Statut documentaire.
- Date de création de l'enregistrement.
- Date de dernière modification des métadonnées.

**Fichier physique**
- Identifiant.
- Photo logique associée.
- Support.
- Chemin relatif et chemin de référence.
- Nom du fichier.
- Extension et format détecté.
- Taille.
- Date de modification du fichier.
- Empreinte cryptographique, si calculée.
- Disponibilité.
- Statut d'intégrité.
- Rôle : original, copie, export, aperçu ou autre variante.

**Support**
- Identifiant interne.
- Nom personnalisé.
- Type.
- Marque et modèle.
- Identifiants techniques disponibles.
- Point de montage ou chemin réseau.
- Capacité disponible lorsque connue.
- Statut.
- Dernier contrôle.
- Rôle dans la stratégie de conservation.

**Métadonnées**
- Identifiant de la photo.
- Source de la donnée.
- Nom du champ.
- Valeur.
- Type de valeur.
- Date de lecture ou de modification.
- Origine : EXIF, IPTC, XMP, base ou saisie manuelle.

**Mots-clés**
- Identifiant.
- Libellé.
- Identifiant du parent pour la hiérarchie.
- Description.
- Catégorie.
- Synonymes facultatifs.

**Association photo-mot-clé**
- Identifiant de photo.
- Identifiant de mot-clé.
- Origine de l'attribution.
- Date d'attribution.

**Personnes et lieux**
- Identifiants.
- Noms.
- Descriptions.
- Coordonnées lorsque pertinentes.
- Liens avec les photos.
- Provenance des informations.

**Retouches et variantes**
- Identifiant.
- Photo source.
- Paramètres de retouche.
- Version du moteur de traitement.
- Historique des opérations.
- Fichier dérivé éventuel.
- Date de création.
- Statut.

**Albums**
- Identifiant.
- Nom.
- Description.
- Format de page.
- Orientation.
- Modèle.
- Date de création et de modification.

**Pages d'album et éléments de page**
- Album associé.
- Ordre de la page.
- Dimensions.
- Fond.
- Éléments placés.
- Position, taille et rotation des éléments.
- Référence vers les photos ou variantes utilisées.
- Textes et légendes.

**Sauvegardes**
- Identifiant.
- Type de sauvegarde.
- Destination.
- Date.
- Version du format.
- Périmètre couvert.
- Statut.
- Résultat de la vérification.
- Informations de restauration.

**Tâches**
- Type.
- État.
- Progression.
- Date de lancement.
- Dernière activité.
- Erreurs.
- Informations nécessaires à la reprise.

**Paramètres, licences, migrations et journaux**
- Préférences utilisateur.
- Version du schéma.
- Historique des migrations.
- Informations de licence.
- Journal des opérations sensibles.
- Historique des versions logicielles.

### 7.2 Règles d'intégrité

Distinguer systématiquement :

- Une photographie logique.
- Un fichier physique.
- Un original.
- Une copie de sauvegarde.
- Une version retouchée.
- Un fichier exporté.
- Une utilisation dans un album.

Une photo ne doit pas être dupliquée dans la base à chaque fois qu'elle est ajoutée à un album.

Une même image peut être référencée dans plusieurs albums.

Prévoir les contraintes de clés étrangères, les index, les transactions, les migrations et des tests d'intégrité.

Documenter le schéma afin qu'un développeur puisse le comprendre et le faire évoluer.

---

## 8. MÉTADONNÉES ET RÉFÉRENCEMENT

Prendre en charge, lorsque disponibles :

- EXIF.
- IPTC.
- XMP.
- Dates et heures de prise de vue.
- Appareil et objectif.
- Paramètres de prise de vue.
- Dimensions et orientation.
- Coordonnées GPS.
- Auteur et copyright.
- Description et légende.
- Informations de couleur et de profil.
- Métadonnées propres aux formats RAW compatibles.

Ne pas confondre les dates de prise de vue, de création du fichier, de modification du fichier et d'indexation.

Prévoir une politique claire de priorité entre les métadonnées embarquées, les fichiers XMP annexes et les modifications documentaires de la base.

Permettre à l'utilisateur de choisir où enregistrer ses changements.

Ne jamais écraser silencieusement une valeur existante. Proposer un aperçu avant une modification massive des métadonnées.

---

## 9. MOTS-CLÉS ET MOTEUR DE RECHERCHE

Créer un gestionnaire de mots-clés hiérarchiques.

Fonctions :

- Création et modification.
- Fusion contrôlée.
- Attribution en masse.
- Suggestions.
- Recherche de variantes.
- Détection des doublons de vocabulaire.
- Importation et exportation.
- Statistiques d'utilisation.
- Synonymes.
- Catégories personnalisables.

Créer une recherche rapide et une recherche avancée.

Critères disponibles :

- Texte libre.
- Dates et périodes.
- Mots-clés inclus ou exclus.
- Conditions ET, OU et NON.
- Appareil et objectif.
- Lieu.
- Dimensions.
- Orientation.
- Format.
- Notes et couleurs.
- Support.
- Disponibilité.
- Statut d'intégrité.
- Présence de GPS.
- État de sauvegarde.
- Doublons.
- Présence ou absence de légende.
- Présence ou absence de mots-clés.

Permettre l'enregistrement de recherches sous forme de collections dynamiques.

Utiliser les index SQL et la recherche textuelle pour maintenir des performances adaptées au volume cible.

---

## 10. VIGNETTES, APERÇUS ET NAVIGATION

Créer une interface de consultation avec :

- Grille de vignettes.
- Plusieurs tailles d'affichage.
- Visionneuse plein écran.
- Zoom.
- Navigation au clavier.
- Comparaison de photos.
- Affichage des métadonnées.
- Sélection multiple.
- Classement rapide.
- Attribution de mots-clés.
- Filtres rapides.
- Historique de navigation.

Utiliser un cache d'aperçus configurable.

Privilégier des aperçus de résolution adaptée pour limiter les lectures répétées sur les disques externes et le NAS.

Le cache doit pouvoir être reconstruit sans perdre les informations documentaires.

Éviter de charger des centaines de milliers de fichiers ou d'éléments d'interface en mémoire simultanément.

Utiliser un chargement progressif, une pagination ou une virtualisation adaptée.

---

## 11. DOUBLONS ET PHOTOS SIMILAIRES

Prévoir plusieurs niveaux d'analyse.

**Doublons exacts :** comparaison d'empreintes cryptographiques fiables.

**Doublons potentiels :** noms, tailles et caractéristiques identiques, à confirmer.

**Images similaires :** empreintes perceptuelles ou analyse visuelle facultative.

**Versions différentes :** images de résolution différente, recadrages, exports et fichiers retouchés.

**Rafales :** photos prises à quelques instants d'intervalle.

Présenter les résultats dans une interface de comparaison indiquant les emplacements, dimensions, dates et supports.

Ne jamais supprimer automatiquement une photo au motif qu'elle ressemble à une autre.

Permettre de désigner une version de référence et de conserver les variantes.

---

## 12. RETOUCHE AVANCÉE ET FICHIERS RAW

Ce module doit offrir une expérience cohérente, sans prétendre remplacer immédiatement tous les logiciels professionnels spécialisés.

### 12.1 Développement RAW

Prévoir un moteur de développement RAW reposant sur une bibliothèque reconnue et compatible avec la licence du produit.

Évaluer notamment LibRaw et les autres solutions adaptées, en tenant compte des formats supportés, de la qualité du rendu, de la maintenance, des licences et de la compatibilité multiplateforme.

Prendre en charge les appareils et formats effectivement supportés par le moteur retenu.

Prévoir :

- Lecture des RAW compatibles.
- Aperçu rapide.
- Balance des blancs.
- Exposition.
- Contraste.
- Hautes lumières et ombres.
- Saturation et vibrance.
- Courbes de tonalité, si prises en charge.
- Réduction du bruit, si prise en charge.
- Netteté, si prise en charge.
- Correction du profil colorimétrique.
- Recadrage et redressement.
- Correction de l'orientation.
- Comparaison avant/après.

Ne pas affirmer que toutes les fonctions avancées sont disponibles si le moteur ne les fournit pas.

### 12.2 Retouche non destructive

Enregistrer les paramètres de retouche séparément des originaux.

Prévoir :

- Historique.
- Annulation et rétablissement.
- Réinitialisation.
- Variantes virtuelles.
- Préréglages.
- Comparaison des rendus.
- Export de la version finale.

Les fichiers RAW ne doivent jamais être modifiés directement par le moteur de retouche.

### 12.3 Autres outils

Intégrer :

- Recadrage.
- Rotation.
- Retournement.
- Redressement.
- Luminosité.
- Contraste.
- Balance des blancs.
- Couleurs.
- Noir et blanc.
- Filtres.
- Filigranes à l'export.
- Annotations et légendes lorsque pertinent.

Prévoir la possibilité d'ouvrir une image dans un logiciel externe, puis de retrouver facilement le fichier concerné.

### 12.4 Gestion des couleurs

Prévoir la prise en charge des profils ICC dans les flux qui le permettent.

Distinguer l'apparence de l'image à l'écran, l'espace colorimétrique de travail et le profil du fichier exporté.

Ne pas convertir automatiquement tous les originaux vers un profil unique.

Documenter les limites de la gestion colorimétrique de chaque moteur utilisé.

---

## 13. ALBUMS PHOTO

Créer un éditeur visuel permettant de construire des livres photo.

Fonctions :

- Format personnalisé.
- Formats prédéfinis.
- Orientation portrait, paysage ou carré.
- Pages simples et doubles pages.
- Placement par glisser-déposer.
- Modèles de mise en page.
- Plusieurs photos par page.
- Recadrage dans les cadres.
- Fonds et couleurs.
- Bordures.
- Textes et légendes.
- Titres.
- Numéros de page.
- Alignement.
- Guides.
- Marges de sécurité.
- Fonds perdus.
- Aperçu de l'impression.
- Duplication de pages.
- Réorganisation.
- Sauvegarde automatique.
- Annulation et rétablissement.

Les projets d'albums doivent être enregistrés dans un format versionné et documenté.

Ils doivent conserver les références aux photos et les paramètres de mise en page, plutôt que de multiplier inutilement les copies des originaux.

Signaler les photos absentes, les résolutions insuffisantes, les éléments hors page et les zones de sécurité non respectées.

Prévoir des modèles graphiques réutilisables.

---

## 14. CATALOGUES ET DOCUMENTS

Permettre de produire :

- Catalogue général.
- Catalogues thématiques.
- Planches-contact.
- Fiches détaillées.
- Portfolios.
- Inventaires par support.
- Catalogues par année.
- Catalogues par lieu.
- Catalogues par mot-clé.
- Rapports de sauvegarde.
- Rapports d'intégrité.
- Rapports de fichiers manquants.

Personnaliser :

- Le nombre d'images par page.
- La taille des vignettes.
- Les légendes.
- Les métadonnées affichées.
- Les titres.
- Les numéros.
- Les pieds de page.
- Les couleurs.
- La typographie.
- Les marges.
- L'ordre des photos.

Exporter en PDF et, selon le document, en CSV ou dans d'autres formats documentés.

Permettre de relancer la génération d'un catalogue après modification de la sélection.

---

## 15. EXPORT ET IMPRESSION

Créer un assistant d'export configurable.

Formats à prendre en charge selon les capacités réelles des bibliothèques : JPEG, PNG, TIFF et PDF, ainsi que les autres formats utiles lorsqu'ils sont correctement supportés.

Pour les photos, proposer :

- Dimensions en pixels.
- Dimensions physiques.
- Résolution de sortie.
- Qualité JPEG.
- Compression.
- Profil colorimétrique.
- Conversion de l'espace colorimétrique.
- Conservation ou suppression des métadonnées.
- Suppression facultative du GPS.
- Filigrane.
- Renommage.
- Organisation des dossiers.
- Export par lot.
- Rapport de résultat.

Pour l'impression :

- Formats de page.
- Marges.
- Fonds perdus.
- Résolution effective.
- Avertissement en cas de définition insuffisante.
- Profil de couleur lorsqu'il est nécessaire et disponible.

Créer des profils d'export enregistrables.

Prévoir des profils spécifiques aux prestataires de livres photo à partir de leurs spécifications réelles et documentées.

En l'absence d'intégration officielle, générer un dossier prêt à être envoyé manuellement sur le site du prestataire.

Ne jamais présenter une intégration directe comme opérationnelle tant qu'elle n'a pas été développée et testée.

---

## 16. INTELLIGENCE ARTIFICIELLE FACULTATIVE ET LOCALE

L'IA est une extension optionnelle et non une dépendance du fonctionnement principal.

### Fonctions envisagées

- Suggestion de mots-clés.
- Reconnaissance de catégories d'objets et de scènes.
- Recherche par description.
- Recherche d'images visuellement proches.
- Regroupement d'images similaires.
- Suggestions de classement.
- Détection facultative de visages.
- Suggestions de lieux ou de thèmes lorsque cela est possible.

### Contraintes

- Exécution locale en priorité.
- Modèles installables séparément.
- Téléchargement facultatif des modèles.
- Vérification des licences des modèles.
- Contrôle de l'utilisation du processeur et du GPU.
- Possibilité de désactiver chaque fonction.
- Aucune modification automatique des originaux.
- Aucune attribution définitive de mots-clés sans validation, sauf préférence explicite.
- Aucun transfert distant sans consentement explicite.

Les résultats produits par l'IA doivent être identifiés comme des suggestions.

Ne pas exiger une carte graphique haut de gamme pour utiliser les fonctions essentielles.

Prévoir une architecture permettant d'ajouter ou de retirer un moteur d'IA sans modifier le cœur de la photothèque.

---

## 17. SAUVEGARDES ET RESTAURATION

La sauvegarde est un module prioritaire.

Distinguer trois catégories :

1. Sauvegarde du catalogue et des informations documentaires.
2. Sauvegarde des originaux photographiques.
3. Sauvegarde des projets, paramètres et fichiers dérivés utiles.

La sauvegarde de la base ne garantit pas la sauvegarde des originaux qui se trouvent sur des disques externes ou sur le NAS.

### 17.1 Fonctions requises

- Sauvegarde manuelle.
- Sauvegarde planifiée.
- Plusieurs destinations.
- Historique.
- Politique de rétention.
- Vérification des sauvegardes.
- Restauration complète.
- Restauration sélective.
- Prévisualisation du contenu.
- Rapport d'erreurs.
- Alerte en cas d'échec.
- Vérification périodique.
- Test de restauration.

### 17.2 Destinations

Prévoir :

- Un autre disque local.
- Un disque externe.
- Un NAS.
- Un support conservé dans un autre emplacement.
- Un emplacement supplémentaire facultatif.

Ne pas considérer la synchronisation comme une sauvegarde suffisante : une suppression ou une corruption peut se propager.

### 17.3 Stratégie recommandée

Proposer une stratégie 3-2-1 :

- Trois copies des données importantes.
- Deux types de supports différents.
- Une copie conservée dans un emplacement distinct.

Lorsque c'est possible, utiliser des sauvegardes versionnées et une copie protégée contre les modifications accidentelles ou malveillantes.

### 17.4 Intégrité

Utiliser des empreintes cryptographiques pour vérifier les fichiers lorsque cela est pertinent.

Contrôler les archives de sauvegarde.

Documenter la date du dernier contrôle et les fichiers vérifiés.

Une sauvegarde n'est pas considérée comme fiable uniquement parce qu'elle a été créée : sa cohérence et sa capacité de restauration doivent être vérifiées.

### 17.5 Restauration

Permettre de restaurer le catalogue sur un nouvel ordinateur.

Prévoir la réassociation des supports et la détection des chemins devenus invalides.

Avant toute restauration, protéger l'état existant et expliquer les conséquences de l'opération.

---

## 18. SÉCURITÉ ET CONFIDENTIALITÉ

Concevoir l'application selon le principe du moindre privilège.

Prévoir :

- Permissions de fichiers limitées aux emplacements nécessaires.
- Validation des chemins.
- Protection contre les accès non autorisés.
- Gestion sécurisée des fichiers temporaires.
- Protection des clés et secrets.
- Chiffrement des sauvegardes sensibles.
- Verrouillage facultatif de l'application.
- Journalisation des opérations critiques.
- Dépendances maintenues.
- Vérification des mises à jour.
- Installation de versions signées lorsque l'infrastructure le permet.
- Gestion propre des erreurs.
- Protection contre les fichiers malformés.
- Contrôle des opérations de suppression, d'écrasement et de restauration.

Ne pas exposer les fonctions système à l'interface sans contrôle.

Ne pas stocker de mot de passe ou de clé de chiffrement en clair dans la base.

Préciser que le chiffrement des sauvegardes ne signifie pas automatiquement que les originaux ou la base active sont chiffrés.

Si le chiffrement intégral de la photothèque est souhaité, proposer une solution distincte, documentée et adaptée aux systèmes de fichiers ou au chiffrement du volume.

Aucune télémétrie ne doit être activée par défaut.

Aucune photo ni donnée GPS ne doit être transmise à un tiers sans consentement explicite.

---

## 19. VERSIONS ET LICENCE PERSONNELLE

### 19.1 Versionnement

Gérer séparément :

- La version de l'application.
- La version du schéma de base.
- La version du format de sauvegarde.
- La version du format de projet d'album.
- La version des paramètres de retouche.

Utiliser un système de gestion de versions du code source, avec historique des modifications, branches de développement et versions distribuées identifiables.

Avant une migration, prévoir une sauvegarde et une procédure de récupération adaptée.

Tester les migrations sur des copies avant de les exécuter sur les données de l'utilisateur.

Ne jamais promettre un retour arrière automatique si une transformation a détruit des informations impossibles à reconstruire.

### 19.2 Licence

Le logiciel est destiné à un usage personnel sans abonnement obligatoire.

Prévoir une licence locale simple, sans activation distante obligatoire.

La licence doit être distincte des informations sur les droits d'auteur des photographies.

Ne pas créer inutilement un serveur de licences, un compte utilisateur en ligne ou une infrastructure commerciale complexe.

Documenter les licences des bibliothèques, moteurs RAW et modèles d'IA intégrés.

---

## 20. STATISTIQUES ET TABLEAU DE BORD

Créer un tableau de bord synthétique comprenant :

- Nombre de photos.
- Nombre de fichiers physiques.
- Volume total référencé.
- Volume réellement stocké dans les emplacements gérés.
- Nombre de supports.
- Nombre de supports absents.
- Nombre de fichiers indisponibles.
- Répartition par année.
- Répartition par mois.
- Répartition par format.
- Répartition par appareil.
- Répartition par objectif.
- Photos sans mots-clés.
- Photos sans légende.
- Photos sans date de prise de vue.
- Photos sans coordonnées GPS.
- Doublons détectés.
- Sauvegardes récentes.
- Sauvegardes en échec.
- État général du catalogue.
- Historique des importations.

Distinguer clairement les volumes des originaux, des aperçus, des exports et des sauvegardes.

Prévoir des graphiques, des filtres et un export CSV ou PDF.

Les statistiques doivent être calculées sans ralentir la navigation courante.

---

## 21. INTERFACE GRAPHIQUE ET EXPÉRIENCE UTILISATEUR

Créer une interface professionnelle, moderne, intuitive, élégante et agréable à utiliser pendant plusieurs heures.

### Direction artistique

Proposer une identité visuelle inspirée des logiciels photographiques professionnels.

Prévoir :

- Thème sombre par défaut.
- Thème clair alternatif.
- Bleu profond.
- Turquoise discret.
- Gris neutres.
- Accents colorés pour les actions et les états.
- Typographie lisible.
- Icônes cohérentes.
- Contrastes accessibles.
- Espacements équilibrés.
- Animations discrètes.
- Vignettes de haute qualité.

Ne pas surcharger les écrans.

### Organisation

Barre latérale :

- Accueil.
- Photothèque.
- Importation.
- Supports.
- Collections.
- Recherche enregistrée.
- Mots-clés.
- Albums.
- Catalogues.
- Retouche.
- Sauvegardes.
- Statistiques.
- Paramètres.

Zone centrale :

- Grille de vignettes.
- Visionneuse.
- Éditeur d'albums.
- Documents.
- Rapports.

Panneau latéral facultatif :

- Métadonnées.
- Mots-clés.
- Informations du fichier.
- Emplacements physiques.
- État de sauvegarde.
- Informations de retouche.

Barre supérieure :

- Recherche globale.
- Filtres.
- Sélecteur de vue.
- Actions principales.

Barre d'état :

- Tâches en cours.
- Progression.
- État des supports.
- Alertes.
- Dernière sauvegarde.

### Ergonomie

Prévoir :

- Glisser-déposer.
- Raccourcis clavier.
- Menus contextuels.
- Sélection multiple.
- Opérations en lot.
- Infobulles.
- Confirmations adaptées au risque.
- Annulation lorsque techniquement possible.
- Messages d'erreur compréhensibles.
- Navigation rapide.
- Préférences personnalisables.

Créer un assistant de première utilisation permettant de définir la base, les dossiers de cache, les supports à indexer et les destinations de sauvegarde.

---

## 22. PERFORMANCES ET OBJECTIFS DE QUALITÉ

Concevoir l'application pour 100 000 à 500 000 photographies sur un ordinateur personnel courant compatible avec le logiciel.

Ne pas imposer que tous les originaux soient stockés sur un SSD.

Prendre en compte les performances différentes entre :

- SSD local.
- Disque dur externe.
- NAS.
- Réseau lent.
- Support momentanément absent.

### Objectifs à mesurer

- Temps de démarrage.
- Temps de chargement du catalogue.
- Temps de réponse des recherches.
- Temps de génération des vignettes.
- Utilisation mémoire.
- Utilisation CPU et GPU.
- Débit d'indexation.
- Comportement avec 500 000 enregistrements.
- Temps de reconnexion des supports.
- Temps de restauration.

Établir des seuils mesurables sur un matériel de référence plutôt que de promettre des temps universels.

Prévoir les tâches longues en arrière-plan, la reprise après interruption, la gestion des erreurs et la limitation de la consommation de ressources.

Le logiciel doit rester utilisable pendant l'indexation ou la génération d'un catalogue.

---

## 23. TESTS ET CRITÈRES D'ACCEPTATION

Créer des tests unitaires, d'intégration, de sécurité et des tests de parcours utilisateur.

Les critères suivants sont obligatoires.

### Indexation

- Indexer un dossier sans modifier les originaux.
- Reconnaître les fichiers déjà indexés.
- Détecter les changements.
- Reprendre une opération interrompue.
- Gérer les fichiers illisibles.
- Signaler les supports absents.
- Reconnecter un support sans perdre les annotations.

### Base de données

- Préserver l'intégrité des relations.
- Exécuter les migrations sur des copies de test.
- Récupérer les données après une fermeture inattendue.
- Vérifier les contraintes et les index.
- Tester les performances avec 500 000 entrées synthétiques.

### Recherche

- Combiner plusieurs filtres.
- Rechercher des mots-clés.
- Enregistrer une collection dynamique.
- Retrouver une image sur un support absent à partir des données du catalogue.

### Retouche et albums

- Conserver l'original.
- Reproduire les paramètres de retouche enregistrés.
- Enregistrer et rouvrir un album.
- Détecter une image manquante.
- Exporter un document conforme aux dimensions définies.

### Sauvegarde

- Sauvegarder le catalogue.
- Vérifier l'intégrité de la sauvegarde.
- Restaurer sur une base de test.
- Contrôler les projets et les métadonnées restaurés.
- Signaler les originaux qui ne sont pas couverts par la sauvegarde.
- Tester une restauration sur un ordinateur ou un emplacement différent.

### Sécurité

- Refuser les chemins non autorisés.
- Gérer les fichiers malformés sans compromettre la base.
- Protéger les opérations sensibles.
- Vérifier la gestion des secrets.
- Tester les mises à jour et les migrations.
- Vérifier les dépendances et leurs licences.

Tous les tests destructifs doivent être exécutés sur des données synthétiques ou des copies isolées.

---

## 24. FEUILLE DE ROUTE DE DÉVELOPPEMENT

Développer le produit en étapes indépendantes, chacune devant fournir un résultat réellement exécutable.

### Phase 0 — Conception

Livrables :

- Architecture.
- Schéma de données.
- Maquettes.
- Spécifications d'importation.
- Politique de sécurité.
- Stratégie de sauvegarde.
- Inventaire des dépendances.
- Plan de tests.

Identifier les risques techniques, notamment la prise en charge des RAW, la gestion du stockage réseau et la distribution multiplateforme.

### Phase 1 — Socle fonctionnel

Développer :

- Installation et lancement.
- Interface générale.
- Base SQLite.
- Gestion des supports.
- Indexation sans copie.
- Importation par copie.
- Vignettes.
- Recherche simple.
- Affichage des métadonnées.
- Détection des supports absents.

Cette phase doit déjà permettre de gérer une photothèque réelle sur un jeu de données de test.

### Phase 2 — Organisation documentaire

Développer :

- Mots-clés hiérarchiques.
- Recherche avancée.
- Collections dynamiques.
- Notes et évaluations.
- Modifications en masse.
- Détection des doublons.
- Gestion des variantes.
- Inventaire des supports.

### Phase 3 — Sauvegarde et fiabilité

Développer :

- Sauvegarde de la base.
- Sauvegardes planifiées.
- Contrôle d'intégrité.
- Historique.
- Restauration.
- Reconnexion des supports.
- Journalisation.
- Migrations.
- Tests de reprise après incident.

Valider cette phase avant d'ajouter les modules les plus complexes.

### Phase 4 — Retouche et RAW

Développer :

- Visionneuse avancée.
- Retouches non destructives.
- Gestion des variantes.
- Moteur RAW.
- Paramètres de développement.
- Profils colorimétriques compatibles.
- Export des images retouchées.

Documenter les formats et les fonctions qui ne sont pas supportés.

### Phase 5 — Albums et édition

Développer :

- Éditeur d'albums.
- Modèles de mise en page.
- Textes et légendes.
- Catalogues.
- Planches-contact.
- PDF.
- Profils d'impression.
- Export par lots.

### Phase 6 — Intelligence artificielle facultative

Développer :

- Moteur local optionnel.
- Suggestions de mots-clés.
- Recherche visuelle.
- Regroupement d'images similaires.
- Outils facultatifs de reconnaissance.

Ne pas rendre cette phase nécessaire à l'utilisation du logiciel.

### Phase 7 — Distribution et finalisation

Finaliser :

- Installateurs Windows.
- Application macOS.
- Paquet Linux lorsque possible.
- Signature et vérification des distributions lorsque disponibles.
- Documentation française.
- Guide de migration.
- Guide de sauvegarde.
- Tests de performance.
- Tests de sécurité.
- Processus de mise à jour.
- Gestion de version.
- Gestion de licence.

Ne jamais supprimer les fonctions validées au cours des phases précédentes.

---

## 25. LIVRABLES FINAUX

Fournir :

1. Le code source complet.
2. Une application exécutable et installable.
3. Les fichiers de configuration.
4. Le schéma de base de données.
5. Les migrations versionnées.
6. Les tests automatisés.
7. Les scripts de construction.
8. Les fichiers de distribution.
9. Le guide d'installation.
10. Le guide utilisateur en français.
11. Le guide de sauvegarde et de restauration.
12. La documentation technique.
13. La documentation des formats de projets.
14. L'inventaire des dépendances et de leurs licences.
15. Le journal des versions.
16. Une procédure de récupération après incident.
17. Une liste des fonctionnalités terminées et des limitations connues.

Ne pas fournir uniquement des fragments de code si l'objectif est une application complète.

Lorsque l'environnement de développement ne permet pas de compiler ou de tester un composant, expliquer précisément ce qui reste à faire au lieu de prétendre que le résultat est validé.

---

## 26. INSTRUCTIONS FINALES À L'IA DE DÉVELOPPEMENT

Commence par analyser l'ensemble du cahier des charges.

Présente ensuite :

1. L'architecture technique recommandée.
2. Les décisions nécessitant une validation.
3. Le schéma de données initial.
4. Les bibliothèques envisagées et leurs licences.
5. Les principaux risques techniques.
6. Les critères de réussite de la première version.
7. Le plan de réalisation détaillé.

Puis commence effectivement le développement du premier socle fonctionnel.

La priorité absolue est de construire une application stable qui sait indexer, retrouver et référencer des photographies sans modifier les originaux.

La deuxième priorité est de garantir la fiabilité du catalogue et la restauration des données.

La troisième priorité est de fournir les fonctions de retouche, d'édition et de valorisation photographique.

La quatrième priorité est d'ajouter les fonctions avancées et facultatives.

Privilégie la simplicité de maintenance, les technologies éprouvées, la documentation et la maîtrise des coûts.

À chaque étape, livre du code exécutable, des tests et un état précis de l'avancement.

Ne confonds jamais une maquette, un prototype, une fonctionnalité partielle et une fonction réellement opérationnelle.

Le résultat final doit être une application de bureau agréable à utiliser, sécurisée, durable, multiplateforme et capable de gérer plusieurs centaines de milliers de photographies sans imposer de dépendance à un abonnement ou à un service cloud.
