// Journal des prompts — enregistre chaque demande utilisateur dans la base.
// Usage : node scripts/journal.mjs "texte du prompt" [statut] [version]
// Conforme à la convention des projets frères (hook UserPromptSubmit).
import { initStore } from '../lib/store.mjs';

const [, , text, status = 'soumis', version = process.env.PHOTOTHEQUE_VERSION || ''] = process.argv;

if (!text || !text.trim()) {
  console.error('Usage : node scripts/journal.mjs "texte du prompt" [statut] [version]');
  process.exit(1);
}

const { db, store } = initStore();
const date = new Date().toISOString();

// la table prompt_journal existe déjà dans le schéma (lib/db.mjs)
db.prepare('INSERT INTO prompt_journal(id,date,text,status,version,data) VALUES(?,?,?,?,?,?)')
  .run('pj' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date, text.trim(), status, version, '{}');

db.close();
console.log(`[journal] ${date} · ${status} — ${text.trim().slice(0, 80)}`);
