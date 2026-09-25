// Shared data through Supabase (replaces local-network discovery).
// Each copy of ff publishes its player's shared data (skins, banner, stats) to one row, and
// reads the rows of the people it cares about (lobby members and friends). Works across
// different networks, no firewall prompts. Writes go through ff_publish, which checks this
// install's secret, so nobody can overwrite anyone else's row.
const EventEmitter = require('events');
const crypto = require('crypto');

const URL = 'https://xboeqldysmrnysseeajq.supabase.co';
// Publishable key: meant to be public (the database's security rules do the protecting)
const KEY = 'sb_publishable_ktJ4LYd6aZ4yusCnWvjajw_7pmlLj1h';
const ONLINE_MS = 150_000;      // seen within 2.5 minutes = online
const HEARTBEAT_MS = 60_000;    // republish at least this often while running
const PULL_MS = 10_000;         // check friends for changes this often
const MAX_BYTES = 550_000;      // stay under the server's payload limit

const headers = (extra = {}) => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...extra });

class Cloud extends EventEmitter {
  constructor(getMine, { getInterest, getSecret }) {
    super();
    this.getMine = getMine;
    this.getInterest = getInterest; // () => [puuid...] we want data for
    this.getSecret = getSecret;     // () => this install's secret
    this.seen = new Map();          // puuid -> updated_at we last pulled
    this.lastSeen = new Map();      // puuid -> ms timestamp of their last publish
    this.lastHash = null;
    this.lastPublish = 0;
    this.status = 'starting';
  }

  start() {
    setTimeout(() => this.publish(), 3000);
    setInterval(() => this.publish(), 15_000);
    setInterval(() => this.pull(), PULL_MS);
    setTimeout(() => this.pull(), 4000);
  }

  isOnline(puuid) {
    const t = this.lastSeen.get(puuid);
    return Boolean(t && Date.now() - t < ONLINE_MS);
  }

  // Send our row when it changed (or as a heartbeat so friends see us as online)
  async publish(force = false) {
    const mine = this.getMine();
    if (!mine?.puuid) return;
    let payload = mine;
    let json = JSON.stringify(payload);
    if (json.length > MAX_BYTES && Array.isArray(mine.history)) {
      // trim shared match history until it fits
      let keep = mine.history.length;
      while (json.length > MAX_BYTES && keep > 20) { keep = Math.floor(keep * 0.7); payload = { ...mine, history: mine.history.slice(0, keep) }; json = JSON.stringify(payload); }
    }
    const hash = crypto.createHash('sha1').update(json).digest('hex');
    if (!force && hash === this.lastHash && Date.now() - this.lastPublish < HEARTBEAT_MS) return;
    try {
      const res = await fetch(`${URL}/rest/v1/rpc/ff_publish`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ p_puuid: mine.puuid, p_secret: this.getSecret(), p_name: mine.name || null, p_payload: payload }),
      });
      if (!res.ok) throw new Error(`publish ${res.status} ${(await res.text()).slice(0, 120)}`);
      const ok = await res.json();
      this.status = ok ? 'connected' : 'row owned by another install';
      this.lastHash = hash; this.lastPublish = Date.now();
    } catch (e) {
      this.status = `offline (${e.message})`;
    }
  }

  // Check which friends changed, then download only those
  async pull() {
    const ids = [...new Set(this.getInterest().filter(Boolean))];
    if (!ids.length) return;
    const list = ids.map((x) => `"${x.replace(/"/g, '')}"`).join(',');
    try {
      const res = await fetch(`${URL}/rest/v1/ff_players?select=puuid,updated_at&puuid=in.(${encodeURIComponent(list)})`, { headers: headers() });
      if (!res.ok) throw new Error(`pull ${res.status}`);
      const rows = await res.json();
      const wasOnline = new Set(ids.filter((id) => this.isOnline(id)));
      const changed = [];
      for (const r of rows) {
        this.lastSeen.set(r.puuid, Date.parse(r.updated_at));
        if (this.seen.get(r.puuid) !== r.updated_at) changed.push(r.puuid);
      }
      if (changed.length) {
        const q = changed.map((x) => `"${x}"`).join(',');
        const full = await fetch(`${URL}/rest/v1/ff_players?select=puuid,updated_at,payload&puuid=in.(${encodeURIComponent(q)})`, { headers: headers() });
        if (full.ok) {
          for (const r of await full.json()) {
            this.seen.set(r.puuid, r.updated_at);
            if (r.payload?.puuid === r.puuid) this.emit('inventory', r.payload);
          }
        }
      }
      if (ids.some((id) => wasOnline.has(id) && !this.isOnline(id))) this.emit('offline');
      this.status = this.status.startsWith('offline') ? 'connected' : this.status;
    } catch (e) {
      this.status = `offline (${e.message})`;
    }
  }

  // Grab everyone's latest right now (champ select, refresh)
  async syncAll() { this.seen.clear(); await this.pull(); }

  // Old "connect by address" is no longer needed
  async add() { return null; }
}

module.exports = { Cloud };
