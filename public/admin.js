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
  // Catalogue et réglages : archives (chiffrées ou non), copiées vers des destinations, testées.
  // Originaux : couverts par des copies sur des supports de rôle « Sauvegarde » / « Archive ».
  function askPassword(title, message, { confirm = false, current = false } = {}) {
    return new Promise(resolve => {
      const cur = current ? h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'mot de passe actuel' }) : null;
      const pw = h('input', { type: 'password', autocomplete: confirm ? 'new-password' : 'current-password' });
      const pw2 = confirm ? h('input', { type: 'password', autocomplete: 'new-password' }) : null;
      let done = false;
      const finish = v => { if (!done) { done = true; m.close(); resolve(v); } };
      const ok = () => {
        if (confirm && pw.value !== pw2.value) { toast('Les deux saisies diffèrent', 'bad'); return; }
        finish(current ? { current: cur.value, password: pw.value } : pw.value);
      };
      for (const el of [cur, pw, pw2].filter(Boolean)) el.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
      const m = modal({ title, body: h('div', h('p', message), cur ? field('Mot de passe actuel', cur) : null, field(confirm ? 'Nouveau mot de passe' : 'Mot de passe', pw), pw2 ? field('Confirmation', pw2) : null),
        actions: [h('button.ghost', { onclick: () => finish(null) }, 'Annuler'), h('button', { onclick: ok }, 'Valider')] });
      setTimeout(() => (cur ?? pw).focus(), 50);
    });
  }

  async function backups(body) {
    const wrap = h('div');
    let o = null;
    const TYPE = { data: 'Données', program: 'Programme', full: 'Complète' };
    // mot de passe d'une archive chiffrée : celui de la session s'il est saisi, sinon demandé
    async function pwFor(b) {
      if (!b?.manifest?.encrypted || o.encryption.unlocked) return '';
      const pw = await askPassword('Archive chiffrée', `${b.name} est chiffrée. Saisissez le mot de passe des sauvegardes.`);
      if (pw === null) throw new Error('Opération annulée');
      return pw;
    }
    const run = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; } catch (e) { if (e.message !== 'Opération annulée') toast(e.message, 'bad'); return null; } };

    async function refresh() {
      o = await api('/backups');
      clear(wrap);
      const last = o.list.find(b => b.manifest && b.manifest.type !== 'program');
      const cov = o.coverage;
      wrap.appendChild(h('div.kpis',
        kpi('Sauvegardes', o.total.count, { sub: fmtBytes(o.total.size) }),
        kpi('Dernière du catalogue', last ? fmtDateTime(last.manifest.createdAt) : 'aucune', { tone: last ? 'ok' : 'bad' }),
        kpi('Prochaine programmée', o.nextAuto ? fmtDateTime(o.nextAuto) : 'désactivée', { tone: o.nextAuto ? 'ok' : '' }),
        kpi('Destinations', o.destinations.filter(d => d.enabled).length, { sub: o.destinations.filter(d => d.enabled && d.last?.ok).length + ' à jour' }),
        cov ? kpi('Originaux couverts', cov.photos ? Math.round(cov.covered * 100 / cov.photos) + ' %' : '—', { sub: `${fmtNum(cov.photos - cov.covered)} sans copie de sauvegarde`, tone: cov.covered === cov.photos ? 'ok' : 'warn' }) : null));

      // alertes
      if (o.alerts.length) wrap.appendChild(card(h('div.sect', `⚠ Alertes (${o.alerts.filter(a => a.level !== 'info').length})`, h('div.spacer'),
        o.events.some(e => !e.ok && !e.ack) ? h('button.ghost.small', { onclick: async () => { await api('/backups/alerts/ack', 'POST'); refresh(); } }, 'Marquer les échecs comme vus') : null),
        ...o.alerts.map(a => h('div.album-alert.' + a.level, a.message))));

      // règle 3-2-1
      const R = o.rule321, mark = ok => h('b', { style: { color: ok ? 'var(--ok)' : 'var(--warn)' } }, ok ? '✓' : '✗');
      wrap.appendChild(card(h('div.sect', 'Stratégie 3-2-1'),
        h('div.rule321',
          h('div', mark(R.three), ` 3 copies du catalogue (actuellement ${R.copies} : la base en service, les archives locales, les destinations à jour)`),
          h('div', mark(R.two), ' 2 types de supports (une destination autre qu’un disque interne : disque externe, NAS…)'),
          h('div', mark(R.one), ' 1 copie dans un autre lieu (destination « Support conservé dans un autre lieu »)'),
          cov ? h('div', mark(cov.covered === cov.photos), ` Originaux : ${fmtNum(cov.covered)} / ${fmtNum(cov.photos)} photo(s) ont une copie sur un support de sauvegarde ou d’archive`,
            cov.covered < cov.photos ? h('button.ghost.small', { style: { marginLeft: '8px' }, onclick: () => { App.state.q = ''; App.state.facet = { backup: 'uncovered' }; App.state.page = 0; App.go('photos'); } }, 'Voir les photos non couvertes') : null) : null),
        h('p.dim', 'Les archives ci-dessous contiennent le catalogue, les réglages et les documents, pas les photos : copiez les originaux sur un disque déclaré « Sauvegarde » ou « Archive » (menu Supports) puis indexez-le. Une synchronisation n’est pas une sauvegarde : une suppression ou une corruption s’y propage.')));

      // archives
      wrap.appendChild(h('div.sect', 'Sauvegardes disponibles', h('div.spacer'),
        h('button.small', { onclick: () => create('data') }, 'Sauvegarder les données'),
        h('button.small.ghost', { onclick: () => create('program') }, 'Programme'),
        h('button.small.ghost', { onclick: () => create('full') }, 'Complète'),
        h('button.small.ghost', { title: 'Ajoute une archive .zip ou .enc (autre ordinateur, disque externe) à la liste, pour la tester ou la restaurer', onclick: () => {
          const inp = h('input', { type: 'file', accept: '.zip,.enc', style: { display: 'none' }, onchange: async () => {
            const f = inp.files[0]; inp.remove(); if (!f) return;
            toast('Import de ' + f.name + '…');
            try {
              const r = await fetch('/api/backups/import?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
              const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Import impossible');
              toast(`Archive importée : ${j.imported}. Testez-la, puis restaurez-la si besoin.`); refresh();
            } catch (e) { toast(e.message, 'bad'); }
          } });
          document.body.appendChild(inp); inp.click();
        } }, 'Importer une archive…')));
      const rows = o.list.map(b => ({ ...b, _date: b.manifest?.createdAt ?? b.mtime }));
      if (!rows.length) wrap.appendChild(h('p.dim', 'Aucune sauvegarde.'));
      else wrap.appendChild(table({ columns: [
        { label: 'Date', format: b => h('span', { title: b.name }, fmtDateTime(b._date)) },
        { label: 'Type', format: b => h('span', h('span.pill', TYPE[b.manifest?.type] ?? '?'), b.manifest?.encrypted ? h('span.pill', { title: 'Chiffrée (AES-256)' }, '🔒') : null, b.manifest?.auto ? h('small.dim', ' auto') : null) },
        { label: 'Taille', format: b => fmtBytes(b.size), align: 'right' },
        { label: 'Test de restauration', format: b => b.test ? h('span.' + (b.test.ok ? 'ok' : 'bad'), { title: b.test.message }, `${b.test.ok ? '✓ réussi' : '✗ échec'} · ${fmtDate(b.test.at)}`) : h('span.dim', 'jamais') },
        { label: '', align: 'right', format: b => h('div.row-actions',
          b.manifest?.type !== 'program' ? h('button.ghost.small', { title: 'Voir ce que contient la sauvegarde et en restaurer une partie', onclick: () => contents(b) }, 'Contenu…') : null,
          h('button.ghost.small', { title: 'Contrôles CRC, empreintes, ouverture du catalogue dans un dossier temporaire : rien n’est remplacé', onclick: () => test(b) }, 'Tester'),
          o.destinations.some(d => d.enabled) ? h('button.ghost.small', { title: 'Copier vers les destinations actives', onclick: () => copy(b) }, 'Copier') : null,
          h('a', { href: '/api/backups/file?name=' + encodeURIComponent(b.name), style: { padding: '5px 10px', fontSize: '12.5px' } }, 'Télécharger'),
          b.manifest?.type !== 'program' ? h('button.small', { onclick: () => restore(b) }, 'Restaurer…') : null,
          h('button.danger.small', { onclick: async () => { if (await confirmDialog('Supprimer', `Supprimer ${b.name} ? Les copies des destinations ne sont pas touchées.`)) { await api('/backups?name=' + encodeURIComponent(b.name), 'DELETE'); refresh(); } } }, '🗑')) },
      ], rows }));

      wrap.appendChild(h('div.two-cards', destinationsCard(), h('div', scheduleCard(), encryptionCard())));

      // journal
      wrap.appendChild(h('div.sect', 'Journal des opérations'));
      if (!o.events.length) wrap.appendChild(h('p.dim', 'Aucune opération enregistrée.'));
      else wrap.appendChild(table({ columns: [
        { label: 'Date', format: e => fmtDateTime(e.at) },
        { label: 'Opération', key: 'kind' },
        { label: 'Résultat', format: e => h('span.' + (e.ok ? 'ok' : 'bad'), e.ok ? 'réussi' : 'ÉCHEC') },
        { label: 'Détail', format: e => h('span.wrap', e.message) },
      ], rows: o.events.slice(0, 30) }));
    }

    function destinationsCard() {
      const list = o.destinations.map(d => h('div.dest' + (d.enabled ? '' : '.off'),
        h('div.row', h('b', d.name), h('span.pill', o.destKinds[d.kind] ?? d.kind), d.reachable ? null : h('span.pill.warn', 'inaccessible'), h('div.spacer'),
          h('button.ghost.small', { onclick: () => editDest(d) }, 'Modifier'),
          h('button.ghost.small.danger', { onclick: async () => { if (await confirmDialog('Retirer la destination', `Retirer « ${d.name} » ? Les archives déjà copiées restent sur place.`)) { await api('/backups/destinations?id=' + encodeURIComponent(d.id), 'DELETE'); refresh(); } } }, 'Retirer')),
        h('small.dim', `${d.folder} · ${d.archives} archive(s)`),
        h('small.' + (d.last ? (d.last.ok ? 'ok' : 'bad') : 'dim'), d.last ? `Dernière copie : ${fmtDateTime(d.last.at)} — ${d.last.message}` : 'Aucune copie encore')));
      return card(h('div.sect', 'Destinations', h('div.spacer'), h('button.small', { onclick: () => editDest(null) }, 'Ajouter…')),
        ...(list.length ? list : [h('p.dim', 'Aucune : les archives ne sont que dans le dossier Sauvegardes de l’application, sur le même disque.')]),
        h('p.dim', `Chaque nouvelle sauvegarde est copiée dans « ${o.destSubdir} » sur chaque destination active, puis la copie est relue et comparée (SHA-256). Les sauvegardes programmées y sont conservées au nombre réglé ci-contre.`));
    }
    function editDest(d) {
      const name = h('input', { type: 'text', value: d?.name ?? '', placeholder: 'ex. : Disque externe bleu' });
      const pth = h('input', { type: 'text', value: d?.path ?? '', placeholder: 'ex. : E:\\  ou  \\\\NAS\\sauvegardes' });
      const kind = h('select', {}, ...Object.entries(o.destKinds).map(([k, l]) => h('option', { value: k, selected: k === (d?.kind ?? 'external') }, l)));
      const en = h('input', { type: 'checkbox', checked: d ? d.enabled : true });
      const m = modal({ title: d ? 'Modifier la destination' : 'Nouvelle destination', body: h('div', field('Nom', name), field('Dossier (chemin complet)', pth), field('Type de support', kind), h('label.check', en, ' Active (copier les nouvelles sauvegardes)'),
        h('p.dim', 'Un disque débranché ou un NAS éteint n’est pas une erreur grave : la copie échoue, une alerte le signale, et vous pouvez recopier plus tard avec « Copier ».')),
        actions: [h('button.ghost', { onclick: () => m.close() }, 'Annuler'), h('button', { onclick: async () => {
          try { await api('/backups/destinations', 'POST', { id: d?.id, name: name.value, path: pth.value, kind: kind.value, enabled: en.checked }); m.close(); toast('Destination enregistrée'); refresh(); } catch (e) { toast(e.message, 'bad'); }
        } }, 'Enregistrer')] });
    }

    function scheduleCard() {
      const s = o.settings;
      const auto = h('input', { type: 'checkbox', checked: s.auto });
      const every = h('select', {}, h('option', { value: 'daily', selected: s.every !== 'weekly' }, 'Chaque jour'), h('option', { value: 'weekly', selected: s.every === 'weekly' }, 'Chaque semaine'));
      const days = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
      const wd = h('select', {}, ...days.map((d, i) => h('option', { value: i, selected: i === s.weekday }, d)));
      const time = h('input', { type: 'time', value: s.time });
      const type = h('select', {}, ...Object.entries(TYPE).map(([k, l]) => h('option', { value: k, selected: k === s.type }, l)));
      const keep = h('input', { type: 'number', min: 1, max: 200, value: s.keep });
      const vEvery = h('input', { type: 'number', min: 0, max: 90, value: s.verifyEvery });
      const maxAge = h('input', { type: 'number', min: 1, max: 365, value: s.maxAgeDays });
      const save = async () => { await run(async () => { await api('/backups/settings', 'PUT', { auto: auto.checked, every: every.value, weekday: +wd.value, time: time.value, type: type.value, keep: +keep.value, verifyEvery: +vEvery.value, maxAgeDays: +maxAge.value }); await refresh(); }, 'Programmation enregistrée'); };
      return card(h('div.sect', 'Programmation et contrôles'),
        h('label.check', auto, ' Sauvegarde automatique'),
        h('div.form', field('Fréquence', every), field('Jour (hebdomadaire)', wd), field('Heure', time)),
        h('div.form', field('Contenu', type), field('Sauvegardes programmées conservées', keep)),
        h('div.form', field('Test de restauration automatique tous les (jours, 0 = jamais)', vEvery), field('Alerte si la dernière sauvegarde a plus de (jours)', maxAge)),
        h('div.row', h('button.small', { onclick: save }, 'Enregistrer')),
        h('p.dim', 'L’application doit être ouverte pour que la sauvegarde programmée ait lieu ; un créneau manqué est rattrapé au démarrage suivant.'));
    }

    function encryptionCard() {
      const E = o.encryption;
      const actions = [];
      if (!E.enabled) actions.push(h('button.small', { onclick: async () => {
        const pw = await askPassword('Chiffrer les sauvegardes', 'Les nouvelles sauvegardes seront chiffrées (AES-256). Sans ce mot de passe, elles seront illisibles : notez-le en lieu sûr. Il n’est enregistré nulle part.', { confirm: true });
        if (pw === null) return; await run(async () => { await api('/backups/encryption', 'POST', { enabled: true, password: pw }); await refresh(); }, 'Chiffrement activé');
      } }, 'Activer le chiffrement…'));
      else {
        if (!E.unlocked) actions.push(h('button.small', { onclick: async () => { const pw = await askPassword('Mot de passe des sauvegardes', 'Saisi pour la session : permet les sauvegardes programmées chiffrées et l’ouverture des archives chiffrées jusqu’à l’arrêt de l’application.'); if (pw === null) return; await run(async () => { await api('/backups/encryption/unlock', 'POST', { password: pw }); await refresh(); }, 'Mot de passe accepté pour la session'); } }, 'Saisir le mot de passe…'));
        else actions.push(h('button.ghost.small', { onclick: async () => { await api('/backups/encryption/lock', 'POST'); refresh(); } }, 'Oublier le mot de passe (session)'));
        actions.push(h('button.ghost.small', { onclick: async () => { const r = await askPassword('Changer le mot de passe', 'Les nouvelles sauvegardes utiliseront le nouveau mot de passe ; les anciennes gardent l’ancien.', { confirm: true, current: true }); if (!r) return; await run(async () => { await api('/backups/encryption', 'POST', { enabled: true, password: r.password, current: r.current }); await refresh(); }, 'Mot de passe changé'); } }, 'Changer…'));
        actions.push(h('button.ghost.small.danger', { onclick: async () => { const pw = await askPassword('Désactiver le chiffrement', 'Les nouvelles sauvegardes ne seront plus chiffrées (les anciennes le restent).'); if (pw === null) return; await run(async () => { await api('/backups/encryption', 'POST', { enabled: false, current: pw }); await refresh(); }, 'Chiffrement désactivé'); } }, 'Désactiver…'));
      }
      return card(h('div.sect', 'Chiffrement des sauvegardes'),
        h('p', E.enabled ? (E.unlocked ? '🔒 Activé — mot de passe saisi pour cette session.' : '🔒 Activé — mot de passe non saisi depuis le démarrage.') : 'Désactivé.'),
        h('div.row', { style: { gap: '8px' } }, ...actions),
        h('p.dim', 'Seules les archives de sauvegarde sont chiffrées : la base en service et les photos originales ne le sont pas. Pour chiffrer tout le disque, utilisez le chiffrement du système (BitLocker sous Windows). Le mot de passe n’est jamais enregistré ; seule une empreinte de contrôle l’est.'));
    }

    async function create(type) {
      let password = '';
      if (o.encryption.enabled && !o.encryption.unlocked) { const pw = await askPassword('Sauvegarde chiffrée', 'Saisissez le mot de passe des sauvegardes.'); if (pw === null) return; password = pw; }
      const r = await run(() => api('/backups', 'POST', { type, password }), r => `Sauvegarde créée : ${r.created}`);
      if (r?.copies?.length) { const bad = r.copies.filter(c => !c.ok); if (bad.length) toast(`Copie en échec : ${bad.map(c => `${c.name} (${c.message})`).join(' ; ')}`, 'bad'); else toast(`Copiée vers ${r.copies.length} destination(s), copies vérifiées`); }
      refresh();
    }
    async function test(b) {
      let pw; try { pw = await pwFor(b); } catch { return; }
      toast('Test de restauration en cours…');
      const r = await run(() => api('/backups/test', 'POST', { name: b.name, password: pw }));
      if (r) { toast(r.test.message, r.test.ok ? 'ok' : 'bad'); refresh(); }
    }
    async function copy(b) {
      const r = await run(() => api('/backups/copy', 'POST', { name: b.name }));
      if (r) { const bad = r.copies.filter(c => !c.ok); toast(bad.length ? `Échec : ${bad.map(c => `${c.name} (${c.message})`).join(' ; ')}` : `Copiée vers ${r.copies.length} destination(s), copies vérifiées`, bad.length ? 'bad' : 'ok'); refresh(); }
    }
    async function restore(b, pw = null) {
      try { pw ??= await pwFor(b); } catch { return; }
      const when = fmtDateTime(b.manifest.createdAt);
      if (!await confirmDialog('Restaurer tout le catalogue', `Le catalogue actuel (photos indexées, mots-clés, albums, collections, retouches, réglages) sera remplacé par celui du ${when}. Les modifications faites depuis seront perdues, mais une sauvegarde de sécurité de l’état actuel est créée d’abord. Les photos elles-mêmes ne sont pas touchées. L’application redémarre ensuite.`)) return;
      const r = await run(() => api('/backups/restore', 'POST', { name: b.name, password: pw }));
      if (!r) return;
      if (r.restartRequired) {
        toast(`Restauration prête (sauvegarde de sécurité : ${r.safety}). Redémarrage…`);
        try { await api('/restart', 'POST'); } catch { /* le serveur s'arrête */ }
        setTimeout(() => location.reload(), 5000);
      } else { toast(`Restauré (${r.restored} fichier(s)). Sauvegarde de sécurité : ${r.safety}`); refresh(); }
    }
    async function contents(b) {
      let pw; try { pw = await pwFor(b); } catch { return; }
      const c = await run(() => api('/backups/contents', 'POST', { name: b.name, password: pw })); if (!c) return;
      const K = c.catalogue?.counts ?? {}, cur = c.current ?? {};
      const chk = (val, label, sub) => { const cb = h('input', { type: 'checkbox', value: val }); return { cb, el: h('label.check.pick', cb, ' ', label, sub ? h('small.dim', ' ' + sub) : null) }; };
      const al = (c.catalogue?.albums ?? []).map(a => ({ id: a.id, ...chk(a.id, a.name, `${a.pages} page(s) · modifié le ${fmtDate(a.updated_at)}`) }));
      const co = (c.catalogue?.collections ?? []).map(x => ({ id: x.id, ...chk(x.id, x.name, x.kind === 'dynamic' ? 'recherche enregistrée' : `${x.photos} photo(s)`) }));
      const docs = (c.documents ?? []).map(d => ({ id: d, ...chk(d, d) }));
      const cmp = (label, a, now) => h('tr', h('td', label), h('td.right', a == null ? '—' : fmtNum(a)), h('td.right', now == null ? '—' : fmtNum(now)));
      const status = h('div');
      const m = modal({ title: `Contenu — ${fmtDateTime(c.manifest.createdAt)}`, wide: true, body: h('div',
        h('p.dim', `${c.name} · ${TYPE[c.manifest.type] ?? c.manifest.type}${c.manifest.encrypted ? ' · chiffrée' : ''} · version ${c.manifest.version} · ${c.files.length} fichier(s)${c.manifest.label ? ' · ' + c.manifest.label : ''}`),
        c.catalogue ? h('table.table', h('thead', h('tr', h('th', ''), h('th.right', 'Sauvegarde'), h('th.right', 'Actuellement'))),
          h('tbody', cmp('Photos', K.photos, cur.photos), cmp('Supports', K.supports, cur.supports), cmp('Mots-clés', K.keywords, cur.keywords), cmp('Albums', K.albums, cur.albums), cmp('Collections', K.collections, cur.collections))) : null,
        h('div.sect', 'Restaurer une partie'),
        h('p.dim', 'Les éléments cochés sont recréés à côté de l’existant (« … (restauré) ») : rien n’est écrasé, et une sauvegarde de sécurité est faite avant. Les photos sont retrouvées par identifiant ou par empreinte.'),
        al.length ? h('details', { open: true }, h('summary', `Albums (${al.length})`), h('div.pick-list', ...al.map(x => x.el))) : null,
        co.length ? h('details', h('summary', `Collections (${co.length})`), h('div.pick-list', ...co.map(x => x.el))) : null,
        docs.length ? h('details', h('summary', `Documents (${docs.length})`), h('div.pick-list', ...docs.map(x => x.el))) : null,
        status),
        actions: [
          h('button.ghost', { onclick: () => m.close() }, 'Fermer'),
          h('button.ghost', { onclick: () => { m.close(); restore(b, pw); } }, 'Tout restaurer…'),
          h('button', { onclick: async () => {
            const sel = l => l.filter(x => x.cb.checked).map(x => x.id);
            const payload = { name: b.name, password: pw, albums: sel(al), collections: sel(co), documents: sel(docs) };
            if (!payload.albums.length && !payload.collections.length && !payload.documents.length) { toast('Cochez au moins un élément', 'bad'); return; }
            mount(status, h('p.dim', 'Restauration…'));
            try {
              const r = await api('/backups/selective', 'POST', payload);
              mount(status, h('div.album-alert.ok', `✓ ${r.albums.length} album(s), ${r.collections.length} collection(s), ${r.documents} document(s) restauré(s). Sauvegarde de sécurité : ${r.safety}`),
                ...r.albums.filter(a => a.found < a.total).map(a => h('div.album-alert.warn', `« ${a.name} » : ${a.total - a.found} photo(s) introuvable(s) dans le catalogue actuel (signalées dans l’album)`)),
                ...r.collections.filter(x => x.missing).map(x => h('div.album-alert.warn', `« ${x.name} » : ${x.missing} photo(s) introuvable(s), non ajoutée(s)`)));
              toast('Restauration sélective faite');
            } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
          } }, 'Restaurer la sélection'),
        ] });
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
    const inst = await api('/install');
    const wrap = h('div');
    const vOut = h('div');
    wrap.appendChild(card(h('div.sect', 'Installation'),
      h('p', inst.installed ? `Version ${inst.version} installée${inst.info?.installedAt ? ' le ' + fmtDateTime(inst.info.installedAt) : ''}${inst.info?.previous ? ` (mise à jour depuis la ${inst.info.previous})` : ''}.` : `Version ${inst.version} lancée depuis son dossier de développement.`),
      table({ columns: [{ label: '', key: 'k' }, { label: '', format: r => h('span', { style: { wordBreak: 'break-all' } }, r.v) }], rows: [
        { k: 'Programme', v: inst.program }, { k: 'Données', v: inst.data }, { k: 'Node.js', v: inst.node },
        { k: 'Signature', v: inst.distributable ? (inst.signedFile ? `distribution signée (clé de l’éditeur ${inst.keyId ?? '?'})` : 'distribution non signée') : 'sans objet (développement)' }] }),
      h('div.row', h('button', { disabled: !inst.distributable, title: inst.distributable ? 'Recalcule l’empreinte de chaque fichier du programme et contrôle la signature' : 'Disponible sur une version installée', onclick: async e => {
        e.target.disabled = true; mount(vOut, h('p.dim', 'Vérification…'));
        try { const r = await api('/install/verify', 'POST'); mount(vOut, h('p', h(r.ok ? 'span.ok' : 'span.bad', r.ok ? `✓ ${fmtNum(r.files)} fichiers conformes${r.signed ? `, signature valide (clé ${r.keyId})` : ', distribution non signée'}.` : '✗ ' + r.error)),
          ...['modified', 'missing', 'added'].flatMap(k => (r[k] ?? []).slice(0, 10).map(f => h('div', h('small.dim', `${{ modified: 'modifié', missing: 'manquant', added: 'ajouté' }[k]} : ${f}`))))); }
        catch (x) { mount(vOut, h('p.bad', x.message)); } finally { e.target.disabled = false; }
      } }, 'Vérifier l’installation')), vOut,
      h('p.dim', 'Mettre à jour : lancez l’installateur de la nouvelle version (Photothèque fermée). Ses fichiers sont vérifiés avec la clé de la version installée ; vos données ne sont pas touchées, et la version précédente est gardée jusqu’à la mise à jour suivante.')));
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
