// Administration (frontend) : sauvegardes, versions, base de données, licence, manifeste, prompts, modèle.
// S'appuie sur les routes /api/backups, /api/versions, /api/db, /api/license, /api/manifest, /api/prompts, /api/model.
'use strict';
const Admin = (() => {
  const { h, clear, mount, esc, fmtBytes, fmtDate, fmtDateTime, fmtNum, kpi, card, sectionTitle, table, field, toast, modal, confirmDialog } = UI;
  // App est défini dans app.js : on le résout à l'appel pour ne pas dépendre de l'ordre des <script>.
  const api = (...args) => App.api(...args);

  const SECTIONS = [
    { id: 'backups', label: 'Sauvegardes', icon: '💾' },
    { id: 'versions', label: 'Versions', icon: '🏷️' },
    { id: 'db', label: 'Base de données', icon: '🗄️' },
    { id: 'license', label: 'Licence', icon: '©️' },
    { id: 'manifest', label: 'Manifeste', icon: '🧾' },
    { id: 'prompts', label: 'Prompts', icon: '💬' },
    { id: 'model', label: 'Modèle', icon: '📦' },
  ];

  async function view(container, section) {
    clear(container);
    const nav = h('div.tabs', ...SECTIONS.map(s => h('button' + (s.id === section ? '.active' : ''), { onclick: () => App.go('admin-' + s.id) }, s.icon + ' ' + s.label)));
    container.appendChild(h('h2.page-title', 'Administration'));
    container.appendChild(nav);
    const body = h('div'); container.appendChild(body);
    clear(body); body.appendChild(h('div.loading', 'Chargement…'));
    try {
      if (section === 'backups') await backups(body);
      else if (section === 'versions') await versions(body);
      else if (section === 'db') await db(body);
      else if (section === 'license') await license(body);
      else if (section === 'manifest') await manifest(body);
      else if (section === 'prompts') await prompts(body);
      else if (section === 'model') await model(body);
    } catch (e) { clear(body); body.appendChild(h('div.empty', h('div.big', '⚠️'), e.message)); }
  }

  // ---------- Sauvegardes ----------
  async function backups(body) {
    const wrap = h('div');
    async function refresh() {
      const o = await api('/backups');
      clear(wrap);
      wrap.appendChild(h('div.kpis', kpi('Sauvegardes', o.total.count), kpi('Volume total', fmtBytes(o.total.size)),
        kpi('Prochaine auto', o.nextAuto ? fmtDateTime(o.nextAuto) : 'désactivée', { tone: o.nextAuto ? 'ok' : '' })));
      const rows = o.list.map(b => ({ ...b, _size: b.size, _date: b.manifest?.createdAt ?? b.mtime }));
      wrap.appendChild(h('div.sect', 'Sauvegardes disponibles', h('div.spacer'),
        h('button.small', { onclick: () => create('data') }, 'Données'),
        h('button.small.ghost', { onclick: () => create('program') }, 'Programme'),
        h('button.small.ghost', { onclick: () => create('full') }, 'Complète')));
      if (!rows.length) wrap.appendChild(h('p.dim', 'Aucune sauvegarde.'));
      else wrap.appendChild(table({ columns: [
        { label: 'Fichier', key: 'name' },
        { label: 'Type', format: b => h('span.pill', b.manifest?.type || '?') },
        { label: 'Taille', format: b => fmtBytes(b._size), align: 'right' },
        { label: 'Date', format: b => fmtDateTime(b._date) },
        { label: '', align: 'right', format: b => h('div.row-actions',
          h('button.ghost.small', { onclick: () => verify(b.name) }, 'Vérifier'),
          h('a', { href: '/api/backups/file?name=' + encodeURIComponent(b.name), style: { padding: '5px 10px', fontSize: '12.5px' } }, 'Télécharger'),
          h('button.small', { onclick: () => restore(b.name) }, 'Restaurer'),
          h('button.danger.small', { onclick: async () => { if (await confirmDialog('Supprimer', `Supprimer ${b.name} ?`)) { await api('/backups?name=' + encodeURIComponent(b.name), 'DELETE'); refresh(); } } }, 'Supprimer')) },
      ], rows }));
    }
    async function create(type) { const r = await api('/backups', 'POST', { type }); toast('Sauvegarde créée : ' + r.created); refresh(); }
    async function verify(name) { const r = await api('/backups/verify', 'POST', { name }); toast(r.ok ? `Archive intacte (${r.entries} entrées)` : 'Archive corrompue : ' + r.bad.join(', '), r.ok ? 'ok' : 'bad'); }
    async function restore(name) {
      if (!await confirmDialog('Restaurer', `Restaurer ${name} ? Une sauvegarde de sécurité sera créée avant.`)) return;
      const r = await api('/backups/restore', 'POST', { name }); toast(`Restauré (${r.restored} fichier(s)). Sauvegarde de sécurité : ${r.safety}`); refresh();
    }
    mount(wrap, h('div')); await refresh(); clear(body); body.appendChild(wrap);
  }

  // ---------- Versions ----------
  async function versions(body) {
    const wrap = h('div');
    async function refresh() {
      const d = await api('/versions');
      clear(wrap);
      wrap.appendChild(h('div.kpis', kpi('Version courante', d.current), kpi('Instantanés', d.list.length),
        kpi('Node.js', d.about.node), kpi('Plateforme', d.about.platform), kpi('Uptime', Math.round(d.about.uptime / 60) + ' min')));
      const bump = h('select', {}, h('option', { value: 'patch' }, 'patch (correctif)'), h('option', { value: 'minor' }, 'minor (fonction)'), h('option', { value: 'major' }, 'major (majeur)'));
      const notes = h('textarea', { rows: 3, placeholder: 'Notes de version (une par ligne)' });
      wrap.appendChild(card(h('div.sect', 'Publier une version'), h('div.form', field('Niveau', bump), field('Notes', notes), h('div.field', h('label', ' '), h('button', { onclick: publish }, 'Publier')))));
      wrap.appendChild(h('div.sect', 'Versions publiées'));
      if (!d.list.length) wrap.appendChild(h('p.dim', 'Aucune version publiée.'));
      else wrap.appendChild(table({ columns: [
        { label: 'Version', format: v => h('b', v.version) },
        { label: 'Niveau', key: 'bump' },
        { label: 'Date', format: v => fmtDate(v.createdAt) },
        { label: 'Notes', format: v => h('span', { title: v.notes }, (v.notes || '').slice(0, 60)) },
        { label: '', align: 'right', format: v => h('div.row-actions',
          h('a', { href: '/api/versions/file?version=' + encodeURIComponent(v.version), style: { padding: '5px 10px', fontSize: '12.5px' } }, 'Télécharger'),
          h('button.danger.small', { onclick: async () => { if (await confirmDialog('Supprimer', `Supprimer l'instantané ${v.version} ?`)) { await api('/versions?version=' + encodeURIComponent(v.version), 'DELETE'); refresh(); } } }, 'Supprimer')) },
      ], rows: d.list }));
    }
    async function publish() {
      const notesVal = notes.value.trim(); if (!notesVal) return toast('Notes manquantes', 'warn');
      const r = await api('/versions', 'POST', { bump: bump.value, notes: notesVal }); toast('Version publiée : ' + r.published); refresh();
    }
    mount(wrap); await refresh(); clear(body); body.appendChild(wrap);
  }

  // ---------- Base de données ----------
  async function db(body) {
    const wrap = h('div');
    const st = await api('/db/status');
    wrap.appendChild(h('div.kpis', kpi('Moteur', st.engine), kpi('Schéma v', st.schema), kpi('Taille', fmtBytes(st.size)), kpi('Tables', st.tables.length)));
    const tableSel = h('select', {}, ...st.tables.map(t => h('option', { value: t.name }, `${t.name} (${t.rows})`)));
    const out = h('div');
    async function loadTable() {
      const name = tableSel.value; if (!name) return;
      const d = await api(`/db/table?name=${encodeURIComponent(name)}&limit=100`);
      clear(out);
      if (!d.rows.length) { out.appendChild(h('p.dim', 'Table vide.')); return; }
      out.appendChild(h('p.dim', `${fmtNum(d.total)} ligne(s) — page de ${d.rows.length}`));
      out.appendChild(h('div.table-wrap', table({ columns: d.columns.map(c => ({ label: c, key: c, format: r => typeof r[c] === 'object' ? JSON.stringify(r[c]).slice(0, 40) : String(r[c] ?? '') })), rows: d.rows })));
    }
    tableSel.addEventListener('change', loadTable);
    wrap.appendChild(card(h('div.sect', 'Contenu des tables (lecture seule)'),
      h('div.row', field('Table', tableSel),
        h('button.ghost.small', { onclick: async () => { const r = await api('/db/check', 'POST'); toast(r.ok ? 'Intégrité OK' : 'Problème : ' + r.result.join(', '), r.ok ? 'ok' : 'bad'); } }, "Contrôle d'intégrité"),
        h('button.ghost.small', { onclick: async () => { const r = await api('/db/vacuum', 'POST'); toast('Compacté : ' + fmtBytes(r.before) + ' → ' + fmtBytes(r.after)); } }, 'Compactage'),
        h('a', { href: '/api/db/file', style: { padding: '5px 10px', fontSize: '12.5px' } }, 'Télécharger le .db'),
        h('a', { href: '/api/db/export', style: { padding: '5px 10px', fontSize: '12.5px' } }, 'Exporter JSON')),
      out));
    clear(body); body.appendChild(wrap); loadTable();
  }

  // ---------- Licence ----------
  async function license(body) {
    const d = await api('/license');
    const holder = h('input', { type: 'text', value: d.license.holder });
    const year = h('input', { type: 'number', value: d.license.year });
    const product = h('input', { type: 'text', value: d.license.product });
    const type = h('select', {}, ...Object.entries(d.types).map(([k, v]) => h('option', { value: k, selected: d.license.licenseType === k }, v.label)));
    const wrap = h('div');
    wrap.appendChild(card(h('div.sect', "Copyright et licence d'utilisation"),
      h('div.form', field('Titulaire', holder), field('Année', year), field('Produit', product), field('Type de licence', type),
        h('div.field', h('label', ' '), h('button', { onclick: save }, 'Enregistrer'))),
      h('div.divider'), h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '12px', background: 'var(--surface-2)', padding: '12px', borderRadius: '8px' } }, d.licenseFile)));
    wrap.appendChild(card(h('div.sect', 'Composants tiers'),
      table({ columns: [{ label: 'Composant', key: 'name' }, { label: 'Version', key: 'version' }, { label: 'Licence', key: 'license' }], rows: d.thirdParty })));
    async function save() { await api('/license', 'PUT', { holder: holder.value, year: +year.value, product: product.value, licenseType: type.value }); toast('Licence enregistrée'); }
    clear(body); body.appendChild(wrap);
  }

  // ---------- Manifeste ----------
  async function manifest(body) {
    const d = await api('/manifest');
    const wrap = h('div');
    wrap.appendChild(h('div.kpis', kpi('Fichiers', d.manifest.summary.files), kpi('Taille', fmtBytes(d.manifest.summary.bytes)),
      kpi('Intégrité', d.manifest.integrity.slice(0, 12) + '…'), kpi('Enregistré', d.saved ? (d.saved.matches ? 'conforme' : 'différent') : 'aucun', { tone: d.saved ? (d.saved.matches ? 'ok' : 'warn') : '' })));
    wrap.appendChild(card(h('div.sect', 'Manifeste du programme'),
      h('p.dim', 'Le manifeste liste chaque fichier du programme avec son empreinte SHA-256, permettant de vérifier l\'intégrité du code.'),
      h('div.row',
        h('button', { onclick: async () => { const r = await api('/api/manifest/write'.replace('/api', ''), 'POST'); toast('Manifeste écrit (' + r.files + ' fichiers)'); } }, 'Générer le manifeste'),
        h('button.ghost', { onclick: async () => { const r = await api('/manifest/verify', 'POST'); toast(r.ok ? 'Conforme au manifeste enregistré' : `Écarts : ${r.modified.length} modifié(s), ${r.removed.length} supprimé(s), ${r.added.length} ajouté(s)`, r.ok ? 'ok' : 'warn'); } }, "Vérifier l'intégrité"),
        h('a', { href: '/api/manifest/download', style: { padding: '8px 14px' } }, 'Télécharger'))),
      card(h('div.sect', 'Composants'), table({ columns: [{ label: 'Nom', key: 'name' }, { label: 'Version', key: 'version' }, { label: 'Licence', key: 'license' }], rows: d.manifest.dependencies })));
    clear(body); body.appendChild(wrap);
  }

  // ---------- Prompts ----------
  async function prompts(body) {
    const d = await api('/prompts');
    const wrap = h('div');
    const journal = h('div');
    function renderJournal() {
      clear(journal);
      if (!d.journal.length) { journal.appendChild(h('p.dim', 'Journal vide.')); return; }
      journal.appendChild(table({ columns: [
        { label: 'Date', format: e => fmtDateTime(e.date) },
        { label: 'Texte', format: e => h('span', { title: e.text }, e.text.slice(0, 80)) },
        { label: 'Statut', format: e => h('span.pill', e.status || '—') },
        { label: 'Version', key: 'version' },
      ], rows: [...d.journal].reverse() }));
    }
    const text = h('textarea', { rows: 2, placeholder: 'Texte du prompt / demande' });
    wrap.appendChild(card(h('div.sect', 'Journal des prompts'),
      h('div.form', field('Nouvelle demande', text), h('div.field', h('label', ' '), h('button', { onclick: async () => { if (!text.value.trim()) return; d.journal = (await api('/prompts/journal', 'POST', { text: text.value.trim() })).journal; text.value = ''; renderJournal(); } }, 'Ajouter'))),
      journal));
    const sys = h('textarea', { rows: 3, value: d.templates.system || '' });
    const user = h('textarea', { rows: 3, value: d.templates.user || '' });
    wrap.appendChild(card(h('div.sect', 'Modèles de prompt'),
      h('p.dim', 'Le modèle utilisateur doit contenir la variable {{donnees}}.'),
      h('div.form', field('Modèle système', sys), field('Modèle utilisateur', user)),
      h('div.row', h('button', { onclick: async () => { d.templates = (await api('/prompts/templates', 'PUT', { system: sys.value, user: user.value, userMulti: d.templates.userMulti })).templates; toast('Modèles enregistrés'); } }, 'Enregistrer'),
        h('button.ghost', { onclick: async () => { d.templates = (await api('/prompts/templates/reset', 'POST')).templates; sys.value = d.templates.system; user.value = d.templates.user; toast('Réinitialisé'); } }, 'Réinitialiser'))));
    renderJournal();
    clear(body); body.appendChild(wrap);
  }

  // ---------- Modèle ----------
  async function model(body) {
    const d = await api('/model/sections');
    const wrap = h('div');
    const name = h('input', { type: 'text', placeholder: 'Nom du modèle' });
    const desc = h('input', { type: 'text', description: '', placeholder: 'Description' });
    const checks = h('div.form', ...Object.entries(d.sections).map(([k, label]) => {
      const cb = h('input', { type: 'checkbox', checked: true, value: k });
      return h('label.check', cb, h('span', label));
    }));
    wrap.appendChild(card(h('div.sect', 'Exporter un modèle de paramétrage'),
      h('p.dim', 'Exporte la configuration (menus, indexation, import, sauvegardes, modèles de prompt, licence) sans aucune donnée personnelle ni chemin.'),
      field('Nom', name), field('Description', desc), checks,
      h('div.row', h('button', { onclick: exportModel }, 'Exporter (JSON)'))));
    const file = h('input', { type: 'file', accept: '.json' });
    wrap.appendChild(card(h('div.sect', 'Importer un modèle'),
      field('Fichier de modèle', file),
      h('div.row', h('button', { onclick: importModel }, 'Importer et appliquer'))));
    async function exportModel() {
      const sections = [...checks.querySelectorAll('input:checked')].map(c => c.value);
      const r = await fetch('/api/model/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.value, description: desc.value, sections }) });
      const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (name.value || 'modele') + '.json'; a.click();
    }
    async function importModel() {
      const f = file.files[0]; if (!f) return toast('Choisissez un fichier', 'warn');
      const m = JSON.parse(await f.text());
      const r = await api('/model/import', 'POST', { model: m, sections: m.sections, mode: 'merge' });
      toast('Modèle appliqué (sauvegarde de sécurité : ' + r.safety + ')');
    }
    clear(body); body.appendChild(wrap);
  }

  return { view };
})();
