// Local network sync: each app serves its own data and finds other ff apps via mDNS.
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');
const { Bonjour } = require('bonjour-service');

const DEFAULT_PORT = 47831;
const SERVICE_TYPE = 'skinmatch';

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Same-network addresses first: the one the announcement came from, then any on a local subnet
function candidates(svc) {
  const local = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  const sameNet = (ip) => local.some((l) => l.split('.').slice(0, 3).join('.') === ip.split('.').slice(0, 3).join('.'));
  const all = [svc.referer?.address, ...(svc.addresses || [])].filter((a) => a && a.includes('.'));
  return [...new Set(all)].sort((a, b) => (a === svc.referer?.address ? -2 : sameNet(a) ? -1 : 0) - (b === svc.referer?.address ? -2 : sameNet(b) ? -1 : 0));
}

const toUrl = (address) => `http://${address}${/:\d+$/.test(address) ? '' : ':' + DEFAULT_PORT}/inventory`;

class Peer extends EventEmitter {
  constructor(getMine) {
    super();
    this.getMine = getMine;
    this.instanceId = crypto.randomBytes(4).toString('hex');
    this.urls = new Map(); // url -> { puuid, online }
  }

  start() {
    this.server = http.createServer((req, res) => {
      if (req.url !== '/inventory') { res.writeHead(404); return res.end(); }
      const mine = this.getMine();
      if (!mine) { res.writeHead(503); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mine));
    });
    this.server.on('error', () => this.server.listen(0, '0.0.0.0')); // port taken, use any
    this.server.on('listening', () => this._advertise());
    this.server.listen(DEFAULT_PORT, '0.0.0.0');
    setInterval(() => this.syncAll(), 60_000);
  }

  _advertise() {
    if (this.bonjour) return;
    this.bonjour = new Bonjour();
    this.bonjour.publish({
      name: `skinmatch-${os.hostname()}-${this.instanceId}`,
      type: SERVICE_TYPE,
      port: this.server.address().port,
      txt: { id: this.instanceId },
    });
    this.bonjour.find({ type: SERVICE_TYPE }, (svc) => {
      if (svc.txt?.id === this.instanceId) return; // that's us
      this.connect(candidates(svc), svc.port);
    });
  }

  // PCs with WSL, Hyper-V, VPNs (Tailscale) etc. advertise several addresses.
  // Try them best-first and keep the first one that answers.
  async connect(ips, port) {
    for (const ip of ips) {
      const url = toUrl(`${ip}:${port}`);
      if (this.urls.get(url)?.online) return;
      const had = this.urls.has(url);
      if (!had) this.urls.set(url, { puuid: null, online: false });
      if (await this.fetch(url)) return;
      if (!had) this.urls.delete(url); // didn't answer, don't keep polling it
    }
  }

  add(address) {
    const url = toUrl(address);
    if (!this.urls.has(url)) this.urls.set(url, { puuid: null, online: false });
    return this.fetch(url);
  }

  syncAll() { return Promise.all([...this.urls.keys()].map((u) => this.fetch(u))); }

  isOnline(puuid) {
    for (const v of this.urls.values()) if (v.puuid === puuid && v.online) return true;
    return false;
  }

  async fetch(url) {
    const entry = this.urls.get(url);
    if (!entry) return null;
    try {
      const inv = await getJson(url);
      if (inv.puuid === this.getMine()?.puuid) { this.urls.delete(url); return null; } // our own account
      entry.puuid = inv.puuid;
      entry.online = true;
      this.emit('inventory', inv);
      return inv;
    } catch {
      entry.online = false;
      this.emit('offline');
      return null;
    }
  }
}

module.exports = { Peer };
