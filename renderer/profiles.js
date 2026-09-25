// Profiles tab: op.gg-style player pages for you and your friends.
const QUEUES = {
  420: 'Ranked Solo/Duo', 440: 'Ranked Flex', 400: 'Normal Draft', 430: 'Normal Blind', 490: 'Quickplay', 480: 'Swiftplay',
  450: 'ARAM', 1700: 'Arena', 1710: 'Arena', 900: 'URF', 1900: 'URF', 0: 'Custom',
};
// Filters go by game mode first (so ARAM: Mayhem and new variants land in the right place), then ranked queues
const QUEUE_FILTERS = [['all', 'All'], ['aram', 'ARAM', (m) => m.mode === 'aram'], ['mayhem', 'Mayhem', (m) => m.mode === 'mayhem'], ['arena', 'Arena', (m) => m.mode === 'arena'],
  ['solo', 'Solo/Duo', (m) => m.queueId === 420], ['flex', 'Flex', (m) => m.queueId === 440], ['normal', 'Normal', (m) => m.mode === 'rift' && ![420, 440].includes(m.queueId)]];
const TIERS = { IRON: 'Iron', BRONZE: 'Bronze', SILVER: 'Silver', GOLD: 'Gold', PLATINUM: 'Platinum', EMERALD: 'Emerald', DIAMOND: 'Diamond', MASTER: 'Master', GRANDMASTER: 'Grandmaster', CHALLENGER: 'Challenger' };
const APEX = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];

let profView = { puuid: null, target: null, queue: 'all', shown: 20, open: new Set() };

// Open anyone's profile (null or your own puuid = you)
function openProfile(puuid) {
  profView = { ...profView, target: puuid && puuid !== state.lcu.puuid ? puuid : null, queue: 'all', shown: 20, open: new Set() };
  setTab('profiles');
}
let profCache = null;

const rankText = (r) => (r ? `${TIERS[r.tier] || r.tier}${APEX.includes(r.tier) ? '' : ` ${r.division}`}` : 'Unranked');
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const icon = (x, cls = '') => (x?.icon ? `<img class="${cls}" src="${esc(x.icon)}" alt="${esc(x.name || '')}" title="${esc(x.name || '')}">` : `<span class="${cls} is-empty"></span>`);

async function renderProfiles() {
  const mine = (await api.profiles()).find((p) => p.slot === 'me');
  profView.puuid = profView.target || mine?.puuid;
  if (!profView.puuid) return empty('No profile yet', 'Open League so ff knows who you are.', { warn: true });
  const prof = await api.profile(profView.puuid, 500);
  profCache = prof;

  // Refresh in the background when stale (10 min)
  if (prof.hasKey && !prof.refreshing && (!prof.updatedAt || Date.now() - prof.updatedAt > 600000) && !prof.error) api.refreshProfile(prof.puuid);

  const back = profView.target ? `<button class="btn back-link" id="profBack">← Back to my profile</button>` : '';
  view.innerHTML = `<div class="profiles profiles--solo"><section class="profile">${back}${profileHtml(prof)}</section></div>`;
  const b = document.getElementById('profBack');
  if (b) b.onclick = () => openProfile(null);
  bindProfile();
  watchImages(view);
}

function profileHtml(p) {
  const updated = p.refreshing ? 'Updating...' : p.updatedAt ? `Updated ${ago(p.updatedAt)}` : 'Not updated yet';
  let html = `<header class="phead ${pc(p.slot)}">
    <div class="phead__avatar">${p.icon ? `<img src="${esc(p.icon)}" alt="">` : ''}${p.level ? `<span class="phead__level">${p.level}</span>` : ''}</div>
    <div class="phead__who"><h1 class="phead__name">${esc(p.name)} <span>${esc(p.tag)}</span></h1>
      <div class="phead__meta">${p.slot === 'me' || p.relation === 'none' ? '' : p.app ? '<span class="chip chip--match">ff</span>' : '<span class="chip">Riot ID only</span>'}<span class="muted">${esc(updated)}</span></div></div>
    ${p.relation === 'none' ? '<button class="btn btn--match" id="profAdd">+ Add friend</button>' : p.relation === 'friend' ? '<span class="chip chip--match">Friend</span>' : ''}
    <button class="btn" id="profRefresh" ${!p.hasKey || p.refreshing ? 'disabled' : ''}>${p.refreshing ? 'Updating...' : 'Update'}</button>
  </header>`;
  if (!p.hasKey) html += `<div class="notice" style="margin-bottom:20px">Add a Riot API key in Settings to load ranks and match history for everyone. Until then you'll only see games from this PC's League client.</div>`;
  if (p.error) html += `<div class="alert alert--error" style="margin-bottom:20px">${esc(p.error)}</div>`;

  // ranks
  const ranks = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'].map((q) => p.ranks.find((r) => r.queue === q) || { queue: q, label: q === 'RANKED_SOLO_5x5' ? 'Ranked Solo/Duo' : 'Ranked Flex' });
  html += `<div class="ranks">${ranks.map((r) => {
    const games = (r.wins || 0) + (r.losses || 0);
    const wr = games ? r.wins / games : 0;
    return `<div class="rankcard ${r.tier ? `t-${r.tier.toLowerCase()}` : 'is-unranked'}">
      ${r.tier ? rankEmblem(r.tier, 'rankcard__emblem') : '<span class="crest" aria-hidden="true"></span>'}
      <div class="rankcard__body"><div class="label">${esc(r.label)}</div>
        <div class="rankcard__tier">${esc(rankText(r.tier && r))}</div>
        ${r.tier ? `<div class="rankcard__lp">${r.lp} LP</div><div class="rankcard__wl"><span class="wr ${wr >= 0.55 ? 'is-good' : ''}" style="--v:${Math.round(wr * 100)}%">${r.wins}W ${r.losses}L, ${Math.round(wr * 100)}%<i></i></span></div>` : '<div class="rankcard__lp muted">No games this split</div>'}
      </div></div>`;
  }).join('')}</div>`;

  // recent summary + top champions
  const played = p.matches.filter((m) => !m.remake);
  const recent = played.slice(0, 20);
  const wins = recent.filter((m) => m.win).length;
  const sum = recent.reduce((a, m) => ({ k: a.k + m.k, d: a.d + m.d, a: a.a + m.a, kp: a.kp + m.kp }), { k: 0, d: 0, a: 0, kp: 0 });
  html += `<div class="pgrid">
    <div class="ppanel"><h3 class="section-title">Last ${recent.length} games</h3>${recent.length ? `
      <div class="recent"><div class="recent__wl"><b>${wins}W ${recent.length - wins}L</b><span class="muted">${Math.round((wins / recent.length) * 100)}% win rate</span></div>
      <div class="recent__kda"><b>${((sum.k + sum.a) / Math.max(sum.d, 1)).toFixed(2)} KDA</b><span class="muted">${(sum.k / recent.length).toFixed(1)} / ${(sum.d / recent.length).toFixed(1)} / ${(sum.a / recent.length).toFixed(1)}, ${Math.round((sum.kp / recent.length) * 100)}% KP</span></div>
      <div class="streak">${recent.slice().reverse().map((m) => `<i class="${m.win ? 'is-w' : 'is-l'}" title="${m.win ? 'Win' : 'Loss'}"></i>`).join('')}</div></div>` : '<p class="muted" style="margin:0">No games loaded yet.</p>'}</div>
    <div class="ppanel"><h3 class="section-title">Top champions</h3>${p.mastery.length ? `<ul class="topchamps">${p.mastery.map((m) => `
      <li><span class="champ-cell">${img(m.champ.icon)}${esc(m.champ.name)}</span><span class="mastery ${m.level >= 10 ? 'is-max' : ''}">${m.level}</span><span class="muted">${m.points.toLocaleString()} pts</span></li>`).join('')}</ul>` : '<p class="muted" style="margin:0">No mastery data yet.</p>'}</div>
  </div>`;

  // match list
  const filter = QUEUE_FILTERS.find((f) => f[0] === profView.queue);
  const rows = p.matches.filter((m) => !filter[2] || filter[2](m));
  html += `<div class="mhead"><h3 class="section-title">Match history <span class="muted">(${p.total.toLocaleString()} stored)</span></h3>
    <div class="seg seg--sm" role="group" aria-label="Queue">${QUEUE_FILTERS.map(([k, l]) => `<button class="seg__btn" data-queue="${k}" aria-pressed="${k === profView.queue}">${l}</button>`).join('')}</div></div>`;
  html += rows.length ? `<div class="mlist">${rows.slice(0, profView.shown).map((m) => matchRowHtml(m, p.puuid)).join('')}</div>
    ${rows.length > profView.shown ? `<div class="more"><button class="btn" id="moreMatches">Show more</button></div>` : ''}`
    : `<p class="muted">${p.matches.length ? 'No games in this queue yet.' : 'No games loaded yet.'}</p>`;
  return html;
}

function matchRowHtml(m, puuid) {
  const arena = m.mode === 'arena' && m.placement;
  const cls = m.remake ? 'is-remake' : (arena ? m.placement === 1 : m.win) ? 'is-win' : 'is-loss';
  const ordn = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 10 > 3 || [11, 12, 13].includes(n % 100) ? 0 : n % 10]}`;
  const kda = m.d ? ((m.k + m.a) / m.d).toFixed(2) : 'Perfect';
  const open = profView.open.has(m.gameId);
  const side = (list) => `<ul class="mrow__side">${list.map((x) => `<li class="${x.puuid === puuid ? 'is-me' : ''}">${img(x.champ?.icon, x.champ?.name)}<span>${esc(x.name || x.champ?.name || '')}</span></li>`).join('')}</ul>`;
  return `<div class="mrow ${cls}">
    <div class="mrow__meta"><b>${esc(m.mode === 'mayhem' ? 'ARAM: Mayhem' : QUEUES[m.queueId] || (m.mode === 'aram' ? 'ARAM' : m.mode === 'arena' ? 'Arena' : 'Other'))}</b><span>${ago(m.start)}</span><span class="mrow__res">${m.remake ? 'Remake' : arena ? `${ordn(m.placement)} place` : m.win ? 'Victory' : 'Defeat'}</span><span>${mmss(m.duration)}</span></div>
    <div class="mrow__champ"><span class="mrow__cimg">${img(m.champ.icon, m.champ.name)}<i>${m.level}</i></span>
      <span class="mrow__loadout">${icon(m.spells[0])}${icon(m.rune, 'is-round')}${icon(m.spells[1])}${icon(m.subStyle, 'is-round is-sub')}</span></div>
    <div class="mrow__kda"><b>${m.k} <span>/</span> <em>${m.d}</em> <span>/</span> ${m.a}</b><span>${kda}${kda === 'Perfect' ? '' : ' KDA'}</span></div>
    <div class="mrow__stats"><span>${m.cs} CS (${(m.cs / Math.max(m.duration / 60, 1)).toFixed(1)})</span><span>${Math.round(m.kp * 100)}% KP</span></div>
    <div class="mrow__items">${m.items.slice(0, 6).map((it) => icon(it)).join('')}${icon(m.items[6], 'is-round')}</div>
    ${m.augments?.length ? `<div class="mrow__augs"><span class="label">Augments</span>${augmentIcons(m.augments, { size: 'md' })}</div>` : `<div class="mrow__teams">${side(m.team)}${side(m.enemy)}</div>`}
    <button class="mrow__toggle" data-open="${m.gameId}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} scoreboard">${open ? '▴' : '▾'}</button>
  </div>${open ? `<div class="scoreboard" id="sb-${m.gameId}"><p class="muted">Loading scoreboard...</p></div>` : ''}`;
}

async function fillScoreboards() {
  for (const id of profView.open) {
    const el = document.getElementById(`sb-${id}`);
    if (!el) continue;
    const d = await api.matchDetail(id, profView.puuid);
    if (!d) { el.innerHTML = '<p class="muted">Scoreboard not available for this game.</p>'; continue; }
    const hasAugs = d.teams.some((t) => t.players.some((x) => x.augments?.length));
    const teams = [...d.teams].sort((a, b) => b.players.some((x) => x.isFocus) - a.players.some((x) => x.isFocus));
    el.innerHTML = teams.map((t) => `<table class="table sb ${t.win ? 'is-win' : 'is-loss'}">
      <thead><tr><th>${t.win ? 'Victory' : 'Defeat'} <span class="muted">(${t.id === 100 ? 'Blue' : 'Red'} side, ${t.kills} kills, ${t.tower} towers, ${t.dragon} dragons, ${t.baron} barons)</span></th>
        <th class="n">KDA</th><th>Damage</th><th class="n">Gold</th><th class="n">CS</th><th class="n">Vision</th><th>Items</th>${hasAugs ? '<th>Augments</th>' : ''}</tr></thead>
      <tbody>${t.players.map((x) => `<tr class="${x.isFocus ? 'is-focus' : ''} ${pc(x.slot)}">
        <td><span class="sb__who"><span class="mrow__cimg sm">${img(x.champ.icon, x.champ.name)}<i>${x.level}</i></span>
          <span class="mrow__loadout sm">${icon(x.spells[0])}${icon(x.rune, 'is-round')}${icon(x.spells[1])}${icon(x.subStyle, 'is-round is-sub')}</span>
          <span class="sb__name ${x.slot ? 'is-friend' : ''}">${esc(x.name || x.champ.name)}</span></span></td>
        <td class="n">${x.k}/${x.d}/${x.a}</td>
        <td><span class="dmg"><i style="--v:${Math.round(x.dmgShare * 100)}%"></i>${(x.dmg || 0).toLocaleString()}</span></td>
        <td class="n">${(x.gold || 0).toLocaleString()}</td><td class="n">${x.cs}</td><td class="n">${x.vision ?? '–'}</td>
        <td><span class="mrow__items sm">${x.items.slice(0, 6).map((it) => icon(it)).join('')}${icon(x.items[6], 'is-round')}</span></td>
        ${hasAugs ? `<td>${augmentIcons(x.augments)}</td>` : ''}
      </tr>`).join('')}</tbody></table>`).join('');
    watchImages(el);
  }
}

function bindProfile() {
  const add = document.getElementById('profAdd');
  if (add) add.onclick = async () => { await api.addFriendPuuid(profView.puuid); renderProfiles(); };
  const r = document.getElementById('profRefresh');
  if (r) r.onclick = () => api.refreshProfile(profView.puuid);
  view.querySelectorAll('[data-queue]').forEach((b) => (b.onclick = () => { profView.queue = b.dataset.queue; profView.shown = 20; renderProfiles(); }));
  const more = document.getElementById('moreMatches');
  if (more) more.onclick = () => { profView.shown += 20; renderProfiles(); };
  view.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => {
    const id = Number(b.dataset.open);
    profView.open.has(id) ? profView.open.delete(id) : profView.open.add(id);
    renderProfiles();
  }));
  fillScoreboards();
}
