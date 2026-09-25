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

// ---------- sign-in (email code) ----------
async function authCall(path, body, token) {
  const res = await fetch(`${URL}/auth/v1/${path}`, { method: 'POST', headers: headers(token ? { Authorization: `Bearer ${token}` } : {}), body: JSON.stringify(body || {}) });
  const text = await res.text();
  let data = {}; try { data = JSON.parse(text); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.msg || data.error_description || data.message || `sign-in error ${res.status}`);
  return data;
}

class Cloud extends EventEmitter {
  constructor(getMine, { getInterest, getSecret, getAuth, setAuth }) {
    super();
    this.getAuth = getAuth;         // () => saved session { email, userId, access, refresh, expires, links }
    this.setAuth = setAuth;         // (session | null) => save it
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

  // Email a 6-digit sign-in code
  async sendCode(email) {
    await authCall('otp', { email, create_user: true });
  }
  // Check the code; on success we're signed in (and stay signed in)
  async verifyCode(email, code) {
    let data;
    try { data = await authCall('verify', { type: 'email', email, token: code }); }
    catch (e) { data = await authCall('verify', { type: 'signup', email, token: code }).catch(() => { throw e; }); }
    this.saveSession(data);
    this.lastHash = null; // republish as the signed-in owner
    await this.link();
    await this.publish(true);
    return this.getAuth();
  }
  saveSession(d) {
    const prev = this.getAuth() || {};
    this.setAuth({ email: d.user?.email || prev.email, userId: d.user?.id || prev.userId, access: d.access_token, refresh: d.refresh_token,
      expires: Date.now() + (d.expires_in || 3600) * 1000, links: prev.links || {} });
  }
  async signOut() {
    const a = this.getAuth();
    if (a?.access) authCall('logout', {}, a.access).catch(() => {});
    this.setAuth(null);
    this.lastHash = null;
  }
  // A fresh access token (they last an hour; the refresh token keeps you signed in)
  async token() {
    const a = this.getAuth();
    if (!a?.refresh) return null;
    if (a.access && Date.now() < a.expires - 60_000) return a.access;
    try {
      const d = await authCall('token?grant_type=refresh_token', { refresh_token: a.refresh });
      this.saveSession(d);
      return d.access_token;
    } catch (e) {
      if (/invalid|revoked|not found/i.test(e.message)) this.setAuth(null); // signed out elsewhere
      return null;
    }
  }
  // Claim this PC's League account for the signed-in user (once per League account)
  async link() {
    const mine = this.getMine();
    const a = this.getAuth();
    const tok = await this.token();
    if (!mine?.puuid || !a || !tok) return null;
    if (a.links?.[mine.puuid] === 'linked') return 'linked';
    try {
      const res = await fetch(`${URL}/rest/v1/rpc/ff_link`, { method: 'POST', headers: headers({ Authorization: `Bearer ${tok}` }),
        body: JSON.stringify({ p_puuid: mine.puuid, p_secret: this.getSecret() }) });
      const result = res.ok ? await res.json() : `error ${res.status}`;
      const fresh = this.getAuth();
      if (fresh) { fresh.links = { ...(fresh.links || {}), [mine.puuid]: result, [`${mine.puuid}:name`]: mine.name }; this.setAuth(fresh); }
      return result;
    } catch { return null; }
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
      // signed in and this League account is linked: publish as the account; otherwise the old install way
      const a = this.getAuth();
      if (a && a.links?.[mine.puuid] !== 'linked') await this.link();
      const tok = a && this.getAuth()?.links?.[mine.puuid] === 'linked' ? await this.token() : null;
      const res = tok
        ? await fetch(`${URL}/rest/v1/rpc/ff_publish_auth`, { method: 'POST', headers: headers({ Authorization: `Bearer ${tok}` }),
            body: JSON.stringify({ p_puuid: mine.puuid, p_name: mine.name || null, p_payload: payload }) })
        : await fetch(`${URL}/rest/v1/rpc/ff_publish`, { method: 'POST', headers: headers(),
            body: JSON.stringify({ p_puuid: mine.puuid, p_secret: this.getSecret(), p_name: mine.name || null, p_payload: payload }) });
      if (!res.ok) throw new Error(`publish ${res.status} ${(await res.text()).slice(0, 120)}`);
      const ok = await res.json();
      this.status = ok ? 'connected' : tok ? 'this League account is linked to a different sign-in' : 'this League account is signed in on another PC; sign in here to use it';
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
