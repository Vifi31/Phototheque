// Journal des prompts initial (graine) et modèles de prompt par défaut pour Photothèque.
// Ces données ne sont que des exemples de démonstration : elles peuvent être effacées
// depuis l'application (Administration → Prompts) sans jamais supprimer le journal utilisateur.
const D = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).toISOString();

export const SEED_JOURNAL = [
  ['Ouvrir une nouvelle session et ajouter le projet Photothèque (C:\\DVP\\Phototheque)', D(2026, 10, 28, 9, 0), '0.1.0', 'Projet initialisé sur le modèle des applications voisines.'],
  ["Concevoir l'architecture, le schéma de base et les décisions techniques (indexation sans copie, SQLite, sharp/exifr)", D(2026, 10, 28, 9, 20), '0.1.0', 'Document ARCHITECTURE créé ; schéma photos/files/supports/keywords/albums défini.'],
].map(([text, date, version, notes], i) => ({ id: i + 1, date, source: 'session', status: 'ok', version, text, notes }));

// Modèles de prompt réutilisables. Le texte « user » doit contenir {{donnees}}.
export const DEFAULT_PROMPT_TEMPLATES = {
  system: "Tu es l'assistant d'une photothèque personnelle. Tu aides à indexer, importer, rechercher et organiser des photos sans jamais modifier ni supprimer les originaux. Réponds en français, de façon claire et concise.",
  user: "Indexe le dossier {{donnees}} sans copier ni modifier les originaux. Extrait les métadonnées EXIF, génère les vignettes, puis rapporte le nombre de photos indexées, les erreurs et les doublons éventuels.",
  userMulti: "Pour chaque dossier de {{donnees}}, indexe-le sans copier les originaux, extrait les métadonnées et génère les vignettes. Résume par dossier : indexées, ignorées, en erreur.",
};
