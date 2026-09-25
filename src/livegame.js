// Live game coverage from Riot's Live Client Data API (https://127.0.0.1:2999), which the game
// serves locally while you're in a match. Only shows what the in-game Tab scoreboard already shows.
const https = require('https');
const EventEmitter = require('events');

const agent = new https.Agent({ rejectUnauthorized: false }); // the game uses a self-signed cert

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: '127.0.0.1', port: 2999, path, agent, timeout: 1500 }, (res) => {
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

class LiveGame extends EventEmitter {
  constructor() {
    super();
    this.data = null;
    this.timer = null;
  }

  // Poll fast while League says we're in a game, stop otherwise
  setActive(on) {
    if (on && !this.timer) { this.poll(); this.timer = setInterval(() => this.poll(), 2000); }
    if (!on && this.timer) { clearInterval(this.timer); this.timer = null; this.data = null; this.emit('update', null); }
  }

  async poll() {
    try {
      this.data = await getJson('/liveclientdata/allgamedata');
      this.data.receivedAt = Date.now();
      this.emit('update', this.data);
    } catch {
      // game still loading, or not in a game; keep the last good data
    }
  }
}

module.exports = { LiveGame };
