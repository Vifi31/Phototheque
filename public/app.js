// Contrôleur principal de l'interface Photothèque. Scripts classiques (globaux), aucune dépendance.
// La logique métier vit côté serveur (lib/*.mjs) ; ici on appelle l'API /api/* et on affiche.
'use strict';
const { h, clear, mount, esc, fmtBytes, fmtDate, fmtDateTime, fmtNum, kpi, card, sectionTitle, table, field, toast, modal, confirmDialog, lightboxOpen } = UI;

const App = (() => {
  const state = {
    version: '', stats: {}, scan: {}, import: {},
    view: 'photos', facet: {}, q: '', sort: 'captured_desc',
    page: 0, pageSize: 60, total: 0, rows: [],
    selection: new Set(),
    supports: [], keywords: [], facets: { years: [], cameras: [], formats: [] },
  };

  const api = async (p, method = 'GET', body) => {
    const r = await fetch('/api' + p, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('Erreur ' + r.status));
    return j;
  };

  // ---------- navigation ----------
  const NAV = [
    { group: 'Bibliothèque' },
    { id: 'photos', label: 'Photothèque', icon: '🖼️' },
    { id: 'import', label: 'Importation', icon: '📥' },
    { id: 'supports', label: 'Supports', icon: '💾' },
    { id: 'keywords', label: 'Mots-clés', icon: '🏷️' },
    { id: 'collections', label: 'Collections', icon: '🗂️' },
    { id: 'albums', label: 'Albums', icon: '📖' },
    { group: 'Analyse' },
    { id: 'duplicates', label: 'Doublons', icon: '🧬' },
    { id: 'stats', label: 'Statistiques', icon: '📊' },
    { group: 'Administration' },
    { id: 'admin', label: 'Administration', icon: '⚙️' },
    { id: 'settings', label: 'Paramètres', icon: '🛠️' },
  ];

  function renderNav() {
    const nav = document.getElementById('nav');
    clear(nav);
    for (const item of NAV) {
      if (item.group) { nav.appendChild(h('div.nav-group', item.group)); continue; }
      const active = state.view === item.id || (item.id === 'admin' && state.view.startsWith('admin-'));
      nav.appendChild(h('button.nav-item' + (active ? '.active' : ''), { onclick: () => go(item.id), title: item.label },
        h('span.ico', item.icon), h('span', item.label), badgeFor(item.id)));
    }
  }
  function badgeFor(id) {
    if (id === 'photos' && state.stats.photos) return h('span.badge', fmtNum(state.stats.photos));
    if (id === 'supports' && state.supports.filter(s => s.status === 'absent').length) return h('span.badge', String(state.supports.filter(s => s.status === 'absent').length));
    return null;
  }

  async function go(view) {
    state.view = view; state.selection.clear();
    renderNav();
    const v = document.getElementById('view');
    clear(v); v.appendChild(h('div.loading', 'Chargement…'));
    try {
      if (view === 'photos') await viewPhotos(v);
      else if (view === 'import') await viewImport(v);
      else if (view === 'supports') await viewSupports(v);
      else if (view === 'keywords') await viewKeywords(v);
      else if (view === 'collections') await viewCollections(v);
      else if (view === 'albums') await viewAlbums(v);
      else if (view === 'duplicates') await viewDuplicates(v);
      else if (view === 'stats') await viewStats(v);
      else if (view === 'settings') await viewSettings(v);
      else if (view === 'admin') await Admin.view(v, 'backups', nav => (state._adminNav = nav));
      else if (view.startsWith('admin-')) await Admin.view(v, view.slice(6));
      renderStatus();
    } catch (e) { clear(v); v.appendChild(h('div.empty', h('div.big', '⚠️'), e.message)); }
  }

  function renderStatus() {
    const s = state.stats;
    mount(document.getElementById('statusbar'),
      h('span', `${fmtNum(s.photos ?? 0)} photo(s)`),
      h('span', `${fmtNum(s.files ?? 0)} fichier(s)`),
      h('span', fmtBytes(s.bytes ?? 0)),
      h('span', `${fmtNum(s.keywords ?? 0)} mot(s)-clé(s)`),
      s.missing ? h('span', { style: { color: 'var(--warn)' } }, `${fmtNum(s.missing)} indisponible(s)`) : h('span', 'tous les fichiers présents'),
    );
  }

  // ---------- vue Photothèque (grille + recherche + filtres) ----------
  async function viewPhotos(v) {
    clear(v);
    const facets = await api('/facets'); state.facets = facets;
    // consultation d'une collection : la grille est filtrée par collectionId (voir viewCollections)
    const coll = state.facet.collectionId ? (await api('/collections/' + encodeURIComponent(state.facet.collectionId)).catch(() => ({}))).collection : null;
    if (state.facet.collectionId && !coll) delete state.facet.collectionId;
    const toolbar = h('div.grid-toolbar');
    const filterBar = h('div.row');
    const grid = h('div.grid-photos');
    const info = h('div.dim');

    // filtres
    const sortSel = h('select', { onchange: () => { state.sort = sortSel.value; state.page = 0; refresh(); } },
      ...[['captured_desc', 'Plus récentes'], ['captured_asc', 'Plus anciennes'], ['rating_desc', 'Mieux notées'], ['added_desc', 'Ajoutées récemment'], ['size_desc', 'Plus grandes']].map(([v2, l]) => h('option', { value: v2, selected: state.sort === v2 }, l)));
    const yearSel = h('select', { onchange: () => { state.facet.year = yearSel.value; state.page = 0; refresh(); } },
      h('option', { value: '' }, 'Toutes les années'),
      ...facets.years.map(y => h('option', { value: y.y, selected: state.facet.year === y.y }, `${y.y} (${y.n})`)));
    const camSel = h('select', { onchange: () => { state.facet.camera = camSel.value; state.page = 0; refresh(); } },
      h('option', { value: '' }, 'Tous les appareils'),
      ...facets.cameras.map(c => h('option', { value: c.camera_model, selected: state.facet.camera === c.camera_model }, `${c.camera_model || c.camera_make} (${c.n})`)));
    const fmtSel = h('select', { onchange: () => { state.facet.format = fmtSel.value; state.page = 0; refresh(); } },
      h('option', { value: '' }, 'Tous les formats'),
      ...facets.formats.map(f => h('option', { value: f.format, selected: state.facet.format === f.format }, `${f.format} (${f.n})`)));
    const ratingSel = h('select', { onchange: () => { state.facet.rating = ratingSel.value; state.page = 0; refresh(); } },
      ...[['', 'Toutes notes'], ['1', '★ et +'], ['3', '★★★ et +'], ['5', '★★★★★']].map(([v2, l]) => h('option', { value: v2, selected: state.facet.rating === v2 }, l)));
    const missSel = h('select', { onchange: () => { state.facet.missing = missSel.value; state.page = 0; refresh(); } },
      ...[['', 'Toutes disponibilités'], ['0', 'Présentes'], ['1', 'Indisponibles']].map(([v2, l]) => h('option', { value: v2, selected: state.facet.missing === v2 }, l)));

    mount(filterBar, yearSel, camSel, fmtSel, ratingSel, missSel, h('button.ghost.small', { onclick: () => { state.facet = {}; state.q = ''; document.getElementById('search').value = ''; state.page = 0; go('photos'); } }, 'Réinitialiser'));

    // sélection multiple
    const selInfo = h('span.sel-count');
    const batchBar = h('div.row');
    function refreshSelection() {
      selInfo.textContent = state.selection.size ? `${state.selection.size} sélectionnée(s)` : '';
      clear(batchBar);
      if (state.selection.size) {
        batchBar.append(
          h('button.small', { onclick: batchRate }, 'Noter…'),
          h('button.small.ghost', { onclick: batchKeyword }, 'Mot-clé…'),
          h('button.small.ghost', { onclick: batchCollection }, 'Ajouter à une collection…'),
          coll?.kind === 'static' ? h('button.small.ghost', { onclick: batchUncollect }, 'Retirer de la collection') : null,
          h('button.small.danger', { onclick: batchRemoveIndex }, "Retirer de l'index"),
          h('button.small.ghost', { onclick: () => { state.selection.clear(); renderGrid(); } }, 'Tout désélectionner'),
        );
      }
    }
    // critères courants (texte + filtres), tels qu'enregistrés dans une recherche sauvegardée
    const currentCriteria = () => { const c = { ...state.facet }; delete c.collectionId; if (state.q) c.q = state.q; return Object.fromEntries(Object.entries(c).filter(([, val]) => val !== '' && val != null)); };
    const saveBtn = h('button.ghost.small', { onclick: saveSearch, title: 'Enregistrer le texte et les filtres actuels comme collection dynamique' }, 'Enregistrer la recherche…');
    const refreshSaveBtn = () => { saveBtn.hidden = !!coll || !Object.keys(currentCriteria()).length; };
    mount(toolbar, h('span', { class: 'dim' }, 'Tri :'), sortSel, saveBtn, h('div.spacer'), selInfo, batchBar);

    function renderGrid() {
      clear(grid);
      if (!state.rows.length) { grid.appendChild(h('div.empty', h('div.big', '📷'), 'Aucune photo ne correspond. Indexez un dossier depuis Importation.')); return; }
      state.rows.forEach((p, i) => {
        const cell = h('div.photo-cell' + (state.selection.has(p.id) ? '.selected' : ''), {
          onclick: () => openViewer(i),
        });
        if (p.thumb) cell.appendChild(h('img', { src: p.thumb, loading: 'lazy', alt: p.title || '' }));
        else cell.appendChild(h('div.ph-placeholder', '🖼️'));
        cell.appendChild(h('div.ph-sel', { onclick: e => { e.stopPropagation(); toggleSel(p.id); } }, state.selection.has(p.id) ? '✓' : ''));
        if (p.missing) cell.appendChild(h('div.ph-miss', 'indisponible'));
        if (p.rating) cell.appendChild(h('div.ph-rating', '★'.repeat(p.rating)));
        grid.appendChild(cell);
      });
    }
    function toggleSel(id) { if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id); renderGrid(); refreshSelection(); }
    function openViewer(i) {
      lightboxOpen(state.rows, i, () => {});
    }

    async function refresh() {
      const params = new URLSearchParams({ limit: state.pageSize, offset: state.page * state.pageSize, sort: state.sort });
      if (state.q) params.set('q', state.q);
      for (const [k, val] of Object.entries(state.facet)) if (val) params.set(k, val);
      const r = await api('/photos?' + params.toString());
      state.rows = r.rows; state.total = r.total;
      info.textContent = `${fmtNum(r.total)} photo(s)`;
      renderGrid(); refreshSelection(); renderPager(); refreshSaveBtn();
    }

    const pager = h('div.row');
    function renderPager() {
      const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
      clear(pager);
      pager.append(h('span.dim', `Page ${state.page + 1} / ${pages}`),
        h('button.ghost.small', { disabled: state.page === 0, onclick: () => { state.page--; refresh(); } }, '‹ Précédent'),
        h('button.ghost.small', { disabled: state.page >= pages - 1, onclick: () => { state.page++; refresh(); } }, 'Suivant ›'));
    }

    // actions sur la sélection
    async function batchRate() {
      const input = h('input', { type: 'number', min: 0, max: 5, value: 3 });
      modal({ title: 'Noter la sélection', body: field('Note (0 à 5)', input), actions: [
        h('button.ghost', { onclick: () => UI.modal && document.getElementById('modalRoot').replaceChildren() }, 'Annuler'),
        h('button', { onclick: async () => { for (const id of state.selection) await api('/photos', 'PUT', { id, rating: +input.value }); document.getElementById('modalRoot').replaceChildren(); toast('Note appliquée à ' + state.selection.size + ' photo(s)'); state.selection.clear(); refresh(); } }, 'Appliquer'),
      ] });
    }
    async function batchKeyword() {
      const input = h('input', { type: 'text', placeholder: 'Mot-clé (ex: Vacances)' });
      modal({ title: 'Ajouter un mot-clé à la sélection', body: field('Mot-clé', input), actions: [
        h('button.ghost', { onclick: () => document.getElementById('modalRoot').replaceChildren() }, 'Annuler'),
        h('button', { onclick: async () => { const kw = input.value.trim(); if (!kw) return; for (const id of state.selection) { const d = await api('/photos/' + id); const names = [...(d.photo.keywords || []).map(k => k.name), kw]; await api('/photos', 'PUT', { id, keywords: names }); } document.getElementById('modalRoot').replaceChildren(); toast('Mot-clé ajouté'); state.selection.clear(); refresh(); } }, 'Appliquer'),
      ] });
    }
    async function batchCollection() {
      const { list } = await api('/collections');
      const statics = list.filter(c => c.kind === 'static');
      const sel = h('select', {}, ...statics.map(c => h('option', { value: c.id }, `${c.name} (${c.photo_count})`)), h('option', { value: '' }, '➕ Nouvelle sélection…'));
      const name = h('input', { type: 'text', placeholder: 'Nom de la nouvelle sélection' });
      const nameField = field('Nom', name);
      const sync = () => { nameField.hidden = !!sel.value; };
      sel.addEventListener('change', sync); sync();
      const m = modal({ title: `Ajouter ${state.selection.size} photo(s) à une collection`, body: h('div.form', field('Collection', sel), nameField), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => {
          try {
            const ids = [...state.selection];
            if (sel.value) { const r = await api(`/collections/${encodeURIComponent(sel.value)}/photos`, 'POST', { ids }); toast(`${r.added} photo(s) ajoutée(s) à « ${r.collection.name} »`); }
            else { const r = await api('/collections', 'POST', { name: name.value, kind: 'static', photoIds: ids }); toast(`Sélection « ${r.collection.name} » créée (${r.collection.photo_count} photo(s))`); }
            m.close(); state.selection.clear(); renderGrid(); refreshSelection();
          } catch (e) { toast(e.message, 'bad'); }
        } }, 'Ajouter'),
      ] });
    }
    async function batchUncollect() {
      const r = await api(`/collections/${encodeURIComponent(coll.id)}/photos/remove`, 'POST', { ids: [...state.selection] });
      toast(`${r.removed} photo(s) retirée(s) de « ${coll.name} ». Elles restent dans la photothèque.`); state.selection.clear(); refresh();
    }
    function saveSearch() {
      const query = currentCriteria();
      const name = h('input', { type: 'text', placeholder: 'Ex. : Vacances bien notées' });
      const m = modal({ title: 'Enregistrer la recherche', body: h('div.form', field('Nom', name), h('p.dim', 'Critères : ' + describeQuery(query)), h('p.dim', 'Le contenu se met à jour seul : les photos indexées plus tard y apparaîtront si elles correspondent.')), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => {
          try { const r = await api('/collections', 'POST', { name: name.value, kind: 'dynamic', query }); m.close(); toast(`Recherche « ${r.collection.name} » enregistrée (${r.collection.photo_count} photo(s))`); }
          catch (e) { toast(e.message, 'bad'); }
        } }, 'Enregistrer'),
      ] });
      name.focus();
    }
    async function batchRemoveIndex() {
      const ok2 = await confirmDialog("Retirer de l'index", `${state.selection.size} photo(s) seront retirée(s) de l'index. Les fichiers originaux ne seront JAMAIS supprimés. Continuer ?`);
      if (!ok2) return;
      const r = await api('/photos/remove', 'POST', { ids: [...state.selection] });
      toast(`${r.removed} photo(s) retirée(s). Originaux intacts.`); state.selection.clear(); refresh();
    }

    const title = coll ? h('h2.page-title', `Collection « ${coll.name} »`) : h('h2.page-title', 'Photothèque');
    const collBar = coll ? h('div.row', h('span.dim', coll.kind === 'dynamic' ? 'Recherche enregistrée — ' + describeQuery(coll.query) : 'Sélection'),
      h('button.ghost.small', { onclick: () => { delete state.facet.collectionId; state.page = 0; go('photos'); } }, 'Quitter la collection'),
      h('button.ghost.small', { onclick: () => go('collections') }, 'Toutes les collections')) : null;
    mount(v, title, collBar, filterBar, toolbar, info, grid, pager);
    await refresh();
  }

  // ---------- vue Importation ----------
  async function viewImport(v) {
    clear(v);
    const folders = await api('/folders');
    const pathInput = h('input', { type: 'text', placeholder: 'Chemin absolu du dossier à indexer (ex: E:\\\\Carte SD\\\\DCIM)' });
    const supportSel = h('select', {}, h('option', { value: '' }, 'Sans support'));
    const sup = await api('/supports');
    for (const s of sup.list) supportSel.appendChild(h('option', { value: s.id }, s.name));

    const folderList = h('div');
    function renderFolders(list) {
      clear(folderList);
      if (!list.length) { folderList.appendChild(h('p.dim', 'Aucun dossier indexé pour le moment.')); return; }
      for (const f of list) {
        const item = h('div.folder-item');
        const count = h('span.badge', fmtNum(f.photo_count));
        item.append(h('div.grow', h('div', f.path), h('small.dim', `Indexé : ${f.indexed_at ? fmtDateTime(f.indexed_at) : 'jamais'} · ${f.photo_count} photo(s)`)),
          count,
          h('button.small', { onclick: () => startIndex(f.id, count) }, 'Indexer'),
          h('button.ghost.small', { onclick: async () => { await api('/folders/' + f.id, 'DELETE'); renderFolders((await api('/folders')).list); } }, 'Retirer'));
        folderList.appendChild(item);
      }
    }
    async function startIndex(fid, countEl) {
      const { jobId } = await api(`/folders/${fid}/index`, 'POST');
      toast('Indexation lancée (sans copie des originaux)…');
      const poll = setInterval(async () => {
        try {
          const { job } = await api('/jobs/' + jobId);
          if (job.total) countEl.textContent = `${job.done}/${job.total}`;
          if (job.status !== 'running') {
            clearInterval(poll);
            if (job.status === 'done') { toast(`Indexation terminée : ${job.result.added} ajoutée(s), ${job.result.errors} erreur(s)`); state.stats = (await api('/stats')); renderFolders((await api('/folders')).list); renderNav(); }
            else toast(job.error || 'Indexation en erreur', 'bad');
          }
        } catch { clearInterval(poll); }
      }, 500);
    }

    mount(v,
      h('h2.page-title', 'Importation'),
      card(h('div.sect', 'Ajouter et indexer un dossier (sans copie)'),
        h('p.dim', "L'indexation lit les fichiers, extrait les métadonnées et génère les vignettes. Vos originaux ne sont ni copiés, ni modifiés, ni déplacés."),
        h('div.form',
          field('Chemin du dossier', pathInput),
          field('Support rattaché', supportSel),
          h('div.field', h('label', ' '), h('button', { onclick: addFolder }, 'Ajouter le dossier')),
        )),
      card(h('div.sect', 'Dossiers indexés'), folderList),
      card(h('div.sect', 'Importer des fichiers (copie vers la bibliothèque)'),
        h('p.dim', "Transfère physiquement des fichiers vers le dossier d'import, avec détection de doublons (empreinte) et renommage en cas de collision. La source n'est jamais supprimée."),
        h('div.form', field('Fichiers source (séparés par ;)', h('input#importSources', { type: 'text', placeholder: 'E:\\\\photo1.jpg ; E:\\\\photo2.jpg' })),
          h('div.field', h('label', ' '), h('button', { onclick: doImport }, 'Importer (copie)'))),
      ),
    );
    renderFolders(folders.list);

    async function addFolder() {
      const p = pathInput.value.trim(); if (!p) return toast('Chemin manquant', 'warn');
      try { await api('/folders', 'POST', { path: p, supportId: supportSel.value || null }); toast('Dossier ajouté'); pathInput.value = ''; renderFolders((await api('/folders')).list); }
      catch (e) { toast(e.message, 'bad'); }
    }
    async function doImport() {
      const sources = document.getElementById('importSources').value.split(';').map(s => s.trim()).filter(Boolean);
      if (!sources.length) return toast('Indiquez au moins un fichier source', 'warn');
      const r = await api('/import', 'POST', { sources });
      toast(`Import : ${r.copied} copiée(s), ${r.duplicates} doublon(s), ${r.errors} erreur(s)`);
      state.stats = await api('/stats'); renderNav();
    }
  }

  // ---------- vue Supports ----------
  async function viewSupports(v) {
    clear(v);
    const wrap = h('div');
    async function refresh() {
      const { list, stats } = await api('/supports');
      state.supports = list; renderNav();
      clear(wrap);
      if (!list.length) wrap.appendChild(h('p.dim', 'Aucun support enregistré. Ajoutez un disque, une carte mémoire ou un NAS pour suivre vos originaux.'));
      for (const s of list) {
        wrap.appendChild(h('div.support-card',
          h('div', { style: { fontSize: '24px' } }, s.status === 'available' ? '🟢' : s.status === 'absent' ? '🔴' : '⚪'),
          h('div.grow', h('b', s.name), h('div.dim', `${s.mount_path || '—'} · ${s.kind} · rôle ${s.role}`),
            h('small.dim', `Statut : ${s.status === 'available' ? 'disponible' : s.status === 'absent' ? 'absent (déconnecté)' : 'inconnu'}${s.drive_label ? ' · ' + s.drive_label : ''}`)),
          h('div.row-actions',
            h('button.ghost.small', { onclick: () => editSupport(s) }, 'Modifier'),
            h('button.ghost.small', { onclick: async () => { const r = await api('/support/refresh' in {} ? '/supports/refresh' : '/supports/refresh', 'POST'); toast('Supports rafraîchis'); refresh(); } }, 'Actualiser'),
            h('button.danger.small', { onclick: async () => { if (await confirmDialog('Retirer le support', `Retirer « ${s.name} » de l'inventaire ? Les fichiers ne sont pas supprimés.`)) { await api('/supports/' + s.id, 'DELETE'); refresh(); } } }, 'Retirer'))));
      }
      mount(v, h('h2.page-title', 'Supports'),
        card(h('div.sect', 'Inventaire des supports de stockage'),
          h('p.dim', 'Un support absent (déconnecté) rend ses photos « indisponibles », jamais supprimées. La reconnexion est détectée par empreinte.'),
          h('div.kpis', kpi('Supports', stats.total), kpi('Disponibles', stats.available, { tone: 'ok' }), kpi('Absents', stats.absent, { tone: 'warn' })),
          h('div.spacer'), wrap),
        card(h('div.sect', 'Ajouter un support'), addForm()));
    }
    function addForm() {
      const name = h('input', { type: 'text', placeholder: 'Nom (ex: Carte SD Nikon)' });
      const path = h('input', { type: 'text', placeholder: 'Chemin monté (ex: E:\\\\)' });
      const kind = h('select', {}, ...Object.entries(supKinds).map(([k, l]) => h('option', { value: k }, l)));
      const role = h('select', {}, ...Object.entries(supRoles).map(([k, l]) => h('option', { value: k }, l)));
      return h('div.form', field('Nom', name), field('Chemin', path), field('Type', kind), field('Rôle', role),
        h('div.field', h('label', ' '), h('button', { onclick: async () => { try { await api('/supports', 'POST', { name: name.value, mount_path: path.value, kind: kind.value, role: role.value }); toast('Support ajouté'); refresh(); } catch (e) { toast(e.message, 'bad'); } } }, 'Ajouter')));
    }
    function editSupport(s) {
      const name = h('input', { type: 'text', value: s.name });
      const path = h('input', { type: 'text', value: s.mount_path || '' });
      const loc = h('input', { type: 'text', value: s.location || '' });
      modal({ title: 'Modifier le support', body: h('div.form', field('Nom', name), field('Chemin', path), field('Emplacement physique', loc)), actions: [
        h('button.ghost', { onclick: () => document.getElementById('modalRoot').replaceChildren() }, 'Annuler'),
        h('button', { onclick: async () => { await api('/supports/' + s.id, 'PUT', { name: name.value, mount_path: path.value, location: loc.value }); document.getElementById('modalRoot').replaceChildren(); toast('Support modifié'); refresh(); } }, 'Enregistrer'),
      ] });
    }
    await refresh();
  }
  let supKinds = {}, supRoles = {};

  // ---------- vue Mots-clés ----------
  async function viewKeywords(v) {
    clear(v);
    const wrap = h('div');
    async function refresh() {
      const { list } = await api('/keywords');
      state.keywords = list;
      clear(wrap);
      if (!list.length) wrap.appendChild(h('p.dim', 'Aucun mot-clé. Créez-en depuis une photo ou ajoutez-en ci-dessous.'));
      const t = table({ columns: [
        { label: 'Mot-clé', format: r => h('b', r.name) },
        { label: 'Photos', key: 'photo_count', align: 'right' },
        { label: 'Créé', format: r => fmtDate(r.created_at) },
        { label: '', align: 'right', format: r => h('div.row-actions',
          h('button.ghost.small', { onclick: () => App.searchKeyword(r) }, 'Voir'),
          h('button.ghost.small', { onclick: () => renameKw(r) }, 'Renommer'),
          h('button.danger.small', { onclick: async () => { if (await confirmDialog('Supprimer le mot-clé', `Supprimer « ${r.name} » et ses affectations ?`)) { await api('/keywords/' + r.id, 'DELETE'); refresh(); } } }, 'Supprimer')) },
      ], rows: list });
      wrap.appendChild(t);
    }
    const newName = h('input', { type: 'text', placeholder: 'Nouveau mot-clé' });
    function renameKw(r) {
      const input = h('input', { type: 'text', value: r.name });
      modal({ title: 'Renommer', body: field('Nom', input), actions: [
        h('button.ghost', { onclick: () => document.getElementById('modalRoot').replaceChildren() }, 'Annuler'),
        h('button', { onclick: async () => { await api('/keywords/' + r.id, 'PUT', { name: input.value }); document.getElementById('modalRoot').replaceChildren(); refresh(); } }, 'Enregistrer'),
      ] });
    }
    mount(v, h('h2.page-title', 'Mots-clés'),
      card(h('div.sect', 'Ajouter un mot-clé'), h('div.form', field('Nom', newName), h('div.field', h('label', ' '), h('button', { onclick: async () => { if (!newName.value.trim()) return; await api('/keywords', 'POST', { name: newName.value.trim() }); newName.value = ''; refresh(); } }, 'Créer')))),
      card(h('div.sect', 'Tous les mots-clés'), wrap));
    await refresh();
  }

  // ---------- vues simples (Collections, Albums, Doublons) ----------
  async function viewCollections(v) {
    clear(v);
    const wrap = h('div');
    async function refresh() {
      const { list, kinds } = await api('/collections');
      if (!state.keywords.length) state.keywords = (await api('/keywords')).list; // noms des mots-clés dans les critères
      clear(wrap);
      if (!list.length) { wrap.appendChild(h('p.dim', 'Aucune collection. Créez une sélection ci-dessous, ou depuis la Photothèque : sélectionnez des photos puis « Ajouter à une collection… », ou cherchez puis « Enregistrer la recherche… ».')); return; }
      wrap.appendChild(table({ columns: [
        { label: 'Collection', format: r => h('div', h('b', r.name), r.kind === 'dynamic' ? h('div', h('small.dim', describeQuery(r.query))) : null) },
        { label: 'Type', format: r => kinds[r.kind] ?? r.kind },
        { label: 'Photos', key: 'photo_count', align: 'right' },
        { label: 'Modifiée', format: r => fmtDate(r.updated_at) },
        { label: '', align: 'right', format: r => h('div.row-actions',
          h('button.ghost.small', { onclick: () => openCollection(r) }, 'Voir'),
          h('button.ghost.small', { onclick: () => renameColl(r) }, 'Renommer'),
          h('button.danger.small', { onclick: async () => { if (await confirmDialog('Supprimer la collection', `Supprimer « ${r.name} » ? Les photos restent dans la photothèque ; seule la collection disparaît.`)) { await api('/collections/' + encodeURIComponent(r.id), 'DELETE'); toast('Collection supprimée (photos conservées)'); refresh(); } } }, 'Supprimer')) },
      ], rows: list }));
    }
    function renameColl(r) {
      const input = h('input', { type: 'text', value: r.name });
      const m = modal({ title: 'Renommer la collection', body: field('Nom', input), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => { try { await api('/collections/' + encodeURIComponent(r.id), 'PUT', { name: input.value }); m.close(); refresh(); } catch (e) { toast(e.message, 'bad'); } } }, 'Enregistrer'),
      ] });
    }
    const newName = h('input', { type: 'text', placeholder: 'Nom de la sélection' });
    const create = async () => { try { await api('/collections', 'POST', { name: newName.value, kind: 'static' }); newName.value = ''; refresh(); } catch (e) { toast(e.message, 'bad'); } };
    mount(v, h('h2.page-title', 'Collections'),
      card(h('div.sect', 'Nouvelle sélection'),
        h('p.dim', 'Une sélection contient les photos que vous y ajoutez (depuis la Photothèque). Une recherche enregistrée se crée depuis la Photothèque et se met à jour seule.'),
        h('div.form', field('Nom', newName), h('div.field', h('label', ' '), h('button', { onclick: create }, 'Créer')))),
      card(h('div.sect', 'Sélections et recherches enregistrées'), wrap));
    await refresh();
  }
  function openCollection(c) { state.q = ''; document.getElementById('search').value = ''; state.facet = { collectionId: c.id }; state.page = 0; go('photos'); }

  // Résumé lisible des critères d'une recherche enregistrée (mêmes clés que lib/search.mjs).
  const CRITERIA = {
    q: 'texte', anyText: 'un des textes', excludeText: 'sans le texte', keywords: 'mots-clés', anyKeywords: 'un des mots-clés', excludeKeywords: 'sans les mots-clés',
    keywordId: 'mot-clé', year: 'année', from: 'depuis', to: "jusqu'au", camera: 'appareil', lens: 'objectif', author: 'auteur', format: 'format',
    rating: 'note ≥', color: 'couleur', missing: 'disponibilité', orientation: 'orientation', minWidth: 'largeur ≥', maxWidth: 'largeur ≤', minHeight: 'hauteur ≥', maxHeight: 'hauteur ≤',
    supportId: 'support', folderId: 'dossier', albumId: 'album', integrity: 'intégrité', hasGps: 'GPS',
    noKeyword: 'sans mot-clé', hasKeyword: 'avec mot-clé', hasCaption: 'avec légende', noCaption: 'sans légende', duplicate: 'doublons',
  };
  function describeQuery(q) {
    const kwName = id => state.keywords.find(k => k.id === id)?.name ?? id;
    const parts = Object.entries(q ?? {}).filter(([k]) => CRITERIA[k]).map(([k, val]) => {
      if (val === true) return CRITERIA[k];
      if (k === 'missing') return +val ? 'indisponibles' : 'présentes';
      if (k === 'hasGps') return val ? 'avec GPS' : 'sans GPS';
      if (k === 'keywordId') return `${CRITERIA[k]} « ${kwName(val)} »`;
      return `${CRITERIA[k]} « ${[].concat(val).join(', ')} »`;
    });
    return parts.length ? parts.join(' · ') : 'aucun critère';
  }
  async function viewAlbums(v) {
    clear(v);
    mount(v, h('h2.page-title', 'Albums'),
      card(h('div.sect', 'Albums et mises en page'),
        h('p.dim', 'La création d\'albums avec mises en page (formats portrait/paysage, gabarits) est planifiée pour l\'étape 4.'),
        h('div.warnbox', 'Fonctionnalité planifiée (étape 4) — non implémentée dans ce socle.')));
  }
  async function viewDuplicates(v) {
    clear(v);
    // doublons exacts par empreinte
    const dups = await api('/photos?limit=1'); // juste pour la stats
    // interrogation directe via une recherche dédiée : on liste les empreintes partagées
    const body = h('div');
    // On interroge le serveur via /api/db n'est pas adapté ; on passe par une recherche par empreinte.
    // Pour ce socle, on affiche les photos groupées par empreinte via /api/photos + regroupement côté client (limité).
    mount(v, h('h2.page-title', 'Doublons'),
      card(h('div.sect', 'Doublons exacts (empreinte SHA-256)'),
        h('p.dim', "L'indexation détecte les fichiers de contenu identique (même empreinte) et les rattache à la même fiche photo. Un outil dédié de listage/groupement sera affiné à l'étape 3."),
        body));
    void dups;
  }

  // ---------- vue Statistiques ----------
  async function viewStats(v) {
    clear(v);
    const s = await api('/stats');
    const facets = await api('/facets');
    mount(v, h('h2.page-title', 'Statistiques'),
      h('div.kpis',
        kpi('Photos', fmtNum(s.photos)),
        kpi('Fichiers', fmtNum(s.files)),
        kpi('Volume', fmtBytes(s.bytes)),
        kpi('Mots-clés', fmtNum(s.keywords)),
        kpi('Albums', fmtNum(s.albums)),
        kpi('Avec GPS', fmtNum(s.gps)),
        kpi('Notées', fmtNum(s.rated)),
        kpi('Indisponibles', fmtNum(s.missing), { tone: s.missing ? 'warn' : '' })),
      card(h('div.sect', 'Répartition par année'),
        facets.years.length ? table({ columns: [{ label: 'Année', key: 'y' }, { label: 'Photos', key: 'n', align: 'right' }], rows: facets.years }) : h('p.dim', 'Aucune donnée.')),
      card(h('div.sect', 'Appareils utilisés'),
        facets.cameras.length ? table({ columns: [{ label: 'Marque', key: 'camera_make' }, { label: 'Modèle', key: 'camera_model' }, { label: 'Photos', key: 'n', align: 'right' }], rows: facets.cameras }) : h('p.dim', 'Aucune donnée.')),
      card(h('div.sect', 'Formats'),
        facets.formats.length ? table({ columns: [{ label: 'Format', key: 'format' }, { label: 'Photos', key: 'n', align: 'right' }], rows: facets.formats }) : h('p.dim', 'Aucune donnée.')));
  }

  // ---------- vue Paramètres ----------
  async function viewSettings(v) {
    clear(v);
    const scan = { ...state.scan };
    const thumbSize = h('input', { type: 'number', value: scan.thumbSize ?? 320 });
    const previewSize = h('input', { type: 'number', value: scan.previewSize ?? 1600 });
    const hashCb = h('input', { type: 'checkbox', checked: scan.hash !== false });
    const thumbCb = h('input', { type: 'checkbox', checked: scan.thumb !== false });
    const symCb = h('input', { type: 'checkbox', checked: !!scan.followSymlinks });
    const destInput = h('input', { type: 'text', value: state.import.dest || '', placeholder: 'Dossier de destination des imports copiés' });
    const keepCb = h('input', { type: 'checkbox', checked: state.import.keepFolders !== false });

    mount(v, h('h2.page-title', 'Paramètres'),
      card(h('div.sect', "Indexation"),
        h('div.form',
          field('Taille vignette (px)', thumbSize),
          field('Taille aperçu (px)', previewSize),
          h('label.check', hashCb, h('span', 'Calculer les empreintes SHA-256 (détection de doublons)')),
          h('label.check', thumbCb, h('span', 'Générer les vignettes')),
          h('label.check', symCb, h('span', 'Suivre les liens symboliques')))),
      card(h('div.sect', 'Importation'),
        h('div.form', field('Dossier de destination', destInput), h('label.check', keepCb, h('span', 'Classer par année de prise de vue')))),
      h('div.row', h('button', { onclick: save }, 'Enregistrer les paramètres')));

    async function save() {
      const r = await api('/settings', 'PUT', {
        scan: { thumbSize: +thumbSize.value, previewSize: +previewSize.value, hash: hashCb.checked, thumb: thumbCb.checked, followSymlinks: symCb.checked },
        import: { dest: destInput.value, keepFolders: keepCb.checked },
      });
      state.scan = r.scan; state.import = r.import; toast('Paramètres enregistrés');
    }
  }

  // ---------- recherche ----------
  function searchKeyword(k) { state.q = ''; state.facet = { keywordId: k.id }; go('photos'); }
  function setQuery(q) { state.q = q; state.page = 0; if (state.view !== 'photos') go('photos'); else refreshSearch(); }
  async function refreshSearch() { const v = document.getElementById('view'); clear(v); await viewPhotos(v); }

  // ---------- amorçage ----------
  async function boot() {
    // thème sombre par défaut
    document.documentElement.setAttribute('data-theme', 'dark');
    const st = await api('/state');
    state.version = st.version; state.scan = st.scan; state.import = st.import; state.stats = st.stats;
    supKinds = st.supportKinds; supRoles = st.supportRoles;
    document.getElementById('sidebarFoot').appendChild(h('small', `v${st.version}`));
    // recherche
    const searchEl = document.getElementById('search');
    let tId; searchEl.addEventListener('input', () => { clearTimeout(tId); tId = setTimeout(() => setQuery(searchEl.value.trim()), 300); });
    // menu admin
    document.getElementById('topbarActions').appendChild(h('button.ghost.small', { onclick: () => go('admin') }, 'Administration'));
    renderNav(); await go('photos');
  }

  return { boot, go, api, searchKeyword, state, refreshNav: renderNav };
})();

document.addEventListener('DOMContentLoaded', () => App.boot().catch(e => toast('Erreur : ' + e.message, 'bad')));
