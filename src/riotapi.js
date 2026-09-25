// Riot's official API: match history import, friend profiles, ranks.
const https = require('https');
const { fromApi, detailFromApi } = require('./stats');

const REGIONS = {
  NA: ['americas', 'na1'], NA1: ['americas', 'na1'], BR: ['americas', 'br1'], BR1: ['americas', 'br1'],
  LAN: ['americas', 'la1'], LA1: ['americas', 'la1'], LAS: ['americas', 'la2'], LA2: ['americas', 'la2'],
  EUW: ['europe', 'euw1'], EUW1: ['europe', 'euw1'], EUNE: ['europe', 'eun1'], EUN1: ['europe', 'eun1'],
  TR: ['europe', 'tr1'], TR1: ['europe', 'tr1'], RU: ['europe', 'ru'], ME: ['europe', 'me1'], ME1: ['europe', 'me1'],
  KR: ['asia', 'kr'], JP: ['asia', 'jp1'], JP1: ['asia', 'jp1'],
  OCE: ['sea', 'oc1'], OC1: ['sea', 'oc1'], PH: ['sea', 'ph2'], PH2: ['sea', 'ph2'], SG: ['sea', 'sg2'], SG2: ['sea', 'sg2'],
  TH: ['sea', 'th2'], TH2: ['sea', 'th2'], TW: ['sea', 'tw2'], TW2: ['sea', 'tw2'], VN: ['sea', 'vn2'], VN2: ['sea', 'vn2'],
};

class KeyError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RiotApi {
  constructor(key, region) {
    this.toApi = new Map();
    this.toLocal = new Map();
    this.key = key.trim();
    const [regional, platform] = REGIONS[String(region).toUpperCase()] || REGIONS.NA;
    this.regional = `${regional}.api.riotgames.com`;
    // account-v1 lives on americas/europe/asia only
    this.account = `${regional === 'sea' ? 'asia' : regional}.api.riotgames.com`;
    this.platform = `${platform}.api.riotgames.com`;
    this.calls = [];
  }

  // Dev and personal keys: 20 requests / 1s and 100 requests / 2min, shared by everything
  async throttle() {
    for (;;) {
      const now = Date.now();
      this.calls = this.calls.filter((t) => now - t < 120_000);
      const lastSec = this.calls.filter((t) => now - t < 1000).length;
      if (this.calls.length < 98 && lastSec < 19) break;
      await sleep(this.calls.length >= 98 ? 120_000 - (now - this.calls[0]) + 50 : 1000);
    }
    this.calls.push(Date.now());
  }

  async get(host, path) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.throttle();
      const res = await new Promise((resolve, reject) => {
        https.get({ host, path, headers: { 'X-Riot-Token': this.key } }, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
        }).on('error', reject);
      });
      if (res.status === 200) return JSON.parse(res.body);
      if (res.status === 401 || res.status === 403) throw new KeyError('Your Riot API key is invalid or expired. Paste a fresh one in Settings. Everything already loaded stays.');
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) { await sleep((Number(res.headers['retry-after']) || 5) * 1000); continue; }
      let why = ''; try { why = JSON.parse(res.body)?.status?.message || ''; } catch { /* no details */ }
      throw new Error(`Riot API error ${res.status}${why ? `: ${why}` : ''}`);
    }
    throw new Error('Riot API kept failing, try again later');
  }

  accountByRiotId(name, tag) { return this.get(this.account, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`); }
  accountByPuuid(puuid) { return this.get(this.account, `/riot/account/v1/accounts/by-puuid/${puuid}`); }
  summoner(puuid) { return this.get(this.platform, `/lol/summoner/v4/summoners/by-puuid/${puuid}`); }
  ranks(puuid) { return this.get(this.platform, `/lol/league/v4/entries/by-puuid/${puuid}`); }
  topMastery(puuid, n = 5) { return this.get(this.platform, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=${n}`); }
  matchIds(puuid, start = 0, count = 20, startTime) {
    return this.get(this.regional, `/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${start}&count=${count}${startTime ? `&startTime=${startTime}` : ''}`);
  }
  // Matches come back with this key's player IDs; swap in the IDs ff uses for people it knows
  async match(id) {
    const m = await this.get(this.regional, `/lol/match/v5/matches/${id}`);
    if (!m) return m;
    const local = (p) => this.toLocal.get(p) || p;
    if (m.metadata?.participants) m.metadata.participants = m.metadata.participants.map(local);
    for (const p of m.info?.participants || []) p.puuid = local(p.puuid);
    return m;
  }

  // Riot gives every API key its own encrypted version of each player ID, which differs from the
  // ID the League client uses. Translate: ff's ID -> this key's ID, via the Riot ID (cached).
  async id(localPuuid, riotId) {
    if (this.toApi.has(localPuuid)) return this.toApi.get(localPuuid);
    let apiPuuid = null;
    const [name, tag] = String(riotId || '').split('#');
    if (name && tag) {
      try { apiPuuid = (await this.accountByRiotId(name, tag))?.puuid || null; } catch { /* fall through */ }
    }
    if (!apiPuuid) apiPuuid = localPuuid; // already this key's ID (e.g. found through search)
    this.learn(localPuuid, apiPuuid);
    return apiPuuid;
  }
  learn(localPuuid, apiPuuid) {
    this.toApi.set(localPuuid, apiPuuid);
    this.toLocal.set(apiPuuid, localPuuid);
    if (this.onLearn) this.onLearn(localPuuid, apiPuuid);
  }
}

// One shared client so imports and profile refreshes respect the same rate limit
let shared = null;
function getApi(key, region) {
  if (!shared || shared.key !== key.trim() || shared.region !== region) { shared = new RiotApi(key, region); shared.region = region; }
  return shared;
}

// Pull up to ~2 years of matches, skipping ones already stored. Resumable.
async function backfill({ key, region, puuid, riotId, people = [], store, details, onProgress, shouldStop }) {
  const api = getApi(key, region);
  // this key's version of your ID (and your friends', so they're recognized in imported games)
  const apiPuuid = await api.id(puuid, riotId);
  for (const p of people) await api.id(p.puuid, p.name);
  const startTime = Math.floor(Date.now() / 1000) - 2 * 365 * 24 * 3600;
  const ids = [];
  for (let start = 0; ; start += 100) {
    if (shouldStop()) return;
    const page = await api.matchIds(apiPuuid, start, 100, startTime);
    if (!page || !page.length) break;
    ids.push(...page);
    onProgress({ phase: 'Finding games', done: 0, total: ids.length });
    if (page.length < 100) break;
  }
  const missing = ids.filter((id) => !store.has(Number(id.split('_')[1])));
  for (let i = 0; i < missing.length; i++) {
    if (shouldStop()) break;
    const match = await api.match(missing[i]);
    const m = match && fromApi(match, puuid);
    if (m) store.set(m.gameId, m);
    if (match) details.set(match.info.gameId, detailFromApi(match));
    if (i % 20 === 0) { store.save(); details.save(); }
    onProgress({ phase: 'Importing games', done: i + 1, total: missing.length });
  }
  store.save(); details.save();
}

module.exports = { backfill, getApi, KeyError, REGIONS };
