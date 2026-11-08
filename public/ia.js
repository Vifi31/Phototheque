// Assistant IA (frontend) : extension facultative, routes /api/ai/* (lib/ai.mjs).
// Tout ce que produit l'IA est présenté comme une SUGGESTION, à accepter ou refuser.
'use strict';
const IA = (() => {
  const { h, clear, mount, fmtNum, fmtDateTime, kpi, card, table, field, toast, modal, confirmDialog, lightboxOpen } = UI;
  const api = (...a) => App.api(...a);
  const pct = x => Math.round((x ?? 0) * 100) + ' %';
  const TABS = [
    { id: 'suggestions', label: 'Suggestions', icon: '💡' },
    { id: 'search', label: 'Recherche', icon: '🔎' },
    { id: 'groups', label: 'Regroupements', icon: '🧩' },
    { id: 'settings', label: 'Réglages', icon: '⚙️' },
  ];
  const ui = { tab: 'suggestions', photoId: null, q: '', source: '', kind: '', value: '', sel: new Set(), poll: null };

  /** Ouvre la vue sur un onglet (depuis la visionneuse : photos proches d'une photo). */
  function open(tab, photoId = null) { ui.tab = tab; if (photoId) ui.photoId = photoId; App.go('ia'); }
  function openInLibrary(ids) { App.state.q = ''; App.state.facet = { ids: ids.slice(0, 500).join(',') }; App.state.page = 0; App.go('photos'); }

  function thumbCard(c, { badge = null, sub = null, actions = [], list = null, index = 0, selectable = null } = {}) {
    if (!c) return null;
    return h('div.ia-card',
      h('div.ia-thumb', { onclick: () => lightboxOpen(list ?? [c], list ? index : 0, () => {}) }, c.thumb ? h('img', { src: c.thumb, alt: '', loading: 'lazy' }) : h('span', '🖼️'),
        selectable ? h('input', { type: 'checkbox', class: 'ia-check', checked: selectable.checked, onclick: e => { e.stopPropagation(); selectable.onchange(e.target.checked); } }) : null),
      h('div.ia-body', h('div.ia-title', { title: c.title || c.file_name || '' }, c.title || c.file_name || 'Sans titre'), badge, sub ? h('small.dim', sub) : null,
        actions.length ? h('div.row.ia-actions', ...actions) : null));
  }
  const aiBadge = text => h('span.pill.accent.ia-badge', { title: 'Proposé par l’IA : rien n’est attribué sans votre validation' }, '🤖 ' + text);

  async function view(v) {
    clearInterval(ui.poll); ui.poll = null;
    const st = await api('/ai');
    App.state.aiEnabled = st.settings.enabled;
    clear(v);
    v.appendChild(h('h2.page-title', 'Assistant IA ', h('span.pill', 'facultatif · local')));
    if (!st.settings.enabled && ui.tab !== 'settings') {
      v.appendChild(card(h('h3', 'L’assistant IA est désactivé'),
        h('p', 'Il propose des mots-clés, des lieux et des regroupements, retrouve des photos visuellement proches et permet une recherche par description. Ce ne sont que des ', h('b', 'suggestions'), ' : rien n’est attribué sans votre validation, et les originaux ne sont jamais modifiés.'),
        h('p', 'Le moteur intégré fonctionne ', h('b', 'sur cet ordinateur'), ', sans modèle à télécharger ni carte graphique : il analyse les vignettes (couleurs, composition, textures) et s’appuie sur ce que vous avez déjà décrit. Des moteurs plus puissants (programme local, serveur Ollama) peuvent être ajoutés dans les réglages.'),
        h('div.row', h('button', { onclick: async () => { await api('/ai/settings', 'PUT', { enabled: true }); toast('Assistant IA activé'); view(v); } }, 'Activer l’assistant IA'),
          h('button.ghost', { onclick: () => { ui.tab = 'settings'; view(v); } }, 'Réglages…'))));
      return;
    }
    const pend = st.suggestions.pending, extActive = st.engines.filter(e => !e.builtin && e.active).length;
    v.appendChild(h('div.kpis', kpi('Photos analysées', `${fmtNum(st.analysed)} / ${fmtNum(st.photos)}`, { tone: st.analysed < st.photos ? 'warn' : 'ok' }),
      kpi('Suggestions en attente', fmtNum(pend), { sub: `${fmtNum(st.suggestions.accepted)} acceptée(s) · ${fmtNum(st.suggestions.rejected)} refusée(s)` }),
      kpi('Moteurs', String(1 + extActive), { sub: extActive ? `intégré + ${extActive} externe(s)` : 'moteur intégré' })));
    const jobBox = h('div'); v.appendChild(jobBox);
    renderJob(jobBox, st, () => view(v));
    v.appendChild(h('div.tabs', ...TABS.map(t => h('button' + (t.id === ui.tab ? '.active' : ''), { onclick: () => { ui.tab = t.id; view(v); } }, t.icon + ' ' + t.label + (t.id === 'suggestions' && pend ? ` (${fmtNum(pend)})` : '')))));
    const body = h('div'); v.appendChild(body);
    try {
      if (ui.tab === 'suggestions') await suggestionsTab(body, st, () => view(v));
      else if (ui.tab === 'search') await searchTab(body, st);
      else if (ui.tab === 'groups') await groupsTab(body, st);
      else await settingsTab(body, st, () => view(v));
    } catch (e) { mount(body, h('div.empty', h('div.big', '⚠️'), e.message)); }
  }

  // ---------- analyse ----------
  function renderJob(box, st, reload) {
    const j = st.job, running = j && ['running', 'paused'].includes(j.status);
    if (!st.settings.enabled) return clear(box);
    const left = st.photos - st.analysed;
    const ctl = action => api('/ai/analyse/control', 'POST', { action }).then(() => tick());
    const bar = h('div.progress', h('i', { style: { width: running && j.total ? (j.done * 100 / j.total) + '%' : '0%' } }));
    const info = h('small.dim');
    mount(box, card(h('div.row', h('b', running ? (j.status === 'paused' ? '⏸ Analyse en pause' : '⏳ Analyse en cours…') : '🤖 Analyse des photos'),
      running ? null : h('button.small', { onclick: async () => { try { await api('/ai/analyse', 'POST', {}); tick(); } catch (e) { toast(e.message, 'bad'); } } }, left ? `Analyser ${fmtNum(left)} photo(s) nouvelle(s)` : 'Compléter l’analyse'),
      running ? null : h('button.small.ghost', { title: 'Recalcule tout (après un changement de moteur, par exemple)', onclick: async () => { if (await confirmDialog('Tout réanalyser', `Réanalyser les ${fmtNum(st.photos)} photo(s) ? Les suggestions déjà acceptées ou refusées sont gardées.`)) { await api('/ai/analyse', 'POST', { all: true }); tick(); } } }, 'Tout réanalyser'),
      running ? null : h('button.small.ghost', { title: 'Recalcule les suggestions sans réanalyser les images', onclick: async () => { const r = await api('/ai/suggestions/refresh', 'POST'); toast(`${fmtNum(r.pending)} suggestion(s) en attente`); reload(); } }, '↻ Suggestions'),
      running && j.status === 'running' ? h('button.small.ghost', { onclick: () => ctl('pause') }, '⏸ Pause') : null,
      running && j.status === 'paused' ? h('button.small.ghost', { onclick: () => ctl('resume') }, '▶ Reprendre') : null,
      running ? h('button.small.ghost.danger', { onclick: () => ctl('stop') }, '■ Arrêter') : null),
    running ? bar : null, info));
    const say = jj => {
      if (!jj) { info.textContent = left ? `${fmtNum(left)} photo(s) pas encore analysée(s). L’analyse tourne en arrière-plan, une photo à la fois, avec une pause de ${st.settings.pauseMs} ms entre deux.` : 'Toutes les photos sont analysées.'; return; }
      if (['running', 'paused'].includes(jj.status)) info.textContent = `${fmtNum(jj.done)} / ${fmtNum(jj.total)} photo(s)${jj.failed ? ` · ${fmtNum(jj.failed)} illisible(s)` : ''}`;
      else info.textContent = `Dernière analyse ${fmtDateTime(jj.endedAt)} : ${fmtNum(jj.result?.analysed ?? 0)} photo(s)${jj.failed ? `, ${fmtNum(jj.failed)} illisible(s) (support absent ?)` : ''}${jj.result?.stopped ? ' — arrêtée' : ''}${jj.result?.suggestions ? ` · ${fmtNum(jj.result.suggestions.pending)} suggestion(s) en attente` : ''}${jj.errors?.length ? ' · ' + jj.errors.at(-1).error : ''}.`;
    };
    say(j);
    async function tick() {
      clearInterval(ui.poll);
      ui.poll = setInterval(async () => {
        if (!document.body.contains(box)) { clearInterval(ui.poll); return; }
        const r = await api('/ai/analyse'); const jj = r.job;
        bar.firstChild.style.width = jj?.total ? (jj.done * 100 / jj.total) + '%' : '0%'; say(jj);
        if (!jj || !['running', 'paused'].includes(jj.status)) { clearInterval(ui.poll); toast('Analyse terminée'); reload(); }
      }, 800);
      reload();
    }
    if (running && !ui.poll) ui.poll = setInterval(async () => {
      if (!document.body.contains(box)) { clearInterval(ui.poll); return; }
      const jj = (await api('/ai/analyse')).job; bar.firstChild.style.width = jj?.total ? (jj.done * 100 / jj.total) + '%' : '0%'; say(jj);
      if (!jj || !['running', 'paused'].includes(jj.status)) { clearInterval(ui.poll); ui.poll = null; reload(); }
    }, 800);
  }

  // ---------- suggestions ----------
  async function suggestionsTab(body, st, reload) {
    const qs = new URLSearchParams({ limit: 120 }); if (ui.source) qs.set('source', ui.source); if (ui.kind) qs.set('kind', ui.kind); if (ui.value) qs.set('value', ui.value);
    const r = await api('/ai/suggestions?' + qs);
    ui.sel = new Set([...ui.sel].filter(id => r.rows.some(x => x.id === id)));
    const list = r.rows.map(x => x.card).filter(Boolean);
    async function decide(ids, ok) {
      if (!ids.length) return;
      try {
        if (ok) {
          const a = await api('/ai/suggestions/accept', 'POST', { ids });
          toast(`${fmtNum(a.accepted)} suggestion(s) acceptée(s)`);
          undoBar(a);
        } else { const x = await api('/ai/suggestions/reject', 'POST', { ids }); toast(`${fmtNum(x.rejected)} suggestion(s) refusée(s) : elles ne seront plus proposées`); }
        ui.sel.clear(); reload();
      } catch (e) { toast(e.message, 'bad'); }
    }
    const sourceSel = h('select', { onchange: e => { ui.source = e.target.value; ui.value = ''; reload(); } }, h('option', { value: '' }, 'Toutes les sources'),
      ...Object.entries(r.sources).map(([k, l]) => h('option', { value: k, selected: k === ui.source }, l)));
    const kindSel = h('select', { onchange: e => { ui.kind = e.target.value; ui.value = ''; reload(); } }, ...[['', 'Mots-clés et lieux'], ['keyword', 'Mots-clés'], ['place', 'Lieux']].map(([k, l]) => h('option', { value: k, selected: k === ui.kind }, l)));
    mount(body,
      h('p.dim', 'Chaque proposition indique sa source et sa confiance. Accepter ajoute le mot-clé (ou remplit le lieu s’il est vide) par un lot de métadonnées annulable ; refuser l’écarte définitivement.'),
      h('div.row.ia-filters', sourceSel, kindSel,
        ui.value ? h('button.ghost.small', { onclick: () => { ui.value = ''; reload(); } }, '✕ ' + (r.byValue.find(b => b.value === ui.value)?.label ?? ui.value)) : null,
        h('span.spacer'),
        r.rows.length ? h('button.small', { onclick: () => decide(ui.sel.size ? [...ui.sel] : r.rows.map(x => x.id), true) }, ui.sel.size ? `✓ Accepter la sélection (${ui.sel.size})` : `✓ Tout accepter (${fmtNum(r.rows.length)})`) : null,
        r.rows.length ? h('button.small.ghost', { onclick: () => decide(ui.sel.size ? [...ui.sel] : r.rows.map(x => x.id), false) }, ui.sel.size ? `✕ Refuser la sélection` : `✕ Tout refuser`) : null,
        st.suggestions.rejected ? h('button.small.ghost', { title: 'Les refus seront oubliés : ces suggestions pourront revenir au prochain calcul', onclick: async () => { if (await confirmDialog('Réexaminer les refus', `Oublier les ${fmtNum(st.suggestions.rejected)} refus ?`)) { await api('/ai/suggestions/forget', 'POST'); reload(); } } }, 'Réexaminer les refus') : null),
      r.byValue.length > 1 && !ui.value ? h('div.ia-values', ...r.byValue.map(b => h('button.chip', { onclick: () => { ui.value = b.value; ui.kind = b.kind; reload(); }, title: `Confiance moyenne ${pct(b.score)}` }, `${b.kind === 'place' ? '📍 ' : '🏷️ '}${b.label} `, h('b', fmtNum(b.n))))) : null,
      r.rows.length ? h('div.ia-grid', ...r.rows.map((x, i) => thumbCard(x.card, {
        list, index: list.indexOf(x.card),
        badge: aiBadge(`${x.kind === 'place' ? '📍 ' : ''}${x.label} · ${pct(x.score)}`),
        sub: x.sourceLabel + (x.detail?.distanceKm != null ? ` (${String(x.detail.distanceKm).replace('.', ',')} km)` : '') + (x.detail?.photos ? ` (${x.detail.portent ?? ''}${x.detail.portent ? ' / ' : ''}${x.detail.photos} photos)` : ''),
        selectable: { checked: ui.sel.has(x.id), onchange: on => (on ? ui.sel.add(x.id) : ui.sel.delete(x.id)) },
        actions: [h('button.small', { title: 'Accepter', onclick: () => decide([x.id], true) }, '✓'), h('button.small.ghost', { title: 'Refuser', onclick: () => decide([x.id], false) }, '✕'),
          st.settings.features.similar ? h('button.small.ghost', { title: 'Photos visuellement proches', onclick: () => { ui.photoId = x.photoId; ui.tab = 'search'; App.go('ia'); } }, '≈') : null].filter(Boolean),
      }))) : h('div.empty', h('div.big', '💡'), st.analysed ? 'Aucune suggestion en attente.' : 'Lancez l’analyse pour obtenir des suggestions.'),
      r.total > r.rows.length ? h('p.dim', `${fmtNum(r.rows.length)} affichée(s) sur ${fmtNum(r.total)} : acceptez ou refusez pour voir la suite, ou filtrez par valeur.`) : null);
  }
  function undoBar(a) {
    if (!a.batches?.length) return;
    let m = null;
    const undo = h('button.ghost', { onclick: async () => { m.close(); const u = await api('/ai/suggestions/undo', 'POST', { ids: a.ids, batches: a.batches.map(b => b.batchId) }); toast(`${fmtNum(u.restored)} valeur(s) rétablie(s) ; suggestions remises en attente`); App.go('ia'); } }, 'Annuler ces ajouts');
    m = modal({ title: 'Suggestions acceptées', body: h('div', h('p', `${fmtNum(a.accepted)} suggestion(s) appliquée(s) en ${a.batches.length} lot(s) de métadonnées :`),
      h('ul', ...a.batches.map(b => h('li', `${b.kind === 'place' ? 'Lieu' : 'Mot-clé'} « ${b.value.split('|').filter(Boolean).join(', ')} » : ${fmtNum(b.photos)} photo(s)`))),
      h('p.dim', 'Les lots restent annulables plus tard depuis l’historique des métadonnées.')),
    actions: [undo, h('button', { onclick: () => m.close() }, 'Fermer')] });
  }

  // ---------- recherche ----------
  async function searchTab(body, st) {
    const out = h('div'), simBox = h('div');
    const input = h('input', { type: 'search', placeholder: 'Ex. : ciel bleu, coucher de soleil, nuit, forêt verte, noir et blanc…', value: ui.q, style: { flex: '1', minWidth: '260px' } });
    async function run() {
      ui.q = input.value.trim(); if (!ui.q) { clear(out); return; }
      mount(out, h('p.dim', 'Recherche…'));
      try {
        const r = await api('/ai/describe?' + new URLSearchParams({ q: ui.q, limit: 60 }));
        const list = r.rows.map(x => x.card).filter(Boolean);
        const TYPE = { colour: 'couleur', scene: 'scène', light: 'lumière', text: 'texte' };
        mount(out, h('div.row', h('small.dim', 'Compris : '), ...r.terms.map(t => h('span.pill', { title: t.type === 'text' ? 'Cherché dans les titres, légendes, mots-clés et descriptions des moteurs' : 'Calculé sur l’image par le moteur intégré' }, `${t.word} → ${TYPE[t.type]}`)),
          h('span.spacer'), r.rows.length ? h('button.small.ghost', { onclick: () => openInLibrary(r.rows.map(x => x.id)) }, 'Ouvrir dans la Photothèque') : null),
        r.rows.length ? h('div.ia-grid', ...r.rows.map(x => thumbCard(x.card, { list, index: list.indexOf(x.card), badge: aiBadge('pertinence ' + pct(x.score)), sub: x.why.join(' · '),
          actions: st.settings.features.similar ? [h('button.small.ghost', { onclick: () => { ui.photoId = x.id; similarBox(simBox, st); simBox.scrollIntoView({ behavior: 'smooth' }); } }, '≈ Proches')] : [] }))) : h('p.dim', 'Aucune photo ne correspond à tous les mots.'),
        r.engines ? null : h('p.dim', 'Sans moteur externe, la description est comprise à partir des couleurs, de la lumière, de quelques scènes (ciel, végétation, nuit, coucher de soleil, noir et blanc) et du texte de vos fiches.'));
      } catch (e) { mount(out, h('p.dim', e.message)); }
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
    mount(body, st.settings.features.describe ? card(h('h3', 'Recherche par description'), h('div.row', input, h('button', { onclick: run }, 'Chercher')), out) : null, simBox);
    if (ui.q) run();
    if (st.settings.features.similar) similarBox(simBox, st);
  }
  async function similarBox(box, st) {
    if (!ui.photoId) { mount(box, card(h('h3', 'Images visuellement proches'), h('p.dim', 'Choisissez une photo : bouton « ≈ Proches » ci-dessus, ou « 🤖 Photos proches » dans la visionneuse de la Photothèque.'))); return; }
    mount(box, card(h('p.dim', 'Recherche des photos proches…')));
    const minSel = h('select', { onchange: () => load() }, ...[['', 'Proximité normale'], ['0.85', 'Très proches'], ['0.65', 'Large']].map(([k, l]) => h('option', { value: k }, l)));
    async function load() {
      const r = await api('/ai/similar?' + new URLSearchParams({ photoId: ui.photoId, limit: 60, ...(minSel.value ? { min: minSel.value } : {}) }));
      const list = r.rows.map(x => x.card).filter(Boolean);
      mount(box, card(h('div.row.ia-filters', h('h3', 'Images visuellement proches'), h('span.spacer'), minSel, r.rows.length ? h('button.small.ghost', { onclick: () => openInLibrary([ui.photoId, ...r.rows.map(x => x.id)]) }, 'Ouvrir dans la Photothèque') : null),
        h('div.ia-ref', r.me ? thumbCard(r.me, { badge: h('span.pill', 'photo de référence') }) : null,
          !r.analysed ? h('p.dim', 'Cette photo n’est pas encore analysée : lancez l’analyse.') : r.rows.length ? null : h('p.dim', 'Aucune photo assez proche.')),
        r.rows.length ? h('div.ia-grid', ...r.rows.map(x => thumbCard(x.card, { list, index: list.indexOf(x.card), badge: aiBadge('ressemblance ' + pct(x.score)),
          actions: [h('button.small.ghost', { onclick: () => { ui.photoId = x.id; load(); } }, '≈ Proches')] }))) : null,
        h('p.dim', 'Ressemblance calculée sur les couleurs, la composition et les textures (moteur intégré). Pour les copies retouchées ou réenregistrées, voir aussi l’outil Doublons.')));
    }
    try { await load(); } catch (e) { mount(box, card(h('p.dim', e.message))); }
  }

  // ---------- regroupements ----------
  async function groupsTab(body, st) {
    const g1 = h('div'), g2 = h('div');
    mount(body, g1, g2);
    async function collect(name, ids) {
      const nm = await askName(name); if (!nm) return;
      const r = await api('/ai/collection', 'POST', { name: nm, ids }); toast(`Collection « ${r.collection.name} » créée (${fmtNum(ids.length)} photo(s))`);
    }
    if (st.settings.features.classify) {
      mount(g2, card(h('p.dim', 'Recherche des séances…')));
      try {
        const r = await api('/ai/events');
        mount(g2, card(h('h3', 'Séances et événements'), h('p.dim', `Photos prises à moins de ${String(r.hours).replace('.', ',')} h d’intervalle, avec le lieu et les mots-clés les plus fréquents : une suggestion de classement en collection.`),
          r.events.length ? h('div.ia-groups', ...r.events.map(e => h('div.ia-group', h('div.row', h('b', e.name), aiBadge(`${fmtNum(e.count)} photos`), h('span.spacer'),
            h('button.small.ghost', { onclick: () => openInLibrary(e.ids) }, 'Voir'), h('button.small', { onclick: () => collect(e.name, e.ids) }, 'Créer une collection…')),
            e.keywords.length ? h('small.dim', 'Mots-clés fréquents : ' + e.keywords.join(', ')) : null,
            h('div.ia-strip', ...e.cards.map((c, i) => h('img', { src: c.thumb, alt: '', loading: 'lazy', onclick: () => lightboxOpen(e.cards, i, () => {}) })))))) : h('p.dim', 'Aucune séance d’au moins 3 photos datées.')));
      } catch (e) { mount(g2, card(h('p.dim', e.message))); }
    }
    if (st.settings.features.groups) {
      mount(g1, card(h('p.dim', 'Regroupement…')));
      try {
        const r = await api('/ai/groups');
        mount(g1, card(h('h3', 'Images semblables'), h('p.dim', 'Photos qui se ressemblent (couleurs, composition, textures), quelle que soit leur date.'),
          r.groups.length ? h('div.ia-groups', ...r.groups.map((g, k) => h('div.ia-group', h('div.row', h('b', `Groupe ${k + 1}`), aiBadge(`${fmtNum(g.count)} photos · cohésion ${pct(g.cohesion)}`), g.colours.length ? h('small.dim', 'dominante ' + g.colours.join(', ')) : null, h('span.spacer'),
            h('button.small.ghost', { onclick: () => openInLibrary(g.ids) }, 'Voir'), h('button.small', { onclick: () => collect(`Photos semblables ${k + 1}`, g.ids) }, 'Créer une collection…')),
            h('div.ia-strip', ...g.cards.map((c, i) => h('img', { src: c.thumb, alt: '', loading: 'lazy', onclick: () => lightboxOpen(g.cards, i, () => {}) })))))) : h('p.dim', st.analysed ? 'Aucun groupe de photos semblables.' : 'Lancez l’analyse pour regrouper les photos.')));
      } catch (e) { mount(g1, card(h('p.dim', e.message))); }
    }
  }
  function askName(def) {
    return new Promise(resolve => {
      const inp = h('input', { type: 'text', value: def, style: { width: '100%' } });
      let done = false; const fin = v => { if (!done) { done = true; m.close(); resolve(v); } };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') fin(inp.value.trim() || def); });
      const m = modal({ title: 'Nouvelle collection', body: field('Nom', inp), actions: [h('button.ghost', { onclick: () => fin(null) }, 'Annuler'), h('button', { onclick: () => fin(inp.value.trim() || def) }, 'Créer')] });
      setTimeout(() => inp.select(), 50);
    });
  }

  // ---------- réglages ----------
  async function settingsTab(body, st, reload) {
    const s = st.settings;
    const save = async (patch, msg = 'Réglages enregistrés') => { try { await api('/ai/settings', 'PUT', patch); toast(msg); reload(); } catch (e) { toast(e.message, 'bad'); } };
    const num = (k, min, max, step, label, hint) => field(label, h('input', { type: 'number', min, max, step, value: s[k], onchange: e => save({ [k]: +e.target.value }) }), hint);
    const chk = (k, label, extra = {}) => h('label.check', h('input', { type: 'checkbox', checked: s[k], onchange: e => save({ [k]: e.target.checked }), ...extra }), ' ' + label);
    mount(body,
      card(h('h3', 'Activation'),
        h('label.check', h('input', { type: 'checkbox', checked: s.enabled, onchange: e => save({ enabled: e.target.checked }, e.target.checked ? 'Assistant IA activé' : 'Assistant IA désactivé') }), ' ', h('b', 'Activer l’assistant IA')),
        h('p.dim', 'Désactivé, rien n’est analysé ni proposé, et la photothèque fonctionne exactement de la même façon. Aucune photo, vignette ni métadonnée ne quitte cet ordinateur sans votre consentement explicite.')),
      card(h('h3', 'Fonctions'), h('p.dim', 'Chaque fonction se désactive séparément.'),
        h('div.ia-features', ...Object.entries(st.features).map(([k, label]) => h('label.check', { title: st.available[k] ? '' : 'Demande un moteur externe actif qui détecte les visages' },
          h('input', { type: 'checkbox', checked: s.features[k], disabled: !st.available[k] && !s.features[k], onchange: e => save({ features: { [k]: e.target.checked } }) }), ' ' + label,
          st.available[k] ? null : h('small.dim', ' — moteur externe nécessaire'))))),
      card(h('h3', 'Suggestions'),
        h('div.form', num('minScore', 0.1, 0.95, 0.05, 'Confiance minimale', 'En dessous, rien n’est proposé (0,5 = 50 %).'),
          num('similarity', 0.5, 0.99, 0.01, 'Seuil « visuellement proche »', 'Plus il est haut, plus les rapprochements sont stricts.'),
          num('sessionHours', 0.25, 48, 0.25, 'Écart entre deux séances (heures)', 'Sert aux suggestions « même séance » et aux événements.')),
        chk('autoAccept', 'Accepter automatiquement les suggestions très sûres (préférence explicite)', { onchange: async e => {
          if (e.target.checked && !(await confirmDialog('Acceptation automatique', `Les suggestions dont la confiance atteint ${pct(s.autoThreshold)} seront appliquées sans validation (lots annulables). Continuer ?`))) { e.target.checked = false; return; }
          save({ autoAccept: e.target.checked });
        } }),
        s.autoAccept ? num('autoThreshold', 0.5, 1, 0.01, 'Seuil d’acceptation automatique') : null),
      card(h('h3', 'Processeur et carte graphique'),
        h('div.form', num('pauseMs', 0, 5000, 50, 'Pause entre deux photos (ms)', `Plus elle est longue, moins l’analyse charge l’ordinateur (${st.cpus} cœurs ; une seule photo à la fois).`),
          num('maxSide', 256, 2048, 64, 'Taille transmise aux moteurs externes (px)', 'Côté de l’aperçu envoyé ; le moteur intégré lit la vignette.')),
        chk('lowPriority', 'Lancer les moteurs externes en priorité basse'),
        chk('gpu', 'Autoriser la carte graphique (moteurs externes)'),
        h('p.dim', 'Le moteur intégré n’utilise que le processeur et ne demande aucune carte graphique.')),
      enginesCard(st, save, reload),
      card(h('h3', 'Envoi vers un serveur distant'),
        h('label.check', h('input', { type: 'checkbox', checked: s.allowRemote, onchange: async e => {
          if (e.target.checked) {
            if (!(await confirmDialog('Consentement explicite', 'Autoriser l’envoi d’aperçus de vos photos à un serveur qui n’est pas sur cet ordinateur ?\n\nSeuls les moteurs que vous avez déclarés avec une adresse distante sont concernés. Le serveur reçoit une image réduite de chaque photo analysée.'))) { e.target.checked = false; return; }
            save({ allowRemote: true, remoteConsent: true }, 'Envoi distant autorisé');
          } else save({ allowRemote: false }, 'Envoi distant refusé');
        } }), ' Autoriser l’envoi d’images à un moteur distant'),
        h('p.dim', s.allowRemote ? `Consentement donné le ${fmtDateTime(s.remoteConsentAt)}.` : 'Refusé : seuls les moteurs de cet ordinateur sont utilisés.')),
      card(h('h3', 'Résultats'), h('p.dim', 'Efface les descripteurs, les réponses des moteurs et les suggestions en attente. Les mots-clés et lieux déjà acceptés restent sur les photos.'),
        h('button.ghost.danger', { onclick: async () => { if (await confirmDialog('Effacer les résultats', 'Effacer tous les résultats de l’IA ? Une nouvelle analyse sera nécessaire.')) { const r = await api('/ai/clear', 'POST'); toast(`${fmtNum(r.features)} analyse(s) effacée(s)`); reload(); } } }, 'Effacer les résultats de l’IA…')));
  }
  function enginesCard(st, save, reload) {
    const one = e => {
      const pill = e.builtin ? h('span.pill.ok', 'intégré') : e.kind === 'invalid' ? h('span.pill.bad', 'fiche illisible') : e.active ? h('span.pill.ok', 'actif') : e.issues?.length ? h('span.pill.warn', 'à vérifier') : h('span.pill', 'inactif');
      const where = e.builtin ? e.about : `${st.engineKinds[e.kind] ?? e.kind}${e.model ? ' · modèle ' + e.model : ''}${e.kind === 'ollama' ? ' · ' + e.url : e.command ? ' · ' + e.command : ''}`;
      return h('div.ia-engine',
        h('div.row', h('b', e.name), pill, e.builtin || e.kind === 'invalid' ? null : h('small.dim', e.local ? 'sur cet ordinateur' : 'distant'), h('span.spacer'),
          e.kind === 'invalid' ? h('button.small.ghost.danger', { onclick: () => removeEngine(e, reload) }, 'Retirer') : null,
          e.builtin || e.kind === 'invalid' ? null : [h('button.small.ghost', { onclick: () => testEngine(e) }, 'Tester'), h('button.small.ghost', { onclick: () => engineDialog(st, reload, e) }, 'Modifier'), h('button.small.ghost.danger', { onclick: () => removeEngine(e, reload) }, 'Retirer')]),
        h('small.dim.ia-where', where),
        h('small', h('b', 'Licence : '), e.license || h('span.bad', 'non déclarée'), e.licenseUrl ? [' · ', h('a', { href: e.licenseUrl, target: '_blank', rel: 'noopener' }, 'texte de la licence')] : null,
          ' · ', h('b', 'Fournit : '), e.builtin ? 'descripteurs visuels, scènes, couleurs' : (e.provides ?? []).map(p => st.engineProvides[p] ?? p).join(', ') || '—',
          e.analysed ? ` · ${fmtNum(e.analysed)} photo(s) analysée(s)` : '', e.errors ? ` · ${fmtNum(e.errors)} échec(s)` : ''),
        ...(e.issues ?? []).map(x => h('small.bad', x)),
        e.builtin || e.kind === 'invalid' ? null : h('div.row',
          h('label.check', { title: 'J’ai lu la licence du modèle et je l’accepte' }, h('input', { type: 'checkbox', checked: e.licenseAccepted, disabled: !e.license, onchange: ev => save({ engines: { [e.id]: { licenseAccepted: ev.target.checked, enabled: ev.target.checked && e.enabled } } }, ev.target.checked ? 'Licence acceptée' : 'Licence retirée : moteur désactivé') }), ' J’ai lu et j’accepte la licence'),
          h('label.check', h('input', { type: 'checkbox', checked: e.enabled, disabled: !e.licenseAccepted, onchange: ev => save({ engines: { [e.id]: { enabled: ev.target.checked } } }, ev.target.checked ? 'Moteur activé' : 'Moteur désactivé') }), ' Moteur actif')));
    };
    return card(h('div.row', h('h3', 'Moteurs'), h('span.spacer'), h('button.small', { onclick: () => engineDialog(st, reload) }, '+ Déclarer un moteur…')),
      h('p.dim', 'Un moteur externe s’installe séparément (programme local, ou serveur Ollama avec un modèle de vision) ; Photothèque ne télécharge rien. Il doit déclarer sa licence, que vous acceptez avant de l’activer.'),
      h('div.ia-engines', ...st.engines.map(one)),
      h('p.dim', h('small', 'Fiches des moteurs : ' + st.enginesDir)));
  }
  async function removeEngine(e, reload) {
    if (!(await confirmDialog('Retirer le moteur', `Retirer « ${e.name} » ? Seule sa fiche de déclaration est supprimée : le programme ou le modèle installé n’est pas touché. Ses suggestions déjà acceptées restent sur les photos.`))) return;
    await api('/ai/engines/' + encodeURIComponent(e.id), 'DELETE'); toast('Moteur retiré'); reload();
  }
  async function testEngine(e) {
    const box = h('div', h('p.dim', 'Analyse d’une photo par ce moteur…'));
    const m = modal({ title: 'Essai : ' + e.name, body: box, wide: true, actions: [h('button', { onclick: () => m.close() }, 'Fermer')] });
    try {
      const r = await api('/ai/engines/' + encodeURIComponent(e.id) + '/test', 'POST', {});
      mount(box, h('div.ia-ref', r.card ? thumbCard(r.card) : null, h('div',
        h('p', h('b', 'Description : '), r.result.description || h('span.dim', '—')),
        h('p', h('b', 'Mots-clés proposés : '), r.result.labels.length ? r.result.labels.map(l => `${l.name} (${pct(l.score)})`).join(', ') : h('span.dim', '—')),
        e.provides.includes('faces') ? h('p', h('b', 'Visages : '), String(r.result.faces.length)) : null,
        h('p.dim', `Réponse en ${(r.result.ms / 1000).toFixed(1).replace('.', ',')} s. Rien n’a été enregistré.`))));
    } catch (x) { mount(box, h('p.bad', x.message)); }
  }
  function engineDialog(st, reload, cur = null) {
    const v = cur ?? { kind: 'ollama', url: 'http://127.0.0.1:11434', provides: ['labels', 'description'], timeoutSec: 120, args: ['{image}'] };
    const inp = (k, ph = '', val = v[k] ?? '') => h('input', { type: 'text', value: Array.isArray(val) ? JSON.stringify(val) : val, placeholder: ph, style: { width: '100%' } });
    const f = { id: inp('id', 'ex. llava-local'), name: inp('name', 'ex. LLaVA (Ollama)'), url: inp('url'), model: inp('model', 'ex. llava, llama3.2-vision, qwen2.5vl'),
      command: inp('command', 'ex. C:\\Outils\\moteur\\moteur.exe'), args: inp('args', '["{image}"]', v.args ?? ['{image}']), license: inp('license', 'ex. Apache-2.0, licence du modèle'), licenseUrl: inp('licenseUrl', 'https://…'), timeoutSec: h('input', { type: 'number', min: 5, max: 900, value: v.timeoutSec ?? 120 }) };
    if (cur) f.id.disabled = true;
    const modelsBox = h('div');
    async function listModels() {
      mount(modelsBox, h('small.dim', 'Interrogation du serveur…'));
      try {
        const r = await api('/ai/ollama/models?' + new URLSearchParams({ url: f.url.value }));
        mount(modelsBox, r.models.length ? h('div.row', ...r.models.map(m => h('button.small' + (m.vision ? '' : '.ghost'), { disabled: !m.vision, title: m.vision ? 'Modèle de vision' : 'Ne lit pas les images', onclick: () => { f.model.value = m.name; } }, (m.vision ? '👁 ' : '') + m.name)))
          : h('small.dim', 'Aucun modèle installé.'));
        if (!r.models.some(m => m.vision)) modelsBox.appendChild(h('small.bad', 'Aucun modèle de vision installé : par exemple « ollama pull llava » (téléchargement de plusieurs Go, à faire vous-même).'));
      } catch (e) { mount(modelsBox, h('small.bad', e.message)); }
    }
    const kind = h('select', ...Object.entries(st.engineKinds).map(([k, l]) => h('option', { value: k, selected: k === v.kind }, l)));
    const provides = Object.entries(st.engineProvides).map(([k, l]) => h('label.check', h('input', { type: 'checkbox', value: k, checked: (v.provides ?? []).includes(k) }), ' ' + l));
    const kindBox = h('div');
    const draw = () => mount(kindBox, kind.value === 'ollama'
      ? [field('Adresse du serveur', f.url, 'http://127.0.0.1:11434 pour Ollama sur cet ordinateur. Une autre adresse demande votre consentement à l’envoi distant.'), field('Modèle de vision', h('div.row', f.model, h('button.small.ghost', { onclick: listModels }, 'Modèles installés…')), 'Installé au préalable avec « ollama pull <modèle> ».'), modelsBox]
      : [field('Programme', f.command), field('Arguments (JSON)', f.args, '{image} = image à analyser (JPEG temporaire), {lang} = langue, {gpu} = 1 si la carte graphique est autorisée. Le programme répond en JSON : {"labels":[…], "description":"…", "faces":[…]}.')]);
    kind.addEventListener('change', draw); draw();
    const saveBtn = h('button', { onclick: async () => {
      let args; try { args = JSON.parse(f.args.value || '["{image}"]'); } catch { toast('Arguments : liste JSON attendue, ex. ["{image}"]', 'bad'); return; }
      try {
        await api('/ai/engines', 'POST', { id: f.id.value, name: f.name.value, kind: kind.value, url: f.url.value, model: f.model.value, command: f.command.value, args, license: f.license.value, licenseUrl: f.licenseUrl.value, timeoutSec: +f.timeoutSec.value,
          provides: provides.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value) });
        m.close(); toast(cur ? 'Moteur modifié : acceptez de nouveau sa licence pour l’activer' : 'Moteur déclaré : acceptez sa licence pour l’activer'); reload();
      } catch (e) { toast(e.message, 'bad'); }
    } }, 'Enregistrer');
    const m = modal({ title: cur ? 'Modifier le moteur' : 'Déclarer un moteur', wide: true,
      body: h('div', h('div.form', field('Identifiant', f.id), field('Nom', f.name), field('Type', kind), field('Délai maximal (s)', f.timeoutSec)), kindBox,
        h('div.form', field('Licence du modèle', f.license, 'Obligatoire : un moteur sans licence déclarée ne peut pas être activé.'), field('Texte de la licence (adresse)', f.licenseUrl)),
        field('Fournit', h('div.row', ...provides))),
      actions: [h('button.ghost', { onclick: () => m.close() }, 'Annuler'), saveBtn] });
  }

  return { view, open };
})();
