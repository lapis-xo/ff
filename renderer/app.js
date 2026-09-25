const api = window.skinmatch;
const view = document.getElementById('view');
let state = null;
let tab = 'party';
let champs = [];
let explorePick = { mine: '', friend: '', theirs: '' };
let statsView = { who: 'me', mode: 'all', friend: '' };
let liveView = { line: null, showAll: false };
let partyStats = null;
let partyStatsKey = '';
let wasInChampSelect = false;
let lastRefreshKey = '';
let lastWatchKey = '';
const watchKey = (s) => s.watch.map((w) => w.puuid + w.name).join(',');

document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
// Account menu (your icon + name): Settings and Refresh live here
const meBtn = document.getElementById('me'), meMenu = document.getElementById('meMenu');
function setMenu(open) {
  meMenu.hidden = !open;
  meBtn.setAttribute('aria-expanded', String(open));
  if (open) meMenu.querySelector('.menu__item').focus();
}
meBtn.onclick = (e) => { e.stopPropagation(); setMenu(meMenu.hidden); };
document.addEventListener('click', (e) => { if (!meMenu.hidden && !meMenu.contains(e.target)) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !meMenu.hidden) { setMenu(false); meBtn.focus(); } });
meMenu.querySelectorAll('[data-menu]').forEach((b) => (b.onclick = async () => {
  setMenu(false);
  if (['settings', 'profiles', 'friends'].includes(b.dataset.menu)) setTab(b.dataset.menu);
  if (b.dataset.menu === 'update') api.installUpdate();
  if (b.dataset.menu === 'refresh') { state = await api.refresh(); partyStats = null; render(); }
}));

// Top-bar search: any Riot ID opens that player's profile
const searchEl = document.getElementById('search'), searchMsg = document.getElementById('searchMsg');
searchEl.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { searchEl.value = ''; searchMsg.hidden = true; return; }
  if (e.key !== 'Enter' || !searchEl.value.trim()) return;
  searchMsg.hidden = false; searchMsg.className = 'search__msg'; searchMsg.textContent = 'Looking up...';
  const res = await api.lookupRiotId(searchEl.value.trim());
  if (!res.ok) { searchMsg.className = 'search__msg is-error'; searchMsg.textContent = res.error; return; }
  searchMsg.hidden = true; searchEl.value = ''; searchEl.blur();
  openProfile(res.puuid);
});
searchEl.addEventListener('blur', () => setTimeout(() => { if (!searchMsg.classList.contains('is-error')) searchMsg.hidden = true; }, 150));
searchEl.addEventListener('input', () => { searchMsg.hidden = true; });

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.tab === t)));
  document.querySelectorAll('[data-menu]').forEach((x) => x.classList.toggle('is-current', x.dataset.menu === t));
  render();
}

const friendBySlot = (slot) => state.party.find((f) => f.slot === slot);

// ---------- header ----------
function renderHeader() {
  const me = state.me, lcu = state.lcu;
  // update ready: menu item + a one-time pop-up
  const up = document.querySelector('[data-menu="update"]');
  if (up) {
    up.hidden = !state.update?.ready;
    if (state.update?.ready) document.getElementById('updateLabel').textContent = `Restart to update to ${state.update.version}`;
  }
  if (state.update?.ready && !updateToastShown) { updateToastShown = true; showUpdateToast(state.update.version); }
  // "ff" becomes "gg ez" after a win (until the next game starts)
  const bt = document.getElementById('brandText');
  const word = state.ggez ? 'gg ez' : 'ff';
  if (bt && bt.textContent !== word) {
    bt.textContent = word;
    bt.classList.toggle('is-gg', state.ggez);
    bt.classList.remove('pop'); void bt.offsetWidth; bt.classList.add('pop');
  }
  const meEl = document.getElementById('me');
  meEl.className = `me-chip ${lcu.connected ? '' : 'is-off'}`;
  meEl.title = 'Account menu';
  meEl.classList.toggle('is-open', !meMenu.hidden);
  document.getElementById('meMenuHead').innerHTML = `<b>${esc(me?.name || 'You')}<span>${esc(me?.tag || '')}</span></b>
    <span class="menu__status ${lcu.connected ? 'is-on' : ''}">${lcu.connected ? 'Connected to League' : 'League is closed'}</span>`;
  meEl.innerHTML = `<span class="me-chip__avatar">${me?.icon ? `<img class="me-chip__icon" src="${esc(me.icon)}" alt="">` : '<span class="me-chip__icon"></span>'}<i class="me-chip__dot"></i></span>
    <div class="me-chip__text"><div class="me-chip__name">${esc(me?.name || 'You')}</div><div class="me-chip__sub">${lcu.connected ? plural(lcu.skinCount, 'skin') : 'League closed'}</div></div>
    <svg class="me-chip__caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

  // (party pill removed from the top bar; the Party tab shows the lobby)
}

// ---------- what you're queued for ----------
const PHASES = {
  Lobby: ['In lobby', 'lobby'], Matchmaking: ['In queue', 'queue'], ReadyCheck: ['Match found', 'found'], ChampSelect: ['Champ select', 'cs'],
  GameStart: ['Loading in', 'game'], InProgress: ['In game', 'game'], Reconnect: ['In game', 'game'], WaitingForStats: ['Game over', 'lobby'],
  PreEndOfGame: ['Game over', 'lobby'], EndOfGame: ['Game over', 'lobby'],
};
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const MODE_ICON = (kind) => `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/content/src/leagueclient/gamemodeassets/${({ aram: 'aram', mayhem: 'aram', arena: 'gamemodex' })[kind] || 'classic_sru'}/img/game-select-icon-active.png`;
// What we're playing right now: the lobby's queue, or (if ff started mid-game) what the game itself reports
function currentQueue() {
  const L = state.live;
  const q = state.queue;
  if (q && (!L || !q.mode || q.mode === L.kind || L.kind === 'other')) return q;
  if (!L) return q;
  return { ...(q || {}), mode: L.kind, name: MODE_LABEL[L.kind] || L.mode, short: L.kind === 'rift' ? 'SR' : L.kind === 'arena' ? null : 'HA',
    mapName: L.mapName, pick: L.kind === 'aram' || L.kind === 'mayhem' ? 'Random' : null, icon: MODE_ICON(L.kind), phase: 'InProgress' };
}
function queueHeader() {
  const q = currentQueue();
  if (!q || !state.lcu.connected) return '';
  const [label, cls] = PHASES[q.phase] || PHASES.Lobby;
  const timer = q.search ? ` <span data-qsince="${q.search.since}">${clock((Date.now() - q.search.since) / 1000)}</span>${q.search.estimate ? `<small>est. ${clock(q.search.estimate)}</small>` : ''}` : '';
  // Same line the client shows above the lobby: [icon] MAP · QUEUE · PICK
  const parts = [q.short, q.name, q.pick].filter(Boolean);
  return `<div class="qhead">
    <div class="qhead__line" title="${esc(q.mapName || '')}">${q.icon ? `<img class="qhead__icon" src="${esc(q.icon)}" alt="">` : ''}
      <h2 class="qhead__mode">${parts.map((x) => `<span>${esc(x)}</span>`).join('')}</h2></div>
    ${cls === 'lobby' ? '' : `<span class="qchip qchip--${cls}"><i></i>${label}${timer}</span>`}</div>`;
}
// Tick the queue timer without re-rendering the page
setInterval(() => document.querySelectorAll('[data-qsince]').forEach((el) => { el.textContent = clock((Date.now() - Number(el.dataset.qsince)) / 1000); }), 1000);

// ---------- party ----------
// League status on the summoner icon, like the friends list in the client:
// green = online in the client, blue = in queue / champ select / in game, gray = League closed.
// Everyone shown on Party is in your lobby, so they share your phase.
function leagueStatus() {
  if (!state.lcu.connected) return ['off', 'League closed'];
  const ph = state.queue?.phase;
  if (ph === 'Matchmaking' || ph === 'ReadyCheck') return ['busy', 'In queue'];
  if (ph === 'ChampSelect') return ['busy', 'In champ select'];
  if (['GameStart', 'InProgress', 'Reconnect'].includes(ph)) return ['busy', 'In game'];
  return ['on', 'Online'];
}

function banner(p, { isMe = false } = {}) {
  const guest = !isMe && !p.onSkinMatch;
  const [st, stLabel] = leagueStatus();
  const cls = ['lbanner', isMe && 'lbanner--me', pc(isMe ? 'me' : p.slot), guest && 'is-guest'].filter(Boolean).join(' ');
  const puuid = isMe ? state.lcu.puuid : p.puuid;
  // The player's real lobby banner art, with their prestige crest framing the icon (like the client)
  const art = p.banner ? `style="--banner:url('${esc(p.banner)}'); --orn:${Number(p.orn) || 0.8}"` : '';
  return `<div class="${cls}" ${art} ${puuid ? `data-profile="${esc(puuid)}" role="button" tabindex="0" title="Open ${esc(p.name || 'your')} profile"` : ''}>
    <div class="lbanner__crest">
      ${p.icon ? `<img class="lbanner__icon" src="${esc(p.icon)}" alt="">` : '<span class="lbanner__icon"></span>'}
      ${p.crest ? `<img class="lbanner__frame" src="${esc(p.crest)}" alt="">` : ''}
      ${p.gem ? `<img class="lbanner__gem" src="${esc(p.gem)}" alt="">` : ''}
      <i class="status-dot status-dot--${st}" title="${stLabel}" aria-label="${stLabel}"></i>
    </div>
    <div class="lbanner__name ${(p.name || '').length > 13 ? 'is-long' : ''}" title="${esc(p.name)}${esc(p.tag || '')}">${esc(p.name || 'You')}</div>
    <div class="lbanner__sub">${guest ? 'ff not detected' : esc(p.title || '')}</div>
    <div class="lbanner__mastery">${(p.mastery || []).map((m) => img(m.champ.icon, m.champ.name, `title="${esc(m.champ.name)}"`)).join('')}</div>
  </div>`;
}

// Party turns into champ select while anyone from the party is on your team there
const inChampSelect = () => state.lcu.connected && state.champSelect.active && state.champSelect.mates.length > 0;

async function renderParty() {
  if (inChampSelect()) return renderLive();
  if (!state.champSelect.active) resetCelebrations();
  const me = { ...(state.me || {}), name: state.me?.name || 'You', skinCount: state.lcu.skinCount || state.me?.skinCount || 0 };
  // Mirror the League lobby: me in the middle, fill inner-right, inner-left, outer-right, outer-left
  const friends = state.lcu.connected ? state.lobby : [];
  const cells = [];
  const order = [3, 1, 4, 0];
  const slots = Array(5).fill('');
  slots[2] = banner(me, { isMe: true });
  friends.forEach((f, i) => { slots[order[i]] = banner(f); });
  // Always five spots, like the client's lobby: empty ones get a blank default banner
  const blank = state.blank || {};
  const emptyBanner = () => `<div class="lbanner lbanner--empty" ${blank.banner ? `style="--banner:url('${esc(blank.banner)}'); --orn:${Number(blank.orn) || 0.8}"` : ''} aria-hidden="true"></div>`;
  cells.push(...slots.map((x) => x || emptyBanner()));
  const smIds = friends.filter((f) => f.onSkinMatch).map((f) => f.puuid);
  const key = smIds.join(',');
  if (key !== partyStatsKey) { partyStats = null; partyStatsKey = key; }
  if (smIds.length && !partyStats) partyStats = await api.partySummary(smIds);
  const s = partyStats;
  const face = (p) => `<img class="${pc(p.slot)}" src="${esc(p.icon || '')}" alt="">`;
  let summary = `<p class="party-note">${!state.lcu.connected ? 'Open League to see your lobby.'
    : !friends.length ? 'Not in a lobby. Friends show up here when they join your League lobby.'
    : 'Nobody else in this lobby is using ff yet.'}</p>`;
  if (smIds.length && s) summary = snapshotHtml(s, face);
  else if (state.live) summary = `<div class="snap"><div class="snap__head"><p class="party-summary__title">Current match</p></div>${liveCard()}</div>`;
  // Everyone's champ icons sit at the same spot: above the tallest bottom decoration in the lobby
  const orns = [me, ...friends].filter((p) => p.banner && (p === me || p.onSkinMatch)).map((p) => Number(p.orn) || 0.8);
  const rowOrn = orns.length ? Math.min(...orns) : 0.8;
  view.innerHTML = `<div class="party">${queueHeader()}<div class="party-row" style="--orn-row:${rowOrn}">${cells.join('')}</div>${summary}</div>`;
  view.querySelectorAll('[data-snapmode]').forEach((b) => (b.onclick = () => { snapMode = b.dataset.snapmode; renderParty(); }));
  view.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(b.dataset.copy); b.classList.add('is-copied'); setTimeout(() => b.classList.remove('is-copied'), 1200); } catch { /* clipboard blocked */ }
  }));
  view.querySelectorAll('[data-profile].lbanner').forEach((b) => {
    b.onclick = () => openProfile(b.dataset.profile);
    b.onkeydown = (e) => { if (e.key === 'Enter') openProfile(b.dataset.profile); };
  });
  watchImages(view);
}

// ---------- Party Snapshot charts ----------
const gradeBadge = (g, big = false) => (g ? `<span class="grade g-${g.replace('+', 'p').toLowerCase()} ${big ? 'grade--big' : ''}">${g}</span>` : '<span class="grade">–</span>');
const TIER_NAMES = ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Emerald', 'Diamond', 'Master+'];

let snapMode = null; // the mode picked in the snapshot's switch
let snapFollowKey = null;
const MODE_LABEL = { aram: 'ARAM', mayhem: 'ARAM: Mayhem', arena: 'Arena', rift: "Summoner's Rift" };
const ord = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th'}`;
const cap = (x) => x[0].toUpperCase() + x.slice(1);

function snapshotHtml(s, face) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const P = s.people;
  const cur = state.live?.kind || (state.queue && ['ChampSelect', 'Lobby', 'Matchmaking', 'ReadyCheck', 'GameStart', 'InProgress'].includes(state.queue.phase) ? state.queue.mode : null);
  const curKey = `${state.queue?.queueId || ''}:${state.live?.kind || ''}`;
  if (curKey !== snapFollowKey) { snapFollowKey = curKey; snapMode = null; } // new match type: follow it again
  const mode = s.modes.includes(snapMode) ? snapMode : cur && s.modes.includes(cur) ? cur : s.defaultMode;
  const F = s.form.map((f) => f?.modes?.[mode] || null);
  const modeSeg = s.modes.length ? `<div class="seg seg--sm" role="group" aria-label="Game mode">${s.modes.map((m) =>
    `<button class="seg__btn" data-snapmode="${m}" aria-pressed="${m === mode}">${MODE_LABEL[m]}</button>`).join('')}</div>` : '';
  const legend = `<div class="snap__legend">${P.map((p) => `<span class="${pc(p.slot)}"><i></i>${esc(p.name)}</span>`).join('')}</div>`;
  const nameCell = (p) => `<span class="who ${pc(p.slot)}">${face(p)}<span>${esc(p.name)}</span></span>`;

  // ---- current match: champ select picks (the live game has its own scoreboard above the snapshot)
  let recap = '';
  const cs = state.champSelect;
  if (state.live) {
    recap = liveCard();
  } else if (inChampSelect() && cs.team?.length) {
    const q = state.queue || {};
    const locked = cs.team.filter((p) => p.champ && p.locked).length;
    const facts = [q.mapName && q.mapName !== 'Random Map' ? q.mapName : null, q.name, q.pick].filter(Boolean);
    const spellSlots = (list) => list.map((x) => (x?.icon ? `<span class="eog__slot is-spell" title="${esc(x.name || '')}"><img src="${esc(x.icon)}" alt=""></span>` : '<span class="eog__slot is-spell is-empty"></span>')).join('');
    recap = `<section class="chartcard eog eog--current">
      <div class="eog__head">
        ${q.icon ? `<span class="eog__icon">${img(q.icon)}</span>` : ''}
        <div><h3 class="eog__result">Champ select</h3>
          <div class="eog__facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}<span>${locked} of ${cs.team.length} locked in</span></div></div>
      </div>
      <div class="eog__wrap"><table class="eog__table"><tbody class="is-mine">
        <tr class="eog__team"><th colspan="3">Your team</th><th>Skin</th><th class="c">Status</th></tr>
        ${cs.team.map((p) => `<tr class="${p.isMe ? 'is-me' : ''} ${p.slot ? pc(p.slot) : ''}">
          <td class="eog__spells"><span>${spellSlots(p.spells)}</span></td>
          <td class="eog__lvl"></td>
          <td class="eog__who"><span class="eog__whoin"><span class="eog__champ">${p.champ ? img(p.champ.icon, p.champ.name) : '<span class="eog__champ-empty"></span>'}</span>
            <span class="eog__name ${p.isParty ? 'is-friend' : ''}">${p.champ ? esc(p.champ.name) : 'Picking...'}<small>${esc([p.name, p.role].filter(Boolean).join(', ') || 'Teammate')}</small></span></span></td>
          <td class="eog__skin">${esc(p.skin && p.champ && p.skin !== p.champ.name ? p.skin : p.champ ? 'Default' : '')}</td>
          <td class="c">${p.champ && p.locked ? '<span class="eog__locked">Locked in</span>' : '<span class="eog__picking">Picking</span>'}</td>
        </tr>`).join('')}
      </tbody></table></div>
      ${cs.theirCount ? `<p class="coverage" style="margin:10px 0 0">Enemy team is revealed when the game loads.</p>` : ''}
    </section>`;
  } else if (s.recap?.teams) {
    const r = s.recap;
    const arena = r.mode === 'arena';
    const title = arena ? (r.placement ? `${ord(r.placement)} place` : 'Arena') : r.win ? 'Victory' : 'Defeat';
    const good = arena ? r.placement === 1 : r.win;
    const hasAugs = r.teams.some((t) => t.players.some((p) => p.augments?.length));
    const augN = Math.max(4, ...r.teams.flatMap((t) => t.players.map((p) => p.augments?.length || 0)));
    const slots = (list, n, cls) => Array.from({ length: n }, (_, i) => list[i]).map((x) => x?.icon
      ? `<span class="eog__slot ${cls || ''} ${x.rarity ? `aug--${x.rarity}` : ''}" title="${esc(x.name || '')}"><img src="${esc(x.icon)}" alt=""></span>`
      : `<span class="eog__slot ${cls || ''} is-empty"></span>`).join('');
    const teamLabel = (t, i) => arena ? `${t.mine ? 'Your duo' : 'Duo'}${t.placement ? `, ${ord(t.placement)}` : ''}` : t.mine ? 'Your team' : 'Enemy team';
    // Header like the client's end-of-game screen: mode icon, VICTORY / DEFEAT, then map, mode, length, date, game ID
    const folder = { aram: 'aram', mayhem: 'aram', arena: 'cherry' }[r.mode] || 'classic_sru';
    const modeIcon = `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/content/src/leagueclient/gamemodeassets/${folder}/img/icon-${good ? 'victory' : 'defeat'}.png`;
    const facts = [r.mapName, MODE_LABEL[r.mode] || r.queueName, mmss(r.duration), new Date(r.start || r.end).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit', year: 'numeric' })].filter(Boolean);
    recap = `<section class="chartcard eog ${good ? 'is-win' : 'is-loss'}">
      <div class="eog__head">
        <span class="eog__icon">${img(modeIcon)}</span>
        <div><h3 class="eog__result">${arena ? esc(title) : good ? 'Victory' : 'Defeat'}</h3>
          <div class="eog__facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}
            <button class="eog__gameid" data-copy="${esc(r.gameId)}" title="Copy game ID ${esc(r.gameId)}">GameID
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button></div></div>
        <span class="eog__ago muted">${ago(r.end)}</span>
      </div>
      <div class="eog__wrap"><table class="eog__table">${r.teams.map((t, ti) => `
        <tbody class="${t.mine ? 'is-mine' : ''} ${(arena ? t.placement === 1 : t.win) ? 'is-won' : 'is-lost'}">
          <tr class="eog__team"><th colspan="3">${esc(teamLabel(t, ti))}</th>
            ${hasAugs ? '<th>Augments</th>' : ''}<th>Items</th>
            <th class="n eog__kdah">${t.k} / ${t.d} / ${t.a}</th><th class="n eog__gold">${t.gold.toLocaleString()}</th><th class="c">Grade</th></tr>
          ${t.players.map((p) => `<tr class="${p.isMe ? 'is-me' : ''} ${p.slot ? pc(p.slot) : ''}">
            <td class="eog__spells"><span>${slots(p.spells, 2, 'is-spell')}</span></td>
            <td class="eog__lvl">${p.level}</td>
            <td class="eog__who"><span class="eog__whoin"><span class="eog__champ">${img(p.champ.icon, p.champ.name)}</span>
              <span class="eog__name ${p.isParty ? 'is-friend' : ''}">${esc(p.name)}${p.mvp ? ' <em class="eog__mvp">MVP</em>' : ''}</span></span></td>
            ${hasAugs ? `<td><span class="eog__row">${slots(p.augments, augN, 'is-aug')}</span></td>` : ''}
            <td><span class="eog__row">${slots(p.items.slice(0, 6), 6)}${slots(p.items.slice(6, 7), 1, 'is-trinket')}</span></td>
            <td class="n eog__kda">${p.k} / ${p.d} / ${p.a}</td>
            <td class="n eog__gold">${p.gold.toLocaleString()}</td>
            <td class="c">${gradeBadge(p.grade)}</td>
          </tr>`).join('')}
        </tbody>`).join('')}</table></div></section>`;
  }

  // ---- performance table, columns depend on the mode
  const METRICS = {
    rift: [['Win rate', 'winRate', pct], ['KDA', 'kda', (v) => v.toFixed(2)], ['KP', 'kp', pct], ['CS/min', 'csm', (v) => v.toFixed(1)], ['Dmg/min', 'dpm', (v) => Math.round(v).toLocaleString()], ['Vision/min', 'vpm', (v) => v.toFixed(2)]],
    aram: [['Win rate', 'winRate', pct], ['KDA', 'kda', (v) => v.toFixed(2)], ['KP', 'kp', pct], ['Dmg/min', 'dpm', (v) => Math.round(v).toLocaleString()], ['Tank/min', 'tpm', (v) => Math.round(v).toLocaleString()], ['Heal/min', 'hpm', (v) => Math.round(v).toLocaleString()], ['Pentas', 'pentas', (v) => v]],
    arena: [['Avg place', 'avgPlace', (v) => v.toFixed(1), { low: true }], ['1st place', 'firstRate', pct], ['Top 4', 'top4Rate', pct], ['KDA', 'kda', (v) => v.toFixed(2)], ['Dmg/min', 'dpm', (v) => Math.round(v).toLocaleString()], ['Tank/min', 'tpm', (v) => Math.round(v).toLocaleString()]],
  };
  METRICS.mayhem = METRICS.aram;
  const metrics = METRICS[mode] || METRICS.rift;
  const best = Object.fromEntries(metrics.map(([, key, , o]) => {
    const vals = F.filter((f) => f && f[key] != null).map((f) => f[key]);
    return [key, vals.length ? (o?.low ? Math.min(...vals) : Math.max(...vals)) : null];
  }));
  const rankLine = (r) => {
    if (!r) return '<span class="rk rk--none">Unranked</span>';
    const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(r.tier);
    const d = r.weekDelta;
    return `<span class="rk t-${r.tier.toLowerCase()}">${rankEmblem(r.tier)}${cap(r.tier.toLowerCase())}${apex ? '' : ` ${r.division}`} ${r.lp} LP`
      + `${d == null || d === 0 ? '' : `<em class="${d > 0 ? 'is-up' : 'is-down'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</em>`}</span>`;
  };
  // Rank gets its own column so the emblem can be big
  const rankCell = (r) => {
    if (!r) return '<span class="perf__rank is-none"><span class="perf__rank-emblem"></span><span><b>Unranked</b></span></span>';
    const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(r.tier);
    const d = r.weekDelta;
    return `<span class="perf__rank t-${r.tier.toLowerCase()}">${rankEmblem(r.tier, 'perf__rank-emblem')}
      <span><b>${cap(r.tier.toLowerCase())}${apex ? '' : ` ${r.division}`}</b><small>${r.lp} LP${d == null || d === 0 ? '' : ` <em class="${d > 0 ? 'is-up' : 'is-down'}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</em>`}</small></span></span>`;
  };
  // Main role on the Rift, best champion class everywhere else (you don't pick in ARAM)
  const styleCell = (f, rank) => {
    if (!f) return '<span class="perf__none">–</span>';
    const list = Object.entries((mode === 'rift' ? f.roles : f.classes) || {}).sort((a, b) => b[1].games - a[1].games);
    const total = list.reduce((a, [, x]) => a + x.games, 0);
    if (!total) return '<span class="perf__none">–</span>';
    if (mode === 'rift') {
      const [name, x] = list[0], next = list[1];
      // icon with the role name underneath; the numbers are in the tooltip
      return `<span class="perf__roleicon perf__roleicon--stack" title="${pct(x.games / total)} of games, ${pct(x.wins / x.games)} WR${next ? `; then ${next[0]} ${pct(next[1].games / total)}` : ''}">${roleIcon(name, rank?.tier)}<b>${name}</b></span>`;
    }
    const enough = list.filter(([, x]) => x.games >= 5);
    const [name, x] = (enough.length ? enough.sort((a, b) => b[1].wins / b[1].games - a[1].wins / a[1].games) : list)[0];
    const most = list[0][0];
    return `<span class="perf__role" title="${pct(x.wins / x.games)} ${mode === 'arena' ? 'top 4' : 'WR'} over ${x.games} games${most !== name ? `, most played: ${cap(most)}` : ''}"><b>${cap(name)}</b></span>`;
  };
  const anyForm = F.some(Boolean);
  const form = anyForm ? `<div class="perf-wrap"><table class="perf">
      <thead><tr><th>Player</th>${mode === 'rift' ? '<th class="rankcol">Rank</th>' : ''}<th class="c">Grade</th><th class="c">${mode === 'rift' ? 'Main role' : 'Best class'}</th>${metrics.map(([label]) => `<th>${label}</th>`).join('')}</tr></thead>
      <tbody>${P.map((p, i) => {
        const f = F[i];
        return `<tr class="${pc(p.slot)}">
          <td><span class="perf__who">${p.icon ? `<img src="${esc(p.icon)}" alt="">` : '<i></i>'}<span><b>${esc(p.name)}</b><span class="perf__games">${f ? plural(f.games, 'game') : 'No games'}</span></span></span></td>
          ${mode === 'rift' ? `<td class="rankcol">${rankCell(s.form[i]?.rank)}</td>` : ''}
          <td class="c">${gradeBadge(f?.grade, true)}${f ? `<small class="perf__sub">${f.score.toFixed(1)} score</small>` : ''}</td>
          <td class="c">${styleCell(f, s.form[i]?.rank)}</td>
          ${metrics.map(([, key, fmt, o]) => {
            if (!f || f[key] == null) return '<td class="perf__none">–</td>';
            const top = best[key] != null && f[key] === best[key] && P.length > 1 && (o?.low || best[key] > 0);
            const w = o?.low ? (best[key] / f[key]) * 100 : best[key] > 0 ? (f[key] / best[key]) * 100 : 0;
            return `<td class="${top ? 'is-best' : ''}"><span class="perf__v">${fmt(f[key])}${top ? '<em>Best</em>' : ''}</span>
              ${o?.sub ? `<small class="perf__sub">${f[o.sub] || 0} ${o.sub}</small>` : `<span class="perf__bar"><i style="--w:${w}%"></i></span>`}</td>`;
          }).join('')}
        </tr>`;
      }).join('')}</tbody></table></div>
    <p class="coverage" style="margin:10px 0 0">${MODE_LABEL[mode]} only, each person's last 50 games with a full scoreboard. Bars compare everyone to the best in each column.${mode === 'arena' ? ' Tank/min is damage taken.' : mode === 'rift' ? '' : ' Tank/min is damage taken, Heal/min is healing plus shielding on teammates.'}
      Grades rate you against everyone else in the game${mode === 'arena' ? ', mostly on placement' : mode === 'rift' ? '' : ', counting damage, kill participation, tanking and healing'}.${mode === 'rift' ? ' Rank is Solo/Duo, with LP gained or lost this week.' : ''}</p>`
    : `<p class="muted">No ${MODE_LABEL[mode]} games with a scoreboard yet.</p>`;

  // ---- champion pools for this mode
  const anyPool = F.some((f) => f?.pool?.length);
  const poolTitle = mode === 'rift' ? 'Champion pools' : mode === 'arena' ? 'Arena picks' : 'Top champions';
  const pools = anyPool ? `<div class="pools" style="grid-template-columns:repeat(${P.length}, minmax(0, 1fr))">${F.map((f, i) => `<div class="pool">
      <div class="pool__head">${nameCell(P[i])}</div>
      ${(f?.pool || []).length ? f.pool.map((c) => `<div class="pool__row"><span class="pool__img">${img(c.champ.icon, c.champ.name)}</span>
        <span class="pool__name"><b>${esc(c.champ.name)}</b><small>${c.kda.toFixed(2)} KDA</small></span>
        <span class="pool__num"><b class="${c.winRate >= 0.55 ? 'is-good' : c.winRate < 0.45 ? 'is-bad' : ''}">${pct(c.winRate)}${mode === 'arena' ? ' top 4' : ''}</b><small>${c.games} games</small></span></div>`).join('')
      : '<p class="muted small">No games in this mode.</p>'}
      ${(mode === 'arena' || mode === 'mayhem') && f?.augments?.length ? `<div class="pool__augs"><span class="label">Go-to augments</span>${augmentIcons(f.augments, { size: 'md', stats: mode })}</div>` : ''}</div>`).join('')}</div>` : `<p class="muted">No ${MODE_LABEL[mode]} games yet.</p>`;

  // ---- skinlines (not mode-specific)
  const maxLine = Math.max(1, ...s.skinlines.map((l) => l.counts.reduce((a, b) => a + b, 0)));
  const lines = s.skinlines.length ? `<div class="bars">${s.skinlines.map((l) => {
    const total = l.counts.reduce((a, b) => a + b, 0);
    return `<div class="bars__row"><span class="bars__label" title="${esc(l.name)}">${esc(l.name)}</span>
      <span class="stackbar" style="--w:${(total / maxLine) * 100}%">${l.counts.map((c, i) => c ? `<i class="${pc(P[i].slot)}" style="flex:${c}" title="${esc(P[i].name)}: ${c}"></i>` : '').join('')}</span>
      <b>${total}</b></div>`;
  }).join('')}</div>` : '<p class="muted">No skinlines shared yet.</p>';

  return `<div class="snap">
    <div class="snap__head"><p class="party-summary__title">Party Snapshot</p></div>
    ${recap}
    <div class="snap__grid">
      <section class="chartcard chartcard--wide"><div class="chartcard__top"><h3 class="chartcard__title">Performance</h3>${modeSeg}</div>${form}</section>
      <section class="chartcard chartcard--wide"><h3 class="chartcard__title">${poolTitle}</h3>${pools}</section>
    </div></div>`;
}

// ---------- live game card (Riot's Live Client Data: only what the in-game scoreboard shows) ----------
function liveCard() {
  const L = state.live;
  if (!L) return '';
  const q = currentQueue() || {};
  const kind = L.kind;
  const rift = kind === 'rift', arena = kind === 'arena';
  const facts = [L.mapName || (q.mapName && q.mapName !== 'Random Map' ? q.mapName : null), q.name || MODE_LABEL[kind] || L.mode, q.pick].filter(Boolean);
  const box = (x, cls = '') => (x?.icon ? `<span class="eog__slot ${cls}" title="${esc(x.name || '')}"><img src="${esc(x.icon)}" alt=""></span>` : `<span class="eog__slot ${cls} is-empty"></span>`);
  // Columns per match type: the Rift has vision and roles; ARAM/Mayhem have CS but no jungle objectives; Arena is just fights
  const cols = [
    { head: 'Items', cell: (p) => `<span class="eog__row">${p.items.slice(0, 6).map((it) => box(it)).join('')}${box(p.items[6], 'is-trinket')}</span>` },
    { head: (t) => `${t.kills} kills`, cls: 'n eog__kdah', cellCls: 'n eog__kda', cell: (p) => `${p.k} / ${p.d} / ${p.a}` },
    ...(arena ? [] : [{ head: 'CS', cls: 'n', cellCls: 'n', cell: (p) => p.cs }]),
    ...(rift ? [{ head: 'Vision', cls: 'n', cellCls: 'n', cell: (p) => p.ward }] : []),
  ];
  const objectives = (t) => (arena ? '' : [plural(t.towers, 'tower'), t.inhibs ? plural(t.inhibs, 'inhib') : '',
    ...(rift ? [plural(t.dragons.length, 'drake'), t.heralds ? plural(t.heralds, 'herald') : '', t.barons ? plural(t.barons, 'baron') : ''] : [])].filter(Boolean).join(', '));
  const team = (t) => {
    const mine = t.id === L.myTeam;
    return `<tbody class="${mine ? 'is-mine is-won' : 'is-lost'}">
      <tr class="eog__team"><th colspan="3">${mine ? 'Your team' : arena ? 'Opponents' : 'Enemy team'}${arena ? '' : ` <span class="eog__side">${esc(t.side)}</span>`}</th>
        ${cols.map((c) => `<th class="${c.cls || ''}">${typeof c.head === 'function' ? c.head(t) : c.head}</th>`).join('')}
        <th class="eog__obj" title="${esc(t.dragons.join(', '))}">${objectives(t)}</th></tr>
      ${t.players.map((p) => `<tr class="${p.isMe ? 'is-me' : ''} ${p.slot ? pc(p.slot) : ''} ${p.dead ? 'is-dead' : ''}">
        <td class="eog__spells"><span>${box(p.spells[0], 'is-spell')}${box(p.spells[1], 'is-spell')}</span></td>
        <td class="eog__lvl">${p.level}</td>
        <td class="eog__who"><span class="eog__whoin"><span class="eog__champ lchamp">${img(p.champ.icon, p.champ.name)}
            ${p.dead && p.respawn > 0 ? `<b class="lchamp__respawn" data-respawn="${p.respawn}" data-at="${L.receivedAt}">${p.respawn}</b>` : ''}</span>
          <span class="eog__name ${p.isParty ? 'is-friend' : ''}">${esc(p.name)}<small>${esc([p.champ.name, rift ? p.role : null].filter(Boolean).join(', '))}</small></span></span></td>
        ${cols.map((c) => `<td class="${c.cellCls || ''}">${c.cell(p)}</td>`).join('')}
        <td></td>
      </tr>`).join('')}
    </tbody>`;
  };
  const icon = q.icon || MODE_ICON(kind);
  return `<section class="chartcard eog eog--live" data-kind="${kind}">
    <div class="eog__head">
      <span class="eog__icon">${img(icon)}</span>
      <div><h3 class="eog__result">In game <span class="eog__clock" data-gclock="${L.time}" data-at="${L.receivedAt}">${clock(L.time)}</span></h3>
        <div class="eog__facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</div></div>
    </div>
    <div class="eog__wrap"><table class="eog__table">${L.teams.map(team).join('')}</table></div>
    ${L.feed.length ? `<div class="eog__feed"><div class="label">Game feed</div><ol>${L.feed.slice(0, 8).map((f) => `<li class="${f.mine ? 'is-mine' : f.team ? 'is-theirs' : ''} ${f.big ? 'is-big' : ''}">
      <span class="lfeed__t">${clock(f.t)}</span><span>${esc(f.text)}</span></li>`).join('')}</ol></div>` : ''}
  </section>`;
}
// Tick the game clock and respawn timers between updates
setInterval(() => {
  document.querySelectorAll('[data-gclock]').forEach((el) => { el.textContent = clock(Number(el.dataset.gclock) + (Date.now() - Number(el.dataset.at)) / 1000); });
  document.querySelectorAll('[data-respawn]').forEach((el) => {
    const left = Math.ceil(Number(el.dataset.respawn) - (Date.now() - Number(el.dataset.at)) / 1000);
    el.textContent = Math.max(0, left);
  });
}, 500);

// ---------- champ select ----------
// Champ select: each person's own lobby banner, filled with the loading-screen art of the skin they're wearing
function pcard(c) {
  const picking = !c.champ;
  const cls = ['lbanner', 'csb', pc(c.slot), picking && 'csb--picking', c.locked && 'is-locked', c.isMe && 'csb--me'].filter(Boolean).join(' ');
  const art = c.banner ? `style="--banner:url('${esc(c.banner)}'); --orn:${Number(c.orn) || 0.8}"` : '';
  return `<div class="${cls}" ${art}>
    <div class="csb__art">${picking ? '<span class="csb__picking">Picking...</span>' : img(c.skin?.card, c.skin?.name || c.champ.name)}
      <span class="pcard__lock" aria-label="Locked in">✓</span></div>
    ${picking ? '' : `<div class="csb__skin" title="${esc(c.skin?.name || c.champ.name)}">${esc(c.skin?.name || c.champ.name)}</div>`}
    <div class="lbanner__crest">
      ${c.icon ? `<img class="lbanner__icon" src="${esc(c.icon)}" alt="">` : '<span class="lbanner__icon"></span>'}
      ${c.crest ? `<img class="lbanner__frame" src="${esc(c.crest)}" alt="">` : ''}
      ${c.gem ? `<img class="lbanner__gem" src="${esc(c.gem)}" alt="">` : ''}
    </div>
    <div class="lbanner__name ${(c.name || '').length > 13 ? 'is-long' : ''}" title="${esc(c.name)}${esc(c.tag || '')}">${esc(c.name)}</div>
    <div class="lbanner__sub">${esc(c.title || '')}</div>
  </div>`;
}

function renderLive() {
  const cs = state.champSelect;
  // Build the team row: groups collapse into one item at their first member's position, mine moves to the middle
  const everyone = cs.groups.length === 1 && cs.groups[0].ids.length === cs.cards.length && cs.cards.length >= 2;
  const placed = new Set();
  let items = [];
  for (const c of cs.cards) {
    const gi = cs.groups.findIndex((g) => g.ids.includes(c.id));
    if (gi < 0) { items.push({ html: pcard(c), mine: c.id === cs.myId }); continue; }
    if (placed.has(gi)) continue;
    placed.add(gi);
    const g = cs.groups[gi];
    const members = cs.cards.filter((x) => g.ids.includes(x.id));
    const cls = ['match', gi === 1 && 'match--b', everyone && 'match--all', groupIsNew(g) && 'is-new'].filter(Boolean).join(' ');
    items.push({
      mine: g.ids.includes(cs.myId),
      html: `<div class="${cls}">${everyone ? sparkles() : ''}<div class="match__cards">${members.map(pcard).join('')}</div><div class="match__ribbon">${esc(g.lineName)}</div></div>`,
    });
  }
  const mineIdx = items.findIndex((i) => i.mine);
  if (mineIdx >= 0) {
    const [m] = items.splice(mineIdx, 1);
    items.splice(Math.floor(items.length / 2), 0, m);
  }
  // everyone's crest and name on one line: follow the tallest bottom decoration in the group
  const csOrn = Math.min(0.8, ...cs.cards.map((c) => Number(c.orn) || 0.8));
  let html = `<div class="cs">${queueHeader()}<div class="team ${everyone ? 'team--all' : ''}" style="--orn-row:${csOrn}">${items.map((i) => i.html).join('')}</div>`;

  if (cs.benchOptions.length) {
    html += `<div class="bench"><span class="label">ARAM bench</span>${cs.benchOptions.map((b) =>
      `<span class="bench-chip">${img(b.champ.icon)}${esc(b.champ.name)} <span>${plural(b.count, 'line')}, up to ${b.most} of you</span></span>`).join('')}</div>`;
  }
  // Party Snapshot stays underneath during champ select
  const smIds = (state.lobby || []).filter((f) => f.onSkinMatch).map((f) => f.puuid);
  const key = smIds.join(',');
  if (key !== partyStatsKey) { partyStats = null; partyStatsKey = key; }
  if (smIds.length && !partyStats) {
    api.partySummary(smIds).then((ps) => { partyStats = ps; if (tab === 'party' && inChampSelect()) renderLive(); });
  }
  if (smIds.length && partyStats) {
    const face = (p) => `<img class="${pc(p.slot)}" src="${esc(p.icon || '')}" alt="">`;
    html += `<div class="cs__snap">${snapshotHtml(partyStats, face)}</div>`;
  }
  view.innerHTML = html + '</div>';
  view.querySelectorAll('[data-snapmode]').forEach((b) => (b.onclick = () => { snapMode = b.dataset.snapmode; renderLive(); }));
  view.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(b.dataset.copy); b.classList.add('is-copied'); setTimeout(() => b.classList.remove('is-copied'), 1200); } catch { /* clipboard blocked */ }
  }));
  bindApply(view, () => tab === 'party' && inChampSelect() && renderLive());
  watchImages(view);
}

function sparkles() {
  const spots = ['left:8%;top:6%', 'left:24%;top:0', 'left:46%;top:3%', 'right:26%;top:1%', 'right:8%;top:7%', 'left:3%;bottom:18%', 'right:3%;bottom:20%', 'left:50%;bottom:2%'];
  return `<div class="sparkles" aria-hidden="true">${spots.map((s) => `<i style="${s}"></i>`).join('')}</div>`;
}

// ---------- explore ----------
async function renderExplore() {
  if (!champs.length) champs = await api.champions();
  if (!champs.length) return empty('Champion data not loaded', 'Open the League client once so ff can load skin data.');
  if (!state.party.length) return empty('No friends yet', 'Friends get added when they join your League lobby with ff open.');
  if (!state.party.some((f) => f.puuid === explorePick.friend)) explorePick.friend = state.party[0].puuid;
  view.innerHTML = `<div class="pickers">
      <label class="field"><span>Your champion</span><input class="input" list="champlist" id="exMine" value="${esc(explorePick.mine)}"></label>
      <label class="field"><span>Friend</span><select class="select" id="exFriend">${state.party.map((f) => `<option value="${esc(f.puuid)}" ${f.puuid === explorePick.friend ? 'selected' : ''}>${esc(f.name)}${f.online ? '' : ' (offline)'}</option>`).join('')}</select></label>
      <label class="field"><span>Their champion</span><input class="input" list="champlist" id="exTheirs" value="${esc(explorePick.theirs)}"></label>
      <datalist id="champlist">${champs.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
    </div><div id="exResult"></div>`;
  const run = async () => {
    explorePick = { mine: exMine.value, friend: exFriend.value, theirs: exTheirs.value };
    const find = (n) => champs.find((c) => c.name.toLowerCase() === n.trim().toLowerCase());
    const a = find(explorePick.mine), b = find(explorePick.theirs);
    const f = state.party.find((x) => x.puuid === explorePick.friend);
    const out = document.getElementById('exResult');
    if (!a || !b) return (out.innerHTML = '<p class="muted" style="margin:0">Pick a champion for each of you.</p>');
    const m = await api.explore(a.id, f.puuid, b.id);
    if (!m.length) return (out.innerHTML = `<p class="muted" style="margin:0">${esc(a.name)} and ${esc(f.name)}'s ${esc(b.name)} don't share any skinlines.</p>`);
    const tiles = (skins) => {
      const shown = skins.slice(0, skins.length > 4 ? 3 : 4);
      return `<div class="tiles">${shown.map((s) => `<span class="tile" title="${esc(s.name)}">${img(s.tile, s.name)}</span>`).join('')}${skins.length > shown.length ? `<span class="tile tile--more">+${skins.length - shown.length}</span>` : ''}</div>`;
    };
    out.innerHTML = `<div class="label" style="margin-bottom:12px">${plural(m.length, 'shared skinline')}</div><div class="xgrid">${m.map((x) => `
      <div class="xline"><div class="xline__name">${esc(x.lineName)}</div><div class="xline__cols">
        <div class="pc-me"><div class="xline__who">You</div>${tiles(x.mySkins)}</div>
        <div class="${pc(f.slot)}"><div class="xline__who">${esc(f.name)}</div>${tiles(x.members[0].skins)}</div>
      </div></div>`).join('')}</div>`;
    watchImages(out);
  };
  exMine.onchange = run; exTheirs.onchange = run; exFriend.onchange = run;
  run();
}

// ---------- shared skinlines ----------
async function renderLines() {
  if (!state.party.length) return empty('No friends yet', 'Friends get added when they join your League lobby with ff open.');
  const { people, lines } = await api.sharedLines();
  const sorted = [...lines].sort((a, b) => (b.counts.filter(Boolean).length - a.counts.filter(Boolean).length) || (b.counts.reduce((x, y) => x + y) - a.counts.reduce((x, y) => x + y)));
  view.innerHTML = `<h2 class="section-title">Skinlines your party owns</h2>
    <p class="coverage">${lines.length}, sorted by how many of you own one</p>
    <table class="table"><thead><tr><th>Skinline</th>${people.map((p) => `<th class="person ${pc(p.slot)}" title="${esc(p.full || p.name)}">${esc(p.name)}</th>`).join('')}</tr></thead><tbody>
    ${sorted.map((l) => {
      const max = Math.max(...l.counts);
      return `<tr><td>${esc(l.lineName)}</td>${l.counts.map((c) => c
        ? `<td class="n ${c === max && l.counts.filter((x) => x === max).length === 1 ? 'top' : ''}">${c}</td>`
        : '<td class="n dash" aria-label="none">–</td>').join('')}</tr>`;
    }).join('')}</tbody></table>`;
}

// ---------- stats ----------
const pct = (x) => `${Math.round(x * 100)}%`;
const hrsHtml = (h) => `${h >= 10 ? Math.round(h).toLocaleString() : h.toFixed(1)}<small>hr</small>`;
const hrsText = (h) => `${h >= 10 ? Math.round(h).toLocaleString() : h.toFixed(1)} hr`;
const monthYear = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
const stat = (v, l, { sub = '', accent = false } = {}) => `<div class="stat ${accent ? 'stat--accent' : ''}"><div class="stat__v">${v}</div><div class="stat__l">${l}</div>${sub ? `<div class="stat__sub">${sub}</div>` : ''}</div>`;
const wr = (x) => `<span class="wr ${x >= 0.55 ? 'is-good' : ''}" style="--v:${Math.round(x * 100)}%">${pct(x)}<i></i></span>`;
const champCell = (c) => `<span class="champ-cell">${img(c.icon)}${esc(c.name)}</span>`;

async function renderStats() {
  const { who, mode } = statsView;
  if (!state.party.some((f) => f.puuid === statsView.friend)) statsView.friend = state.party[0]?.puuid || '';
  if (who !== 'me' && !state.party.length) statsView.who = 'me';
  const friend = state.party.find((f) => f.puuid === statsView.friend);
  const segBtn = (key, label, cls, friendId = '') => {
    const pressed = statsView.who === key && (key !== 'friend' || friendId === statsView.friend);
    return `<button class="seg__btn ${cls}" data-who="${key}" data-friend="${esc(friendId)}" aria-pressed="${pressed}" title="${esc(label)}">${esc(label)}</button>`;
  };
  const modes = [['all', 'All'], ['rift', "Summoner's Rift"], ['aram', 'ARAM'], ['arena', 'Arena']];
  let html = `<div class="stats-bar">
    <div class="seg" role="group" aria-label="Whose stats">${segBtn('me', 'You', 'pc-me')}${state.party.map((f) => segBtn('friend', f.name, pc(f.slot), f.puuid)).join('')}${state.party.length ? segBtn('duo', 'Together', 'seg__btn--together') : ''}</div>
    <div class="stats-filters">
      ${statsView.who === 'duo' && state.party.length > 1 ? `<select class="select" id="duoFriend" aria-label="Together with">${state.party.map((f) => `<option value="${esc(f.puuid)}" ${f.puuid === statsView.friend ? 'selected' : ''}>With ${esc(f.name)}</option>`).join('')}</select>` : ''}
      <div class="seg seg--sm" role="group" aria-label="Mode">${modes.map(([k, l]) => `<button class="seg__btn" data-mode="${k}" aria-pressed="${k === mode}">${l}</button>`).join('')}</div>
    </div></div>`;

  const data = await api.stats(statsView.who, mode, statsView.friend);
  if (statsView.who === 'duo') {
    html += data ? duoHtml(data, friend.name) : emptyState(`No games with ${friend.name} yet`, `Games where you and ${friend.name} are on the same team show up here.`);
  } else if (!data || !data.games) {
    html += statsView.who === 'me'
      ? emptyState('No stats yet', 'Open League and your recent games load on their own. For your full history, add a Riot API key in Settings.')
      : emptyState(`No stats for ${friend?.name} yet`, 'They show up once ff on their PC has synced.');
  } else {
    html += soloHtml(data, statsView.who === 'me');
  }
  view.innerHTML = html;
  view.querySelectorAll('[data-who]').forEach((b) => (b.onclick = () => {
    statsView.who = b.dataset.who;
    if (b.dataset.friend) statsView.friend = b.dataset.friend;
    renderStats();
  }));
  view.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { statsView.mode = b.dataset.mode; renderStats(); }));
  const df = document.getElementById('duoFriend');
  if (df) df.onchange = (e) => { statsView.friend = e.target.value; renderStats(); };
  watchImages(view);
}

function soloHtml(d, isMe) {
  let html = `<div class="nums">${stat(hrsHtml(d.hours), 'played')}${stat(d.games.toLocaleString(), 'games')}${stat(pct(d.winRate), 'win rate')}${stat(d.kda.toFixed(2), 'KDA', { sub: `${d.avg.k.toFixed(1)} / ${d.avg.d.toFixed(1)} / ${d.avg.a.toFixed(1)} avg` })}</div>`;
  html += `<p class="coverage">Based on ${plural(d.games, 'game')} since ${monthYear(d.since)}. ${d.games < 20 && isMe ? 'Import your full history in Settings for the real numbers.' : 'Remakes aren\'t counted.'}</p>`;
  const stickers = [];
  const top = d.champs?.[0], second = d.champs?.[1];
  if (top) stickers.push(`<div class="sticker"><b>${esc(top.champ.name)}, ${plural(top.games, 'game')}</b>${second && top.games > second.games * 1.3 ? 'Most played by a mile' : 'Most played'}</div>`);
  if (d.bestWinRate) stickers.push(`<div class="sticker"><b>${esc(d.bestWinRate.champ.name)}, ${pct(d.bestWinRate.winRate)}</b>Best win rate (20+ games)</div>`);
  if (d.streak >= 3) stickers.push(`<div class="sticker"><b>${d.streak} wins in a row</b>Longest streak</div>`);
  if (stickers.length) html += `<div class="stickers">${stickers.join('')}</div>`;

  const played = d.champs?.length ? `<div><h3 class="section-title">Most played</h3><table class="table"><thead><tr><th>Champion</th><th class="n">Games</th><th class="n">Time</th><th class="n">Win rate</th><th class="n">KDA</th></tr></thead><tbody>
    ${d.champs.map((c) => `<tr><td>${champCell(c.champ)}</td><td class="n">${c.games}</td><td class="n">${hrsText(c.hours)}</td><td class="n">${wr(c.winRate)}</td><td class="n">${c.kda.toFixed(2)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const mastery = d.mastery?.length ? `<div><h3 class="section-title">Highest mastery</h3><table class="table"><thead><tr><th>Champion</th><th class="n">Level</th><th class="n">Points</th></tr></thead><tbody>
    ${d.mastery.slice(0, 5).map((m) => `<tr><td>${champCell(m.champ)}</td><td class="n"><span class="mastery ${m.level >= 10 ? 'is-max' : ''}">${m.level}</span></td><td class="n">${m.points.toLocaleString()}</td></tr>`).join('')}</tbody></table></div>` : '';
  return html + `<div class="cols-2">${played}${mastery}</div>`;
}

function duoHtml(d, name) {
  const t = d.together;
  if (!t.games) return emptyState(`No games with ${name} yet`, `Games where you and ${name} are on the same team show up here.`);
  let html = `<div class="nums">${stat(t.games.toLocaleString(), `games with ${esc(name)}`)}${stat(hrsHtml(t.hours), `with ${esc(name)}`)}${stat(pct(t.winRate), `win rate with ${esc(name)}`)}${
    stat(d.skins.tracked ? pct(d.skins.matched / d.skins.tracked) : '–', 'games with matching skins', { accent: true, sub: d.skins.tracked ? `${d.skins.matched} of ${d.skins.tracked} tracked` : 'None tracked yet' })}</div>`;
  html += `<p class="coverage">Since ${monthYear(d.since)}. Skin matching counts games since you installed ff.</p>`;
  html += `<div class="vs">
    <div class="vs__row"><span>With ${esc(name)}</span><div class="vs__track"><div class="vs__fill" style="--v:${Math.round(t.winRate * 100)}%"></div></div><b>${pct(t.winRate)}</b></div>
    <div class="vs__row is-apart"><span>Without</span><div class="vs__track"><div class="vs__fill" style="--v:${Math.round(d.apart.winRate * 100)}%"></div></div><b>${d.apart.games ? pct(d.apart.winRate) : '–'}</b></div></div>`;
  const slot = state.party.find((f) => f.name === name)?.slot;
  const duos = d.pairs.length ? `<div><h3 class="section-title">Favorite duos</h3><table class="table"><thead><tr><th>You + ${esc(name)}</th><th class="n">Games</th><th class="n">Win rate</th></tr></thead><tbody>
    ${d.pairs.map((p) => `<tr><td><span class="duo-cell"><span class="stack"><img class="pc-me" src="${esc(p.mine.icon || '')}" alt=""><img class="${pc(slot)}" src="${esc(p.theirs.icon || '')}" alt=""></span>${esc(p.mine.name)} + ${esc(p.theirs.name)}</span></td><td class="n">${p.games}</td><td class="n">${wr(p.winRate)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const lines = d.skins.lines.length ? `<div><h3 class="section-title">Matched in most</h3><table class="table"><tbody>
    ${d.skins.lines.map((l) => `<tr><td>${esc(l.line)}</td><td class="n">${plural(l.games, 'game')}</td></tr>`).join('')}</tbody></table></div>` : '';
  return html + `<div class="cols-2">${duos}${lines}</div>`;
}

// ---------- settings ----------
function importHtml() {
  const st = state.importStatus, s = state.settings;
  const running = st?.running;
  let status = `<p class="help">${plural(state.history.games, 'game')} stored.</p>`;
  if (running) {
    const p = st.total ? Math.round((st.done / st.total) * 100) : 0;
    const mins = st.phase === 'Importing games' ? Math.ceil((st.total - st.done) / 49) : null;
    status = `<div class="progress" role="progressbar" aria-valuenow="${st.done}" aria-valuemax="${st.total}"><div class="progress__bar" style="--p:${p}%"></div></div>
      <div class="import__status">${esc(st.phase)}: ${st.done.toLocaleString()} of ${st.total.toLocaleString()}${mins ? ` <span class="muted">· about ${plural(mins, 'min')} left</span>` : ''}</div>`;
  } else if (st?.error) {
    status = `<div class="alert alert--error" id="importErr">${esc(st.error)}</div>`;
  } else if (st?.phase) {
    status = `<div class="alert alert--ok">${esc(st.phase)}. ${plural(st.done || 0, 'game')} imported.</div>`;
  }
  return `<div class="inline"><button class="btn ${running ? 'btn--danger' : 'btn--primary'}" id="importBtn" ${!s.riotKey && !running ? 'disabled' : ''}>${running ? 'Stop import' : 'Import history'}</button></div>${status}`;
}

function renderSettings() {
  const s = state.settings;
  view.innerHTML = `<div class="settings">
    <div class="setting"><div style="flex:1"><div class="setting__title">Connect a friend's ff</div>
      <p class="setting__desc">Friends with ff open are picked up automatically when they join your League lobby. Manage your friends list on the Friends tab.</p>
      <div class="field" style="margin-top:12px"><span>Connect by address</span>
        <div class="inline"><input class="input" id="peerAddr" placeholder="192.168.1.20" aria-label="Friend's address" aria-describedby="peerMsg"><button class="btn" id="peerConnect" type="button">Connect</button></div>
        <p class="msg" id="peerMsg" role="status"></p><p class="help" id="myAddr">Only needed if a friend in your lobby doesn't show up.</p></div>
    </div></div>
    <div class="setting"><div><div class="setting__title">Start with Windows</div><p class="setting__desc">ff waits quietly in the system tray (bottom-right, by the clock) so it's ready when you play. Closing the window hides it there; right-click the tray icon to quit.</p></div>
      <input type="checkbox" role="switch" class="toggle" id="startWithWindows" aria-label="Start with Windows" ${s.startWithWindows !== false ? 'checked' : ''}></div>
    <div class="setting"><div><div class="setting__title">Open when League starts</div><p class="setting__desc">Pops ff open as soon as the League client launches.</p></div>
      <input type="checkbox" role="switch" class="toggle" id="openWithLeague" aria-label="Open when League starts" ${s.openWithLeague !== false ? 'checked' : ''}></div>
    <div class="setting"><div><div class="setting__title">Auto-equip matching skin</div><p class="setting__desc">Equips your skin from the skinline the most people on your team can match. If a friend is already wearing a line you own, it follows them. It only does this once per set of picks, so changing it yourself sticks.</p></div>
      <input type="checkbox" role="switch" class="toggle" id="autoApply" aria-label="Auto-equip matching skin" ${s.autoApply ? 'checked' : ''}></div>
    <div class="setting"><div><div class="setting__title">Show overlay in champ select</div><p class="setting__desc">A small always-on-top window during champ select. Close it with × for the rest of that champ select.</p></div>
      <input type="checkbox" role="switch" class="toggle" id="overlay" aria-label="Show overlay in champ select" ${s.overlay ? 'checked' : ''}></div>
    <div class="setting"><div style="flex:1"><div class="setting__title">Riot API key</div><p class="setting__desc">Powers profiles, ranks, friends added by Riot ID and history import. Get one at developer.riotgames.com. Dev keys expire after 24 hours; everything already loaded stays, just paste a new key.</p>
      <div class="import"><div class="inline"><input class="input" type="password" id="riotKey" placeholder="${s.riotKey ? 'Key saved, paste a new one to replace it' : 'RGAPI-...'}" aria-label="Riot API key" autocomplete="off">
      <button class="btn btn--primary" id="keySave">Save key</button></div><p class="msg msg--ok" id="keyMsg" role="status"></p></div></div></div>
    <div class="setting"><div style="flex:1"><div class="setting__title">Import full match history</div><p class="setting__desc">Pulls up to 2 years of your games from Riot, so your stats aren't limited to recent matches.</p>
      <div class="import" id="import">${importHtml()}</div></div></div>
  <div class="setting"><div style="flex:1"><div class="setting__title">ff version ${esc(state.version || '')}</div>
      <p class="setting__desc" id="updStatus">${esc(state.updateStatus?.text || '')}</p></div>
      ${state.update?.ready ? '<button class="btn btn--match" id="updNow">Restart to update</button>' : '<button class="btn" id="updCheck">Check for updates</button>'}</div>
  <p class="legal">ff is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or registered trademarks of Riot Games, Inc.</p>
  </div>`;
  document.getElementById('autoApply').onchange = (e) => api.setSettings({ autoApply: e.target.checked });
  const updCheck = document.getElementById('updCheck');
  if (updCheck) updCheck.onclick = () => { updCheck.disabled = true; api.checkForUpdates(); };
  const updNow = document.getElementById('updNow');
  if (updNow) updNow.onclick = () => api.installUpdate();
  document.getElementById('startWithWindows').onchange = (e) => api.setSettings({ startWithWindows: e.target.checked });
  document.getElementById('openWithLeague').onchange = (e) => api.setSettings({ openWithLeague: e.target.checked });
  document.getElementById('keySave').onclick = async () => {
    const k = document.getElementById('riotKey').value.trim();
    if (!k) return;
    await api.saveKey(k);
    document.getElementById('riotKey').value = '';
    document.getElementById('keyMsg').textContent = 'Key saved.';
  };
  api.myIp().then((ip) => { const el = document.getElementById('myAddr'); if (el) el.textContent = `Only needed if a friend in your lobby doesn't show up. This PC's address is ${ip || 'unknown'}.`; });
  document.getElementById('peerConnect').onclick = async () => {
    const input = document.getElementById('peerAddr'), msg = document.getElementById('peerMsg');
    const addr = input.value.trim();
    if (!addr) return;
    msg.className = 'msg'; msg.textContent = 'Connecting...';
    const res = await api.addAddress(addr);
    if (!res.ok) {
      input.className = 'input is-error'; msg.className = 'msg msg--error';
      msg.textContent = `Couldn't reach ff at ${addr}. Check it's open on their PC and allowed through the firewall.`;
      return;
    }
    input.className = 'input is-ok'; msg.className = 'msg msg--ok';
    msg.textContent = res.added ? `Connected. ${res.name} is now a friend.` : `Connected to ${res.name}.`;
  };
  document.getElementById('overlay').onchange = (e) => api.setSettings({ overlay: e.target.checked });
  bindImport();
}

function bindImport() {
  document.getElementById('importBtn').onclick = () => {
    if (state.importStatus?.running) return api.stopImport();
    api.startImport('');
  };
}

// ---------- shell ----------
function empty(title, text, opts) {
  view.innerHTML = emptyState(title, text, opts);
}

function render() {
  if (!state) return;
  renderHeader();
  updateMatchToast();
  ({ party: renderParty, profiles: renderProfiles, friends: renderFriends, explore: renderExplore, lines: renderLines, collection: renderCollection, stats: renderStats, settings: renderSettings }[tab] || renderParty)();
}

api.onState((s) => {
  const partyChanged = JSON.stringify(s.party.map((f) => f.puuid)) !== JSON.stringify(state?.party.map((f) => f.puuid));
  state = s;
  updateMatchToast();
  const us = document.getElementById('updStatus');
  if (us) us.textContent = s.updateStatus?.text || '';
  if (partyChanged) partyStats = null;
  renderHeader();
  // Jump to Party once when champ select starts, since that's where the matching happens
  if (inChampSelect() && !wasInChampSelect && tab !== 'party') setTab('party');
  wasInChampSelect = inChampSelect();
  const refreshKey = s.refreshing.join(',');
  if (tab === 'profiles' && refreshKey !== lastRefreshKey) render();
  lastRefreshKey = refreshKey;
  if (tab === 'party' || tab === 'lines' || tab === 'friends' || (tab === 'settings' && (partyChanged || watchKey(s) !== lastWatchKey))) render();
  lastWatchKey = watchKey(s);
  if (tab === 'settings') {
    const box = document.getElementById('import');
    if (box) { box.innerHTML = importHtml(); bindImport(); }
  }
});
api.getState().then((s) => { state = s; render(); });


// ---------- skin match pop-up (any tab, during champ select) ----------
const toastState = { dismissed: new Set(), html: '' };
function updateMatchToast() {
  const root = document.getElementById('toastRoot');
  const cs = state.champSelect;
  let html = '';
  if (state.lcu.connected && cs?.active) {
    const a = cs.autoApplied;
    const best = (cs.matches || [])[0];
    const wearing = best && best.mySkins.some((x) => x.id === cs.mySelected);
    const key = best && `${cs.myChamp?.id}:${best.lineId}`;
    const names = (list) => list.length > 2 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list.join(' and ');
    if (a && Date.now() - a.at < 20000 && !toastState.dismissed.has(`auto:${a.at}`)) {
      html = `<div class="mtoast" role="status">
        <span class="mtoast__img">${img(a.tile)}</span>
        <div class="mtoast__body"><div class="mtoast__title">Matched <b>${esc(a.lineName)}</b></div>
          <div class="mtoast__text">Equipped ${esc(a.skinName)} to match ${esc(names(a.with))}.</div>
          <div class="mtoast__actions">${a.prevSkinId ? `<button class="btn btn--sm" data-toast-undo="${a.prevSkinId}">Undo</button>` : ''}</div></div>
        <button class="mtoast__x" data-toast-close="auto:${a.at}" aria-label="Dismiss">×</button></div>`;
    } else if (best && !wearing && !toastState.dismissed.has(key)) {
      const top = best.mySkins[0];
      html = `<div class="mtoast" role="status">
        <span class="mtoast__img">${img(top.tile)}</span>
        <div class="mtoast__body"><div class="mtoast__title">Match <b>${esc(best.lineName)}</b></div>
          <div class="mtoast__text">with ${esc(names(best.members.map((m) => m.name)))}</div>
          <div class="mtoast__actions"><button class="btn btn--match btn--sm" data-toast-equip="${top.id}">Equip ${esc(top.name)}</button>
            ${best.mySkins.length > 1 ? `<span class="mtoast__more">${best.mySkins.slice(1, 4).map((x) => `<button class="mtoast__alt" data-toast-equip="${x.id}" title="Equip ${esc(x.name)}">${img(x.tile)}</button>`).join('')}</span>` : ''}</div>
          <button class="mtoast__link" data-toast-always>Always auto-equip</button></div>
        <button class="mtoast__x" data-toast-close="${esc(key)}" aria-label="Dismiss">×</button></div>`;
    }
  }
  if (html === toastState.html) return;
  toastState.html = html;
  root.innerHTML = html;
  root.querySelectorAll('[data-toast-equip]').forEach((b) => (b.onclick = async () => { b.disabled = true; await api.applySkin(Number(b.dataset.toastEquip)); }));
  root.querySelectorAll('[data-toast-undo]').forEach((b) => (b.onclick = async () => {
    b.disabled = true; await api.applySkin(Number(b.dataset.toastUndo));
    toastState.dismissed.add(`auto:${state.champSelect.autoApplied?.at}`);
    // and don't offer the same match again right away
    const best = (state.champSelect.matches || [])[0];
    if (best) toastState.dismissed.add(`${state.champSelect.myChamp?.id}:${best.lineId}`);
    updateMatchToast();
  }));
  root.querySelectorAll('[data-toast-close]').forEach((b) => (b.onclick = () => { toastState.dismissed.add(b.dataset.toastClose); updateMatchToast(); }));
  root.querySelectorAll('[data-toast-always]').forEach((b) => (b.onclick = async () => { await api.setSettings({ autoApply: true }); }));
}

// ---------- update ready pop-up ----------
let updateToastShown = false;
function showUpdateToast(version) {
  const el = document.createElement('div');
  el.className = 'mtoast mtoast--update';
  el.setAttribute('role', 'status');
  el.innerHTML = `<div class="mtoast__body"><div class="mtoast__title">ff <b>${esc(version)}</b> is ready</div>
    <div class="mtoast__text">Restart to update now, or it installs next time ff quits.</div>
    <div class="mtoast__actions"><button class="btn btn--match btn--sm" data-up-now>Restart to update</button><button class="btn btn--sm" data-up-later>Later</button></div></div>`;
  document.getElementById('toastRoot').before(el);
  el.querySelector('[data-up-now]').onclick = () => api.installUpdate();
  el.querySelector('[data-up-later]').onclick = () => el.remove();
}
