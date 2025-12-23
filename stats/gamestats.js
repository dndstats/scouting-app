const GAME_STATS_INPUT_SHEET = 'shotmap';
const GAME_STATS_INPUT_HEADERS = ['gameId', 'org', 'date', 'opponent', 'competition'];
const GAME_STATS_CACHE_SECONDS = 300;
const GAME_STATS_SUMMARY_ID = '__ALL__';
const GAME_STATS_SUMMARY_LABEL = 'All Games — Peristeri BC vs Opponents';
const GAME_STATS_DEFAULT_TEAM_NAME = 'Peristeri BC';
const GAME_STATS_DEFAULT_TEAM_ABBR = 'PER';

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
    const options = games.map(function(item){ return { gameId: item.gameId, label: item.label }; });
    options.unshift({ gameId: GAME_STATS_SUMMARY_ID, label: GAME_STATS_SUMMARY_LABEL });
    return {
      ok: true,
      games: options,
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
    if (gameId === GAME_STATS_SUMMARY_ID) {
      return buildGameStatsSummary_(query);
    }

    // Extract org from query or look it up from game metadata
    const org = String(query && query.org || '').trim();
    
    const cacheKey = 'gamestats:' + gameId;
    let raw = _cacheGetJSON_ && _cacheGetJSON_(cacheKey);
    if (!raw) {
      raw = fetchGameStatsData_(gameId, org);
      if (_cachePutJSON_) _cachePutJSON_(cacheKey, raw, GAME_STATS_CACHE_SECONDS);
    }

    return buildGameStatsPayload_(raw || {}, query || {}, gameId);
  } catch (err) {
    console.error('getGameStats error:', err);
    return { ok: false, error: String(err) };
  }
}

function fetchGameStatsData_(gameId, org) {
  const cleanId = String(gameId || '').trim();
  if (!cleanId) throw new Error('Missing gameId');
  
  // Try smart endpoint discovery with multiple candidates
  try {
    return fetchGameStatsDataSmart_(cleanId, org);
  } catch (err) {
    // Fall back to original single endpoint approach
    const url = 'https://fibalivestats.dcd.shared.geniussports.com/data/' + encodeURIComponent(cleanId) + '/data.json';
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Error('Request failed (' + code + '): ' + url + ' | Original error: ' + err);
    }
    const text = resp.getContentText();
    return text ? JSON.parse(text) : {};
  }
}

function fetchGameStatsDataSmart_(gameId, org) {
  const urls = generateCandidateUrls(gameId, org);
  const successes = [];
  let lastErr;

  function rank(url) {
    if (/\/data\.json$/i.test(url)) return 1;
    if (/\/(pbp|playbyplay)\.json$/i.test(url)) return 2;
    if (/\/game\.json$/i.test(url)) return 3;
    if (/\/shots\.json$/i.test(url)) return 4;
    return 10;
  }

  for (const url of urls) {
    try {
      const res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: { 'Accept': 'application/json,text/html,*/*' }
      });
      const code = res.getResponseCode();
      const body = res.getContentText();

      if (code >= 200 && code < 300 && startsLikeJson(body)) {
        successes.push({ url: url, jsonText: body });
        continue;
      }

      const ct = String(res.getHeaders()['Content-Type'] || '').toLowerCase();
      if (code >= 200 && code < 300 && (ct.includes('text/html') || body.startsWith('<'))) {
        const discovered = discoverJsonFromHtml(body);
        for (const ju of discovered) {
          try {
            const jr = UrlFetchApp.fetch(ju, { muteHttpExceptions:true, followRedirects:true, headers:{'Accept':'application/json,*/*'} });
            const jcode = jr.getResponseCode();
            const jtxt = jr.getContentText();
            if (jcode >= 200 && jcode < 300 && startsLikeJson(jtxt)) successes.push({ url: ju, jsonText: jtxt });
          } catch (inner) { lastErr = inner; }
        }
        
        // NEW: Try to extract JSON data from embedded script tags (common in FIBA pages)
        try {
          // Look for JSON data in script tags: <script type="application/json">...</script>
          const scriptMatches = body.match(/<script[^>]*type=["']application\/json["'][^>]*>(.*?)<\/script>/gis);
          if (scriptMatches && scriptMatches.length > 0) {
            for (let i = 0; i < scriptMatches.length; i++) {
              const jsonMatch = scriptMatches[i].match(/>([^<]+)</);
              if (jsonMatch && jsonMatch[1]) {
                const jsonStr = jsonMatch[1].trim();
                if (startsLikeJson(jsonStr)) {
                  Logger.log('Found embedded JSON in script tag');
                  successes.push({ url: url + ' (embedded)', jsonText: jsonStr });
                }
              }
            }
          }
        } catch (e) {
          Logger.log('Error parsing embedded JSON: ' + e);
        }
      }
    } catch (e) { lastErr = e; }
  }

  if (successes.length) {
    successes.sort((a,b)=> rank(a.url) - rank(b.url));
    const best = successes[0];
    Logger.log('Using endpoint: ' + best.url);
    return JSON.parse(best.jsonText);
  }

  throw lastErr || new Error('No JSON endpoint found for gameId: ' + gameId);
}

function generateCandidateUrls(gameId, org) {
  const urls = [];
  
  // NEW: FIBA Europe Cup support (fiba.basketball domain)
  // Try FIBA-specific endpoints first if org contains 'EUROPE' or 'FIBACUP' or similar
  if (org && typeof org === 'string' && /EUROPE|FIBACUP|FIBA/i.test(org)) {
    urls.push(
      'https://www.fiba.basketball/data/games/' + gameId + '.json',
      'https://www.fiba.basketball/api/game/' + gameId + '/shots.json',
      'https://www.fiba.basketball/api/game/' + gameId + '/data.json',
      'https://live.fiba.com/api/game/' + gameId + '/shots.json',
      'https://live.fiba.com/api/game/' + gameId + '/data.json'
    );
  }
  
  // Try org-based variants if org is provided
  if (org) {
    const orgVariants = [org, org.toUpperCase(), org.toLowerCase()];
    for (const o of orgVariants) {
      const base = 'https://fibalivestats.dcd.shared.geniussports.com/u/' + encodeURIComponent(o) + '/' + encodeURIComponent(gameId);
      urls.push(
        base + '/data.json',
        base + '/shots.json',
        base + '/pbp.json',
        base + '/playbyplay.json',
        base + '/game.json'
      );
    }
  }

  // Org-less family (prefer data.json, then others)
  const base2 = 'https://fibalivestats.dcd.shared.geniussports.com/data/' + encodeURIComponent(gameId);
  urls.push(
    base2 + '/data.json',
    base2 + '/shots.json',
    base2 + '/pbp.json',
    base2 + '/playbyplay.json',
    base2 + '/game.json'
  );

  return urls;
}

function startsLikeJson(s) {
  const t = String(s || '').trim();
  return t.startsWith('{') || t.startsWith('[');
}

function discoverJsonFromHtml(html) {
  const out = new Set();
  
  // Genius Sports patterns (existing)
  const m1 = html.match(/\/u\/[A-Za-z0-9_-]+\/\d+\/(?:data|pbp|playbyplay|game|shots)\.json/gi) || [];
  m1.forEach(rel => out.add('https://fibalivestats.dcd.shared.geniussports.com' + rel));
  const m2 = html.match(/\/data\/\d+\/(?:data|pbp|playbyplay|game|shots)\.json/gi) || [];
  m2.forEach(rel => out.add('https://fibalivestats.dcd.shared.geniussports.com' + rel));
  
  // FIBA Europe Cup patterns (NEW)
  const m3 = html.match(/\/api\/game\/\d+\/(?:shots|data)\.json/gi) || [];
  m3.forEach(function(rel) { 
    if (rel.startsWith('/')) {
      out.add('https://www.fiba.basketball' + rel);
    }
  });
  const m4 = html.match(/\/data\/games\/\d+\.json/gi) || [];
  m4.forEach(function(rel) {
    if (rel.startsWith('/')) {
      out.add('https://www.fiba.basketball' + rel);
    }
  });
  
  return Array.from(out);
}

function buildGameStatsPayload_(data, query, gameId) {
  const teams = [];
  const tmLookup = {};

  const structuredTeams = [].concat((data && data.teams) || (data && data.Teams) || []);
  if (structuredTeams.length) {
    structuredTeams.forEach(function(team) {
      const id = String((team && (team.id || team.teamId || team.TeamID || team.TeamId || team.code)) || '').trim();
      const name = String((team && (team.name || team.Name)) || '').trim() || id;
      const abbreviation = String((team && (team.abbreviation || team.Abbreviation || team.shortName || team.ShortName || id)) || '').trim() || id;
      const totals = normalizeTotals_((team && (team.totals || team.Totals)) || {});
      const playersRaw = [].concat((team && (team.players || team.Players)) || []);
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

  const pbpRaw = Array.isArray(data && data.pbp) ? data.pbp.slice() : Array.isArray(data && data.plays) ? data.plays.slice() : [];

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
    game: normalizeGameMeta_((data && (data.game || data.Game)) || {}, metrics.teams, gameId),
    filters: filters,
    teams: metrics.teams,
    players: filteredPlayers,
    allPlayers: playersWithAdvanced,
    timeline: metrics.timeline,
    insights: buildInsights_(metrics.teams, playersWithAdvanced),
  };
}

function computeTeamMetrics_(teams, rawPlays, tmLookup, data) {
  const periodLengthMinutes = Number((data && (data.periodLength || data.periodLengthREGULAR)) || 10) || 10;
  const periodLengthSeconds = periodLengthMinutes * 60;
  const overtimeLengthSeconds = Number((data && data.periodLengthOVERTIME) || 5) * 60 || 300;

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
    return Number((a && a.actionNumber) || 0) - Number((b && b.actionNumber) || 0);
  });

  sortedPlays.forEach(function(play){
    const teamId = resolveTeamIdFromPlay_(play, teamIndex, tmLookup);
    if (!teamId || !shotAttempts[teamId]) return;
    const action = String((play && (play.actionType || play.ActionType)) || '').toLowerCase();
    const subtype = String((play && (play.subType || play.SubType)) || '').toLowerCase();
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
    const oppPts = opp && opp.totals ? opp.totals.pts : 0;
    const defensiveRating = oppPoss ? (oppPts || 0) / oppPoss * 100 : null;
    const netRating = (offensiveRating != null && defensiveRating != null) ? offensiveRating - defensiveRating : null;
    const efg = totals.fga ? (totals.fgm + 0.5 * (totals.tpm || 0)) / totals.fga : null;
    const tov = poss ? (totals.to || 0) / poss : null;
    const oppDreb = opp && opp.totals ? opp.totals.dreb : 0;
    const orbDen = (totals.oreb + (oppDreb || 0));
    const orb = orbDen ? (totals.oreb || 0) / orbDen : null;
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
      shotAttempts: {
        paint: shots.paint,
        mid: shots.mid,
        three: shots.three,
        ft: shots.ft,
        totalFloor: totalFloorAttempts,
        total: totalAttempts,
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

function buildGameStatsSummary_(query) {
  const rows = readGameRows_();
  if (!rows.length) return { ok: false, error: 'No games available to summarise.' };
  const orgName = determinePrimaryOrg_(rows) || 'Peristeri BC';
  const primaryName = orgName || GAME_STATS_DEFAULT_TEAM_NAME;
  const summary = {
    orgName: primaryName,
    our: initAggregateTeam_('peristeri', primaryName, GAME_STATS_DEFAULT_TEAM_ABBR),
    opp: initAggregateTeam_('opponents', 'Opponents', 'OPP'),
    games: [],
    players: {
      peristeri: Object.create(null),
      opponents: Object.create(null),
    },
  };

  rows.forEach(function(row, index){
    try {
      const raw = fetchGameStatsDataCached_(row.gameId, row.org);
      const payload = buildGameStatsPayload_(raw || {}, {}, row.gameId);
      const ourTeam = identifySummaryTeam_(payload.teams || [], row.org, summary.orgName);
      const oppTeam = (payload.teams || []).find(function(team){ return team && team !== ourTeam; }) || (payload.teams && payload.teams[0]) || null;
      if (!ourTeam || !oppTeam) return;

      accumulateAggregateTeam_(summary.our, ourTeam, oppTeam);
      accumulateAggregateTeam_(summary.opp, oppTeam, ourTeam);
      if (ourTeam.name) {
        summary.our.name = ourTeam.name;
        summary.orgName = ourTeam.name;
      }
      if (ourTeam.abbreviation) {
        summary.our.abbreviation = ourTeam.abbreviation;
      }

      summary.games.push({
        label: buildSummaryTimelineLabel_(row, oppTeam, index),
        ourPts: Number(ourTeam.totals?.pts || 0),
        oppPts: Number(oppTeam.totals?.pts || 0),
      });

      (payload.allPlayers || []).forEach(function(player){
        if (isPlayerOnTeam_(player, ourTeam)) {
          accumulateSummaryPlayer_(summary.players.peristeri, player, summary.our);
        } else {
          accumulateSummaryPlayer_(summary.players.opponents, player, summary.opp);
        }
      });
    } catch (err) {
      console.error('Summary aggregation failed for game', row.gameId, err);
    }
  });

  if (!summary.games.length || !summary.our.games) {
    return { ok: false, error: 'Unable to compile season summary.' };
  }

  const aggregatedTeams = finalizeAggregateTeams_(summary);
  const timeline = buildSummaryTimeline_(summary, aggregatedTeams);
  const players = finalizeAggregatePlayers_(summary, aggregatedTeams);
  const filters = buildFiltersPayload_(aggregatedTeams, players, timeline);
  const insights = buildInsights_(aggregatedTeams, players);
  const ourDisplayName = aggregatedTeams[0]?.name || summary.orgName || GAME_STATS_DEFAULT_TEAM_NAME;
  const oppDisplayName = aggregatedTeams[1]?.name || 'Opponents';

  return {
    ok: true,
    game: {
      id: GAME_STATS_SUMMARY_ID,
      title: ourDisplayName + ' vs ' + oppDisplayName + ' — All Games',
      status: 'SUMMARY',
      competition: '',
      venue: '',
      date: '',
      periods: 4,
    },
    filters: filters,
    teams: aggregatedTeams,
    players: players,
    allPlayers: players,
    timeline: timeline,
    insights: insights,
  };
}

function fetchGameStatsDataCached_(gameId, org) {
  const cacheKey = 'gamestats:' + gameId;
  let raw = _cacheGetJSON_ && _cacheGetJSON_(cacheKey);
  if (!raw) {
    raw = fetchGameStatsData_(gameId, org);
    if (_cachePutJSON_) _cachePutJSON_(cacheKey, raw, GAME_STATS_CACHE_SECONDS);
  }
  return raw || {};
}

function determinePrimaryOrg_(rows) {
  let fallback = '';
  for (var i = 0; i < rows.length; i++) {
    const org = String(rows[i].org || '').trim();
    if (!org) continue;
    if (!fallback) fallback = org;
    if (org.toLowerCase().indexOf('peristeri') >= 0) return org;
  }
  return fallback || GAME_STATS_DEFAULT_TEAM_NAME;
}

function identifySummaryTeam_(teams, orgName, fallbackName) {
  if (!teams || !teams.length) return null;
  const target = String(orgName || '').trim().toLowerCase();
  const fallback = String(fallbackName || '').trim().toLowerCase();
  let match = null;
  teams.forEach(function(team){
    if (match) return;
    const name = String(team?.name || '').trim().toLowerCase();
    const abbr = String(team?.abbreviation || '').trim().toLowerCase();
    if (target && (name === target || abbr === target || name.indexOf(target) >= 0 || abbr.indexOf(target) >= 0)) {
      match = team;
      return;
    }
    if (!match && fallback && (name.indexOf(fallback) >= 0 || abbr.indexOf(fallback) >= 0)) {
      match = team;
      return;
    }
    if (!match && (name.indexOf('peristeri') >= 0 || abbr.indexOf('per') >= 0)) {
      match = team;
    }
  });
  return match || teams[0];
}

function initAggregateTeam_(id, name, abbreviation) {
  return {
    id: id,
    name: name,
    abbreviation: abbreviation,
    games: 0,
    totals: Object.create(null),
    shotAttempts: { paint: 0, mid: 0, three: 0, ft: 0, totalFloor: 0, total: 0 },
    minutes: 0,
    sumPossessions: 0,
    sumOpponentPossessions: 0,
    sourceTeamIds: Object.create(null),
  };
}

function accumulateAggregateTeam_(aggregate, team, opponent) {
  if (!aggregate || !team) return;
  aggregate.games += 1;
  if (team.id) aggregate.sourceTeamIds[String(team.id)] = true;
  aggregate.minutes += Number(team.minutes || 0) || 0;

  const totals = team.totals || {};
  Object.keys(totals).forEach(function(key){
    const val = Number(totals[key]);
    if (!isNaN(val)) {
      aggregate.totals[key] = (aggregate.totals[key] || 0) + val;
    }
  });

  const shots = team.metrics?.shotAttempts || {};
  ['paint', 'mid', 'three', 'ft', 'totalFloor', 'total'].forEach(function(key){
    const val = Number(shots[key] || 0);
    if (!isNaN(val)) {
      aggregate.shotAttempts[key] = (aggregate.shotAttempts[key] || 0) + val;
    }
  });

  const poss = Number(team.metrics?.possessions);
  if (!isNaN(poss)) {
    aggregate.sumPossessions += poss;
  } else {
    aggregate.sumPossessions += computePossessions_(totals);
  }

  const oppPossMetric = Number(team.metrics?.opponentPossessions);
  if (!isNaN(oppPossMetric)) {
    aggregate.sumOpponentPossessions += oppPossMetric;
  } else if (opponent && opponent.totals) {
    aggregate.sumOpponentPossessions += computePossessions_(opponent.totals);
  } else {
    aggregate.sumOpponentPossessions += computePossessions_(totals);
  }
}

function buildSummaryTimelineLabel_(row, opponentTeam, index) {
  const parts = [];
  const date = String(row?.date || '').trim();
  if (date) parts.push(date);
  const oppName = String(row?.opponent || opponentTeam?.name || opponentTeam?.abbreviation || '').trim();
  if (oppName) parts.push('vs ' + oppName);
  if (!parts.length) return 'Game ' + (index + 1);
  return parts.join(' ');
}

function buildSummaryTimeline_(summary, aggregatedTeams) {
  const labels = summary.games.map(function(game){ return game.label; });
  const ourTeam = aggregatedTeams[0] || { id: 'peristeri', name: summary.orgName };
  const oppTeam = aggregatedTeams[1] || { id: 'opponents', name: 'Opponents' };
  const ourScores = summary.games.map(function(game){ return game.ourPts; });
  const oppScores = summary.games.map(function(game){ return game.oppPts; });
  return {
    labels: labels,
    series: [
      { teamId: ourTeam.id, name: ourTeam.name, scores: ourScores },
      { teamId: oppTeam.id, name: oppTeam.name, scores: oppScores },
    ],
  };
}

function accumulateSummaryPlayer_(bucket, player, aggregateTeam) {
  if (!player || !aggregateTeam) return;
  const stats = player.statistics || {};
  const key = (player.id || player.name || Math.random().toString(36).slice(2)) + '|' + aggregateTeam.id;
  if (!bucket[key]) {
    bucket[key] = {
      id: player.id || key,
      name: player.name || 'Player',
      teamId: aggregateTeam.id,
      teamName: aggregateTeam.name,
      teamAbbreviation: aggregateTeam.abbreviation,
      stats: createEmptyStatLine_(),
      games: 0,
    };
  }
  const entry = bucket[key];
  entry.games += 1;
  entry.stats.minutes += parseMinutes_(stats.minutes || 0);
  ['fgm','fga','tpm','tpa','ftm','fta','oreb','dreb','reb','ast','stl','blk','to','pf','pts','plusminus'].forEach(function(k){
    const val = Number(stats[k] || 0);
    if (!isNaN(val)) entry.stats[k] += val;
  });
}

function finalizeAggregateTeams_(summary) {
  const ourTeam = buildAggregateTeamObject_(summary.our, summary.opp);
  const oppTeam = buildAggregateTeamObject_(summary.opp, summary.our);
  return [ourTeam, oppTeam];
}

function buildAggregateTeamObject_(aggregate, opponentAggregate) {
  const games = Math.max(aggregate.games, 1);
  const totals = Object.assign({}, aggregate.totals);
  const oppTotals = opponentAggregate ? opponentAggregate.totals : {};
  const totalPoss = aggregate.sumPossessions;
  const oppPoss = aggregate.sumOpponentPossessions;
  const pace = games ? (aggregate.sumPossessions + aggregate.sumOpponentPossessions) / (2 * games) : null;
  const offensiveRating = totalPoss ? (Number(totals.pts || 0) / totalPoss) * 100 : null;
  const defensiveRating = oppPoss ? (Number(oppTotals?.pts || 0) / oppPoss) * 100 : null;
  const netRating = (offensiveRating != null && defensiveRating != null) ? offensiveRating - defensiveRating : null;
  const efg = totals.fga ? (Number(totals.fgm || 0) + 0.5 * Number(totals.tpm || 0)) / Number(totals.fga || 1) : null;
  const tov = totalPoss ? Number(totals.to || 0) / totalPoss : null;
  const orbDen = Number(totals.oreb || 0) + Number(oppTotals?.dreb || 0);
  const orb = orbDen ? Number(totals.oreb || 0) / orbDen : null;
  const ftr = totals.fga ? Number(totals.fta || 0) / Number(totals.fga || 1) : null;
  const shots = aggregate.shotAttempts || {};
  const totalAttempts = shots.total || (shots.paint + shots.mid + shots.three + shots.ft);
  const shotProfile = totalAttempts ? {
    paint: shots.paint / totalAttempts,
    mid: shots.mid / totalAttempts,
    three: shots.three / totalAttempts,
    ft: shots.ft / totalAttempts,
  } : {
    paint: null,
    mid: null,
    three: null,
    ft: null,
  };
  return {
    id: aggregate.id,
    name: aggregate.name,
    abbreviation: aggregate.abbreviation,
    totals: totals,
    metrics: {
      possessions: totalPoss,
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
      shotAttempts: shots,
      shotProfile: shotProfile,
    },
    minutes: aggregate.minutes,
    summary: {
      games: aggregate.games,
      sourceTeamIds: Object.keys(aggregate.sourceTeamIds),
    },
  };
}

function finalizeAggregatePlayers_(summary, aggregatedTeams) {
  const teamLookup = {};
  aggregatedTeams.forEach(function(team){ teamLookup[team.id] = team; });
  const players = [];

  Object.keys(summary.players).forEach(function(bucketKey){
    const bucket = summary.players[bucketKey];
    Object.keys(bucket).forEach(function(playerKey){
      const entry = bucket[playerKey];
      const team = teamLookup[entry.teamId] || aggregatedTeams[0];
      const stats = entry.stats;
      const usage = computeSummaryUsage_(stats, team);
      const trueShooting = computeSummaryTrueShooting_(stats);
      players.push({
        id: entry.id,
        name: entry.name,
        teamId: entry.teamId,
        teamName: entry.teamName,
        teamAbbreviation: entry.teamAbbreviation,
        statistics: {
          minutes: formatMinutesString_(stats.minutes),
          fgm: stats.fgm,
          fga: stats.fga,
          tpm: stats.tpm,
          tpa: stats.tpa,
          ftm: stats.ftm,
          fta: stats.fta,
          oreb: stats.oreb,
          dreb: stats.dreb,
          reb: stats.reb,
          ast: stats.ast,
          stl: stats.stl,
          blk: stats.blk,
          to: stats.to,
          pf: stats.pf,
          pts: stats.pts,
          plusminus: stats.plusminus,
        },
        advanced: {
          minutes: stats.minutes,
          usage: usage,
          trueShooting: trueShooting,
        },
      });
    });
  });

  players.sort(function(a, b){
    return (b.advanced.minutes || 0) - (a.advanced.minutes || 0);
  });
  return players;
}

function createEmptyStatLine_() {
  return {
    minutes: 0,
    fgm: 0,
    fga: 0,
    tpm: 0,
    tpa: 0,
    ftm: 0,
    fta: 0,
    oreb: 0,
    dreb: 0,
    reb: 0,
    ast: 0,
    stl: 0,
    blk: 0,
    to: 0,
    pf: 0,
    pts: 0,
    plusminus: 0,
  };
}

function isPlayerOnTeam_(player, team) {
  if (!player || !team) return false;
  const playerTeamId = String(player.teamId || '').trim();
  const teamId = String(team.id || '').trim();
  if (playerTeamId && teamId && playerTeamId === teamId) return true;
  const lower = function(str){ return String(str || '').trim().toLowerCase(); };
  const playerName = lower(player.teamName);
  const playerAbbr = lower(player.teamAbbreviation);
  const teamName = lower(team.name);
  const teamAbbr = lower(team.abbreviation);
  if (teamName && playerName === teamName) return true;
  if (teamAbbr && playerAbbr === teamAbbr) return true;
  if (teamName && playerName.indexOf(teamName) >= 0) return true;
  if (teamAbbr && playerAbbr.indexOf(teamAbbr) >= 0) return true;
  if (teamName && (playerName.indexOf('peristeri') >= 0 || playerAbbr.indexOf('per') >= 0)) return true;
  return false;
}

function computeSummaryUsage_(stats, team) {
  if (!stats || !team) return null;
  const playerMinutes = stats.minutes || 0;
  const teamMinutes = team.minutes || (team.summary?.games ? team.summary.games * 200 : 0);
  const teamTotals = team.totals || {};
  const usageDenominator = Number(teamTotals.fga || 0) + 0.44 * Number(teamTotals.fta || 0) + Number(teamTotals.to || 0);
  const usageNumerator = Number(stats.fga || 0) + 0.44 * Number(stats.fta || 0) + Number(stats.to || 0);
  if (!playerMinutes || !teamMinutes || !usageDenominator) return null;
  return 100 * usageNumerator * (teamMinutes / 5) / (playerMinutes * usageDenominator);
}

function computeSummaryTrueShooting_(stats) {
  if (!stats) return null;
  const denom = Number(stats.fga || 0) + 0.44 * Number(stats.fta || 0);
  if (!denom) return null;
  return Number(stats.pts || 0) / (2 * denom);
}

function formatMinutesString_(minutes) {
  if (!minutes) return '0:00';
  const totalSeconds = Math.round(Number(minutes || 0) * 60);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return mins + ':' + String(secs).padStart(2, '0');
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

/* ===================== Shot & Assist Extraction Functions ===================== */

/**
 * Extract shot locations and assists from FIBALivestats data structure
 * Returns array of shot objects with location, assist data
 */
function extractShotsFromData_(data) {
  const shots = [];
  
  if (!data || typeof data !== 'object') return shots;
  
  // Try Genius Sports tm structure
  if (data.tm && (data.tm['1'] || data.tm['2'])) {
    ['1', '2'].forEach(function(key){
      const team = data.tm[key];
      if (!team) return;
      
      // Get shots array - try various field names
      const teamShots = team.shot || team.shots || team.sh || team.Shot || team.SHOTS || [];
      if (!Array.isArray(teamShots)) return;
      
      teamShots.forEach(function(shot){
        if (!shot || typeof shot !== 'object') return;
        
        const x = Number(shot.x || shot.cx || shot.posX || shot.coordX || 0);
        const y = Number(shot.y || shot.cy || shot.posY || shot.coordY || 0);
        
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        
        const period = Number(shot.period || shot.per || shot.Period || 0);
        const clock = String(shot.clock || shot.gameClock || shot.time || shot.t || '');
        const made = normalizeMadeFromShot(shot);
        const type = determineShotType(shot);
        const playerId = String(shot.playerId || shot.pno || shot.pid || shot.player_id || '');
        const player = String(shot.player || shot.playerName || shot.name || '');
        
        // Assist information
        const assistData = extractAssistInfo(shot);
        
        shots.push({
          x: x,
          y: y,
          period: period,
          clock: clock,
          made: made,
          type: type,
          playerId: playerId,
          player: player,
          assist: assistData.assist,
          assistBy: assistData.assistBy,
          assistPlayerId: assistData.assistPlayerId
        });
      });
    });
  }
  
  // Try flat array structure
  if (Array.isArray(data.shots)) {
    data.shots.forEach(function(shot){
      if (!shot || typeof shot !== 'object') return;
      
      const x = Number(shot.x || 0);
      const y = Number(shot.y || 0);
      
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      
      const period = Number(shot.period || 0);
      const clock = String(shot.clock || '');
      const made = normalizeMadeFromShot(shot);
      const type = determineShotType(shot);
      const playerId = String(shot.playerId || '');
      const player = String(shot.player || shot.playerName || '');
      const assistData = extractAssistInfo(shot);
      
      shots.push({
        x: x,
        y: y,
        period: period,
        clock: clock,
        made: made,
        type: type,
        playerId: playerId,
        player: player,
        assist: assistData.assist,
        assistBy: assistData.assistBy,
        assistPlayerId: assistData.assistPlayerId
      });
    });
  }
  
  return shots;
}

/**
 * Extract assist information from shot object
 */
function extractAssistInfo(shot) {
  if (!shot || typeof shot !== 'object') return { assist: 0, assistBy: '', assistPlayerId: '' };
  
  const assistPlayerId = String(shot.assistPlayerId || shot.assistId || shot.assist_player_id || shot.passerId || '');
  const assistBy = String(shot.assistPlayer || shot.assistName || shot.assist_name || shot.passer || '');
  const hasAssist = !!(shot.assist || shot.assisted || shot.ast || assistPlayerId || assistBy);
  
  return {
    assist: hasAssist ? 1 : 0,
    assistBy: assistBy,
    assistPlayerId: assistPlayerId
  };
}

/**
 * Normalize made/miss status from shot object
 */
function normalizeMadeFromShot(shot) {
  if (!shot || typeof shot !== 'object') return 0;
  
  // Try various fields that indicate made status
  const made = shot.made || shot.isMade || shot.success || shot.isSuccess || shot.result;
  if (made === 1 || made === true) return 1;
  if (made === 0 || made === false) return 0;
  
  const str = String(shot.type || shot.actionType || shot.eventType || '').toLowerCase();
  if (/made|success|good|hit|scores/i.test(str)) return 1;
  if (/miss|failed|no/i.test(str)) return 0;
  
  return 0;
}

/**
 * Determine shot type (2pt or 3pt) from shot object
 */
function determineShotType(shot) {
  if (!shot || typeof shot !== 'object') return '2pt';
  
  const actionType = String(shot.actionType || shot.type || shot.eventType || '').toLowerCase();
  const points = Number(shot.points || shot.pt || shot.value || shot.shotValue || 0);
  
  if (points === 3) return '3pt';
  if (points === 2) return '2pt';
  if (/3pt|three|triple|3-?pointer/i.test(actionType)) return '3pt';
  if (/2pt|two/i.test(actionType)) return '2pt';
  
  return '2pt';
}

/**
 * Get shots data for a specific game
 */
function getShotsData(gameId, org) {
  try {
    const raw = fetchGameStatsData_(gameId, org);
    const shots = extractShotsFromData_(raw);
    return {
      ok: true,
      shots: shots,
      count: shots.length,
      made: shots.filter(function(s) { return s.made === 1; }).length,
      attempted: shots.length
    };
  } catch (err) {
    console.error('getShotsData error:', err);
    return { ok: false, error: String(err), shots: [] };
  }
}
