// Champion builds from OP.GG's official public data service (their MCP server: https://mcp-api.op.gg/mcp).
// Covers ARAM, Ranked, Flex, URF and Nexus Blitz. Results are cached so we barely touch their servers.
const URL = 'https://mcp-api.op.gg/mcp';
const HOURS = 6;
const cache = new Map(); // "CHAMP|mode|pos" -> { at, build }
let session = null;

const post = async (body, sid) => {
  const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'Mcp-Session-Id': sid } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  const m = text.match(/data: (\{.*\})/);
  return { sid: res.headers.get('mcp-session-id'), msg: text ? JSON.parse(m ? m[1] : text) : null };
};
async function connect() {
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ff', version: '1' } } });
  session = init.sid;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
}
async function callTool(name, args, retry = true) {
  if (!session) await connect();
  const { msg } = await post({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }, session);
  if (msg?.error) {
    if (retry && /session/i.test(msg.error.message || '')) { session = null; return callTool(name, args, false); }
    throw new Error(msg.error.message);
  }
  return msg?.result?.content?.[0]?.text || '';
}

// OP.GG answers in a compact "class" notation:  class Boots: ids,play,win   ...   Boots([3020],19906,10187)
function parseCompact(text) {
  const classes = {};
  for (const line of text.split('\n')) { const m = line.match(/^class (\w+): (.*)$/); if (m) classes[m[1]] = m[2].split(',').map((s) => s.trim()); }
  const body = text.slice(text.lastIndexOf('\nclass ') >= 0 ? text.indexOf('\n\n') + 2 : 0).trim();
  let i = 0;
  const ws = () => { while (/\s/.test(body[i])) i++; };
  const value = () => {
    ws();
    const c = body[i];
    if (c === '"') { let s = ''; i++; while (body[i] !== '"') { if (body[i] === '\\') { i++; s += body[i] === 'n' ? '\n' : body[i]; } else s += body[i]; i++; } i++; return s; }
    if (c === '[') { i++; const arr = []; ws(); if (body[i] === ']') { i++; return arr; } for (;;) { arr.push(value()); ws(); if (body[i] === ',') { i++; continue; } i++; return arr; } }
    const tok = body.slice(i).match(/^[-\w.]+/)[0]; i += tok.length;
    if (body[i] === '(') {
      i++; const args = []; ws();
      if (body[i] !== ')') for (;;) { args.push(value()); ws(); if (body[i] === ',') { i++; continue; } break; }
      i++;
      const fields = classes[tok] || [];
      return Object.fromEntries(fields.map((f, k) => [f, args[k]]));
    }
    if (/^-?\d+(\.\d+)?$/.test(tok)) return Number(tok);
    return tok === 'True' || tok === 'true' ? true : tok === 'False' || tok === 'false' ? false : tok === 'None' || tok === 'null' ? null : tok;
  };
  return value();
}

const FIELDS = [
  'data.summary.average_stats.{play,win_rate,pick_rate,tier}',
  'data.starter_items.{ids[],play,win}', 'data.core_items.{ids[],play,win,pick_rate}', 'data.boots.{ids[],play,win}',
  'data.fourth_items[].{ids[],play,win,pick_rate}', 'data.fifth_items[].{ids[],play,win,pick_rate}', 'data.sixth_items[].{ids[],play,win,pick_rate}',
  'data.runes.{primary_page_id,primary_rune_ids[],secondary_page_id,secondary_rune_ids[],stat_mod_ids[],play,win}',
  'data.skills.{order[],play,win}', 'data.skill_masteries.{ids[]}', 'data.summoner_spells.{ids[],play,win}',
];
const rate = (x) => (x && x.play ? x.win / x.play : null);
const opt = (x) => x && { ids: x.ids || [], play: x.play || 0, winRate: rate(x), pickRate: x.pick_rate ?? null };

// mode: 'aram' | 'ranked' | 'flex' | 'urf' | 'nexus_blitz'; position: 'top'|'jungle'|'mid'|'adc'|'support' (ARAM/URF ignore it)
async function build(championAlias, mode, position = 'mid') {
  const champ = String(championAlias || '').toUpperCase();
  const key = `${champ}|${mode}|${position}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < HOURS * 3600e3) return hit.build;
  const text = await callTool('lol_get_champion_analysis', { champion: champ, game_mode: mode, position, desired_output_fields: FIELDS });
  const d = parseCompact(text)?.data;
  if (!d) throw new Error('no build data');
  const s = d.summary?.average_stats || {};
  const out = {
    source: 'OP.GG', mode, position, games: s.play || 0, winRate: s.win_rate ?? null, pickRate: s.pick_rate ?? null, tier: s.tier ?? null,
    starter: opt(d.starter_items), core: opt(d.core_items), boots: opt(d.boots),
    fourth: (d.fourth_items || []).map(opt), fifth: (d.fifth_items || []).map(opt), sixth: (d.sixth_items || []).map(opt),
    spells: opt(d.summoner_spells),
    runes: d.runes && { primary: d.runes.primary_page_id, primaryIds: d.runes.primary_rune_ids || [], secondary: d.runes.secondary_page_id,
      secondaryIds: d.runes.secondary_rune_ids || [], shards: d.runes.stat_mod_ids || [], play: d.runes.play || 0, winRate: rate(d.runes) },
    skills: d.skills && { order: d.skills.order || [], play: d.skills.play || 0, winRate: rate(d.skills) },
    skillMax: d.skill_masteries?.ids || [],
  };
  cache.set(key, { at: Date.now(), build: out });
  return out;
}

module.exports = { build, parseCompact };
