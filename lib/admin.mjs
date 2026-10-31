// Routes d'administration : journal des prompts et modèles de prompt, copyright / licence d'utilisation.
import fs from 'fs';
import path from 'path';
import { SEED_JOURNAL, DEFAULT_PROMPT_TEMPLATES } from './seed-prompts.mjs';
import { defaultLicense, LICENSE_TYPES, DEFAULT_EULA, eulaText, licenseFileText, noticeText, thirdParty, brief, copyrightLine } from './license.mjs';

const STATUSES = ['à faire', 'en cours', 'réalisé', 'annulé', 'envoyé', 'erreur'];
const str = (v, n) => String(v ?? '').slice(0, n);

export function licenseBrief(store) { return brief({ ...defaultLicense(), ...(store.license ?? {}) }); }
export function copyrightOf(store) { return copyrightLine({ ...defaultLicense(), ...(store.license ?? {}) }); }

export function setupAdmin({ root, getStore, saveStore }) {

  const prompts = () => {
    const s = getStore();
    if (!s.prompts) s.prompts = { journal: SEED_JOURNAL.map(x => ({ ...x })), templates: { ...DEFAULT_PROMPT_TEMPLATES }, seq: 1000 };
    s.prompts.templates ??= { ...DEFAULT_PROMPT_TEMPLATES }; s.prompts.seq ??= 1000;
    s.prompts.templates.userMulti ||= DEFAULT_PROMPT_TEMPLATES.userMulti;
    return s.prompts;
  };
  const license = () => { const s = getStore(); s.license = { ...defaultLicense(), ...(s.license ?? {}) }; return s.license; };
  const licensePayload = () => {
    const l = license(), list = thirdParty(root, process.version);
    return { license: l, types: LICENSE_TYPES, brief: brief(l), eulaPreview: eulaText(l), eulaDefault: DEFAULT_EULA, licenseFile: licenseFileText(l), notice: noticeText(l, list), thirdParty: list };
  };

  return async function handle(req, res, url, { json, readBody }) {
    const p = url.pathname, m = req.method;
    if (!['/api/prompts', '/api/license'].some(x => p.startsWith(x))) return false;
    const err = (msg, code = 400) => { json(res, code, { error: msg }); return true; };
    const ok = body => { saveStore(); json(res, 200, body); return true; };
    let mm;
    try {
      // ---------- journal des prompts
      if (p === '/api/prompts' && m === 'GET') { const pr = prompts(); return json(res, 200, { journal: pr.journal, templates: pr.templates, defaults: DEFAULT_PROMPT_TEMPLATES, statuses: STATUSES }), true; }
      if (p === '/api/prompts/journal' && m === 'POST') {
        const b = await readBody(req), pr = prompts(); if (!str(b.text, 20000).trim()) return err('Le texte du prompt est obligatoire');
        pr.journal.push({ id: ++pr.seq, source: 'demande', date: b.date || new Date().toISOString(), text: str(b.text, 20000), status: STATUSES.includes(b.status) ? b.status : 'à faire', version: str(b.version, 20), notes: str(b.notes, 2000) });
        return ok({ journal: pr.journal });
      }
      if ((mm = p.match(/^\/api\/prompts\/journal\/(\d+)$/))) {
        const pr = prompts(), i = pr.journal.findIndex(x => String(x.id) === mm[1]); if (i < 0) return err('Entrée introuvable', 404);
        if (m === 'PUT') {
          const b = await readBody(req), e = pr.journal[i];
          if (b.text !== undefined) { if (!str(b.text, 20000).trim()) return err('Le texte du prompt est obligatoire'); e.text = str(b.text, 20000); }
          if (b.date) e.date = String(b.date); if (STATUSES.includes(b.status)) e.status = b.status;
          if (b.version !== undefined) e.version = str(b.version, 20); if (b.notes !== undefined) e.notes = str(b.notes, 2000);
          e.edited = new Date().toISOString(); return ok({ journal: pr.journal });
        }
        if (m === 'DELETE') { pr.journal.splice(i, 1); return ok({ journal: pr.journal }); }
      }
      if (p === '/api/prompts/templates' && m === 'PUT') {
        const b = await readBody(req), pr = prompts();
        if (!str(b.system, 8000).trim() || !str(b.user, 8000).includes('{{donnees}}')) return err('Le modèle utilisateur doit contenir {{donnees}}');
        pr.templates = { system: str(b.system, 8000), user: str(b.user, 8000), userMulti: str(b.userMulti, 8000).includes('{{donnees}}') ? str(b.userMulti, 8000) : (pr.templates.userMulti || DEFAULT_PROMPT_TEMPLATES.userMulti) };
        return ok({ templates: pr.templates });
      }
      if (p === '/api/prompts/templates/reset' && m === 'POST') { const pr = prompts(); pr.templates = { ...DEFAULT_PROMPT_TEMPLATES }; return ok({ templates: pr.templates }); }

      // ---------- licence
      if (p === '/api/license' && m === 'GET') return json(res, 200, licensePayload()), true;
      if (p === '/api/license' && m === 'PUT') {
        const b = await readBody(req), l = license();
        if (b.holder !== undefined) { if (!str(b.holder, 80).trim()) return err('Le titulaire du copyright est obligatoire'); l.holder = str(b.holder, 80).trim(); }
        if (b.year) l.year = Math.min(2100, Math.max(1990, Math.round(+b.year) || l.year));
        if (b.product !== undefined && str(b.product, 60).trim()) l.product = str(b.product, 60).trim();
        if (b.contact !== undefined) l.contact = str(b.contact, 120);
        if (LICENSE_TYPES[b.licenseType]) l.licenseType = b.licenseType;
        if (typeof b.eulaEnabled === 'boolean') l.eulaEnabled = b.eulaEnabled;
        if (b.eulaText !== undefined && str(b.eulaText, 30000) !== (l.eulaText ?? '')) { l.eulaText = str(b.eulaText, 30000); l.eulaVersion = (l.eulaVersion || 1) + 1; }
        return ok(licensePayload());
      }
      if (p === '/api/license/accept' && m === 'POST') {
        const b = await readBody(req), l = license(); if (!str(b.name, 80).trim()) return err('Indiquez votre nom pour accepter la licence');
        l.acceptance = { name: str(b.name, 80).trim(), at: new Date().toISOString(), eulaVersion: l.eulaVersion }; return ok(licensePayload());
      }
      if (p === '/api/license/revoke' && m === 'POST') { license().acceptance = null; return ok(licensePayload()); }
      if (p === '/api/license/write-files' && m === 'POST') {
        const l = license(), list = thirdParty(root, process.version);
        fs.writeFileSync(path.join(root, 'LICENSE'), licenseFileText(l)); fs.writeFileSync(path.join(root, 'NOTICE'), noticeText(l, list));
        return json(res, 200, { written: ['LICENSE', 'NOTICE'], dir: root }), true;
      }

    } catch (e) { return err(String(e.message || e)); }
    return false;
  };
}
