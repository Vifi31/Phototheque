// Modèle de paramétrage : configuration réutilisable, sans aucune donnée personnelle (ni chemin, ni photo).
import { APP } from './appinfo.mjs';
import { DEFAULT_PROMPT_TEMPLATES } from './seed-prompts.mjs';
import { defaultLicense } from './license.mjs';
import { backupSettings } from './backup.mjs';

export const SECTIONS = {
  menu: 'Affichage et ordre des menus',
  scan: "Options d'indexation (taille des vignettes, empreintes)",
  import: 'Options importation (destination, collisions, dossiers)',
  backup: 'Planification des sauvegardes',
  promptTemplates: 'Modèles de prompt',
  license: "Copyright et licence d'utilisation (sans acceptation)",
};
const clone = x => JSON.parse(JSON.stringify(x));

export function exportModel(store, { name, description, sections, appVersion }) {
  const s = new Set(sections?.length ? sections : Object.keys(SECTIONS));
  const content = {};
  if (s.has('menu') && store.menu) content.menu = clone(store.menu);
  if (s.has('scan') && store.scan) { const { hash, thumb, thumbSize, previewSize, followSymlinks } = store.scan; content.scan = { hash, thumb, thumbSize, previewSize, followSymlinks }; }
  if (s.has('import') && store.import) { const { dest, onCollision, keepFolders } = store.import; content.import = { onCollision, keepFolders, destConfigured: !!dest }; }
  if (s.has('backup') && store.backup) { const { auto, every, weekday, time, type, keep } = backupSettings(store.backup); content.backup = { auto, every, weekday, time, type, keep }; }
  if (s.has('promptTemplates')) content.promptTemplates = clone(store.prompts?.templates ?? DEFAULT_PROMPT_TEMPLATES);
  if (s.has('license')) { const l = { ...defaultLicense(), ...(store.license ?? {}) }; content.license = { holder: l.holder, year: l.year, product: l.product, contact: l.contact, licenseType: l.licenseType, eulaEnabled: l.eulaEnabled, eulaText: l.eulaText }; }
  return { schema: APP.slug + '-model/1', name: String(name || 'Modèle ' + APP.name).slice(0, 80), description: String(description || '').slice(0, 500), createdAt: new Date().toISOString(), appVersion, sections: Object.keys(content), content };
}

export function builtinModel() {
  return { schema: APP.slug + '-model/1', name: "Modèle d'origine", description: "Modèles de prompt et options par défaut fournis avec l'application.", createdAt: null, appVersion: '', sections: ['promptTemplates', 'scan', 'import'],
    content: { promptTemplates: clone(DEFAULT_PROMPT_TEMPLATES), scan: { hash: true, thumb: true, thumbSize: 320, previewSize: 1600, followSymlinks: false }, import: { onCollision: 'rename', keepFolders: true } } };
}

export function validate(model) {
  if (!model || model.schema !== APP.slug + '-model/1' || typeof model.content !== 'object') throw new Error('Fichier de modèle invalide (schéma ' + APP.slug + '-model/1 attendu)');
}

/** Applique (ou simule) l'import. Retourne un résumé des changements. */
export function applyModel(store, model, { sections, mode = 'merge', dryRun = false }) {
  validate(model);
  const want = new Set((sections?.length ? sections : model.sections ?? Object.keys(model.content)).filter(k => model.content[k] !== undefined));
  const sum = [];
  const target = dryRun ? clone(store) : store;
  const c = model.content;
  if (want.has('menu')) { target.menu = clone(c.menu); sum.push('Menus : affichage et ordre remplacés'); }
  if (want.has('scan')) { target.scan = { ...(target.scan ?? {}), ...clone(c.scan) }; sum.push("Indexation : options remplacées"); }
  if (want.has('import')) { const d = target.import?.dest; target.import = { ...(target.import ?? {}), ...clone(c.import) }; if (d && c.import?.destConfigured !== false) target.import.dest = d; delete target.import.destConfigured; sum.push('Importation : options remplacées'); }
  if (want.has('backup')) { target.backup = backupSettings({ ...(target.backup ?? {}), ...clone(c.backup), since: new Date().toISOString() }); sum.push('Sauvegardes : planification remplacée'); }
  if (want.has('promptTemplates')) { target.prompts ??= { journal: [], templates: {}, seq: 1000 }; target.prompts.templates = clone(c.promptTemplates); sum.push('Modèles de prompt : remplacés'); }
  if (want.has('license')) { const l = { ...defaultLicense(), ...(target.license ?? {}) }; const t = c.license; const textChanged = (t.eulaText ?? '') !== (l.eulaText ?? ''); Object.assign(l, { holder: t.holder, year: t.year, product: t.product, contact: t.contact, licenseType: t.licenseType, eulaEnabled: t.eulaEnabled, eulaText: t.eulaText ?? '' }); if (textChanged) l.eulaVersion = (l.eulaVersion || 1) + 1; target.license = l; sum.push("Licence : copyright et licence d'utilisation remplacés"); }
  return { summary: sum, sections: [...want] };
}
