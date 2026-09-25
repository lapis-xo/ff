// Skin/champion data from the client, plus the matching logic.
const CDRAGON = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/';

function assetUrl(path) {
  if (!path) return null;
  return CDRAGON + path.replace(/^\/lol-game-data\/assets\//, '').toLowerCase();
}

const champOf = (skinId) => Math.floor(skinId / 1000);

const RARITY = {
  kNoRarity: null, kRare: 'Rare', kEpic: 'Epic', kLegendary: 'Legendary', kUltimate: 'Ultimate',
  kMythic: 'Mythic', kTranscendent: 'Transcendent', kExalted: 'Exalted',
};

class GameData {
  constructor() {
    this.skins = {};      // skinId -> skin
    this.skinlines = {};  // lineId -> name
    this.champions = {};  // champId -> { id, name, icon }
    this.items = {}; this.runes = {}; this.spells = {}; this.augments = {}; this.banners = {}; this.titles = {};
    this.loaded = false;
  }

  // get(file) returns parsed JSON for a file like 'skins.json', from the client or CommunityDragon
  async load(get) {
    const [skins, lines, champs, items, perks, styles, spells, augs] = await Promise.all([
      get('skins.json'), get('skinlines.json'), get('champion-summary.json'),
      get('items.json').catch(() => []), get('perks.json').catch(() => []),
      get('perkstyles.json').catch(() => ({ styles: [] })), get('summoner-spells.json').catch(() => []),
      get('cherry-augments.json').catch(() => []), // Arena and ARAM: Mayhem augments
    ]);
    const regalia = await get('regalia.json').catch(() => []);
    // Player titles (the line under your name in the lobby, like "The Iron Revenant")
    const titles = await get('achievementtitles.json').catch(() => []);
    this.titles = Object.fromEntries((titles || []).filter((t) => t.contentId && t.titleName).map((t) => [t.contentId, t.titleName]));
    // Lobby banner skins (id -> art), the same list your client picks from in Customize Identity
    this.banners = Object.fromEntries((regalia || []).filter((r) => r.regaliaType === 'kBanner' && r.assetPath).map((r) => [Number(r.id), assetUrl(r.assetPath)]));
    const RARITY_AUG = { kSilver: 'silver', kGold: 'gold', kPrismatic: 'prismatic' };
    this.augments = Object.fromEntries((augs || []).map((a) => [a.id, { id: a.id, name: a.nameTRA, icon: assetUrl(a.augmentSmallIconPath), rarity: RARITY_AUG[a.rarity] || 'silver' }]));
    const icons = (list) => Object.fromEntries((list || []).map((x) => [x.id, { name: x.name, icon: assetUrl(x.iconPath) }]));
    this.items = icons(items);
    // Always show modern art: mode variants (League Classic "Jade" items, Arena/ARAM copies) have big IDs
    // like 773157; point them at the regular item with the same name (3157) when there is one.
    const baseByName = {};
    for (const it of items || []) if (it.id < 100000 && it.name && !/jade|classic/i.test(it.iconPath || '')) baseByName[it.name] = it.id;
    for (const it of items || []) {
      const classic = /jade|classic/i.test(it.iconPath || '');
      if ((it.id >= 100000 || classic) && baseByName[it.name] && baseByName[it.name] !== it.id) this.items[it.id] = this.items[baseByName[it.name]];
    }
    this.runes = { ...icons(perks), ...icons(styles?.styles) };
    this.spells = icons(spells);
    this.skins = {};
    for (const s of Object.values(skins)) {
      this.skins[s.id] = {
        id: s.id,
        name: s.name,
        isBase: s.isBase,
        lines: (s.skinLines || []).map((l) => l.id),
        tile: assetUrl(s.tilePath),
        card: assetUrl(s.loadScreenPath),
        splash: assetUrl(s.uncenteredSplashPath || s.splashPath),
        rarity: RARITY[s.rarity] ?? null,
        legacy: Boolean(s.isLegacy),
        chromas: (s.chromas || []).map((c) => ({ id: c.id, name: c.name, colors: c.colors || [] })),
      };
    }
    this.skinlines = {};
    for (const l of lines) if (l.id) this.skinlines[l.id] = l.name;
    this.champions = {};
    for (const c of champs) {
      if (c.id > 0) this.champions[c.id] = { id: c.id, name: c.name, icon: assetUrl(c.squarePortraitPath), roles: c.roles || [] };
    }
    this.loaded = true;
  }

  // skinline id -> [skin] for one champion, from a set of owned skin ids
  linesFor(champId, owned) {
    const map = new Map();
    for (const id of owned) {
      if (champOf(id) !== champId) continue;
      const skin = this.skins[id];
      if (!skin) continue;
      for (const line of skin.lines) {
        if (!map.has(line)) map.set(line, []);
        map.get(line).push(skin);
      }
    }
    return map;
  }

  // Skinlines I can match with teammates in. others: [{ id, name, champ, owned:Set, selected }]
  // Ranked by how many people can match, then how many already wear it, then line id.
  // Ordering is deterministic so everyone's app converges when auto-equip is on.
  groupMatches({ myChamp, mine, mySelected, others }) {
    if (!myChamp) return [];
    const a = this.linesFor(myChamp, mine);
    const myWear = new Set(this.skins[mySelected]?.lines || []);
    const theirLines = others.filter((o) => o.champ).map((o) => ({
      ...o, lines: this.linesFor(o.champ, o.owned), wear: new Set(this.skins[o.selected]?.lines || []),
    }));
    const out = [];
    for (const [line, mySkins] of a) {
      const members = theirLines.filter((o) => o.lines.has(line)).map((o) => ({
        id: o.id, name: o.name, skins: o.lines.get(line), wearing: o.wear.has(line), selected: o.selected,
      }));
      if (!members.length) continue;
      const iAmWearing = myWear.has(line);
      out.push({
        lineId: line,
        lineName: this.skinlines[line] || `Skinline ${line}`,
        mySkins, members, iAmWearing,
        size: members.length + 1,
        wearing: members.filter((m) => m.wearing).length + (iAmWearing ? 1 : 0),
      });
    }
    out.sort((x, y) => (y.size - x.size) || (y.wearing - x.wearing) || (x.lineId - y.lineId));
    return out;
  }

  // Skinlines I own a skin in that at least one friend also owns. people: [{ id, skinIds }], me first
  sharedLines(people) {
    const counts = people.map((p) => {
      const m = new Map();
      for (const id of p.skinIds) for (const l of this.skins[id]?.lines || []) m.set(l, (m.get(l) || 0) + 1);
      return m;
    });
    const [mine, ...rest] = counts;
    return [...mine.keys()].filter((l) => rest.some((c) => c.has(l)))
      .map((l) => ({ lineId: l, lineName: this.skinlines[l] || `Skinline ${l}`, counts: counts.map((c) => c.get(l) || 0) }))
      .sort((x, y) => (y.counts.filter(Boolean).length - x.counts.filter(Boolean).length) || (y.counts.reduce((a, b) => a + b) - x.counts.reduce((a, b) => a + b)));
  }
}

// Everything this account owns: champions, skins, chromas
async function fetchInventory(lcu, summonerId) {
  const champs = await lcu.request('GET', `/lol-champions/v1/inventories/${summonerId}/champions`);
  const skinIds = [], champIds = [], chromaIds = [];
  for (const c of champs || []) {
    if (c.ownership?.owned) champIds.push(c.id);
    for (const s of c.skins || []) {
      if (!s.isBase && s.ownership?.owned) skinIds.push(s.id);
      for (const ch of s.chromas || []) if (ch.ownership?.owned) chromaIds.push(ch.id);
    }
  }
  return { skinIds, champIds, chromaIds };
}

const https = require('https');
// Game data straight from CommunityDragon, for when the League client isn't open
function cdragonGet(file) {
  return new Promise((resolve, reject) => {
    https.get(`${CDRAGON}v1/${file}`, { headers: { 'User-Agent': 'ff' } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// The ornate level border around the summoner icon in the lobby (prestige crest 1-21)
const crestUrl = (n) => (n ? `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/uikit/themed-borders/theme-${Math.min(Math.max(n, 1), 21)}-border.png` : null);

const profileIcon = (id) => (id != null ? `${CDRAGON}v1/profile-icons/${id}.jpg` : null);

module.exports = { GameData, fetchInventory, champOf, profileIcon, assetUrl, cdragonGet, crestUrl };
