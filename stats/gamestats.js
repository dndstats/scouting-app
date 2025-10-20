const GAME_STATS_INPUT_SHEET = 'shotmap';
const GAME_STATS_INPUT_HEADERS = ['gameId', 'org', 'date', 'opponent', 'competition'];
const GAME_STATS_CACHE_SECONDS = 300;

function getGameStatsFilters() {
  try {
    const games = readGameRows_().map(function(row){
      const labelParts = [];
      if (row.date) labelParts.push(row.date);
      if (row.opponent) labelParts.push('vs ' + row.opponent);
      if (row.competition) labelParts.push('(' + row.competition + ')');
      return {
        gameId: row.gameId,
        label: labelParts.length ? labelParts.join(' ') : row.gameId,
        date: row.date,
      };
    });
    games.sort(function(a, b){
      const tA = a.date ? Date.parse(a.date) || 0 : 0;
      const tB = b.date ? Date.parse(b.date) || 0 : 0;
      return tB - tA;
    });
    return {
      ok: true,
      games: games.map(function(item){ return { gameId: item.gameId, label: item.label }; }),
    };
  } catch (err) {
    console.error('getGameStatsFilters error:', err);
    return { ok: false, error: String(err) };
  }
}

function getGameStats(query) {
  try {
    const gameId = String(query && query.gameId || '').trim();
    if (!gameId) return { ok: false, error: 'Missing gameId.' };

    const cacheKey = 'gamestats:' + gameId;
    let raw = _cacheGetJSON_ && _cacheGetJSON_(cacheKey);
    if (!raw) {
      raw = fetchGameStatsData_(gameId);
      if (_cachePutJSON_) _cachePutJSON_(cacheKey, raw, GAME_STATS_CACHE_SECONDS);
    }

    return buildGameStatsPayload_(raw || {}, query || {}, gameId);
  } catch (err) {
    console.error('getGameStats error:', err);
    return { ok: false, error: String(err) };
  }
}

function fetchGameStatsData_(gameId) {
  const cleanId = String(gameId || '').trim();
  if (!cleanId) throw new Error('Missing gameId');
  const url = 'https://fibalivestats.dcd.shared.geniussports.com/data/' + encodeURIComponent(cleanId) + '/data.json';
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Request failed (' + code + '): ' + url);
  }
  const text = resp.getContentText();
  return text ? JSON.parse(text) : {};
}

function buildGameStatsPayload_(data, query, gameId) {
  const teams = [];
  const tmLookup = {};

  const structuredTeams = [].concat(data?.teams || data?.Teams || []);
  if (structuredTeams.length) {
    structuredTeams.forEach(function(team) {
      const id = String(team?.id || team?.teamId || team?.TeamID || team?.TeamId || team?.code || '').trim();
      const name = String(team?.name || team?.Name || '').trim() || id;
      const abbreviation = String(team?.abbreviation || team?.Abbreviation || team?.shortName || team?.ShortName || id).trim() || id;
      const totals = normalizeTotals_(team?.totals || team?.Totals || {});
      const playersRaw = [].concat(team?.players || team?.Players || []);
      teams.push({ id, name, abbreviation, totals, playersRaw, sourceKey: null, raw: team });
    });
  } else if (data && typeof data.tm === 'object' && !Array.isArray(data.tm)) {
    Object.keys(data.tm || {}).forEach(function(key) {
      const entry = data.tm[key] || {};
      const id = String(entry.code || entry.codeInternational || entry.teamId || key).trim() || key;
      const abbreviation = String(entry.code || entry.codeInternational || entry.shortNameInternational || entry.shortName || id).trim() || id;
      const name = String(entry.nameInternational || entry.name || entry.shortName || abbreviation).trim() || id;
      const totals = normalizeTotalsFromTm_(entry);
      const playersRaw = Object.keys(entry.pl || {}).map(function(playerKey) {
        return convertTmPlayer_(id, name, abbreviation, key, playerKey, entry.pl[playerKey] || {});
      });
      teams.push({ id, name, abbreviation, totals, playersRaw, sourceKey: key, raw: entry });
      tmLookup[key] = { id: id, name: name, abbreviation: abbreviation };
    });
  }

  const playersAll = [];
  const playerIndex = {};
  teams.forEach(function(team){
    team.playersRaw.forEach(function(player){
      const entry = Object.assign({}, player);
      entry.teamId = team.id;
      entry.teamAbbreviation = team.abbreviation;
      entry.teamName = team.name;
      playersAll.push(entry);
      if (entry.id) playerIndex[entry.id] = entry;
      (entry.aliases || []).forEach(function(alias){
        if (alias) playerIndex[alias.toLowerCase()] = entry;
      });
    });
  });

  const pbpRaw = Array.isArray(data?.pbp) ? data.pbp.slice() : Array.isArray(data?.plays) ? data.plays.slice() : [];

  const metrics = computeTeamMetrics_(teams, pbpRaw, tmLookup, data);
  const teamLookup = {};
  metrics.teams.forEach(function(team) { teamLookup[team.id] = team; });

  const playersWithAdvanced = augmentPlayersWithAdvanced_(playersAll, teamLookup);

  const teamFilter = String(query.teamId || '').trim();
  const playerFilter = String(query.playerId || '').trim();
  const filteredPlayers = playersWithAdvanced.filter(function(player){
    if (teamFilter && player.teamId !== teamFilter) return false;
    if (playerFilter && player.id !== playerFilter) return false;
    return true;
  });

  const filters = buildFiltersPayload_(metrics.teams, playersWithAdvanced, metrics.timeline, metrics.periods);

  return {
    ok: true,
    game: normalizeGameMeta_(data?.game || data?.Game || {}, metrics.teams, gameId),
    filters: filters,
    teams: metrics.teams,
    players: filteredPlayers,
    allPlayers: playersWithAdvanced,
    timeline: metrics.timeline,
    insights: buildInsights_(metrics.teams, playersWithAdvanced),
  };
}

function computeTeamMetrics_(teams, rawPlays, tmLookup, data) {
  const periodLengthMinutes = Number(data?.periodLength || data?.periodLengthREGULAR || 10) || 10;
  const periodLengthSeconds = periodLengthMinutes * 60;
  const overtimeLengthSeconds = Number(data?.periodLengthOVERTIME || 5) * 60 || 300;

  const teamIndex = {};
  teams.forEach(function(team){
    teamIndex[team.id] = team;
    if (team.name) teamIndex[team.name.toLowerCase()] = team;
    if (team.abbreviation) teamIndex[team.abbreviation.toLowerCase()] = team;
    if (team.raw && typeof team.raw === 'object' && team.sourceKey) {
      tmLookup[team.sourceKey] = { id: team.id, name: team.name, abbreviation: team.abbreviation };
    }
  });

  const shotAttempts = {};
  teams.forEach(function(team){
    shotAttempts[team.id] = { paint: 0, mid: 0, three: 0, ft: 0 };
  });

  const sortedPlays = rawPlays.slice().sort(function(a, b){
    return Number(a?.actionNumber || 0) - Number(b?.actionNumber || 0);
  });

  sortedPlays.forEach(function(play){
    const teamId = resolveTeamIdFromPlay_(play, teamIndex, tmLookup);
    if (!teamId || !shotAttempts[teamId]) return;
    const action = String(play?.actionType || play?.ActionType || '').toLowerCase();
    const subtype = String(play?.subType || play?.SubType || '').toLowerCase();
    if (action === '3pt' || action === '3pt shot' || action === '3ptr') {
      shotAttempts[teamId].three += 1;
    } else if (action === '2pt' || action === '2pt shot' || action === '2ptr') {
      const category = classifyTwoPoint_(subtype);
      if (category === 'paint') shotAttempts[teamId].paint += 1;
      else shotAttempts[teamId].mid += 1;
    } else if (action === 'freethrow' || action === 'free throw') {
      shotAttempts[teamId].ft += 1;
    }
  });

  const scoreboardOrder = [
    (tmLookup && tmLookup['1'] && tmLookup['1'].id) || (teams[0] && teams[0].id) || 'team1',
    (tmLookup && tmLookup['2'] && tmLookup['2'].id) || (teams[1] && teams[1].id) || 'team2',
  ];

  const scoreEvents = buildScoreEvents_(sortedPlays, scoreboardOrder, periodLengthSeconds, overtimeLengthSeconds);

  const enrichedTeams = teams.map(function(team){
    const totals = team.totals || {};
    return Object.assign({}, team, {
      totals: totals,
      minutes: parseMinutes_(team.raw && team.raw.tot_sMinutes ? team.raw.tot_sMinutes : ''),
    });
  });

  enrichedTeams.forEach(function(team){
    const totals = team.totals || {};
    const opp = enrichedTeams.find(function(t){ return t.id !== team.id; }) || { totals: {} };
    const poss = computePossessions_(totals);
    const oppPoss = computePossessions_(opp.totals || {});
    const pace = (poss && oppPoss) ? (poss + oppPoss) / 2 : null;
    const offensiveRating = poss ? (totals.pts || 0) / poss * 100 : null;
    const defensiveRating = oppPoss ? (opp.totals?.pts || 0) / oppPoss * 100 : null;
    const netRating = (offensiveRating != null && defensiveRating != null) ? offensiveRating - defensiveRating : null;
    const efg = totals.fga ? (totals.fgm + 0.5 * (totals.tpm || 0)) / totals.fga : null;
    const tov = poss ? (totals.to || 0) / poss : null;
    const orb = (totals.oreb + (opp.totals?.dreb || 0)) ? (totals.oreb || 0) / (totals.oreb + (opp.totals?.dreb || 0)) : null;
    const ftr = totals.fga ? (totals.fta || 0) / totals.fga : null;

    const shots = shotAttempts[team.id] || { paint: 0, mid: 0, three: 0, ft: totals.fta || 0 };
    const totalFloorAttempts = shots.paint + shots.mid + shots.three;
    const totalAttempts = totalFloorAttempts + shots.ft;

    team.metrics = {
      possessions: poss,
      opponentPossessions: oppPoss,
      pace: pace,
      offensiveRating: offensiveRating,
      defensiveRating: defensiveRating,
      netRating: netRating,
      fourFactors: {
        efg: efg,
        tov: tov,
        orb: orb,
        ftr: ftr,
      },
      shotProfile: totalAttempts ? {
        paint: totalAttempts ? shots.paint / totalAttempts : 0,
        mid: totalAttempts ? shots.mid / totalAttempts : 0,
        three: totalAttempts ? shots.three / totalAttempts : 0,
        ft: totalAttempts ? shots.ft / totalAttempts : 0,
      } : {
        paint: null,
        mid: null,
        three: null,
        ft: null,
      },
    };
  });

  const timeline = buildTimeline_(scoreEvents, scoreboardOrder, enrichedTeams);
  return {
    teams: enrichedTeams,
    timeline: timeline,
    periods: (data && data.periodsMax) || 4,
  };
}

function augmentPlayersWithAdvanced_(players, teamLookup) {
  const byTeamMinutes = {};
  Object.keys(teamLookup).forEach(function(teamId){
    const team = teamLookup[teamId];
    const minutes = parseMinutes_(team?.raw?.tot_sMinutes || '');
    byTeamMinutes[teamId] = minutes || 200;
  });

  const playersByTeam = {};
  players.forEach(function(player){
    playersByTeam[player.teamId] = playersByTeam[player.teamId] || [];
    playersByTeam[player.teamId].push(player);
  });

  Object.keys(playersByTeam).forEach(function(teamId){
    if (!byTeamMinutes[teamId]) {
      byTeamMinutes[teamId] = playersByTeam[teamId].reduce(function(sum, player){
        return sum + parseMinutes_(player.statistics && player.statistics.minutes);
      }, 0) || 200;
    }
  });

  return players.map(function(player){
    const stats = player.statistics || {};
    const team = teamLookup[player.teamId] || {};
    const totals = team.totals || {};
    const possessions = team.metrics ? team.metrics.possessions : computePossessions_(totals);
    const playerMinutes = parseMinutes_(stats.minutes);
    const teamMinutes = byTeamMinutes[player.teamId] || 200;
    const usageDenominator = (totals.fga || 0) + 0.44 * (totals.fta || 0) + (totals.to || 0);
    const usageNumerator = (stats.fga || 0) + 0.44 * (stats.fta || 0) + (stats.to || 0);
    const usage = playerMinutes && teamMinutes && usageDenominator
      ? 100 * usageNumerator * (teamMinutes / 5) / (playerMinutes * usageDenominator)
      : null;
    const tsDenominator = (stats.fga || 0) + 0.44 * (stats.fta || 0);
    const trueShooting = tsDenominator ? (stats.pts || 0) / (2 * tsDenominator) : null;
    const reboundShare = team.minutes
      ? ((stats.reb || 0) * 100) / ((playerMinutes || 0) ? (team.minutes * (totals.reb || 0) / team.minutes) : 1)
      : null;

    return Object.assign({}, player, {
      advanced: {
        minutes: playerMinutes,
        usage: usage,
        trueShooting: trueShooting,
        offensiveRating: (stats.pts || 0) && possessions ? (stats.pts / possessions) * 100 : null,
        reboundPercentage: reboundShare,
      },
    });
  });
}

function buildTimeline_(events, scoreboardOrder, teams) {
  if (!events.length) {
    return { labels: [], series: [] };
  }
  const teamNames = {};
  teams.forEach(function(team) { teamNames[team.id] = team.name || team.abbreviation || team.id; });

  const labels = [];
  const scores1 = [];
  const scores2 = [];

  events.forEach(function(event){
    const label = 'Q' + event.period + ' ' + formatClockLabel_(event.clock);
    labels.push(label);
    scores1.push(event.score1);
    scores2.push(event.score2);
  });

  return {
    labels: labels,
    series: [
      {
        teamId: scoreboardOrder[0],
        name: teamNames[scoreboardOrder[0]] || 'Team 1',
        scores: scores1,
      },
      {
        teamId: scoreboardOrder[1],
        name: teamNames[scoreboardOrder[1]] || 'Team 2',
        scores: scores2,
      },
    ],
  };
}

function buildScoreEvents_(plays, scoreboardOrder, periodLengthSeconds, overtimeLengthSeconds) {
  const events = [];
  let prevScores = null;
  plays.forEach(function(play){
    const cur = {
      s1: Number(play?.s1 || (prevScores ? prevScores.s1 : 0)),
      s2: Number(play?.s2 || (prevScores ? prevScores.s2 : 0)),
    };
    if (!prevScores) {
      prevScores = cur;
      return;
    }
    const diff1 = cur.s1 - prevScores.s1;
    const diff2 = cur.s2 - prevScores.s2;
    const scored = diff1 !== 0 || diff2 !== 0;
    if (!scored) {
      prevScores = cur;
      return;
    }
    const validScore = diff1 >= 0 && diff2 >= 0 && diff1 <= 4 && diff2 <= 4;
    if (!validScore) {
      return;
    }
    const scoreboardIndex = diff1 > 0 ? 0 : 1;
    const clockStr = String(play.clock || play.gt || '');
    events.push({
      actionNumber: Number(play.actionNumber || play.id || 0),
      scoreboardIndex: scoreboardIndex,
      score1: cur.s1,
      score2: cur.s2,
      lead: cur.s1 - cur.s2,
      period: Number(play.period || play.Period || play.per || 0) || 1,
      clock: clockStr,
      player: String(play.player || play.Player || '').trim(),
      actionLabel: buildActionLabel_(play),
      points: diff1 > 0 ? diff1 : diff2,
    });
    prevScores = cur;
  });
  return events;
}

function buildFiltersPayload_(teams, players, timeline) {
  const teamOptions = teams.map(function(team){
    return { id: team.id, label: team.name || team.abbreviation || team.id };
  });
  const playerOptions = players.map(function(player){
    const teamLabel = player.teamAbbreviation || player.teamName || '';
    const label = teamLabel ? player.name + ' • ' + teamLabel : player.name;
    return { id: player.id, label: label };
  });
  const periods = [];
  if (timeline && Array.isArray(timeline.labels) && timeline.labels.length) {
    const maxPeriod = timeline.labels.reduce(function(max, label){
      const match = label.match(/^Q(\d+)/);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    for (var i = 1; i <= Math.max(4, maxPeriod); i++) {
      periods.push({ id: i, label: 'Period ' + i });
    }
  } else {
    for (var j = 1; j <= 4; j++) {
      periods.push({ id: j, label: 'Period ' + j });
    }
  }
  return {
    teams: teamOptions,
    players: playerOptions,
    periods: periods,
  };
}

function buildInsights_(teams, players) {
  const insights = [];
  if (teams.length >= 2) {
    const sortedNet = teams.slice().sort(function(a, b){
      const netA = a.metrics && typeof a.metrics.netRating === 'number' ? a.metrics.netRating : -Infinity;
      const netB = b.metrics && typeof b.metrics.netRating === 'number' ? b.metrics.netRating : -Infinity;
      return netB - netA;
    });
    if (sortedNet[0] && sortedNet[0].metrics && sortedNet[0].metrics.netRating != null) {
      const leader = sortedNet[0];
      insights.push(
        leader.name + ' posted a net rating of ' +
        formatNumber_(leader.metrics.netRating, 1) +
        ' (Off ' + formatNumber_(leader.metrics.offensiveRating, 1) +
        ', Def ' + formatNumber_(leader.metrics.defensiveRating, 1) + ').'
      );
    }
    const paceAvg = sortedNet.reduce(function(sum, team){
      return sum + (team.metrics && typeof team.metrics.pace === 'number' ? team.metrics.pace : 0);
    }, 0) / sortedNet.length;
    if (paceAvg) {
      insights.push('Game pace approx ' + formatNumber_(paceAvg, 1) + ' possessions.');
    }
  }

  const meaningfulPlayers = players
    .filter(function(player){
      return player.advanced && player.advanced.minutes >= 12 && player.advanced.usage != null && player.advanced.trueShooting != null;
    })
    .sort(function(a, b){ return (b.advanced.usage || 0) - (a.advanced.usage || 0); });
  if (meaningfulPlayers.length) {
    const top = meaningfulPlayers[0];
    insights.push(
      top.name + ' (' + top.teamAbbreviation + ') carried ' +
      formatNumber_(top.advanced.usage, 1) + '% usage with ' +
      formatNumber_(top.advanced.trueShooting * 100, 1) + '% TS.'
    );
  }

  return insights;
}

function normalizeTotals_(totals) {
  if (!totals || typeof totals !== 'object') return {};
  const map = {};
  map.fgm = Number(totals.fgm || totals.FGM || 0);
  map.fga = Number(totals.fga || totals.FGA || 0);
  map.tpm = Number(totals.tpm || totals.TPM || totals['3pm'] || totals['3PM'] || 0);
  map.tpa = Number(totals.tpa || totals.TPA || totals['3pa'] || totals['3PA'] || 0);
  map.ftm = Number(totals.ftm || totals.FTM || 0);
  map.fta = Number(totals.fta || totals.FTA || 0);
  map.oreb = Number(totals.oreb || totals.OREB || 0);
  map.dreb = Number(totals.dreb || totals.DREB || 0);
  map.reb = Number(totals.reb || totals.REB || map.oreb + map.dreb);
  map.ast = Number(totals.ast || totals.AST || 0);
  map.stl = Number(totals.stl || totals.STL || 0);
  map.blk = Number(totals.blk || totals.BLK || 0);
  map.to = Number(totals.to || totals.TO || totals.turnovers || totals.Turnovers || 0);
  map.pf = Number(totals.pf || totals.PF || totals.fouls || 0);
  map.pts = Number(totals.pts || totals.PTS || 0);
  map.minutes = parseMinutes_(totals.minutes || '');
  return map;
}

function normalizeTotalsFromTm_(entry) {
  if (!entry) return {};
  return {
    fgm: Number(entry.tot_sFieldGoalsMade || 0),
    fga: Number(entry.tot_sFieldGoalsAttempted || 0),
    tpm: Number(entry.tot_sThreePointersMade || 0),
    tpa: Number(entry.tot_sThreePointersAttempted || 0),
    ftm: Number(entry.tot_sFreeThrowsMade || 0),
    fta: Number(entry.tot_sFreeThrowsAttempted || 0),
    oreb: Number(entry.tot_sReboundsOffensive || 0),
    dreb: Number(entry.tot_sReboundsDefensive || 0),
    reb: Number(entry.tot_sReboundsTotal || 0),
    ast: Number(entry.tot_sAssists || 0),
    stl: Number(entry.tot_sSteals || 0),
    blk: Number(entry.tot_sBlocks || 0),
    to: Number(entry.tot_sTurnovers || 0),
    pf: Number(entry.tot_sFoulsPersonal || 0),
    pts: Number(entry.tot_sPoints || 0),
    minutes: parseMinutes_(entry.tot_sMinutes || ''),
  };
}

function convertTmPlayer_(teamId, teamName, teamAbbreviation, tmKey, playerKey, raw) {
  const jersey = String(raw?.shirtNumber || playerKey || '').trim();
  const baseId = teamId + ':' + (jersey || playerKey || ('p' + Math.random().toString(36).slice(2, 6)));
  const scoreboard = String(raw?.scoreboardName || '').trim();
  const displayName =
    scoreboard ||
    String(raw?.name || '').trim() ||
    [String(raw?.firstName || '').trim(), String(raw?.familyName || '').trim()].filter(Boolean).join(' ') ||
    baseId;

  const stats = {
    minutes: raw?.sMinutes || '',
    fgm: Number(raw?.sFieldGoalsMade || 0),
    fga: Number(raw?.sFieldGoalsAttempted || 0),
    tpm: Number(raw?.sThreePointersMade || 0),
    tpa: Number(raw?.sThreePointersAttempted || 0),
    ftm: Number(raw?.sFreeThrowsMade || 0),
    fta: Number(raw?.sFreeThrowsAttempted || 0),
    oreb: Number(raw?.sReboundsOffensive || 0),
    dreb: Number(raw?.sReboundsDefensive || 0),
    reb: Number(raw?.sReboundsTotal || 0),
    ast: Number(raw?.sAssists || 0),
    stl: Number(raw?.sSteals || 0),
    blk: Number(raw?.sBlocks || 0),
    to: Number(raw?.sTurnovers || 0),
    pf: Number(raw?.sFoulsPersonal || 0),
    pts: Number(raw?.sPoints || 0),
    plusminus: Number(raw?.sPlusMinusPoints || 0),
  };

  return {
    id: baseId,
    teamId: teamId,
    teamAbbreviation: teamAbbreviation,
    teamName: teamName,
    name: displayName,
    starter: Boolean(raw?.starter),
    shirtNumber: jersey,
    statistics: stats,
    aliases: [
      scoreboard,
      String(raw?.name || '').trim(),
      [String(raw?.firstName || '').trim(), String(raw?.familyName || '').trim()].filter(Boolean).join(' '),
      [String(raw?.internationalFirstName || '').trim(), String(raw?.internationalFamilyName || '').trim()].filter(Boolean).join(' '),
    ].filter(Boolean),
  };
}

function resolveTeamIdFromPlay_(play, teamIndex, tmLookup) {
  const directId = String(play?.teamId || play?.teamID || '').trim();
  if (directId && teamIndex[directId]) return directId;

  const teamText = String(play?.team || play?.Team || '').trim().toLowerCase();
  if (teamText && teamIndex[teamText]) {
    const match = teamIndex[teamText];
    return match.id || match;
  }

  const tno = String(play?.tno || play?.teamNumber || '').trim();
  if (tno && tmLookup[tno]) return tmLookup[tno].id;
  return null;
}

function classifyTwoPoint_(subType) {
  const paintKeywords = ['layup', 'dunk', 'hook', 'paint', 'tip', 'putback', 'finger', 'driving', 'alley', 'float', 'reverse'];
  for (var i = 0; i < paintKeywords.length; i++) {
    if (subType.indexOf(paintKeywords[i]) >= 0) return 'paint';
  }
  return 'mid';
}

function parseMinutes_(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const parts = String(value).split(':');
  if (!parts.length) return 0;
  const minutes = Number(parts[0]) || 0;
  const seconds = Number(parts[1]) || 0;
  return minutes + seconds / 60;
}

function computePossessions_(totals) {
  if (!totals) return 0;
  const fga = Number(totals.fga || 0);
  const oreb = Number(totals.oreb || 0);
  const to = Number(totals.to || 0);
  const fta = Number(totals.fta || 0);
  return fga - oreb + to + 0.44 * fta;
}

function parseClockToSeconds_(clock) {
  if (!clock) return 0;
  const parts = String(clock).split(':').map(function(part){ return Number(part) || 0; });
  if (parts.length === 3) {
    return parts[0] * 60 + parts[1] + parts[2] / 100;
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return Number(clock) || 0;
}

function formatClockLabel_(clock) {
  if (!clock) return '00:00';
  const parts = String(clock).split(':');
  if (parts.length >= 2) {
    return parts[0].padStart(2, '0') + ':' + parts[1].padStart(2, '0');
  }
  return clock;
}

function normalizeGameMeta_(game, teams, fallbackId) {
  const home = teams[0]?.name || '';
  const away = teams[1]?.name || '';
  const competitionName = game?.competition?.name || game?.competition?.code || '';
  return {
    id: game?.id || fallbackId,
    title: [home, away].filter(Boolean).join(' vs ') || (game?.id || fallbackId),
    status: game?.status || '',
    competition: competitionName,
    venue: game?.venue || '',
    date: game?.date || '',
    periods: Number(game?.periods || game?.Periods || 4) || 4,
  };
}

function buildActionLabel_(play) {
  const act = String(play?.actionType || '').replace(/_/g, ' ').trim();
  const sub = String(play?.subType || '').replace(/_/g, ' ').trim();
  if (act && sub) return act + ' · ' + sub;
  return act || sub || '';
}

function formatNumber_(value, digits) {
  if (value == null || isNaN(value)) return '—';
  return Number(value).toFixed(digits || 0);
}

function readGameRows_() {
  const sh = ensureGameSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, GAME_STATS_INPUT_HEADERS.length).getValues();
  return values
    .map(function(row){
      const gameId = String(row[0] || '').trim();
      if (!gameId) return null;
      return {
        gameId: gameId,
        org: String(row[1] || '').trim(),
        date: String(row[2] || '').trim(),
        opponent: String(row[3] || '').trim(),
        competition: String(row[4] || '').trim(),
      };
    })
    .filter(Boolean);
}

function ensureGameSheet_() {
  const ss = _open();
  let sh = ss.getSheetByName(GAME_STATS_INPUT_SHEET);
  if (!sh) sh = ss.insertSheet(GAME_STATS_INPUT_SHEET);
  const headers = sh.getRange(1, 1, 1, GAME_STATS_INPUT_HEADERS.length).getValues()[0];
  const needsHeaders = headers.every(function(cell){ return String(cell || '').trim() === ''; });
  if (needsHeaders) {
    sh.getRange(1, 1, 1, GAME_STATS_INPUT_HEADERS.length).setValues([GAME_STATS_INPUT_HEADERS]);
  }
  return sh;
}
