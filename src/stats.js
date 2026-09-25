// Local match store (all sources normalize into one shape) + stat calculations.
const fs = require('fs');

const QUEUES = {
  rift: [400, 420, 430, 440, 490, 700],
  aram: [450, 100, 720],
  arena: [1700, 1710],
};
const modeOf = (q) => Object.keys(QUEUES).find((m) => QUEUES[m].includes(q)) || 'other';
const MODES = ['all', 'rift', 'aram', 'arena'];

class JsonStore {
  constructor(file) {
    this.file = file;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
  }
  has(id) { return Boolean(this.data[id]); }
  set(id, value) { this.data[id] = value; this.dirty = true; }
  values() { return Object.values(this.data); }
  save() { if (this.dirty) { fs.writeFileSync(this.file, JSON.stringify(this.data)); this.dirty = false; } }
}

// Riot API match-v5 -> our shape
function fromApi(match, puuid) {
  const info = match.info;
  const me = info.participants.find((p) => p.puuid === puuid);
  if (!me) return null;
  const duration = info.gameEndTimestamp ? info.gameDuration : Math.round(info.gameDuration / 1000); // old games used ms
  return {
    gameId: info.gameId, queueId: info.queueId, start: info.gameCreation, duration,
    champ: me.championId, win: Boolean(me.win), k: me.kills, d: me.deaths, a: me.assists,
    mates: info.participants.filter((p) => p.teamId === me.teamId && p.puuid !== puuid).map((p) => ({ puuid: p.puuid, champ: p.championId })),
  };
}

// League client match history game -> our shape
function fromLcu(game, puuid) {
  const ids = game.participantIdentities || [];
  const mine = ids.find((i) => i.player?.puuid === puuid);
  if (!mine) return null;
  const me = game.participants.find((p) => p.participantId === mine.participantId);
  const puuidOf = (pid) => ids.find((i) => i.participantId === pid)?.player?.puuid;
  return {
    gameId: game.gameId, queueId: game.queueId, start: game.gameCreation, duration: game.gameDuration,
    champ: me.championId, win: Boolean(me.stats.win), k: me.stats.kills, d: me.stats.deaths, a: me.stats.assists,
    mates: game.participants.filter((p) => p.teamId === me.teamId && p.participantId !== me.participantId)
      .map((p) => ({ puuid: puuidOf(p.participantId), champ: p.championId })),
  };
}

// Full 10-player scoreboard, from the Riot API
function detailFromApi(match) {
  const info = match.info;
  const duration = info.gameEndTimestamp ? info.gameDuration : Math.round(info.gameDuration / 1000);
  return {
    gameId: info.gameId, queueId: info.queueId, gameMode: info.gameMode, mapId: info.mapId, start: info.gameCreation, duration,
    teams: (info.teams || []).map((t) => ({
      id: t.teamId, win: Boolean(t.win), kills: t.objectives?.champion?.kills || 0,
      baron: t.objectives?.baron?.kills || 0, dragon: t.objectives?.dragon?.kills || 0, tower: t.objectives?.tower?.kills || 0,
    })),
    players: info.participants.map((p) => ({
      puuid: p.puuid, name: p.riotIdGameName || p.summonerName || '', tag: p.riotIdTagline || p.riotIdTagLine || '',
      champ: p.championId, team: p.teamId, win: Boolean(p.win), role: p.teamPosition || '',
      k: p.kills, d: p.deaths, a: p.assists, cs: (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0),
      gold: p.goldEarned, dmg: p.totalDamageDealtToChampions, vision: p.visionScore, level: p.champLevel,
      items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6],
      spells: [p.summoner1Id, p.summoner2Id],
      rune: p.perks?.styles?.[0]?.selections?.[0]?.perk || 0, subStyle: p.perks?.styles?.[1]?.style || 0,
      taken: p.totalDamageTaken || 0, heal: (p.totalHealsOnTeammates || 0) + (p.totalDamageShieldedOnTeammates || 0),
      pentas: p.pentaKills || 0, quadras: p.quadraKills || 0, placement: p.placement || p.subteamPlacement || 0, sub: p.playerSubteamId || 0,
      augments: [p.playerAugment1, p.playerAugment2, p.playerAugment3, p.playerAugment4, p.playerAugment5, p.playerAugment6].filter(Boolean),
    })),
  };
}

// Same scoreboard shape, from the League client's match history
function detailFromLcu(game) {
  const ids = game.participantIdentities || [];
  const player = (pid) => ids.find((i) => i.participantId === pid)?.player || {};
  return {
    gameId: game.gameId, queueId: game.queueId, gameMode: game.gameMode, mapId: game.mapId, start: game.gameCreation, duration: game.gameDuration,
    teams: (game.teams || []).map((t) => ({
      id: t.teamId, win: t.win === 'Win', kills: game.participants.filter((p) => p.teamId === t.teamId).reduce((a, p) => a + (p.stats.kills || 0), 0),
      baron: t.baronKills || 0, dragon: t.dragonKills || 0, tower: t.towerKills || 0,
    })),
    players: game.participants.map((p) => {
      const pl = player(p.participantId), st = p.stats || {};
      return {
        puuid: pl.puuid, name: pl.gameName || pl.summonerName || '', tag: pl.tagLine || '',
        champ: p.championId, team: p.teamId, win: Boolean(st.win), role: p.timeline?.lane || '',
        k: st.kills, d: st.deaths, a: st.assists, cs: (st.totalMinionsKilled || 0) + (st.neutralMinionsKilled || 0),
        gold: st.goldEarned, dmg: st.totalDamageDealtToChampions, vision: st.visionScore, level: st.champLevel,
        items: [st.item0, st.item1, st.item2, st.item3, st.item4, st.item5, st.item6],
        spells: [p.spell1Id, p.spell2Id], rune: st.perk0 || 0, subStyle: st.perkSubStyle || 0,
        taken: st.totalDamageTaken || 0, heal: (st.totalHealsOnTeammates || 0) + (st.totalDamageShieldedOnTeammates || 0),
        pentas: st.pentaKills || 0, quadras: st.quadraKills || 0, placement: st.subteamPlacement || st.placement || 0, sub: st.playerSubteamId || 0,
        augments: [st.playerAugment1, st.playerAugment2, st.playerAugment3, st.playerAugment4, st.playerAugment5, st.playerAugment6].filter(Boolean),
      };
    }),
  };
}

function agg(list) {
  const t = { games: 0, wins: 0, secs: 0, k: 0, d: 0, a: 0 };
  for (const m of list) { t.games++; t.wins += m.win; t.secs += m.duration; t.k += m.k; t.d += m.d; t.a += m.a; }
  return {
    games: t.games,
    wins: t.wins,
    winRate: t.games ? t.wins / t.games : 0,
    hours: t.secs / 3600,
    kda: (t.k + t.a) / Math.max(t.d, 1),
    avg: t.games ? { k: t.k / t.games, d: t.d / t.games, a: t.a / t.games } : { k: 0, d: 0, a: 0 },
  };
}

function groupTop(list, keyFn, decorate, limit = 10) {
  const groups = new Map();
  for (const m of list) {
    const key = keyFn(m);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return [...groups.entries()]
    .map(([key, ms]) => ({ ...decorate(key, ms), ...agg(ms) }))
    .sort((a, b) => b.games - a.games)
    .slice(0, limit);
}

const played = (matches, mode) => matches.filter((m) => m.duration >= 300 && (mode === 'all' || modeOf(m.queueId) === mode)); // skip remakes

function summarize(matches, champs, mode) {
  const list = played(matches, mode);
  const allChamps = groupTop(list, (m) => m.champ, (id) => ({ champ: champs[id] || { id, name: `Champion ${id}` } }), Infinity);
  const best = allChamps.filter((c) => c.games >= 20).sort((a, b) => b.winRate - a.winRate)[0];
  let streak = 0, run = 0;
  for (const m of [...list].sort((a, b) => a.start - b.start)) { run = m.win ? run + 1 : 0; streak = Math.max(streak, run); }
  return {
    ...agg(list),
    since: list.length ? Math.min(...list.map((m) => m.start)) : null,
    champs: allChamps.slice(0, 10),
    bestWinRate: best ? { champ: best.champ, winRate: best.winRate, games: best.games } : null,
    streak,
  };
}

// Everything the partner's app needs to show "Partner" stats
function buildSummary(matches, champs, mastery) {
  const modes = {};
  for (const mode of MODES) modes[mode] = summarize(matches, champs, mode);
  return {
    modes,
    // same order as the League client: mastery level first, then points
    mastery: [...(mastery || [])].sort((a, b) => (b.championLevel - a.championLevel) || (b.championPoints - a.championPoints)).slice(0, 10).map((m) => ({
      champ: champs[m.championId] || { id: m.championId, name: `Champion ${m.championId}` },
      points: m.championPoints, level: m.championLevel, lastPlayed: m.lastPlayTime,
    })),
  };
}

function duoSummary(matches, partnerPuuid, champs, skinLog, mode) {
  const list = played(matches, mode);
  const partnerOf = (m) => m.mates.find((x) => x.puuid === partnerPuuid);
  const together = list.filter(partnerOf);
  const apart = list.filter((m) => !partnerOf(m));
  // skin log entries: new { with: { puuid: lineName|null } }, legacy { matched, line }
  const logged = together.map((m) => {
    const e = skinLog[m.gameId];
    if (!e) return null;
    if (e.with) return partnerPuuid in e.with ? { matched: Boolean(e.with[partnerPuuid]), line: e.with[partnerPuuid] } : null;
    return e;
  }).filter(Boolean);
  return {
    together: agg(together),
    apart: agg(apart),
    since: together.length ? Math.min(...together.map((m) => m.start)) : null,
    pairs: groupTop(together, (m) => `${m.champ}:${partnerOf(m).champ}`, (key) => {
      const [a, b] = key.split(':').map(Number);
      return { mine: champs[a] || { id: a, name: `Champion ${a}` }, theirs: champs[b] || { id: b, name: `Champion ${b}` } };
    }, 8),
    skins: {
      tracked: logged.length,
      matched: logged.filter((e) => e.matched).length,
      lines: groupTop(logged.filter((e) => e.matched).map((e) => ({ ...e, win: false, duration: 0, k: 0, d: 0, a: 0 })),
        (e) => e.line, (line) => ({ line }), 5),
    },
  };
}

module.exports = { JsonStore, fromApi, fromLcu, detailFromApi, detailFromLcu, buildSummary, duoSummary, MODES };
