const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { LCU } = require('./lcu');
const { GameData, fetchInventory, champOf, profileIcon, assetUrl, cdragonGet, crestUrl } = require('./data');
const { Cloud } = require('./cloud');
const { JsonStore, fromLcu, fromApi, detailFromLcu, detailFromApi, buildSummary, duoSummary } = require('./stats');
const { backfill, getApi } = require('./riotapi');
const { LiveGame } = require('./livegame');

// Rank champions the way the League client does: mastery level first, then points
const byMastery = (list) => [...list].sort((a, b) => (b.championLevel - a.championLevel) || (b.championPoints - a.championPoints));

// ---------- self-updates from GitHub releases (lapis-xo/ff) ----------
let updateInfo = null; // { version, ready }
let updateStatus = { state: 'idle', text: 'Not checked yet' }; // shown in Settings
// Updater log, so failures can be diagnosed: %APPDATA%\skinmatch\update.log
function ulog(msg) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), `${new Date().toISOString()} v${app.getVersion()} ${msg}\n`); } catch { /* ignore */ }
}
function setStatus(state, text) { updateStatus = { state, text, at: Date.now() }; ulog(`${state}: ${text}`); broadcast(); }
function setupUpdates() {
  if (!app.isPackaged) { updateStatus = { state: 'dev', text: 'Updates only run in the installed app' }; return; }
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { setStatus('error', `Updater missing: ${e.message}`); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => ulog(`info ${m}`), warn: (m) => ulog(`warn ${m}`), error: (m) => ulog(`error ${m}`), debug: () => {} };
  autoUpdater.on('checking-for-update', () => setStatus('checking', 'Checking for updates...'));
  autoUpdater.on('update-not-available', () => setStatus('current', `Up to date (${app.getVersion()})`));
  autoUpdater.on('update-available', (i) => { updateInfo = { version: i.version, ready: false }; setStatus('downloading', `Downloading ${i.version}...`); });
  autoUpdater.on('download-progress', (p) => {
    const pct = Math.floor(p.percent || 0);
    if (pct !== updateStatus.pct) { updateStatus = { state: 'downloading', text: `Downloading ${updateInfo?.version || 'update'}: ${pct}%`, pct }; broadcast(); }
  });
  autoUpdater.on('update-downloaded', (i) => { updateInfo = { version: i.version, ready: true }; setStatus('ready', `${i.version} is ready. Restart to update.`); });
  autoUpdater.on('error', (e) => setStatus('error', `Update failed: ${e?.message || e}`));
  const check = () => autoUpdater.checkForUpdates().catch((e) => setStatus('error', `Update check failed: ${e?.message || e}`));
  setTimeout(check, 8_000);
  setInterval(check, 2 * 3600e3);
  updaterRef = autoUpdater;
  updateCheck = check;
}
let updateCheck = null;
let updaterRef = null;
// Only restarts when an update has actually been downloaded
ipcMain.handle('testPenta', () => { spamPings(); return true; });
ipcMain.handle('authSend', async (_e, email) => { try { await peer.sendCode(String(email).trim()); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('authVerify', async (_e, email, code) => { try { await peer.verifyCode(String(email).trim(), String(code).trim()); broadcast(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('authSignOut', async () => { await peer.signOut(); broadcast(); return true; });
ipcMain.handle('checkForUpdates', () => { if (updateCheck) updateCheck(); return Boolean(updateCheck); });
ipcMain.handle('installUpdate', () => {
  if (!updaterRef || !updateInfo?.ready) return false;
  quitting = true;
  updaterRef.quitAndInstall(false, true);
  return true;
});

const MAX_FRIENDS = 4;
// Data folder stays 'skinmatch' so renaming the app doesn't lose settings, friends or history
app.setPath('userData', path.join(app.getPath('appData'), 'skinmatch'));
const store = (name) => path.join(app.getPath('userData'), name);
const readJson = (name, fallback) => { try { return JSON.parse(fs.readFileSync(store(name), 'utf8')); } catch { return fallback; } };
const writeJson = (name, data) => fs.writeFileSync(store(name), JSON.stringify(data, null, 2));

let mainWin, overlayWin, tray;
let quitting = false;
let leagueWasOpen = false;
const startedHidden = process.argv.includes('--hidden');

// Only one copy of ff at a time; opening it again just shows the window
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showMain());
let settings;
const lcu = new LCU();
const game = new GameData();
let me = null;          // { puuid, summonerId, name, iconId, skinIds, updatedAt }
let known = {};         // puuid -> last inventory seen from any ff app on the network
let session = null;     // latest champ select session
let lobby = [];          // other members of my League lobby: { puuid, name, iconId }
let csLobby = null;      // lobby snapshot for the current champ select
let lastAutoKey = null;
let overlayDismissed = false;
let matchStore, skinLog, details, players; // players: Riot profile cache per puuid
const refreshing = new Set();
let mastery = [];
let summary = null;     // my stats summary, shared with friends
let sharedHistory = []; // compact match list shared with friends for party-wide stats
let myForm = null;       // recent op.gg-style averages, shared so everyone sees the same numbers
let lastCS = null;      // last champ select state that had friends in it
let importStatus = null;
let stopImport = false;

const live = new LiveGame();
live.on('update', () => { checkPenta(); broadcast(); });

// Pentakill: when you get one while playing with your party, your ff gets spammed with "?" pings
const seenPenta = new Set();
function checkPenta() {
  const d = live.data;
  const events = d?.events?.Events || [];
  const now = d?.gameData?.gameTime || 0;
  const mine = String(me?.name || '').split('#')[0].toLowerCase();
  for (const e of events) {
    if (e.EventName !== 'Multikill' || Number(e.KillStreak) < 5 || seenPenta.has(e.EventID)) continue;
    seenPenta.add(e.EventID);
    const killer = String(e.KillerName || '').split('#')[0].toLowerCase();
    const inParty = lobby.some((m) => m.puuid && m.puuid !== me?.puuid);
    const fresh = now - (e.EventTime || 0) < 30; // not an old penta from before ff opened
    if (killer && killer === mine && inParty && fresh && settings.pentaSpam !== false) spamPings();
  }
}
function spamPings() {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('penta');
}
const IN_GAME = ['GameStart', 'InProgress', 'Reconnect'];
// Shared data goes through Supabase now (see cloud.js); "peer" kept as the name the rest of the app uses
const peer = new Cloud(() => me && { ...me, stats: summary, history: sharedHistory, skinLog: skinLog?.data || {}, form: myForm }, {
  // whose data we want: everyone in the lobby / champ select, plus friends
  getInterest: () => [...lobby.map((m) => m.puuid), ...Object.keys(known), ...settings.party, ...(session?.myTeam || []).map((c) => c.puuid)],
  getAuth: () => settings.auth || null,
  setAuth: (a) => { settings.auth = a; saveSettings(); broadcast(); },
  getSecret: () => {
    if (!settings.cloudSecret) { settings.cloudSecret = require('crypto').randomBytes(32).toString('hex'); saveSettings(); }
    return settings.cloudSecret;
  },
});

let peerVersion = 0; // counts friend data updates (drives Party Snapshot refreshes)
const party = () => settings.party.map((id) => known[id]).filter(Boolean);
const shortName = (n) => (n || '').split('#')[0];

// ---------- champ select ----------
const splitName = (n) => { const [name, tag] = (n || '').split('#'); return { name, tag: tag ? `#${tag}` : '' }; };

function champSelectState() {
  if (!session || !me) return { active: false };
  const team = session.myTeam || [];
  const actions = (session.actions || []).flat();
  const isLocked = (cellId, champ) => champ > 0 && !actions.some((a) => a.actorCellId === cellId && a.type === 'pick' && !a.completed);
  const skinFor = (champ, selected) => {
    const s = game.skins[selected] || game.skins[champ * 1000];
    return s ? { id: s.id, name: s.name, card: s.card, tile: s.tile, lines: s.lines } : null;
  };
  const cellFor = (f) => team.find((p) => (p.puuid && p.puuid === f.puuid) || (p.summonerId && p.summonerId === f.summonerId));
  const myCell = team.find((p) => p.cellId === session.localPlayerCellId);
  if (!myCell) return { active: false };

  // Everyone from my lobby on my team. Non-ff members only "own" what they have equipped.
  const members = (csLobby || lobby).map((m) => known[m.puuid] || { puuid: m.puuid, name: m.name, iconId: m.iconId, skinIds: null });
  const slots = displaySlots(members.map((m) => m.puuid));
  const people = [{ f: me, cell: myCell, slot: 'me', owned: new Set(me.skinIds) },
    ...members.map((f) => {
      const cell = cellFor(f);
      return cell && { f, cell, slot: slots[f.puuid], owned: new Set(f.skinIds || [cell.selectedSkinId]) };
    }).filter(Boolean)]
    .sort((a, b) => team.indexOf(a.cell) - team.indexOf(b.cell));

  const cards = people.map(({ f, cell, slot }) => {
    const champ = cell.championId || cell.championPickIntent || 0;
    return {
      id: f.puuid, slot, isMe: f === me, ...splitName(f.name), icon: profileIcon(f.iconId), ...regaliaView(f.regalia),
      champ: game.champions[champ] || null, locked: isLocked(cell.cellId, champ),
      skin: champ ? skinFor(champ, cell.selectedSkinId) : null,
    };
  });

  // Groups: 2+ people whose equipped skins share a skinline. Biggest group first.
  const groups = [];
  let remaining = cards.filter((c) => c.skin?.lines.length);
  for (;;) {
    const count = new Map();
    for (const c of remaining) for (const l of c.skin.lines) count.set(l, (count.get(l) || 0) + 1);
    const best = [...count.entries()].filter(([, n]) => n >= 2).sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))[0];
    if (!best) break;
    const ids = remaining.filter((c) => c.skin.lines.includes(best[0])).map((c) => c.id);
    groups.push({ lineId: best[0], lineName: game.skinlines[best[0]] || `Skinline ${best[0]}`, ids });
    remaining = remaining.filter((c) => !ids.includes(c.id));
  }

  const mates = people.filter((p) => p.f !== me).map(({ f, cell, owned }) => ({
    id: f.puuid, name: shortName(f.name), owned,
    champ: cell.championId || cell.championPickIntent || 0, selected: cell.selectedSkinId,
  }));
  const myChamp = myCell.championId || myCell.championPickIntent || 0;
  const mine = new Set(me.skinIds);
  const allMatches = game.groupMatches({ myChamp, mine, mySelected: myCell.selectedSkinId, others: mates });
  // Nothing to switch to if everyone in that line is already wearing it
  const matches = allMatches.filter((m) => !(m.iAmWearing && m.members.every((x) => x.wearing)));

  const bench = (session.benchChampions || []).map((b) => b.championId ?? b).filter(Boolean);
  const benchOptions = bench.map((id) => {
    const m = game.groupMatches({ myChamp: id, mine, others: mates });
    return { champ: game.champions[id], count: m.length, most: m[0]?.size || 0 };
  }).filter((b) => b.champ && b.count > 0).sort((a, b) => (b.most - a.most) || (b.count - a.count));

  return {
    active: true,
    myId: me.puuid,
    myChamp: game.champions[myChamp] || null,
    mySelected: myCell.selectedSkinId,
    cards, groups, matches, allMatches, benchOptions, autoApplied: lastAutoInfo,
    // The whole team for the snapshot's "Current match" card (only what champ select shows)
    team: team.map((cell) => {
      const person = people.find((x) => x.cell === cell);
      const champ = cell.championId || cell.championPickIntent;
      const s = champ ? skinFor(champ, cell.selectedSkinId) : null;
      return {
        champ: game.champions[champ] || null, locked: isLocked(cell.cellId, cell.championId), skin: s?.name || null,
        spells: [game.spells[cell.spell1Id] || null, game.spells[cell.spell2Id] || null],
        name: person ? splitName(person.f.name).name : cell.gameName || null,
        isMe: cell.cellId === session.localPlayerCellId, isParty: Boolean(person), slot: person?.slot || null,
        role: ROLE[String(cell.assignedPosition || '').toUpperCase()] || null,
      };
    }),
    theirCount: (session.theirTeam || []).length,
    mates: mates.map(({ id, name, champ, selected }) => ({ id, name, champ, selected })),
  };
}

function getState() {
  return {
    lcu: {
      connected: lcu.connected, name: me?.name || null, skinCount: me?.skinIds.length || 0,
      icon: profileIcon(me?.iconId), puuid: me?.puuid,
    },
    me: me && { mastery: summary?.mastery?.slice(0, 3) || [], ...splitName(me.name), icon: profileIcon(me.iconId), skinCount: me.skinIds.length, ...regaliaView(me.regalia) },
    party: party().map((f) => friendView(f)),
    lobby: (() => {
      const slots = displaySlots(lobby.map((m) => m.puuid));
      return lobby.map((m) => (known[m.puuid]
        ? { ...friendView(known[m.puuid]), slot: slots[m.puuid], onSkinMatch: true }
        : { puuid: m.puuid, name: m.name, ...splitName(m.name), icon: profileIcon(m.iconId), slot: slots[m.puuid], onSkinMatch: false, ...regaliaView(null) }));
    })(),
    available: Object.values(known).filter((f) => !settings.party.includes(f.puuid) && peer.isOnline(f.puuid)).map(friendView),
    maxFriends: MAX_FRIENDS,
    champSelect: champSelectState(),
    // secrets stay in the main process: the window only needs to know they exist
    settings: { ...settings, riotKey: settings.riotKey ? 'saved' : '', auth: undefined, cloudSecret: undefined, idMap: undefined },
    importStatus,
    history: { games: matchStore ? matchStore.values().length : 0 },
    queue: lobbyQueue && { ...lobbyQueue, phase, search },
    blank: regaliaView(null), // the default banner, for empty lobby spots
    // bumps whenever a game is saved or a friend's data changes, so the Party Snapshot refreshes
    statsVersion: `${details ? Object.keys(details.data).length : 0}:${peerVersion}`,
    update: updateInfo, updateStatus, version: app.getVersion(),
    cloud: peer.status === 'connected' ? 'Connected' : peer.status === 'starting' ? 'Connecting...' : `Not connected: ${peer.status}`,
    account: settings.auth ? { email: settings.auth.email, link: me ? settings.auth.links?.[me.puuid] || 'linking' : null } : null,
    ggez: lcu.connected ? ggez() : false,
    // signed out: a shuffled handful of emotes for the sign-in screen
    gateEmotes: settings.auth ? null : gateEmotes(),
    live: (() => { try { return liveView(live.data); } catch (e) { console.error('live view', e.message); return null; } })(),
    watch: settings.watch.map((w) => ({ puuid: w.puuid, ...splitName(players?.data[w.puuid]?.name || w.name), icon: profileIcon(players?.data[w.puuid]?.iconId) })),
    refreshing: [...refreshing],
  };
}

function friendView(f) {
  return {
    puuid: f.puuid,
    name: f.name,
    ...splitName(f.name),
    slot: settings.colors[f.puuid] || null,
    icon: profileIcon(f.iconId),
    skinCount: f.skinIds.length,
    updatedAt: f.updatedAt,
    online: peer.isOnline(f.puuid),
    inLobby: lobby.some((m) => m.puuid === f.puuid),
    mastery: f.stats?.mastery?.slice(0, 3) || [],
    ...regaliaView(f.regalia),
  };
}

function broadcast() {
  const state = getState();
  for (const w of [mainWin, overlayWin]) if (w && !w.isDestroyed()) w.webContents.send('state', state);
  updateOverlay(state);
}

// ---------- LCU ----------
async function refreshMe() {
  if (!lcu.connected) return;
  try {
    if (!game.loaded) await game.load((f) => lcu.request('GET', `/lol-game-data/assets/v1/${f}`));
    const s = await lcu.request('GET', '/lol-summoner/v1/current-summoner');
    me = {
      version: 2,
      puuid: s.puuid,
      summonerId: s.summonerId,
      name: s.gameName ? `${s.gameName}#${s.tagLine}` : s.displayName,
      iconId: s.profileIconId,
      ...(await fetchInventory(lcu, s.summonerId)),
      updatedAt: Date.now(),
    };
    try { mastery = byMastery(await lcu.request('GET', '/lol-champion-mastery/v1/local-player/champion-mastery') || []); } catch { /* keep old */ }
    await readRegalia();
    me.masteryMap = Object.fromEntries(mastery.map((m) => [m.championId, [m.championLevel, m.championPoints]]));
    try { settings.region = (await lcu.request('GET', '/riotclient/region-locale')).region || settings.region; saveSettings(); } catch { /* keep */ }
    try {
      const ranked = await lcu.request('GET', '/lol-ranked/v1/current-ranked-stats');
      const prev = players.data[me.puuid] || {};
      players.set(me.puuid, { ...prev, level: s.summonerLevel, iconId: s.profileIconId,
        ranks: (ranked?.queues || []).filter((q) => q.tier && q.tier !== 'NONE').map((q) => ({ queue: q.queueType, tier: q.tier, division: q.division, lp: q.leaguePoints, wins: q.wins, losses: q.losses })) });
      recordRank(me.puuid, players.data[me.puuid].ranks);
      players.save();
    } catch { /* ranks optional */ }
    await syncClientHistory(100);
    peer.syncAll();
    broadcast();
  } catch (e) {
    console.error('refreshMe failed', e.message);
  }
}

const nameCache = {}; // puuid -> { name, iconId }, looked up from the League client
// What the lobby is set up for, and where you are in the queue
let lobbyQueue = null;   // { queueId, name, mode }
let phase = 'None';      // League's gameflow phase: Lobby, Matchmaking, ReadyCheck, ChampSelect, InProgress...
let search = null;       // { since, estimate } while searching
const queueNameCache = {};
async function queueName(id, gameMode) {
  if (queueNameCache[id]) return queueNameCache[id];
  try {
    const q = await lcu.request('GET', `/lol-game-queues/v1/queues/${id}`);
    const name = q?.name || q?.shortName || q?.description;
    if (name) return (queueNameCache[id] = name);
  } catch { /* fall back below */ }
  return queueNames[id] || gameMode || 'Custom game';
}
// The client's lobby header: [mode icon] MAP · QUEUE · PICK TYPE (like "RNG · ARAM: MAYHEM · RANDOM")
let mapsCache = null;
async function mapInfo(mapId, gameMode) {
  if (!mapsCache) { try { mapsCache = await lcu.request('GET', '/lol-maps/v2/maps'); } catch { mapsCache = []; } }
  const list = (mapsCache || []).filter((m) => m.id === mapId);
  const hasIcon = (m) => m.assets?.['game-select-icon-default'] && !/rgm-empty/.test(m.assets['game-select-icon-default']);
  const m = list.find((x) => x.gameMode === gameMode && hasIcon(x)) || list.find((x) => x.gameMode === gameMode) || list.find(hasIcon) || list[0];
  if (!m) return {};
  const src = hasIcon(m) ? m : list.find(hasIcon);
  // the lit-up version, like the client's lobby header
  const icon = src ? src.assets['game-select-icon-active'] || src.assets['game-select-icon-default'] : null;
  return { short: /random/i.test(m.name || '') ? 'RNG' : m.mapStringId || null, mapName: m.name, icon: icon ? assetUrl('/' + icon.replace(/^\//, '')) : null };
}
const PICKS = { AllRandomPickStrategy: 'Random', DraftModeSinglePickStrategy: 'Draft', SimulPickStrategy: 'Blind', TournamentPickStrategy: 'Tournament Draft', BlindDraftStrategy: 'Blind Draft' };
function pickLabel(cfg, mode) {
  if (/SWIFTPLAY/i.test(cfg.gameMode || '')) return null;
  if (PICKS[cfg.pickType]) return PICKS[cfg.pickType];
  if (mode === 'aram' || mode === 'mayhem') return 'Random';
  return null;
}
async function setLobbyQueue(data) {
  const cfg = data?.gameConfig;
  if (!cfg) { lobbyQueue = null; return; }
  const mode = modeOf({ queueId: cfg.queueId, gameMode: cfg.gameMode });
  lobbyQueue = { queueId: cfg.queueId, mode, custom: Boolean(cfg.isCustom),
    name: cfg.isCustom ? 'Custom game' : await queueName(cfg.queueId, cfg.gameMode),
    pick: pickLabel(cfg, mode), ...(await mapInfo(cfg.mapId, cfg.gameMode)) };
  broadcast();
}
function setSearch(data) {
  search = data && data.searchState === 'Searching'
    ? { since: Date.now() - (data.timeInQueue || 0) * 1000, estimate: data.estimatedQueueTime || null }
    : null;
}
function setLobby(data) {
  lobby = (data?.members || []).filter((m) => m.puuid && m.puuid !== me?.puuid).map((m) => ({
    puuid: m.puuid,
    name: nameCache[m.puuid]?.name || (m.gameName ? `${m.gameName}#${m.gameTag || m.tagLine || ''}` : m.summonerName || 'Player'),
    iconId: nameCache[m.puuid]?.iconId ?? m.summonerIconId,
  }));
  addLobbyFriends();
  resolveLobbyNames();
}

// Lobby data doesn't always include Riot IDs, so ask the client for each member
async function resolveLobbyNames() {
  let changed = false;
  for (const m of lobby) {
    if (nameCache[m.puuid]) continue;
    try {
      const s = await lcu.request('GET', `/lol-summoner/v2/summoners/puuid/${m.puuid}`);
      if (!s) continue;
      nameCache[m.puuid] = { name: s.gameName ? `${s.gameName}#${s.tagLine}` : s.displayName || m.name, iconId: s.profileIconId };
      m.name = nameCache[m.puuid].name; m.iconId = nameCache[m.puuid].iconId;
      changed = true;
    } catch { /* keep what we have */ }
  }
  if (changed) broadcast();
}

// Anyone running ff who's in my lobby becomes a friend automatically
function addLobbyFriends() {
  let changed = false;
  for (const m of lobby) {
    if (known[m.puuid] && !settings.party.includes(m.puuid) && settings.party.length < MAX_FRIENDS) {
      settings.party.push(m.puuid);
      assignSlot(m.puuid);
      changed = true;
    }
  }
  if (changed) saveSettings();
}

async function refreshLobby() {
  let data = null;
  try { data = await lcu.request('GET', '/lol-lobby/v2/lobby'); } catch { /* not in a lobby */ }
  setLobby(data); setLobbyQueue(data);
  try { phase = await lcu.request('GET', '/lol-gameflow/v1/gameflow-phase') || 'None'; } catch { phase = 'None'; }
  live.setActive(IN_GAME.includes(phase));
  try { setSearch(await lcu.request('GET', '/lol-matchmaking/v1/search')); } catch { search = null; }
}

// Color for someone on screen: their saved slot, or a free one for this lobby
function displaySlots(puuids) {
  const slots = {};
  const used = new Set();
  for (const id of puuids) if (settings.colors[id]) { slots[id] = settings.colors[id]; used.add(settings.colors[id]); }
  for (const id of puuids) if (!slots[id]) { const free = [1, 2, 3, 4].find((n) => !used.has(n)) || 1; slots[id] = free; used.add(free); }
  return slots;
}

// Your lobby look (banner, crest, title) from your chat presence, which is what the lobby itself reads
async function readRegalia() {
  if (!me) return;
  try { applyPresence((await lcu.request('GET', '/lol-chat/v1/me'))?.lol); } catch { /* keep old */ }
}
function applyPresence(lol) {
  if (!lol || !me) return;
  let crest = null;
  try { const r = JSON.parse(lol.regalia || '{}'); if (r.crestType === 1 || r.crestType === 'prestige') crest = r.selectedPrestigeCrest || null; } catch { /* no crest */ }
  const next = { bannerId: Number(lol.bannerIdSelected) || null, crest, titleId: lol.playerTitleSelected || null,
    crystal: lol.challengeCrystalLevel && lol.challengeCrystalLevel !== 'NONE' ? String(lol.challengeCrystalLevel).toLowerCase() : null };
  if (JSON.stringify(next) !== JSON.stringify(me.regalia)) { me.regalia = next; broadcast(); }
}
const bannerArt = (r) => game.banners[r?.bannerId] || game.banners[1] || null;

// Where each banner's bottom decoration starts (palms, gold trim...), so the champ icons can sit just above it.
// Measured once per banner from the art: the first row below 40% that reaches outside the cloth.
const ornamentTop = {};
function measureOrnament(url) {
  if (!url || url in ornamentTop) return;
  ornamentTop[url] = null;
  require('https').get(url, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      try {
        const img = nativeImage.createFromBuffer(Buffer.concat(chunks));
        const { width: w, height: h } = img.getSize();
        const px = img.toBitmap(); // BGRA
        const alpha = (x, y) => px[(y * w + x) * 4 + 3];
        const L = Math.floor(w * 0.14), R = Math.floor(w * 0.86);
        let top = 0.8;
        outer: for (let y = Math.floor(h * 0.4); y < h; y++) {
          for (let x = 0; x < L; x += 2) if (alpha(x, y) > 120) { top = y / h; break outer; }
          for (let x = R; x < w; x += 2) if (alpha(x, y) > 120) { top = y / h; break outer; }
        }
        ornamentTop[url] = top;
        broadcast();
      } catch { ornamentTop[url] = 0.8; }
    });
  }).on('error', () => { ornamentTop[url] = 0.8; });
}
const regaliaView = (r) => {
  const banner = bannerArt(r);
  measureOrnament(banner);
  // the Challenges crystal gem that sits over the bottom of the border (Diamond, Platinum...)
  const gem = r?.crystal ? `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/challenges-shared/crystal_${r.crystal}.png` : null;
  return { banner, crest: crestUrl(r?.crest), orn: ornamentTop[banner] || 0.8, title: game.titles[r?.titleId] || null, gem };
};

// ---------- stats ----------
function recomputeSummary() {
  if (!matchStore || !me) return;
  const mine = matchStore.values().filter((m) => m.owner === me.puuid);
  summary = buildSummary(mine, game.champions, mastery);
  // [gameId, start, duration, champ, win, [[matePuuid, champ], ...]] with mates limited to ff users
  sharedHistory = mine.filter((m) => m.duration >= 300).map((m) => [m.gameId, m.start, m.duration, m.champ, m.win ? 1 : 0,
    m.mates.filter((x) => known[x.puuid]).map((x) => [x.puuid, x.champ])]);
  myForm = recentForm(me.puuid);
}

// Post-game recap: the latest game you played with someone from this party, for 6 hours after it ends
function recap(ids, who) {
  const g = details.values().filter((d) => d.duration >= 300 && Date.now() - (d.start + d.duration * 1000) < 6 * 3600e3
    && d.players.some((x) => x.puuid === me.puuid) && d.players.filter((x) => ids.includes(x.puuid)).length >= 2)
    .sort((a, b) => b.start - a.start)[0];
  if (!g) return null;
  const mine = g.players.find((x) => x.puuid === me.puuid);
  const rows = g.players.filter((x) => ids.includes(x.puuid)).map((x) => {
    const sc = gameScore(g, x.puuid);
    return { ...who(x.puuid), puuid: x.puuid, champ: game.champions[x.champ] || { id: x.champ, name: `Champion ${x.champ}` },
      k: x.k, d: x.d, a: x.a, cs: x.cs, dmg: x.dmg, taken: x.taken, heal: x.heal, placement: x.placement, augments: (x.augments || []).map(augIcon), score: sc, grade: gradeOf(sc), win: x.win,
      sameTeam: modeOf(g) === 'arena' ? x.sub === mine.sub : x.team === mine.team };
  }).sort((a, b) => b.score - a.score);
  // Rank all 10 by score so "MVP" means best in the whole game
  const ranked = g.players.map((x) => ({ puuid: x.puuid, s: gameScore(g, x.puuid) })).sort((a, b) => b.s - a.s);
  // Full scoreboard, grouped like the client's end-of-game screen (duos in Arena)
  const arena = modeOf(g) === 'arena';
  const groups = new Map();
  for (const x of g.players) {
    const k = arena ? `s${x.sub}` : `t${x.team}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const partyBest = rows[0]?.puuid;
  const teams = [...groups.values()].map((list) => {
    const players = list.map((x) => {
      const person = ids.includes(x.puuid) ? who(x.puuid) : null;
      const sc = gameScore(g, x.puuid);
      return {
        name: x.name || game.champions[x.champ]?.name || 'Player', champ: game.champions[x.champ] || { id: x.champ, name: `Champion ${x.champ}` },
        level: x.level, spells: (x.spells || []).map((id) => game.spells[id] || null), augments: (x.augments || []).map(augIcon),
        items: (x.items || []).map(itemIcon), k: x.k, d: x.d, a: x.a, gold: x.gold || 0, grade: gradeOf(sc),
        isMe: x.puuid === me.puuid, isParty: Boolean(person), slot: person?.slot || null, mvp: x.puuid === partyBest,
      };
    });
    const sum = (f) => list.reduce((t, x) => t + (x[f] || 0), 0);
    return { mine: list.some((x) => x.puuid === me.puuid), win: list[0].win, placement: arena ? list[0].placement || null : null,
      k: sum('k'), d: sum('d'), a: sum('a'), gold: sum('gold'), players };
  }).sort((a, b) => (b.mine - a.mine) || ((a.placement || 9) - (b.placement || 9)));
  const MAPS = { 11: "Summoner's Rift", 12: 'Howling Abyss', 14: "Butcher's Bridge", 21: 'Nexus Blitz', 30: 'Rings of Wrath' };
  const mapName = MAPS[g.mapId] || { aram: 'Howling Abyss', mayhem: 'Howling Abyss', arena: 'Rings of Wrath', rift: "Summoner's Rift" }[modeOf(g)] || null;
  return { gameId: g.gameId, queueId: g.queueId, queueName: queueNames[g.queueId] || null, mode: modeOf(g), mapName, start: g.start, win: mine.win, duration: g.duration, end: g.start + g.duration * 1000,
    size: g.players.length, placement: mine.placement || null, teams,
    players: rows.map((r) => ({ ...r, place: ranked.findIndex((x) => x.puuid === r.puuid) + 1 })) };
}

// ---------- op.gg-style numbers ----------
const SR = [400, 420, 430, 440, 490, 480];
const ROLE = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', MID: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };
const MODE_ORDER = ['aram', 'mayhem', 'arena', 'rift'];

// Queue names from Riot's public list, so new modes (like ARAM: Mayhem) sort themselves out
let queueNames = { 450: '5v5 ARAM games', 100: 'ARAM', 720: 'ARAM Clash', 1700: 'Arena', 1710: 'Arena' };
function loadQueueNames() {
  require('https').get('https://static.developer.riotgames.com/docs/lol/queues.json', (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => { try { for (const q of JSON.parse(body)) if (q.description) queueNames[q.queueId] = q.description; } catch { /* keep defaults */ } });
  }).on('error', () => {});
}

function modeOf(d) {
  const name = (queueNames[d.queueId] || '').toLowerCase();
  const gm = (d.gameMode || '').toUpperCase();
  if (gm === 'CHERRY' || name.includes('arena')) return 'arena';
  if (gm === 'KIWI') return 'mayhem'; // ARAM: Mayhem's code name in game data
  if (gm === 'SWIFTPLAY') return 'rift';
  if (name.includes('mayhem')) return 'mayhem';
  if (gm === 'ARAM' || name.includes('aram')) return 'aram';
  if (SR.includes(d.queueId) || gm === 'CLASSIC') return 'rift';
  return 'other';
}

// Our own game score (0-10) against everyone else in the game, weighted for the mode
const WEIGHTS = {
  rift: { kda: 0.25, kp: 0.2, dmg: 0.25, cs: 0.15, vis: 0.15 },
  aram: { kda: 0.2, kp: 0.25, dmg: 0.3, tank: 0.15, heal: 0.1 },
  mayhem: { kda: 0.2, kp: 0.25, dmg: 0.3, tank: 0.15, heal: 0.1 },
  arena: { place: 0.6, dmg: 0.2, kda: 0.2 },
};
function gameScore(d, puuid) {
  const p = d.players.find((x) => x.puuid === puuid);
  if (!p) return null;
  const mode = modeOf(d);
  const w = WEIGHTS[mode] || WEIGHTS.rift;
  const min = Math.max(d.duration / 60, 1);
  const side = (x) => (mode === 'arena' ? `s${x.sub}` : `t${x.team}`);
  const sum = (x, f) => d.players.filter((y) => side(y) === side(x)).reduce((a, y) => a + (f(y) || 0), 0);
  const val = (x) => ({
    kda: (x.k + x.a) / Math.max(x.d, 1), kp: sum(x, (y) => y.k) ? (x.k + x.a) / sum(x, (y) => y.k) : 0,
    dmg: mode === 'arena' ? (x.dmg || 0) : sum(x, (y) => y.dmg) ? (x.dmg || 0) / sum(x, (y) => y.dmg) : 0,
    tank: sum(x, (y) => y.taken) ? (x.taken || 0) / sum(x, (y) => y.taken) : 0,
    heal: sum(x, (y) => y.heal) ? (x.heal || 0) / sum(x, (y) => y.heal) : 0,
    cs: (x.cs || 0) / min, vis: (x.vision || 0) / min,
  });
  const all = d.players.map(val), mine = val(p);
  let score = 0;
  for (const [k, wt] of Object.entries(w)) {
    if (k === 'place') { score += wt * (p.placement ? (9 - p.placement) / 8 : 0.5); continue; }
    score += wt * (mine[k] / Math.max(...all.map((v) => v[k]), 0.0001));
  }
  const won = mode === 'arena' ? p.placement === 1 : p.win;
  return Math.min(10, score * 9.5 + (won ? 0.5 : 0));
}
const gradeOf = (s2) => (s2 == null ? null : s2 >= 8.5 ? 'S+' : s2 >= 7.5 ? 'S' : s2 >= 6.5 ? 'A' : s2 >= 5.5 ? 'B' : s2 >= 4 ? 'C' : 'D');

// Rank as one number so LP change works across tiers
const TIER_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIV = { IV: 0, III: 1, II: 2, I: 3 };
const rankValue = (r) => (r ? Math.min(TIER_ORDER.indexOf(r.tier), 7) * 400 + (TIER_ORDER.indexOf(r.tier) >= 7 ? 0 : (DIV[r.division] || 0) * 100) + r.lp : null);

function recordRank(puuid, ranks) {
  const solo = (ranks || []).find((r) => r.queue === 'RANKED_SOLO_5x5');
  if (!solo) return;
  const p = players.data[puuid] || {};
  const hist = p.rankHistory || [];
  const v = rankValue(solo);
  if (!hist.length || hist[hist.length - 1].v !== v) hist.push({ t: Date.now(), v });
  players.set(puuid, { ...p, rankHistory: hist.slice(-500) });
}

// One mode's numbers for a player
function statsFor(games, puuid, mode) {
  const last = games.slice(0, 50);
  const t = { w: 0, k: 0, d: 0, a: 0, kp: 0, cs: 0, dmg: 0, vis: 0, taken: 0, heal: 0, min: 0, score: 0, pentas: 0, quadras: 0, place: 0, first: 0, top4: 0 };
  for (const g of last) {
    const x = g.players.find((y) => y.puuid === puuid);
    const mates = g.players.filter((y) => (mode === 'arena' ? y.sub === x.sub : y.team === x.team));
    const teamKills = mates.reduce((s2, y) => s2 + (y.k || 0), 0);
    t.w += x.win ? 1 : 0; t.k += x.k; t.d += x.d; t.a += x.a; t.kp += teamKills ? (x.k + x.a) / teamKills : 0;
    t.cs += x.cs || 0; t.dmg += x.dmg || 0; t.vis += x.vision || 0; t.taken += x.taken || 0; t.heal += x.heal || 0;
    t.min += g.duration / 60; t.score += gameScore(g, puuid); t.pentas += x.pentas || 0; t.quadras += x.quadras || 0;
    if (x.placement) { t.place += x.placement; t.first += x.placement === 1 ? 1 : 0; t.top4 += x.placement <= 4 ? 1 : 0; }
  }
  const n = last.length;
  const out = {
    games: n, lastPlayed: games[0].start, winRate: t.w / n, kda: (t.k + t.a) / Math.max(t.d, 1), kp: t.kp / n,
    csm: t.cs / t.min, dpm: t.dmg / t.min, vpm: t.vis / t.min, tpm: t.taken / t.min, hpm: t.heal / t.min,
    pentas: t.pentas, quadras: t.quadras, score: t.score / n, grade: gradeOf(t.score / n),
    avgPlace: t.place ? t.place / n : null, firstRate: t.first / n, top4Rate: t.top4 / n,
  };

  // champion pool (last 100 games of this mode)
  const pool = new Map(), classes = {};
  for (const g of games.slice(0, 100)) {
    const x = g.players.find((y) => y.puuid === puuid);
    const won = mode === 'arena' ? x.placement && x.placement <= 4 : x.win;
    const e = pool.get(x.champ) || { champ: x.champ, games: 0, wins: 0, k: 0, d: 0, a: 0 };
    e.games++; e.wins += won ? 1 : 0; e.k += x.k; e.d += x.d; e.a += x.a;
    pool.set(x.champ, e);
    const cls = (game.champions[x.champ]?.roles || [])[0];
    if (cls) { classes[cls] = classes[cls] || { games: 0, wins: 0 }; classes[cls].games++; if (won) classes[cls].wins++; }
  }
  const augs = new Map();
  for (const g of games.slice(0, 100)) {
    const x = g.players.find((y) => y.puuid === puuid);
    const won = mode === 'arena' ? x.placement && x.placement <= 4 : x.win;
    for (const id of x.augments || []) { const e = augs.get(id) || { id, picks: 0, wins: 0 }; e.picks++; e.wins += won ? 1 : 0; augs.set(id, e); }
  }
  // Riot's policy doesn't allow augment win rates, so only pick counts are kept
  out.augments = [...augs.values()].sort((a, b) => b.picks - a.picks).slice(0, 6).map((e) => ({ id: e.id, picks: e.picks }));
  out.pool = [...pool.values()].sort((a, b) => b.games - a.games).slice(0, 5)
    .map((e) => ({ champ: e.champ, games: e.games, winRate: e.wins / e.games, kda: (e.k + e.a) / Math.max(e.d, 1) }));
  out.classes = classes;

  if (mode === 'rift') {
    const roles = {};
    for (const g of games.slice(0, 100)) {
      const x = g.players.find((y) => y.puuid === puuid);
      const r = ROLE[x.role];
      if (!r) continue;
      roles[r] = roles[r] || { games: 0, wins: 0 };
      roles[r].games++; if (x.win) roles[r].wins++;
    }
    out.roles = roles;
  }
  return out;
}

// Everything the Party Snapshot needs about one player, per mode, computed on their own PC and shared
function recentForm(puuid) {
  if (!details) return null;
  const games = details.values().filter((d) => d.duration >= 300 && d.players.some((x) => x.puuid === puuid)).sort((a, b) => b.start - a.start);
  const p = players?.data[puuid] || {};
  const solo = (p.ranks || []).find((r) => r.queue === 'RANKED_SOLO_5x5') || null;
  const hist = p.rankHistory || [];
  const weekAgo = [...hist].reverse().find((h) => h.t <= Date.now() - 7 * 864e5) || (hist[0] && hist[0].t <= Date.now() - 864e5 ? hist[0] : null);
  const rank = solo && { tier: solo.tier, division: solo.division, lp: solo.lp, wins: solo.wins, losses: solo.losses, value: rankValue(solo),
    weekDelta: weekAgo ? rankValue(solo) - weekAgo.v : null };
  const modes = {};
  for (const m of MODE_ORDER) {
    const list = games.filter((d) => modeOf(d) === m);
    if (list.length) modes[m] = statsFor(list, puuid, m);
  }
  return { rank, modes };
}

async function syncClientHistory(count) {
  try {
    // The client hands out history in pages of 20
    const games = [];
    for (let beg = 0; beg < count; beg += 20) {
      const page = await lcu.request('GET', `/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=${beg}&endIndex=${Math.min(beg + 20, count)}`);
      const got = page?.games?.games || [];
      games.push(...got);
      if (got.length < Math.min(20, count - beg)) break;
    }
    for (const g of games) {
      // Also backfill scoreboards for games saved by older versions (they only kept the basics)
      if (matchStore.has(g.gameId) && details.has(g.gameId)) continue;
      const full = await lcu.request('GET', `/lol-match-history/v1/games/${g.gameId}`);
      const m = full && fromLcu(full, me.puuid);
      if (m) matchStore.set(m.gameId, { ...m, owner: me.puuid });
      if (full) details.set(full.gameId, detailFromLcu(full));
    }
    matchStore.save();
    details.save();
  } catch (e) {
    console.error('history sync failed', e.message);
  }
  recomputeSummary();
}

async function logSkinMatch() {
  if (!lastCS?.mates?.length) return;
  try {
    const flow = await lcu.request('GET', '/lol-gameflow/v1/session');
    const gameId = flow?.gameData?.gameId;
    if (!gameId) return;
    const mine = game.skins[lastCS.mySelected]?.lines || [];
    const withMap = {};
    for (const mate of lastCS.mates) {
      const theirs = new Set(game.skins[mate.selected]?.lines || []);
      const line = mine.find((l) => theirs.has(l));
      withMap[mate.id] = line ? game.skinlines[line] : null;
    }
    skinLog.set(gameId, { with: withMap });
    skinLog.save();
  } catch { /* not critical */ }
}

async function startImport(key) {
  if (importStatus?.running || !me) return;
  const region = settings.region || 'NA';
  stopImport = false;
  importStatus = { running: true, phase: 'Starting', done: 0, total: 0 };
  broadcast();
  const target = {
    has: (id) => matchStore.has(id),
    set: (id, m) => matchStore.set(id, { ...m, owner: me.puuid }),
    save: () => matchStore.save(),
  };
  try {
    riotApi();
    await backfill({
      key, region, puuid: me.puuid, riotId: me.name, people: knownPeople(), store: target, details,
      shouldStop: () => stopImport,
      onProgress: (p) => { importStatus = { running: true, ...p }; broadcast(); },
    });
    importStatus = { running: false, phase: stopImport ? 'Stopped' : 'Done', done: importStatus.done, total: importStatus.total };
  } catch (e) {
    importStatus = { running: false, error: e.message };
  }
  recomputeSummary();
  broadcast();
}

let gateEmoteList = null;
function gateEmotes() {
  if (!gateEmoteList && game.emotes?.length) {
    const all = [...game.emotes];
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    gateEmoteList = all.slice(0, 60);
  }
  return gateEmoteList || [];
}

// ---------- "gg ez": did we just win? ----------
let lastResult = null; // { win, at }
// Right when the game ends, from League's end-of-game screen
async function readGameResult() {
  try {
    const b = await lcu.request('GET', '/lol-end-of-game/v1/eog-stats-block');
    const mine = b?.localPlayer;
    if (!mine) return;
    let win = null;
    const team = (b.teams || []).find((t) => t.teamId === mine.teamId);
    if (team && typeof team.isWinningTeam === 'boolean') win = team.isWinningTeam;
    const place = mine.stats?.PLAYER_SUBTEAM_PLACEMENT || mine.stats?.SUBTEAM_PLACEMENT; // Arena
    if (place) win = place === 1; // Arena: only 1st place is a win
    if (win === null) return;
    lastResult = { win, at: Date.now() };
    broadcast();
  } catch { /* the history sync below still catches it */ }
}
// Fallback (and on startup): your most recent saved game, if it ended in the last hour
function recentResult() {
  if (lastResult && Date.now() - lastResult.at < 6 * 3600e3) return lastResult;
  if (!details || !me) return null;
  const g = details.values().filter((d) => d.players.some((x) => x.puuid === me.puuid)).sort((a, b) => b.start - a.start)[0];
  if (!g) return null;
  const end = g.start + g.duration * 1000;
  if (Date.now() - end > 3600e3) return null;
  const x = g.players.find((y) => y.puuid === me.puuid);
  return { win: modeOf(g) === 'arena' ? x.placement === 1 : Boolean(x.win), at: end };
}
// "gg ez" after a win, until the next game starts
function ggez() {
  if (['Matchmaking', 'ReadyCheck', 'ChampSelect', 'GameStart', 'InProgress', 'Reconnect'].includes(phase)) return false;
  return Boolean(recentResult()?.win);
}

// ---------- live game ----------
const DRAGON = { Fire: 'Infernal', Water: 'Ocean', Earth: 'Mountain', Air: 'Cloud', Hextech: 'Hextech', Chemtech: 'Chemtech', Elder: 'Elder' };
function liveView(d) {
  if (!d?.allPlayers?.length) return null;
  const champByName = Object.fromEntries(Object.values(game.champions).map((c) => [c.name.toLowerCase(), c]));
  const spellByName = Object.fromEntries(Object.values(game.spells).map((x) => [x.name?.toLowerCase(), x]));
  // Who's who: you, ff friends, and everyone else in your lobby
  const people = [me && { puuid: me.puuid, name: me.name }, ...Object.values(known), ...lobby].filter(Boolean);
  const slots = { ...displaySlots(lobby.map((m) => m.puuid)), [me?.puuid]: 'me' };
  const findPerson = (riotId, gameName) => people.find((x) => x.name && (x.name.toLowerCase() === riotId || x.name.split('#')[0].toLowerCase() === gameName));

  const players = d.allPlayers.map((p) => {
    const gameName = (p.riotIdGameName || p.summonerName || '').toLowerCase();
    const riotId = (p.riotId || `${p.riotIdGameName}#${p.riotIdTagLine}`).toLowerCase();
    const person = findPerson(riotId, gameName);
    const items = [...(p.items || [])].sort((a, b) => a.slot - b.slot);
    const bySlot = (n) => items.find((it) => it.slot === n)?.itemID;
    return {
      name: p.riotIdGameName || p.summonerName, tag: p.riotIdTagLine ? `#${p.riotIdTagLine}` : '',
      champ: champByName[(p.championName || '').toLowerCase()] || { name: p.championName, icon: null },
      level: p.level, dead: p.isDead, respawn: Math.ceil(p.respawnTimer || 0), team: p.team,
      role: ({ TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' })[String(p.position || '').toUpperCase()] || null,
      k: p.scores?.kills || 0, d: p.scores?.deaths || 0, a: p.scores?.assists || 0, cs: p.scores?.creepScore || 0, ward: Math.round(p.scores?.wardScore || 0),
      items: [0, 1, 2, 3, 4, 5, 6].map((n) => itemIcon(bySlot(n))),
      // names can carry extra text like "Flash <i>(on cooldown)</i>"
      spells: [p.summonerSpells?.summonerSpellOne?.displayName, p.summonerSpells?.summonerSpellTwo?.displayName].map((n) => spellByName[String(n || '').replace(/<[^>]*>/g, '').replace(/\(.*?\)/g, '').trim().toLowerCase()] || null),
      rune: game.runes[p.runes?.keystone?.id] || null,
      slot: person ? slots[person.puuid] || settings.colors[person.puuid] || null : null,
      isMe: Boolean(person && person.puuid === me?.puuid),
      isParty: Boolean(person),
      _names: [gameName, (p.summonerName || '').toLowerCase()],
    };
  });
  const teamOf = (name) => players.find((x) => x._names.includes(String(name || '').toLowerCase()))?.team;
  const champOf = (name) => players.find((x) => x._names.includes(String(name || '').toLowerCase()))?.champ?.name || name;
  const myTeam = players.find((x) => x.isMe)?.team || players[0].team;

  const teams = {};
  for (const p of players) {
    teams[p.team] ||= { id: p.team, side: p.team === 'ORDER' ? 'Blue side' : p.team === 'CHAOS' ? 'Red side' : 'Team', kills: 0, towers: 0, inhibs: 0, dragons: [], barons: 0, heralds: 0, players: [] };
    teams[p.team].kills += p.k;
    teams[p.team].players.push(p);
  }
  const feed = [];
  const other = (t) => Object.keys(teams).find((x) => x !== t);
  for (const e of d.events?.Events || []) {
    const t = teamOf(e.KillerName);
    const byTeam = (team) => (team && teams[team] ? teams[team] : null);
    switch (e.EventName) {
      case 'TurretKilled': case 'InhibKilled': {
        // Structures are named like Turret_T1_... (blue side's) or Barracks_T2_... (red side's)
        const name = e.TurretKilled || e.InhibKilled || '';
        const owner = name.includes('_T1_') ? 'ORDER' : name.includes('_T2_') ? 'CHAOS' : null;
        const team = owner ? other(owner) : t;
        const tm = byTeam(team);
        const what = e.EventName === 'TurretKilled' ? 'a tower' : 'an inhibitor';
        if (tm) e.EventName === 'TurretKilled' ? tm.towers++ : tm.inhibs++;
        feed.push({ t: e.EventTime, team, text: `${teamOf(e.KillerName) ? champOf(e.KillerName) : `${team === 'ORDER' ? 'Blue' : 'Red'} side`} destroyed ${what}` });
        break;
      }
      case 'DragonKill': { const tm = byTeam(t); const kind = DRAGON[e.DragonType] || e.DragonType; if (tm) tm.dragons.push(kind); feed.push({ t: e.EventTime, team: t, big: true, text: `${champOf(e.KillerName)} took the ${kind} Drake${e.Stolen === 'True' ? ' (stolen!)' : ''}` }); break; }
      case 'BaronKill': { const tm = byTeam(t); if (tm) tm.barons++; feed.push({ t: e.EventTime, team: t, big: true, text: `${champOf(e.KillerName)} took Baron Nashor${e.Stolen === 'True' ? ' (stolen!)' : ''}` }); break; }
      case 'HeraldKill': { const tm = byTeam(t); if (tm) tm.heralds++; feed.push({ t: e.EventTime, team: t, text: `${champOf(e.KillerName)} took the Rift Herald` }); break; }
      case 'ChampionKill': feed.push({ t: e.EventTime, team: t, text: `${champOf(e.KillerName)} killed ${champOf(e.VictimName)}` }); break;
      case 'Multikill': feed.push({ t: e.EventTime, team: t, big: true, text: `${champOf(e.KillerName)} got a ${({ 2: 'double', 3: 'triple', 4: 'quadra', 5: 'penta' })[e.KillStreak] || 'multi'} kill!` }); break;
      case 'FirstBlood': feed.push({ t: e.EventTime, team: teamOf(e.Recipient), big: true, text: `First blood for ${champOf(e.Recipient)}` }); break;
      case 'Ace': feed.push({ t: e.EventTime, team: e.AcingTeam, big: true, text: `${e.AcingTeam === 'ORDER' ? 'Blue' : 'Red'} side aced the enemy team` }); break;
      case 'GameEnd': feed.push({ t: e.EventTime, team: null, big: true, text: e.Result === 'Win' ? 'Victory!' : 'Defeat' }); break;
      default: break;
    }
  }
  const kind = ({ CLASSIC: 'rift', ARAM: 'aram', KIWI: 'mayhem', CHERRY: 'arena' })[String(d.gameData?.gameMode || '').toUpperCase()] || 'other';
  let list = Object.values(teams).sort((a, b) => (b.id === myTeam) - (a.id === myTeam));
  if (kind === 'arena') list = arenaTeams(players, d.events?.Events || [], champByName);
  for (const p of players) delete p._names;
  return {
    mode: d.gameData?.gameMode, time: d.gameData?.gameTime || 0, receivedAt: d.receivedAt, myTeam: kind === 'arena' ? 'MINE' : myTeam,
    // which kind of match this is, straight from the game (drives the columns and the header)
    kind,
    mapName: ({ 11: "Summoner's Rift", 12: 'Howling Abyss', 14: "Butcher's Bridge", 30: 'Rings of Wrath' })[d.gameData?.mapNumber] || null,
    teams: list, feed: feed.slice(-14).reverse().map((f) => ({ ...f, mine: f.team === myTeam })),
  };
}

// Arena: the live data only says ORDER/CHAOS, not who's in which duo or trio. Work it out:
// your own team from champ select, everyone else from the kill feed (teammates assist each
// other's kills and never kill each other), capped at the team size (3 in 3x6, 2 otherwise).
function arenaTeams(players, events, champByName) {
  const size = players.length >= 18 ? 3 : 2;
  const idx = new Map();
  players.forEach((p, i) => p._names.forEach((n) => n && idx.set(n, i)));
  const find = (names) => { for (const n of [].concat(names)) { const i = idx.get(String(n || '').toLowerCase()); if (i != null) return i; } return null; };
  const parent = players.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const sizeOf = (r) => players.filter((_, i) => root(i) === r).length;
  const enemies = new Set(); // "a|b" pairs that killed each other: never teammates
  const join = (a, b) => {
    const ra = root(a), rb = root(b);
    if (ra === rb || sizeOf(ra) + sizeOf(rb) > size) return;
    for (let i = 0; i < players.length; i++) for (let j = 0; j < players.length; j++) {
      if (root(i) === ra && root(j) === rb && enemies.has(`${i}|${j}`)) return;
    }
    parent[rb] = ra;
  };
  const kills = events.filter((e) => e.EventName === 'ChampionKill');
  for (const e of kills) {
    const k = find(e.KillerName), v = find(e.VictimName);
    if (k != null && v != null) { enemies.add(`${k}|${v}`); enemies.add(`${v}|${k}`); }
  }
  // your team first, from champ select (by name, or champion if names are hidden)
  const me = players.findIndex((p) => p.isMe);
  if (me >= 0 && arenaTeam?.length) {
    for (const t of arenaTeam) {
      let i = t.name ? find(t.name) : null;
      if (i == null && t.champ) i = players.findIndex((p, j) => j !== me && p.champ?.id === t.champ && root(j) === j);
      if (i != null && i >= 0 && i !== me) join(me, i);
    }
  }
  // then everyone else: count how often each pair appears together on a kill
  const together = new Map();
  for (const e of kills) {
    const grp = [find(e.KillerName), ...(e.Assisters || []).map((a) => find(a))].filter((x) => x != null);
    for (let a = 0; a < grp.length; a++) for (let b = a + 1; b < grp.length; b++) {
      const key = grp[a] < grp[b] ? `${grp[a]}|${grp[b]}` : `${grp[b]}|${grp[a]}`;
      together.set(key, (together.get(key) || 0) + 1);
    }
  }
  [...together.entries()].sort((x, y) => y[1] - x[1]).forEach(([key]) => { const [a, b] = key.split('|').map(Number); join(a, b); });
  // leftovers: group players still short a teammate if they've never fought each other (a best guess)
  const guessed = new Set();
  for (let pass = 0; pass < players.length; pass++) {
    const roots = [...new Set(players.map((_, i) => root(i)))].filter((r) => sizeOf(r) < size);
    let merged = false;
    for (let x = 0; x < roots.length && !merged; x++) for (let y = x + 1; y < roots.length && !merged; y++) {
      const before = root(roots[y]);
      join(roots[x], roots[y]);
      if (root(before) === root(roots[x])) { guessed.add(root(roots[x])); merged = true; }
    }
    if (!merged) break;
  }
  // build the teams: yours first, then by kills
  const groups = new Map();
  players.forEach((p, i) => { const r = root(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
  const teamsOut = [...groups.values()].map((ps) => ({
    id: ps.some((p) => p.isMe) ? 'MINE' : `T${ps[0].name}`, side: '', players: ps,
    kills: ps.reduce((a, p) => a + p.k, 0), towers: 0, inhibs: 0, dragons: [], barons: 0, heralds: 0,
    guessed: ps.length < size || guessed.has(root(players.indexOf(ps[0]))), // not confirmed by the kill feed yet
  }));
  teamsOut.sort((a, b) => (b.id === 'MINE') - (a.id === 'MINE') || b.kills - a.kills);
  return teamsOut;
}

// ---------- profiles (Riot API + client) ----------
const RANK_Q = { RANKED_SOLO_5x5: 'Ranked Solo/Duo', RANKED_FLEX_SR: 'Ranked Flex' };

function profileList() {
  const list = [{ puuid: me?.puuid, name: me?.name, iconId: me?.iconId, slot: 'me' }];
  for (const f of party()) list.push({ puuid: f.puuid, name: f.name, iconId: f.iconId, slot: settings.colors[f.puuid], app: true });
  for (const w of settings.watch) if (!list.some((x) => x.puuid === w.puuid)) list.push({ puuid: w.puuid, name: w.name, slot: null });
  return list.filter((x) => x.puuid).map((x) => {
    const p = players.data[x.puuid] || {};
    const solo = (p.ranks || []).find((r) => r.queue === 'RANKED_SOLO_5x5');
    return { puuid: x.puuid, ...splitName(p.name || x.name), icon: profileIcon(p.iconId ?? x.iconId), slot: x.slot, app: Boolean(x.app || x.slot === 'me'),
      solo: solo && { tier: solo.tier, division: solo.division, lp: solo.lp }, watch: settings.watch.some((w) => w.puuid === x.puuid) };
  });
}

// Riot API client with remembered ID translations (per key, so a new key relearns them)
function riotApi() {
  const api = getApi(settings.riotKey, settings.region || 'NA');
  if (!api.onLearn) {
    const fp = settings.riotKey.slice(-8);
    settings.idMap = settings.idMap?.fp === fp ? settings.idMap : { fp, map: {} };
    for (const [l, a] of Object.entries(settings.idMap.map)) { api.toApi.set(l, a); api.toLocal.set(a, l); }
    api.onLearn = (l, a) => { settings.idMap.map[l] = a; saveSettings(); };
  }
  return api;
}
const riotIdOf = (puuid) => (puuid === me?.puuid ? me.name : players.data[puuid]?.name || known[puuid]?.name || settings.watch.find((w) => w.puuid === puuid)?.name || null);
const knownPeople = () => [...Object.values(known), ...settings.watch].filter((p) => p?.puuid && p.name && p.puuid !== me?.puuid);

async function refreshPlayer(puuid) {
  if (!settings.riotKey || refreshing.has(puuid)) return;
  refreshing.add(puuid);
  broadcast();
  const api = riotApi();
  const prev = players.data[puuid] || {};
  try {
    // this key's ID for the player (and for everyone we know, so their games line up)
    const apiId = await api.id(puuid, riotIdOf(puuid));
    for (const p of knownPeople()) await api.id(p.puuid, p.name);
    const [acct, summ, ranks, top] = await Promise.all([api.accountByPuuid(apiId), api.summoner(apiId), api.ranks(apiId), api.topMastery(apiId, 20)]);
    const ids = (await api.matchIds(apiId, 0, 20)) || [];
    for (const id of ids) {
      const gameId = Number(id.split('_')[1]);
      if (details.has(gameId)) continue;
      const m = await api.match(id);
      if (!m) continue;
      details.set(gameId, detailFromApi(m));
      if (puuid === me?.puuid && !matchStore.has(gameId)) { const mm = fromApi(m, puuid); if (mm) matchStore.set(gameId, { ...mm, owner: puuid }); }
    }
    players.set(puuid, {
      ...prev,
      name: acct ? `${acct.gameName}#${acct.tagLine}` : prev.name,
      iconId: summ?.profileIconId ?? prev.iconId, level: summ?.summonerLevel ?? prev.level,
      ranks: (ranks || []).map((r) => ({ queue: r.queueType, tier: r.tier, division: r.rank, lp: r.leaguePoints, wins: r.wins, losses: r.losses })),
      mastery: byMastery(top || []).slice(0, 5).map((m) => ({ champ: m.championId, level: m.championLevel, points: m.championPoints })),
      updatedAt: Date.now(), error: null,
    });
    recordRank(puuid, players.data[puuid].ranks);
    details.save(); matchStore.save();
    if (puuid === me?.puuid) recomputeSummary();
  } catch (e) {
    players.set(puuid, { ...prev, error: e.message });
  }
  players.save();
  refreshing.delete(puuid);
  broadcast();
}

const augIcon = (id) => game.augments[id] || { id, name: `Augment ${id}`, icon: null, rarity: 'silver' };
const itemIcon = (id) => (id ? { id, name: game.items[id]?.name || '', icon: game.items[id]?.icon || null } : null);

function matchRow(d, puuid) {
  const p = d.players.find((x) => x.puuid === puuid);
  if (!p) return null;
  const teamKills = d.players.filter((x) => x.team === p.team).reduce((a, x) => a + (x.k || 0), 0);
  return {
    gameId: d.gameId, queueId: d.queueId, start: d.start, duration: d.duration, win: p.win, remake: d.duration < 300,
    champ: game.champions[p.champ] || { id: p.champ, name: `Champion ${p.champ}` }, level: p.level,
    k: p.k, d: p.d, a: p.a, cs: p.cs, kp: teamKills ? (p.k + p.a) / teamKills : 0, role: p.role,
    items: p.items.map(itemIcon), spells: p.spells.map((id) => game.spells[id] || null),
    rune: game.runes[p.rune] || null, subStyle: game.runes[p.subStyle] || null,
    augments: (p.augments || []).map(augIcon), placement: p.placement || null, mode: modeOf(d),
    team: d.players.filter((x) => x.team === p.team).map((x) => ({ champ: game.champions[x.champ], name: x.name, puuid: x.puuid })),
    enemy: d.players.filter((x) => x.team !== p.team).map((x) => ({ champ: game.champions[x.champ], name: x.name, puuid: x.puuid })),
  };
}

ipcMain.handle('profiles', () => profileList());
ipcMain.handle('friends', () => profileList().filter((x) => x.slot !== 'me').map((x) => {
  const p = players.data[x.puuid] || {};
  const last = details.values().filter((d) => d.players.some((y) => y.puuid === x.puuid)).sort((a, b) => b.start - a.start)[0];
  return { ...x, level: p.level, online: peer.isOnline(x.puuid), inLobby: lobby.some((m) => m.puuid === x.puuid),
    lastGame: last ? { start: last.start, mode: modeOf(last) } : null };
}));
ipcMain.handle('profile', (_e, puuid, limit = 20) => {
  const p = players.data[puuid] || {};
  let entry = profileList().find((x) => x.puuid === puuid);
  if (!entry) {
    // Someone found by search: not a friend (yet)
    const solo = (p.ranks || []).find((r) => r.queue === 'RANKED_SOLO_5x5');
    entry = { puuid, ...splitName(p.name || ''), icon: profileIcon(p.iconId), slot: null, app: Boolean(known[puuid]), solo };
  }
  entry.relation = puuid === me?.puuid ? 'me' : settings.party.includes(puuid) ? 'friend' : settings.watch.some((w) => w.puuid === puuid) ? 'friend' : 'none';
  const cachedMastery = puuid === me?.puuid ? mastery.slice(0, 5).map((m) => ({ champ: m.championId, level: m.championLevel, points: m.championPoints }))
    : (known[puuid]?.stats?.mastery || []).slice(0, 5).map((m) => ({ champ: m.champ.id, level: m.level, points: m.points }));
  const rows = details.values().filter((d) => d.players.some((x) => x.puuid === puuid)).sort((a, b) => b.start - a.start);
  return {
    ...entry, level: p.level, updatedAt: p.updatedAt, error: p.error, refreshing: refreshing.has(puuid), hasKey: Boolean(settings.riotKey),
    ranks: (p.ranks || []).map((r) => ({ ...r, label: RANK_Q[r.queue] || r.queue })).filter((r) => RANK_Q[r.queue]),
    mastery: (p.mastery?.length ? p.mastery : cachedMastery).map((m) => ({ ...m, champ: game.champions[m.champ] || { id: m.champ, name: `Champion ${m.champ}` } })),
    total: rows.length,
    matches: rows.slice(0, limit).map((d) => matchRow(d, puuid)).filter(Boolean),
  };
});
ipcMain.handle('matchDetail', (_e, gameId, puuid) => {
  const d = details.data[gameId];
  if (!d) return null;
  const maxDmg = Math.max(...d.players.map((x) => x.dmg || 0), 1);
  const slots = displaySlots(d.players.map((x) => x.puuid).filter((id) => id && id !== me?.puuid && (known[id] || settings.watch.some((w) => w.puuid === id))));
  return {
    ...d,
    teams: d.teams.map((t) => ({ ...t, players: d.players.filter((x) => x.team === t.id).map((x) => ({
      ...x, champ: game.champions[x.champ] || { id: x.champ, name: `Champion ${x.champ}` },
      items: x.items.map(itemIcon), spells: x.spells.map((id) => game.spells[id] || null),
      rune: game.runes[x.rune] || null, subStyle: game.runes[x.subStyle] || null,
      dmgShare: (x.dmg || 0) / maxDmg, isFocus: x.puuid === puuid, augments: (x.augments || []).map(augIcon),
      slot: x.puuid === me?.puuid ? 'me' : slots[x.puuid] || null,
    })) })),
  };
});
ipcMain.handle('refreshProfile', (_e, puuid) => refreshPlayer(puuid));
ipcMain.handle('addRiotId', async (_e, riotId) => {
  const [name, tag] = String(riotId).split('#').map((x) => x?.trim());
  if (!name || !tag) return { ok: false, error: 'Use the full Riot ID, like Momo#NA1.' };
  if (!settings.riotKey) return { ok: false, error: 'Add a Riot API key first. It\'s how ff looks up players.' };
  try {
    const acct = await getApi(settings.riotKey, settings.region || 'NA').accountByRiotId(name, tag);
    if (!acct) return { ok: false, error: `Couldn't find ${name}#${tag}. Check the spelling and tag.` };
    if (acct.puuid === me?.puuid || settings.watch.some((w) => w.puuid === acct.puuid)) return { ok: true, name: `${acct.gameName}#${acct.tagLine}`, already: true };
    settings.watch.push({ puuid: acct.puuid, name: `${acct.gameName}#${acct.tagLine}` });
    saveSettings();
    refreshPlayer(acct.puuid);
    return { ok: true, name: `${acct.gameName}#${acct.tagLine}`, puuid: acct.puuid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('lookupRiotId', async (_e, riotId) => {
  const [name, tag] = String(riotId).split('#').map((x) => x?.trim());
  if (!name || !tag) return { ok: false, error: 'Use the full Riot ID, like Momo#NA1.' };
  if (!settings.riotKey) return { ok: false, error: 'Add a Riot API key in Settings to search for players.' };
  try {
    const acct = await getApi(settings.riotKey, settings.region || 'NA').accountByRiotId(name, tag);
    if (!acct) return { ok: false, error: `Couldn't find ${name}#${tag}. Check the spelling and tag.` };
    const full = `${acct.gameName}#${acct.tagLine}`;
    players.set(acct.puuid, { ...(players.data[acct.puuid] || {}), name: full });
    refreshPlayer(acct.puuid);
    return { ok: true, puuid: acct.puuid, name: full };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('addFriendPuuid', (_e, puuid) => {
  if (puuid === me?.puuid || settings.watch.some((w) => w.puuid === puuid) || settings.party.includes(puuid)) return;
  settings.watch.push({ puuid, name: players.data[puuid]?.name || known[puuid]?.name || 'Player' });
  saveSettings();
  broadcast();
});
ipcMain.handle('removeWatch', (_e, puuid) => {
  settings.watch = settings.watch.filter((w) => w.puuid !== puuid);
  saveSettings();
  broadcast();
});
ipcMain.handle('saveKey', (_e, key) => { if (key) { settings.riotKey = key.trim(); saveSettings(); broadcast(); } });

// ---------- LCU events ----------
lcu.on('connected', async () => {
  if (!leagueWasOpen && settings.openWithLeague) showMain();
  leagueWasOpen = true;
  await refreshMe();
  await refreshLobby();
  try { session = await lcu.request('GET', '/lol-champ-select/v1/session'); csLobby = [...lobby]; } catch { session = null; }
  onSessionChange();
});
lcu.on('disconnected', () => {
  leagueWasOpen = false; session = null; lobby = []; lobbyQueue = null; phase = 'None'; search = null; live.setActive(false); broadcast(); });

lcu.on('event', (evt) => {
  if (evt.uri === '/lol-champ-select/v1/session') {
    session = evt.eventType === 'Delete' ? null : evt.data;
    if (session && !csLobby) csLobby = [...lobby];
    if (!session) { lastAutoKey = null; overlayDismissed = false; csLobby = null; }
    onSessionChange();
  } else if (evt.uri === '/lol-chat/v1/me') {
    applyPresence(evt.data?.lol);
  } else if (evt.uri === '/lol-lobby/v2/lobby') {
    // League closes the lobby when the game loads; keep showing it until you're back in one
    const inMatch = ['ChampSelect', 'GameStart', 'InProgress', 'Reconnect', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame'].includes(phase);
    if (!(evt.eventType === 'Delete' && inMatch)) setLobby(evt.eventType === 'Delete' ? null : evt.data);
    // The lobby goes away once a game loads; keep showing its mode until you're back
    if (evt.eventType !== 'Delete') setLobbyQueue(evt.data);
    else if (!['ChampSelect', 'GameStart', 'InProgress', 'Reconnect', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame'].includes(phase)) lobbyQueue = null;
    broadcast();
  } else if (evt.uri === '/lol-matchmaking/v1/search') {
    setSearch(evt.eventType === 'Delete' ? null : evt.data);
    broadcast();
  } else if (evt.uri === '/lol-gameflow/v1/gameflow-phase') {
    phase = evt.data || 'None';
    if (phase === 'EndOfGame' || phase === 'PreEndOfGame') setTimeout(readGameResult, 1500);
    if (phase !== 'Matchmaking') search = null;
    live.setActive(IN_GAME.includes(phase));
    broadcast();
    if (evt.data === 'ChampSelect') peer.syncAll(); // grab everyone's latest skins
    if (evt.data === 'InProgress') logSkinMatch();
    if (evt.data === 'EndOfGame') setTimeout(() => syncClientHistory(5).then(broadcast), 15_000);
    if (evt.data === 'Lobby') refreshMe(); // may have bought skins
  }
});

let arenaTeam = null; // your Arena teammates, remembered from champ select: [{ name, champ }]
function onSessionChange() {
  if (session?.myTeam?.length) arenaTeam = session.myTeam.map((c) => ({ name: String(c.gameName || '').toLowerCase(), champ: c.championId || c.championPickIntent || 0 }));
  const cs = champSelectState();
  if (cs.active && cs.mates.length) lastCS = cs;
  broadcast();
  if (session && settings.autoApply) autoApply(cs);
  else if (session) notifyMatch(cs);
}

// If ff is minimized or behind League, a Windows notification points out a skin match
let lastNotifyKey = null;
function notifyMatch(cs) {
  const best = cs.allMatches?.[0];
  if (!best || best.iAmWearing || !best.mySkins?.length) return;
  const key = `${cs.myChamp?.id}:${best.lineId}`;
  if (key === lastNotifyKey) return;
  lastNotifyKey = key;
  if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && mainWin.isFocused()) return; // the in-app pop-up covers it
  if (!Notification.isSupported()) return;
  const names = best.members.map((m) => m.name).join(', ');
  const n = new Notification({ title: `Match ${best.lineName}`, body: `You can match ${best.lineName} with ${names}. Click to open ff.`,
    icon: path.join(__dirname, '../build/icon.png'), silent: false });
  n.on('click', showMain);
  n.show();
}

async function autoApply(cs) {
  const best = cs.allMatches?.[0];
  if (!best || best.iAmWearing) return;
  const key = `${cs.myChamp?.id}:${cs.mates.map((m) => m.champ?.id).join(',')}:${best.lineId}`;
  if (key === lastAutoKey) return; // already applied once, don't fight manual changes
  lastAutoKey = key;
  const prev = cs.mySelected;
  if (await applySkin(best.mySkins[0].id)) {
    // remembered for the pop-up's "Undo"
    lastAutoInfo = { at: Date.now(), skinId: best.mySkins[0].id, skinName: best.mySkins[0].name, tile: best.mySkins[0].tile,
      prevSkinId: prev, lineName: best.lineName, with: best.members.map((m) => m.name) };
    broadcast();
  }
}
let lastAutoInfo = null;

async function applySkin(skinId) {
  try {
    await lcu.request('PATCH', '/lol-champ-select/v1/session/my-selection', { selectedSkinId: skinId });
    return true;
  } catch (e) {
    console.error('applySkin failed', e.message);
    return false;
  }
}

// ---------- friends ----------
peer.on('inventory', (inv) => {
  peerVersion++;
  const isNew = !known[inv.puuid];
  known[inv.puuid] = inv;
  if (isNew) recomputeSummary(); // shared history only lists ff users we know about
  addLobbyFriends();
  writeJson('known.json', known);
  broadcast();
});
peer.on('offline', broadcast);

// ---------- windows ----------
function showMain() {
  if (quitting) return; // shutting down (quit or update restart): don't touch the window
  if (!mainWin || mainWin.isDestroyed()) createMain(); // window was closed: open a fresh one
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

// Start with Windows (hidden in the tray) so ff can pop up when League opens
function applyLoginItem() {
  if (!app.isPackaged) return; // only for the installed app
  app.setLoginItemSettings({ openAtLogin: Boolean(settings.startWithWindows), args: ['--hidden'] });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '../build/tray.png')));
  tray.setToolTip('ff');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open ff', click: showMain },
    { type: 'separator' },
    { label: 'Quit ff', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMain);
}

function createMain() {
  mainWin = new BrowserWindow({
    show: !startedHidden,
    icon: path.join(__dirname, '../build/icon.png'),
    width: 1060, height: 760, minWidth: 760, minHeight: 560,
    backgroundColor: '#1f2024',
    title: 'ff',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  mainWin.loadFile(path.join(__dirname, '../renderer/index.html'));
  // Closing hides to the tray; Quit from the tray menu actually exits
  mainWin.on('close', (e) => { if (!quitting) { e.preventDefault(); mainWin.hide(); } });
}

function updateOverlay(state) {
  const want = settings.overlay && state.champSelect.active && !overlayDismissed;
  if (want && !overlayWin) {
    const { workArea } = screen.getPrimaryDisplay();
    overlayWin = new BrowserWindow({
      width: 340, height: 460,
      x: workArea.x + workArea.width - 360, y: workArea.y + 80,
      frame: false, transparent: true, resizable: true, alwaysOnTop: true, skipTaskbar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.loadFile(path.join(__dirname, '../renderer/overlay.html'));
    overlayWin.webContents.on('did-finish-load', () => overlayWin?.webContents.send('state', getState()));
    overlayWin.on('closed', () => { overlayWin = null; });
  } else if (!want && overlayWin) {
    overlayWin.close();
  }
}

// ---------- IPC ----------
const saveSettings = () => writeJson('settings.json', settings);
// Each friend keeps the same color slot (1-4) for as long as they're in the party
function assignSlot(puuid) {
  if (settings.colors[puuid]) return;
  const used = Object.values(settings.colors);
  settings.colors[puuid] = [1, 2, 3, 4].find((n) => !used.includes(n)) || 1;
}
const people = () => [{ id: me?.puuid, name: 'You', skinIds: me?.skinIds || [] },
  ...party().map((f) => ({ id: f.puuid, name: shortName(f.name), skinIds: f.skinIds }))];

ipcMain.handle('getState', () => getState());
ipcMain.handle('applySkin', (_e, id) => applySkin(id));
ipcMain.handle('refresh', async () => { await refreshMe(); await peer.syncAll(); return getState(); });
ipcMain.handle('setSettings', (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings();
  if (patch.autoApply) { lastAutoKey = null; if (session) autoApply(champSelectState()); }
  if ('startWithWindows' in patch) applyLoginItem();
  broadcast();
});

ipcMain.handle('addFriend', (_e, puuid) => {
  if (!known[puuid] || settings.party.includes(puuid) || settings.party.length >= MAX_FRIENDS) return;
  settings.party.push(puuid);
  assignSlot(puuid);
  saveSettings();
  broadcast();
});
ipcMain.handle('removeFriend', (_e, puuid) => {
  settings.party = settings.party.filter((p) => p !== puuid);
  delete settings.colors[puuid];
  saveSettings();
  broadcast();
});
ipcMain.handle('addAddress', async (_e, address) => {
  const inv = await peer.add(address);
  if (!inv) return { ok: false, error: `Couldn't reach ff at ${address}. Check the address and that the app is open on that PC.` };
  if (!settings.manualPeers.includes(address)) settings.manualPeers.push(address);
  known[inv.puuid] = inv;
  const added = !settings.party.includes(inv.puuid) && settings.party.length < MAX_FRIENDS;
  if (added) { settings.party.push(inv.puuid); assignSlot(inv.puuid); }
  saveSettings();
  broadcast();
  return { ok: true, name: inv.name, added };
});

// ---------- collection ----------
const champDetails = {};
ipcMain.handle('collection', () => {
  if (!game.loaded) return null;
  const ppl = [me && { ...me, name: 'You' }, ...party()].filter(Boolean).map((p) => ({
    id: p.puuid, name: shortName(p.name), icon: profileIcon(p.iconId), slot: p === party().find((f) => f.puuid === p.puuid) ? settings.colors[p.puuid] : 'me',
    skins: new Set(p.skinIds || []), champs: new Set(p.champIds || []), chromas: new Set(p.chromaIds || []),
    mastery: p.masteryMap || {}, partial: !p.champIds, // friend on an older ff version
  }));
  const owners = (test) => ppl.map((p, i) => (test(p) ? i : -1)).filter((i) => i >= 0);
  const champions = Object.values(game.champions).map((c) => ({
    ...c,
    owners: owners((p) => p.champs.has(c.id)),
    mastery: ppl.map((p) => p.mastery[c.id] || null),
  }));
  const skins = Object.values(game.skins).filter((s) => game.champions[champOf(s.id)]).map((s) => ({
    id: s.id, champId: champOf(s.id), name: s.name, isBase: s.isBase, rarity: s.rarity, legacy: s.legacy,
    lines: s.lines.map((l) => game.skinlines[l]).filter(Boolean),
    tile: s.tile, card: s.card, splash: s.splash,
    owners: s.isBase ? owners((p) => p.champs.has(champOf(s.id))) : owners((p) => p.skins.has(s.id)),
    chromas: s.chromas.map((ch) => ({ ...ch, owners: owners((p) => p.chromas.has(ch.id)) })),
  }));
  return { people: ppl.map(({ id, name, icon, partial, slot }) => ({ id, name, icon, partial, slot })), champions, skins };
});
ipcMain.handle('championDetail', async (_e, id) => {
  if (champDetails[id]) return champDetails[id];
  try {
    const c = await lcu.request('GET', `/lol-game-data/assets/v1/champions/${id}.json`);
    champDetails[id] = {
      title: c.title, bio: c.shortBio, roles: c.roles || [],
      spells: [c.passive, ...(c.spells || [])].filter(Boolean).map((sp, i) => ({
        key: i === 0 ? 'Passive' : sp.spellKey?.toUpperCase(), name: sp.name, icon: assetUrl(sp.abilityIconPath),
      })),
    };
    return champDetails[id];
  } catch { return null; }
});

ipcMain.handle('champions', () => Object.values(game.champions).sort((a, b) => a.name.localeCompare(b.name)));
ipcMain.handle('explore', (_e, myChamp, friendPuuid, theirChamp) => {
  const f = known[friendPuuid];
  if (!f) return [];
  return game.groupMatches({
    myChamp, mine: new Set(me?.skinIds || []),
    others: [{ id: f.puuid, name: shortName(f.name), champ: theirChamp, owned: new Set(f.skinIds) }],
  });
});
ipcMain.handle('sharedLines', () => {
  const ppl = people();
  return {
    people: ppl.map((p, i) => ({ name: p.name, full: i ? known[p.id]?.name : me?.name, slot: i ? settings.colors[p.id] : 'me' })),
    lines: ppl.length > 1 ? game.sharedLines(ppl) : [],
  };
});

// A skin tile to represent a skinline, preferring one somebody in the party owns
function lineTile(lineId) {
  const owned = new Set(people().flatMap((p) => p.skinIds));
  const all = Object.values(game.skins).filter((s) => s.lines.includes(lineId));
  return (all.find((s) => owned.has(s.id)) || all[0])?.tile || null;
}

// Party Snapshot: computed from everyone's combined data so every screen shows the same numbers
ipcMain.handle('partySummary', (_e, puuids) => {
  if (!me || !game.loaded) return null;
  const members = [me, ...(puuids || []).map((id) => known[id]).filter(Boolean)];
  if (members.length < 2) return null;
  const ids = members.map((m) => m.puuid);
  const slots = { ...displaySlots(ids.slice(1)), [me.puuid]: 'me' };
  const who = (id) => { const m = members.find((x) => x.puuid === id); return { puuid: id, ...splitName(m.name), icon: profileIcon(m.iconId), slot: slots[id] }; };

  // --- skins
  const perLine = new Map(); // line -> counts per member
  members.forEach((m, i) => {
    for (const id of m.skinIds || []) for (const l of game.skins[id]?.lines || []) {
      if (!perLine.has(l)) perLine.set(l, Array(members.length).fill(0));
      perLine.get(l)[i]++;
    }
  });
  const shared = [...perLine.entries()].filter(([, c]) => c.filter(Boolean).length >= 2);
  const everyone = shared.filter(([, c]) => c.every(Boolean)).length;
  const topOwned = shared.sort((a, b) => b[1].reduce((x, y) => x + y) - a[1].reduce((x, y) => x + y))[0];

  // --- games: merge everyone's history so gaps in one person's import get filled by the others
  const games = new Map(); // gameId -> { secs, players: Map(puuid -> { champ, win }) }
  const addHistory = (owner, rows) => {
    for (const [gameId, , secs, champ, win, mates] of rows || []) {
      if (!games.has(gameId)) games.set(gameId, { secs, players: new Map() });
      const g = games.get(gameId);
      g.players.set(owner, { champ, win });
      for (const [p, c] of mates) if (ids.includes(p) && !g.players.has(p)) g.players.set(p, { champ: c, win });
    }
  };
  addHistory(me.puuid, sharedHistory);
  for (const f of members.slice(1)) addHistory(f.puuid, f.history);

  const tally = (list) => ({ games: list.length, hours: list.reduce((a, g) => a + g.secs, 0) / 3600, winRate: list.length ? list.filter((g) => g.win).length / list.length : 0 });
  const all = [...games.values()].filter((g) => ids.every((id) => g.players.has(id))).map((g) => ({ secs: g.secs, win: g.players.get(me.puuid).win }));

  // Pairs in name order so every screen labels them the same way
  const byName = [...ids].sort((x, y) => who(x).name.localeCompare(who(y).name));
  const duos = [];
  for (let i = 0; i < byName.length; i++) for (let j = i + 1; j < byName.length; j++) {
    const [p, q] = [byName[i], byName[j]];
    const list = [...games.values()].filter((g) => g.players.has(p) && g.players.has(q))
      .map((g) => ({ secs: g.secs, win: g.players.get(p).win, a: g.players.get(p).champ, b: g.players.get(q).champ }));
    if (list.length) duos.push({ a: p, b: q, list, ...tally(list) });
  }
  const mostPlayed = [...duos].sort((x, y) => y.games - x.games)[0];
  const best = duos.filter((d) => d.games >= 10).sort((x, y) => y.winRate - x.winRate)[0];

  const combos = new Map();
  for (const d of duos) for (const g of d.list) {
    const key = `${d.a}:${g.a}|${d.b}:${g.b}`;
    if (!combos.has(key)) combos.set(key, { a: d.a, b: d.b, ca: g.a, cb: g.b, list: [] });
    combos.get(key).list.push(g);
  }
  const combo = [...combos.values()].map((c) => ({ ...c, ...tally(c.list) })).sort((x, y) => y.games - x.games)[0];

  // --- skin matches: merge everyone's logs, count each game once per skinline
  const matchedGames = new Map(); // gameId -> Set(line)
  const addLog = (owner, log) => {
    for (const [gameId, e] of Object.entries(log || {})) {
      if (!e.with) continue;
      for (const [p, line] of Object.entries(e.with)) {
        if (!line || !ids.includes(p) || !ids.includes(owner)) continue;
        if (!matchedGames.has(gameId)) matchedGames.set(gameId, new Set());
        matchedGames.get(gameId).add(line);
      }
    }
  };
  addLog(me.puuid, skinLog.data);
  for (const f of members.slice(1)) addLog(f.puuid, f.skinLog);
  const lineCounts = new Map();
  for (const set of matchedGames.values()) for (const l of set) lineCounts.set(l, (lineCounts.get(l) || 0) + 1);
  const topMatched = [...lineCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const lineIdByName = (n) => Number(Object.keys(game.skinlines).find((id) => game.skinlines[id] === n));

  // Chart data, in the same people order everywhere
  const order = [...ids].sort((x, y) => who(x).name.localeCompare(who(y).name));
  const idx = order.map((id) => ids.indexOf(id));
  const snap = {
    people: order.map(who),
    skinlines: [...perLine.entries()].filter(([, c]) => c.filter(Boolean).length >= 2)
      .sort((a, b) => b[1].reduce((x, y) => x + y) - a[1].reduce((x, y) => x + y)).slice(0, 8)
      .map(([l, c]) => ({ name: game.skinlines[l] || `Skinline ${l}`, counts: idx.map((i) => c[i]) })),
    duos: duos.sort((x, y) => y.games - x.games).slice(0, 10).map((d) => ({ a: who(d.a), b: who(d.b), games: d.games, winRate: d.winRate })),
    form: order.map((id) => {
      let f = id === me.puuid ? myForm : known[id]?.form;
      if (!f) return null;
      if (!f.modes) f = { rank: f.rank, modes: f.games ? { rift: f } : {} }; // friend on an older version
      const modes = {};
      for (const [m, x] of Object.entries(f.modes)) {
        modes[m] = { ...x, pool: (x.pool || []).map((c) => ({ ...c, champ: game.champions[c.champ] || { id: c.champ, name: `Champion ${c.champ}` } })),
          augments: (x.augments || []).map((a) => ({ ...a, ...augIcon(a.id) })) };
      }
      return { rank: f.rank, modes };
    }),
    recap: recap(ids, who),
  };
  // Default to whatever mode the party played most recently
  const latest = {};
  for (const f of snap.form) for (const [m, x] of Object.entries(f?.modes || {})) latest[m] = Math.max(latest[m] || 0, x.lastPlayed || 0);
  snap.modes = MODE_ORDER.filter((m) => latest[m]);
  snap.defaultMode = snap.recap?.mode || [...snap.modes].sort((a, b) => latest[b] - latest[a])[0] || 'aram';
  return snap;
});
ipcMain.handle('stats', (_e, who, mode, friendPuuid) => {
  if (who === 'friend') {
    const st = known[friendPuuid]?.stats;
    return st ? { ...st.modes[mode], mastery: st.mastery } : null;
  }
  if (who === 'duo') {
    const f = known[friendPuuid];
    if (!f || !me) return null;
    return duoSummary(matchStore.values().filter((m) => m.owner === me.puuid), f.puuid, game.champions, skinLog.data, mode);
  }
  if (!summary) recomputeSummary();
  return summary ? { ...summary.modes[mode], mastery: summary.mastery } : null;
});
ipcMain.handle('startImport', (_e, key) => {
  if (key) { settings.riotKey = key; saveSettings(); }
  if (settings.riotKey) startImport(settings.riotKey);
});
ipcMain.handle('stopImport', () => { stopImport = true; });
ipcMain.handle('hideOverlay', () => { overlayDismissed = true; overlayWin?.close(); });
ipcMain.handle('myIp', () => {
  for (const list of Object.values(os.networkInterfaces())) for (const n of list) if (n.family === 'IPv4' && !n.internal) return n.address;
  return null;
});

app.whenReady().then(() => {
  settings = { autoApply: false, overlay: true, manualPeers: [], party: [], colors: {}, watch: [], region: null,
    startWithWindows: true, openWithLeague: true, ...readJson('settings.json', {}) };
  known = readJson('known.json', {});

  // migrate from the two-person version
  const oldPartner = readJson('partner.json', null);
  if (oldPartner?.puuid && !known[oldPartner.puuid]) {
    known[oldPartner.puuid] = oldPartner;
    if (!settings.party.includes(oldPartner.puuid)) settings.party.push(oldPartner.puuid);
  }
  if (settings.manualPeer) { settings.manualPeers.push(settings.manualPeer); delete settings.manualPeer; }
  settings.party.forEach(assignSlot);
  saveSettings();

  matchStore = new JsonStore(store('matches.json'));
  skinLog = new JsonStore(store('skinlog.json'));
  details = new JsonStore(store('details.json'));
  loadQueueNames();
  players = new JsonStore(store('players.json'));
  // Game data even without the client open, so profiles work anytime
  game.load(cdragonGet).then(broadcast).catch(() => {});
  peer.start();
  createMain();
  createTray();
  applyLoginItem();
  setupUpdates();
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault()); // keep running in the tray
