// Talks to the League Client's local API (LCU).
const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const EventEmitter = require('events');
const WebSocket = require('ws');

const agent = new https.Agent({ rejectUnauthorized: false }); // LCU uses a self-signed cert

const LOCKFILE_PATHS = [
  'C:\\Riot Games\\League of Legends\\lockfile',
  'D:\\Riot Games\\League of Legends\\lockfile',
  '/Applications/League of Legends.app/Contents/LoL/lockfile',
];

function findCredsFromProcess() {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'powershell.exe' : 'sh';
    const args = isWin
      ? ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"]
      : ['-c', 'ps -A -o args | grep LeagueClientUx | grep -v grep'];
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const port = stdout.match(/--app-port=(\d+)/);
      const token = stdout.match(/--remoting-auth-token=([\w-]+)/);
      resolve(port && token ? { port: Number(port[1]), password: token[1] } : null);
    });
  });
}

function findCredsFromLockfile() {
  for (const p of LOCKFILE_PATHS) {
    try {
      const [, , port, password] = fs.readFileSync(p, 'utf8').split(':');
      return { port: Number(port), password };
    } catch { /* try next */ }
  }
  return null;
}

class LCU extends EventEmitter {
  constructor() {
    super();
    this.creds = null;
    this.ws = null;
    this.connected = false;
    this._poll();
  }

  async _poll() {
    if (!this.connected) {
      const creds = (await findCredsFromProcess()) || findCredsFromLockfile();
      if (creds) await this._connect(creds);
    }
    setTimeout(() => this._poll(), 3000);
  }

  async _connect(creds) {
    this.creds = creds;
    try {
      await this.request('GET', '/lol-summoner/v1/current-summoner');
    } catch {
      this.creds = null;
      return; // client still starting up
    }
    const auth = 'Basic ' + Buffer.from(`riot:${creds.password}`).toString('base64');
    const ws = new WebSocket(`wss://127.0.0.1:${creds.port}/`, {
      headers: { Authorization: auth },
      rejectUnauthorized: false,
    });
    ws.on('open', () => {
      this.ws = ws;
      this.connected = true;
      ws.send(JSON.stringify([5, 'OnJsonApiEvent_lol-champ-select_v1_session']));
      ws.send(JSON.stringify([5, 'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase']));
      ws.send(JSON.stringify([5, 'OnJsonApiEvent_lol-lobby_v2_lobby']));
      ws.send(JSON.stringify([5, 'OnJsonApiEvent_lol-matchmaking_v1_search']));
      ws.send(JSON.stringify([5, 'OnJsonApiEvent_lol-chat_v1_me']));
      this.emit('connected');
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg[0] === 8 && msg[2]) this.emit('event', msg[2]); // { uri, eventType, data }
      } catch { /* ignore */ }
    });
    const drop = () => {
      if (!this.connected) return;
      this.connected = false;
      this.ws = null;
      this.creds = null;
      this.emit('disconnected');
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  request(method, path, body) {
    return new Promise((resolve, reject) => {
      if (!this.creds) return reject(new Error('Not connected'));
      const data = body ? JSON.stringify(body) : null;
      const req = https.request({
        host: '127.0.0.1',
        port: this.creds.port,
        path,
        method,
        agent,
        headers: {
          Authorization: 'Basic ' + Buffer.from(`riot:${this.creds.password}`).toString('base64'),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }, (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`${method} ${path} -> ${res.statusCode}`));
          try { resolve(chunks ? JSON.parse(chunks) : null); } catch { resolve(chunks); }
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
}

module.exports = { LCU };
