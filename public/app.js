// Contrôleur principal de l'interface Photothèque. Scripts classiques (globaux), aucune dépendance.
// La logique métier vit côté serveur (lib/*.mjs) ; ici on appelle l'API /api/* et on affiche.
'use strict';
const { h, clear, mount, esc, fmtBytes, fmtDate, fmtDateTime, fmtNum, kpi, card, sectionTitle, table, field, toast, modal, confirmDialog, lightboxOpen, lightboxClose } = UI;

const App = (() => {
  const state = {
    version: '', stats: {}, scan: {}, import: {},
    view: 'photos', facet: {}, q: '', sort: 'captured_desc',
    page: 0, pageSize: 60, total: 0, rows: [],
    // variantes désignées dans l'outil Doublons : 'hide' (défaut) | 'show' | 'only' — préférence d'affichage locale
    variants: (() => { try { return localStorage.getItem('phototheque.variants') || 'hide'; } catch { return 'hide'; } })(),
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
      const active = state.view === item.id || (item.id === 'admin' && state.view.startsWith('admin-')) || (item.id === 'albums' && state.view === 'album') || (item.id === 'photos' && state.view === 'retouche');
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
      else if (view === 'album') await viewAlbum(v);
      else if (view === 'retouche') await viewRetouche(v);
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

    // recherche avancée : critères ET / OU / NON et filtres fins (mêmes clés que lib/search.mjs)
    const advanced = advancedPanel(() => { state.page = 0; refresh(); });

    // variantes (outil Doublons) : préférence d'affichage, hors critères enregistrés ; sans effet dans une collection
    // (une sélection montre ce qu'on y a mis) ni pendant « référence et variantes »
    const varSel = h('select', { title: 'Variantes désignées dans l’outil Doublons (rien n’est supprimé)', onchange: () => {
      state.variants = varSel.value; try { localStorage.setItem('phototheque.variants', state.variants); } catch {}
      state.page = 0; refresh(); } },
      ...[['hide', 'Masquer les variantes'], ['show', 'Afficher les variantes'], ['only', 'Seulement les variantes']].map(([v2, l]) => h('option', { value: v2, selected: state.variants === v2 }, l)));
    varSel.hidden = !!coll;
    mount(filterBar, yearSel, camSel, fmtSel, ratingSel, missSel, varSel, h('button.ghost.small', { onclick: () => { state.facet = {}; state.q = ''; document.getElementById('search').value = ''; state.page = 0; go('photos'); } }, 'Réinitialiser'));

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
          h('button.small.ghost', { onclick: batchAlbum }, 'Ajouter à un album…'),
          h('button.small.ghost', { onclick: () => exportDialog([...state.selection]) }, 'Exporter…'),
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
    // planche-contact : la sélection si elle existe, sinon toutes les photos de la recherche affichée
    const sheetBtn = h('button.ghost.small', { title: 'Planche-contact ou fiches détaillées en PDF, catalogue CSV : la sélection, ou toutes les photos affichées par la recherche', onclick: () => {
      const label = coll ? coll.name : state.facet.variantsOf ? 'Référence et variantes' : 'Photothèque';
      if (state.selection.size) contactSheetDialog({ ids: [...state.selection], label, count: state.selection.size });
      else contactSheetDialog({ query: searchParams().toString(), label, count: state.total });
    } }, 'Planche-contact, fiches, CSV…');
    mount(toolbar, h('span', { class: 'dim' }, 'Tri :'), sortSel, saveBtn, sheetBtn, h('div.spacer'), selInfo, batchBar);

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
        if (p.edits) cell.appendChild(h('div.ph-edit', { title: `${p.edits} version(s) retouchée(s)` }, '✎'));
        if (p.variants) cell.appendChild(h('div.ph-variants', { title: `Photo de référence : ${p.variants} variante(s) conservée(s). Cliquer pour les voir.`,
          onclick: e => { e.stopPropagation(); showVariants(p.id); } }, `⧉ ${p.variants}`));
        else if (p.variantOf) cell.appendChild(h('div.ph-variants.is-variant', { title: 'Variante d’une autre photo (outil Doublons). Cliquer pour voir la référence et ses variantes.',
          onclick: e => { e.stopPropagation(); showVariants(p.variantOf); } }, 'variante'));
        grid.appendChild(cell);
      });
    }
    function showVariants(refId) { state.facet = { variantsOf: refId }; state.q = ''; document.getElementById('search').value = ''; state.page = 0; go('photos'); }
    function toggleSel(id) { if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id); renderGrid(); refreshSelection(); }
    function openViewer(i) {
      lightboxOpen(state.rows, i, () => {}, p => [
        h('button.small', { onclick: () => { lightboxClose(); openRetouche(p.id); } }, '✎ Retoucher'),
        h('button.small.ghost', { onclick: () => { lightboxClose(); exportDialog([p.id]); } }, 'Exporter…')]);
    }

    // critères de la grille (texte, filtres, tri, variantes), sans la pagination : servent aussi à la planche-contact
    function searchParams() {
      const params = new URLSearchParams({ sort: state.sort });
      if (state.q) params.set('q', state.q);
      for (const [k, val] of Object.entries(state.facet)) if (val) params.set(k, val);
      if (!coll && !state.facet.variantsOf) { if (state.variants === 'hide') params.set('hideVariants', 'true'); else if (state.variants === 'only') params.set('variants', 'true'); }
      return params;
    }
    async function refresh() {
      const params = searchParams();
      params.set('limit', state.pageSize); params.set('offset', state.page * state.pageSize);
      const r = await api('/photos?' + params.toString());
      state.rows = r.rows; state.total = r.total;
      info.textContent = `${fmtNum(r.total)} photo(s)` + (r.hiddenVariants ? ` · ${fmtNum(r.hiddenVariants)} variante(s) masquée(s)` : '');
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
    async function batchAlbum() {
      await loadAlbumMeta();
      const { list } = await api('/albums');
      const sel = h('select', {}, ...list.map(a => h('option', { value: a.id }, `${a.name} (${a.pageCount} p.)`)), h('option', { value: '' }, '➕ Nouvel album…'));
      const name = h('input', { type: 'text', placeholder: "Nom du nouvel album" });
      const fmt = formatFields();
      const fresh = h('div', field('Nom', name), fmt.el);
      const lay = layoutSelect('quatre', { withTitle: false });
      const sync = () => { fresh.hidden = !!sel.value; };
      sel.addEventListener('change', sync); sync();
      const ids = [...state.selection]; // ordre de sélection
      const m = modal({ title: `Placer ${ids.length} photo(s) dans un album`, body: h('div', field('Album', sel), fresh, field('Gabarit des nouvelles pages', lay),
        h('p.dim', "Les photos sont placées dans l'ordre de sélection, sur de nouvelles pages ajoutées à la fin. Aucun original n'est copié.")), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => {
          try {
            const albumId = sel.value || (await api('/albums', 'POST', { name: name.value, ...fmt.value() })).album.id;
            const r = await api(`/albums/${encodeURIComponent(albumId)}/fill`, 'POST', { photoIds: ids, layout: lay.value });
            m.close(); state.selection.clear();
            toast(`${r.added} photo(s) placée(s) dans « ${r.album.name} » (${r.pagesAdded} page(s))`);
            openAlbum(albumId);
          } catch (e) { toast(e.message, 'bad'); }
        } }, 'Placer'),
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
    const varBar = state.facet.variantsOf ? h('div.row', h('span.dim', 'Photo de référence et ses variantes (outil Doublons) — rien n’est supprimé'),
      h('button.ghost.small', { onclick: () => { delete state.facet.variantsOf; state.page = 0; go('photos'); } }, 'Revenir à la Photothèque'),
      h('button.ghost.small', { onclick: () => go('duplicates') }, 'Ouvrir l’outil Doublons')) : null;
    mount(v, title, collBar, varBar, filterBar, advanced, toolbar, info, grid, pager);
    await refresh();
  }

  // ---------- recherche avancée (panneau repliable de la Photothèque) ----------
  // Chaque contrôle écrit une clé de state.facet ; refresh() la transmet telle quelle à /api/photos,
  // et « Enregistrer la recherche… » l'emporte dans les critères de la collection.
  const ADV_KEYS = ['anyText', 'excludeText', 'keywords', 'anyKeywords', 'excludeKeywords', 'hasKeyword', 'noKeyword', 'hasCaption', 'noCaption',
    'orientation', 'hasGps', 'from', 'to', 'minWidth', 'minHeight', 'lens', 'author', 'duplicate'];
  function advancedPanel(onApply) {
    const f = state.facet;
    const text = (key, placeholder) => h('input', { type: 'text', value: f[key] ?? '', placeholder, dataset: { key } });
    const num = key => h('input', { type: 'number', min: 0, step: 100, value: f[key] ?? '', placeholder: 'px', dataset: { key } });
    const date = key => h('input', { type: 'date', value: (f[key] ?? '').slice(0, 10), dataset: { key } });
    const choice = (options, current) => h('select', {}, ...options.map(([val, label]) => h('option', { value: val, selected: current === val }, label)));
    const LIST = 'séparés par des virgules';

    const inputs = [
      text('anyText', LIST), text('excludeText', LIST),
      text('keywords', LIST), text('anyKeywords', LIST), text('excludeKeywords', LIST),
      text('lens', 'ex. : 50mm'), text('author', 'nom du photographe'),
      date('from'), date('to'), num('minWidth'), num('minHeight'),
    ];
    const byKey = Object.fromEntries(inputs.map(i => [i.dataset.key, i]));
    const kwSel = choice([['', 'Indifférent'], ['hasKeyword', 'Avec au moins un mot-clé'], ['noKeyword', 'Sans aucun mot-clé']], f.hasKeyword ? 'hasKeyword' : f.noKeyword ? 'noKeyword' : '');
    const capSel = choice([['', 'Indifférent'], ['hasCaption', 'Avec légende'], ['noCaption', 'Sans légende']], f.hasCaption ? 'hasCaption' : f.noCaption ? 'noCaption' : '');
    const oriSel = choice([['', 'Toutes'], ['landscape', 'Paysage'], ['portrait', 'Portrait'], ['square', 'Carré']], f.orientation ?? '');
    const gpsSel = choice([['', 'Indifférent'], ['1', 'Avec position GPS'], ['0', 'Sans position GPS']], f.hasGps ?? '');
    const dupSel = choice([['', 'Indifférent'], ['true', 'Seulement les doublons']], f.duplicate ? 'true' : '');

    const active = () => ADV_KEYS.filter(k => f[k] != null && f[k] !== '').length;
    const count = h('span.badge');
    const showCount = () => { const n = active(); count.textContent = n ? String(n) : ''; count.hidden = !n; };

    function apply() {
      for (const k of ADV_KEYS) delete f[k];
      for (const [k, el] of Object.entries(byKey)) {
        let val = el.value.trim();
        if (!val) continue;
        if (k === 'to') val += 'T23:59:59'; // la date de fin inclut toute la journée
        f[k] = val;
      }
      if (kwSel.value) f[kwSel.value] = 'true';
      if (capSel.value) f[capSel.value] = 'true';
      if (oriSel.value) f.orientation = oriSel.value;
      if (gpsSel.value) f.hasGps = gpsSel.value;
      if (dupSel.value) f.duplicate = 'true';
      showCount(); onApply();
    }
    function reset() {
      for (const el of inputs) el.value = '';
      for (const s of [kwSel, capSel, oriSel, gpsSel, dupSel]) s.value = '';
      apply();
    }
    for (const el of inputs) el.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
    showCount();

    const group = (label, ...fields) => h('div.adv-group', h('div.adv-label', label), h('div.form', ...fields));
    return h('details.card.adv', { open: state.advOpen || null, ontoggle: e => { state.advOpen = e.target.open; } },
      h('summary', 'Recherche avancée ', count),
      group('Texte (titre, légende, notes, mots-clés, appareil)',
        field('Au moins un de ces mots', byKey.anyText), field('Aucun de ces mots', byKey.excludeText)),
      group('Mots-clés',
        field('Tous ces mots-clés', byKey.keywords), field('Au moins un de ces mots-clés', byKey.anyKeywords),
        field('Aucun de ces mots-clés', byKey.excludeKeywords), field('Présence', kwSel)),
      group('Prise de vue',
        field('Du', byKey.from), field('Au', byKey.to), field('Objectif', byKey.lens), field('Auteur', byKey.author)),
      group('Image',
        field('Orientation', oriSel), field('Largeur minimale', byKey.minWidth), field('Hauteur minimale', byKey.minHeight),
        field('Légende', capSel), field('GPS', gpsSel), field('Fichiers en double', dupSel, 'même contenu à plusieurs endroits')),
      h('div.row', h('div.spacer'), h('button.ghost.small', { onclick: reset }, 'Effacer ces critères'), h('button.small', { onclick: apply }, 'Rechercher')),
      h('p.dim.adv-hint', 'Le texte de la barre du haut exige tous ses mots ; il se combine avec ces critères. Les listes se séparent par des virgules.'));
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
    hideVariants: 'sans les variantes', variants: 'seulement les variantes', variantsOf: 'référence et variantes de',
  };
  function describeQuery(q) {
    const kwName = id => state.keywords.find(k => k.id === id)?.name ?? id;
    const parts = Object.entries(q ?? {}).filter(([k]) => CRITERIA[k]).map(([k, val]) => {
      if (val === true) return CRITERIA[k];
      if (k === 'missing') return +val ? 'indisponibles' : 'présentes';
      if (k === 'hasGps') return [false, 0, '0', 'false'].includes(val) ? 'sans GPS' : 'avec GPS';
      if (k === 'keywordId') return `${CRITERIA[k]} « ${kwName(val)} »`;
      if (k === 'from' || k === 'to') return `${CRITERIA[k]} ${fmtDate(String(val).slice(0, 10))}`;
      if (k === 'orientation') return { landscape: 'paysage', portrait: 'portrait', square: 'carré' }[val] ?? val;
      return `${CRITERIA[k]} « ${[].concat(val).join(', ')} »`;
    });
    return parts.length ? parts.join(' · ') : 'aucun critère';
  }
  // ---------- Retouche non destructive (réglages enregistrés à part : lib/edits.mjs) ----------
  function openRetouche(photoId) { state.editPhotoId = photoId; state.editBack = state.view === 'retouche' ? state.editBack : state.view; go('retouche'); }

  async function viewRetouche(v) {
    const pid = state.editPhotoId, enc = encodeURIComponent(pid);
    const photo = (await api('/photos/' + enc)).photo;
    let meta = await api(`/photos/${enc}/edits`);
    const F = meta.fields, neutral = { ...meta.defaults };
    let versions = meta.versions;
    let cur = versions.find(x => x.is_default) ?? versions[0] ?? null; // null : original, aucune version encore
    let params = { ...(cur?.params ?? neutral) };
    let cropMode = false, cropBox = null, ratio = 'free';
    const fileName = photo.files?.[0]?.file_name || photo.title || 'Photo';

    // ---- aperçu (rendu par le serveur, mis en cache) ----
    const img = h('img.rt-img', { alt: '' });
    const overlay = h('div.rt-crop', { hidden: true });
    const stage = h('div.rt-stage', h('div.rt-frame', img, overlay));
    const busy = h('div.rt-busy', { hidden: true }, 'Rendu…');
    let seq = 0, timer = null;
    const renderUrl = (prm, noCrop) => `/api/photos/${enc}/render?size=1400${noCrop ? '&nocrop=1' : ''}&params=${encodeURIComponent(JSON.stringify(prm))}`;
    function refreshPreview(delay = 120) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const n = ++seq, url = renderUrl(params, cropMode), pre = new Image();
        busy.hidden = false;
        pre.onload = () => { if (n !== seq) return; img.src = url; busy.hidden = true; if (cropMode) drawCrop(); };
        pre.onerror = () => { if (n === seq) { busy.hidden = true; toast('Rendu impossible pour cette photo', 'bad'); } };
        pre.src = url;
      }, delay);
    }
    // avant / après : l'original (aperçu non retouché) tant que le bouton est enfoncé
    const beforeBtn = h('button.ghost.small', { title: 'Maintenir pour voir l’original' }, '◐ Avant / après');
    const showBefore = on => { img.src = on ? renderUrl(neutral, false) : renderUrl(params, cropMode); };
    beforeBtn.addEventListener('pointerdown', () => showBefore(true));
    for (const ev of ['pointerup', 'pointerleave']) beforeBtn.addEventListener(ev, () => showBefore(false));

    // ---- enregistrement : chaque modification validée est une étape annulable de la version ----
    async function commit() {
      try {
        if (!cur) { cur = (await api(`/photos/${enc}/edits`, 'POST', { params })).version; versions = [...versions, cur]; }
        else cur = (await api('/edits/' + encodeURIComponent(cur.id), 'PUT', { params })).version;
        params = { ...cur.params }; versions = versions.map(x => (x.id === cur.id ? cur : x));
        drawPanel();
      } catch (e) { toast(e.message, 'bad'); }
    }
    async function act(path, method = 'POST', payload) {
      try { cur = (await api('/edits/' + encodeURIComponent(cur.id) + path, method, payload)).version; params = { ...cur.params }; versions = versions.map(x => (x.id === cur.id ? cur : x)); drawPanel(); refreshPreview(0); }
      catch (e) { toast(e.message, 'bad'); }
    }
    const set = (patch, now = false) => { Object.assign(params, patch); refreshPreview(); if (now) commit(); };

    // ---- géométrie : quarts de tour et miroirs transforment aussi le recadrage (exprimé dans l'image affichée) ----
    function turn(dir) {
      const c = params.crop;
      const crop = c ? (dir > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w }) : null;
      set({ rotate: (params.rotate + dir * 90 + 360) % 360, crop }, true);
    }
    function flip(axis) {
      const c = params.crop;
      const crop = c ? (axis === 'h' ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h }) : null;
      set(axis === 'h' ? { flipH: !params.flipH, crop } : { flipV: !params.flipV, crop }, true);
    }

    // ---- recadrage : cadre déplaçable et redimensionnable sur l'image entière (sans recadrage) ----
    const RATIOS = { free: 'Libre', orig: 'Proportion d’origine', '1:1': 'Carré 1:1', '4:3': '4:3', '3:2': '3:2', '16:9': '16:9', '4:5': '4:5 (portrait)', '2:3': '2:3 (portrait)' };
    const aspect = () => (img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1);
    const ratioValue = () => { if (ratio === 'free') return null; if (ratio === 'orig') return aspect(); const [a, b] = ratio.split(':').map(Number); return a / b; };
    function fitRatio(b) {
      const r = ratioValue(); if (!r) return b;
      const A = aspect(); let w = b.w, hh = (w * A) / r;
      if (hh > 1) { hh = 1; w = (hh * r) / A; }
      return { x: Math.min(b.x, 1 - w), y: Math.min(b.y, 1 - hh), w, h: hh };
    }
    function drawCrop() {
      overlay.hidden = !cropMode; if (!cropMode || !cropBox) return;
      Object.assign(overlay.style, { left: cropBox.x * 100 + '%', top: cropBox.y * 100 + '%', width: cropBox.w * 100 + '%', height: cropBox.h * 100 + '%' });
    }
    let dragC = null;
    overlay.appendChild(h('div.rt-handle'));
    overlay.addEventListener('pointerdown', e => {
      e.preventDefault();
      dragC = { x: e.clientX, y: e.clientY, box: { ...cropBox }, resize: e.target.classList.contains('rt-handle') };
      try { overlay.setPointerCapture(e.pointerId); } catch { /* sans capture */ }
    });
    overlay.addEventListener('pointermove', e => {
      if (!dragC) return;
      const R = img.getBoundingClientRect(), dx = (e.clientX - dragC.x) / R.width, dy = (e.clientY - dragC.y) / R.height, b = dragC.box;
      if (dragC.resize) {
        let w = Math.max(0.05, Math.min(1 - b.x, b.w + dx)), hh = Math.max(0.05, Math.min(1 - b.y, b.h + dy));
        const r = ratioValue(); if (r) { hh = (w * aspect()) / r; if (b.y + hh > 1) { hh = 1 - b.y; w = (hh * r) / aspect(); } }
        cropBox = { x: b.x, y: b.y, w, h: hh };
      } else cropBox = { ...b, x: Math.max(0, Math.min(1 - b.w, b.x + dx)), y: Math.max(0, Math.min(1 - b.h, b.y + dy)) };
      drawCrop();
    });
    overlay.addEventListener('pointerup', () => { dragC = null; });
    function startCrop() { cropMode = true; cropBox = params.crop ? { ...params.crop } : { x: 0, y: 0, w: 1, h: 1 }; drawPanel(); refreshPreview(0); }
    function endCrop(apply) {
      cropMode = false; overlay.hidden = true;
      if (apply) set({ crop: cropBox && (cropBox.w < 0.999 || cropBox.h < 0.999) ? cropBox : null }, true);
      else { drawPanel(); refreshPreview(0); }
    }

    // ---- panneau de réglages ----
    const panel = h('div.rt-panel');
    function slider(key) {
      const f = F[key], out = h('span.rt-val', String(params[key]));
      const input = h('input', { type: 'range', min: f.min, max: f.max, step: f.step, value: params[key] });
      input.addEventListener('input', () => { out.textContent = input.value; set({ [key]: +input.value }); });
      input.addEventListener('change', () => commit());
      input.addEventListener('dblclick', () => { input.value = 0; out.textContent = '0'; set({ [key]: 0 }, true); });
      return h('div.rt-slider', h('label', f.label, out), input);
    }
    function drawPanel() {
      const verSel = h('select', { onchange: e => { cur = versions.find(x => x.id === e.target.value) ?? null; params = { ...(cur?.params ?? neutral) }; drawPanel(); refreshPreview(0); } },
        versions.length ? null : h('option', { value: '' }, 'Original (aucune retouche)'),
        ...versions.map(x => h('option', { value: x.id, selected: x.id === cur?.id }, x.name + (x.is_default ? ' ★' : ''))));
      const groups = {};
      for (const key of Object.keys(F)) if (key !== 'straighten') (groups[F[key].group] ??= []).push(slider(key));
      const cap = meta.capability;
      mount(panel,
        cap.fullRes === false ? h('div.album-alert.warn', cap.reason) : null,
        h('div.rt-sect', 'Version'),
        h('div.row', verSel),
        h('div.row.wrap',
          h('button.ghost.small', { title: 'Nouvelle version à partir des réglages actuels', onclick: async () => { cur = (await api(`/photos/${enc}/edits`, 'POST', cur ? { from: cur.id } : { params })).version; versions = [...versions, cur]; params = { ...cur.params }; drawPanel(); } }, '+ Nouvelle version'),
          cur ? h('button.ghost.small', { onclick: async () => { const nm = prompt('Nom de la version', cur.name); if (nm) await act('', 'PUT', { name: nm }); } }, 'Renommer…') : null,
          cur && !cur.is_default ? h('button.ghost.small', { title: 'Version utilisée par l’export', onclick: async () => { await act('', 'PUT', { isDefault: true }); versions = (await api(`/photos/${enc}/edits`)).versions; drawPanel(); } }, '★ Par défaut') : null,
          cur ? h('button.ghost.small.danger', { onclick: async () => { if (!(await confirmDialog('Supprimer la version', `Supprimer « ${cur.name} » ? L’original n’est jamais modifié.`))) return; await api('/edits/' + encodeURIComponent(cur.id), 'DELETE'); meta = await api(`/photos/${enc}/edits`); versions = meta.versions; cur = versions.find(x => x.is_default) ?? null; params = { ...(cur?.params ?? neutral) }; drawPanel(); refreshPreview(0); } }, 'Supprimer') : null),
        h('div.row.wrap',
          h('button.ghost.small', { disabled: !cur?.undo, title: 'Ctrl+Z', onclick: () => act('/undo') }, '↶ Annuler'),
          h('button.ghost.small', { disabled: !cur?.redo, title: 'Ctrl+Y', onclick: () => act('/redo') }, '↷ Rétablir'),
          h('button.ghost.small', { disabled: !cur || cur.neutral, title: 'Revenir aux réglages neutres (annulable)', onclick: () => act('/reset') }, 'Réinitialiser'),
          beforeBtn),
        h('div.rt-sect', 'Filtres'),
        h('div.rt-presets', ...Object.entries(meta.presets).map(([k, pr]) => h('button.ghost.small', { onclick: () => {
          const tone = Object.fromEntries(['exposure', 'brightness', 'contrast', 'temperature', 'tint', 'saturation', 'sharpen', 'mono'].map(t => [t, neutral[t]]));
          set({ ...tone, ...pr.params }, true);
        } }, pr.label))),
        h('div.rt-sect', 'Géométrie'),
        cropMode
          ? h('div', h('div.form', field('Proportion', h('select', { onchange: e => { ratio = e.target.value; cropBox = fitRatio(cropBox); drawCrop(); } }, ...Object.entries(RATIOS).map(([k, l]) => h('option', { value: k, selected: k === ratio }, l))))),
              h('p.dim', 'Faites glisser le cadre ; le coin en bas à droite le redimensionne.'),
              h('div.row', h('button.ghost.small', { onclick: () => { cropBox = { x: 0, y: 0, w: 1, h: 1 }; drawCrop(); } }, 'Image entière'), h('div.spacer'),
                h('button.ghost.small', { onclick: () => endCrop(false) }, 'Annuler'), h('button.small', { onclick: () => endCrop(true) }, 'Appliquer')))
          : h('div.row.wrap',
              h('button.ghost.small', { title: 'Tourner à gauche', onclick: () => turn(-1) }, '↺'),
              h('button.ghost.small', { title: 'Tourner à droite', onclick: () => turn(1) }, '↻'),
              h('button.ghost.small' + (params.flipH ? '.on' : ''), { title: 'Miroir horizontal', onclick: () => flip('h') }, '⇋'),
              h('button.ghost.small' + (params.flipV ? '.on' : ''), { title: 'Miroir vertical', onclick: () => flip('v') }, '⇵'),
              h('button.ghost.small' + (params.crop ? '.on' : ''), { onclick: startCrop }, '✂ Recadrer')),
        cropMode ? null : slider('straighten'),
        ...Object.entries(groups).flatMap(([g, list]) => [h('div.rt-sect', g), ...list]),
        h('div.form', field('Noir et blanc', h('select', { onchange: e => set({ mono: e.target.value || null }, true) },
          h('option', { value: '' }, 'Couleur'), h('option', { value: 'bw', selected: params.mono === 'bw' }, 'Noir et blanc'), h('option', { value: 'sepia', selected: params.mono === 'sepia' }, 'Sépia')))),
        h('p.dim', 'Double-clic sur un curseur : remise à zéro. Les réglages sont enregistrés à part ; l’original n’est jamais modifié.'));
      drawCrop();
    }

    // raccourcis Ctrl+Z / Ctrl+Y (hors champs de saisie)
    keyHandler = e => {
      if (state.view !== 'retouche' || state.editPhotoId !== pid || !cur) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.target.closest?.('input, textarea, select') || document.querySelector('.modal')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey && cur.undo) { e.preventDefault(); act('/undo'); }
      else if ((k === 'y' || (k === 'z' && e.shiftKey)) && cur.redo) { e.preventDefault(); act('/redo'); }
    };

    mount(v,
      h('div.row', h('h2.page-title', `Retouche — ${fileName}`), h('div.spacer'),
        h('button.ghost.small', { onclick: () => go(state.editBack || 'photos') }, '← Retour'),
        h('button.small', { onclick: () => exportDialog([pid]) }, 'Exporter…')),
      h('div.rt-layout', h('div.rt-view', stage, busy), panel));
    drawPanel(); refreshPreview(0);
  }

  // ---------- Export de photos (lib/exports.mjs) : profil, réglages, travail suivi, compte rendu ----------
  async function exportDialog(ids) {
    if (!ids.length) return;
    let meta = await api('/exports/profiles');
    const keyOf = () => [...Object.keys(meta.builtin).map(k => 'b:' + k), ...Object.keys(meta.saved).map(k => 's:' + k)];
    const profOf = k => (k.startsWith('b:') ? meta.builtin[k.slice(2)] : meta.saved[k.slice(2)]);
    const sel = h('select'), fmt = h('select', {}, ...Object.entries(meta.formats).map(([k, f]) => h('option', { value: k }, f.label)));
    const quality = h('input', { type: 'number', min: 30, max: 100 }), maxSide = h('input', { type: 'number', min: 64, max: 20000, placeholder: 'pleine définition' });
    const version = h('select', {}, h('option', { value: 'default' }, 'Version retouchée par défaut (sinon l’original)'), h('option', { value: 'original' }, 'Original non retouché'));
    const metaSel = h('select', {}, ...Object.entries(meta.metadata).map(([k, l]) => h('option', { value: k }, l)));
    const wmText = h('input', { type: 'text', placeholder: 'aucun' }), wmPos = h('select', {}, ...Object.entries(meta.positions).map(([k, l]) => h('option', { value: k }, l)));
    const naming = h('input', { type: 'text' }), folder = h('input', { type: 'text', placeholder: 'Export <date et heure>' });
    const status = h('div'), delBtn = h('button.ghost.small.danger', { hidden: true }, 'Supprimer ce profil');
    function fillSel(selected) { mount(sel, ...keyOf().map(k => h('option', { value: k, selected: k === selected }, (k.startsWith('s:') ? '★ ' : '') + profOf(k).name))); }
    function load(k) {
      const p = profOf(k); if (!p) return;
      fmt.value = p.format; quality.value = p.quality; maxSide.value = p.maxSide ?? ''; version.value = p.version; metaSel.value = p.metadata;
      wmText.value = p.watermark.text; wmPos.value = p.watermark.position; naming.value = p.naming; folder.value = p.folder;
      delBtn.hidden = !k.startsWith('s:'); quality.disabled = !meta.formats[p.format].quality;
    }
    const current = () => ({ format: fmt.value, quality: +quality.value, maxSide: maxSide.value ? +maxSide.value : null, version: version.value, metadata: metaSel.value,
      watermark: { text: wmText.value, position: wmPos.value }, naming: naming.value, folder: folder.value });
    sel.addEventListener('change', () => load(sel.value));
    fmt.addEventListener('change', () => { quality.disabled = !meta.formats[fmt.value].quality; });
    delBtn.addEventListener('click', async () => { await api('/exports/profiles/' + encodeURIComponent(sel.value.slice(2)), 'DELETE'); meta = await api('/exports/profiles'); fillSel('b:web'); load('b:web'); });
    const saveBtn = h('button.ghost.small', { onclick: async () => {
      const nm = prompt('Nom du profil d’export'); if (!nm) return;
      const r = await api('/exports/profiles', 'POST', { ...current(), name: nm }); meta = await api('/exports/profiles'); fillSel('s:' + r.id); load('s:' + r.id); toast('Profil enregistré');
    } }, 'Enregistrer comme profil…');
    const go2 = h('button', { onclick: async () => {
      go2.disabled = true;
      try {
        const { jobId } = await api('/exports', 'POST', { photoIds: ids, profile: current() });
        let job;
        do { await new Promise(r => setTimeout(r, 400)); job = (await api('/jobs/' + jobId)).job; mount(status, h('p.dim', `Export en cours… ${job.done ?? 0} / ${job.total || ids.length}`)); } while (job.status === 'running');
        if (job.status === 'error') throw new Error(job.error);
        const r = job.result;
        mount(status, h('p', `✓ ${r.files.length} fichier(s) · ${fmtBytes(r.bytes)}`), h('p.dim', 'Dossier : ' + r.dir),
          r.fromPreview ? h('div.album-alert.warn', `${r.fromPreview} photo(s) exportée(s) depuis l’aperçu en cache (original indisponible ou RAW) : définition réduite.`) : null,
          ...r.errors.slice(0, 8).map(e => h('div.album-alert.bad', `${e.photoId.slice(0, 8)}… : ${e.error}`)));
        toast(`${r.files.length} photo(s) exportée(s)`);
      } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
      go2.disabled = false;
    } }, `Exporter ${ids.length} photo(s)`);
    fillSel('b:web'); load('b:web');
    const m = modal({ title: 'Exporter', wide: true, body: h('div',
      h('div.form', field('Profil', sel)),
      h('div.form', field('Format', fmt), field('Qualité (JPEG, WebP)', quality), field('Plus grand côté (pixels)', maxSide)),
      h('div.form', field('Version', version), field('Métadonnées', metaSel)),
      h('div.form', field('Filigrane (texte)', wmText), field('Position du filigrane', wmPos)),
      h('div.form', field('Nom des fichiers', naming), field('Sous-dossier', folder)),
      h('p.dim', `Modèles de nom : {nom} (fichier d’origine), {titre}, {date}, {n} (rang). Les fichiers vont dans ${meta.dir} ; un fichier existant n’est jamais écrasé et les originaux ne sont jamais modifiés.`),
      h('div.row', saveBtn, delBtn), status), actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer'), go2] });
  }

  // ---------- Albums : liste + éditeur de pages ----------
  // Formats et gabarits viennent du serveur (lib/albums.mjs) : l'interface ne fait que les dessiner.
  let albumMeta = null;
  // raccourcis clavier de l'éditeur d'album (Ctrl+Z / Ctrl+Y) : un seul écouteur, branché sur l'album ouvert
  let keyHandler = null;
  document.addEventListener('keydown', e => keyHandler?.(e));
  // même règle que le PDF (lib/pdf.mjs, textColorOn) : texte foncé sur fond clair, blanc sur fond foncé
  const inkOn = bg => { const v = parseInt(String(bg).slice(1), 16) || 0xffffff; const l = [v >> 16, (v >> 8) & 255, v & 255].map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2] > 0.25 ? '#1e293b' : '#ffffff'; };
  const loadAlbumMeta = async () => (albumMeta ??= await api('/albums'));
  const formatSelect = (current = 'carre-30') => h('select', {}, ...Object.entries(albumMeta.formats).map(([k, f]) => h('option', { value: k, selected: k === current }, f.label)));
  const layoutSelect = (current = 'une', { withTitle = true } = {}) => h('select', {},
    ...Object.entries(albumMeta.layouts).filter(([k]) => withTitle || k !== 'titre').map(([k, l]) => h('option', { value: k, selected: k === current }, l.label)));
  /** Champs format (+ largeur/hauteur si personnalisé). */
  function formatFields(a = {}) {
    const sel = formatSelect(a.format);
    const w = h('input', { type: 'number', min: 50, max: 1000, value: a.width_mm ?? 250 }), hh = h('input', { type: 'number', min: 50, max: 1000, value: a.height_mm ?? 250 });
    const custom = h('div.form', field('Largeur (mm)', w), field('Hauteur (mm)', hh));
    const sync = () => { custom.hidden = sel.value !== 'custom'; };
    sel.addEventListener('change', sync); sync();
    return { el: h('div', field('Format de page', sel), custom), value: () => ({ format: sel.value, width_mm: +w.value, height_mm: +hh.value }) };
  }

  async function viewAlbums(v) {
    clear(v);
    await loadAlbumMeta();
    const wrap = h('div.album-list');
    async function refresh() {
      const { list } = await api('/albums');
      clear(wrap);
      if (!list.length) { wrap.appendChild(h('p.dim', 'Aucun album. Créez-en un ci-dessus, ou depuis la Photothèque : sélectionnez des photos puis « Ajouter à un album… ».')); return; }
      for (const a of list) {
        wrap.appendChild(h('button.album-card', { onclick: () => openAlbum(a.id) },
          h('div.album-cover', { style: { aspectRatio: `${a.width_mm} / ${a.height_mm}` } }, a.cover ? h('img', { src: a.cover, alt: '' }) : h('span', '📖')),
          h('div.album-info', h('b', a.name), h('small.dim', `${a.formatLabel} · ${a.pageCount} page(s) · ${a.photoCount} photo(s)`),
            a.alerts ? h('small', { style: { color: 'var(--warn)' } }, `⚠ ${a.alerts} alerte(s)`) : null)));
      }
    }
    const name = h('input', { type: 'text', placeholder: 'Ex. : Vacances 2024' });
    const fmt = formatFields();
    const create = async () => { try { const r = await api('/albums', 'POST', { name: name.value, ...fmt.value() }); openAlbum(r.album.id); } catch (e) { toast(e.message, 'bad'); } };
    mount(v, h('h2.page-title', 'Albums'),
      card(h('div.sect', 'Nouvel album'),
        h('p.dim', "Un album ne contient que des références à vos photos : aucun original n'est copié ni modifié."),
        h('div.form', field('Nom', name), fmt.el, h('div.field', h('label', ' '), h('button', { onclick: create }, 'Créer')))),
      card(h('div.sect', 'Importer un projet'),
        h('p.dim', "Réimporte un projet exporté (« Exporter le projet », fichier .album.json) comme nouvel album. Les photos sont retrouvées dans ce catalogue par identifiant, contenu (empreinte) ou chemin ; aucun album existant n'est remplacé."),
        h('button.ghost', { onclick: importAlbumProject }, 'Importer un projet…')),
      card(h('div.sect', 'Mes albums'), wrap));
    await refresh();
  }

  // ---------- Planche-contact (lib/contactsheet.mjs) : réglages, aperçu, PDF ----------
  // `ids` (sélection, dans l'ordre) ou `query` (critères de la grille au format de /api/photos, tri compris).
  let sheetMeta = null;
  async function contactSheetDialog({ ids, query, label, count, presetTitle }) {
    sheetMeta ??= await api('/contactsheet');
    const M = sheetMeta, KEY = 'phototheque.contactsheet';
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') ?? {}; } catch { /* préférence absente */ }
    const o = { ...M.defaults, ...saved };
    const layout = h('select', {}, ...Object.entries(M.layouts).map(([k, l]) => h('option', { value: k, selected: (o.layout ?? 'grid') === k }, l)));
    const isDetail = () => layout.value === 'detail';
    const title = h('input', { type: 'text', value: presetTitle ?? (label && label !== 'Photothèque' ? label : ''), placeholder: 'Titre en tête de page (facultatif)' });
    const page = h('select', {}, ...Object.entries(M.pages).map(([k, p]) => h('option', { value: k, selected: o.page === k }, p.label)));
    const cols = h('input', { type: 'number', min: 1, max: 12, value: o.columns, style: { width: '70px' } });
    const rows = h('input', { type: 'number', min: 1, max: 16, value: o.rows, style: { width: '70px' } });
    const quality = h('select', {}, ...Object.entries(M.qualities).map(([k, q]) => h('option', { value: k, selected: o.quality === k }, q.label)));
    const edited = h('input', { type: 'checkbox', checked: o.edited !== false });
    const boxes = Object.entries(M.fields).map(([k, l]) => { const cb = h('input', { type: 'checkbox', checked: (o.fields ?? []).includes(k) }); cb.dataset.key = k; return h('label.check', cb, ' ' + l); });
    const info = h('p.dim'), status = h('div');
    const options = () => ({ layout: layout.value, title: title.value, page: page.value, columns: +cols.value, rows: +rows.value, quality: quality.value, edited: edited.checked,
      fields: boxes.map(b => b.querySelector('input')).filter(cb => cb.checked).map(cb => cb.dataset.key) });
    const n = Math.min(count ?? 0, M.maxPhotos);
    const gridOnly = [];
    const sync = () => {
      for (const el of gridOnly) el.style.display = isDetail() ? 'none' : ''; // `hidden` serait écrasé par le CSS de .field
      const per = isDetail() ? 1 : Math.max(1, (+cols.value || 1) * (+rows.value || 1)); info.textContent = `${n} photo(s)${ids ? ' sélectionnée(s)' : ' de la recherche affichée'} · ${per} par page → ${Math.ceil(n / per) || 0} page(s)` + ((count ?? 0) > M.maxPhotos ? ` (limitée aux ${M.maxPhotos} premières en PDF)` : '');
    };
    for (const el of [cols, rows]) el.addEventListener('input', sync);
    layout.addEventListener('change', sync);
    const fileBase = () => (title.value || (label || 'Photothèque') + (isDetail() ? ' fiches' : '')).replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, ' ').trim();
    async function produce(inline) {
      const opts = options(); try { localStorage.setItem(KEY, JSON.stringify({ ...opts, title: undefined })); } catch { /* préférence non mémorisée */ }
      const res = await fetch('/api/contactsheet', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(ids ? { ids } : { query }), label, inline, options: inline ? { ...opts, quality: 'screen' } : opts }) });
      if (!res.ok) { let msg = 'Échec de la production de la planche-contact'; try { msg = (await res.json()).error || msg; } catch { /* corps non JSON */ } throw new Error(msg); }
      let report = null; try { report = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(res.headers.get('X-Pdf-Report') || ''), c => c.charCodeAt(0)))); } catch { /* compte rendu absent */ }
      return { blob: await res.blob(), report };
    }
    const summary = r => r ? [h('p', `${r.photos} ${r.layout === 'detail' ? 'fiche(s)' : 'photo(s)'} sur ${r.pages} page(s) · ${fmtBytes(r.bytes)}${r.edited ? ` · ${r.edited} en version retouchée` : ''}`),
      r.unreadable.length ? h('div.album-alert.bad', `${r.unreadable.length} photo(s) illisible(s) (n° ${r.unreadable.slice(0, 8).map(u => u.n).join(', ')}${r.unreadable.length > 8 ? '…' : ''}) : case marquée « illisible »`) : null,
      r.fromPreview.length ? h('div.album-alert.warn', `${r.fromPreview.length} photo(s) prise(s) sur l’aperçu en cache, original indisponible`) : null,
      r.truncated?.length ? h('div.album-alert.warn', `${r.truncated.length} fiche(s) trop longue(s) pour la page (n° ${r.truncated.slice(0, 8).join(', ')}${r.truncated.length > 8 ? '…' : ''}) : la fin des informations n’est pas imprimée`) : null] : [];
    const busy = on => { for (const b of m.box.querySelectorAll('button[data-sheet]')) b.disabled = on; };
    const previewBtn = h('button.ghost', { dataset: { sheet: 'preview' }, onclick: async () => {
      busy(true); mount(status, h('p.dim', 'Préparation de l’aperçu…'));
      try {
        const { blob, report } = await produce(true), src = URL.createObjectURL(blob);
        clear(status);
        // la fenêtre d'aperçu remplace celle des réglages : on peut y revenir ou télécharger directement
        const back = () => contactSheetDialog({ ids, query, label, count, presetTitle: title.value });
        const pv = modal({ title: isDetail() ? 'Aperçu des fiches détaillées' : 'Aperçu de la planche-contact', wide: true, body: h('div', ...summary(report), h('iframe.pdf-frame', { src, title: 'Aperçu PDF' })), actions: [
          h('button.ghost', { onclick: () => pv.close() }, 'Fermer'), h('button.ghost', { onclick: back }, 'Modifier les réglages'),
          h('button', { onclick: async () => { await back(); document.querySelector('button[data-sheet="go"]')?.click(); } }, 'Télécharger le PDF')] });
        new MutationObserver((_, ob) => { if (!pv.box.isConnected) { URL.revokeObjectURL(src); ob.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
      } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
      busy(false);
    } }, 'Aperçu');
    const goBtn = h('button', { dataset: { sheet: 'go' }, onclick: async () => {
      busy(true); mount(status, h('p.dim', 'Production du PDF…'));
      try {
        const { blob, report } = await produce(false);
        const name = (fileBase() || 'planche-contact') + '.pdf';
        const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        mount(status, h('p', '✓ PDF enregistré dans le dossier de téléchargement du navigateur.'), ...summary(report));
        toast(isDetail() ? 'Fiches détaillées produites' : 'Planche-contact produite');
      } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
      busy(false);
    } }, 'Télécharger le PDF');
    // catalogue CSV : les mêmes photos, une ligne par photo et toutes les colonnes (sans la limite du PDF)
    const csvBtn = h('button.ghost', { dataset: { sheet: 'csv' }, title: `Colonnes : ${M.csvColumns.join(', ')}`, onclick: async () => {
      busy(true); mount(status, h('p.dim', 'Préparation du CSV…'));
      try {
        const res = await fetch('/api/catalog/csv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(ids ? { ids } : { query }), label: title.value || label }) });
        if (!res.ok) { let msg = 'Échec de l’export CSV'; try { msg = (await res.json()).error || msg; } catch { /* corps non JSON */ } throw new Error(msg); }
        const blob = await res.blob(), a = h('a', { href: URL.createObjectURL(blob), download: ((title.value || label || 'catalogue').replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, ' ').trim() || 'catalogue') + '.csv' });
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        mount(status, h('p', `✓ CSV enregistré dans le dossier de téléchargement : ${res.headers.get('X-Csv-Photos')} photo(s), ${M.csvColumns.length} colonnes (séparateur « ; », virgule décimale, UTF-8).`));
        toast('Catalogue CSV exporté');
      } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
      busy(false);
    } }, 'Exporter en CSV');
    const colsF = field('Colonnes', cols), rowsF = field('Lignes', rows), legend = h('div', h('b', 'Légende'), h('div.sheet-fields', ...boxes));
    const detailNote = h('p.dim', 'Une photo par page, puis titre, description, date, auteur, mots-clés, appareil, exposition, dimensions, GPS, emplacements et empreinte.');
    gridOnly.push(colsF, rowsF, legend);
    const m = modal({ title: 'Planche-contact, fiches détaillées, CSV', body: h('div.import-report',
      info,
      field('Document', layout),
      field('Titre', title),
      h('div.row.wrap', { style: { gap: '12px' } }, field('Format', page), colsF, rowsF, field('Qualité', quality)),
      legend, detailNote,
      h('label.check', edited, ' Montrer les photos dans leur version retouchée par défaut'),
      h('p.dim', 'Chaque photo est montrée entière, sans recadrage. Les originaux sont lus sans être modifiés.'),
      status), actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer'), csvBtn, previewBtn, goBtn] });
    const syncNote = () => { detailNote.hidden = !isDetail(); }; layout.addEventListener('change', syncNote); syncNote(); sync();
  }

  // ---------- Réimport d'un projet d'album (lib/albums.mjs importProject) : analyse, puis confirmation ----------
  function importAlbumProject() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0]; if (!file) return;
      let project;
      try { project = JSON.parse(await file.text()); } catch { toast('Fichier illisible : ce n’est pas du JSON', 'bad'); return; }
      let an;
      try { an = (await api('/albums/import/analyse', 'POST', { project })).analysis; } catch (e) { toast(e.message, 'bad'); return; }
      const name = h('input', { type: 'text', value: an.name });
      const withEdits = h('input', { type: 'checkbox', checked: true });
      const ph = an.photos, how = [ph.byId && `${ph.byId} par identifiant`, ph.bySha256 && `${ph.bySha256} par contenu`, ph.byPath && `${ph.byPath} par chemin`].filter(Boolean).join(', ');
      const m = modal({ title: `Importer « ${an.name} »`, body: h('div.import-report',
        field('Nom du nouvel album', name),
        h('p', `${an.formatLabel} · ${an.printedPages} page(s) imprimée(s)`),
        h('p', ph.total ? `${ph.found} photo(s) retrouvée(s) sur ${ph.total}` + (how ? ` (${how})` : '') : 'Aucune photo dans ce projet.'),
        ph.missing.length ? h('div.import-missing', h('p', { style: { color: 'var(--warn)' } }, `⚠ ${ph.missing.length} photo(s) introuvable(s) dans ce catalogue : leurs cadres seront signalés dans l’album. Indexez le dossier qui les contient puis réimportez, ou remplacez-les dans l’éditeur.`),
          h('ul.dim', ...ph.missing.slice(0, 20).map(x => h('li', x.title || x.path || x.id)), ph.missing.length > 20 ? h('li', `… et ${ph.missing.length - 20} autre(s)`) : null)) : null,
        an.edits.total ? h('label.check', withEdits, ` Recréer les ${an.edits.total} retouche(s) du projet (${an.edits.same} déjà présente(s) ; une nouvelle version ne devient « par défaut » que si la photo n’en a aucune)`) : null,
        h('p.dim', 'Les originaux ne sont jamais copiés ni modifiés.')), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => {
          try {
            const r = await api('/albums/import', 'POST', { project, name: name.value, withEdits: withEdits.checked });
            m.close();
            toast(`Album « ${r.name} » importé : ${r.photos.found}/${r.photos.total} photo(s)` + (r.edits.created ? `, ${r.edits.created} retouche(s) recréée(s)` : '') + (r.edits.notDefault ? ` (${r.edits.notDefault} à choisir comme version par défaut)` : ''));
            openAlbum(r.album.id);
          } catch (e) { toast(e.message, 'bad'); }
        } }, 'Importer'),
      ] });
    });
    input.click();
  }
  function openAlbum(id) { state.albumId = id; go('album'); }

  async function viewAlbum(v) {
    await loadAlbumMeta();
    let album = (await api('/albums/' + encodeURIComponent(state.albumId))).album;
    const L = albumMeta.layouts;
    const body = h('div.album-editor');
    const base = '/albums/' + encodeURIComponent(album.id);
    let drag = null; // { page, slot } du cadre dont on déplace la photo

    // Toute modification renvoie l'album complet : on redessine en gardant la position de défilement.
    async function change(path, method, payload) {
      try { const r = await api(base + path, method, payload); album = r.album ?? album; render(); return r; }
      catch (e) { toast(e.message, 'bad'); }
    }
    const pageUrl = n => `/pages/${n}`;
    const slotsOf = n => [...album.pages[n - 1].slots];
    const setSlot = (n, s, id) => { const sl = slotsOf(n); while (sl.length <= s) sl.push(null); sl[s] = id; return sl; };

    // le recadrage suit la photo quand on la déplace d'un cadre à l'autre
    const cropsOf = n => album.pages[n - 1].slots.map((_, i) => album.pages[n - 1].crops?.[i] ?? null);
    const setCrop = (list, s, c) => { while (list.length <= s) list.push(null); list[s] = c; return list; };
    async function dropOn(n, s) {
      if (!drag || (drag.page === n && drag.slot === s)) return;
      const from = drag; drag = null;
      // échange fait côté serveur en une seule étape (photo + recadrage), donc annulable d'un coup
      await change('/move-photo', 'POST', { from: { page: from.page, slot: from.slot }, to: { page: n, slot: s } });
    }

    // ---- Annuler / rétablir (piles tenues par le serveur, lib/albums.mjs) ----
    async function undoRedo(kind) {
      const r = await change('/' + kind, 'POST');
      if (r?.done) toast(`${kind === 'undo' ? 'Annulé' : 'Rétabli'} : ${r.done}`);
    }
    // raccourcis Ctrl+Z / Ctrl+Y (ou Ctrl+Maj+Z), hors des champs de saisie et des fenêtres ouvertes
    keyHandler = e => {
      if (state.view !== 'album' || state.albumId !== album.id) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('.modal')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); if (album.history?.undo) undoRedo('undo'); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); if (album.history?.redo) undoRedo('redo'); }
    };

    // ---- Recadrage manuel : même calcul que cropWindow (lib/albums.mjs) ----
    // r = largeur/hauteur de l'image, A = largeur/hauteur du cadre ; renvoie la place de l'image
    // dans le cadre (en fractions du cadre) et la partie visible (en fractions de l'image).
    function cropBox(r, A, crop) {
      const z = crop?.zoom ?? 1;
      const iw = (r > A ? r / A : 1) * z, ih = (r > A ? 1 : A / r) * z; // taille de l'image / taille du cadre
      const w = Math.min(1, 1 / iw), hh = Math.min(1, 1 / ih);
      const cx = Math.min(1 - w / 2, Math.max(w / 2, crop?.x ?? 0.5)), cy = Math.min(1 - hh / 2, Math.max(hh / 2, crop?.y ?? 0.5));
      return { iw, ih, w, h: hh, cx, cy, left: -(cx - w / 2) * iw, top: -(cy - hh / 2) * ih };
    }
    // libellé imprimé d'une ligne d'album : « Page 3 » ou « Pages 4–5 »
    const labelOf = n => { const pg = album.pages[n - 1]; return pg.span === 2 ? `Pages ${pg.folio}–${pg.folio + 1}` : `Page ${pg.folio}`; };
    // proportion d'un cadre ; pour une double page, les cadres sont en fractions de la planche (deux largeurs)
    const frameAspect = (fr, pg) => (fr.w * album.width_mm * (pg?.span ?? 1)) / (fr.h * album.height_mm);
    const imgStyle = (b) => ({ position: 'absolute', maxWidth: 'none', objectFit: 'fill', width: b.iw * 100 + '%', height: b.ih * 100 + '%', left: b.left * 100 + '%', top: b.top * 100 + '%' });

    function cropDialog(n, s) {
      const pg = album.pages[n - 1], fr = L[pg.layout].frames[s], ph = album.photos[pg.slots[s]];
      if (!ph?.width || !ph?.height) { toast('Dimensions de la photo inconnues : recadrage impossible', 'bad'); return; }
      const r = ph.width / ph.height, A = frameAspect(fr, pg);
      let crop = { ...(pg.crops?.[s] ?? { x: 0.5, y: 0.5, zoom: 1 }) };
      // scène à la proportion du cadre, au plus 560 × 400 px
      const sw = Math.min(560, 400 * A), sh = sw / A;
      const img = h('img', { src: ph.preview || ph.thumb, alt: '', draggable: 'false' });
      const stage = h('div.crop-stage', { style: { width: sw + 'px', height: sh + 'px' } }, img, h('div.crop-thirds'));
      const zoom = h('input', { type: 'range', min: 1, max: 5, step: 0.01, value: crop.zoom });
      const info = h('small.dim');
      const frameMm = fr.w * album.width_mm * (pg.span ?? 1);
      function draw() {
        const b = cropBox(r, A, crop); crop.x = b.cx; crop.y = b.cy; // centre ramené dans les limites
        Object.assign(img.style, imgStyle(b));
        zoom.value = crop.zoom;
        const dpi = Math.round(25.4 * ph.width * b.w / frameMm);
        info.textContent = `Zoom × ${crop.zoom.toFixed(2)} · résolution à l'impression ≈ ${dpi} ppp` + (dpi < albumMeta.dpiAdvised ? ` (${albumMeta.dpiAdvised} conseillés)` : '');
        info.className = dpi < 150 ? 'bad' : dpi < albumMeta.dpiAdvised ? 'warn' : 'dim';
      }
      let start = null;
      stage.addEventListener('pointerdown', e => { start = { x: e.clientX, y: e.clientY, cx: crop.x, cy: crop.y }; try { stage.setPointerCapture(e.pointerId); } catch { /* pointeur sans capture possible */ } stage.classList.add('grabbing'); });
      stage.addEventListener('pointermove', e => {
        if (!start) return;
        const b = cropBox(r, A, crop);
        crop.x = start.cx - (e.clientX - start.x) / (sw * b.iw); crop.y = start.cy - (e.clientY - start.y) / (sh * b.ih);
        draw();
      });
      const stop = () => { start = null; stage.classList.remove('grabbing'); };
      stage.addEventListener('pointerup', stop); stage.addEventListener('pointercancel', stop);
      stage.addEventListener('wheel', e => { e.preventDefault(); crop.zoom = Math.min(5, Math.max(1, crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))); draw(); }, { passive: false });
      zoom.addEventListener('input', () => { crop.zoom = +zoom.value; draw(); });
      const m = modal({ title: `Recadrer — ${labelOf(n).toLowerCase()}, cadre ${s + 1}`, wide: true, body: h('div.crop-dialog',
        stage,
        h('div.row', h('span', 'Zoom'), zoom, info),
        h('p.dim', 'Faites glisser la photo pour choisir la partie visible ; molette ou curseur pour zoomer. L’original n’est pas modifié.')), actions: [
        h('button.ghost', { onclick: () => { crop = { x: 0.5, y: 0.5, zoom: 1 }; draw(); } }, 'Réinitialiser'),
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => { const r2 = await change(pageUrl(n), 'PUT', { crops: setCrop(cropsOf(n), s, crop) }); if (r2) m.close(); } }, 'Enregistrer'),
      ] });
      draw();
    }

    // side : 'left' ou 'right' dans la vue en planches (la feuille se colle au pli), sinon rien
    function pageView(pg, n, side = '') {
      const issues = album.issues.filter(i => i.page === n && i.level !== 'info');
      const lay = L[pg.layout], span = pg.span ?? 1, sw = album.width_mm * span;
      // largeur bornée pour qu'une page en hauteur ne dépasse pas 420 px de haut sans être déformée
      const sheet = h('div.album-page' + (state.albumGuides ? '.guides' : '') + (span === 2 ? '.spread' : ''), { style: { aspectRatio: `${sw} / ${album.height_mm}`, width: `min(100%, ${Math.round(420 * sw / album.height_mm)}px)`, background: pg.background, color: inkOn(pg.background) } });
      lay.frames.forEach((fr, s) => {
        const id = pg.slots[s], ph = id ? album.photos[id] : null;
        const bad = album.issues.find(i => i.page === n && i.slot === s && i.level !== 'info');
        const cell = h('div.album-frame' + (id ? '' : '.empty') + (bad ? '.' + bad.level : ''), {
          style: { left: fr.x * 100 + '%', top: fr.y * 100 + '%', width: fr.w * 100 + '%', height: fr.h * 100 + '%' },
          title: bad ? bad.message : id ? 'Cliquer pour changer, glisser pour déplacer' : 'Cliquer pour placer une photo',
          onclick: () => pickPhoto(n, s),
          ondragover: e => { if (drag) { e.preventDefault(); cell.classList.add('over'); } },
          ondragleave: () => cell.classList.remove('over'),
          ondrop: e => { e.preventDefault(); cell.classList.remove('over'); dropOn(n, s); },
        });
        if (ph) {
          const src = ph.preview || ph.thumb, crop = pg.crops?.[s] ?? null;
          const im = src ? h('img', { src, alt: ph.title || '', draggable: 'true', ondragstart: () => { drag = { page: n, slot: s }; } }) : null;
          if (im && ph.width && ph.height) Object.assign(im.style, imgStyle(cropBox(ph.width / ph.height, frameAspect(fr, pg), crop)));
          cell.appendChild(im ?? h('span', '🖼️'));
          if (crop) cell.appendChild(h('span.frame-cropped', { title: `Recadrée (zoom × ${crop.zoom.toFixed(2)})` }, '✂'));
          if (ph.edit) cell.appendChild(h('span.frame-edited', { title: `Version retouchée « ${ph.edit.name} » (modifiable dans la Retouche)` }, '✎'));
          cell.appendChild(h('div.frame-tools',
            src ? h('button', { title: 'Recadrer la photo dans le cadre', onclick: e => { e.stopPropagation(); cropDialog(n, s); } }, '✂') : null,
            h('button', { title: 'Retirer la photo du cadre', onclick: e => { e.stopPropagation(); change(pageUrl(n), 'PUT', { slots: setSlot(n, s, null) }); } }, '×')));
        } else cell.appendChild(h('span', id ? '⚠' : '+'));
        sheet.appendChild(cell);
      });
      if (pg.layout === 'titre') sheet.appendChild(h('div.album-title', h('div.t1', pg.title || 'Titre'), pg.caption ? h('div.t2', pg.caption) : null));
      else if (pg.caption && !lay.fullBleed) sheet.appendChild(h('div.album-caption', pg.caption));
      // numéros des pages imprimées au coin extérieur : droite si impaire, gauche si paire
      if (!lay.fullBleed) for (let k = 0; k < span; k++) {
        const f = pg.folio + k, odd = f % 2 === 1, x0 = (k / span) * 100, x1 = ((k + 1) / span) * 100;
        sheet.appendChild(h('div.album-folio', { style: odd ? { right: `calc(${100 - x1}% + ${2.2 / span}%)`, left: 'auto' } : { left: `calc(${x0}% + ${2.2 / span}%)`, right: 'auto' } }, String(f)));
      }
      const label = span === 2 ? `Pages ${pg.folio}–${pg.folio + 1}` : `Page ${pg.folio}`;

      const laySel = layoutSelect(pg.layout); laySel.addEventListener('change', () => change(pageUrl(n), 'PUT', { layout: laySel.value }));
      const color = h('input', { type: 'color', value: pg.background, title: 'Couleur de fond', onchange: e => change(pageUrl(n), 'PUT', { background: e.target.value }) });
      const text = (key, ph2) => h('input', { type: 'text', value: pg[key], placeholder: ph2, onchange: e => change(pageUrl(n), 'PUT', { [key]: e.target.value }) });
      const last = album.pages.length;
      return h('div.album-page-wrap' + (span === 2 ? '.spread' : '') + (side ? '.' + side : ''),
        sheet,
        h('div.album-page-tools',
          h('div.row', h('b', label), h('div.spacer'),
            h('button.ghost.small', { disabled: n === 1, title: 'Avancer la page', onclick: () => change(pageUrl(n) + '/move', 'POST', { to: n - 1 }) }, '↑'),
            h('button.ghost.small', { disabled: n === last, title: 'Reculer la page', onclick: () => change(pageUrl(n) + '/move', 'POST', { to: n + 1 }) }, '↓'),
            h('button.ghost.small', { title: 'Dupliquer la page', onclick: () => change(pageUrl(n) + '/duplicate', 'POST') }, '⧉'),
            h('button.ghost.small', { title: 'Supprimer la page', onclick: async () => { if (await confirmDialog('Supprimer la page', `Supprimer ${label.toLowerCase()} ? Les photos restent dans la photothèque.`)) change(pageUrl(n), 'DELETE'); } }, '🗑')),
          h('div.row', laySel, color),
          pg.layout === 'titre' ? text('title', 'Titre') : null,
          text('caption', pg.layout === 'titre' ? 'Sous-titre' : 'Légende de la page'),
          issues.length ? h('div.album-issues', ...issues.map(i => h('small.' + i.level, i.message.replace(/^Pages? [\d–]+ : /, '')))) : null));
    }

    // Planches (vue en vis-à-vis) : page 1 seule à droite, puis paires gauche (paire) / droite (impaire).
    // Une double page occupe sa planche ; mal placée (début à droite), elle reste seule et une alerte le dit.
    function planches() {
      const out = []; let cur = null;
      album.pages.forEach((pg, i) => {
        const n = i + 1;
        if (pg.span === 2) { out.push({ spread: n }); cur = null; return; }
        if (pg.folio % 2 === 0) { cur = { left: n, right: null }; out.push(cur); return; }
        if (cur && !cur.right) { cur.right = n; cur = null; } else out.push({ left: null, right: n });
      });
      return out;
    }

    function render() {
      const sc = document.getElementById('main'), top = sc.scrollTop;
      title.textContent = album.name; // une annulation peut rendre son ancien nom à l'album
      const used = new Set(album.pages.flatMap(p => p.slots).filter(Boolean)).size;
      const alerts = album.issues.filter(i => i.level !== 'info');
      const empties = album.issues.filter(i => i.level === 'info').length;
      const addSel = layoutSelect('une');
      const guides = h('input', { type: 'checkbox', checked: !!state.albumGuides, onchange: e => { state.albumGuides = e.target.checked; render(); } });
      const spreads = h('input', { type: 'checkbox', checked: !!album.spreads, onchange: e => change('', 'PUT', { spreads: e.target.checked }) });
      const addWrap = h('div.album-page-wrap.add', h('div.form', field('Nouvelle page', addSel), h('div.field', h('label', ' '), h('button', { onclick: () => change('/pages', 'POST', { layout: addSel.value }) }, 'Ajouter une page'))));
      mount(body,
        h('div.row', h('span.dim', `${album.formatLabel} · ${album.width_mm} × ${album.height_mm} mm · ${album.printedPages} page(s) · ${used} photo(s)`), h('div.spacer'),
          h('button.ghost.small', { disabled: !album.history?.undo, title: album.history?.undo ? `Annuler : ${album.history.undo} (Ctrl+Z)` : 'Rien à annuler', onclick: () => undoRedo('undo') }, '↶ Annuler'),
          h('button.ghost.small', { disabled: !album.history?.redo, title: album.history?.redo ? `Rétablir : ${album.history.redo} (Ctrl+Y)` : 'Rien à rétablir', onclick: () => undoRedo('redo') }, '↷ Rétablir'),
          h('label.row', { style: { gap: '6px' }, title: 'Présenter les pages en vis-à-vis, comme dans le livre (la page 1 est seule, à droite)' }, spreads, 'Vue en planches'),
          h('label.row', { style: { gap: '6px' } }, guides, 'Marges de sécurité')),
        alerts.length || empties ? card(h('div.sect', alerts.length ? `⚠ ${alerts.length} alerte(s)` : 'Contrôles'),
          ...alerts.map(i => h('div.album-alert.' + i.level, i.message)),
          empties ? h('p.dim', `${empties} cadre(s) vide(s).`) : null) : null,
        album.spreads
          ? h('div.album-pages.spreads', ...planches().map(pl => pl.spread
              ? h('div.planche', pageView(album.pages[pl.spread - 1], pl.spread))
              : h('div.planche', pl.left ? pageView(album.pages[pl.left - 1], pl.left, 'left') : h('div.planche-blank'),
                  pl.right ? pageView(album.pages[pl.right - 1], pl.right, 'right') : h('div.planche-blank'))), addWrap)
          : h('div.album-pages', ...album.pages.map((pg, i) => pageView(pg, i + 1)), addWrap));
      sc.scrollTop = top;
    }

    // Choix d'une photo pour un cadre : recherche texte ou collection, vignettes cliquables.
    async function pickPhoto(n, s) {
      const q = h('input', { type: 'search', placeholder: 'Rechercher (titre, mots-clés, appareil…)' });
      const { list: colls } = await api('/collections');
      const coll = h('select', {}, h('option', { value: '' }, 'Toute la photothèque'), ...colls.map(c => h('option', { value: c.id }, c.name)));
      const gridEl = h('div.picker-grid'), count = h('small.dim');
      async function load() {
        const params = new URLSearchParams({ limit: 60, sort: 'captured_desc' });
        if (q.value.trim()) params.set('q', q.value.trim());
        if (coll.value) params.set('collectionId', coll.value);
        const r = await api('/photos?' + params);
        count.textContent = r.total > r.rows.length ? `${r.rows.length} premières sur ${r.total} — affinez la recherche` : `${r.total} photo(s)`;
        mount(gridEl, ...r.rows.map(p => h('button.picker-cell', { title: p.title || p.path || '', onclick: async () => { m.close(); await change(pageUrl(n), 'PUT', { slots: setSlot(n, s, p.id) }); } },
          p.thumb ? h('img', { src: p.thumb, alt: '' }) : h('span', '🖼️'))));
        if (!r.rows.length) gridEl.appendChild(h('p.dim', 'Aucune photo.'));
      }
      let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
      coll.addEventListener('change', load);
      const m = modal({ title: `${labelOf(n)} — cadre ${s + 1}`, wide: true, body: h('div', h('div.form', field('Recherche', q), field('Collection', coll)), count, gridEl) });
      await load(); q.focus();
    }

    function editProps() {
      const name = h('input', { type: 'text', value: album.name });
      const desc = h('textarea', { rows: 3 }, album.description || '');
      const fmt = formatFields(album);
      const m = modal({ title: "Propriétés de l'album", body: h('div', field('Nom', name), field('Description', desc), fmt.el,
        h('p.dim', 'Les gabarits sont proportionnels : changer de format conserve la mise en page.')), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => { const r = await change('', 'PUT', { name: name.value, description: desc.value, ...fmt.value() }); if (r) { m.close(); title.textContent = album.name; } } }, 'Enregistrer'),
      ] });
    }
    async function fillFromCollection() {
      const { list: colls } = await api('/collections');
      if (!colls.length) { toast("Aucune collection : créez-en une depuis la Photothèque.", 'bad'); return; }
      const coll = h('select', {}, ...colls.map(c => h('option', { value: c.id }, `${c.name} (${c.photo_count})`)));
      const lay = layoutSelect('quatre', { withTitle: false });
      const m = modal({ title: 'Remplir depuis une collection', body: h('div.form', field('Collection', coll), field('Gabarit des nouvelles pages', lay),
        h('p.dim', 'Les photos (300 au plus, de la plus ancienne à la plus récente) sont placées sur de nouvelles pages ajoutées à la fin.')), actions: [
        h('button.ghost', { onclick: () => m.close() }, 'Annuler'),
        h('button', { onclick: async () => { const r = await change('/fill', 'POST', { collectionId: coll.value, layout: lay.value }); if (r) { m.close(); toast(`${r.added} photo(s) placée(s) sur ${r.pagesAdded} page(s)`); } } }, 'Remplir'),
      ] });
    }

    // ---- PDF : aperçu (150 ppp, dans la page) et export d'impression (téléchargement) ----
    async function fetchPdf(params) {
      const res = await fetch('/api' + base + '/pdf?' + new URLSearchParams(params));
      if (!res.ok) { let msg = 'Échec de la production du PDF'; try { msg = (await res.json()).error || msg; } catch { /* corps non JSON */ } throw new Error(msg); }
      let report = null;
      try { report = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(res.headers.get('X-Pdf-Report') || ''), c => c.charCodeAt(0)))); } catch { /* compte rendu absent */ }
      return { blob: await res.blob(), report };
    }
    function pdfSummary(r) {
      if (!r) return [];
      const out = [h('p', `${r.pages} page(s)${r.layout === 'spreads' ? ` en ${r.pdfPages} planche(s)` : ''}, ${r.images} image(s), ${fmtBytes(r.bytes)} · ${r.width_mm} × ${r.height_mm} mm${r.bleed ? ` + fonds perdus ${albumMeta.bleedMm} mm` : ''}`)];
      const where = l => l.slice(0, 6).map(x => `p. ${x.page}`).join(', ') + (l.length > 6 ? '…' : '');
      const lost = r.unfilled.filter(u => u.reason !== 'cadre vide'), empty = r.unfilled.length - lost.length;
      if (lost.length) out.push(h('div.album-alert.bad', `${lost.length} cadre(s) sans photo lisible (${where(lost)})`));
      if (r.fromPreview.length) out.push(h('div.album-alert.warn', `${r.fromPreview.length} photo(s) prise(s) sur l'aperçu en cache, original indisponible : qualité réduite (${where(r.fromPreview)})`));
      if (r.edited?.length) out.push(h('p.dim', `${r.edited.length} photo(s) imprimée(s) dans leur version retouchée par défaut.`));
      if (r.fromCopy.length) out.push(h('div.album-alert', `${r.fromCopy.length} photo(s) prise(s) sur une copie identique, original indisponible (${where(r.fromCopy)})`));
      if (r.lowDpi.length) out.push(h('div.album-alert.warn', `${r.lowDpi.length} photo(s) sous la résolution visée (${where(r.lowDpi)})`));
      if (empty) out.push(h('p.dim', `${empty} cadre(s) vide(s)${r.quality === 'screen' ? ', grisés dans l’aperçu' : ', laissés au fond de page'}.`));
      return out;
    }
    async function previewPdf() {
      toast('Préparation de l’aperçu…');
      try {
        const { blob, report } = await fetchPdf({ quality: 'screen', inline: 1, layout: album.spreads ? 'spreads' : 'pages' });
        const src = URL.createObjectURL(blob);
        const m = modal({ title: `Aperçu — ${album.name}`, wide: true, body: h('div', ...pdfSummary(report), h('iframe.pdf-frame', { src, title: 'Aperçu PDF' })),
          actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer'), h('button', { onclick: () => { m.close(); exportPdf(); } }, 'Exporter pour l’impression…')] });
        new MutationObserver((_, o) => { if (!m.box.isConnected) { URL.revokeObjectURL(src); o.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
      } catch (e) { toast(e.message, 'bad'); }
    }
    function exportPdf() {
      const prof = h('select', {}, ...Object.entries(albumMeta.pdfProfiles).map(([k, p]) => h('option', { value: k }, p.label)));
      const bleed = h('input', { type: 'checkbox' });
      const disp = h('select', {}, h('option', { value: 'pages' }, 'Page par page (pour l’imprimeur)'), h('option', { value: 'spreads', selected: !!album.spreads }, 'Planches : pages en vis-à-vis (pour l’écran)'));
      const bad = album.issues.filter(i => i.level === 'bad');
      const status = h('div');
      const go2 = h('button', { onclick: async () => {
        go2.disabled = true; mount(status, h('p.dim', 'Production du PDF… (les photos sont rééchantillonnées depuis les originaux)'));
        try {
          const { blob, report } = await fetchPdf({ quality: prof.value, bleed: bleed.checked ? 1 : 0, layout: disp.value });
          const a = h('a', { href: URL.createObjectURL(blob), download: (album.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'album') + '.pdf' });
          document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
          mount(status, h('p', '✓ PDF enregistré dans le dossier de téléchargement du navigateur.'), ...pdfSummary(report));
          toast('PDF produit');
        } catch (e) { mount(status, h('div.album-alert.bad', e.message)); }
        go2.disabled = false;
      } }, 'Produire le PDF');
      const m = modal({ title: 'Exporter en PDF', body: h('div',
        h('div.form', field('Qualité', prof), field('Disposition', disp)),
        h('label.row', { style: { gap: '6px' } }, bleed, `Ajouter des fonds perdus de ${albumMeta.bleedMm} mm (imprimeur : la page est agrandie, les photos pleine page débordent, la coupe se fait au format)`),
        bad.length ? h('div.album-alert.bad', `${bad.length} alerte(s) bloquante(s) dans l’album : ${bad[0].message}${bad.length > 1 ? '…' : ''}`) : null,
        h('p.dim', 'Les originaux sont lus sans être modifiés. Une photo n’est jamais agrandie au-delà de sa résolution réelle.'),
        status), actions: [h('button.ghost', { onclick: () => m.close() }, 'Fermer'), go2] });
    }

    const title = h('h2.page-title', album.name);
    mount(v,
      h('div.row', title, h('div.spacer'),
        h('button.ghost.small', { onclick: () => go('albums') }, '← Albums'),
        h('button.ghost.small', { onclick: editProps }, 'Propriétés…'),
        h('button.ghost.small', { onclick: fillFromCollection }, 'Remplir depuis une collection…'),
        h('button.ghost.small', { onclick: () => { state.q = ''; state.facet = { albumId: album.id }; state.page = 0; go('photos'); } }, 'Voir ses photos'),
        h('button.ghost.small', { onclick: previewPdf }, 'Aperçu'),
        h('button.small', { onclick: exportPdf }, 'Exporter en PDF…'),
        h('a.btn.ghost.small', { href: '/api' + base + '/export', download: '' }, 'Exporter le projet'),
        h('button.danger.small', { onclick: async () => { if (await confirmDialog("Supprimer l'album", `Supprimer « ${album.name} » ? Les photos restent dans la photothèque ; seul l'album disparaît.`)) { await api(base, 'DELETE'); toast('Album supprimé (photos conservées)'); go('albums'); } } }, 'Supprimer')),
      body);
    render();
  }
  // ---------- Doublons et photos similaires (lib/duplicates.mjs) : comparer, désigner, jamais supprimer ----------
  async function viewDuplicates(v) {
    state.dup ??= { level: 'exact', threshold: null, seconds: null, limit: 30 };
    const S = state.dup;
    const qs = extra => new URLSearchParams(Object.fromEntries(Object.entries({ threshold: S.threshold ?? '', seconds: S.seconds ?? '', ...extra }).filter(([, x]) => x !== '' && x != null)));
    let sum = await api('/duplicates/summary?' + qs());
    S.threshold ??= sum.defaults.threshold; S.seconds ??= sum.defaults.seconds;
    const body = h('div.dup-list'), tabs = h('div.row.dup-tabs'), opts = h('div.row'), hashCard = h('div');
    const HELP = {
      exact: 'Même contenu au bit près (empreinte SHA-256). Une photo présente en plusieurs fichiers apparaît seule, avec la liste de ses fichiers.',
      potential: 'Même nom de fichier et mêmes dimensions, ou même instant de prise de vue avec le même appareil — mais contenu différent. À vérifier.',
      similar: 'Empreinte visuelle proche : même image retouchée, réduite, recadrée, réenregistrée… Plus la tolérance est haute, plus les rapprochements sont larges.',
      burst: 'Photos prises en rafale par le même appareil, à quelques secondes d’intervalle.',
    };

    function photoCol(g, p) {
      const isRef = p.isReference, isVar = !!p.reference && !isRef;
      // le premier fichier listé est celui qu'utilisent l'affichage, les albums et l'export
      const fileRows = p.files.map((f, k) => h('div.dup-file' + (f.available ? '' : '.off'),
        h('span', { title: f.path }, f.path),
        h('small.dim', [f.support, f.bytes != null ? fmtBytes(f.bytes) : null, f.available ? null : 'indisponible', g.kind === 'files' ? (k === 0 ? 'fichier de référence' : 'copie') : null].filter(Boolean).join(' · ')),
        g.kind === 'files' && k > 0 ? h('button.ghost.small', { onclick: async () => { await api('/duplicates/reference-file', 'POST', { fileId: f.id }); toast('Fichier de référence choisi (les autres fichiers restent indexés comme copies)'); load(); } }, 'Fichier de référence') : null,
        p.files.length > 1 ? h('button.ghost.small.danger', { title: 'Retire ce fichier du catalogue ; il reste sur le disque', onclick: async () => {
          if (!(await confirmDialog('Supprimer la fiche', `Supprimer la fiche de ce fichier du catalogue ?\n\n${f.path}\n\nLe fichier n’est ni effacé ni déplacé : il reste sur le disque et ne sera plus réindexé. La photo garde ses ${p.files.length - 1} autre(s) fichier(s), ses mots-clés et ses retouches.`))) return;
          try { await api('/duplicates/remove', 'POST', { fileId: f.id }); toast('Fiche supprimée. Fichier conservé sur le disque.'); load(true); } catch (e) { toast(e.message, 'bad'); }
        } }, 'Supprimer la fiche…') : null));
      return h('div.dup-photo' + (isRef ? '.ref' : ''),
        h('div.dup-thumb', { onclick: () => lightboxOpen(g.photos, g.photos.indexOf(p), () => {}) }, p.thumb ? h('img', { src: p.thumb, alt: '', loading: 'lazy' }) : h('span', '🖼️'),
          isRef ? h('span.dup-badge', '★ Référence') : isVar ? h('span.dup-badge.var', 'Variante') : null),
        h('div.dup-meta',
          h('div', h('b', p.width && p.height ? `${p.width} × ${p.height}` : 'dimensions inconnues'), p.bytes != null ? ` · ${fmtBytes(p.bytes)}` : '', p.format ? ` · ${p.format.toUpperCase()}` : ''),
          h('div.dim', [p.captured_at ? fmtDateTime(p.captured_at) : 'sans date', p.camera].filter(Boolean).join(' · ')),
          p.edits ? h('div.dim', `✎ ${p.edits} version(s) retouchée(s)`) : null,
          p.missing ? h('div.album-alert.warn', 'Indisponible (support absent ?)') : null,
          ...fileRows),
        g.photos.length > 1 ? h('div.row.wrap',
          isRef ? null : h('button.small', { title: 'Les autres photos du groupe deviennent ses variantes (rien n’est supprimé)', onclick: async () => { await api('/duplicates/reference', 'POST', { photoIds: g.photos.map(x => x.id), reference: p.id }); toast('Référence désignée, variantes conservées'); load(); } }, '★ Référence'),
          h('button.ghost.small.danger', { title: 'Retire cette photo du catalogue ; ses fichiers restent sur le disque', onclick: async () => {
            const lost = [p.edits ? `${p.edits} version(s) retouchée(s)` : null, 'ses mots-clés, sa note et sa légende'].filter(Boolean).join(', ');
            if (!(await confirmDialog('Supprimer la fiche', `Supprimer la fiche de cette photo (${p.width ?? '?'} × ${p.height ?? '?'}) du catalogue ? Avec elle disparaissent ${lost} ; un album qui l’utilisait signalera son cadre.\n\nSes ${p.files.length} fichier(s) ne sont ni effacés ni déplacés : ils restent sur le disque et ne seront plus réindexés.`))) return;
            try { await api('/duplicates/remove', 'POST', { photoId: p.id }); toast('Fiche supprimée. Fichiers conservés sur le disque.'); load(true); } catch (e) { toast(e.message, 'bad'); }
          } }, 'Supprimer la fiche…')) : null);
    }
    function groupCard(g) {
      const hasRef = g.photos.some(p => p.isReference || p.reference);
      return card(
        h('div.row', h('b', g.photos.length > 1 ? `${g.photos.length} photos` : `${g.photos[0]?.files.length ?? 0} fichiers`), h('span.dim', g.reason), h('div.spacer'),
          hasRef ? h('button.ghost.small', { onclick: async () => { await api('/duplicates/reference', 'POST', { photoIds: g.photos.map(x => x.id), clear: true }); load(); } }, 'Annuler la référence') : null,
          g.photos.length > 1 ? h('button.ghost.small', { title: 'Ce groupe ne sera plus proposé', onclick: async () => { await api('/duplicates/ignore', 'POST', { photoIds: g.photos.map(x => x.id) }); toast('Groupe écarté : ces photos sont distinctes'); load(); } }, 'Ce ne sont pas des doublons') : null),
        h('div.dup-row', ...g.photos.map(p => photoCol(g, p))));
    }

    async function computeHashes(all = false) {
      const { jobId } = await api('/duplicates/hashes', 'POST', { all });
      let job;
      do { await new Promise(r => setTimeout(r, 400)); job = (await api('/jobs/' + jobId)).job; mount(hashCard, card(h('p.dim', `Calcul des empreintes visuelles… ${job.done ?? 0} / ${job.total || '?'}`))); } while (job.status === 'running');
      if (job.status === 'error') toast(job.error, 'bad'); else toast(`${job.result.computed} empreinte(s) calculée(s)${job.result.failed ? `, ${job.result.failed} photo(s) illisible(s)` : ''}`);
      load(true);
    }

    async function load(refreshSummary = false) {
      if (refreshSummary) { sum = await api('/duplicates/summary?' + qs()); drawOpts(); } // compteurs des boutons d'options
      mount(tabs, ...Object.entries(sum.levels).map(([k, label]) => h('button.small' + (S.level === k ? '' : '.ghost'), { onclick: () => { S.level = k; S.limit = 30; drawOpts(); load(); } }, `${label} (${sum[k]})`)));
      mount(hashCard, sum.hashesMissing ? card(h('div.row', h('span', `${sum.hashesMissing} photo(s) n’ont pas encore d’empreinte visuelle : elles n’apparaissent pas dans les photos similaires.`), h('div.spacer'), h('button.small', { onclick: () => computeHashes(false) }, 'Calculer'))) : null);
      const r = await api('/duplicates?' + qs({ level: S.level, limit: S.limit }));
      mount(body,
        h('p.dim', HELP[S.level] + ' Rien n’est jamais supprimé automatiquement.'),
        r.groups.length ? null : h('div.empty', h('div.big', '✓'), 'Aucun groupe à ce niveau.'),
        ...r.groups.map(groupCard),
        r.total > r.groups.length ? h('button.ghost', { onclick: () => { S.limit += 30; load(); } }, `Afficher plus (${r.groups.length} sur ${r.total})`) : null);
    }
    function drawOpts() {
      if (S.level === 'similar') {
        const out = h('span.rt-val', String(S.threshold));
        const range = h('input', { type: 'range', min: 0, max: sum.defaults.maxThreshold, step: 1, value: S.threshold });
        range.addEventListener('input', () => { out.textContent = range.value; });
        range.addEventListener('change', () => { S.threshold = +range.value; load(true); });
        mount(opts, h('label.row', { style: { gap: '8px' } }, 'Tolérance', range, out, h('small.dim', '0 = quasi identiques · 8 = conseillé · 20 = large')),
          h('div.spacer'), h('button.ghost.small', { title: 'Recalculer toutes les empreintes (après une mise à jour des vignettes, par exemple)', onclick: () => computeHashes(true) }, 'Recalculer les empreintes'));
      } else if (S.level === 'burst') {
        const sec = h('input', { type: 'number', min: 0.5, max: 60, step: 0.5, value: S.seconds, style: { width: '80px' } });
        sec.addEventListener('change', () => { S.seconds = +sec.value; load(true); });
        mount(opts, h('label.row', { style: { gap: '8px' } }, 'Intervalle maximal (secondes)', sec));
      } else clear(opts);
      if (sum.excludedFiles) opts.appendChild(h('button.ghost.small', { title: 'Les fichiers dont la fiche a été supprimée pourront de nouveau être indexés (à la prochaine indexation de leur dossier)', onclick: async () => {
        if (!(await confirmDialog('Réautoriser les fichiers écartés', `${sum.excludedFiles} fichier(s) dont la fiche a été supprimée pourront de nouveau être indexés. Rien n’est indexé tout de suite : ils reviendront à la prochaine indexation de leur dossier.`))) return;
        await api('/duplicates/remove', 'POST', { reset: true }); toast('Fichiers écartés réautorisés'); load(true); } }, `Réautoriser les fichiers écartés (${sum.excludedFiles})`));
      if (sum.ignoredPairs) opts.appendChild(h('button.ghost.small', { title: 'Reproposer les groupes déclarés « pas des doublons »', onclick: async () => { await api('/duplicates/ignore', 'POST', { reset: true }); load(true); } }, `Reproposer les groupes écartés (${sum.ignoredPairs} paire(s))`));
    }

    mount(v, h('h2.page-title', 'Doublons et photos similaires'), tabs, hashCard, opts, body);
    drawOpts(); await load();
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
