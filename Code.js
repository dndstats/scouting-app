

/*** ====== CONFIG ====== ***/
const SHEET_ID = '1N3tuxzNjrCcFur5s3fmIds2NL1gQsW3bVhcOD_lVJGA';

// Tab names
const TAB_CLIPS       = 'Clip_Library';
const TAB_PLAYERS     = 'Player_Notes';
const TAB_TEAM_TRENDS = 'Team_Trends';
const TAB_PICS        = 'pics';
const TAB_EMAILS      = 'Emails';  // 👈 make sure this EXACTLY matches your tab name
const TAB_SUMMARIES = 'Summaries';
const TAB_INDICES = 'Sheet38';   // <-- exact tab name with your indices (A:I)

// Notifications
const NOTE_ALERT_EMAIL = 'satkiew@gmail.com';
const NOTE_ALERT_SKIP_COACHES = ['dimitris']; // lower-case comparison

// Helper to open your file by ID (always the same file)
function _open() {
  return SpreadsheetApp.openById(SHEET_ID);
}
function _sheet(name) {
  const sh = _open().getSheetByName(name);
  if (!sh) throw new Error(`Sheet not found: ${name}`);
  return sh;
}

// === Strength / Practice data lives in a DIFFERENT spreadsheet ===
// Paste the ID from its URL (the long string between /d/ and /edit)
const PRACTICE_DOC_ID     = '1iluzzbhkoJ612JxE4YNTS2fDGumaGIbVEXVA_54Tfy8';
const PRACTICE_SHEET_NAME = 'PracticeData'; // the tab with your columns

/*** ====== WEB APP ENTRY ====== ***/
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('Practice loop');
}


function _openPractice_() {
  const file = SpreadsheetApp.openById(PRACTICE_DOC_ID);
  const sh   = file.getSheetByName(PRACTICE_SHEET_NAME);
  if (!sh) throw new Error(`Sheet "${PRACTICE_SHEET_NAME}" not found in practice doc`);
  return sh;
}

/*** ====== Cache helpers ====== ***/
function _cacheGet_(key) {
  try {
    const cache = CacheService.getScriptCache();
    return cache ? cache.get(key) : null;
  } catch (err) {
    return null;
  }
}
function _cachePut_(key, value, seconds) {
  try {
    const cache = CacheService.getScriptCache();
    if (cache) cache.put(key, value, seconds);
  } catch (err) {
    // ignore cache errors
  }
}
function _cacheGetJSON_(key) {
  const raw = _cacheGet_(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}
function _cachePutJSON_(key, obj, seconds) {
  try {
    _cachePut_(key, JSON.stringify(obj), seconds);
  } catch (err) {
    // ignore cache errors
  }
}


function getPlayerDetail(name) {
  return apiGetPlayerDetail(name);
}





function _toNum_(x) {
  // turn "▼ -4.40", " -4,40 ", etc. into a number
  const s = String(x || '').replace(/[^\d.,\-]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}






/** ------- Simple password → name map (server-side) ------- **/
const PASSWORD_USERS = {
  'peristeri':  'Visitor',
  '12': 'Dimitris',
  'peristeri2': 'Vasillis',
  'peristeri3': 'Stefanos',
  'peristeri4': 'Konstantinos',
  'peristeri5': 'Xristoforos',
};

/** Validate password and return resolved name (do not expose map to client) */
function validatePassword(pw) {
  try {
    const key = String(pw || '').trim();
    const name = PASSWORD_USERS[key];
    if (!name) return { ok:false, error:'Wrong password.' };
    return { ok:true, name };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}



/************** TZ + date helpers (REPLACE) **************/
function _plTZ_() {
  // use the practice sheet’s own timezone if available
  try {
    return SpreadsheetApp.openById(PRACTICE_DOC_ID).getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  } catch (_) {
    return Session.getScriptTimeZone();
  }
}
function _fmtISO_(d) { // yyyy-MM-dd in local (sheet) TZ
  return Utilities.formatDate(d, _plTZ_(), 'yyyy-MM-dd');
}
function _parseDMYorISO_(v) {
  if (v instanceof Date && !isNaN(v)) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const s = String(v||'').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);       // ISO
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);     // dd/MM/yyyy
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  const dt = new Date(s);
  return isNaN(dt) ? null : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}
function _addDays_(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

/************** Build daily loads (REPLACE) **************/
// Sum minutes*RPE for all rows on the same calendar day
function _buildDailyMap_() {
  const sh   = SpreadsheetApp.openById(PRACTICE_DOC_ID).getSheetByName(PRACTICE_SHEET_NAME);
  if (!sh) return {};
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return {};

  const H = vals[0].map(String);
  const cDate      = H.indexOf('Date');
  const cMinutes   = H.indexOf('Practice Minutes');
  const cIntensity = H.indexOf('Physical Intensity');

  const map = {}; // iso -> SUM(loads)
  for (let i=1;i<vals.length;i++){
    const r = vals[i];
    const d = _parseDMYorISO_(r[cDate]);
    if (!d) continue;
    const iso = _fmtISO_(d);
    const load = _sessionLoadForRow_(r[cMinutes], r[cIntensity]);
    if (load > 0) {
      map[iso] = (map[iso] || 0) + load;  // <-- SUM (not max)
    }
  }
  return map;
}

/************** Trend + ACWR + Monotony/Strain (REPLACE) **************/
function _trend14_(dailyMap, isoEnd) {
  const end = _parseDMYorISO_(isoEnd);
  const labels = [], values = [];
  for (let i = 13; i >= 0; i--) {
    const d = _addDays_(end, -i);
    const k = _fmtISO_(d);
    labels.push(k);
    values.push(Number(dailyMap[k] || 0));
  }
  return { labels, values };
}

function _acwr_(dailyMap, isoEnd) {
  const end = _parseDMYorISO_(isoEnd);
  const mean = (arr)=> arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

  const getRangeLoads = (days) => {
    const out = [];
    for (let i=0;i<days;i++){
      const k = _fmtISO_(_addDays_(end, -i));
      out.push(Number(dailyMap[k] || 0));
    }
    return out;
  };

  const acute7     = getRangeLoads(7);   // today..last 6
  const chronic28  = getRangeLoads(28);  // today..last 27
  const acuteAvg   = mean(acute7);
  const chronicAvg = mean(chronic28);
  if (chronicAvg <= 0) return null;
  return acuteAvg / chronicAvg;
}

function _monoStrain_(dailyMap, isoEnd) {
  const end = _parseDMYorISO_(isoEnd);
  const loads = [];
  for (let i=0;i<7;i++){
    const k = _fmtISO_(_addDays_(end, -i));
    loads.push(Number(dailyMap[k] || 0));
  }
  const sum  = loads.reduce((a,b)=>a+b,0);
  const mean = loads.length ? sum / loads.length : 0;
  const v = loads.length ? loads.reduce((a,b)=>a + Math.pow(b-mean,2),0) / loads.length : 0;
  const sd = Math.sqrt(v);
  const monotony = sd > 0 ? (mean / sd) : 0;
  const strain   = monotony * sum;
  return { monotony, strain };
}


/************** Intensity → RPE + session load + severity (ADD) **************/
function _rpeFromIntensity_(txt) {
  const s = String(txt || '').trim();
  const m = s.match(/rpe\s*:\s*(\d+(?:\.\d+)?)/i);
  if (m) return Number(m[1]);                // "RPE: 4" → 4
  const n = parseFloat(s.replace(',', '.')); // "6" → 6.0 (fallback if a bare number)
  if (isFinite(n) && n > 0) return n;
  const lc = s.toLowerCase();                // text buckets
  if (lc.includes('very high')) return 8;
  if (lc.includes('high'))      return 7;
  if (lc.includes('medium'))    return 5;
  if (lc.includes('low'))       return 3;
  return 5; // default
}

function _sessionLoadForRow_(minutes, intensity) {
  const min = Number(minutes);
  if (!isFinite(min) || min <= 0) return 0;
  const rpe = _rpeFromIntensity_(intensity);
  return Math.round(min * rpe);              // Minutes × RPE
}

function _severity_(sessionLoad, acwr, monotony) {
  if (acwr != null && acwr > 1.5) return 'high';
  if (monotony > 2.0)             return 'high';
  if (acwr != null && (acwr < 0.8 || acwr > 1.3)) return 'med';
  if (sessionLoad >= 600)         return 'med';
  return 'low';
}





/*** ====== HELPERS ====== ***/
function _open() { return SpreadsheetApp.openById(SHEET_ID); }
function _norm(s){ return String(s||'').trim().toLowerCase(); }
function _uniq(arr){ return Array.from(new Set((arr||[]).map(x=>String(x||'').trim()).filter(Boolean))); }

function _toDate(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  let s = String(v || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!s) return null;
  // dd/MM/yyyy or dd/MM/yy
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let dd = +m[1], mm = +m[2], yy = +m[3];
    if (yy < 100) yy = 2000 + yy;
    const d = new Date(yy, mm - 1, dd);
    return isNaN(d) ? null : d;
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t);
}
function _parseYMDLocal_(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(+m[1], +m[2]-1, +m[3]) : null;
}
function _isAllToken(x) {
  const s = _norm(x);
  return !s || s === '(all)' || s === 'all' || s === 'all players' || s === 'all themes' || s === 'all sub-tags' || s === 'all types';
}
function _toImageUrl_(val) {
  let s = String(val || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    const m = s.match(/[-\w]{25,}/);
    return m ? 'https://drive.google.com/uc?export=view&id=' + m[0] : s;
  }
  const id = s.match(/[-\w]{25,}/);
  return id ? 'https://drive.google.com/uc?export=view&id=' + id[0] : '';
}

/*** ====== API: Team Trend ====== ***/
function getTeamTrend() {
  const sh = _open().getSheetByName(TAB_TEAM_TRENDS);
  if (!sh) return null;
  const v = sh.getDataRange().getValues();
  if (v.length < 2) return null;
  let row = v.find(r => String(r[0]).toLowerCase().includes('last 7'));
  if (!row) row = v[1];
  return {
    window: String(row[0] || ''),
    summary: String(row[1] || ''),
    positives: String(row[2] || ''),
    concerns: String(row[3] || ''),
    focus: String(row[4] || '')
  };
}
function getThemeCountsLast7d(limit) {
  const sh = _open().getSheetByName(TAB_CLIPS);
  if (!sh) return {};
  const v = sh.getDataRange().getValues();
  if (v.length < 2) return {};
  const since = new Date(Date.now() - 7*24*60*60*1000);
  const counts = {};
  for (let r=1; r<v.length; r++) {
    const d = _toDate(v[r][0]);
    if (!d || d < since) continue;
    const theme = String(v[r][2] || '').trim();
    if (!theme) continue;
    counts[theme] = (counts[theme] || 0) + 1;
  }
  const lim = Math.max(1, Math.min(50, limit || 12));
  const sorted = Object.keys(counts).sort((a,b)=> counts[b]-counts[a] || a.localeCompare(b));
  const out = {};
  sorted.slice(0, lim).forEach(k => out[k] = counts[k]);
  return out;
}

function _homeSummaryBundle_() {
  const ss = _open();
  const tz = (ss.getSpreadsheetTimeZone && ss.getSpreadsheetTimeZone()) || Session.getScriptTimeZone();
  const now = new Date();
  const nowTs = now.getTime();
  let fallbackCursor = nowTs;
  const fallbackTs = () => {
    fallbackCursor -= 60000;
    return fallbackCursor;
  };

  const todayISO = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  const summary = {
    latestSession: null,
    upcoming: []
  };

  const dashPair = _homeLatestDashboardPair_(ss, tz);
  const latestSession = _homeLoadRatings_(ss, tz, nowTs, fallbackTs, todayISO, dashPair);
  if (latestSession) summary.latestSession = latestSession;

  const upcoming = _homeUpcoming_(nowTs);
  summary.upcoming = upcoming.games;

  const generatedAt = Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm:ss'Z'");
  return { summary, generatedAt };
}

function getHomeSummary() {
  try {
    const bundle = _homeSummaryBundle_();
    return { ok: true, summary: bundle.summary, generatedAt: bundle.generatedAt };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function getHomeDashboard(opts) {
  const force = opts && opts.force;
  const cacheKey = 'homeDashboard:v3';
  if (!force) {
    const cached = _cacheGetJSON_(cacheKey);
    if (cached) return cached;
  }

  try {
    const bundle = _homeSummaryBundle_();
    const flags = getThreeDayFlags();
    const teamRating = getTeamRatingSeries();
    const result = {
      ok: true,
      summary: bundle.summary,
      generatedAt: bundle.generatedAt,
      flags,
      teamRating
    };
    _cachePutJSON_(cacheKey, result, 90);
    return result;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function _homeLatestDashboardPair_(ss, tz) {
  const sh = ss.getSheetByName('Dashboard1');
  if (!sh) return null;

  const START_ROW = 5;
  const last = sh.getLastRow();
  if (last < START_ROW) return null;

  const totalRows = last - START_ROW + 1;
  if (totalRows <= 0) return null;

  const take = Math.min(totalRows, 180);
  const offset = totalRows - take;

  const valRange = sh.getRange(START_ROW + offset, 20, take, 1).getValues();
  const dateValues = sh.getRange(START_ROW + offset, 26, take, 1).getValues();
  const dateDisplay = sh.getRange(START_ROW + offset, 26, take, 1).getDisplayValues();
  const sessionDisplay = sh.getRange(START_ROW + offset, 2, take, 1).getDisplayValues();

  const sessionOf = s => {
    const m = String(s || '').match(/\(([^)]+)\)/);
    return m && m[1] ? m[1].trim() : '';
  };

  const entries = [];
  for (let i = 0; i < take; i++) {
    const rawVal = valRange[i][0];
    const val = _homeSafeNumber_(rawVal);
    if (val == null) continue;

    const rawDate = dateValues[i][0];
    const dispDate = dateDisplay[i][0];
    const dateObj = (rawDate instanceof Date && !isNaN(rawDate)) ? rawDate : _homeCoerceDate_(rawDate);
    const iso = dateObj ? _homeToISO_(dateObj, tz) : '';
    const display = String(dispDate || iso || '').trim();
    const sess = sessionOf(sessionDisplay[i][0]);
    const sessionKey = String(sess || '').replace(/\s+/g, ' ').trim().toLowerCase();

    entries.push({
      avg: Number(Number(val).toFixed(2)),
      dateISO: iso,
      displayDate: display,
      session: sess,
      sessionKey
    });
  }

  if (!entries.length) return null;

  const current = entries[entries.length - 1];
  const previous = entries.length > 1 ? entries[entries.length - 2] : null;
  return { current, previous };
}

function _homeLoadRatings_(ss, tz, nowTs, fallbackTs, todayISO, dashPair) {
  const sh = ss.getSheetByName('Log');
  if (!sh) return null;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

  const colCount = sh.getLastColumn();
  const header = sh.getRange(1, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
  const find = (rx) => {
    if (rx instanceof RegExp) {
      const idx = header.findIndex(h => rx.test(h));
      return idx >= 0 ? idx : null;
    }
    const lower = String(rx || '').toLowerCase();
    const idx = header.findIndex(h => String(h || '').trim().toLowerCase() === lower);
    return idx >= 0 ? idx : null;
  };
  const idx = {
    Date: find(/^date/i),
    Session: find(/^session/i),
    Coach: find(/^coach/i),
    Player: find(/^player/i),
    Exec: find(/^execution/i),
    Energy: find(/^energy/i),
    Comm: find(/^communication/i),
    Adapt: find(/^adapt/i),
    Res: find(/^resilience/i),
    Impact: find(/^team\s*impact/i),
    Notes: find(/^notes/i)
  };
  const traitCols = [idx.Exec, idx.Energy, idx.Comm, idx.Adapt, idx.Res, idx.Impact].filter(i => i != null);
  if (!traitCols.length || idx.Player == null || idx.Session == null) return null;

  const rows = sh.getRange(2, 1, lastRow - 1, colCount).getValues();

  const ratingRows = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const player = String(row[idx.Player] || '').trim();
    const session = String(row[idx.Session] || '').trim();
    if (!player || !session) continue;

    const rawDate = idx.Date != null ? row[idx.Date] : '';
    const dateObj = _homeCoerceDate_(rawDate);
    const coach = idx.Coach != null ? String(row[idx.Coach] || '').trim() : '';
    const note = idx.Notes != null ? String(row[idx.Notes] || '').trim() : '';
    const scores = traitCols.map(c => _homeSafeNumber_(row[c])).filter(n => n != null);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const ts = dateObj ? dateObj.getTime() + i : fallbackTs();
    const dateISO = dateObj ? _homeToISO_(dateObj, tz) : '';

    ratingRows.push({
      ts,
      dateISO,
      session,
      coach,
      player,
      avg,
      note,
      rawDate: rawDate != null ? String(rawDate).trim() : ''
    });
  }

  if (!ratingRows.length) return null;
  ratingRows.sort((a, b) => a.ts - b.ts);

  const normalize = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizeDisplay = s => String(s || '').trim().toLowerCase();
  const todayKey = todayISO || '';
  const dashCurrent = dashPair && dashPair.current ? dashPair.current : null;
  const dashPrev = dashPair && dashPair.previous ? dashPair.previous : null;

  const buildGroups = (rows) => {
    const map = new Map();
    const list = [];
    rows.forEach(row => {
      const sessionKey = normalize(row.session) || '__blank__';
      const dateKey = row.dateISO || row.rawDate || '';
      const key = `${dateKey}|${sessionKey}`;
      let grp = map.get(key);
      if (!grp) {
        grp = {
          key,
          sessionKey,
          sessionName: row.session || '',
          dateISO: row.dateISO || '',
          rawDate: row.rawDate || '',
          displayKey: normalizeDisplay(row.rawDate || row.dateISO || ''),
          ts: row.ts,
          rows: []
        };
        map.set(key, grp);
        list.push(grp);
      }
      grp.rows.push(row);
      if (row.ts > grp.ts) grp.ts = row.ts;
      if (!grp.dateISO && row.dateISO) grp.dateISO = row.dateISO;
      if (!grp.rawDate && row.rawDate) grp.rawDate = row.rawDate;
      if (!grp.sessionName && row.session) grp.sessionName = row.session;
      if (!grp.displayKey) grp.displayKey = normalizeDisplay(row.rawDate || row.dateISO || '');
    });
    list.sort((a, b) => a.ts - b.ts);
    return list;
  };

  const allGroups = buildGroups(ratingRows);
  if (!allGroups.length) return null;

  const findGroupForMeta = (meta) => {
    if (!meta) return null;
    const metaSession = normalize(meta.session);
    const metaSessionKey = meta.sessionKey || metaSession;
    const metaDateISO = meta.dateISO || '';
    const metaDisplay = normalizeDisplay(meta.displayDate || '');
    for (let i = allGroups.length - 1; i >= 0; i--) {
      const g = allGroups[i];
      if (metaDateISO && g.dateISO && g.dateISO === metaDateISO) return g;
      if (metaSessionKey && g.sessionKey === metaSessionKey) return g;
      if (metaDisplay && normalizeDisplay(g.rawDate || g.displayKey || '') === metaDisplay) return g;
    }
    return null;
  };

  let latestGroup = null;
  if (dashCurrent) {
    latestGroup = findGroupForMeta(dashCurrent);
  }
  if (!latestGroup && todayKey) {
    for (let i = allGroups.length - 1; i >= 0; i--) {
      const g = allGroups[i];
      if (g.dateISO && g.dateISO === todayKey) { latestGroup = g; break; }
    }
  }
  if (!latestGroup) latestGroup = allGroups[allGroups.length - 1];
  if (!latestGroup) return null;

  const latestIndex = allGroups.indexOf(latestGroup);
  let prevGroup = dashPrev ? findGroupForMeta(dashPrev) : null;
  if (!prevGroup || prevGroup === latestGroup) {
    prevGroup = latestIndex > 0 ? allGroups[latestIndex - 1] : null;
  }

  const latestRows = latestGroup.rows;
  const prevRows = prevGroup ? prevGroup.rows : null;

  const players = latestRows.map(r => ({
    player: r.player,
    coach: r.coach,
    avg: r.avg,
    note: r.note
  })).sort((a, b) => (b.avg || 0) - (a.avg || 0));

  const avgValues = players.filter(p => p.avg != null).map(p => p.avg);
  const avgFromRows = avgValues.length
    ? Number((avgValues.reduce((a, b) => a + b, 0) / avgValues.length).toFixed(2))
    : null;

  let avgScore = dashCurrent && dashCurrent.avg != null
    ? Number(Number(dashCurrent.avg).toFixed(2))
    : avgFromRows;

  let prevAvg = dashPrev && dashPrev.avg != null
    ? Number(Number(dashPrev.avg).toFixed(2))
    : null;
  if ((prevAvg == null || !isFinite(prevAvg)) && prevRows && prevRows.length) {
    const prevValues = prevRows.map(r => r.avg).filter(n => n != null);
    if (prevValues.length) {
      prevAvg = Number((prevValues.reduce((a, b) => a + b, 0) / prevValues.length).toFixed(2));
    }
  }

  const deltaPrev = (avgScore != null && prevAvg != null)
    ? Number((avgScore - prevAvg).toFixed(2))
    : null;

  const coachMap = new Map();
  players.forEach(p => {
    const coachName = p.coach || '—';
    let bucket = coachMap.get(coachName);
    if (!bucket) {
      bucket = { coach: coachName, sum: 0, count: 0 };
      coachMap.set(coachName, bucket);
    }
    if (p.avg != null) {
      bucket.sum += p.avg;
      bucket.count += 1;
    }
  });

  const coaches = Array.from(coachMap.values()).map(c => ({
    coach: c.coach,
    avg: c.count ? Number((c.sum / c.count).toFixed(2)) : null,
    count: c.count
  })).sort((a, b) => {
    if (a.avg == null && b.avg == null) return a.coach.localeCompare(b.coach);
    if (a.avg == null) return 1;
    if (b.avg == null) return -1;
    return b.avg - a.avg || a.coach.localeCompare(b.coach);
  });

  const noteRows = latestRows.filter(r => r.note);
  const notes = noteRows
    .slice(0, 12)
    .map(r => ({ player: r.player, coach: r.coach, note: r.note }));

  const coachNames = Array.from(new Set(latestRows.map(r => r.coach).filter(Boolean)));
  const coachLabel = coachNames.length > 1 ? 'Multiple coaches' : (coachNames[0] || latestRows[0]?.coach || '');

  const primaryDateISO = dashCurrent && dashCurrent.dateISO
    ? dashCurrent.dateISO
    : (latestGroup.dateISO || latestRows[0]?.dateISO || '');

  const displayDate = dashCurrent && dashCurrent.displayDate
    ? dashCurrent.displayDate
    : (latestGroup.rawDate || primaryDateISO);

  const primarySession = dashCurrent && dashCurrent.session
    ? dashCurrent.session
    : (latestGroup.sessionName || latestRows[0]?.session || '');

  const playerMap = new Map();
  latestRows.forEach(r => {
    const name = r.player || 'Unnamed';
    let bucket = playerMap.get(name);
    if (!bucket) {
      bucket = {
        player: name,
        sum: 0,
        count: 0,
        coaches: new Set(),
        notes: []
      };
      playerMap.set(name, bucket);
    }
    if (r.avg != null) {
      bucket.sum += r.avg;
      bucket.count += 1;
    }
    if (r.coach) bucket.coaches.add(r.coach);
    if (r.note) bucket.notes.push({ coach: r.coach || '', note: r.note });
  });

  const playerSummaries = Array.from(playerMap.values()).map(p => ({
    player: p.player,
    avg: p.count ? Number((p.sum / p.count).toFixed(2)) : null,
    coaches: Array.from(p.coaches),
    notes: p.notes
  })).sort((a, b) => {
    if (a.avg == null && b.avg == null) return a.player.localeCompare(b.player);
    if (a.avg == null) return 1;
    if (b.avg == null) return -1;
    return b.avg - a.avg || a.player.localeCompare(b.player);
  });

  return {
    session: primarySession,
    dateISO: primaryDateISO || '',
    displayDate: displayDate || '',
    coach: coachLabel,
    avgScore: avgScore != null ? Number(avgScore.toFixed(2)) : null,
    prevAvg: prevAvg != null ? Number(prevAvg.toFixed(2)) : null,
    deltaPrev,
    playerCount: playerSummaries.length,
    coaches,
    noteCount: noteRows.length,
    notes,
    players: playerSummaries,
    playerSummaries
  };
}

function _homeUpcoming_(nowTs) {
  const out = { games: [] };
  const res = getSchedule();
  if (!res || !res.ok || !Array.isArray(res.games)) return out;
  const upcoming = res.games.filter(g => (g.status || '').toLowerCase() === 'upcoming');
  upcoming.sort((a, b) => {
    if (a.ts == null && b.ts == null) return 0;
    if (a.ts == null) return 1;
    if (b.ts == null) return -1;
    return a.ts - b.ts;
  });
  const soon = upcoming.filter(g => g.ts == null || g.ts >= nowTs - 12 * 60 * 60 * 1000).slice(0, 3);
  out.games = soon;
  return out;
}

function _homeCoerceDate_(value) {
  if (value instanceof Date && !isNaN(value)) return new Date(value.getTime());
  if (value == null || value === '') return null;
  const parsed = _parseNotesDate(value);
  if (parsed instanceof Date && !isNaN(parsed)) return parsed;
  const direct = _toDate(value);
  return direct instanceof Date && !isNaN(direct) ? direct : null;
}

function _homeToISO_(dateObj, tz) {
  if (!dateObj) return '';
  return Utilities.formatDate(dateObj, tz, 'yyyy-MM-dd');
}

function _homeSafeNumber_(value) {
  if (value == null || value === '') return null;
  const n = parseFloat(String(value).replace(',', '.'));
  return isFinite(n) ? n : null;
}

/*** ====== API: Players ====== ***/
function getPlayers() {
  const sh = _open().getSheetByName(TAB_PLAYERS);
  if (!sh) return [];
  const v = sh.getDataRange().getValues();
  const out = [];
  for (let r=1; r<v.length; r++) {
    const name = String(v[r][0] || '').trim();
    if (name) out.push(name);
  }
  return _uniq(out).sort((a,b)=>a.localeCompare(b));
}



function apiGetPlayerDetail(playerName) {
  const ss = _open();
  const sh = ss.getSheetByName(TAB_PLAYERS);
  if (!sh) return null;
  const v = sh.getDataRange().getValues();
  const target = _norm(playerName);
  let detail = null;

  for (let r=1; r<v.length; r++) {
    const nm = _norm(v[r][0]);
    if (nm && nm === target) {
      detail = {
        name: v[r][0],
        strengths: String(v[r][2] || ''),
        weaknesses: String(v[r][3] || ''),
        focus: String(v[r][4] || '')
      };
      break;
    }
  }
  if (!detail) return null;

  // add photo from pics
  const picSh = ss.getSheetByName(TAB_PICS);
  if (picSh) {
    const pv = picSh.getDataRange().getValues();
    const tgt = _norm(detail.name);
    for (let r=1; r<pv.length; r++) {
      const nm = _norm(pv[r][0]);
      if (nm && nm === tgt) {
        detail.photoUrl = _toImageUrl_(pv[r][1]);
        break;
      }
    }
  }

  // ⬇️ NEW: attach 3-day flags
  detail.flags = getFlagsForPlayer(detail.name);


  // ⬅️ NEW: Overall progress (Σ Δ) from Player_Progress!U
  detail.overall = getOverallProgressForPlayer(detail.name);

  return detail;
}





function getPlayerPhoto(name) {
  if (!name) return '';
  const sh = _open().getSheetByName(TAB_PICS);
  if (!sh) return '';
  const v = sh.getDataRange().getValues();
  for (let r=1; r<v.length; r++) {
    if (_norm(v[r][0]) === _norm(name)) return _toImageUrl_(v[r][1]);
  }
  return '';
}

function getPlayerBundle(name, clipLimit) {
  try {
    const detail = apiGetPlayerDetail(name) || null;
    const photoUrl = detail && detail.photoUrl ? detail.photoUrl : getPlayerPhoto(name);
    const coachRatings = getPlayerCoachRatings(name);
    const clips = getPlayerClips(name, clipLimit);
    return {
      ok: true,
      detail,
      photoUrl,
      coachRatings,
      clips
    };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

/*** ====== API: Clip filters ====== ***/
function getClipFilters() {
  const sh = _open().getSheetByName(TAB_CLIPS);
  if (!sh) return { players:[], themes:[], subTags:[], clipTypes:[] };
  const v = sh.getDataRange().getValues();
  const players=[], themes=[], subs=[], types=[];
  for (let r=1; r<v.length; r++) {
    players.push(String(v[r][1] || '').trim());
    themes .push(String(v[r][2] || '').trim());
    subs   .push(String(v[r][3] || '').trim());
    types  .push(String(v[r][5] || '').trim());
  }
  const subList = _uniq(subs).sort((a,b)=>a.localeCompare(b));
  return {
    players:  _uniq(players).sort((a,b)=>a.localeCompare(b)),
    themes:   _uniq(themes).sort((a,b)=>a.localeCompare(b)),
    subTags:  subList,
    subtags:  subList,
    clipTypes:_uniq(types).sort((a,b)=>a.localeCompare(b))
  };
}

/*** ====== Core: Clips (rich) ====== ***/
function apiGetClips(query) {
  query = query || {};
  const sh = _open().getSheetByName(TAB_CLIPS);
  if (!sh) return [];
  const rng  = sh.getDataRange();
  const v    = rng.getValues();
  const disp = rng.getDisplayValues();
  const rt   = rng.getRichTextValues();
  const fm   = rng.getFormulas();

  const wantPlayer   = query.player   || '';
  const wantTheme    = query.theme    || '';
  const wantSubTag   = query.subTag   || '';
  const wantClipType = query.clipType || '';
  const limit        = Math.max(1, Math.min(500, query.limit || 50));
  const newestFirst  = (query.newestFirst !== false);

  const since = _parseYMDLocal_(query.since);
  const until = _parseYMDLocal_(query.until);
  const qtext = _norm(query.q || '');
  const tz    = Session.getScriptTimeZone() || 'Europe/Athens';

  const rows = [];
  for (let r=1; r<v.length; r++) {
    const dateRaw = v[r][0];
    const dateStrSeen = String(disp[r][0] || '');
    const dateObj = _toDate(dateRaw);

    const player = String(v[r][1] || '').trim();
    const theme  = String(v[r][2] || '').trim();
    const subTag = String(v[r][3] || '').trim();
    const offdef = String(v[r][4] || '').trim();
    const type   = String(v[r][5] || '').trim();
    const notes  = String(v[r][6] || '').trim();
    const times = String(v[r][8] || '').trim();

    if (since && dateObj && dateObj < since) continue;
    if (until && dateObj && dateObj > until) continue;

    if (!_isAllToken(wantPlayer)   && _norm(player) !== _norm(wantPlayer))   continue;
    if (!_isAllToken(wantTheme)    && _norm(theme)  !== _norm(wantTheme))    continue;
    if (!_isAllToken(wantSubTag)   && _norm(subTag) !== _norm(wantSubTag))   continue;
    if (!_isAllToken(wantClipType) && _norm(type)   !== _norm(wantClipType)) continue;

    if (qtext) {
      const hay = _norm([player, theme, subTag, type, offdef, notes].join(' '));
      if (!hay.includes(qtext)) continue;
    }

    // link from col H
    let link = '';
    const rtCell = rt && rt[r] ? rt[r][7] : null;
    if (rtCell) {
      try {
        const runs = rtCell.getRuns ? rtCell.getRuns() : null;
        if (runs && runs.length) {
          for (let k=0;k<runs.length;k++) {
            const u = runs[k].getLinkUrl && runs[k].getLinkUrl();
            if (u) { link = u; break; }
          }
        } else {
          const u = rtCell.getLinkUrl && rtCell.getLinkUrl();
          if (u) link = u;
        }
      } catch(e) {}
    }
    if (!link) {
      const f = fm && fm[r] ? fm[r][7] : '';
      const m = f && f.match(/HYPERLINK\(\s*"([^"]+)"/i);
      if (m) link = m[1];
    }
    if (!link) {
      const raw = v[r][7];
      if (typeof raw === 'string' && /^https?:\/\//i.test(raw)) link = raw.trim();
    }

    rows.push({
      date: dateObj || null,
      dateStr: dateObj ? Utilities.formatDate(dateObj, tz, 'dd/MM/yyyy') : (dateStrSeen || ''),
      player, theme, subTag, offdef, type, notes,
      link, url: link,
      times
    });
  }

  rows.sort((a,b)=>{
    if (a.date && b.date) return newestFirst ? (b.date - a.date) : (a.date - b.date);
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return 0;
  });

  return rows.slice(0, limit);
}

/*** ====== Flat/string-only API (use this from HTML) ====== ***/
function apiGetClipsFlat(query) {
  var out = apiGetClips(query || {});
  if (!Array.isArray(out)) return [];
  return out.map(function(r){
    return {
      dateStr: String(r && r.dateStr || ''),
      player:  String(r && r.player  || ''),
      theme:   String(r && r.theme   || ''),
      subTag:  String(r && r.subTag  || ''),
      type:    String(r && r.type    || ''),
      notes:   String(r && r.notes   || ''),
      link:    String((r && (r.link || r.url)) || ''),
     times: String(r && r.times || '')     
    };
  });
}



/*** ====== Convenience ====== ***/
function getPlayerClips(name, limit) {
  return apiGetClipsFlat({ player: name, newestFirst: true, limit: Math.max(1, limit || 6) });
}
function getClips(args) {
  return apiGetClipsFlat(args || { newestFirst: true, limit: 200 });
}

/*** ====== Ping ====== ***/
function pingVersion() { return 'web endpoints live'; }





/*** ====== API: Ratings heatmap from Dashboard1 (B4:Q) ====== ***/
function apiGetRatingsHeatmap() {
  const sh = _open().getSheetByName('Dashboard1');
  if (!sh) return null;

  const startRow = 4;   // header row
  const startCol = 2;   // column B
  const maxRow   = 34;  // cap at row 34
  const endCol   = 18;  // column R

  const lastRow = Math.min(sh.getLastRow(), maxRow);
  if (lastRow < startRow) return null;

  const numRows = lastRow - startRow + 1;
  const numCols = endCol - startCol + 1;

  const v = sh.getRange(startRow, startCol, numRows, numCols).getDisplayValues();
  if (!v.length) return null;

  const headers = v[0];
  const rowsOut = [];

  for (let i = 1; i < v.length; i++) {
    const row = v[i];
    if (row.every(c => String(c).trim() === '')) continue;

    rowsOut.push({
      date: row[0],
      values: row.slice(1),
    });
  }

  return { headers, rows: rowsOut };
}

/* Alias for HTML */
function getRatingsHeatmap() { return apiGetRatingsHeatmap(); }





/** Read 3-day flags from Flags!J26:P41 (J: player name, K–P: Exec..Impact) */
function getFlagsForPlayer(name) {
  if (!name) return null;
  const sh = _open().getSheetByName('Flags');
  if (!sh) return null;

  // J..P (7 cols): J = Player, K–P = 6 traits
  const range = sh.getRange(26, 10, 16, 7).getDisplayValues(); 
  const target = String(name).trim().toLowerCase();

  for (let i = 0; i < range.length; i++) {
    const row = range[i];
    const playerCell = String(row[0] || '').trim().toLowerCase();
    if (!playerCell) continue;
    if (playerCell === target) {
      const vals = row.slice(1, 7).map(x => String(x || '').trim() || "—");
      return {
        exec:       vals[0],
        energy:     vals[1],
        comm:       vals[2],
        adapt:      vals[3],
        resilience: vals[4],
        impact:     vals[5]
      };
    }
  }
  return null;
}



function getOverallProgressForPlayer(name) {
  if (!name) return null;
  const sh = _open().getSheetByName('Player_Progress');
  if (!sh) return null;

  // A..U (21 columns). Row 1 is header; data from row 2 down.
  const last = sh.getLastRow();
  if (last < 2) return null;
  const rows = sh.getRange(2, 1, last - 1, 21).getDisplayValues(); // A:Player ... U:Overall

  const target = _norm(name);
  for (let i = 0; i < rows.length; i++) {
    const player = _norm(rows[i][0]);   // A
    if (player && player === target) {
      const overall = _toNum_(rows[i][20]); // U (index 20)
      return overall;
    }
  }
  return null;
}




/** Brand for landing page (logo + title). Edit name and link below. */
function getBrand() {
  // Put your Drive *file link or ID* here; _toImageUrl_ already converts it
  var logoDriveLink = 'https://www.peristeribc.gr/wp-content/uploads/2025/07/Peristeri-Logo-plain-1.png';
  return {
    name: 'Peristeri B.C.',
    logoUrl: _toImageUrl_(logoDriveLink)
  };
}











/** Dashboard1 heatmap → compute per-day team average from A4:Q34 */
/** Team rating time-series from Dashboard1 heatmap (handles 1 or 2 Date columns) */
/** Team rating time-series from Dashboard1 heatmap (handles 1 or 2 "Date" columns) */
// Code.gs
function getTeamRatingSeries() {
  const sh = _open().getSheetByName('Dashboard1');
  if (!sh) return { ok:false, reason:'Dashboard1 not found' };

  // Rows 5..34 (30 rows). Adjust if your sheet has a different depth.
  const N = 30;

  // T = 20 (values), Z = 26 (date-only labels), B = 2 (date + session like "20-Aug ( Team Practice )")
  const valRange = sh.getRange(5, 20, N, 1).getValues();          // T5:T34
  const labRange = sh.getRange(5, 26, N, 1).getDisplayValues();    // Z5:Z34  (dates only for axis)
  const bRange   = sh.getRange(5,  2, N, 1).getDisplayValues();    // B5:B34  (date + session)

  const labels   = [];  // x-axis (dates from Z)
  const values   = [];  // y values (from T)
  const sessions = [];  // tooltip session text (parsed from B)

  // helper: pull text inside parentheses
  const sessionOf = s => {
    const m = String(s || '').match(/\(([^)]+)\)/);
    return m && m[1] ? m[1].trim() : '';
  };

  for (let i = 0; i < N; i++) {
    const rawV = valRange[i][0];
    const rawL = labRange[i][0];
    const rawB = bRange[i][0];

    // skip blank rows
    if ((rawV === '' || rawV == null) && String(rawL).trim() === '') continue;

    const n = (typeof rawV === 'number') ? rawV : parseFloat(String(rawV).replace(',', '.'));
    if (!isNaN(n) && String(rawL).trim() !== '') {
      labels.push(String(rawL));          // date only (for axis)
      values.push(n);
      sessions.push(sessionOf(rawB));     // just "Team Practice", "Friendly", …
    }
  }

  if (!labels.length) return { ok:false, reason:'No data' };
  return { ok:true, labels, values, sessions };
}




/** Coach ratings per selected player (from Log!A:L)
 *  Assumptions:
 *  - Column C = Coach
 *  - Column D = Player
 *  - Column L = Overall (numeric)
 */
function getPlayerCoachRatings(playerName) {
  if (!playerName) return { ok: false, reason: 'No player' };
  const sh = _open().getSheetByName('Log');
  if (!sh) return { ok: false, reason: 'Log sheet not found' };

  const v = sh.getDataRange().getValues(); // A:L
  const want = _norm(playerName);
  const groups = {}; // coach -> [numbers]

  for (let r = 1; r < v.length; r++) {
    const coach  = String(v[r][2] || '').trim();      // C
    const player = _norm(v[r][3]);                    // D
    let overall  = v[r][11];                          // L

    if (!coach || player !== want) continue;

    const num = (typeof overall === 'number')
      ? overall
      : parseFloat(String(overall).replace(',', '.'));

    if (isNaN(num)) continue;

    (groups[coach] = groups[coach] || []).push(num);
  }

  const rows = Object.keys(groups).map(coach => {
    const arr = groups[coach];
    const n = arr.length;
    const avg = n ? arr.reduce((a,b) => a + b, 0) / n : 0;
    return [coach, avg, n];
  }).sort((a,b) => b[1] - a[1]); // highest avg first

  return { ok: true, rows };
}



















/*** ====== RATINGS (Dashboard1!A4:Q34) ====== ***/
function apiGetRatingsGrid() {
  const SH = 'Dashboard1';
  const START_ROW = 4;   // header row (Date, players…)
  const END_ROW   = 34;  // last heatmap row (adjust as needed)
  const START_COL = 1;   // A
  const END_COL   = 18;  // Q

  const sh = _open().getSheetByName(SH);
  if (!sh) return { ok:false, error:'Dashboard1 not found' };

  const numRows = END_ROW - START_ROW + 1;
  const numCols = END_COL - START_COL + 1;
  const grid = sh.getRange(START_ROW, START_COL, numRows, numCols).getDisplayValues();
  if (!grid.length) return { ok:false, error:'No data in A4:Q34' };

  const headers = grid[0];                 // ["Date","Abercrombie",...]
  const rows = [];
  for (let r=1; r<grid.length; r++) {
    const row = grid[r];
    const allBlank = row.every(c => String(c).trim() === '');
    if (allBlank) continue;
    rows.push(row);
  }

  return { ok:true, headers, rows };
}

// Alias for HTML
function getRatingsGrid() { return apiGetRatingsGrid(); }




function getGameNotes(){
  const sh = _open().getSheetByName('Game_notes');
  if (!sh) return { ok:false, rows:[] };

  // Read all rows with display values so dates look like on sheet
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok:true, rows:[] };

  // A:E -> 5 columns
  const values = sh.getRange(2, 1, lastRow - 1, 5).getDisplayValues();

  // Filter out blank rows (both Date and Game empty)
  const rows = values.filter(r => String(r[0]).trim() || String(r[1]).trim());

  return { ok:true, rows };
}






/** 3-Day flags from Dashboard1!L39:R54
 *  Expected:
 *    L39: "Player"
 *    M39..R39: "Exec","Energy","Comm","Adapt","Resilience","Impact"
 *    L40..R54: data rows
 */
function getThreeDayFlags() {
  const sh = _open().getSheetByName('Dashboard1');
  if (!sh) return { ok:false, reason:'Dashboard1 not found' };

  // Exact range: L39:R54  (row 39, col L=12, 16 rows, 7 cols)
  const startRow = 39, startCol = 12, numRows = 17, numCols = 7;
  const values = sh.getRange(startRow, startCol, numRows, numCols).getDisplayValues();
  if (!values || !values.length) return { ok:false, reason:'Empty range' };

  const headers = values[0].map(String);
  const rows = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const allBlank = row.every(c => String(c).trim() === '');
    if (allBlank) continue;

    const player = String(row[0] || '').trim();
    if (!player) continue;

    rows.push(row);
  }

  if (!rows.length) return { ok:false, reason:'No rows' };
  return { ok:true, headers, rows };
}












function getPlayerEmailMap() {
 const ss = SpreadsheetApp.openById(SHEET_ID); // use getActiveSpreadsheet (not getActive)
  const sh = ss.getSheetByName('Emails');            // ✅ your tab name is "Emails"
  if (!sh) throw new Error("Sheet 'Emails' not found");

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return {};

  const values = sh.getRange(2, 1, lastRow - 1, 2).getValues(); // A2:B
  const map = {};
  values.forEach(([name, email]) => {
    const n = String(name || '').trim();
    const e = String(email || '').trim();
    if (n && e && /@/.test(e)) {
      map[n] = e;
      map[n.toLowerCase()] = e; // optional: lookup case-insensitive
    }
  });
  return map;
}





function sendFeedbackEmail(payload) {
  try {
    const player = payload && payload.player;
    let   email  = payload && payload.email;           // from client cache
    const text   = (payload && payload.text) || '';
    const clips  = (payload && payload.clips) || [];

    // Look up email + first name from Emails sheet (A: name, B: email, C: first)
    const { email: sheetEmail, first } = _getEmailAndFirst_(player);
    if (sheetEmail) email = sheetEmail; // prefer the sheet value

    if (!email || !clips.length) {
      return { ok:false, error:'Missing email or clips.' };
    }

    const firstName = first || (String(player).split(' ')[0] || player);
    const subj = `Video Feedback — ${player}`;
    const list = clips.map(u => {
      const esc = HtmlService.createHtmlOutput(u).getContent();
      return `<li><a href="${esc}" target="_blank" rel="noopener">${esc}</a></li>`;
    }).join('');

    const html =
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;">
        <p>Hi ${firstName},</p>
        ${text ? `<p>${text.replace(/\n/g,'<br>')}</p>` : ''}
        <p><b>Clips:</b></p>
        <ul>${list}</ul>
        <p style="color:#777;">Sent via Peristeri Coaching Hub</p>
      </div>`;

    GmailApp.sendEmail(email, subj, '', { htmlBody: html, name: 'Peristeri Coaching Hub' });
    return { ok:true };
  } catch (e) {
    return { ok:false, error: String(e) };
  }
}



function _getEmailAndFirst_(playerName) {
  const sh = _open().getSheetByName(TAB_EMAILS); // "Emails"
  if (!sh) return { email: '', first: '' };

  const v = sh.getDataRange().getValues(); // headers + data
  const want = _norm(playerName);

  for (let r = 1; r < v.length; r++) {
    const name = _norm(v[r][0]);       // Col A: Full Name
    const email = String(v[r][1] || '').trim();   // Col B: Email
    const first = String(v[r][2] || '').trim();   // Col C: First Name
    if (name && name === want) {
      return { email, first };
    }
  }
  return { email: '', first: '' };
}





/*** ====== TRAIT RATINGS from Dashboard1!B39:I54 ====== ***/
function getTraitRatingsGrid() {
  const SH = 'Dashboard1';
  const START_ROW = 39;  // header row: Player | n | Exec | Energy | Comm | Adapt | Resilience | Impact
  const END_ROW   = 55;  // last data row
  const START_COL = 2;   // B
  const END_COL   = 9;   // I

  const sh = _open().getSheetByName(SH);
  if (!sh) return { ok:false, error:'Dashboard1 not found' };

  const numRows = END_ROW - START_ROW + 1;
  const numCols = END_COL - START_COL + 1;
  const grid = sh.getRange(START_ROW, START_COL, numRows, numCols).getDisplayValues();
  if (!grid.length) return { ok:false, error:'No data in B39:I54' };

  const headers = grid[0]; // ["Player","n","Exec","Energy","Comm","Adapt","Resilience","Impact"]
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const allBlank = row.every(c => String(c).trim() === '');
    if (allBlank) continue;
    rows.push(row);
  }
  return { ok:true, headers, rows };
}



/*** ====== SUMMARIES ====== ***/
// Sheet columns (A:I):
// A:ID | B:Title | C:AudienceType | D:AudienceName | E:Date | F:Description | G:Clips | H:Captions | I:CreatedBy

function ensureSummariesSheet_() {
  const ss = _open();
  let sh = ss.getSheetByName(TAB_SUMMARIES);
  if (!sh) {
    sh = ss.insertSheet(TAB_SUMMARIES);
    sh.getRange(1,1,1,9).setValues([[
      'ID','Title','AudienceType','AudienceName','Date','Description','Clips','Captions','CreatedBy'
    ]]);
  }
  return sh;
}

/** Create a new summary row */
function createSummary(payload) {
  try {
    const sh = ensureSummariesSheet_();

    const title         = String(payload?.title || '').trim();
    const audienceType  = String(payload?.audienceType || '').trim().toLowerCase(); // player|team|group
    const audienceName  = String(payload?.audienceName || '').trim();
    const description   = String(payload?.description || '').trim();
    const clips         = Array.isArray(payload?.clips) ? payload.clips.filter(Boolean) : [];
    const captions      = Array.isArray(payload?.captions) ? payload.captions : [];

    if (!title) return { ok:false, error:'Title is required' };
    if (!clips.length) return { ok:false, error:'No clips selected' };

    // ID like SUM-20250912-154210
    const now = new Date();
    const pad = n => (n<10 ? '0'+n : ''+n);
    const id = `SUM-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const tz = Session.getScriptTimeZone() || 'Europe/Athens';
    const dateStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

    // Join lists with |
    const caps = clips.map((_,i) => String(captions[i] || '').trim());
    const clipsStr = clips.join(' | ');
    const capsStr  = caps.join(' | ');

    const createdBy = String(Session.getActiveUser().getEmail() || '').trim();

    sh.appendRow([id, title, audienceType, audienceName, dateStr, description, clipsStr, capsStr, createdBy]);
    return { ok:true, id };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

/** Return all summaries (lightweight list) */
function getSummaries() {
  const sh = ensureSummariesSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok:true, rows:[] };

  const values = sh.getRange(2,1,last-1,9).getValues();
  // Map to array of objects for the UI
  const rows = values.map(r => ({
    id:          String(r[0] || ''),
    title:       String(r[1] || ''),
    audienceType:String(r[2] || ''),
    audienceName:String(r[3] || ''),
    date:        String(r[4] || ''),
    description: String(r[5] || ''),
  })).filter(x => x.id);

  // newest first by date/id
  rows.sort((a,b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
  return { ok:true, rows };
}

/** Return full detail for a summary (by ID) */
function getSummaryDetail(id) {
  if (!id) return { ok:false, error:'No ID' };
  const sh = ensureSummariesSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok:false, error:'No data' };

  const values = sh.getRange(2,1,last-1,9).getValues(); // A:I
  for (let i=0;i<values.length;i++){
    const r = values[i];
    if (String(r[0]) === id) {
      const clips    = String(r[6] || '').split(' | ').filter(Boolean);
      const captions = String(r[7] || '').split(' | ');
      return {
        ok:true,
        id: id,
        title: String(r[1] || ''),
        audienceType: String(r[2] || ''),
        audienceName: String(r[3] || ''),
        date: String(r[4] || ''),
        description: String(r[5] || ''),
        clips,
        captions
      };
    }
  }
  return { ok:false, error:'Not found' };
}






function deleteSummary(id) {
  try {
    if (!id) return { ok:false, error:'No id' };
    const sh = _open().getSheetByName(TAB_SUMMARIES);
    if (!sh) return { ok:false, error:'Summaries sheet not found' };

    // Read header to find the ID column (fallback: assume column B)
    const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    let idCol = header.findIndex(h => String(h).trim().toLowerCase() === 'id') + 1; // 1-based
    if (idCol <= 0) idCol = 2; // fallback if "ID" header not found

    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok:false, error:'No data' };

    const ids = sh.getRange(2, idCol, lastRow - 1, 1).getDisplayValues().map(r => String(r[0]).trim());
    const idx = ids.findIndex(v => v === String(id).trim());
    if (idx < 0) return { ok:false, error:'Summary not found' };

    const rowToDelete = 2 + idx; // data starts at row 2
    sh.deleteRow(rowToDelete);
    return { ok:true };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}




function getClipNotes(url) {
  try {
    const ss = _open();                                     // ← use openById
    let sh = ss.getSheetByName('Clip_Notes');
    if (!sh) {
      // if sheet doesn’t exist, create with headers and return empty
      sh = ss.insertSheet('Clip_Notes');
      sh.getRange(1, 1, 1, 4).setValues([['Timestamp', 'ClipURL', 'Coach', 'Note']]);
      return { ok: true, rows: [] };
    }

    const last = sh.getLastRow();
    if (last < 2) return { ok: true, rows: [] };

    // Read raw values so we can sort by the actual Date object in col A
    const values = sh.getRange(2, 1, last - 1, 4).getValues(); // A:D
    const tz = Session.getScriptTimeZone() || 'Europe/Athens';
    const want = String(url || '').trim();

    // Filter for this URL, sort by timestamp (col 1) descending
    const filtered = values
      .filter(r => String(r[1] || '').trim() === want)
      .sort((a, b) => (b[0] instanceof Date ? b[0].getTime() : 0) - (a[0] instanceof Date ? a[0].getTime() : 0));

    const rows = filtered.map(r => ({
      date: (r[0] instanceof Date && !isNaN(r[0])) ? Utilities.formatDate(r[0], tz, 'dd MMM yyyy HH:mm') : '',
      coach: r[2] || '',
      note:  r[3] || ''
    }));

    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message || 'getClipNotes error' };
  }
}

function saveClipNote(obj) {
  try {
    const url   = (obj && obj.url)   ? String(obj.url).trim()   : '';
    const note  = (obj && obj.note)  ? String(obj.note).trim()  : '';
    const coach = (obj && obj.coach) ? String(obj.coach).trim() : '';

    if (!url || !note) return { ok: false, error: 'Missing url or note.' };

    const ss = _open();                                       // ← use openById
    let sh = ss.getSheetByName('Clip_Notes');
    if (!sh) {
      sh = ss.insertSheet('Clip_Notes');
      sh.getRange(1, 1, 1, 4).setValues([['Timestamp', 'ClipURL', 'Coach', 'Note']]);
    } else if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, 4).setValues([['Timestamp', 'ClipURL', 'Coach', 'Note']]);
    }

    sh.appendRow([new Date(), url, coach, note]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'saveClipNote error' };
  }
}






/** ====== NOTES VIEW (for Daily Ratings tooltips) ====== **
 * Sheet: Notes_View
 * Columns: A:Date | B:Session | C:Coach | D:Player | E:Note
 * Data starts on row 3 (rows 1–2 are headers)
 */
function getNotesIndexForRatings() {
  try {
    const ss = _open();
    const sh = ss.getSheetByName('Notes_View');
    if (!sh) return { ok:false, map:{} };

    const last = sh.getLastRow();
    if (last < 3) return { ok:true, map:{} };

    const tz = ss.getSpreadsheetTimeZone ? ss.getSpreadsheetTimeZone() : Session.getScriptTimeZone();

    // A: Date (as Date objects for reliable formatting)
    const dateVals = sh.getRange(3, 1, last - 2, 1).getValues();
    // B:E as strings
    const other    = sh.getRange(3, 2, last - 2, 4).getDisplayValues();
    //           session, coach, player, note

    const map = {}; // keys like "12/02/2025|player", "12 Feb 2025|player", "12/2/25|player" → [{coach,note,session}]

    for (let i = 0; i < dateVals.length; i++) {
      const dRaw = dateVals[i][0];
      const [session, coach, player, note] = other[i];

      const playerKey = String(player || '').trim().toLowerCase();
      const noteText  = String(note || '').trim();
      if (!(dRaw instanceof Date) || !playerKey || !noteText) continue;

      // Generate several display formats to cover differences between sheets/tables
      const f1 = Utilities.formatDate(dRaw, tz, 'dd/MM/yyyy'); // 12/02/2025
      const f2 = Utilities.formatDate(dRaw, tz, 'd/M/yy');     // 12/2/25
      const f3 = Utilities.formatDate(dRaw, tz, 'd MMM yyyy'); // 12 Feb 2025

      const payload = { coach: String(coach || '').trim(), note: noteText, session: String(session || '').trim() };

      [f1, f2, f3].forEach(dateKey => {
        const key = `${dateKey}|${playerKey}`;
        (map[key] = map[key] || []).push(payload);
      });
    }

    return { ok:true, map };
  } catch (e) {
    return { ok:false, error:String(e), map:{} };
  }
}



/************************************************************
 * Presence sheets helpers (Web App compatible)
 * - Uses SpreadsheetApp.openById(SHEET_ID)
 * - Creates/maintains:
 *    1) Presence_Online    → simple “who’s online now”
 *    2) Presence_Heartbeat → per-tab heartbeat table (userId/name/last seen)
 *    3) Presence_Log       → login/logout audit log
 ************************************************************/

/** ---------- Core open helper ---------- **/
function _open() {
  // Uses your global SHEET_ID constant
  return SpreadsheetApp.openById(SHEET_ID);
}

/** ---------- Timezone / formatting helpers ---------- **/
// Force everything we format in code to Europe/Athens
function _getTz_() {
  return 'Europe/Athens';
}

function _formatNowLocal_() {
  return Utilities.formatDate(new Date(), _getTz_(), 'dd/MM/yyyy HH:mm');
}

/** ======================================================
 *  A) Simple “who’s online now” (name-only)
 *     - recordPresence(name)  → call once on unlock
 *     - pingPresence(name)    → call every 30s
 *     - getOnlineUsers()      → returns users seen within ONLINE_WINDOW_MS
 * ====================================================== */

const PRESENCE_SHEET = 'Presence_Online';
const ONLINE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

function _getPresenceSheet_() {
  const ss = _open();
  let sh = ss.getSheetByName(PRESENCE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(PRESENCE_SHEET);
    sh.getRange(1,1,1,4).setValues([['Name','LastSeenEpoch','LastSeenLocal','Status']]);
    sh.getRange('A:A').setNumberFormat('@');                     // Name as text
    sh.getRange('B:B').setNumberFormat('0');                     // Epoch number
    sh.getRange('C:C').setNumberFormat('dd/MM/yyyy HH:mm');      // Local time
    sh.getRange('D:D').setNumberFormat('@');                     // Status text
  }
  return sh;
}
function _upsertPresenceRow_(name) {
  const sh = _getPresenceSheet_();
  const last = sh.getLastRow();
  const nowEpoch = Date.now();
  const nowLocal = _formatNowLocal_();

  if (last < 2) {
    sh.appendRow([name, nowEpoch, nowLocal, 'online']);
    return;
  }

  const names = sh.getRange(2,1,last-1,1).getValues(); // col A names
  for (let i = 0; i < names.length; i++) {
    if (String(names[i][0]).trim().toLowerCase() === name.toLowerCase()) {
      const r = i + 2;
      sh.getRange(r, 2, 1, 3).setValues([[nowEpoch, nowLocal, 'online']]);
      return;
    }
  }
  sh.appendRow([name, nowEpoch, nowLocal, 'online']);
}

/** Called once after successful login + name selection */
function recordPresence(name) {
  if (!name) return { ok:false, error:'No name' };
  _upsertPresenceRow_(name);
  return { ok:true };
}

/** Called periodically to keep the user online */
function pingPresence(name) {
  if (!name) return { ok:false, error:'No name' };
  _upsertPresenceRow_(name);
  return { ok:true };
}

/** Returns users seen within ONLINE_WINDOW_MS with server-formatted local time */
/** Returns users seen within ONLINE_WINDOW_MS with server-formatted local time */
function getOnlineUsers() {
  const sh = _getPresenceSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok:true, users:[] };

  const now = Date.now();
  const tz = _getTz_();
  const values = sh.getRange(2,1,last-1,4).getValues(); // Name, Epoch, Local, Status
  const users = values
    .map(r => {
      const name = String(r[0]||'').trim();
      const epoch = Number(r[1]||0);
      const lastSeen = epoch ? Utilities.formatDate(new Date(epoch), tz, 'dd/MM/yyyy HH:mm') : '';
      return { name, epoch, lastSeen };
    })
    .filter(u => u.name && isFinite(u.epoch) && (now - u.epoch) <= ONLINE_WINDOW_MS)
    .sort((a,b)=>a.name.localeCompare(b.name));

  return { ok:true, users };
}

/** ======================================================
 *  B) Heartbeat + Audit Log (per-tab sessions)
 *     - startPresenceSession(userId, userName)  → on unlock
 *     - recordHeartbeat(userId, userName)       → every 30s
 *     - endPresenceSession(userId, userName)    → on unload
 *     - getCurrentPresence()                     → who pinged within last 2 min
 *     - getPresenceLog(limit)                    → recent login/logout events
 * ====================================================== */

function _presenceEnsureHeartbeatSheet_() {
  const ss = _open();
  const name = 'Presence_Heartbeat';
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,3).setValues([['User ID','Name','Last Seen']]);
    sh.getRange('A:A').setNumberFormat('@');                // userId as text
    sh.getRange('B:B').setNumberFormat('@');                // name as text
    sh.getRange('C:C').setNumberFormat('dd/MM/yyyy HH:mm'); // last seen as datetime
  }
  return sh;
}
function _presenceEnsureLogSheet_() {
  const ss = _open();
  const name = 'Presence_Log';
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,4).setValues([['Timestamp','User ID','Name','Event']]);
    sh.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm'); // timestamp as datetime
    sh.getRange('B:B').setNumberFormat('@');                // userId
    sh.getRange('C:C').setNumberFormat('@');                // name
    sh.getRange('D:D').setNumberFormat('@');                // event
  }
  return sh;
}

/** Upsert heartbeat row by userId (col A) */
function recordHeartbeat(userId, userName) {
  try {
    const sh = _presenceEnsureHeartbeatSheet_();
    const now = new Date();
    const data = sh.getDataRange().getValues();
    let row = -1;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(userId)) { row = i + 1; break; }
    }
    if (row === -1) {
      row = sh.getLastRow() + 1;
      sh.getRange(row, 1, 1, 3).setValues([[String(userId), String(userName || ''), now]]);
    } else {
      // update name & last seen
      sh.getRange(row, 2, 1, 2).setValues([[String(userName || ''), now]]);
    }
    return { ok:true, ts: now.getTime() };
  } catch (e) {
    return { ok:false, error: String(e) };
  }
}

/** Mark a login event */
function startPresenceSession(userId, userName) {
  try {
    const sh = _presenceEnsureLogSheet_();
    const now = new Date();
    const tsLocal = Utilities.formatDate(now, _getTz_(), 'dd/MM/yyyy HH:mm:ss');
    // If you don’t want to change columns, replace r[0] with tsLocal only:
    sh.appendRow([tsLocal, String(userId), String(userName||''), 'login']);
    // keep heartbeat in sync
    recordHeartbeat(userId, userName);
    return { ok:true };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

function endPresenceSession(userId, userName) {
  try {
    const sh = _presenceEnsureLogSheet_();
    const now = new Date();
    const tsLocal = Utilities.formatDate(now, _getTz_(), 'dd/MM/yyyy HH:mm:ss');
    sh.appendRow([tsLocal, String(userId), String(userName||''), 'logout']);
    return { ok:true };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

/** Return users (userId/name) seen in last 2 minutes */
function getCurrentPresence() {
  try {
    const sh = _presenceEnsureHeartbeatSheet_();
    const rows = sh.getDataRange().getValues();
    const now = Date.now();
    const users = [];
    for (let i = 1; i < rows.length; i++) {
      const [id, name, lastSeen] = rows[i];
      const t = lastSeen instanceof Date ? lastSeen.getTime() : (new Date(lastSeen)).getTime();
      if (t && (now - t) < ONLINE_WINDOW_MS) {
        users.push({ id: String(id), name: String(name), lastSeen: t });
      }
    }
    return { ok:true, users };
  } catch (e) {
    return { ok:false, users:[], error:String(e) };
  }
}

/** Return last N log rows (default 200) */
function getPresenceLog(limit) {
  try {
    const sh = _presenceEnsureLogSheet_();
    const values = sh.getDataRange().getValues();
    const rows = values.slice(1); // skip header
    const out = rows.slice(-1 * (limit || 200)).map(r => ({
      timestamp: r[0] instanceof Date ? r[0] : new Date(r[0]),
      userId: String(r[1] || ''),
      name: String(r[2] || ''),
      event: String(r[3] || '')
    }));
    return { ok:true, rows: out };
  } catch (e) {
    return { ok:false, rows:[], error:String(e) };
  }
}







/**
 * Return dynamic notification messages for a coach.
 * Tries multiple optional sheets and only pushes messages it can compute.
 * Sheets it knows how to read if present:
 * - Presence_Log: [Timestamp, User ID, Name, Event]
 * - Ratings_Log:  [Timestamp, Coach, Player, Trait, Value, Date]
 * - Clip_Notes:   [Date, Coach, Player, URL, Note]
 * - Summaries:    [ID, Date, Title, AudienceType, AudienceName, Description, Status, CreatedBy]
 */
/** Personalized notifications from Notes_View (no Roster/Clip_Notes needed) */
/** Return coach-specific notifications (Notes_View-only) */
/** Return coach-specific notifications (PERSONALISED, Notes_View only + recent notes list) */
function getCoachNotifications(coachName) {
  try {
    if (!coachName) return { ok:false, error:'No coach' };

    // Visitor message as rich objects
    if (coachName === 'Visitor') {
      return {
        ok: true,
        messages: [
          {
            title: 'Visitor mode',
            body: 'Personalised notifications are disabled for this login.',
            kind: 'warn',
            actions: []
          },
          {
            title: 'Tip',
            body: 'Use a named coach password to see your own notes, coverage reminders, and recent activity.',
            kind: 'info',
            actions: []
          }
        ]
      };
    }

    const ss = _open();
    const tz = (ss.getSpreadsheetTimeZone && ss.getSpreadsheetTimeZone()) || Session.getScriptTimeZone();
    const nameLC = coachName.trim().toLowerCase();

    const sh = ss.getSheetByName('Notes_View');
    if (!sh) return { ok:true, messages:[{ title:'', body:`Welcome back, ${coachName}!`, kind:'info', actions:[] }] };

    const last = sh.getLastRow();
    if (last < 3) return { ok:true, messages:[{ title:'', body:`Welcome back, ${coachName}!`, kind:'info', actions:[] }] };

    const dateVals = sh.getRange(3, 1, last - 2, 1).getValues();
    const other    = sh.getRange(3, 2, last - 2, 4).getDisplayValues(); // session, coach, player, note

    const now      = new Date();
    const since48h = new Date(now.getTime() - 48*60*60*1000);
    const since7d  = new Date(now.getTime() - 7*24*60*60*1000);
    const since3d  = new Date(now.getTime() - 3*24*60*60*1000);
    const since30d = new Date(now.getTime() - 30*24*60*60*1000);

    const rows = [];
    for (let i = 0; i < dateVals.length; i++) {
      const d = dateVals[i][0];
      if (!(d instanceof Date) || isNaN(d)) continue;
      const [session, coach, player, note] = other[i].map(x => String(x || '').trim());
      if (!coach || !player) continue;
      rows.push({ date: d, session, coach, player, note });
    }

    const fmt = (d, f) => Utilities.formatDate(d, tz, f || 'dd MMM yyyy');

    // your tracked players = players you wrote about in last 30d
    const yourTracked = new Set(
      rows.filter(r => r.coach.toLowerCase() === nameLC && r.date >= since30d).map(r => r.player)
    );

    let newByYou48 = 0;
    let newByOthersOnYours48 = 0;
    let latestTarget = '';

    rows.filter(r => r.date >= since48h)
        .sort((a,b) => b.date - a.date)
        .forEach(r => {
          const isYou = r.coach.toLowerCase() === nameLC;
          if (isYou) newByYou48++;
          else if (yourTracked.size === 0 || yourTracked.has(r.player)) {
            newByOthersOnYours48++;
            if (!latestTarget) latestTarget = r.player;
          }
        });

    const recent48List = rows
      .filter(r => r.date >= since48h)
      .sort((a,b) => b.date - a.date)
      .slice(0, 4)
      .map(r => {
        const snip = r.note ? (r.note.length > 80 ? r.note.slice(0,77)+'…' : r.note) : '(no text)';
        return { player:r.player, coach:r.coach, session:r.session, date:r.date, snip };
      });

    let yourNotes7d = 0;
    const uniqPlayers7d = new Set();
    rows.forEach(r => {
      if (r.date >= since7d && r.coach.toLowerCase() === nameLC) {
        yourNotes7d++;
        uniqPlayers7d.add(r.player);
      }
    });

    const sessions3d = new Map(); // key = yyyy-MM-dd|session -> {date, session, coaches:Set}
    rows.filter(r => r.date >= since3d).forEach(r => {
      const key = fmt(r.date,'yyyy-MM-dd') + '|' + (r.session || '');
      if (!sessions3d.has(key)) sessions3d.set(key, { date:r.date, session:r.session || '', coaches: new Set() });
      sessions3d.get(key).coaches.add(r.coach.toLowerCase());
    });

    const uncovered = [];
    sessions3d.forEach(info => {
      if (!info.coaches.has(nameLC)) {
        uncovered.push(`${fmt(info.date,'EEE d MMM')}${info.session ? ' — '+info.session : ''}`);
      }
    });

    // Optional Daily_Ratings owed
    let oweCount = 0, oweLabels = [];
    const ratSh = ss.getSheetByName('Daily_Ratings');
    if (ratSh) {
      const vals = ratSh.getDataRange().getValues();
      if (vals.length >= 2) {
        const header = vals[0] || [];
        const colIdx = header.findIndex(h => String(h||'').trim().toLowerCase() === nameLC);
        if (colIdx > 0) {
          vals.slice(1).forEach(r => {
            const d = r[0] instanceof Date ? r[0] : new Date(r[0]);
            if (!(d instanceof Date) || isNaN(d) || d < since3d) return;
            const v = r[colIdx];
            if (v === '' || v == null) {
              oweCount++;
              oweLabels.push(fmt(d,'EEE d MMM'));
            }
          });
        }
      }
    }

    // === Build rich messages ===
    const messages = [];

    messages.push({
      title: 'Hey',
      body: `Welcome back, ${coachName}.`,
      kind: 'info',
      actions: []
    });

    if (newByOthersOnYours48 > 0) {
      messages.push({
        title: 'New notes on your players',
        body:
          `Staff added ${newByOthersOnYours48} note${newByOthersOnYours48>1?'s':''} ` +
          `about players you’re tracking in the last 48h` +
          (latestTarget ? ` — latest on ${latestTarget}.` : '.'),
        kind: 'info',
        actions: [{ type:'gotoTab', args:{ tab:'players' }, label:'Open Players' }]
      });
    }

    messages.push({
      title: (newByYou48 > 0 ? 'Nice momentum' : 'No notes in 48h'),
      body:  (newByYou48 > 0
                ? `You added ${newByYou48} note${newByYou48>1?'s':''} in the last 48h.`
                : 'No notes from you in the last 48h. Add quick notes to keep context current.'),
      kind:  (newByYou48 > 0 ? 'success' : 'warn'),
      actions: [{ type:'gotoTab', args:{ tab:'chat' }, label:'Open Chat' }]
    });

    if (uncovered.length) {
      const label = uncovered.slice(0,3).join(', ') + (uncovered.length>3 ? '…' : '');
      messages.push({
        title: 'Coverage reminder',
        body:  `No notes from you in the last 3 days for ${label}.`,
        kind:  'warn',
        actions: [{ type:'gotoTab', args:{ tab:'dailyratings' }, label:'Daily Ratings' }]
      });
    }

    if (oweCount > 0) {
      const datesLabel = oweLabels.slice(0,3).join(', ') + (oweLabels.length>3 ? '…' : '');
      messages.push({
        title: 'Ratings missing',
        body:  `You have ${oweCount} unrated day${oweCount>1?'s':''} in the last 3 days (${datesLabel}).`,
        kind:  'error',
        actions: [{ type:'gotoTab', args:{ tab:'dailyratings' }, label:'Rate now' }]
      });
    }

    messages.push({
      title: 'Last 7 days',
      body:  `You logged ${yourNotes7d} note${yourNotes7d===1?'':'s'} across ${uniqPlayers7d.size} player${uniqPlayers7d.size===1?'':'s'}.`,
      kind:  'info',
      actions: []
    });

    if (recent48List.length) {
      messages.push({
        title: 'Recent notes (48h)',
        body:  'Highlights from the last 48h:',
        kind:  'info',
        actions: [{ type:'gotoTab', args:{ tab:'players' }, label:'Review players' }]
      });
      recent48List.forEach(r => {
        messages.push({
          title: r.player,
          body:  `“${r.snip}” (${r.coach}, ${r.session || fmt(r.date,'d MMM')})`,
          kind:  'info',
          actions: [{ type:'gotoPlayer', args:{ name:r.player }, label:'Open player' }]
        });
      });
    }

    // ===== ADD: Clips pack (last 48h + quick actions) =====
    try {
      const clipSh = ss.getSheetByName('Clips') || ss.getSheetByName('Clips_View');
      if (clipSh) {
        const clipVals = clipSh.getDataRange().getDisplayValues();
        if (clipVals.length > 1) {
          const H = clipVals[0].map(h => String(h||'').trim().toLowerCase());
          const idx = (name) => H.findIndex(h => h === name);

          // Try common column names; tweak if yours differ
          const cDate   = idx('date');
          const cPlayer = idx('player');
          const cTheme  = idx('theme');
          const cSub    = idx('subtag') >= 0 ? idx('subtag') : idx('sub');
          const cType   = idx('type');
          const cUrl    = ['url','link','clip','video'].map(n=>idx(n)).find(i=>i>=0);
          const cCoach  = idx('coach');
          const cNotes  = idx('notes');

          const rowsClips = [];
          for (let i = 1; i < clipVals.length; i++) {
            const r = clipVals[i];
            const d = (cDate>=0) ? new Date(r[cDate]) : null;
            if (!(d instanceof Date) || isNaN(d)) continue;
            const player = cPlayer>=0 ? String(r[cPlayer]||'').trim() : '';
            const theme  = cTheme>=0  ? String(r[cTheme] ||'').trim() : '';
            const sub    = cSub>=0    ? String(r[cSub]   ||'').trim() : '';
            const type   = cType>=0   ? String(r[cType]  ||'').trim() : '';
            const url    = cUrl>=0    ? String(r[cUrl]   ||'').trim() : '';
            const coach  = cCoach>=0  ? String(r[cCoach] ||'').trim() : '';
            const notes  = cNotes>=0  ? String(r[cNotes] ||'').trim() : '';
            rowsClips.push({ d, player, theme, sub, type, url, coach, notes });
          }

          // New clips in last 48h, biased to your tracked players
          const clips48 = rowsClips
            .filter(c => c.d >= since48h)
            .sort((a,b) => b.d - a.d);

          const clipsByOthersOnYours = clips48.filter(c =>
            (!c.coach || c.coach.toLowerCase() !== nameLC) &&
            (yourTracked.size === 0 || yourTracked.has(c.player))
          );

          if (clipsByOthersOnYours.length) {
            const top = clipsByOthersOnYours[0];
            messages.push({
              title: 'New clips on your players',
              body:
                `${clipsByOthersOnYours.length} new clip${clipsByOthersOnYours.length>1?'s':''} ` +
                `in the last 48h` + (top.player ? ` — latest on ${top.player}.` : '.'),
              kind: 'info',
              actions: [
                { type:'gotoTab', args:{ tab:'clips' }, label:'Open Clips' },
                ...(top.url ? [{ type:'openClip', args:{ url: top.url }, label:'Play latest' }] : [])
              ]
            });
          }

          // Your own new clips (handy to jump back and caption)
          const yourClips48 = clips48.filter(c => c.coach && c.coach.toLowerCase() === nameLC);
          if (yourClips48.length) {
            const first = yourClips48[0];
            messages.push({
              title: 'Your recent clips',
              body:  `You added ${yourClips48.length} clip${yourClips48.length>1?'s':''} in the last 48h.`,
              kind:  'success',
              actions: [
                { type:'gotoClipsFilter',
                  args:{ player:(first.player||''), theme:(first.theme||''), sub:(first.sub||'') },
                  label:'Filter to player' },
                ...(first.url ? [{ type:'openClip', args:{ url:first.url }, label:'Reopen last' }] : [])
              ]
            });
          }

          // Your clips missing notes (last 7d)
          const yourClipsNoNotes7d = rowsClips.filter(c =>
            c.d >= since7d &&
            c.coach && c.coach.toLowerCase() === nameLC &&
            (!c.notes || !c.notes.trim())
          );
          if (yourClipsNoNotes7d.length) {
            const sample = yourClipsNoNotes7d[0];
            messages.push({
              title: 'Add quick captions?',
              body:  `${yourClipsNoNotes7d.length} of your clips from the last 7 days have no notes/captions.`,
              kind:  'warn',
              actions: [
                { type:'gotoTab', args:{ tab:'clips' }, label:'Go to Clips' },
                ...(sample.url ? [{ type:'openClip', args:{ url:sample.url }, label:'Open one' }] : [])
              ]
            });
          }
        }
      }
    } catch (e) {
      // Non-fatal: skip clips block if any error
    }

    // ===== ADD: Practice-load (Strength) cards from external sheet =====
    try {
      const practiceCards = _practiceLoadNotifyCardsFromSheet_(); // <- your helper reading the separate sheet
      if (practiceCards && practiceCards.length) {
        messages.push(...practiceCards);
      }
    } catch (e) {
      // Non-fatal: strength sheet not ready or unreachable
    }

    // Optional: dedupe (title+body) to avoid repeats
    const seen = new Set();
    const deduped = [];
    messages.forEach(m => {
      const key = (m.title || '') + '|' + (m.body || '');
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push(m);
    });

    return { ok:true, messages: deduped };
  } catch (e) {
    return {
      ok:true,
      messages:[{ title:'Heads up', body:`Hi ${coachName}, notifications are temporarily unavailable.`, kind:'warn', actions:[] }]
    };
  }
}





/***** ===== Coach Chat API ===== *****/

// REPLACE your _chatEnsureSheet_ with this
function _chatEnsureSheet_() {
  const ss = _open();
  let sh = ss.getSheetByName('Coach_Chat');
  if (!sh) {
    sh = ss.insertSheet('Coach_Chat');
    sh.getRange(1,1,1,5).setValues([['Timestamp','From','To','Message','Attachments']]);
    sh.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm'); // display nicely
    sh.getRange('B:D').setNumberFormat('@');
    sh.getRange('E:E').setNumberFormat('@');
    return sh;
  }

  // Ensure Attachments column exists as col E
  const header = sh.getRange(1, 1, 1, Math.max(5, sh.getLastColumn())).getDisplayValues()[0];
  if (String(header[4] || '').trim().toLowerCase() !== 'attachments') {
    // if the sheet only has 4 cols, add a 5th and label it
    if (sh.getLastColumn() < 5) sh.insertColumnAfter(4);
    sh.getRange(1,5).setValue('Attachments');
    sh.getRange('E:E').setNumberFormat('@');
  }
  return sh;
}

/** Return distinct list of coach names (from your PASSWORD_USERS map) */
function getCoachesList() {
  try {
    const names = new Set();

    Object.values(PASSWORD_USERS || {}).forEach(n => {
      const v = String(n || '').trim();
      if (v && v.toLowerCase() !== 'visitor') names.add(v);
    });

    const ss = _open();
    const listsSheet = ss.getSheetByName('Lists');
    if (listsSheet) {
      const last = listsSheet.getLastRow();
      if (last >= 2) {
        const vals = listsSheet.getRange(2, 1, last - 1, 1).getDisplayValues(); // column A
        vals.forEach(r => {
          const v = String(r[0] || '').trim();
          if (v && v.toLowerCase() !== 'visitor') names.add(v);
        });
      }
    }

    const logSheet = ss.getSheetByName('Log');
    if (logSheet) {
      const last = logSheet.getLastRow();
      if (last >= 2) {
        const vals = logSheet.getRange(2, 3, last - 1, 1).getDisplayValues(); // coach col
        vals.forEach(r => {
          const v = String(r[0] || '').trim();
          if (v && v.toLowerCase() !== 'visitor') names.add(v);
        });
      }
    }

    const chatSheet = ss.getSheetByName('Coach_Chat');
    if (chatSheet) {
      const last = chatSheet.getLastRow();
      if (last >= 2) {
        const vals = chatSheet.getRange(2, 2, last - 1, 2).getDisplayValues(); // from/to
        vals.forEach(row => {
          const from = String(row[0] || '').trim();
          const to   = String(row[1] || '').trim();
          if (from && from.toLowerCase() !== 'visitor') names.add(from);
          if (to && to.toLowerCase() !== 'all' && to.toLowerCase() !== 'visitor') names.add(to);
        });
      }
    }

    const list = Array.from(names).sort((a,b)=>a.localeCompare(b, undefined, {sensitivity:'base'}));
    return { ok:true, coaches: list };
  } catch (e) {
    return { ok:false, coaches:[], error:String(e) };
  }
}

/** Post a chat message.
 * payload = { from: 'Dimitris', to: 'All' | 'Xristoforos' | 'Konstantinos'..., message: 'text' }
 */
// REPLACE your postCoachMessage with this extended version
function postCoachMessage(payload) {
  try {
    const from = String(payload?.from || '').trim();
    const to   = String(payload?.to   || '').trim() || 'All';
    const msg  = String(payload?.message || '').trim();
    const attachments = Array.isArray(payload?.attachments)
      ? payload.attachments.filter(Boolean).map(u => String(u).trim())
      : [];

    if (!from || !msg) return { ok:false, error:'Missing sender or message.' };

    const sh = _chatEnsureSheet_();
    sh.appendRow([new Date(), from, to, msg, attachments.join(' | ')]);
    return { ok:true, attachments: attachments.length };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

/** Fetch recent messages for a coach.
 * args = { forName:'Dimitris', sinceEpoch?:number, limit?:number }
 * - Returns messages where To === 'All' OR To === forName OR From === forName (so you see your own).
 * - Ordered newest->oldest, limited.
 */
// REPLACE your getCoachMessages with this (only the mapping part changed)
function getCoachMessages(args) {
  try {
    const forName    = String(args?.forName || '').trim();
    const sinceEpoch = Number(args?.sinceEpoch || 0);
    const limit      = Math.max(10, Math.min(300, Number(args?.limit || 120)));

    const sh = _chatEnsureSheet_();
    const last = sh.getLastRow();
    if (last < 2) return { ok:true, rows:[] };

    const vals = sh.getRange(2,1,last-1,5).getValues(); // A:E
    const rows = [];
    for (let i = vals.length - 1; i >= 0; i--) { // newest first
      const [ts, from, to, message, attsStr] = vals[i];
      const t  = (ts instanceof Date && !isNaN(ts)) ? ts.getTime() : 0;
      if (sinceEpoch && t && t <= sinceEpoch) break;

      const toStr   = String(to || '').trim();
      const fromStr = String(from || '').trim();
      const msgStr  = String(message || '').trim();
      const attachments = String(attsStr || '').split(' | ').map(s => s.trim()).filter(Boolean);

      if (!msgStr && !attachments.length) continue;

      const directedToMe = !forName ? true : (toStr.toLowerCase() === 'all' || toStr.toLowerCase() === forName.toLowerCase());
      const mine = forName && fromStr.toLowerCase() === forName.toLowerCase();

      if (directedToMe || mine) {
        rows.push({
          ts: t,
          dateStr: Utilities.formatDate(new Date(t || 0), _getTz_ ? _getTz_() : (SpreadsheetApp.getActive().getSpreadsheetTimeZone() || 'Europe/Athens'), 'dd/MM/yyyy HH:mm'),
          from: fromStr,
          to: toStr || 'All',
          message: msgStr,
          attachments
        });
        if (rows.length >= limit) break;
      }
    }
    return { ok:true, rows };
  } catch (e) {
    return { ok:false, rows:[], error:String(e) };
  }
}


/** Reads Opponents sheet and returns a clean rows array */
/** Reads Opponents sheet and returns a clean rows array */
function getOpponents() {
  try {
    const ss = _open(); // uses your SHEET_ID config
    const sh = ss.getSheetByName('Opponents');
    if (!sh) return { ok:false, error:'Sheet "Opponents" not found.' };

    const rng = sh.getDataRange().getValues();
    if (rng.length < 2) return { ok:true, rows: [] };

    const headers = rng[0].map(String);
    const idx = {
      team: headers.indexOf('Team'),
      off:  headers.indexOf('video.offense'),
      def:  headers.indexOf('video.defense'),
      rq:   headers.indexOf('report.quick'),
      rf:   headers.indexOf('report.full')       // make sure header matches exactly
      
    };

    const rows = rng.slice(1)
      .filter(r => (r[idx.team] || '').toString().trim())
      .map(r => ({
        team:        (r[idx.team] || '').toString().trim(),
        offense:     (r[idx.off]  || '').toString().trim(),
        defense:     (r[idx.def]  || '').toString().trim(),
        reportQuick: (r[idx.rq]   || '').toString().trim(),
        reportFull:  (r[idx.rf]   || '').toString().trim()
        
      }));

    rows.sort((a,b) => a.team.localeCompare(b.team, undefined, {sensitivity:'base'}));
    return { ok:true, rows };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}



/** Returns detail for a specific team (case-insensitive) */
function getOpponentDetail(team) {
  try {
    if (team == null) return { ok:false, error:'Missing team.' };
    // ✅ handle values passed as encodeURIComponent(...)
    const want = decodeURIComponent(String(team)).trim().toLowerCase();

    const all = getOpponents();
    if (!all.ok) return all;

    const row = all.rows.find(r => String(r.team || '').toLowerCase() === want);
    if (!row) return { ok:false, error:'Team not found.' };

    return { ok:true, team: row.team, offense: row.offense, defense: row.defense,
             reportQuick: row.reportQuick, reportFull: row.reportFull,reportIndiv: row.reportIndiv };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

function getOpponentsDebug() {
  try {
    const ss = _open();
    const sh = ss.getSheetByName('Opponents');
    if (!sh) return { ok:false, where:'open', note:'Opponents not found in this file', file: ss.getName() };

    const rng = sh.getDataRange().getValues();
    const headers = rng[0] || [];
    return {
      ok: true,
      file: ss.getName(),
      sheet: sh.getName(),
      rows: Math.max(0, rng.length - 1),
      headers,
      first3: rng.slice(1, 4)
    };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}




/** LIST: include week + video minutes so the client can show them */
function getPracticeLoadSummaries() {
  const sh = _openPractice_();
  if (!sh) return { ok:true, rows:[] };
  const vals = sh.getDataRange().getDisplayValues();
  if (vals.length < 2) return { ok:true, rows:[] };

  const H = vals[0].map(h => String(h||'').trim().toLowerCase());
  const idx = (name) => H.indexOf(name);

  const cWeek   = idx('week');
  const cDate   = idx('date');
  const cDay    = idx('day');
  const cMin    = idx('practice minutes');
  const cPI     = idx('physical intensity');
  const cVidS   = idx('video sessions');
  const cVidM   = idx('video minutes');

  // daily loads for severity / trend cues
  const daily = _buildDailyMap_();

  // Build rows; id = ISO date
  const rows = vals.slice(1).map(r => {
    const d  = _parseDMYorISO_(r[cDate]);
    if (!d) return null;
    const iso  = _fmtISO_(d);
    const day  = r[cDay] || '';
    const mins = Number(r[cMin] || 0);
    const pi   = r[cPI] || '';
    const week = cWeek >= 0 ? r[cWeek] : '';
    const vs   = cVidS >= 0 ? Number(r[cVidS] || 0) : 0;
    const vm   = cVidM >= 0 ? Number(r[cVidM] || 0) : 0;

    // severity from computed metrics on that day
    const acwr = _acwr_(daily, iso);
    const mono = _monoStrain_(daily, iso).monotony;
    const sev  = _severity_(daily[iso] || 0, acwr, mono);

    return {
      id: iso,
      date: iso,
      title: `${day} — ${mins}min • ${pi}`,   // client can still use this
      audienceType: 'team',
      audienceName: 'All',
      severity: sev,
      // extra bits the client can show
      week,
      videoSessions: vs,
      videoMinutes: vm
    };
  }).filter(Boolean)
    .sort((a,b) => new Date(b.date) - new Date(a.date));

  return { ok:true, rows };
}

/** DETAIL: return ALL raw columns (+ computed metrics) so the modal can print them */
function getPracticeLoadDetail(id) {
  const sh = _openPractice_();
  if (!sh) return { ok:false, error:'Practice sheet not found' };
  const vals = sh.getDataRange().getDisplayValues();
  if (vals.length < 2) return { ok:false, error:'No data' };

  const H = vals[0].map(h => String(h||'').trim().toLowerCase());
  const idx = (name) => H.indexOf(name);

  const cWeek   = idx('week');
  const cDate   = idx('date');
  const cDay    = idx('day');
  const cMin    = idx('practice minutes');
  const cPI     = idx('physical intensity');
  const cDtg    = idx('days till game');
  const cTrav   = idx('travel?');
  const cVidS   = idx('video sessions');
  const cVidM   = idx('video minutes');
  const cBFI    = idx('bfi load');
  const cBFIb   = idx('bfi before');
  const cBFIa   = idx('bfi after');
  const cPLI    = idx('pli load');
  const cPLIb   = idx('pli before');
  const cPLIa   = idx('pli after');
  const cCLI    = idx('cli load');
  const cCLIb   = idx('cli before');
  const cCLIa   = idx('cli after');
  const cNotes  = idx('notes');
  const cTs     = idx('timestamp');

  // find record by ISO id (yyyy-MM-dd)
  const row = vals.slice(1).find(r => _fmtISO_(_parseDMYorISO_(r[cDate])) === String(id));
  if (!row) return { ok:false, error:'Not found' };

  const iso  = String(id);
  const day  = row[cDay] || '';
  const mins = Number(row[cMin] || 0);
  const pi   = row[cPI] || '';
  const rpe  = (function toRPE(s){ const m=String(s||'').match(/(\d+(?:\.\d+)?)/); return m?Number(m[1]):_rpeFromIntensity_(s); })(pi);
  const load = Math.round(mins * (isFinite(rpe)? rpe : 5));

  const daily = _buildDailyMap_();
  const acwr = _acwr_(daily, iso);
  const ms   = _monoStrain_(daily, iso);

  // Simple narrative
  const positives = [];
  const suggestions = [];
  if (rpe <= 5) positives.push('Light to moderate intensity — good for recovery.');
  if (load > 600) suggestions.push('High session load — ensure recovery modalities are in place.');
  if (acwr != null && acwr >= 0.8 && acwr <= 1.3) positives.push('ACWR in sweet spot (0.8–1.3).');
  if (acwr != null && acwr > 1.5) suggestions.push('ACWR elevated (>1.5). Consider a taper next session.');
  if (ms.monotony > 2.0) suggestions.push('High monotony — add variation across the week.');
  if (!positives.length) positives.push('—');
  if (!suggestions.length) suggestions.push('—');

  const toNum = v => { const n = Number(v); return isFinite(n) ? n : null; };
  const toBool = v => /^true$/i.test(String(v||'').trim());

   // … keep everything above as-is …

  // Build description lines so the existing HTML shows all key facts
   const insights = _plInsightCards_({
    sessionLoad: load,
    acwr: acwr,
    monotony: ms.monotony,
    strain: ms.strain,
    daysTillGame: toNum(row[cDtg]),
    travel: toBool(row[cTrav]),
    videoMinutes: toNum(row[cVidM])
  });

  return {
    ok: true,
    id: iso,
    title: `${iso} Load Summary`,
    date: iso,
    audienceType: 'team',
    audienceName: 'All',
    description: String(row[cNotes] || ''),

    sessionLoad: load,
    acwr: acwr == null ? null : Number(acwr.toFixed(2)),
    monotony: Number(ms.monotony.toFixed(2)),
    strain: Math.round(ms.strain),

    trend: _trend14_(daily, iso),

    // existing raw fields...
    week: row[cWeek] || '',
    day,
    practiceMinutes: mins,
    physicalIntensity: pi,
    physicalIntensityRPE: isFinite(rpe) ? rpe : null,
    daysTillGame: toNum(row[cDtg]),
    travel: toBool(row[cTrav]),
    videoSessions: toNum(row[cVidS]),
    videoMinutes: toNum(row[cVidM]),
    bfiLoad: toNum(row[cBFI]),
    bfiBefore: toNum(row[cBFIb]),
    bfiAfter: toNum(row[cBFIa]),
    pliLoad: toNum(row[cPLI]),
    pliBefore: toNum(row[cPLIb]),
    pliAfter: toNum(row[cPLIa]),
    cliLoad: toNum(row[cCLI]),
    cliBefore: toNum(row[cCLIb]),
    cliAfter: toNum(row[cCLIa]),
    timestamp: row[cTs] || '',

    // NEW:
    insights
  };
}

/** Cards for Coach Notify (unchanged logic, now uses sheet directly) */
function _practiceLoadNotifyCardsFromSheet_() {
  const sh = _openPractice_();
  if (!sh) return [];
  const vals = sh.getDataRange().getDisplayValues();
  if (vals.length < 2) return [];

  const H = vals[0].map(h=>h.trim().toLowerCase());
  const idx = (name) => H.indexOf(name);
  const cDate = idx('date');
  const cDay  = idx('day');
  const cMin  = idx('practice minutes');
  const cPI   = idx('physical intensity');
  const cPLI  = idx('pli load');
  const cBFI  = idx('bfi load');

  const cards = [];
  const now = new Date();
  const since48h = new Date(now.getTime() - 48*60*60*1000);

  vals.slice(1).forEach(r => {
    const d = _parseDMYorISO_(r[cDate]);
    if (!d || d < since48h) return;

    const day  = r[cDay] || '';
    const mins = Number(r[cMin] || 0);
    const rpe  = (function toRPE(s){ const m=String(s||'').match(/(\d+(?:\.\d+)?)/); return m?Number(m[1]):_rpeFromIntensity_(s); })(r[cPI]);
    const load = Math.round(mins * (isFinite(rpe)? rpe : 5));
    const pli  = Number(r[cPLI] || 0);
    const bfi  = Number(r[cBFI] || 0);

    let kind = 'info';
    let body = `${day} — ${mins}min, RPE ${isFinite(rpe)? rpe: '—'}, load ${load}`;
    if (load > 600 || pli > 25) { kind = 'warn'; body += ' • High strain'; }
    else if (bfi < 10) { body += ' • Mentally fresh'; }

    cards.push({
      title: 'Practice Load',
      body,
      kind,
      actions: [{ type:'gotoTab', label:'Open Practice Load', args:{ tab:'strength' } }]
    });
  });

  return cards;
}

/** Turn metrics into plain-language insight cards for the modal */
function _plInsightCards_({ sessionLoad, acwr, monotony, strain, daysTillGame, travel, videoMinutes }) {
  const cards = [];

  // Session Load
  if (sessionLoad != null) {
    if (sessionLoad < 350) {
      cards.push({ kind:'success', title:'Light day', body:'Good for recovery and teaching focus.' });
    } else if (sessionLoad <= 600) {
      cards.push({ kind:'info', title:'Solid working day', body:'Appropriate stimulus without heavy fatigue.' });
    } else {
      cards.push({ kind:'warn', title:'Heavy session', body:'Plan recovery modalities (sleep, hydration, mobility).' });
    }
  }

  // ACWR
  if (acwr != null) {
    if (acwr >= 0.8 && acwr <= 1.3) {
      cards.push({ kind:'success', title:'ACWR in sweet spot', body:'Load is balanced vs. recent norm (0.8–1.3).' });
    } else if (acwr > 1.3 && acwr <= 1.5) {
      cards.push({ kind:'info', title:'ACWR trending high', body:'Slight spike vs. 28-day average — monitor freshness.' });
    } else if (acwr > 1.5) {
      cards.push({ kind:'warn', title:'ACWR spike', body:'Acute 7-day load is high vs. chronic 28-day. Consider a lighter next session.' });
    } else if (acwr < 0.8) {
      cards.push({ kind:'info', title:'ACWR low', body:'Week is light vs. chronic load — useful during taper/recovery.' });
    }
  }

  // Monotony & Strain
  if (monotony != null) {
    if (monotony > 2.0) {
      cards.push({ kind:'warn', title:'High monotony', body:'Days look too similar — add variation (hard/medium/light) to reduce fatigue risk.' });
    } else if (monotony < 1.0) {
      cards.push({ kind:'success', title:'Good variety', body:'Healthy spread of loads across the week.' });
    }
  }
  if (strain != null) {
    if (strain > 8000) {
      cards.push({ kind:'warn', title:'High weekly strain', body:'Total stress is elevated — prioritize recovery and monitor responses.' });
    } else if (strain > 2000) {
      cards.push({ kind:'info', title:'Moderate weekly strain', body:'Manageable overall stress; keep an eye on sleep and soreness.' });
    } else {
      cards.push({ kind:'success', title:'Low weekly strain', body:'Overall week stress is light.' });
    }
  }

  // Context cues
  if (typeof daysTillGame === 'number') {
    if (daysTillGame === 1) {
      cards.push({ kind:'info', title:'E-1', body:'Day before game — keep it short/sharp; preserve freshness.' });
    } else if (daysTillGame === 0) {
      cards.push({ kind:'success', title:'Gameday', body:'Activate, not accumulate — prime neuromuscular readiness.' });
    }
  }

  if (travel === true) {
    cards.push({ kind:'info', title:'Travel day', body:'Add mobility, fluids, and brief movement to offset stiffness.' });
  }

  if (typeof videoMinutes === 'number' && videoMinutes > 0) {
    if (videoMinutes >= 20) {
      cards.push({ kind:'info', title:'Long video block', body:'Break up with brief movement to maintain attention.' });
    } else {
      cards.push({ kind:'success', title:'Short video', body:'Concise review supports learning without fatigue.' });
    }
  }

  return cards;
}




/** Minimal: return practice-session loads by label "dd-MMM" (e.g., "04-Oct") */
function getPracticeLoadSeriesSimple() {
  try {
    const sh = SpreadsheetApp.openById(PRACTICE_DOC_ID).getSheetByName(PRACTICE_SHEET_NAME);
    if (!sh) return { ok:false, reason:'Practice sheet not found' };

    const disp = sh.getDataRange().getDisplayValues();  // display strings
    if (disp.length < 2) return { ok:false, reason:'No data' };

    // Case-insensitive header map
    const H = disp[0].map(h => String(h || '').trim().toLowerCase());
    const cLabel = H.indexOf('dd-mmm');                 // helper col (U)
    const cDate  = H.indexOf('date');                   // B
    const cMin   = H.indexOf('practice minutes');
    const cPI    = H.indexOf('physical intensity');
    if (cMin < 0 || cPI < 0) return { ok:false, reason:'Missing columns Practice Minutes / Physical Intensity' };

    const norm = s => String(s||'')
      .trim()
      .replace(/\u2013|\u2014/g, '-')   // en/em dash → hyphen
      .replace(/\s+/g,' ')
      .toUpperCase();                   // align with client normalization

    const toRPE = (s) => {
      const m = String(s||'').match(/(\d+(?:\.\d+)?)/);
      if (m) return Number(m[1]);
      const lc = String(s||'').toLowerCase();
      if (lc.includes('very high')) return 8;
      if (lc.includes('high'))      return 7;
      if (lc.includes('medium'))    return 5;
      if (lc.includes('low'))       return 3;
      return 5;
    };

    const byLabel = {};
    const orderKey = {};

    for (let i = 1; i < disp.length; i++) {
      // Prefer helper label (U). If empty, derive from Date (B) display value.
      let rawLab = cLabel >= 0 ? (disp[i][cLabel] || '') : '';
      if (!rawLab && cDate >= 0) rawLab = disp[i][cDate] || '';

      // If Date is dd/MM/yyyy, convert to dd-MMM first
      let labelUpper = norm(rawLab);
      if (cDate >= 0 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(rawLab)) {
        const [dd, mm, yyyy] = String(disp[i][cDate]).split('/');
        const d = new Date(+yyyy, +mm - 1, +dd);
        labelUpper = norm(Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd-MMM'));
      }
      if (!labelUpper) continue;

      const mins = Number(String(disp[i][cMin] || '').replace(',', '.')) || 0;
      const rpe  = toRPE(disp[i][cPI]);
      const load = (mins > 0 && isFinite(rpe)) ? Math.round(mins * rpe) : 0;
      if (load <= 0) continue;

      byLabel[labelUpper] = (byLabel[labelUpper] || 0) + load;
      if (!orderKey[labelUpper]) orderKey[labelUpper] = i; // stable by first occurrence
    }

    const labelsUpper = Object.keys(byLabel).sort((a,b)=> orderKey[a]-orderKey[b]);
    const loads       = labelsUpper.map(l => byLabel[l]);

    // Send “pretty” labels down too (dd-MMM with original case) — optional
    const pretty = labelsUpper.map(s => {
      // revert to Title Case for months (e.g., 04-OCT -> 04-Oct)
      return s.replace(/^(\d{2})-([A-Z][A-Z][A-Z])$/, (_, d, m) =>
        d + '-' + m[0] + m.slice(1).toLowerCase()
      );
    });

    return { ok:true, labels: pretty, loads };
  } catch (e) {
    return { ok:false, reason:String(e) };
  }
}


/** =============== STATS (server) =============== **/
const STATS_SHEET_NAME = 'stats';
const STATS_TEAM_NAME  = 'Peristeri BC'; // for the league table row match

function _openStats_() {
  const ss = _open(); // your global opener
  const sh = ss.getSheetByName(STATS_SHEET_NAME);
  if (!sh) throw new Error(`Sheet "${STATS_SHEET_NAME}" not found`);
  return sh;
}

/** Safe number parse (supports commas). Returns null on non-numeric. */
function _num(x) {
  if (x === '' || x == null) return null;
  const n = parseFloat(String(x).replace(/,/g, '.'));
  return isFinite(n) ? n : null;
}
/** Zero-default numeric helper for arithmetic (keeps UI nulls separate). */
function _nz(x) {
  const n = _num(x);
  return n == null ? 0 : n;
}

/** Read a block as objects (header = first row) */
function _readBlock_(sh, a1) {
  const rng = sh.getRange(a1);
  const v   = rng.getValues();
  if (!v.length) return { headers:[], rows:[] };
  const headers = v[0].map(h => String(h||'').trim());
  const rows = v.slice(1)
    .filter(r => r.some(c => String(c).trim() !== ''))
    .map(r => {
      const obj = {};
      headers.forEach((h,i) => obj[h] = r[i]);
      return obj;
    });
  return { headers, rows };
}

function _parseTeamPerGameRow_(row) {
  if (!row) return null;
  const num = (key) => _num(row[key]);
  const threeMadeHeader = ('15:00' in row) ? '15:00' : ('3PM' in row ? '3PM' : null);
  return {
    gp:     num('GP'),
    mpg:    num('MPG'),
    ppg:    num('PPG'),
    fgm:    num('FGM'),
    fga:    num('FGA'),
    fgPct:  num('FG%'),
    threePm: threeMadeHeader ? num(threeMadeHeader) : null,
    threePa: num('3PA'),
    threePct:num('3P%'),
    ftm:    num('FTM'),
    fta:    num('FTA'),
    ftPct:  num('FT%'),
    orb:    num('ORB'),
    drb:    num('DRB'),
    rpg:    num('RPG'),
    apg:    num('APG'),
    spg:    num('SPG'),
    bpg:    num('BPG'),
    tov:    num('TOV'),
    pf:     num('PF')
  };
}

function _avgTeamPerGame_(rows) {
  const keys = ['gp','mpg','ppg','fgm','fga','fgPct','threePm','threePa','threePct','ftm','fta','ftPct','orb','drb','rpg','apg','spg','bpg','tov','pf'];
  const sums = {};
  const counts = {};
  rows.forEach(r => {
    keys.forEach(k => {
      const v = r[k];
      if (v == null || isNaN(v)) return;
      sums[k] = (sums[k] || 0) + v;
      counts[k] = (counts[k] || 0) + 1;
    });
  });
  const avg = {};
  keys.forEach(k => {
    if (counts[k]) avg[k] = sums[k] / counts[k];
    else avg[k] = null;
  });
  return avg;
}

/** Build derived rates from per-game block (A40:W52) – per-40 (FIBA 40) */
function _buildPlayerRates_(rows) {
  return rows.map(r => {
    const player = String(r['Player']||'').trim();
    const team   = String(r['Team']||'').trim();

    const MPG    = _nz(r['MPG']);
    const PTS    = _nz(r['PPG']);
    const FGA    = _nz(r['FGA']);

    // 3PM may be labeled "3PM" or "15:00" (your 3PM column)
    const PM3    = ('3PM' in r) ? _nz(r['3PM']) : _nz(r['15:00']);
    const PA3    = _nz(r['3PA']);

    const FTA    = _nz(r['FTA']);
    const REB    = _nz(r['RPG']);
    const AST    = _nz(r['APG']);
    const STL    = _nz(r['SPG']);
    const BLK    = _nz(r['BPG']);
    const TOV    = _nz(r['TOV']);
    const PF     = _nz(r['PF']);

    const hasMP  = MPG > 0;
    const per40  = hasMP ? (x)=> (x/MPG)*40 : ()=>null;

    const threePar = FGA>0 ? (PA3/FGA) : null;
    const fTr      = FGA>0 ? (FTA/FGA) : null;
    const pps      = FGA>0 ? (PTS/FGA) : null;
    const stocks40 = hasMP ? ((STL+BLK)/MPG*40) : null;

    const out = {
      player, team,
      mpg: MPG, ppg: PTS, fga: FGA, pm3: PM3, pa3: PA3, fta: FTA,
      rpg: REB, apg: AST, spg: STL, bpg: BLK, tov: TOV, pf: PF,
      threePar, fTr, pps,

      // per-40 outputs (FIBA 40)
      per40_pts:     per40(PTS),
      per40_reb:     per40(REB),
      per40_ast:     per40(AST),
      per40_tov:     per40(TOV),
      per40_stl:     per40(STL),
      per40_blk:     per40(BLK),
      per40_stocks:  stocks40,
      per40_3pa:     per40(PA3),
      per40_3pm:     per40(PM3)
    };

    // Back-compat for any old UI keys expecting per36_*
    ['pts','reb','ast','tov','stl','blk','stocks','3pa','3pm'].forEach(k=>{
      const v = out['per40_'+k];
      if (v != null) out['per36_'+k] = v;
    });

    return out;
  });
}

/** Join advanced table metrics into playerRates by Player */
function _joinAdvanced_(rates, advRows) {
  const map = new Map();
  advRows.forEach(r => {
    const key = String(r['Player']||'').trim().toLowerCase();
    if (key) map.set(key, r);
  });

  return rates.map(p => {
    const adv = map.get(String(p.player).toLowerCase()) || {};
    const getN = (k) => _num(adv[k]); // returns null when not numeric

    return Object.assign({}, p, {
      ts:     getN('TS%'),
      efg:    getN('eFG%'),
      usg:    getN('USG%'),
      ortg:   getN('ORtg'),
      drtg:   getN('DRtg'),
      ediff:  getN('eDiff'),
      per:    getN('PER'),

      // NEW: bring over AST% and TOV% (as 0–100 numbers, same as your sheet)
      astPct: getN('AST%'),
      tovPct: getN('TOV%')
    });
  });
}

/** Simple coach flags per player (now using per-40) */
/** Simple, concise coach flags (max N per player) */
/** Concise coach flags (max 2), offense-first, no double-defense */
function _buildFlags_(p, maxFlags = 2) {
  const has = v => v != null && v !== '' && !isNaN(v);
  const val = k => has(p[k]) ? Number(p[k]) : null;

  const pts40   = val('per40_pts');
  const ast40   = val('per40_ast');
  const tov40   = val('per40_tov');
  const reb40   = val('per40_reb');
  const stocks40= val('per40_stocks');
  const threePar= p.threePar;
  const pa3     = p.pa3;
  const p3pct   = has(p['3P%']) ? Number(p['3P%']) : null;
  const ts      = has(p.ts) ? Number(p.ts) : null;
  const usg     = has(p.usg) ? Number(p.usg) : null;
  const ortg    = has(p.ortg)? Number(p.ortg): null;
  const drtg    = has(p.drtg)? Number(p.drtg): null;
  const fTr     = has(p.fTr) ? Number(p.fTr) : null;

  const cand = [];
  const add = (ok, label, prio, cat, score=0) => { if (ok) cand.push({label, prio, cat, score}); };

  /* ---------- OFFENSE-FIRST IDENTITIES ---------- */
  // Go-to / efficient scoring
  add(has(pts40) && pts40 >= 26 && has(ts) && ts >= 0.58,                       'Go-to scorer',     95, 'off', pts40);
  add(has(pts40) && pts40 >= 22 && has(ts) && ts >= 0.62 && (!has(usg) || usg<=25),
                                                                              'Efficient scorer', 90, 'off', ts ?? 0);

  // Creation
  add(has(ast40) && ast40 >= 6 && has(tov40) && tov40 > 0 && (ast40/tov40) >= 2 && has(ortg) && ortg > 110,
                                                                              'Primary creator',  88, 'off', ast40);

  // Shooting gravity
  add(has(threePar) && threePar >= 0.45 &&
      ((has(pa3) && pa3 >= 4) || (has(val('per40_3pa')) && val('per40_3pa') >= 7)) &&
      has(p3pct) && p3pct >= 0.37,                                             'Floor spacer',     86, 'off', p3pct ?? 0);

  // Rim pressure
  add(has(fTr) && fTr >= 0.45,                                                 'Rim pressure',     80, 'off', fTr);

  // Rebounding
  add(has(reb40) && reb40 >= 11,                                               'Glass cleaner',    70, 'off', reb40);

  /* ---------- DEFENSE (limit to one) ---------- */
  // Disruption
  add(has(stocks40) && stocks40 >= 3.0,                                        'Events defender',  84, 'def', stocks40);

  // Team-defense impact (avoid giving both def tags)
  add(has(drtg) && drtg <= 100 && (!has(stocks40) || stocks40 < 3.0),          'Defensive impact', 82, 'def', 130 - drtg);

  // Rank and pick with diversity (max one per category)
  cand.sort((a,b)=> b.prio - a.prio || b.score - a.score);

  const out = [];
  const usedCat = new Set();

  for (const c of cand) {
    if (out.length >= maxFlags) break;
    if (usedCat.has(c.cat)) continue;           // no two from same category
    out.push(c.label);
    usedCat.add(c.cat);
  }

  // Ensure at least one offense tag if any exist
  if (!usedCat.has('off')) {
    const firstOff = cand.find(x => x.cat === 'off');
    if (firstOff && !out.includes(firstOff.label)) {
      out.unshift(firstOff.label);
      if (out.length > maxFlags) out.pop();
    }
  }

  return out;
}

/** Team row and league means from A20:S32 (league table) */
function _teamLeagueContext_(leagueRows) {
  const mean = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;

  const tsArr    = leagueRows.map(r => _num(r['TS%'])).filter(n=>n!=null);
  const efgArr   = leagueRows.map(r => _num(r['eFG%'])).filter(n=>n!=null);
  const ortgArr  = leagueRows.map(r => _num(r['ORtg'])).filter(n=>n!=null);
  const drtgArr  = leagueRows.map(r => _num(r['DRtg'])).filter(n=>n!=null);
  const ediffArr = leagueRows.map(r => _num(r['eDiff'])).filter(n=>n!=null);
  const paceArr  = leagueRows.map(r => _num(r['Pace'])).filter(n=>n!=null);

  const league = {
    ts:   mean(tsArr),
    efg:  mean(efgArr),
    ortg: mean(ortgArr),
    drtg: mean(drtgArr),
    ediff:mean(ediffArr),
    pace: mean(paceArr)
  };

  const teamRow = leagueRows.find(r => String(r['Team']||'').trim().toLowerCase() === STATS_TEAM_NAME.toLowerCase()) || {};
  const team = {
    team: String(teamRow['Team']||STATS_TEAM_NAME),
    ts:   _num(teamRow['TS%']),
    efg:  _num(teamRow['eFG%']),
    ortg: _num(teamRow['ORtg']),
    drtg: _num(teamRow['DRtg']),
    ediff:_num(teamRow['eDiff']),
    pace: _num(teamRow['Pace'])
  };

  return { team, league };
}







function _leaderboards_(players) {
  const top = (key, n=5, filter=()=>true, desc=true) =>
    players
      .filter(filter)
      .filter(p => p[key] != null)
      .sort((a,b) => desc ? (b[key] - a[key]) : (a[key] - b[key]))
      .slice(0, n)
      .map(p => ({ player: p.player, value: p[key] }));

  return {
    ortg:         top('ortg'),
    drtg_best:    top('drtg', 5, () => true, false), // lower is better
    per40_pts:    top('per40_pts'),
    stocks40:     top('per40_stocks'),
    ratings:      top('coachAvg'),                    // ← rename to ratings
    spacers: players
      .filter(p => p.threePar != null && p.pa3 != null && p.pa3 >= 3 && p.threePar > 0.40)
      .sort((a,b) => (b.pa3 - a.pa3))
      .slice(0, 5)
      .map(p => ({ player: p.player, pa3: p.pa3, threePar: p.threePar, pct: p['3P%'] || null }))
  };
}

/** ---------- Coach ratings from Dashboard!A7:I23 ---------- **
 * Expected headers (case-insensitive):
 * Player | n | Exec | Energy | Comm | Adapt | Resilience | Impact | Overall (last col)
 * Players in this sheet are LAST NAMES only.
 ****************************************************************/

function _normName_(s) {
  // lower, trim, strip diacritics & non-letters
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')     // remove accents
    .replace(/[^a-z]/g, '');             // keep letters only
}

function getCoachAveragesFromDashboard_(playerFullNames) {
  const ss = _open();
  const sh = ss.getSheetByName('dashboard');
  if (!sh) return { ok:false, map:{}, nMap:{} };

  // Read the block (A7:I23). If you later expand, you can widen safely:
  const startRow = 7, startCol = 1;
  const numRows = Math.max(1, sh.getLastRow() - startRow + 1);
  const numCols = Math.min(9, sh.getLastColumn() - startCol + 1); // up to I
  const v = sh.getRange(startRow, startCol, numRows, numCols).getDisplayValues();

  if (!v.length) return { ok:true, map:{}, nMap:{} };

  // find the header row inside this block (first row that contains "Player")
  let headerRowIdx = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i].some(c => String(c).toLowerCase() === 'player')) { headerRowIdx = i; break; }
  }
  const H = v[headerRowIdx].map(x => String(x || '').trim());
  const rows = v.slice(headerRowIdx + 1).filter(r => String(r[0] || '').trim());

  const idx = (name) => H.findIndex(h => h.toLowerCase() === name.toLowerCase());

  const cPlayer = idx('player');
  const cN      = idx('n');
  const cExec   = idx('exec');
  const cEnergy = idx('energy');
  const cComm   = idx('comm');
  const cAdapt  = idx('adapt');
  const cRes    = idx('resilience');
  const cImp    = idx('impact');

  // overall header might be broken (#DIV/0!) — treat the LAST column as "overall" if it parses,
  // otherwise we’ll compute mean(Exec..Impact) ourselves per row.
  let cOverall = idx('overall');
  if (cOverall < 0) cOverall = H.length - 1; // I col

  const toNum = (x) => {
    const n = Number(String(x || '').replace(',', '.'));
    return isFinite(n) ? n : null;
  };

  // Build roster last-name map for matching
  const fullByLast = new Map();
  playerFullNames.forEach(full => {
    const parts = String(full || '').trim().split(/\s+/);
    const last  = parts[parts.length - 1];               // Tubbergen, Jankovic, etc.
    const key   = _normName_(last);
    if (key) fullByLast.set(key, full);
  });

  const map  = {};   // full name -> coachAvg
  const nMap = {};   // full name -> n (count)

  rows.forEach(r => {
    const rawLast = String(r[cPlayer] || '').trim();     // e.g., "VanTubbergen"
    const keyLast = _normName_(rawLast);
    if (!keyLast) return;

    const full = fullByLast.get(keyLast);
    if (!full) return; // no match in roster

    const n = toNum(r[cN]);

    const exec   = toNum(r[cExec]);
    const energy = toNum(r[cEnergy]);
    const comm   = toNum(r[cComm]);
    const adapt  = toNum(r[cAdapt]);
    const res    = toNum(r[cRes]);
    const imp    = toNum(r[cImp]);

    const traitVals = [exec, energy, comm, adapt, res, imp].filter(x => x != null);
    let overall = toNum(r[cOverall]);

    if (overall == null && traitVals.length) {
      overall = traitVals.reduce((a,b)=>a+b,0) / traitVals.length;  // compute if header bad
    }

    if (overall != null) {
      map[full]  = overall;
      if (n != null) nMap[full] = n;
    }
  });

  return { ok:true, map, nMap };
}


/** ---------- Join advanced stats into rates (unchanged) ---------- */
function _joinAdvanced_(rates, advRows) {
  const map = new Map();
  advRows.forEach(r => {
    const key = String(r['Player'] || '').trim().toLowerCase();
    if (key) map.set(key, r);
  });

  const toN = (x) => {
    if (x === '' || x == null) return null;
    const n = parseFloat(String(x).replace(',', '.'));
    return isFinite(n) ? n : null;
  };

  return rates.map(p => {
    const adv = map.get(String(p.player).toLowerCase()) || {};
    return Object.assign({}, p, {
      ts:    toN(adv['TS%']),
      efg:   toN(adv['eFG%']),
      usg:   toN(adv['USG%']),
      ortg:  toN(adv['ORtg']),
      drtg:  toN(adv['DRtg']),
      ediff: toN(adv['eDiff']),
      per:   toN(adv['PER']),
      tovPct: toN(adv['TOV%']) // if present in your advanced table
    });
  });
}



/** ---------- MASTER: getStatsBundle (reads Dashboard for coachAvg + builds teamAlign) ---------- */
/** ---------- MASTER: getStatsBundle (reads Dashboard for coachAvg + builds teamAlign) ---------- */
function getStatsBundle() {
  try {
    const sh = _openStats_();

    // Read blocks
    const adv   = _readBlock_(sh, 'A1:U13');    // advanced players
    const lg    = _readBlock_(sh, 'A20:S32');   // league table (12 teams)
    const pg    = _readBlock_(sh, 'A40:W52');   // per-game (player)
    const lgPer = _readBlock_(sh, 'W20:AR33');  // league per-game (team)

    // Team + league summary (you already had this)
    const teamLeague = _teamLeagueContext_(lg.rows);

    // Combine league advanced + per-game for each team
    const perTeamMap = new Map();
    (lgPer.rows || []).forEach(r => {
      const name = String(r['Team'] || '').trim();
      if (!name) return;
      const parsed = _parseTeamPerGameRow_(r);
      perTeamMap.set(name.toLowerCase(), parsed);
    });

    const leagueTeams = [];
    (lg.rows || []).forEach(r => {
      const name = String(r['Team'] || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      leagueTeams.push({
        team: name,
        advanced: {
          ts:    _num(r['TS%']),
          efg:   _num(r['eFG%']),
          ortg:  _num(r['ORtg']),
          drtg:  _num(r['DRtg']),
          ediff: _num(r['eDiff']),
          pace:  _num(r['Pace']),
          orbPct:_num(r['ORB%']),
          astPct:_num(r['AST%']),
          tovPct:_num(r['TOV%']),
          stlPct:_num(r['STL%']),
          blkPct:_num(r['BLK%'])
        },
        perGame: perTeamMap.get(key) || null
      });
    });

    const perValues = Array.from(perTeamMap.values()).filter(Boolean);
    const leaguePerAvg = _avgTeamPerGame_(perValues);
    const ourTeamPer   = perTeamMap.get(String(STATS_TEAM_NAME || '').toLowerCase()) || null;

    // Per-game -> per-40 + join advanced
    const rates   = _buildPlayerRates_(pg.rows);
    let players   = _joinAdvanced_(rates, adv.rows);

    // Keep only our team
    players = players.filter(p => (p.team || '').toLowerCase().includes('per'));

    // === Coach averages from Dashboard (fast, last-name match) ===
    const names = players.map(p => p.player);
    const dash  = getCoachAveragesFromDashboard_(names);
    const coachMap  = dash.ok ? (dash.map  || {}) : {};
    const coachNMap = dash.ok ? (dash.nMap || {}) : {};

    // Attach coachAvg + coachN; build flags
    players = players.map(p => Object.assign({}, p, {
      coachAvg: coachMap[p.player] != null ? coachMap[p.player] : null,
      coachN:   coachNMap[p.player] != null ? coachNMap[p.player] : null,
      flags:    _buildFlags_(p)  // (you can ignore flags in the UI now)
    }));

    // Leaderboards (drop PER block, add coach ratings)
    const top = (list, key, n=5, desc=true) =>
      list.filter(x => x[key] != null)
          .sort((a,b)=> desc ? (b[key]-a[key]) : (a[key]-b[key]))
          .slice(0,n)
          .map(x => ({ player:x.player, value:x[key] }));

    const leaders = {
      ortg:         top(players, 'ortg'),
      drtg_best:    top(players, 'drtg', 5, false),
      per40_pts:    top(players, 'per40_pts'),
      stocks40:     top(players, 'per40_stocks'),
      coachAvg:     top(players, 'coachAvg')
    };

    // ---------------- TEAM ALIGNMENT (coaches vs stats) ----------------

    // 1) Aggregate COACH trait averages from Dashboard!A7:I23 (weighted by n)
    function _readCoachTeamAverages_() {
      const ss = _open();
      const dashSh = ss.getSheetByName('dashboard');
      if (!dashSh) return null;

      // Read a generous area; we’ll locate the header row that contains "Player"
      const vals = dashSh.getRange(7, 1, Math.max(1, dashSh.getLastRow() - 6), 9).getDisplayValues();
      if (!vals.length) return null;

      let headerIdx = 0;
      for (let i = 0; i < vals.length; i++) {
        if (vals[i].some(c => String(c).toLowerCase() === 'player')) { headerIdx = i; break; }
      }
      const H = vals[headerIdx].map(s => String(s||'').trim());
      const rows = vals.slice(headerIdx+1).filter(r => String(r[0]||'').trim());

      const idx = (name) => H.findIndex(h => h.toLowerCase() === name.toLowerCase());
      const cN    = idx('n');
      const cExec = idx('exec');
      const cEn   = idx('energy');
      const cComm = idx('comm');
      const cAd   = idx('adapt');
      const cRes  = idx('resilience');
      const cImp  = idx('impact');
      let cOverall = idx('overall'); if (cOverall < 0) cOverall = H.length - 1;

      const toNum = (x) => {
        const n = Number(String(x||'').replace(',', '.'));
        return isFinite(n) ? n : null;
      };

      let W = 0;
      const acc = { exec:0, energy:0, comm:0, adapt:0, resilience:0, impact:0, overall:0 };

      rows.forEach(r => {
        const w  = toNum(r[cN]) || 0;
        const ex = toNum(r[cExec]); const en = toNum(r[cEn]);
        const co = toNum(r[cComm]); const ad = toNum(r[cAd]);
        const re = toNum(r[cRes]);  const im = toNum(r[cImp]);
        let ov   = toNum(r[cOverall]);

        const traits = [ex,en,co,ad,re,im].filter(v => v!=null);
        if (ov == null && traits.length) ov = traits.reduce((a,b)=>a+b,0)/traits.length;

        if (w > 0) {
          W += w;
          if (ex!=null) acc.exec       += ex * w;
          if (en!=null) acc.energy     += en * w;
          if (co!=null) acc.comm       += co * w;
          if (ad!=null) acc.adapt      += ad * w;
          if (re!=null) acc.resilience += re * w;
          if (im!=null) acc.impact     += im * w;
          if (ov!=null) acc.overall    += ov * w;
        }
      });

      if (W === 0) return null;
      return {
        exec:       acc.exec       / W,
        energy:     acc.energy     / W,
        comm:       acc.comm       / W,
        adapt:      acc.adapt      / W,
        resilience: acc.resilience / W,
        impact:     acc.impact     / W,
        overall:    acc.overall    / W
      };
    }

    // 2) Build STAT trait scores (1–5) from league table using min–max scaling per metric
    const leagueRows = lg.rows || [];
    const teamRow    = leagueRows.find(r => String(r['Team']).trim().toLowerCase() === STATS_TEAM_NAME.toLowerCase()) || {};

    const METRICS = ['TS%','ORB%','AST%','TOV%','STL%','BLK%','ORtg','DRtg','eDiff','Pace'];
    const minmax = {};
    METRICS.forEach(h => {
      const vals = leagueRows.map(r => _num(r[h])).filter(v => v!=null);
      if (vals.length) minmax[h] = { min: Math.min(...vals), max: Math.max(...vals) };
    });

    function scale1to5(h, v, invert=false){
      if (v==null || !minmax[h]) return null;
      const {min,max} = minmax[h];
      if (min===max) return 3;
      let t = (v - min) / (max - min);
      if (invert) t = 1 - t;
      return 1 + t * 4; // 1..5
    }

    // Compose each trait from relevant metrics
    function statTraitScores(){
      const ts   = _num(teamRow['TS%']);
      const orb  = _num(teamRow['ORB%']);
      const ast  = _num(teamRow['AST%']);
      const tovP = _num(teamRow['TOV%']);
      const stl  = _num(teamRow['STL%']);
      const blk  = _num(teamRow['BLK%']);
      const ortg = _num(teamRow['ORtg']);
      const drtg = _num(teamRow['DRtg']);
      const edf  = _num(teamRow['eDiff']);
      const pace = _num(teamRow['Pace']);

      // helper: average non-null numbers
      const avg = (arr) => {
        const g = arr.filter(x => x!=null);
        return g.length ? g.reduce((a,b)=>a+b,0)/g.length : null;
      };

      // Execution: ORtg ↑, TS% ↑, TOV% ↓
      const exec = avg([
        scale1to5('ORtg', ortg, false),
        scale1to5('TS%',  ts,   false),
        scale1to5('TOV%', tovP, true)
      ]);

      // Energy: ORB% ↑, STL% ↑, BLK% ↑, Pace ↑
      const energy = avg([
        scale1to5('ORB%', orb,  false),
        scale1to5('STL%', stl,  false),
        scale1to5('BLK%', blk,  false),
        scale1to5('Pace', pace, false)
      ]);

      // Communication: AST% ↑, DRtg ↓
      const comm = avg([
        scale1to5('AST%', ast,  false),
        scale1to5('DRtg', drtg, true)
      ]);

      // Adaptability: TS% ↑, eDiff ↑ (proxy without role data)
      const adapt = avg([
        scale1to5('TS%',   ts,  false),
        scale1to5('eDiff', edf, false)
      ]);

      // Resilience: DRtg ↓, eDiff ↑ (two-way consistency proxy)
      const resilience = avg([
        scale1to5('DRtg',  drtg, true),
        scale1to5('eDiff', edf,  false)
      ]);

      // Impact: eDiff ↑ (clean summary margin)
      const impact = scale1to5('eDiff', edf, false);

      const overall = avg([exec, energy, comm, adapt, resilience, impact]);

      return { exec, energy, comm, adapt, resilience, impact, overall };
    }

    const coachTeamAvg = _readCoachTeamAverages_();   // {exec..overall} or null
    const statTeamAvg  = statTraitScores();            // {exec..overall}

    // Build rows for UI
    const traits = ['execution','energy','communication','adaptability','resilience','impact','overall'];
    const label = (t) => ({
      execution:'Exec', energy:'Energy', communication:'Comm',
      adaptability:'Adapt', resilience:'Resilience', impact:'Impact', overall:'Overall'
    }[t] || t);

    const teamAlign = {
      rows: traits.map(t => {
        const coach = coachTeamAvg ? coachTeamAvg[
          t==='execution'?'exec':
          t==='communication'?'comm':
          t==='adaptability'?'adapt':
          t
        ] : null;

        const stat = statTeamAvg[
          t==='execution'?'exec':
          t==='communication'?'comm':
          t==='adaptability'?'adapt':
          t
        ];

        const diff = (stat!=null && coach!=null) ? (stat - coach) : null;
        return { trait: label(t), coach, stat, diff };
      })
    };

    // ---------------- return everything ----------------
    return {
      ok: true,
      team: teamLeague.team,
      league: teamLeague.league,
      leagueRaw: lg.rows,   // used for your snapshot bullets / ranges
      leagueTeams,
      leaguePerGameAvg: leaguePerAvg,
      teamPerGame: ourTeamPer,
      players,
      leaders,
      teamAlign          // ✅ now defined
    };

  } catch (e) {
    return { ok:false, error:String(e) };
  }
}






/**** ================= TEAM IDENTITY & ALIGNMENT ================= ****/
/** Small clamp + normalize helpers */
function _clamp01(x){ return x == null ? null : Math.max(0, Math.min(1, x)); }
function _normRange(x, min, max, invert){
  if (x == null || min == null || max == null || min === max) return null;
  var t = (x - min) / (max - min);
  if (invert) t = 1 - t;
  return _clamp01(t);
}
/** map 0..1 → 1..5 (coach scale) */
function _toFive(t){ return t == null ? null : (1 + 4*t); }

/** Minutes-weighted mean of a per-player value array */
function _weightedMean(values, minutes){
  var sumW = 0, sum = 0;
  for (var i=0;i<values.length;i++){
    var v = values[i], w = (minutes[i] || 0);
    if (v == null || !isFinite(v) || w <= 0) continue;
    sum += v * w; sumW += w;
  }
  return sumW > 0 ? (sum / sumW) : null;
}

/** Join advanced (A1:U13) + per-game (A40:W52) and return just our team with MPG for weighting */
function _getJoinedPlayersWithMins_(){
  var sh = _openStats_();

  // advanced
  var adv = _readBlock_(sh, 'A1:U13').rows;          // Player, Team, TS%, eFG%, AST%, TOV%, ORB%, DRB%, STL%, BLK%, USG%, ORtg, DRtg, eDiff, PER, ...
  // per-game
  var pg  = _readBlock_(sh, 'A40:W52').rows;         // Player, Team, MPG, 3PA, FTA, FGA, ...

  // index per-game by player (case-insensitive)
  var pgMap = new Map();
  pg.forEach(function(r){
    var key = String(r['Player']||'').trim().toLowerCase();
    if (!key) return;
    pgMap.set(key, r);
  });

  // merge a light row: {player, team, mpg, ts, efg, astPct, tovPct, orbPct, drbPct, stlPct, blkPct, usg, ortg, drtg, ediff, per, threePar, fTr}
  var out = [];
  adv.forEach(function(r){
    var name = String(r['Player']||'').trim();
    var team = String(r['Team']||'').trim();
    if (!name || !team) return;
    var key  = name.toLowerCase();
    var pgRow = pgMap.get(key) || {};
    var mpg = _num(pgRow['MPG']);

    // helpers possibly with commas
    var n = function(x){ return _num(x); };

    // 3PAr & FTr from per-game FGA/3PA/FTA
    var FGA = _num(pgRow['FGA']), TPA = _num(pgRow['3PA']), FTA = _num(pgRow['FTA']);
    var threePar = (FGA && FGA>0 && TPA!=null) ? (TPA / FGA) : null;
    var fTr      = (FGA && FGA>0 && FTA!=null) ? (FTA / FGA) : null;

    out.push({
      player: name,
      team: team,
      mpg: mpg,
      ts: n(r['TS%']),
      efg: n(r['eFG%']),
      astPct: n(r['AST%']),
      tovPct: n(r['TOV%']),
      orbPct: n(r['ORB%']),
      drbPct: n(r['DRB%']),
      stlPct: n(r['STL%']),
      blkPct: n(r['BLK%']),
      usg: n(r['USG%']),
      ortg: n(r['ORtg']),
      drtg: n(r['DRtg']),
      ediff: n(r['eDiff']),
      per: n(r['PER']),
      threePar: threePar,
      fTr: fTr
    });
  });

  // keep our team only
  return out.filter(function(p){ return (p.team || '').toLowerCase().includes('per'); });
}

/** Pull team row & league pace from A20:S32 (you already do similar elsewhere) */
function _getTeamLeagueRow_(){
  var sh = _openStats_();
  var lg = _readBlock_(sh, 'A20:S32').rows;
  var leaguePace = null, team = null;
  var sumP=0, nP=0;

  lg.forEach(function(r){
    var pace = _num(r['Pace']);
    if (pace != null) { sumP += pace; nP += 1; }
    if (String(r['Team']||'').trim().toLowerCase() === STATS_TEAM_NAME.toLowerCase()){
      team = {
        team: String(r['Team']),
        ortg: _num(r['ORtg']),
        drtg: _num(r['DRtg']),
        ts:   _num(r['TS%']),
        efg:  _num(r['eFG%']),
        ediff:_num(r['eDiff']),
        pace: _num(r['Pace'])
      };
    }
  });
  leaguePace = nP>0 ? (sumP/nP) : null;
  return { team: team || {}, leaguePace: leaguePace };
}

/** Build TEAM identity (stats → 6 traits on 1..5 scale) */
function getTeamIdentity(){
  try{
    // players joined + minutes
    var players = _getJoinedPlayersWithMins_();
    if (!players.length) return { ok:false, error:'No Peristeri rows' };

    // minutes-weighted team rates from player advanced
    var mpgArr = players.map(function(p){ return p.mpg || 0; });

    var teamAst = _weightedMean(players.map(function(p){ return p.astPct; }), mpgArr);
    var teamTov = _weightedMean(players.map(function(p){ return p.tovPct; }), mpgArr);
    var teamOrb = _weightedMean(players.map(function(p){ return p.orbPct; }), mpgArr);
    var teamDrb = _weightedMean(players.map(function(p){ return p.drbPct; }), mpgArr);
    var teamStl = _weightedMean(players.map(function(p){ return p.stlPct; }), mpgArr);
    var teamBlk = _weightedMean(players.map(function(p){ return p.blkPct; }), mpgArr);
    var team3Par= _weightedMean(players.map(function(p){ return p.threePar; }), mpgArr);
    var teamFTr = _weightedMean(players.map(function(p){ return p.fTr; }), mpgArr);

    // team row & pace/ORtg/DRtg/eFG/TS
    var tl = _getTeamLeagueRow_();
    var tRow = tl.team;
    var pace = tRow.pace, ortg = tRow.ortg, drtg = tRow.drtg, ts = tRow.ts, efg = tRow.efg, ediff = tRow.ediff;

    // --- normalize to 0..1 (ranges are tunable; safe defaults for first pass)
    var nExec = _clamp01( ( _normRange(ortg, 90,130,false) * 0.55 ) +
                          ( _normRange(ts,   0.45,0.70,false) * 0.25 ) +
                          ( _normRange(teamTov, 5,20,true)     * 0.20 ) );

    var nEnergy = _clamp01( ( _normRange(pace,   65,78,false) * 0.35 ) +
                            ( _normRange(teamOrb, 5,15,false) * 0.35 ) +
                            ( _normRange(teamStl, 1,5,false)  * 0.30 ) );

    var nComm = _clamp01( ( _normRange(teamAst, 10,35,false) * 0.70 ) +
                          ( _normRange(teamTov, 5,20,true)   * 0.30 ) );

    var nAdapt = _clamp01( ( _normRange(team3Par, 0.20,0.60,false) * 0.55 ) +
                           ( _normRange(teamFTr,  0.15,0.45,false) * 0.45 ) );

    var nRes = _clamp01( ( _normRange(teamDrb, 15,30,false) * 0.35 ) +
                         ( _normRange(drtg,    90,130,true) * 0.50 ) +
                         ( _normRange(teamBlk, 2,8,false)   * 0.15 ) );

    var nImpact = _clamp01( ( _normRange(efg, 0.45,0.65,false) * 0.40 ) +
                            ( _normRange(ortg,90,130,false)    * 0.40 ) +
                            ( _normRange(ediff,-10,40,false)   * 0.20 ) );

    // convert to 1..5
    var identity = {
      exec:       _toFive(nExec),
      energy:     _toFive(nEnergy),
      comm:       _toFive(nComm),
      adapt:      _toFive(nAdapt),
      resilience: _toFive(nRes),
      impact:     _toFive(nImpact),

      // for debugging/UX tooltips (raws)
      raw: {
        pace: pace, ortg: ortg, drtg: drtg, ts: ts, efg: efg, ediff: ediff,
        astPct: teamAst, tovPct: teamTov, orbPct: teamOrb, drbPct: teamDrb,
        stlPct: teamStl, blkPct: teamBlk, threePar: team3Par, fTr: teamFTr
      }
    };

    return { ok:true, identity: identity };
  } catch(e){
    return { ok:false, error:String(e) };
  }
}

/** Read coach trait averages from Dashboard!A7:I23 (Exec..Impact columns) */
function getCoachTraitAverages(){
  try{
    var ss = _open();
    var sh = ss.getSheetByName('dashboard');
    if (!sh) return { ok:false, error:'dashboard sheet not found' };

    // Read a safe window and find the header row that contains "Player"
    var startRow = 7, startCol = 1, numRows = Math.max(1, sh.getLastRow() - startRow + 1), numCols = Math.min(9, sh.getLastColumn() - startCol + 1);
    var v = sh.getRange(startRow, startCol, numRows, numCols).getDisplayValues();
    if (!v.length) return { ok:false, error:'empty dashboard block' };

    var Hrow = 0;
    for (var i=0;i<v.length;i++){
      if (v[i].some(function(c){ return String(c).toLowerCase() === 'player'; })) { Hrow = i; break; }
    }
    var H = v[Hrow].map(function(x){ return String(x||'').trim().toLowerCase(); });
    var rows = v.slice(Hrow+1).filter(function(r){ return String(r[0]||'').trim(); });

    var idx = function(name){ return H.indexOf(name.toLowerCase()); };
    var cExec = idx('exec'), cEnergy = idx('energy'), cComm = idx('comm'), cAdapt = idx('adapt'), cRes = idx('resilience'), cImp = idx('impact');

    var toN = function(x){ var n = Number(String(x||'').replace(',','.')); return isFinite(n) ? n : null; };

    var cols = [cExec,cEnergy,cComm,cAdapt,cRes,cImp];
    var sums = [0,0,0,0,0,0], counts=[0,0,0,0,0,0];

    rows.forEach(function(r){
      cols.forEach(function(ci, j){
        if (ci < 0) return;
        var n = toN(r[ci]);
        if (n != null) { sums[j]+=n; counts[j]+=1; }
      });
    });

    var out = {
      exec:       counts[0] ? sums[0]/counts[0] : null,
      energy:     counts[1] ? sums[1]/counts[1] : null,
      comm:       counts[2] ? sums[2]/counts[2] : null,
      adapt:      counts[3] ? sums[3]/counts[3] : null,
      resilience: counts[4] ? sums[4]/counts[4] : null,
      impact:     counts[5] ? sums[5]/counts[5] : null
    };

    return { ok:true, coach: out };
  } catch(e){
    return { ok:false, error:String(e) };
  }
}

/** Compare coach averages vs stat identity (returns both + deltas) */
function getTeamIdentityAlignment(){
  try{
    var id = getTeamIdentity();
    if (!id.ok) return id;

    var ca = getCoachTraitAverages();
    if (!ca.ok) return ca;

    var coach = ca.coach, stat = id.identity;

    function pack(k){
      var c = coach[k], s = stat[k];
      return { trait:k, coach:c, stat:s, diff: (c!=null && s!=null) ? (c - s) : null };
    }

    var rows = ['exec','energy','comm','adapt','resilience','impact'].map(pack);
    return { ok:true, rows: rows, coach: coach, stat: stat };
  } catch(e){
    return { ok:false, error:String(e) };
  }
}


















/** ================== SCHEDULE (server) ================== **/

/** One canonical date parser for schedule cells.
 * Supports:
 *  - "Oct 4, 2025"
 *  - "Oct 12, 2025\n1:00 PM ET"
 */
function _parseSchedDate_(cell) {
  if (cell == null) return { ts:null, iso:null, dateStr:null, timeStr:null };

  // Normalize
  const s = String(cell).replace(/^[\"']|[\"']$/g,'').replace(/\r/g,'').trim();
  if (!s) return { ts:null, iso:null, dateStr:null, timeStr:null };

  // Split possible multi-line "date\n time"
  const parts    = s.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const datePart = parts[0] || '';
  const timePart = (parts[1] || '').replace(/\b(ET|CET|EET|UTC)\b/i,'').trim();

  // Parse date "Mon dd, yyyy"
  const mm = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11};
  const m1 = datePart.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m1) {
    // Fallback: try JS Date on the whole thing
    const d = new Date(s);
    if (isNaN(d.getTime())) return { ts:null, iso:null, dateStr:datePart || null, timeStr:timePart || null };
    const tz = Session.getScriptTimeZone();
    return {
      ts:  d.getTime(),
      iso: Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ss"),
      dateStr: Utilities.formatDate(d, tz, "EEE, dd MMM yyyy"),
      timeStr: timePart ? Utilities.formatDate(d, tz, "HH:mm") : null
    };
  }

  const mon = mm[m1[1].toLowerCase()];
  const day = Number(m1[2]);
  const yr  = Number(m1[3]);

  // Parse time (optional) "h:mm AM/PM"
  let hh = 0, mmn = 0;
  if (timePart) {
    const t12 = timePart.match(/^(\d{1,2}):(\d{2})\s*([AP]M)?/i);
    if (t12) {
      hh = Number(t12[1]); mmn = Number(t12[2]);
      const ampm = (t12[3]||'').toUpperCase();
      if (ampm === 'PM' && hh < 12) hh += 12;
      if (ampm === 'AM' && hh === 12) hh = 0;
    }
  }

  // Build date in script TZ for stable iso/labels
  const d = new Date(yr, mon, day, hh, mmn, 0, 0);
  const tz = Session.getScriptTimeZone();
  return {
    ts:  d.getTime(),
    iso: Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm:ss"),
    dateStr: Utilities.formatDate(d, tz, "EEE, dd MMM yyyy"),
    timeStr: timePart ? Utilities.formatDate(d, tz, "HH:mm") : null
  };
}

/** Leaders parser: "PTS: 19. Ty Nichols\nREB: 6. ...\nAST: 7. ..." */
function _parseLeaders_(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\r/g,'').trim();
  if (!s) return null;
  const out = {};
  const re = /(PTS|REB|AST)\s*:\s*([.\d]+)\.?\s*([^ \n].*)?/gi;
  let m;
  while ((m = re.exec(s))) {
    const key = m[1].toUpperCase();
    const val = Number(String(m[2]).replace(',','.'));
    const who = (m[3]||'').trim();
    out[key] = { value: isFinite(val) ? val : null, player: who || null };
  }
  return Object.keys(out).length ? out : null;
}

/** PPP parser: supports "86.3 - *123.0*" or "N/A" */
function _parsePPP_(raw) {
  if (!raw) return { us:null, them:null };
  const s = String(raw);
  const m = s.match(/([\d.]+)\s*-\s*\*?([\d.]+)\*?/);
  if (!m) return { us:null, them:null };
  const a = Number(m[1]), b = Number(m[2]);
  return { us: isFinite(a) ? a : null, them: isFinite(b) ? b : null };
}

/** Read schedule block: stats!A66:I92 → array of games */
function getSchedule() {
  try {
    const sh = _openStats_();
    const startRow = 66, startCol = 1, numCols = 9; // A..I
    const lastRow = sh.getLastRow();
    const height = Math.max(0, Math.min(92, lastRow) - startRow + 1);
    if (height <= 0) return { ok:true, games:[] };

    const vals = sh.getRange(startRow, startCol, height, numCols).getDisplayValues();
    const H = vals[0].map(h => String(h||'').trim());
    const rows = vals.slice(1).filter(r => r.some(c => String(c).trim() !== ''));

    const idx = (name) => H.findIndex(h => h.toLowerCase() === name.toLowerCase());
    const cDate    = idx('Date');
    const cOpp     = idx('Opponent');
    const cResult  = idx('Result');
    const cVenue   = idx('Venue');
    const cRecord  = idx('Record');
    const cOurLead = idx('Peristeri BC Leaders');
    const cOppLead = idx('Opponent Leaders');
    const cPPP     = idx('PPP');

    const games = rows.map(r => {
      const when   = _parseSchedDate_(r[cDate]);
      const oppRaw = String(r[cOpp]||'').trim();

      let homeAway = 'H';
      let opponent = oppRaw;
      if (/^\s*@/.test(opponent)) { homeAway = 'A'; opponent = opponent.replace(/^\s*@\s*/,''); }
      if (/^\s*v\./i.test(opponent)) { homeAway = 'H'; opponent = opponent.replace(/^\s*v\.\s*/i,''); }

      const resRaw = String(r[cResult]||'').trim();
      const status = /preview/i.test(resRaw) ? 'upcoming' : (resRaw ? 'final' : 'upcoming');

      const venueRaw = String(r[cVenue]||'').replace(/\r/g,'');
      const vParts = venueRaw.split(/\n+/);
      const arena = (vParts[0]||'').trim() || null;
      const comp  = (vParts[1]||'').trim() || null;

      const leadersUs   = _parseLeaders_(r[cOurLead]);
      const leadersThem = _parseLeaders_(r[cOppLead]);
      const ppp         = _parsePPP_(r[cPPP]);

      return {
        dateISO: when.iso,
        dateStr: when.dateStr,
        timeStr: when.timeStr,
        ts: when.ts,
        opponent,
        homeAway,            // 'H' or 'A'
        status,              // 'final' | 'upcoming'
        result: resRaw || null,
        record: String(r[cRecord]||'').trim() || null,
        arena, competition: comp,
        leadersUs, leadersThem,
        pppUs: ppp.us, pppThem: ppp.them
      };
    });

    games.sort((a,b)=>{
      if (a.ts == null && b.ts == null) return 0;
      if (a.ts == null) return 1;
      if (b.ts == null) return -1;
      return a.ts - b.ts;
    });

    return { ok:true, games };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}







/** Canonicalize header names (case/spacing/punct tolerant) */
function _canonHeader(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[._-]+/g, '');
}

/** Canonicalize team keys so schedule opponent ⇄ sheet Team match robustly */
function _canonTeamKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+bc\b/g, '')     // strip trailing “BC”
    .replace(/\s+bk\b/g, '')
    .replace(/\s+bc\./g, '')
    .replace(/[^a-z0-9]+/g, '') // remove punctuation/spaces
    .trim();
}

/** Read Opponents sheet → map by canonical team key */
function getOpponentsMap() {
  try {
    const ss = _open();
    const sh = ss.getSheetByName('Opponents');
    if (!sh) return { ok:false, error:'Sheet "Opponents" not found.' };

    const vals = sh.getDataRange().getValues();
    if (vals.length < 2) return { ok:true, map:{} };

    const H = vals[0].map(_canonHeader);
    const idx = {
      team: H.indexOf('team'),
      off:  H.indexOf('videooffense'),
      def:  H.indexOf('videodefense'),
      rq:   H.indexOf('reportquick'),
      rf:   H.indexOf('reportfull'),
      ri:   H.indexOf('individualreport'),
      ra:   H.indexOf('aftergamereport') // tolerant of “After.game.reprt”
    };

    const map = {};
    vals.slice(1).forEach(r => {
      const team = (r[idx.team] || '').toString().trim();
      if (!team) return;
      const key = _canonTeamKey(team);
      map[key] = {
        team,
        offense:     idx.off >= 0 ? String(r[idx.off]||'').trim() : '',
        defense:     idx.def >= 0 ? String(r[idx.def]||'').trim() : '',
        reportQuick: idx.rq  >= 0 ? String(r[idx.rq] ||'').trim() : '',
        reportFull:  idx.rf  >= 0 ? String(r[idx.rf] ||'').trim() : '',
        reportIndiv: idx.ri  >= 0 ? String(r[idx.ri] ||'').trim() : '',
        reportAfter: idx.ra  >= 0 ? String(r[idx.ra] ||'').trim() : ''
      };
    });

    return { ok:true, map };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

/** Schedule + opponent links join (uses your getSchedule() exactly as posted) */
function getScheduleWithOppLinks() {
  try {
    const sched = getSchedule();                 // ← your function above
    if (!sched || !sched.ok) return sched;

    const opp = getOpponentsMap();
    if (!opp || !opp.ok) return opp;

    const games = (sched.games || []).map(g => {
      const key = _canonTeamKey(g.opponent);
      const row = opp.map[key];
      return Object.assign({}, g, {
        oppLinks: row ? {
          offense: row.offense,
          defense: row.defense,
          reportQuick: row.reportQuick,
          reportFull:  row.reportFull,
          reportIndiv: row.reportIndiv,
          reportAfter: row.reportAfter
        } : {}
      });
    });

    return { ok:true, games };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

/** (Optional) keep detail endpoint working via new map */
function getOpponentDetail(team) {
  try {
    if (team == null) return { ok:false, error:'Missing team.' };
    const want = _canonTeamKey(decodeURIComponent(String(team)));
    const m = getOpponentsMap();
    if (!m.ok) return m;
    const row = m.map[want];
    if (!row) return { ok:false, error:'Team not found.' };
    return { ok:true, team: row.team, offense: row.offense, defense: row.defense,
             reportQuick: row.reportQuick, reportFull: row.reportFull,
             reportIndiv: row.reportIndiv, reportAfter: row.reportAfter };
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}






/** Read notes from "Notes_View" with filters + facets.
 *  Expected headers (case-insensitive): Date | Session | Coach | Player | Note
 */
/** Returns notes with optional filtering and joins Daily.Overall by (date, player). */
/** Notes + (optional) Daily score join.
 *  - Sheet "Notes_View": headers row 1, cols: Date | Session | Coach | Player | Note
 *  - Sheet "Daily": headers row 2, cols: Date | Player | ... | Overall
 */
/** Returns notes from Notes_View with optional filters and joins Daily.Overall (1–5) by (date, player). */
function getNotesLibrary(filters) {
  try {
    const ss = _open(); // your helper

    // ---------------- Notes_View ----------------
    const shNotes = ss.getSheetByName('Notes_View');
    if (!shNotes) return { ok:false, error:'Sheet "Notes_View" not found.' };

    const notesVals = shNotes.getDataRange().getValues();
    if (!notesVals || notesVals.length < 2) {
      return okOut([], { players:[], coaches:[], sessions:[] }, 0, Number(filters && filters.offset || 0));
    }

    // Normalize headers (lowercase) and find columns
    const H = notesVals[0].map(h => String(h || '').trim().toLowerCase());

    const iDate    = findHeader(H, ['date']);
    const iSession = findHeader(H, ['session']);
    const iCoach   = findHeader(H, ['coach']);
    const iPlayer  = findHeader(H, ['player']);
    // note column: be forgiving ("note", "notes", starts with "note")
    const iNote    = findHeader(H, ['note','notes'], /*prefixOK*/ true);

    if (iDate < 0 || iSession < 0 || iCoach < 0 || iPlayer < 0 || iNote < 0) {
      return { ok:false, error:'Notes_View is missing one of: Date, Session, Coach, Player, Note.' };
    }

    const noteRows = notesVals.slice(1).filter(r => r.some(x => String(x).trim() !== ''));

    // ---------------- UI filters ----------------
    filters = filters || {};
    const wantPlayer  = norm(filters.player);
    const wantCoach   = norm(filters.coach);
    const wantSession = norm(filters.session);
    const q           = norm(filters.q);

    // score range (1–5)
    const minScore = (typeof filters.minScore === 'number') ? filters.minScore : null;
    const maxScore = (typeof filters.maxScore === 'number') ? filters.maxScore : null;

    // pagination
    const limit  = Math.max(0, Number(filters.limit || 0));
    const offset = Math.max(0, Number(filters.offset || 0));

    // facet sets
    const setPlayer  = new Set();
    const setCoach   = new Set();
    const setSession = new Set();

    // ---------------- Daily (A2:I) → score map ----------------
    const shDaily = ss.getSheetByName('Daily');
    const scoreMap = new Map(); // key: 'yyyy-mm-dd|player-lc' -> overall (1..5)

    if (shDaily) {
      const lastRow = shDaily.getLastRow();
      if (lastRow >= 2) {
        const height = lastRow - 1; // start at row 2
        const dVals = shDaily.getRange(2, 1, height, 9).getValues(); // A..I
        // columns: 0=Date, 1=Player, 8=Overall (1..5)
        for (const r of dVals) {
          const d = parseDateLoose(r[0]);
          const p = String(r[1] || '').trim();
          const overall = Number(r[8]);
          if (!d || !p || !isFinite(overall)) continue;
          const key = formatISO(d) + '|' + p.toLowerCase();
          scoreMap.set(key, overall);
        }
      }
    }

    // ---------------- Build & filter output ----------------
    const outAll = [];
    for (const r of noteRows) {
      const dRaw    = r[iDate];
      const session = val(r, iSession);
      const coach   = val(r, iCoach);
      const player  = val(r, iPlayer);
      const note    = val(r, iNote);

      // facets (from all data)
      if (player)  setPlayer.add(player);
      if (coach)   setCoach.add(coach);
      if (session) setSession.add(session);

      // primary filters
      if (wantPlayer  && norm(player)  !== wantPlayer)   continue;
      if (wantCoach   && norm(coach)   !== wantCoach)    continue;
      if (wantSession && norm(session) !== wantSession)  continue;

      // text match (in note, player, session)
      const noteLC = norm(note);
      if (q && !contains(noteLC, q) && !contains(norm(player), q) && !contains(norm(session), q)) continue;

      // date normalize
      const dt = parseDateLoose(dRaw);
      const dateISO = dt ? formatISO(dt) : '';
      const dateStr = dt ? formatDateGB(dt) : String(dRaw || '');

      // attach score (1–5)
      let avgScore = null;
      if (dateISO && player) {
        const key = dateISO + '|' + player.toLowerCase();
        if (scoreMap.has(key)) {
          const s = scoreMap.get(key);
          avgScore = clamp(Number(s), 1, 5);
        }
      }

      // score range filter
      if (minScore != null && !(avgScore != null && avgScore >= minScore)) continue;
      if (maxScore != null && !(avgScore != null && avgScore <= maxScore)) continue;

      outAll.push({ dateISO, dateStr, session, coach, player, note, avgScore });
    }

    // newest → oldest by ISO
    outAll.sort((a,b) => (b.dateISO || '').localeCompare(a.dateISO || ''));

    // pagination slice
    const total = outAll.length;
    const rows = (limit > 0) ? outAll.slice(offset, offset + limit) : outAll;

    return {
      ok: true,
      rows,
      facets: {
        players:  Array.from(setPlayer).sort(),
        coaches:  Array.from(setCoach).sort(),
        sessions: Array.from(setSession).sort()
      },
      total,
      offset
    };

  } catch (e) {
    return { ok:false, error:String(e) };
  }

  // ---------------- helpers ----------------
  function okOut(rows, facets, total, offset){ return { ok:true, rows, facets, total: total||rows.length, offset: offset||0 }; }
  function val(r,i){ return (i>=0 && r[i]!=null) ? String(r[i]).trim() : ''; }
  function norm(s){ return String(s||'').trim().toLowerCase(); }
  function contains(a,b){ return a.indexOf(b) !== -1; }
  function clamp(x, lo, hi){ return Math.max(lo, Math.min(hi, x)); }

  function findHeader(H, exactList, prefixOK){
    // exact match first
    for (const key of exactList) {
      const at = H.indexOf(String(key).toLowerCase());
      if (at >= 0) return at;
    }
    if (prefixOK) {
      // fallback: any header that starts with 'note' (e.g., "notes (important …)")
      const i = H.findIndex(h => /^note/.test(h));
      if (i >= 0) return i;
    }
    return -1;
  }

  // Accepts JS Date, ISO yyyy-mm-dd, or dd/MM/yyyy
  function parseDateLoose(v){
    if (!v) return null;
    if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v) ? null : v;
    const s = String(v).trim();

    // ISO yyyy-mm-dd
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));

    // dd/MM/yyyy (your Notes_View format)
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(Number(m[3]), Number(m[2])-1, Number(m[1]));

    // fallback
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }

  function formatISO(d){
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }

  function formatDateGB(d){
    const opts = { day:'2-digit', month:'short', year:'numeric' };
    try { return d.toLocaleDateString('en-GB', opts); } catch(_) { return formatISO(d); }
  }
}

  // ---------- helpers ----------
  function val(r,i){ return (i>=0 && r[i]!=null) ? String(r[i]).trim() : ''; }
  function norm(s){ return String(s||'').trim().toLowerCase(); }
  function findCol_(headers, want){
    const w = String(want).trim().toLowerCase();
    for (let i=0;i<headers.length;i++){
      if (String(headers[i]).trim().toLowerCase() === w) return i;
    }
    return -1;
  }
  function parseDateLoose_(v){
    if (!v) return null;
    if (Object.prototype.toString.call(v) === '[object Date]') return v;
    const s = String(v).trim();

    // ISO yyyy-mm-dd
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2]-1, +m[3]);

    // dd/MM/yyyy
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(+m[3], +m[2]-1, +m[1]);

    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  function toISO_(d){
    if (!d || isNaN(d)) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  }
  function num_(x){
    if (x==null || x==='') return null;
    const n = parseFloat(String(x).replace(',', '.'));
    return isFinite(n) ? n : null;
  }
  function okOut(rows, facets){ return { ok:true, rows, total: rows.length, facets }; }


/** Parse dd/MM/yyyy or yyyy-MM-dd or a Date */
function _parseNotesDate(x){
  if (x instanceof Date && !isNaN(x)) return x;
  const s = String(x||'').trim();
  // dd/MM/yyyy
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = new Date(+m[3], +m[2]-1, +m[1]);
    return isNaN(d) ? null : d;
  }
  // yyyy-MM-dd
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(+m[1], +m[2]-1, +m[3]);
    return isNaN(d) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

/** Related clips (same as before, just in case) — adjust headers if needed */
/** Related clips for the Notes tab, pulled from "Clip_Library" */
function getRelatedClips(filters) {
  try {
    const ss = _open();
    const sh = ss.getSheetByName('Clip_Library');
    if (!sh) return { ok:false, error:'Sheet "Clip_Library" not found.' };

    filters = filters || {};
    const wantPlayer = norm(filters.player);
    const q          = norm(filters.q);
    const dateFrom   = filters.dateFrom ? parseISO(filters.dateFrom) : null; // yyyy-mm-dd
    const dateTo     = filters.dateTo   ? parseISO(filters.dateTo)   : null;

    const vals = sh.getDataRange().getValues();
    if (vals.length < 2) return { ok:true, rows: [] };

    // Expect exact headers but stay case-insensitive
    const H = vals[0].map(String);
    const idx = {
      date:     find(H, ['Date']),
      player:   find(H, ['Player']),
      theme:    find(H, ['Theme']),
      subTag:   find(H, ['Sub-Tag','Sub Tag','SubTag']),
      offdef:   find(H, ['Off/Def','Off-Def','OffDef']),
      clipType: find(H, ['Clip Type','ClipType']),
      notes:    find(H, ['Notes']),
      link:     find(H, ['Link','URL','Url'])
    };

    const rows = [];
    for (let i = 1; i < vals.length; i++) {
      const r = vals[i];

      const player = val(r, idx.player);
      const link   = val(r, idx.link);
      // Skip rows without a link
      if (!link) continue;

      if (wantPlayer && norm(player) !== wantPlayer) continue;

      const dRaw = val(r, idx.date);
      const dObj = looseDate(dRaw);                 // dd/MM/yyyy supported
      if (dateFrom && (!dObj || dObj < dateFrom)) continue;
      if (dateTo   && (!dObj || dObj > dateTo))   continue;

      // Text blob for q search
      const blob = [
        val(r, idx.notes), val(r, idx.theme), val(r, idx.subTag),
        val(r, idx.offdef), val(r, idx.clipType)
      ].join(' ').toLowerCase();
      if (q && !blob.includes(q)) continue;

      rows.push({
        dateISO: iso(dObj) || '',
        player,
        url: link,
        notes:  val(r, idx.notes),
        theme:  val(r, idx.theme),
        subTag: val(r, idx.subTag),
        offdef: val(r, idx.offdef),
        clipType: val(r, idx.clipType)
      });
    }

    // Recent first; return a sensible cap to keep UI snappy
    rows.sort((a,b) => (b.dateISO||'').localeCompare(a.dateISO||''));
    return { ok:true, rows: rows.slice(0, 48) };
  } catch (e) {
    return { ok:false, error:String(e) };
  }

  // helpers
  function find(H, names){
    const set = new Set(names.map(n => n.toLowerCase()));
    return H.findIndex(h => set.has(String(h||'').toLowerCase()));
  }
  function val(r,i){ return (i>=0 && r[i]!=null) ? String(r[i]).trim() : ''; }
  function norm(s){ return String(s||'').trim().toLowerCase(); }
  function parseISO(s){ const m=String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m?new Date(+m[1],+m[2]-1,+m[3]):null; }
  function looseDate(v){
    if (!v) return null;
    if (Object.prototype.toString.call(v)==='[object Date]') return v;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return new Date(+m[1],+m[2]-1,+m[3]);
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) return new Date(+m[3],+m[2]-1,+m[1]); // dd/MM/yyyy
    const d = new Date(s); return isNaN(d) ? null : d;
  }
  function iso(d){ if (!d) return ''; const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), da=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${da}`; }
}






/** ===== Ratings: meta + save ===== */

/** Lists!A:C → Coaches | Sessions | Players (headers in row 1) */
function getRatingsMeta() {
  try {
    const ss = _open(); // your existing helper
    const sh = ss.getSheetByName('Lists');
    if (!sh) return { ok:false, error:'Sheet "Lists" not found.' };

    const lastRow = sh.getLastRow();
    const out = { ok:true, coaches:[], sessions:[], players:[], todayISO: _todayISO_() };
    if (lastRow < 2) return out;

    const vals = sh.getRange(2, 1, lastRow-1, 3).getDisplayValues(); // A2:C
    const sc = new Set(), ssn = new Set(), sp = new Set();
    vals.forEach(r => {
      const c = String(r[0]||'').trim();
      const s = String(r[1]||'').trim();
      const p = String(r[2]||'').trim();
      if (c) sc.add(c);
      if (s) ssn.add(s);
      if (p) sp.add(p);
    });
    const sortLC = (a,b)=> a.localeCompare(b, undefined, {sensitivity:'base'});
    out.coaches  = Array.from(sc).sort(sortLC);
    out.sessions = Array.from(ssn).sort(sortLC);
    out.players  = Array.from(sp).sort(sortLC);
    return out;
  } catch (e) {
    return { ok:false, error:String(e) };
  }
}

/**
 * Save ratings to "Log" sheet (append). Expects payload:
 * {
 *   dateISO: 'yyyy-mm-dd',
 *   session: 'Team Practice',
 *   coach: 'Dimitris',
 *   rows: [{player, exec, energy, comm, adapt, resilience, impact, notes}, ...]
 * }
 */
function saveRatings(payload) {
  try {
    if (!payload || !Array.isArray(payload.rows) || !payload.rows.length) {
      return { ok:false, error:'No rows to save.' };
    }

    const ss = _open();
    const sh = ss.getSheetByName('Log') || ss.insertSheet('Log');

    // Read headers in row 1 (or create if empty)
    const lastCol = Math.max(11, sh.getLastColumn()); // expect A..K
    const hasHeader = sh.getLastRow() >= 1 && sh.getRange(1,1,1,lastCol).getValues()[0].some(String);
    if (!hasHeader) {
      const headers = [
        'Date (double click for calendar)',
        'Session',
        'Coach',
        'Player',
        'Execution:  Did the player consistently execute with precision and maintain focus throughout the session?',
        'Energy & Effort: Did the player sustain high physical intensity and effort from start to finish?',
        'Communication: Did the player communicate effectively with teammates and coaches, both verbally and non-verbally?',
        'Adaptability & Dec making:  Did the player adjust well to changing situations and make good decisions under pressure?',
        'Resilience & Mindset: Did the player respond positively to mistakes, challenges, and feedback?',
        'Team Impact: Did the player’s presence on the floor positively influence the team’s overall performance?',
        'Notes (important, write down what ever you think is helpful. be specific!)'
      ];
      sh.getRange(1,1,1,headers.length).setValues([headers]);
    }

    const H = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(h => String(h||'').trim());
    // Best-effort header mapping (works even if headers change slightly)
    const idx = {
      Date:     _findHeader(H, /^date/i),
      Session:  _findHeader(H, /^session/i),
      Coach:    _findHeader(H, /^coach/i),
      Player:   _findHeader(H, /^player/i),
      Exec:     _findHeader(H, /^execution/i),
      Energy:   _findHeader(H, /^energy/i),
      Comm:     _findHeader(H, /^communication/i),
      Adapt:    _findHeader(H, /^adapt/i),
      Res:      _findHeader(H, /^resilience/i),
      Impact:   _findHeader(H, /^team\s*impact/i),
      Notes:    _findHeader(H, /^notes/i),
    };

    // Build rows in order of columns 1..N, filling blanks where unmapped.
    const timeZone = Session.getScriptTimeZone();
    const dateISO = String(payload.dateISO || '').trim();
    const dateObj = dateISO ? _parseISO_(dateISO) : new Date();
    const dateSht = Utilities.formatDate(dateObj, timeZone, 'dd/MM/yyyy'); // match your sheets style

    const session = String(payload.session || '').trim();
    const coach   = String(payload.coach || '').trim();

    const colCount = H.length;
    const alertNotes = [];
    const toWrite = payload.rows.map(r => {
      const row = new Array(colCount).fill('');
      const playerName = String(r.player || '').trim();
      const noteText = String(r.notes || '').trim();

      _safe(row, idx.Date,   dateSht);
      _safe(row, idx.Session,session);
      _safe(row, idx.Coach,  coach);
      _safe(row, idx.Player, playerName);
      _safe(row, idx.Exec,   _numOrBlank(r.exec));
      _safe(row, idx.Energy, _numOrBlank(r.energy));
      _safe(row, idx.Comm,   _numOrBlank(r.comm));
      _safe(row, idx.Adapt,  _numOrBlank(r.adapt));
      _safe(row, idx.Res,    _numOrBlank(r.resilience));
      _safe(row, idx.Impact, _numOrBlank(r.impact));
      _safe(row, idx.Notes,  noteText);

      if (noteText) {
        alertNotes.push({ player: playerName, note: noteText });
      }
      return row;
    });

    const startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, toWrite.length, colCount).setValues(toWrite);

    if (NOTE_ALERT_EMAIL && !_shouldSkipNoteAlert(coach) && alertNotes.length) {
      try {
        _sendNoteAlertEmail({
          coach,
          session,
          dateObj,
          timeZone,
          notes: alertNotes
        });
      } catch (err) {
        console.error('Note alert email failed:', err);
      }
    }

    return { ok:true, saved: toWrite.length };

  } catch (e) {
    return { ok:false, error:String(e) };
  }

  // ---- helpers ----
  function _findHeader(headers, rx){
    const i = headers.findIndex(h => rx.test(h));
    return i >= 0 ? i : null;
  }
  function _safe(arr, i, v){
    if (i == null) return;
    arr[i] = v;
  }
  function _numOrBlank(v){
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : '';
  }
  function _parseISO_(s){
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return new Date(s);
    return new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
  }
}

function _shouldSkipNoteAlert(coachName) {
  const lc = String(coachName || '').trim().toLowerCase();
  if (!lc) return true;
  return NOTE_ALERT_SKIP_COACHES.some(skip => lc === skip || lc.startsWith(skip + ' '));
}

function _sendNoteAlertEmail(details) {
  if (!details || !Array.isArray(details.notes) || !details.notes.length) return;
  if (!NOTE_ALERT_EMAIL) return;

  const coach   = String(details.coach || '').trim() || 'Unknown coach';
  const session = String(details.session || '').trim();
  const tz      = details.timeZone || Session.getScriptTimeZone();
  const dateObj = (details.dateObj instanceof Date && !isNaN(details.dateObj))
    ? details.dateObj
    : new Date();
  const dateLabel = Utilities.formatDate(dateObj, tz, 'EEE, dd MMM yyyy');

  const plainLines = details.notes.map(({ player, note }) => {
    const safePlayer = player || '(player unknown)';
    const safeNote = String(note || '').replace(/\r?\n/g, '\n    ');
    return `• ${safePlayer}: ${safeNote}`;
  });

  const plainBody = [
    `Coach: ${coach}`,
    session ? `Session: ${session}` : null,
    `Date: ${dateLabel}`,
    '',
    'Notes:',
    ...plainLines,
    '',
    '— Team Hub'
  ].filter(Boolean).join('\n');

  const escape = (s) => String(s || '').replace(/[&<>"']/g, ch => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch] || ch
  ));
  const htmlItems = details.notes.map(({ player, note }) => {
    const safePlayer = escape(player || '(player unknown)');
    const safeNote = escape(note || '').replace(/\r?\n/g, '<br>');
    return `<li><strong>${safePlayer}</strong>: ${safeNote}</li>`;
  }).join('');

  const htmlBody = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;">
      <p>
        Coach: <strong>${escape(coach)}</strong><br>
        ${session ? `Session: ${escape(session)}<br>` : ''}
        Date: ${escape(dateLabel)}
      </p>
      <p>Notes:</p>
      <ul style="padding-left:18px; margin-top:6px;">${htmlItems}</ul>
    </div>
  `;

  const subject = `New session notes from ${coach}`;
  GmailApp.sendEmail(
    NOTE_ALERT_EMAIL,
    subject,
    plainBody,
    { name: 'Team Hub Alerts', htmlBody }
  );
}

function _todayISO_(){
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const y = Utilities.formatDate(now, tz, 'yyyy');
  const m = Utilities.formatDate(now, tz, 'MM');
  const d = Utilities.formatDate(now, tz, 'dd');
  return `${y}-${m}-${d}`;
}







function getTeamIndices() {
  try {
    const sh = _sheet(TAB_INDICES);              // uses your helper
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok:false, error:'No data rows in indices sheet.' };

    const rng = sh.getRange(1, 1, lastRow, 9);   // A:I
    const values = rng.getValues();
    const header = values[0].map(h => String(h || '').trim());
    const data   = values.slice(1);

    // header → index map (case-insensitive)
    const H = {};
    header.forEach((h,i)=> H[h.toLowerCase()] = i);

    const rows = [];
    for (const r of data) {
      // stop at first completely empty row
      if (r.every(v => v === '' || v == null)) break;

      // skip footer/aggregate rows with 2827 or #DIV/0!
      const looksLikeFooter = r.some(v => String(v).includes('2827') || String(v).toUpperCase().includes('#DIV/0'));
      if (looksLikeFooter) continue;

      rows.push({
        dateStr    : asDateStr(r[H['date']]),
        session    : asStr(r[H['session']]),
        type       : asStr(r[H['type']]),
        avgOverall : asNum(r[H['avgoverall']]),
        avgTEI     : asNum(r[H['avgtei']]),
        avgEEI     : asNum(r[H['avgeei']]),
        nRows      : asNum(r[H['nrows']]),
        tmi        : asNum(r[H['tmi (Δ vs prev 3)']]) ?? asNum(r[H['tmi (δ vs prev 3)']]) ?? asNum(r[H['tmi']]),
        gri        : asNum(r[H['gri (games only)']]) ?? asNum(r[H['gri']]),
      });
    }

    return { ok:true, rows };
  } catch (err) {
    return { ok:false, error: String(err) };
  }
}

/* ---- helpers ---- */
function asStr(x){ return (x == null ? '' : String(x)).trim(); }
function asNum(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }
function asDateStr(x){
  let d = x instanceof Date ? x : null;
  if (!d && typeof x === 'string' && x.trim()) {
    const m = x.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) d = new Date(Number(m[3].length===2?('20'+m[3]):m[3]), Number(m[2])-1, Number(m[1]));
  }
  if (!d) return asStr(x);
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}
