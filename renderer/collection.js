// Collection tab: champions and skins, with who in the party owns what.
const RARITY_ORDER = ['Exalted', 'Transcendent', 'Mythic', 'Ultimate', 'Legendary', 'Epic', 'Rare'];
const rarityRank = (r) => { const i = RARITY_ORDER.indexOf(r); return i < 0 ? 99 : i; };

let col = null;
let colView = { mode: 'champions', q: '', role: '', own: 'all', rarity: '', sort: 'name', champ: null, limit: 120 };

async function renderCollection() {
  col = await api.collection();
  if (!col) return empty('Collection not loaded', 'Open the League client once so ff can load champion and skin data.', { warn: true });
  if (colView.champ) return renderChampDetail(colView.champ);

  const ownOptions = [['all', 'Everything'], ['mine', 'I own'], ['notmine', 'I don\'t own']];
  if (col.people.length > 2) ownOptions.push(['party', 'Whole party owns']);
  col.people.slice(1).forEach((p, i) => ownOptions.push([`p:${i + 1}`, `${p.name} owns`], [`pn:${i + 1}`, `${p.name} owns, I don't`]));
  const roles = [...new Set(col.champions.flatMap((c) => c.roles))].sort();
  const rarities = RARITY_ORDER.filter((r) => col.skins.some((s) => s.rarity === r));
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const isChamps = colView.mode === 'champions';
  const cap = (r) => r[0].toUpperCase() + r.slice(1);

  view.innerHTML = `<div class="stats-bar">
      <div class="seg" role="group" aria-label="Collection view">
        <button class="seg__btn" data-mode="champions" aria-pressed="${isChamps}">Champions</button>
        <button class="seg__btn" data-mode="skins" aria-pressed="${!isChamps}">Skins</button>
      </div>
      <div class="stats-filters">
        <input class="input" type="search" id="colQ" placeholder="${isChamps ? 'Search champions' : 'Search skins or champions'}" value="${esc(colView.q)}" aria-label="Search">
        ${isChamps
          ? `<select class="select" id="colRole" aria-label="Role"><option value="">All roles</option>${opt(roles.map((r) => [r, cap(r)]), colView.role)}</select>`
          : `<select class="select" id="colRarity" aria-label="Rarity"><option value="">All rarities</option>${opt(rarities.map((r) => [r, r]), colView.rarity)}</select>`}
        <select class="select" id="colOwn" aria-label="Ownership">${opt(ownOptions, colView.own)}</select>
        <select class="select" id="colSort" aria-label="Sort">${opt(isChamps
          ? [['name', 'Name'], ['mastery', 'My mastery'], ['skins', 'Skins owned']]
          : [['champ', 'Champion'], ['name', 'Name'], ['rarity', 'Rarity']], colView.sort)}</select>
      </div>
    </div>
    ${partialNote()}
    <div id="colGrid"></div>`;

  view.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
    colView = { ...colView, mode: b.dataset.mode, sort: b.dataset.mode === 'champions' ? 'name' : 'champ', limit: 120 };
    renderCollection();
  }));
  const bind = (id, key) => { const el = document.getElementById(id); if (el) el.oninput = () => { colView[key] = el.value; colView.limit = 120; drawGrid(); }; };
  bind('colQ', 'q'); bind('colRole', 'role'); bind('colRarity', 'rarity'); bind('colOwn', 'own'); bind('colSort', 'sort');
  drawGrid();
}

function partialNote() {
  const old = col.people.filter((p) => p.partial).map((p) => p.name);
  return old.length ? `<div class="notice" style="margin-bottom:16px">${esc(old.join(', '))} ${old.length === 1 ? 'needs' : 'need'} to update ff before their champions and chromas show up here.</div>` : '';
}

function ownMatch(owners) {
  const o = colView.own;
  if (o === 'all') return true;
  if (o === 'mine') return owners.includes(0);
  if (o === 'notmine') return !owners.includes(0);
  if (o === 'party') return owners.length === col.people.length;
  const [kind, idx] = o.split(':');
  return kind === 'p' ? owners.includes(Number(idx)) : owners.includes(Number(idx)) && !owners.includes(0);
}

function ownerStack(owners) {
  if (col.people.length < 2 || !owners.length) return '';
  return `<span class="stack owners">${owners.map((i) => {
    const p = col.people[i];
    return p.icon ? `<img class="${pc(p.slot)}" src="${esc(p.icon)}" alt="${esc(p.name)}" title="${esc(p.name)} owns this">`
      : `<i class="${pc(p.slot)}" title="${esc(p.name)} owns this"></i>`;
  }).join('')}</span>`;
}

function drawGrid() {
  const grid = document.getElementById('colGrid');
  const q = colView.q.trim().toLowerCase();
  const champName = (id) => col.champions.find((c) => c.id === id)?.name || '';
  if (colView.mode === 'champions') {
    const counts = {};
    for (const s of col.skins) if (!s.isBase) {
      const e = (counts[s.champId] ||= { total: 0, mine: 0 });
      e.total++; if (s.owners.includes(0)) e.mine++;
    }
    const list = col.champions.filter((c) => (!q || c.name.toLowerCase().includes(q)) && (!colView.role || c.roles.includes(colView.role)) && ownMatch(c.owners));
    const pts = (c) => c.mastery[0]?.[1] || 0;
    list.sort(colView.sort === 'mastery' ? (a, b) => pts(b) - pts(a)
      : colView.sort === 'skins' ? (a, b) => (counts[b.id]?.mine || 0) - (counts[a.id]?.mine || 0)
      : (a, b) => a.name.localeCompare(b.name));
    grid.innerHTML = list.length ? `<div class="label" style="margin-bottom:12px">${plural(list.length, 'champion')}</div><div class="cgrid">${list.map((c) => `
      <button class="ctile ${c.owners.includes(0) ? '' : 'is-unowned'}" data-champ="${c.id}">
        <span class="ct-art">${img(c.icon)}${c.mastery[0] ? `<span class="mastery ${c.mastery[0][0] >= 10 ? 'is-max' : ''}">${c.mastery[0][0]}</span>` : ''}</span>
        <span class="ctile__name">${esc(c.name)}</span>
        <span class="ctile__meta">${counts[c.id]?.mine || 0}/${counts[c.id]?.total || 0} skins</span>
        ${ownerStack(c.owners)}
      </button>`).join('')}</div>` : emptyState('No champions match', 'Try a different search or filter.');
    grid.querySelectorAll('[data-champ]').forEach((b) => (b.onclick = () => { colView.champ = Number(b.dataset.champ); renderCollection(); }));
  } else {
    const list = col.skins.filter((s) => !s.isBase
      && (!q || s.name.toLowerCase().includes(q) || champName(s.champId).toLowerCase().includes(q))
      && (!colView.rarity || s.rarity === colView.rarity) && ownMatch(s.owners));
    list.sort(colView.sort === 'rarity' ? (a, b) => rarityRank(a.rarity) - rarityRank(b.rarity) || a.name.localeCompare(b.name)
      : colView.sort === 'name' ? (a, b) => a.name.localeCompare(b.name)
      : (a, b) => champName(a.champId).localeCompare(champName(b.champId)) || a.id - b.id);
    const shown = list.slice(0, colView.limit);
    grid.innerHTML = list.length ? `<div class="label" style="margin-bottom:12px">${plural(list.length, 'skin')}</div><div class="sgrid">${shown.map(skinCard).join('')}</div>
      ${list.length > shown.length ? `<div class="more"><button class="btn" id="more">Show more (${(list.length - shown.length).toLocaleString()} left)</button></div>` : ''}`
      : emptyState('No skins match', 'Try a different search or filter.');
    const more = document.getElementById('more');
    if (more) more.onclick = () => { colView.limit += 120; drawGrid(); };
  }
  watchImages(grid);
}

function skinCard(s) {
  const mine = s.owners.includes(0);
  const myChromas = s.chromas.filter((c) => c.owners.includes(0)).length;
  return `<div class="scard ${mine ? '' : 'is-unowned'} ${s.rarity ? `r-${s.rarity.toLowerCase()}` : ''}">
    <div class="sc-art"><span class="pcard__alt">${esc(s.name)}</span>${img(s.card, s.name)}
      ${s.legacy ? '<span class="sc-tag">Legacy</span>' : ''}${mine ? '' : '<span class="sc-tag sc-tag--left">Not owned</span>'}</div>
    <div class="scard__body">
      <div class="scard__name">${esc(s.name)}</div>
      ${s.rarity ? `<div class="rarity"><i></i>${s.rarity}</div>` : ''}
      ${s.lines.length ? `<div class="scard__line">${esc(s.lines.join(', '))}</div>` : ''}
      ${s.chromas.length ? `<div class="chromas" title="${esc(s.chromas.map((c) => c.name).join(', '))}">
        ${s.chromas.map((c) => `<i class="${c.owners.includes(0) ? 'is-owned' : ''}" style="background:${esc(c.colors[0] || '#555')}"></i>`).join('')}
        <span>${myChromas}/${s.chromas.length}</span></div>` : ''}
      ${ownerStack(s.owners)}
    </div>
  </div>`;
}

async function renderChampDetail(id) {
  const c = col.champions.find((x) => x.id === id);
  const skins = col.skins.filter((s) => s.champId === id).sort((a, b) => (b.isBase - a.isBase) || a.id - b.id);
  const base = skins.find((s) => s.isBase);
  const d = await api.championDetail(id);
  const ownedCount = skins.filter((s) => !s.isBase && s.owners.includes(0)).length;
  const masteryRows = col.people.map((p, i) => `<div class="chero__m ${pc(p.slot)}"><span>${esc(p.name)}</span>${c.mastery[i]
    ? `<span class="mastery ${c.mastery[i][0] >= 10 ? 'is-max' : ''}">${c.mastery[i][0]}</span><b>${c.mastery[i][1].toLocaleString()} pts</b>`
    : `<span class="muted">${c.owners.includes(i) ? 'No mastery yet' : 'Doesn\'t own'}</span>`}</div>`).join('');

  view.innerHTML = `<button class="btn" id="back" style="margin-bottom:16px">← All champions</button>
    <div class="chero">
      ${img(base?.splash, '', 'class="chero__splash"')}
      <div class="chero__text">
        <h1 class="chero__name">${esc(c.name)}</h1>
        ${d?.title ? `<div class="chero__title">${esc(d.title)}</div>` : ''}
        <div class="chero__roles">${esc((d?.roles || c.roles).map((r) => r[0].toUpperCase() + r.slice(1)).join(', '))}</div>
        <div class="chero__mastery">${masteryRows}</div>
      </div>
    </div>
    ${d?.spells?.length ? `<div class="spells">${d.spells.map((sp) => `<div class="spell" title="${esc(sp.name)}"><span class="tile">${img(sp.icon, sp.name)}</span><span>${esc(sp.key || '')}</span></div>`).join('')}</div>` : ''}
    ${d?.bio ? `<p class="bio">${esc(d.bio)}</p>` : ''}
    <h2 class="section-title">Skins <span class="muted">(${ownedCount} of ${skins.length - 1} owned)</span></h2>
    <div class="sgrid" style="margin-top:12px">${skins.map(skinCard).join('')}</div>`;
  document.getElementById('back').onclick = () => { colView.champ = null; renderCollection(); };
  watchImages(view);
}
