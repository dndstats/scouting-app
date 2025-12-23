

/*** ====== CONFIG ====== ***/
const SHEET_ID = '1N3tuxzNjrCcFur5s3fmIds2NL1gQsW3bVhcOD_lVJGA';

// Tab names
const TAB_CLIPS       = 'Clip_Library';
const TAB_PLAYERS     = 'Player_Notes';
const TAB_TEAM_TRENDS = 'Team_Trends';  // Team summaries (window, summary, positives, concerns, focus)
const TAB_TEAM_TRENDS_TRAITS = 'team trent';  // Trait data for line chart (Date, Exec, Energy, Comm, Adapt, Resilience, Impact)
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

// === Shot Map data lives in a DIFFERENT spreadsheet ===
const SHOTMAP_DOC_ID      = '1FcvbwuZSwjsTIv_vTApo1lnbchNR8MvW2xH29FdO9Us';
const PRACTICE_SHEET_NAME = 'PracticeData'; // the tab with your columns

/*** ====== WEB APP ENTRY ====== ***/
function doGet() {
  const tpl = HtmlService.createTemplateFromFile('Index');
  return tpl.evaluate().setTitle('Practice loop');
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
    
    // Generate a simple userId (use name as base, add timestamp for uniqueness)
    const userId = String(name).replace(/\s+/g, '_').toLowerCase() + '_' + Date.now().toString().slice(-8);
    
    return { ok:true, name, userId: userId };
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
  
  // Only read top 25 rows where summaries are located (trait data starts at row 27)
  const maxSummaryRow = 25;
  const lastRow = Math.min(sh.getLastRow(), maxSummaryRow);
  if (lastRow < 2) return null;
  
  const v = sh.getRange(1, 1, lastRow, 5).getValues(); // Columns A-E (1-5)
  if (v.length < 2) return null;
  
  // Find row with "last 7" in first column, or use row 1 (second row, index 1)
  let row = v.find(r => String(r[0] || '').toLowerCase().includes('last 7'));
  if (!row) row = v[1]; // Fallback to second row
  
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
    practiceTime: null
  };

  const dashPair = _homeLatestDashboardPair_(ss, tz);
  const latestSession = _homeLoadRatings_(ss, tz, nowTs, fallbackTs, todayISO, dashPair);
  if (latestSession) summary.latestSession = latestSession;

  const practiceTime = _homePracticeTime_();
  summary.practiceTime = practiceTime;

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
    const insights = getTeamInsights();
    const result = {
      ok: true,
      summary: bundle.summary,
      generatedAt: bundle.generatedAt,
      flags,
      teamRating,
      insights
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
  // Match the team rating chart: only read 30 rows (same as getTeamRatingSeries)
  const N = 30;
  
  const valRange = sh.getRange(START_ROW, 20, N, 1).getValues();
  const dateValues = sh.getRange(START_ROW, 26, N, 1).getValues();
  const dateDisplay = sh.getRange(START_ROW, 26, N, 1).getDisplayValues();
  const sessionDisplay = sh.getRange(START_ROW, 2, N, 1).getDisplayValues();

  const sessionOf = s => {
    const m = String(s || '').match(/\(([^)]+)\)/);
    return m && m[1] ? m[1].trim() : '';
  };

  const entries = [];
  for (let i = 0; i < N; i++) {
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

  // Use Dashboard1 values (from team rating chart) - this is the source of truth
  let avgScore = dashCurrent && dashCurrent.avg != null
    ? Number(Number(dashCurrent.avg).toFixed(2))
    : null;

  let prevAvg = dashPrev && dashPrev.avg != null
    ? Number(Number(dashPrev.avg).toFixed(2))
    : null;

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
  const firstLatestRow = latestRows.length ? latestRows[0] : {};
  const coachLabel = coachNames.length > 1 ? 'Multiple coaches' : (coachNames[0] || firstLatestRow.coach || '');

  const primaryDateISO = dashCurrent && dashCurrent.dateISO
    ? dashCurrent.dateISO
    : (latestGroup.dateISO || (firstLatestRow && firstLatestRow.dateISO) || '');

  const displayDate = dashCurrent && dashCurrent.displayDate
    ? dashCurrent.displayDate
    : (latestGroup.rawDate || primaryDateISO);

  const primarySession = dashCurrent && dashCurrent.session
    ? dashCurrent.session
    : (latestGroup.sessionName || (firstLatestRow && firstLatestRow.session) || '');

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

function _homePracticeTime_() {
  const ss = _open();
  const sh = ss.getSheetByName('time.practice');
  
  if (!sh) {
    return { categories: [], error: 'Sheet "time.practice" not found' };
  }
  
  const lastRow = sh.getLastRow();
  if (lastRow < 2) {
    return { categories: [], error: 'No practice data found' };
  }
  
  // Get all data including teach, learn, compete columns (A-G: date, segment, sub-segment, note, teach, learn, compete)
  const data = sh.getRange(2, 1, lastRow - 1, 7).getValues();
  
  // Group by date first to identify unique sessions
  // sessionsByDate = { 'dateString': { segments: { segment: { total, subs: {} } } } }
  const sessionsByDate = {};
  
  // Track aspects (teach, learn, compete)
  const aspectCounts = { teach: 0, learn: 0, compete: 0 };
  
  for (let i = 0; i < data.length; i++) {
    const rawDate = data[i][0];
    const segment = String(data[i][1] || '').trim().toLowerCase();
    const subSegment = String(data[i][2] || '').trim();
    const teach = String(data[i][4] || '').trim().toLowerCase() === 'yes';
    const learn = String(data[i][5] || '').trim().toLowerCase() === 'yes';
    const compete = String(data[i][6] || '').trim().toLowerCase() === 'yes';
    
    if (!segment) continue;
    
    // Count aspects
    if (teach) aspectCounts.teach++;
    if (learn) aspectCounts.learn++;
    if (compete) aspectCounts.compete++;
    
    // Convert date to string for grouping
    let dateKey = '';
    if (rawDate instanceof Date && !isNaN(rawDate)) {
      dateKey = Utilities.formatDate(rawDate, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
    } else if (rawDate) {
      dateKey = String(rawDate).trim();
    } else {
      dateKey = 'unknown';
    }
    
    if (!sessionsByDate[dateKey]) {
      sessionsByDate[dateKey] = { segments: {} };
    }
    
    if (!sessionsByDate[dateKey].segments[segment]) {
      sessionsByDate[dateKey].segments[segment] = { total: 0, subs: {} };
    }
    
    sessionsByDate[dateKey].segments[segment].total++;
    
    if (subSegment) {
      if (!sessionsByDate[dateKey].segments[segment].subs[subSegment]) {
        sessionsByDate[dateKey].segments[segment].subs[subSegment] = 0;
      }
      sessionsByDate[dateKey].segments[segment].subs[subSegment]++;
    }
  }
  
  // Now aggregate across all sessions
  // Count the actual number of segment occurrences per date
  const segmentCounts = {};
  let totalCount = 0;
  
  for (const dateKey in sessionsByDate) {
    const session = sessionsByDate[dateKey];
    
    for (const segment in session.segments) {
      if (!segmentCounts[segment]) {
        segmentCounts[segment] = { total: 0, subs: {} };
      }
      
      // Add the actual count of this segment on this date
      segmentCounts[segment].total += session.segments[segment].total;
      totalCount += session.segments[segment].total;
      
      // Aggregate sub-segments with their actual counts
      for (const subSeg in session.segments[segment].subs) {
        if (!segmentCounts[segment].subs[subSeg]) {
          segmentCounts[segment].subs[subSeg] = 0;
        }
        segmentCounts[segment].subs[subSeg] += session.segments[segment].subs[subSeg];
      }
    }
  }
  
  // Build result structure for pie chart
  const categories = [];
  
  for (const segment in segmentCounts) {
    const segmentData = segmentCounts[segment];
    const percentage = totalCount > 0 ? (segmentData.total / totalCount * 100).toFixed(1) : 0;
    
    const subCategories = [];
    for (const subSeg in segmentData.subs) {
      const subCount = segmentData.subs[subSeg];
      const subPercentage = totalCount > 0 ? (subCount / totalCount * 100).toFixed(1) : 0;
      subCategories.push({
        name: subSeg,
        count: subCount,
        percentage: parseFloat(subPercentage)
      });
    }
    
    // Sort subcategories by count (descending)
    subCategories.sort((a, b) => b.count - a.count);
    
    categories.push({
      segment: segment.charAt(0).toUpperCase() + segment.slice(1),
      count: segmentData.total,
      percentage: parseFloat(percentage),
      subCategories: subCategories
    });
  }
  
  // Sort categories by count (descending)
  categories.sort((a, b) => b.count - a.count);
  
  const uniqueSessions = Object.keys(sessionsByDate).length;
  
  // Calculate aspect percentages
  const aspects = {
    teach: {
      count: aspectCounts.teach,
      percentage: totalCount > 0 ? parseFloat((aspectCounts.teach / totalCount * 100).toFixed(1)) : 0
    },
    learn: {
      count: aspectCounts.learn,
      percentage: totalCount > 0 ? parseFloat((aspectCounts.learn / totalCount * 100).toFixed(1)) : 0
    },
    compete: {
      count: aspectCounts.compete,
      percentage: totalCount > 0 ? parseFloat((aspectCounts.compete / totalCount * 100).toFixed(1)) : 0
    }
  };
  
  return { 
    categories: categories, 
    totalSessions: uniqueSessions, 
    totalSegments: totalCount,
    aspects: aspects
  };
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
    // Check if first row is header (common pattern: if first row has 'Player' or 'Name')
    // If no header, start from row 0; otherwise start from row 1
    const firstRow = pv[0] || [];
    const hasHeader = firstRow.some(cell => {
      const str = String(cell || '').trim().toLowerCase();
      return str === 'player' || str === 'name' || str === 'photo' || str === 'url';
    });
    const startRow = hasHeader ? 1 : 0;
    for (let r = startRow; r < pv.length; r++) {
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
  // Check if first row is header (common pattern: if first row has 'Player' or 'Name')
  // If no header, start from row 0; otherwise start from row 1
  const firstRow = v[0] || [];
  const hasHeader = firstRow.some(cell => {
    const str = String(cell || '').trim().toLowerCase();
    return str === 'player' || str === 'name' || str === 'photo' || str === 'url';
  });
  const startRow = hasHeader ? 1 : 0;
  for (let r=startRow; r<v.length; r++) {
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
    let shotMap = null;
    
    // Only load shot map data if clipLimit > 0 (indicates full player page load, not just thumbnail)
    // This avoids triggering expensive shot map queries when only fetching photos for clip thumbnails
    if (clipLimit > 0) {
      try {
        shotMap = shotMapGetPlayerChartData(name, { limit: 200 });
      } catch (err) {
        shotMap = { ok:false, error:String(err) };
      }
    }
    
    return {
      ok: true,
      detail,
      photoUrl,
      coachRatings,
      clips,
      shotMap
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

/**
 * Get clips for spiral sessions (OPTIONAL - doesn't affect main analysis)
 * This is called separately and wrapped in try-catch
 * Returns clips grouped by date (YYYY-MM-DD format)
 */
function getSpiralClipsForSessions(playerName, sessionDates) {
  try {
    if (!playerName || !sessionDates || sessionDates.length === 0) {
      return {};
    }
    
    // Convert session dates to Set for fast lookup
    const dateSet = new Set();
    sessionDates.forEach(dateStr => {
      if (dateStr) dateSet.add(dateStr);
    });
    
    if (dateSet.size === 0) return {};
    
    // Fetch clips for this player
    const clips = apiGetClipsFlat({
      player: playerName,
      limit: 100, // Reasonable limit
      newestFirst: true
    });
    
    if (!clips || clips.length === 0) return {};
    
    // Group clips by date (YYYY-MM-DD format)
    const clipsByDate = {};
    const tz = Session.getScriptTimeZone() || 'Europe/Athens';
    
    clips.forEach(clip => {
      // apiGetClipsFlat returns 'link' not 'url'
      const clipUrl = clip.link || clip.url || '';
      if (!clipUrl) return;
      
      // Convert clip date to ISO string for matching
      // apiGetClipsFlat returns dateStr as string, need to parse it
      let clipDate = null;
      if (clip.date instanceof Date) {
        clipDate = clip.date;
      } else if (clip.dateStr) {
        // Try parsing dateStr (format: dd/MM/yyyy)
        const dateParts = String(clip.dateStr).split('/');
        if (dateParts.length === 3) {
          clipDate = new Date(parseInt(dateParts[2]), parseInt(dateParts[1]) - 1, parseInt(dateParts[0]));
        } else {
          clipDate = new Date(clip.dateStr);
        }
      } else if (clip.date) {
        clipDate = new Date(clip.date);
      }
      
      if (!clipDate || isNaN(clipDate.getTime())) return;
      
      const dateISO = Utilities.formatDate(clipDate, tz, 'yyyy-MM-dd');
      
      // Only include clips for dates we have sessions
      if (dateSet.has(dateISO)) {
        if (!clipsByDate[dateISO]) {
          clipsByDate[dateISO] = [];
        }
        clipsByDate[dateISO].push({
          url: clipUrl,
          theme: clip.theme || '',
          type: clip.type || '',
          notes: clip.notes || '',
          times: clip.times || ''
        });
      }
    });
    
    return clipsByDate;
  } catch (e) {
    Logger.log('Error fetching clips for spiral: ' + String(e));
    return {}; // Return empty object on error - doesn't break main function
  }
}

/**
 * Get team clips for spiral sessions (aggregates clips from all players)
 * OPTIMIZED: Fetches ALL clips once instead of per-player queries
 */
function getTeamClipsForSessions(sessionDates, playerNames) {
  try {
    if (!sessionDates || sessionDates.length === 0 || !playerNames || playerNames.length === 0) {
      return {};
    }
    
    // Convert to Sets for O(1) lookup
    const dateSet = new Set(sessionDates);
    const playerSet = new Set(playerNames.map(p => String(p).trim().toLowerCase()));
    
    // Fetch ALL clips ONCE (much faster than per-player queries)
    // Use a higher limit since we're fetching for all players
    const allClips = apiGetClipsFlat({
      limit: 500,
      newestFirst: true
    });
    
    if (!allClips || allClips.length === 0) return {};
    
    // Group clips by date, filtering for our players and dates
    const clipsByDate = {};
    const tz = Session.getScriptTimeZone() || 'Europe/Athens';
    
    allClips.forEach(clip => {
      // Filter by player
      const playerName = String(clip.player || '').trim().toLowerCase();
      if (!playerSet.has(playerName)) return;
      
      const clipUrl = clip.link || clip.url || '';
      if (!clipUrl) return;
      
      // Parse clip date
      let clipDate = null;
      if (clip.date instanceof Date) {
        clipDate = clip.date;
      } else if (clip.dateStr) {
        // Try parsing dateStr (format: dd/MM/yyyy)
        const dateParts = String(clip.dateStr).split('/');
        if (dateParts.length === 3) {
          clipDate = new Date(parseInt(dateParts[2]), parseInt(dateParts[1]) - 1, parseInt(dateParts[0]));
        } else {
          clipDate = new Date(clip.dateStr);
        }
      } else if (clip.date) {
        clipDate = new Date(clip.date);
      }
      
      if (!clipDate || isNaN(clipDate.getTime())) return;
      
      const dateISO = Utilities.formatDate(clipDate, tz, 'yyyy-MM-dd');
      
      // Filter by date
      if (!dateSet.has(dateISO)) return;
      
      // Add to result
      if (!clipsByDate[dateISO]) {
        clipsByDate[dateISO] = [];
      }
      clipsByDate[dateISO].push({
        url: clipUrl,
        player: clip.player || '',
        theme: clip.theme || '',
        type: clip.type || '',
        notes: clip.notes || '',
        times: clip.times || ''
      });
    });
    
    return clipsByDate;
  } catch (e) {
    Logger.log('Error getting team clips: ' + String(e));
    return {};
  }
}

/*** ====== Ping ====== ***/
function pingVersion() { return 'web endpoints live'; }





/*** ====== API: Ratings heatmap from Dashboard1 (B4:S) ====== ***/
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











/** Dashboard1 heatmap → compute per-day team average from A4:S34 */
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
  const labRangeValues = sh.getRange(5, 26, N, 1).getValues();     // Z5:Z34  (actual date values)
  const bRange   = sh.getRange(5,  2, N, 1).getDisplayValues();    // B5:B34  (date + session)
  
  const tz = (sh.getParent().getSpreadsheetTimeZone && sh.getParent().getSpreadsheetTimeZone()) || Session.getScriptTimeZone();

  // Get player columns (C-S, indices 2-18) and headers for finding highest player
  const headerRow = sh.getRange(4, 3, 1, 17).getDisplayValues()[0]; // C4:S4 (player names)
  const playerDataRange = sh.getRange(5, 3, N, 17).getValues(); // C5:S34 (player ratings)

  const labels   = [];  // x-axis (dates from Z)
  const values   = [];  // y values (from T)
  const sessions = [];  // tooltip session text (parsed from B)
  const topPlayers = []; // highest rated player per session
  const bottomPlayers = []; // lowest rated player per session
  const topTraits = [];  // highest rated trait per session
  const ratingRanges = []; // min/max ratings per session
  const gameInfo = []; // game info (win/loss, score) for each session

  // helper: pull text inside parentheses
  const sessionOf = s => {
    const m = String(s || '').match(/\(([^)]+)\)/);
    return m && m[1] ? m[1].trim() : '';
  };

  // Get trait data from Team_Trends sheet for highest trait calculation
  const traitData = _getTeamTrendsTraitData_();
  
  // Get schedule data to match games
  let scheduleData = null;
  try {
    const scheduleResult = getSchedule();
    if (scheduleResult && scheduleResult.ok && scheduleResult.games) {
      scheduleData = scheduleResult.games;
    }
  } catch (e) {
    Logger.log('[getTeamRatingSeries] Error fetching schedule: ' + String(e));
  }

  for (let i = 0; i < N; i++) {
    const rawV = valRange[i][0];
    const rawL = labRange[i][0];
    const rawLValue = labRangeValues[i][0]; // Actual date value, not display
    const rawB = bRange[i][0];

    // skip blank rows
    if ((rawV === '' || rawV == null) && String(rawL).trim() === '') continue;

    const n = (typeof rawV === 'number') ? rawV : parseFloat(String(rawV).replace(',', '.'));
    if (!isNaN(n) && String(rawL).trim() !== '') {
      labels.push(String(rawL));          // date only (for axis)
      values.push(n);
      const sess = sessionOf(rawB);
      sessions.push(sess);     // just "Team Practice", "Friendly", …

      // Find highest and lowest rated players in this row and calculate min/max
      let topPlayer = null;
      let topPlayerRating = -Infinity;
      let bottomPlayer = null;
      let bottomPlayerRating = Infinity;
      let minRating = Infinity;
      let maxRating = -Infinity;
      const playerRow = playerDataRange[i];
      for (let j = 0; j < playerRow.length && j < headerRow.length; j++) {
        const playerName = String(headerRow[j] || '').trim();
        if (!playerName) continue;
        const rating = (typeof playerRow[j] === 'number') ? playerRow[j] : parseFloat(String(playerRow[j]).replace(',', '.'));
        if (!isNaN(rating)) {
          if (rating > topPlayerRating) {
            topPlayerRating = rating;
            topPlayer = playerName;
          }
          if (rating < bottomPlayerRating) {
            bottomPlayerRating = rating;
            bottomPlayer = playerName;
          }
          if (rating < minRating) minRating = rating;
          if (rating > maxRating) maxRating = rating;
        }
      }
      topPlayers.push(topPlayer || '');
      bottomPlayers.push(bottomPlayer || '');
      // Store rating range (only if we found valid ratings)
      if (minRating !== Infinity && maxRating !== -Infinity) {
        ratingRanges.push({ min: minRating, max: maxRating });
      } else {
        ratingRanges.push(null);
      }

      // Find highest trait for this date from Team_Trends sheet
      let topTrait = '';
      // Parse the date - rawLValue might be a Date object or a string like "21-Oct"
      let dateObj = null;
      if (rawLValue instanceof Date && !isNaN(rawLValue)) {
        dateObj = rawLValue;
        // Fix year if it's wrong (like 2001 instead of 2025)
        if (dateObj.getFullYear() < 2020) {
          const currentYear = new Date().getFullYear();
          dateObj = new Date(currentYear, dateObj.getMonth(), dateObj.getDate());
        }
      } else {
        // Try to parse the date string (e.g., "21-Oct" or display value)
        dateObj = _homeCoerceDate_(rawLValue) || _homeCoerceDate_(rawL);
        
        // If date was parsed but has wrong year (like 2001), fix it to current year
        if (dateObj && dateObj.getFullYear() < 2020) {
          const currentYear = new Date().getFullYear();
          const month = dateObj.getMonth();
          const day = dateObj.getDate();
          // Use current year (2025 based on the data)
          dateObj = new Date(currentYear, month, day);
          // If that date is in the future, try previous year
          const now = new Date();
          if (dateObj > now) {
            dateObj = new Date(currentYear - 1, month, day);
          }
        }
      }
      
      if (traitData && dateObj && !isNaN(dateObj.getTime())) {
        // Normalize date to match (use date only, ignore time)
        // Team_Trends uses dd/MM/yyyy format (e.g., "20/08/2025")
        const dateKey1 = Utilities.formatDate(dateObj, tz, 'dd/MM/yyyy');
        const dateKey2 = Utilities.formatDate(dateObj, tz, 'yyyy-MM-dd'); // Also try ISO format
        
        // Try to find trait data for this date (prioritize dd/MM/yyyy since that's Team_Trends format)
        const traits = traitData[dateKey1] || traitData[dateKey2] || null;
        
        if (traits) {
          let maxTrait = '';
          let maxValue = -Infinity;
          for (const [trait, value] of Object.entries(traits)) {
            const numValue = (typeof value === 'number') ? value : parseFloat(String(value).replace(',', '.'));
            if (!isNaN(numValue) && numValue > maxValue) {
              maxValue = numValue;
              maxTrait = trait;
            }
          }
          topTrait = maxTrait;
        }
      }
      topTraits.push(topTrait);
      
      // Match with schedule to get game info (win/loss, score)
      let gameData = null;
      if (scheduleData && dateObj && !isNaN(dateObj.getTime())) {
        const sessionDateISO = Utilities.formatDate(dateObj, tz, 'yyyy-MM-dd');
        // Try to find a game on this date
        for (let g = 0; g < scheduleData.length; g++) {
          const game = scheduleData[g];
          if (game.dateISO && game.dateISO.startsWith(sessionDateISO)) {
            // Found a game on this date
            if (game.status === 'final' && game.result) {
              // Parse result to extract win/loss and score
              const resultStr = String(game.result || '').trim();
              let winLoss = null;
              let score = null;
              
              // Try to parse result like "W 85-72" or "L 72-85" or "85-72 W"
              const winMatch = resultStr.match(/\b(W|Win|Won)\b/i);
              const lossMatch = resultStr.match(/\b(L|Loss|Lost)\b/i);
              if (winMatch) {
                winLoss = 'W';
              } else if (lossMatch) {
                winLoss = 'L';
              }
              
              // Extract score (format: "85-72" or similar)
              const scoreMatch = resultStr.match(/(\d+)\s*[-–]\s*(\d+)/);
              if (scoreMatch) {
                score = scoreMatch[1] + '-' + scoreMatch[2];
              }
              
              gameData = {
                opponent: game.opponent || null,
                result: resultStr,
                winLoss: winLoss,
                score: score,
                homeAway: game.homeAway || null,
                record: game.record || null
              };
            }
            break;
          }
        }
      }
      gameInfo.push(gameData);
    }
  }

  if (!labels.length) return { ok:false, reason:'No data' };
  return { ok:true, labels, values, sessions, topPlayers, bottomPlayers, topTraits, ratingRanges, gameInfo };
}

// Helper function to get trait data from Team_Trends sheet
function _getTeamTrendsTraitData_() {
  try {
    const ss = _open();
    const tz = (ss.getSpreadsheetTimeZone && ss.getSpreadsheetTimeZone()) || Session.getScriptTimeZone();
    const sh = ss.getSheetByName(TAB_TEAM_TRENDS_TRAITS);
    if (!sh) {
      Logger.log('[getTeamTrendsTraitData] Team_Trends sheet not found');
      return null;
    }

    // Headers are in row 26 (F26-L26): Date, Exec, Energy, Comm, Adapt, Resilience, Impact
    const headerRow = 26;
    const dateCol = 6; // F = column 6 (1-indexed)
    const execCol = 7;   // G
    const energyCol = 8;  // H
    const commCol = 9;    // I
    const adaptCol = 10;  // J
    const resilienceCol = 11; // K
    const impactCol = 12;     // L
    
    const lastRow = sh.getLastRow();
    if (lastRow < headerRow + 1) {
      return null;
    }

    const result = {};
    const numRows = lastRow - headerRow;
    const rows = sh.getRange(headerRow + 1, dateCol, numRows, 7).getValues(); // F27:L(lastRow)
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rawDate = row[0]; // Date column
      if (!rawDate) continue;
      
      const dateObj = (rawDate instanceof Date && !isNaN(rawDate)) ? rawDate : _homeCoerceDate_(rawDate);
      if (!dateObj) continue;
      
      // Create date keys in multiple formats for matching
      const dateKey1 = Utilities.formatDate(dateObj, tz, 'yyyy-MM-dd');
      const dateKey2 = Utilities.formatDate(dateObj, tz, 'dd/MM/yyyy');
      
      const traits = {
        'execution': row[1],      // Exec
        'energy': row[2],         // Energy
        'communication': row[3],  // Comm
        'adaptability': row[4],   // Adapt
        'resilience': row[5],     // Resilience
        'impact': row[6]          // Impact
      };
      
      // Store under both date formats for flexible matching
      result[dateKey1] = traits;
      result[dateKey2] = traits;
    }
    
    return result;
  } catch (e) {
    Logger.log('[getTeamTrendsTraitData] Error: ' + String(e));
    return null;
  }
}

// Helper function to get trait averages per session from Log/Daily sheet (kept for backward compatibility)
function _getSessionTraitData_() {
  try {
    const ss = _open();
    const tz = (ss.getSpreadsheetTimeZone && ss.getSpreadsheetTimeZone()) || Session.getScriptTimeZone();
    let sh = ss.getSheetByName('Daily');
    if (!sh) sh = ss.getSheetByName('Log');
    if (!sh) return null;

    const lastRow = sh.getLastRow();
    if (lastRow < 2) return null;

    const colCount = sh.getLastColumn();
    let header = sh.getRange(1, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
    
    // Check if row 2 has headers (Daily sheet format)
    let headerRow = 1;
    if (lastRow >= 2) {
      const header2 = sh.getRange(2, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
      const hasDate2 = header2.some(h => /^date/i.test(h));
      const hasPlayer2 = header2.some(h => /^player/i.test(h));
      if (hasDate2 && hasPlayer2) {
        header = header2;
        headerRow = 2;
      }
    }

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
      Exec: find(/^execution/i),
      Energy: find(/^energy/i),
      Comm: find(/^communication/i),
      Adapt: find(/^adapt/i),
      Res: find(/^resilience/i),
      Impact: find(/^team\s*impact/i)
    };

    if (idx.Date == null || idx.Session == null) return null;
    const traitCols = {
      'execution': idx.Exec,
      'energy': idx.Energy,
      'communication': idx.Comm,
      'adaptability': idx.Adapt,
      'resilience': idx.Res,
      'impact': idx.Impact
    };

    const rows = sh.getRange(headerRow + 1, 1, lastRow - headerRow, colCount).getValues();
    const sessionMap = {}; // date -> session -> trait -> sum/count

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rawDate = idx.Date != null ? row[idx.Date] : '';
      const dateObj = _homeCoerceDate_(rawDate);
      if (!dateObj) continue;
      
      const dateStr = Utilities.formatDate(dateObj, tz, 'dd-MMM');
      const session = String(row[idx.Session] || '').trim().toLowerCase();
      if (!session) continue;

      if (!sessionMap[dateStr]) sessionMap[dateStr] = {};
      if (!sessionMap[dateStr][session]) {
        sessionMap[dateStr][session] = {
          'execution': { sum: 0, count: 0 },
          'energy': { sum: 0, count: 0 },
          'communication': { sum: 0, count: 0 },
          'adaptability': { sum: 0, count: 0 },
          'resilience': { sum: 0, count: 0 },
          'impact': { sum: 0, count: 0 }
        };
      }

      for (const [trait, colIdx] of Object.entries(traitCols)) {
        if (colIdx == null) continue;
        const val = row[colIdx];
        const num = (typeof val === 'number') ? val : parseFloat(String(val).replace(',', '.'));
        if (!isNaN(num)) {
          sessionMap[dateStr][session][trait].sum += num;
          sessionMap[dateStr][session][trait].count += 1;
        }
      }
    }

    // Calculate averages
    const result = {};
    for (const [date, sessions] of Object.entries(sessionMap)) {
      result[date] = {};
      for (const [session, traits] of Object.entries(sessions)) {
        result[date][session] = {};
        for (const [trait, data] of Object.entries(traits)) {
          if (data.count > 0) {
            result[date][session][trait] = data.sum / data.count;
          }
        }
      }
    }

    return result;
  } catch (e) {
    return null;
  }
}

function _analyzePlayerCorrelations_(ss, tz, teamValues, teamLabels) {
  try {
    // Read team ratings directly from Dashboard1 to get more sessions (last 30 rows)
    const dashSh = ss.getSheetByName('Dashboard1');
    let teamValuesExpanded = teamValues;
    let teamLabelsExpanded = teamLabels;
    
    if (dashSh) {
      // Read from row 5 onwards, up to 100 rows to find the last 30 with data
      const maxRows = 100;
      const valRange = dashSh.getRange(5, 20, maxRows, 1).getValues(); // T5:T104
      const labRange = dashSh.getRange(5, 26, maxRows, 1).getDisplayValues(); // Z5:Z104
      
      const expandedValues = [];
      const expandedLabels = [];
      
      for (let i = 0; i < maxRows; i++) {
        const rawV = valRange[i][0];
        const rawL = labRange[i][0];
        
        if ((rawV === '' || rawV == null) && String(rawL).trim() === '') continue;
        
        const n = (typeof rawV === 'number') ? rawV : parseFloat(String(rawV).replace(',', '.'));
        if (!isNaN(n) && String(rawL).trim() !== '') {
          expandedValues.push(n);
          expandedLabels.push(String(rawL).trim());
        }
      }
      
      // Take the last 30 sessions (most recent)
      if (expandedValues.length > 0) {
        const startIdx = Math.max(0, expandedValues.length - 30);
        teamValuesExpanded = expandedValues.slice(startIdx);
        teamLabelsExpanded = expandedLabels.slice(startIdx);
      }
    }
    
    // Try "Daily" sheet first, then "Log" for backward compatibility
    let sh = ss.getSheetByName('Daily');
    if (!sh) {
      sh = ss.getSheetByName('Log');
    }
    if (!sh) {
      return {
        topCorrelated: [],
        allCorrelations: [],
        totalPlayers: 0,
        diagnostic: {
          message: 'Daily or Log sheet not found',
          teamDatesFound: teamLabelsExpanded ? teamLabelsExpanded.length : 0,
          playerDatesFound: 0
        }
      };
    }
    
    if (!teamValuesExpanded || teamValuesExpanded.length < 3) {
      return {
        topCorrelated: [],
        allCorrelations: [],
        totalPlayers: 0,
        diagnostic: {
          message: 'Insufficient team rating data (need at least 3 sessions)',
          teamDatesFound: teamLabelsExpanded ? teamLabelsExpanded.length : 0,
          playerDatesFound: 0
        }
      };
    }
    
    const lastRow = sh.getLastRow();
    if (lastRow < 2) {
      return {
        topCorrelated: [],
        allCorrelations: [],
        totalPlayers: 0,
        diagnostic: {
          message: 'Daily/Log sheet is empty or has no data',
          teamDatesFound: teamLabelsExpanded ? teamLabelsExpanded.length : 0,
          playerDatesFound: 0
        }
      };
    }
    
    const colCount = sh.getLastColumn();
    
    // Try to find header row - check row 2 first (for Daily sheet), then row 1 (for Log sheet backward compatibility)
    let headerRow = 1;
    let header = sh.getRange(1, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
    
    // Check row 2 first (Daily sheet format - headers in row 2, data starts in row 3)
    if (lastRow >= 2) {
      const header2 = sh.getRange(2, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
      const hasDate2 = header2.some(h => /^date/i.test(h));
      const hasPlayer2 = header2.some(h => /^player/i.test(h));
      if (hasDate2 && hasPlayer2) {
        // Row 2 has headers - use it (Daily sheet format)
        header = header2;
        headerRow = 2;
      }
    }
    
    // If row 2 doesn't have headers, check row 1 (Log sheet format - headers in row 1, data starts in row 2)
    if (headerRow === 1) {
      const hasDate = header.some(h => /^date/i.test(h));
      const hasPlayer = header.some(h => /^player/i.test(h));
      if (!hasDate || !hasPlayer) {
        // Row 1 also doesn't have headers - this will be caught in the column check below
      }
    }
    
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
      Player: find(/^player/i),
      Overall: find(/^overall/i) || find(/^avg/i) || find(/^average/i) || find(/^rating/i) || find(/^score/i) || find(/^total/i)
    };
    
    // Fallback: If Overall not found by name, try column I (index 8) or L (index 11)
    if (idx.Overall == null) {
      const testStartRow = headerRow + 1; // Start testing from first data row
      // Try column I first (for Daily sheet)
      if (colCount > 8) {
        const testRowsI = sh.getRange(testStartRow, 9, Math.min(10, lastRow - headerRow), 1).getValues();
        const hasNumericDataI = testRowsI.some(row => {
          const val = row[0];
          return typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)));
        });
        if (hasNumericDataI) {
          idx.Overall = 8; // Column I (0-based index 8)
        }
      }
      // Try column L (for Log sheet backward compatibility)
      if (idx.Overall == null && colCount > 11) {
        const testRowsL = sh.getRange(testStartRow, 12, Math.min(10, lastRow - headerRow), 1).getValues();
        const hasNumericDataL = testRowsL.some(row => {
          const val = row[0];
          return typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)));
        });
        if (hasNumericDataL) {
          idx.Overall = 11; // Column L (0-based index 11)
        }
      }
    }
    
    if (idx.Player == null || idx.Overall == null) {
      // Get available column names for diagnostics
      const availableColumns = header.filter((h, i) => h && String(h).trim() !== '').map((h, i) => `${String.fromCharCode(65 + i)}: ${String(h).trim()}`);
      // Also include column letters for all columns
      const allColumns = header.map((h, i) => `${String.fromCharCode(65 + i)}: ${String(h || '').trim() || '(empty)'}`);
      
      // Also check row 1 and row 2 for diagnostics
      const row1Header = sh.getRange(1, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
      const row2Header = lastRow >= 2 ? sh.getRange(2, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim()) : [];
      
      return {
        topCorrelated: [],
        allCorrelations: [],
        totalPlayers: 0,
        diagnostic: {
          message: `Missing required columns in Daily/Log sheet: ${idx.Player == null ? 'Player' : ''}${idx.Player == null && idx.Overall == null ? ' and ' : ''}${idx.Overall == null ? 'Overall/Avg/Rating/Score (or column I/L)' : ''}`,
          teamDatesFound: teamLabelsExpanded ? teamLabelsExpanded.length : 0,
          playerDatesFound: 0,
          availableColumns: availableColumns,
          allColumns: allColumns,
          headerRowFound: headerRow,
          row1Columns: row1Header.slice(0, 10),
          row2Columns: row2Header.slice(0, 10),
          foundColumns: {
            Date: idx.Date != null ? (idx.Date < header.length ? header[idx.Date] : `Column ${String.fromCharCode(65 + idx.Date)}`) : null,
            Player: idx.Player != null ? (idx.Player < header.length ? header[idx.Player] : `Column ${String.fromCharCode(65 + idx.Player)}`) : null,
            Overall: idx.Overall != null ? (idx.Overall < header.length ? header[idx.Overall] : `Column ${String.fromCharCode(65 + idx.Overall)}`) : null
          }
        }
      };
    }
    
    // Read data rows starting after the header row
    const dataStartRow = headerRow + 1;
    const numDataRows = lastRow - headerRow;
    const rows = numDataRows > 0 ? sh.getRange(dataStartRow, 1, numDataRows, colCount).getValues() : [];
    
    // Find trait columns (Exec, Energy, Comm, Adapt, Resilience, Impact)
    const traitColumns = ['Exec', 'Energy', 'Comm', 'Adapt', 'Resilience', 'Impact'];
    const traitIndices = {};
    traitColumns.forEach(trait => {
      const traitIdx = find(new RegExp(`^${trait}$`, 'i'));
      if (traitIdx != null) {
        traitIndices[trait] = traitIdx;
      }
    });
    
    // Group player ratings and traits by session date
    const sessionPlayerRatings = {}; // { dateISO: { playerName: { ratings: [], traits: {traitName: []} } } }
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const player = String(row[idx.Player] || '').trim();
      const rawDate = idx.Date != null ? row[idx.Date] : '';
      const rating = _homeSafeNumber_(row[idx.Overall]);
      
      if (!player || rating == null) continue;
      
      const dateObj = _homeCoerceDate_(rawDate);
      const dateISO = dateObj ? _homeToISO_(dateObj, tz) : '';
      if (!dateISO) continue;
      
      if (!sessionPlayerRatings[dateISO]) {
        sessionPlayerRatings[dateISO] = {};
      }
      if (!sessionPlayerRatings[dateISO][player]) {
        sessionPlayerRatings[dateISO][player] = { ratings: [], traits: {} };
        Object.keys(traitIndices).forEach(trait => {
          sessionPlayerRatings[dateISO][player].traits[trait] = [];
        });
      }
      sessionPlayerRatings[dateISO][player].ratings.push(rating);
      
      // Store trait values
      Object.keys(traitIndices).forEach(trait => {
        const traitVal = _homeSafeNumber_(row[traitIndices[trait]]);
        if (traitVal != null) {
          sessionPlayerRatings[dateISO][player].traits[trait].push(traitVal);
        }
      });
    }
    
    // Helper function to parse Dashboard1 date format: "20-Oct" -> {day: 20, month: 10}
    function parseDashboardDate(dateStr) {
      if (!dateStr) return null;
      const str = String(dateStr).trim();
      // Format: "20-Oct" or "01-Nov"
      const match = str.match(/^(\d{1,2})-([A-Za-z]{3})$/i);
      if (!match) return null;
      
      const day = parseInt(match[1], 10);
      const monthName = match[2].toLowerCase();
      const monthMap = {
        'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
        'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
      };
      const month = monthMap[monthName];
      if (!month || day < 1 || day > 31) return null;
      
      return { day: day, month: month };
    }
    
    // Helper function to parse ISO date (YYYY-MM-DD) -> {day, month, year}
    function parseISODate(dateISO) {
      if (!dateISO) return null;
      const parts = String(dateISO).split('-');
      if (parts.length !== 3) return null;
      return {
        day: parseInt(parts[2], 10),
        month: parseInt(parts[1], 10),
        year: parseInt(parts[0], 10)
      };
    }
    
    // Match player session averages with team ratings
    const playerTeamPairs = {}; // { playerName: { teamRatings: [], playerRatings: [], traits: {traitName: []} } }
    let totalMatchesFound = 0;
    
    for (let i = 0; i < teamLabelsExpanded.length; i++) {
      const teamLabel = teamLabelsExpanded[i];
      const teamRating = teamValuesExpanded[i];
      
      // Parse Dashboard1 date format: "20-Oct"
      const dashboardDate = parseDashboardDate(teamLabel);
      if (!dashboardDate) continue;
      
      // Try to find matching date in player ratings by day and month
      let matchedDate = null;
      for (const dateISO in sessionPlayerRatings) {
        const playerDate = parseISODate(dateISO);
        if (playerDate && 
            playerDate.day === dashboardDate.day && 
            playerDate.month === dashboardDate.month) {
          matchedDate = dateISO;
          break;
        }
      }
      
      if (matchedDate && sessionPlayerRatings[matchedDate]) {
        totalMatchesFound++;
        // Get average player rating and trait values for this session
        for (const player in sessionPlayerRatings[matchedDate]) {
          const playerData = sessionPlayerRatings[matchedDate][player];
          const playerRatings = playerData.ratings || [];
          const playerAvg = playerRatings.length > 0 ? playerRatings.reduce((a, b) => a + b, 0) / playerRatings.length : null;
          
          if (playerAvg == null) continue;
          
          if (!playerTeamPairs[player]) {
            playerTeamPairs[player] = { teamRatings: [], playerRatings: [], traits: {} };
            Object.keys(traitIndices).forEach(trait => {
              playerTeamPairs[player].traits[trait] = [];
            });
          }
          playerTeamPairs[player].teamRatings.push(teamRating);
          playerTeamPairs[player].playerRatings.push(playerAvg);
          
          // Store average trait values for this session
          Object.keys(traitIndices).forEach(trait => {
            const traitVals = playerData.traits[trait] || [];
            if (traitVals.length > 0) {
              const traitAvg = traitVals.reduce((a, b) => a + b, 0) / traitVals.length;
              playerTeamPairs[player].traits[trait].push(traitAvg);
            }
          });
        }
      }
    }
    
    // Fallback: If we have few matches, also try to match by session order (assuming both are chronological)
    // This handles cases where dates might be in different formats or timezones
    const totalMatches = Object.values(playerTeamPairs).reduce((sum, p) => sum + p.teamRatings.length, 0);
    const numPlayers = Object.keys(playerTeamPairs).length;
    const avgMatchesPerPlayer = numPlayers > 0 ? totalMatches / numPlayers : 0;
    
    // Use fallback if we have no matches OR if we have very few matches per player (less than 10)
    // This will help us get more sessions analyzed
    if (avgMatchesPerPlayer < 10 && Object.keys(sessionPlayerRatings).length > 0 && teamLabelsExpanded.length > 0) {
      // Get all unique dates from player ratings, sorted chronologically
      const allPlayerDates = Object.keys(sessionPlayerRatings).sort();
      // Try to match by position (most recent sessions at end, assuming both arrays are in chronological order)
      // Match the last N team ratings with the last N player rating dates
      const numToMatch = Math.min(teamLabelsExpanded.length, allPlayerDates.length);
      const teamStartIdx = teamLabelsExpanded.length - numToMatch;
      const playerStartIdx = allPlayerDates.length - numToMatch;
      
      // Create a set of already-matched combinations to avoid duplicates
      const matchedCombinations = new Set();
      for (const player in playerTeamPairs) {
        for (let j = 0; j < playerTeamPairs[player].teamRatings.length; j++) {
          const key = `${player}::${playerTeamPairs[player].teamRatings[j].toFixed(2)}::${playerTeamPairs[player].playerRatings[j].toFixed(2)}`;
          matchedCombinations.add(key);
        }
      }
      
      for (let i = 0; i < numToMatch; i++) {
        const teamIdx = teamStartIdx + i;
        const playerDate = allPlayerDates[playerStartIdx + i];
        const teamRating = teamValuesExpanded[teamIdx];
        
        if (sessionPlayerRatings[playerDate]) {
          for (const player in sessionPlayerRatings[playerDate]) {
            const playerData = sessionPlayerRatings[playerDate][player];
            const playerRatings = playerData.ratings || [];
            const playerAvg = playerRatings.length > 0 ? playerRatings.reduce((a, b) => a + b, 0) / playerRatings.length : null;
            
            if (playerAvg == null) continue;
            
            // Check if this exact combination was already matched
            const key = `${player}::${teamRating.toFixed(2)}::${playerAvg.toFixed(2)}`;
            if (matchedCombinations.has(key)) continue;
            
            if (!playerTeamPairs[player]) {
              playerTeamPairs[player] = { teamRatings: [], playerRatings: [], traits: {} };
              Object.keys(traitIndices).forEach(trait => {
                playerTeamPairs[player].traits[trait] = [];
              });
            }
            
            playerTeamPairs[player].teamRatings.push(teamRating);
            playerTeamPairs[player].playerRatings.push(playerAvg);
            
            // Store average trait values for this session
            Object.keys(traitIndices).forEach(trait => {
              const traitVals = playerData.traits[trait] || [];
              if (traitVals.length > 0) {
                const traitAvg = traitVals.reduce((a, b) => a + b, 0) / traitVals.length;
                playerTeamPairs[player].traits[trait].push(traitAvg);
              }
            });
            
            matchedCombinations.add(key);
          }
        }
      }
    }
    
    // Check if we have any matches after both strategies
    const finalTotalMatches = Object.values(playerTeamPairs).reduce((sum, p) => sum + p.teamRatings.length, 0);
    
    // Calculate correlation for each player
    const correlations = [];
    const playersWithInsufficientData = [];
    
    for (const player in playerTeamPairs) {
      const pairs = playerTeamPairs[player];
      if (pairs.teamRatings.length < 3) {
        playersWithInsufficientData.push({ player: player, matches: pairs.teamRatings.length });
        continue; // Need at least 3 data points
      }
      
      // Simple correlation coefficient (Pearson's r)
      const n = pairs.teamRatings.length;
      const sumX = pairs.playerRatings.reduce((a, b) => a + b, 0);
      const sumY = pairs.teamRatings.reduce((a, b) => a + b, 0);
      const sumXY = pairs.playerRatings.reduce((sum, x, i) => sum + x * pairs.teamRatings[i], 0);
      const sumX2 = pairs.playerRatings.reduce((sum, x) => sum + x * x, 0);
      const sumY2 = pairs.teamRatings.reduce((sum, y) => sum + y * y, 0);
      
      const numerator = n * sumXY - sumX * sumY;
      const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
      
      if (denominator === 0) continue;
      
      const correlation = numerator / denominator;
      const avgPlayerRating = sumX / n;
      const sessionsCount = n;
      
      // Calculate trait correlations to find the best correlating trait
      let bestTrait = null;
      let bestTraitCorr = -1;
      
      Object.keys(pairs.traits).forEach(trait => {
        const traitValues = pairs.traits[trait];
        // Only calculate if we have enough trait data points
        if (traitValues.length >= 3 && traitValues.length === pairs.teamRatings.length) {
          const traitN = traitValues.length;
          const traitSumX = traitValues.reduce((a, b) => a + b, 0);
          const traitSumY = pairs.teamRatings.reduce((a, b) => a + b, 0);
          const traitSumXY = traitValues.reduce((sum, x, i) => sum + x * pairs.teamRatings[i], 0);
          const traitSumX2 = traitValues.reduce((sum, x) => sum + x * x, 0);
          const traitSumY2 = pairs.teamRatings.reduce((sum, y) => sum + y * y, 0);
          
          const traitNumerator = traitN * traitSumXY - traitSumX * traitSumY;
          const traitDenominator = Math.sqrt((traitN * traitSumX2 - traitSumX * traitSumX) * (traitN * traitSumY2 - traitSumY * traitSumY));
          
          if (traitDenominator !== 0) {
            const traitCorr = Math.abs(traitNumerator / traitDenominator);
            if (traitCorr > bestTraitCorr) {
              bestTraitCorr = traitCorr;
              bestTrait = trait;
            }
          }
        }
      });
      
      correlations.push({
        player: player,
        correlation: correlation,
        avgRating: avgPlayerRating,
        sessionsCount: sessionsCount,
        impact: correlation > 0.5 ? 'high' : (correlation > 0.3 ? 'medium' : 'low'),
        bestTrait: bestTrait || 'N/A'
      });
    }
    
    // Sort by correlation strength
    correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
    
    // If we have matches but no correlations (insufficient data per player), return diagnostic
    if (finalTotalMatches > 0 && correlations.length === 0) {
      const dashboardDates = teamLabelsExpanded.map(l => parseDashboardDate(l)).filter(d => d);
      const playerDates = Object.keys(sessionPlayerRatings).map(d => parseISODate(d)).filter(d => d);
      
      return {
        topCorrelated: [],
        allCorrelations: [],
        totalPlayers: 0,
        diagnostic: {
          teamDatesFound: dashboardDates.length,
          playerDatesFound: playerDates.length,
          totalMatchesFound: finalTotalMatches,
          playersWithData: Object.keys(playerTeamPairs).length,
          playersWithInsufficientData: playersWithInsufficientData,
          sampleTeamDate: dashboardDates[0] ? `${dashboardDates[0].day}-${dashboardDates[0].month}` : 'none',
          samplePlayerDate: playerDates[0] ? `${playerDates[0].day}/${playerDates[0].month}/${playerDates[0].year}` : 'none',
          message: `Found ${finalTotalMatches} total matches, but no player has 3+ matching sessions`
        }
      };
    }
    
    // If no matches at all, return diagnostic
    if (finalTotalMatches === 0) {
      const dashboardDates = teamLabelsExpanded.map(l => parseDashboardDate(l)).filter(d => d);
      const playerDates = Object.keys(sessionPlayerRatings).map(d => parseISODate(d)).filter(d => d);
      
      // Get sample raw labels and dates for debugging
      const sampleTeamLabels = teamLabelsExpanded.slice(0, 5).filter(l => l);
      const samplePlayerDateKeys = Object.keys(sessionPlayerRatings).slice(0, 5);
      
      // Try to see what dates we actually have
      const dashboardDateStrings = dashboardDates.slice(0, 5).map(d => `${d.day}/${d.month}`);
      const playerDateStrings = playerDates.slice(0, 5).map(d => `${d.day}/${d.month}/${d.year}`);
      
      return {
        topCorrelated: [],
        allCorrelations: [],
        totalPlayers: 0,
        diagnostic: {
          teamDatesFound: dashboardDates.length,
          playerDatesFound: playerDates.length,
          sampleTeamDate: dashboardDates[0] ? `${dashboardDates[0].day}-${dashboardDates[0].month}` : 'none',
          samplePlayerDate: playerDates[0] ? `${playerDates[0].day}/${playerDates[0].month}/${playerDates[0].year}` : 'none',
          sampleTeamLabels: sampleTeamLabels,
          samplePlayerDateKeys: samplePlayerDateKeys,
          dashboardDateStrings: dashboardDateStrings,
          playerDateStrings: playerDateStrings,
          message: 'No matching dates found between Dashboard1 and Daily/Log sheet'
        }
      };
    }
    
    // Add diagnostics to successful return
    const dashboardDates = teamLabelsExpanded.map(l => parseDashboardDate(l)).filter(d => d);
    const playerDates = Object.keys(sessionPlayerRatings).map(d => parseISODate(d)).filter(d => d);
    const avgSessionsPerPlayer = correlations.length > 0 
      ? correlations.reduce((sum, c) => sum + c.sessionsCount, 0) / correlations.length 
      : 0;
    
    return {
      topCorrelated: correlations.slice(0, 5), // Top 5
      allCorrelations: correlations,
      totalPlayers: correlations.length,
      diagnostic: {
        teamDatesRead: teamLabelsExpanded.length,
        teamDatesFound: dashboardDates.length, // For frontend compatibility
        teamDatesParsed: dashboardDates.length,
        playerDatesFound: playerDates.length,
        totalMatchesFound: finalTotalMatches,
        playersWithData: correlations.length,
        avgSessionsPerPlayer: Math.round(avgSessionsPerPlayer * 10) / 10,
        sampleTeamDate: dashboardDates.length > 0 ? `${dashboardDates[0].day}-${dashboardDates[0].month}` : 'none',
        samplePlayerDate: playerDates.length > 0 ? `${playerDates[0].day}/${playerDates[0].month}/${playerDates[0].year}` : 'none',
        message: `Analyzed ${correlations.length} players with average ${Math.round(avgSessionsPerPlayer * 10) / 10} sessions each`
      }
    };
    
  } catch (e) {
    return {
      topCorrelated: [],
      allCorrelations: [],
      totalPlayers: 0,
      diagnostic: {
        message: `Error during correlation analysis: ${String(e)}`,
        teamDatesFound: (typeof teamLabelsExpanded !== 'undefined' && teamLabelsExpanded) ? teamLabelsExpanded.length : (teamLabels ? teamLabels.length : 0),
        playerDatesFound: 0,
        error: String(e)
      }
    };
  }
}

function generateCorrelationSummary(positivePlayers, negativePlayers) {
  const insights = [];
  
  // Add explanation about Best Trait
  insights.push('Best Trait indicates which skill (from the Daily sheet) most strongly predicts team success for that player.');
  
  // Analyze positive correlations - get correlation as number
  if (positivePlayers && positivePlayers.length > 0) {
    const highImpact = positivePlayers.filter(p => {
      const corr = typeof p.correlation === 'number' ? p.correlation : parseFloat(p.correlation);
      return Math.abs(corr) > 0.5;
    });
    const mediumImpact = positivePlayers.filter(p => {
      const corr = typeof p.correlation === 'number' ? p.correlation : parseFloat(p.correlation);
      return Math.abs(corr) > 0.3 && Math.abs(corr) <= 0.5;
    });
    
    if (highImpact.length > 0) {
      const topPlayer = highImpact[0];
      const corr = typeof topPlayer.correlation === 'number' ? topPlayer.correlation : parseFloat(topPlayer.correlation);
      insights.push(`${topPlayer.player} shows strong positive correlation (r=${corr.toFixed(2)}) - when their ${topPlayer.bestTrait || 'performance'} is high, team success typically follows. Focus on maintaining and enhancing their ${topPlayer.bestTrait || 'key skills'}.`);
    }
    
    if (mediumImpact.length > 0) {
      const sample = mediumImpact[0];
      const corr = typeof sample.correlation === 'number' ? sample.correlation : parseFloat(sample.correlation);
      insights.push(`${sample.player} shows moderate positive correlation (r=${corr.toFixed(2)}) with team performance. Their ${sample.bestTrait || 'key trait'} (${sample.bestTrait || 'N/A'}) is the main driver - work on strengthening this area.`);
    }
  }
  
  // Analyze negative correlations
  if (negativePlayers && negativePlayers.length > 0) {
    const negativeCorr = negativePlayers.filter(p => {
      const corr = typeof p.correlation === 'number' ? p.correlation : parseFloat(p.correlation);
      return corr < 0;
    });
    
    if (negativeCorr.length > 0) {
      negativeCorr.forEach(player => {
        const corr = typeof player.correlation === 'number' ? player.correlation : parseFloat(player.correlation);
        if (Math.abs(corr) > 0.3) {
          insights.push(`${player.player} shows a negative pattern (r=${corr.toFixed(2)}) - needs investigation. When their performance is high, team performance tends to decrease. Review their role, playing style, or team dynamics. Their ${player.bestTrait || 'key trait'} (${player.bestTrait || 'N/A'}) may need adjustment.`);
        } else {
          insights.push(`${player.player} shows weak correlation (r=${corr.toFixed(2)}) with team performance - minimal impact on team outcomes. Consider role adjustment or focus on ${player.bestTrait || 'key skills'} development.`);
        }
      });
    } else {
      // Very low positive correlations
      const lowCorr = negativePlayers[0];
      if (lowCorr) {
        const corr = typeof lowCorr.correlation === 'number' ? lowCorr.correlation : parseFloat(lowCorr.correlation);
        insights.push(`${lowCorr.player} shows weak correlation (r=${corr.toFixed(2)}) with team performance - minimal impact on team outcomes. Consider role adjustment or focus on ${lowCorr.bestTrait || 'key skills'} development.`);
      }
    }
  }
  
  // Add general guidance
  if (positivePlayers && positivePlayers.length > 0) {
    const topPlayer = positivePlayers[0];
    insights.push(`Focus Area: Prioritize players with strong positive correlations (r>0.5). ${topPlayer.player}'s ${topPlayer.bestTrait || 'performance'} is a key indicator of team success.`);
  }
  
  return insights;
}

function analyzeHighRatingDrivers(ss, tz, teamValues, teamLabels) {
  try {
    const highRatingThreshold = 3.5;
    const highRatingSessions = [];
    const lowRatingSessions = [];
    
    // Identify high and low rating sessions
    for (let i = 0; i < teamValues.length && i < teamLabels.length; i++) {
      if (teamValues[i] >= highRatingThreshold) {
        highRatingSessions.push({ rating: teamValues[i], label: teamLabels[i], index: i });
      } else if (teamValues[i] < highRatingThreshold - 0.3) {
        lowRatingSessions.push({ rating: teamValues[i], label: teamLabels[i], index: i });
      }
    }
    
    if (highRatingSessions.length === 0) {
      return {
        summary: 'No sessions above 3.5 found in recent data',
        insights: []
      };
    }
    
    // Get Daily sheet data
    let sh = ss.getSheetByName('Daily');
    if (!sh) {
      sh = ss.getSheetByName('Log');
    }
    if (!sh) return { summary: 'Daily/Log sheet not available', insights: [] };
    
    const lastRow = sh.getLastRow();
    if (lastRow < 3) return { summary: 'Insufficient data in Daily sheet', insights: [] };
    
    const colCount = sh.getLastColumn();
    let headerRow = 1;
    let header = sh.getRange(1, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
    
    // Check row 2 first (Daily sheet format)
    if (lastRow >= 2) {
      const header2 = sh.getRange(2, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
      const hasDate2 = header2.some(h => /^date/i.test(h));
      const hasPlayer2 = header2.some(h => /^player/i.test(h));
      if (hasDate2 && hasPlayer2) {
        header = header2;
        headerRow = 2;
      }
    }
    
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
      Player: find(/^player/i),
      Overall: find(/^overall/i) || find(/^avg/i) || find(/^average/i) || find(/^rating/i) || find(/^score/i) || find(/^total/i)
    };
    
    // Find trait columns
    const traitColumns = ['Exec', 'Energy', 'Comm', 'Adapt', 'Resilience', 'Impact'];
    const traitIndices = {};
    traitColumns.forEach(trait => {
      const traitIdx = find(new RegExp(`^${trait}$`, 'i'));
      if (traitIdx != null) {
        traitIndices[trait] = traitIdx;
      }
    });
    
    if (idx.Player == null || idx.Overall == null) {
      return { summary: 'Required columns not found in Daily sheet', insights: [] };
    }
    
    // Read data
    const dataStartRow = headerRow + 1;
    const numDataRows = lastRow - headerRow;
    const rows = numDataRows > 0 ? sh.getRange(dataStartRow, 1, numDataRows, colCount).getValues() : [];
    
    // Helper to parse dates
    function parseDashboardDate(dateStr) {
      if (!dateStr) return null;
      const str = String(dateStr).trim();
      const match = str.match(/^(\d{1,2})-([A-Za-z]{3})$/i);
      if (!match) return null;
      const day = parseInt(match[1], 10);
      const monthName = match[2].toLowerCase();
      const monthMap = {
        'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
        'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
      };
      const month = monthMap[monthName];
      if (!month || day < 1 || day > 31) return null;
      return { day: day, month: month };
    }
    
    function parseISODate(dateISO) {
      if (!dateISO) return null;
      const parts = String(dateISO).split('-');
      if (parts.length !== 3) return null;
      return {
        day: parseInt(parts[2], 10),
        month: parseInt(parts[1], 10),
        year: parseInt(parts[0], 10)
      };
    }
    
    // Group data by session date
    const sessionData = {}; // { dateISO: { players: [{name, rating, traits}], teamRating } }
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const player = String(row[idx.Player] || '').trim();
      const rawDate = idx.Date != null ? row[idx.Date] : '';
      const rating = _homeSafeNumber_(row[idx.Overall]);
      
      if (!player || rating == null) continue;
      
      const dateObj = _homeCoerceDate_(rawDate);
      const dateISO = dateObj ? _homeToISO_(dateObj, tz) : '';
      if (!dateISO) continue;
      
      if (!sessionData[dateISO]) {
        sessionData[dateISO] = { players: [], teamRating: null };
      }
      
      const playerData = { name: player, rating: rating, traits: {} };
      Object.keys(traitIndices).forEach(trait => {
        const traitVal = _homeSafeNumber_(row[traitIndices[trait]]);
        if (traitVal != null) {
          playerData.traits[trait] = traitVal;
        }
      });
      
      sessionData[dateISO].players.push(playerData);
    }
    
    // Match high rating sessions with Daily sheet data
    const highSessionData = [];
    const lowSessionData = [];
    
    highRatingSessions.forEach(session => {
      const dashboardDate = parseDashboardDate(session.label);
      if (!dashboardDate) return;
      
      for (const dateISO in sessionData) {
        const playerDate = parseISODate(dateISO);
        if (playerDate && playerDate.day === dashboardDate.day && playerDate.month === dashboardDate.month) {
          sessionData[dateISO].teamRating = session.rating;
          highSessionData.push(sessionData[dateISO]);
          break;
        }
      }
    });
    
    lowRatingSessions.forEach(session => {
      const dashboardDate = parseDashboardDate(session.label);
      if (!dashboardDate) return;
      
      for (const dateISO in sessionData) {
        const playerDate = parseISODate(dateISO);
        if (playerDate && playerDate.day === dashboardDate.day && playerDate.month === dashboardDate.month) {
          sessionData[dateISO].teamRating = session.rating;
          lowSessionData.push(sessionData[dateISO]);
          break;
        }
      }
    });
    
    if (highSessionData.length === 0) {
      return { summary: 'No matching high-rating sessions found in Daily sheet', insights: [] };
    }
    
    // Analyze what's different in high vs low rating sessions
    const insights = [];
    
    // 1. Analyze average player ratings
    const highAvgPlayerRating = highSessionData.reduce((sum, s) => {
      const avg = s.players.length > 0 ? s.players.reduce((s2, p) => s2 + p.rating, 0) / s.players.length : 0;
      return sum + avg;
    }, 0) / highSessionData.length;
    
    const lowAvgPlayerRating = lowSessionData.length > 0 ? lowSessionData.reduce((sum, s) => {
      const avg = s.players.length > 0 ? s.players.reduce((s2, p) => s2 + p.rating, 0) / s.players.length : 0;
      return sum + avg;
    }, 0) / lowSessionData.length : highAvgPlayerRating;
    
    if (highAvgPlayerRating > lowAvgPlayerRating + 0.1) {
      insights.push(`High-rating sessions (≥3.5) show ${(highAvgPlayerRating - lowAvgPlayerRating).toFixed(2)} points higher average player ratings (${highAvgPlayerRating.toFixed(2)} vs ${lowAvgPlayerRating.toFixed(2)}). Focus on elevating overall player performance.`);
    }
    
    // 2. Find top performers in high-rating sessions
    const playerHighCounts = {};
    highSessionData.forEach(session => {
      session.players.forEach(p => {
        if (p.rating >= 3.5) {
          if (!playerHighCounts[p.name]) {
            playerHighCounts[p.name] = { count: 0, totalRating: 0, sessions: 0 };
          }
          playerHighCounts[p.name].count++;
          playerHighCounts[p.name].totalRating += p.rating;
          playerHighCounts[p.name].sessions++;
        }
      });
    });
    
    const topPerformers = Object.keys(playerHighCounts)
      .map(name => ({
        name: name,
        avgRating: playerHighCounts[name].totalRating / playerHighCounts[name].sessions,
        frequency: playerHighCounts[name].count / highSessionData.length
      }))
      .sort((a, b) => b.frequency - a.frequency || b.avgRating - a.avgRating)
      .slice(0, 3);
    
    if (topPerformers.length > 0) {
      const topPerformer = topPerformers[0];
      insights.push(`Key Player: ${topPerformer.name} consistently performs well (avg ${topPerformer.avgRating.toFixed(2)}) in high-rating sessions. Their strong performance is a key driver of team success.`);
    }
    
    // 3. Analyze trait differences
    const highTraitAvgs = {};
    const lowTraitAvgs = {};
    
    Object.keys(traitIndices).forEach(trait => {
      const highVals = [];
      const lowVals = [];
      
      highSessionData.forEach(session => {
        session.players.forEach(p => {
          if (p.traits[trait] != null) {
            highVals.push(p.traits[trait]);
          }
        });
      });
      
      lowSessionData.forEach(session => {
        session.players.forEach(p => {
          if (p.traits[trait] != null) {
            lowVals.push(p.traits[trait]);
          }
        });
      });
      
      if (highVals.length > 0) {
        highTraitAvgs[trait] = highVals.reduce((a, b) => a + b, 0) / highVals.length;
      }
      if (lowVals.length > 0) {
        lowTraitAvgs[trait] = lowVals.reduce((a, b) => a + b, 0) / lowVals.length;
      }
    });
    
    // Find traits with biggest difference
    const traitDiffs = Object.keys(highTraitAvgs)
      .map(trait => ({
        trait: trait,
        diff: highTraitAvgs[trait] - (lowTraitAvgs[trait] || highTraitAvgs[trait]),
        highAvg: highTraitAvgs[trait]
      }))
      .filter(t => t.diff > 0.1)
      .sort((a, b) => b.diff - a.diff);
    
    if (traitDiffs.length > 0) {
      const topTrait = traitDiffs[0];
      insights.push(`Key Trait: ${topTrait.trait} is ${topTrait.diff.toFixed(2)} points higher in high-rating sessions (${topTrait.highAvg.toFixed(2)} avg). Focus on developing this trait across all players.`);
    }
    
    // 4. Find player combinations (top 2 players together in high sessions)
    if (topPerformers.length >= 2) {
      const combo1 = topPerformers[0].name;
      const combo2 = topPerformers[1].name;
      const comboCount = highSessionData.filter(session => {
        const has1 = session.players.some(p => p.name === combo1 && p.rating >= 3.5);
        const has2 = session.players.some(p => p.name === combo2 && p.rating >= 3.5);
        return has1 && has2;
      }).length;
      
      if (comboCount > 0) {
        const comboRate = (comboCount / highSessionData.length * 100).toFixed(0);
        insights.push(`Player Combination: When ${combo1} and ${combo2} both perform well (≥3.5), team rating is high ${comboRate}% of the time. This duo is a strong indicator of team success.`);
      }
    }
    
    const summary = insights.length > 0 
      ? `Analysis of ${highSessionData.length} high-rating sessions (≥3.5) reveals key success drivers`
      : 'Limited data available for high-rating session analysis';
    
    return { summary: summary, insights: insights };
    
  } catch (e) {
    return { summary: 'Error analyzing high-rating drivers', insights: [] };
  }
}

function getTeamInsights() {
  try {
    const ss = _open();
    const tz = (ss.getSpreadsheetTimeZone && ss.getSpreadsheetTimeZone()) || Session.getScriptTimeZone();
    
    // Get team rating data
    const ratingData = getTeamRatingSeries();
    if (!ratingData || !ratingData.ok || !ratingData.values || ratingData.values.length < 3) {
      return { ok: false, reason: 'Insufficient data for analysis' };
    }
    
    const values = ratingData.values.map(Number);
    const labels = ratingData.labels || [];
    const sessions = ratingData.sessions || [];
    
    // Get practice time data
    const practiceData = _homePracticeTime_();
    
    // Performance zone thresholds (used throughout)
    const excellentThreshold = 4.0;
    const goodThreshold = 3.5;
    const needsWorkThreshold = 3.0;
    
    const insights = {
      predictions: [],
      trends: {},
      correlations: {},
      recommendations: [],
      warnings: []
    };
    
    // ===== TREND ANALYSIS =====
    // Use the SAME data as Latest Session and line chart - the last actual value
    const currentValue = values[values.length - 1]; // Last value (same as latest session)
    const previousValue = values.length > 1 ? values[values.length - 2] : currentValue; // Previous single value
    
    // Calculate trend from recent period vs earlier period (for momentum analysis)
    const recentCount = Math.min(5, values.length);
    const recentValues = values.slice(-recentCount);
    const earlierValues = values.slice(-recentCount * 2, -recentCount);
    
    const recentAvg = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
    const earlierAvg = earlierValues.length > 0 
      ? earlierValues.reduce((a, b) => a + b, 0) / earlierValues.length
      : recentAvg;
    
    const trend = recentAvg - earlierAvg; // Trend from period comparison
    const singleChange = currentValue - previousValue; // Change from last to previous
    const trendDirection = trend > 0.05 ? 'improving' : (trend < -0.05 ? 'declining' : 'stable');
    
    insights.trends = {
      current: currentValue, // Same as latest session - the last actual value
      previous: previousValue, // Previous single value
      change: singleChange, // Change from last to previous (matches latest session delta)
      trend: trend, // Overall trend from period comparison
      direction: trendDirection,
      momentum: trend > 0 ? 'positive' : (trend < 0 ? 'negative' : 'neutral')
    };
    
    // ===== PREDICTIONS =====
    // Simple linear regression for next session prediction
    if (values.length >= 3) {
      const last3 = values.slice(-3);
      const avgChange = (last3[2] - last3[0]) / 2; // Average change per session
      const predictedNext = last3[2] + avgChange;
      const confidence = values.length >= 5 ? 'medium' : 'low';
      
      insights.predictions.push({
        type: 'next_session',
        value: Math.max(2.0, Math.min(5.0, predictedNext)), // Clamp between 2-5
        range: [
          Math.max(2.0, predictedNext - 0.15),
          Math.min(5.0, predictedNext + 0.15)
        ],
        confidence: confidence,
        basedOn: `${values.length} historical sessions`
      });
    }
    
    // Performance zone prediction (using same currentValue as latest session)
    if (currentValue < excellentThreshold && trend > 0.1) {
      const sessionsToExcellent = Math.ceil((excellentThreshold - currentValue) / trend);
      insights.predictions.push({
        type: 'zone_progression',
        message: `At current trend, team could reach Excellent zone (4.0+) in ~${sessionsToExcellent} sessions`,
        confidence: trend > 0.15 ? 'high' : 'medium'
      });
    }
    
    if (currentValue > goodThreshold && trend < -0.1) {
      const sessionsToDrop = Math.ceil((currentValue - goodThreshold) / Math.abs(trend));
      insights.warnings.push({
        type: 'zone_risk',
        message: `Declining trend: Risk of dropping below Good zone (3.5) in ~${sessionsToDrop} sessions if trend continues`,
        severity: trend < -0.15 ? 'high' : 'medium'
      });
    }
    
    // ===== PRACTICE TYPE CORRELATION =====
    if (practiceData && practiceData.categories && practiceData.categories.length > 0) {
      const offensePct = practiceData.categories.find(c => c.segment.toLowerCase() === 'offense');
      const defensePct = practiceData.categories.find(c => c.segment.toLowerCase() === 'defense');
      
      if (offensePct && defensePct) {
        const offenseRatio = offensePct.percentage / 100;
        const defenseRatio = defensePct.percentage / 100;
        
        // Analyze if there's a correlation (simplified - would need historical practice data per session for real correlation)
        if (defenseRatio > 0.6 && trend > 0) {
          insights.correlations.practiceType = {
            finding: 'Defense-heavy practice (60%+) correlates with positive rating trends',
            recommendation: 'Consider maintaining or increasing defense focus',
            confidence: 'medium'
          };
        } else if (offenseRatio > 0.7 && trend < 0) {
          insights.correlations.practiceType = {
            finding: 'Excessive offense focus (70%+) may correlate with declining ratings',
            recommendation: 'Balance practice with more defense work',
            confidence: 'medium'
          };
        }
      }
      
      // Practice aspects analysis
      if (practiceData.aspects) {
        const competeRatio = practiceData.aspects.compete.percentage / 100;
        if (competeRatio > 0.5 && trend > 0) {
          insights.correlations.aspects = {
            finding: 'High competitive aspect (50%+) in practice correlates with improvement',
            recommendation: 'Maintain competitive drills and game-like situations',
            confidence: 'medium'
          };
        }
      }
    }
    
    // ===== DATA-RICH RECOMMENDATIONS =====
    // Generate actionable, data-driven recommendations
    
    // Trend-based recommendations with specific numbers
    if (trend < -0.1) {
      const declineAmount = Math.abs(trend);
      const sessionsAnalyzed = Math.min(5, values.length);
      insights.recommendations.push({
        priority: 'high',
        category: 'trend_recovery',
        message: `Team rating declined ${declineAmount.toFixed(2)} points over last ${sessionsAnalyzed} sessions (from ${earlierAvg.toFixed(2)} to ${recentAvg.toFixed(2)})`,
        data: {
          currentRating: currentValue.toFixed(2),
          previousRating: previousValue.toFixed(2),
          sessionChange: singleChange.toFixed(2),
          periodTrend: trend.toFixed(2),
          sessionsAnalyzed: sessionsAnalyzed
        },
        actions: [
          `Immediate: Current session (${currentValue.toFixed(2)}) is ${singleChange < 0 ? Math.abs(singleChange).toFixed(2) + ' points below' : singleChange.toFixed(2) + ' points above'} previous session`,
          `Short-term: Reverse ${declineAmount.toFixed(2)}-point decline trend over next 2-3 sessions`,
          'Practice focus: Increase defense work if currently offense-heavy (60%+)',
          'Engagement: Add competitive aspects - current compete ratio: ' + (practiceData.aspects ? practiceData.aspects.compete.percentage.toFixed(0) + '%' : 'N/A'),
          'Review: Check individual player flags and coach notes for specific issues'
        ]
      });
    } else if (trend > 0.1) {
      const improvementAmount = trend;
      const sessionsAnalyzed = Math.min(5, values.length);
      insights.recommendations.push({
        priority: 'medium',
        category: 'momentum_maintenance',
        message: `Positive momentum: +${improvementAmount.toFixed(2)} points over last ${sessionsAnalyzed} sessions (${earlierAvg.toFixed(2)} → ${recentAvg.toFixed(2)})`,
        data: {
          currentRating: currentValue.toFixed(2),
          improvementRate: (improvementAmount / sessionsAnalyzed).toFixed(3),
          momentumStrength: improvementAmount > 0.15 ? 'strong' : 'moderate'
        },
        actions: [
          `Maintain: Continue current approach - ${improvementAmount > 0.15 ? 'strong' : 'moderate'} positive trend`,
          `Target: At current rate (+${(improvementAmount / sessionsAnalyzed).toFixed(3)} per session), could reach 4.0+ in ~${Math.ceil((4.0 - currentValue) / (improvementAmount / sessionsAnalyzed))} sessions`,
          'Practice: Maintain current offense/defense balance',
          'Monitor: Watch for any sudden drops - maintain consistency'
        ]
      });
    } else {
      insights.recommendations.push({
        priority: 'low',
        category: 'stability',
        message: `Performance stable: ${trend >= 0 ? '+' : ''}${trend.toFixed(2)} change over last ${Math.min(5, values.length)} sessions`,
        data: {
          currentRating: currentValue.toFixed(2),
          stabilityRange: (Math.max(...recentValues) - Math.min(...recentValues)).toFixed(2)
        },
        actions: [
          `Current rating: ${currentValue.toFixed(2)} (stable within ${(Math.max(...recentValues) - Math.min(...recentValues)).toFixed(2)} point range)`,
          'Consider: Small adjustments to break plateau and push toward next level',
          'Focus: Identify specific areas (offense/defense) that could drive improvement'
        ]
      });
    }
    
    // Practice balance recommendation with detailed data
    if (practiceData && practiceData.categories) {
      const offensePct = practiceData.categories.find(c => c.segment.toLowerCase() === 'offense');
      const defensePct = practiceData.categories.find(c => c.segment.toLowerCase() === 'defense');
      
      if (offensePct && defensePct) {
        const offenseRatio = offensePct.percentage;
        const defenseRatio = defensePct.percentage;
        const imbalance = Math.abs(offenseRatio - defenseRatio);
        const totalSegments = practiceData.totalSegments || 0;
        const offenseSegments = Math.round(totalSegments * offenseRatio / 100);
        const defenseSegments = Math.round(totalSegments * defenseRatio / 100);
        
        if (imbalance > 20) {
          const dominant = offenseRatio > defenseRatio ? 'Offense' : 'Defense';
          const dominantPct = Math.max(offenseRatio, defenseRatio);
          const weakPct = Math.min(offenseRatio, defenseRatio);
          const neededShift = Math.ceil((imbalance - 20) / 2); // How much to shift for balance
          
          insights.recommendations.push({
            priority: imbalance > 40 ? 'high' : 'medium',
            category: 'practice_balance',
            message: `Practice imbalance detected: ${dominantPct.toFixed(0)}% ${dominant.toLowerCase()} vs ${weakPct.toFixed(0)}% ${offenseRatio > defenseRatio ? 'defense' : 'offense'} (${imbalance.toFixed(0)}% gap)`,
            data: {
              offensePercentage: offenseRatio.toFixed(1),
              defensePercentage: defenseRatio.toFixed(1),
              offenseSegments: offenseSegments,
              defenseSegments: defenseSegments,
              totalSegments: totalSegments,
              imbalanceGap: imbalance.toFixed(1),
              recommendedShift: neededShift
            },
            actions: [
              `Current split: ${offenseSegments} offense segments (${offenseRatio.toFixed(0)}%) vs ${defenseSegments} defense segments (${defenseRatio.toFixed(0)}%)`,
              `Target: Shift ${neededShift}% more toward ${offenseRatio > defenseRatio ? 'defense' : 'offense'} for better balance (aim for 45-55% each)`,
              `Impact: Balanced practice (50/50) historically correlates with ${trend > 0 ? 'maintained' : 'improved'} performance`,
              'Action: Plan next 3-5 sessions with adjusted focus to reach balance'
            ]
          });
        } else {
          insights.recommendations.push({
            priority: 'low',
            category: 'practice_balance',
            message: `Well-balanced practice: ${offenseRatio.toFixed(0)}% offense / ${defenseRatio.toFixed(0)}% defense (${imbalance.toFixed(0)}% difference)`,
            data: {
              offensePercentage: offenseRatio.toFixed(1),
              defensePercentage: defenseRatio.toFixed(1),
              balanceScore: (100 - imbalance).toFixed(0) + '%'
            },
            actions: [
              `Maintain: Current ${offenseRatio.toFixed(0)}/${defenseRatio.toFixed(0)} split is well-balanced`,
              'Continue: Keep this distribution for consistent development'
            ]
          });
        }
      }
    }
    
    // Practice aspects recommendations with data
    if (practiceData && practiceData.aspects) {
      const teachPct = practiceData.aspects.teach.percentage;
      const learnPct = practiceData.aspects.learn.percentage;
      const competePct = practiceData.aspects.compete.percentage;
      const totalSegments = practiceData.totalSegments || 0;
      
      const teachSegments = Math.round(totalSegments * teachPct / 100);
      const learnSegments = Math.round(totalSegments * learnPct / 100);
      const competeSegments = Math.round(totalSegments * competePct / 100);
      
      // Check for aspect imbalances
      const maxAspect = Math.max(teachPct, learnPct, competePct);
      const minAspect = Math.min(teachPct, learnPct, competePct);
      const aspectSpread = maxAspect - minAspect;
      
      if (aspectSpread > 30) {
        const dominantAspect = teachPct === maxAspect ? 'Teaching' : (learnPct === maxAspect ? 'Learning' : 'Competing');
        const weakAspect = teachPct === minAspect ? 'Teaching' : (learnPct === minAspect ? 'Learning' : 'Competing');
        
        insights.recommendations.push({
          priority: 'medium',
          category: 'practice_aspects',
          message: `Aspect imbalance: ${dominantAspect} (${maxAspect.toFixed(0)}%) dominates over ${weakAspect} (${minAspect.toFixed(0)}%)`,
          data: {
            teachPercentage: teachPct.toFixed(1),
            learnPercentage: learnPct.toFixed(1),
            competePercentage: competePct.toFixed(1),
            teachSegments: teachSegments,
            learnSegments: learnSegments,
            competeSegments: competeSegments,
            aspectSpread: aspectSpread.toFixed(1)
          },
          actions: [
            `Current distribution: ${teachSegments} teach (${teachPct.toFixed(0)}%), ${learnSegments} learn (${learnPct.toFixed(0)}%), ${competeSegments} compete (${competePct.toFixed(0)}%)`,
            `Recommendation: Increase ${weakAspect.toLowerCase()} aspects by ${Math.ceil(aspectSpread / 3)}% for balanced development`,
            `Target: Aim for 30-40% each aspect for comprehensive skill development`,
            `Correlation: ${competePct > 50 ? 'High compete ratio correlates with' : 'Increasing compete aspects may improve'} performance trends`
          ]
        });
      }
    }
    
    // Volatility-based recommendations
    if (values.length >= 5) {
      const recent5 = values.slice(-5);
      const avg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
      const variance = recent5.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / recent5.length;
      const stdDev = Math.sqrt(variance);
      const minRecent = Math.min(...recent5);
      const maxRecent = Math.max(...recent5);
      const range = maxRecent - minRecent;
      
      if (stdDev > 0.25) {
        insights.recommendations.push({
          priority: 'high',
          category: 'consistency',
          message: `High performance volatility: ${stdDev.toFixed(2)} standard deviation (range: ${minRecent.toFixed(2)} - ${maxRecent.toFixed(2)})`,
          data: {
            standardDeviation: stdDev.toFixed(2),
            minRating: minRecent.toFixed(2),
            maxRating: maxRecent.toFixed(2),
            range: range.toFixed(2),
            average: avg.toFixed(2),
            coefficientOfVariation: ((stdDev / avg) * 100).toFixed(1) + '%'
          },
          actions: [
            `Issue: ${range.toFixed(2)}-point swing between best (${maxRecent.toFixed(2)}) and worst (${minRecent.toFixed(2)}) recent sessions`,
            `Target: Reduce volatility to <0.20 std dev for more predictable performance`,
            `Focus: Identify factors causing inconsistency (practice structure, player engagement, session timing)`,
            `Action: Standardize practice format and intensity to reduce ${range.toFixed(2)}-point variance`
          ]
        });
      } else if (stdDev < 0.15 && values.length >= 5) {
        insights.recommendations.push({
          priority: 'low',
          category: 'consistency',
          message: `Excellent consistency: ${stdDev.toFixed(2)} standard deviation (very stable performance)`,
          data: {
            standardDeviation: stdDev.toFixed(2),
            consistencyScore: 'excellent'
          },
          actions: [
            `Maintain: Current practice consistency is excellent (${stdDev.toFixed(2)} std dev)`,
            'Continue: Stable performance indicates well-structured practices'
          ]
        });
      }
    }
    
    // Zone-based recommendations
    if (currentValue >= excellentThreshold) {
      insights.recommendations.push({
        priority: 'low',
        category: 'performance_zone',
        message: `Excellent zone performance: ${currentValue.toFixed(2)} (above 4.0 threshold)`,
        data: {
          currentZone: 'Excellent',
          distanceFromThreshold: (currentValue - excellentThreshold).toFixed(2),
          nextMilestone: 'Maintain 4.0+'
        },
        actions: [
          `Status: In Excellent zone (${currentValue.toFixed(2)} ≥ 4.0)`,
          'Goal: Maintain this level and push toward 4.2+',
          'Focus: Fine-tune details and maintain high standards'
        ]
      });
    } else if (currentValue >= goodThreshold) {
      const distanceToExcellent = excellentThreshold - currentValue;
      insights.recommendations.push({
        priority: 'medium',
        category: 'performance_zone',
        message: `Good zone: ${currentValue.toFixed(2)} (${distanceToExcellent.toFixed(2)} points from Excellent)`,
        data: {
          currentZone: 'Good',
          distanceToExcellent: distanceToExcellent.toFixed(2),
          sessionsToExcellent: trend > 0.1 ? Math.ceil(distanceToExcellent / (trend / Math.min(5, values.length))) : 'N/A'
        },
        actions: [
          `Current: ${currentValue.toFixed(2)} in Good zone (3.5-4.0)`,
          `Target: Reach Excellent zone (4.0+) - need +${distanceToExcellent.toFixed(2)} points`,
          trend > 0.1 ? `Timeline: At current trend, could reach 4.0+ in ~${Math.ceil(distanceToExcellent / (trend / Math.min(5, values.length)))} sessions` : 'Action: Increase improvement rate to reach 4.0+ sooner',
          'Focus: Identify and replicate practices that drive highest ratings'
        ]
      });
    } else if (currentValue >= needsWorkThreshold) {
      const distanceToGood = goodThreshold - currentValue;
      
      // Analyze what drives ratings above 3.5
      const highRatingAnalysis = analyzeHighRatingDrivers(ss, tz, values, labels);
      
      const actions = [
        `Critical: ${currentValue.toFixed(2)} below Good threshold (3.5)`,
        `Immediate goal: Reach Good zone - need +${distanceToGood.toFixed(2)} points`,
        `Action: ${distanceToGood < 0.2 ? 'Urgent - very close to Good zone, focus on next 1-2 sessions' : 'Focus on fundamentals and practice structure'}`
      ];
      
      // Note: High-rating analysis is displayed separately in the frontend, not in Action Items
      
      insights.recommendations.push({
        priority: 'high',
        category: 'performance_zone',
        message: `Needs improvement: ${currentValue.toFixed(2)} (${distanceToGood.toFixed(2)} points from Good zone)`,
        data: {
          currentZone: 'Needs Work',
          distanceToGood: distanceToGood.toFixed(2),
          urgency: distanceToGood < 0.2 ? 'high' : 'medium',
          highRatingAnalysis: highRatingAnalysis
        },
        actions: actions
      });
    } else {
      insights.recommendations.push({
        priority: 'critical',
        category: 'performance_zone',
        message: `Critical zone: ${currentValue.toFixed(2)} (below 3.0 - immediate attention needed)`,
        data: {
          currentZone: 'Critical',
          distanceToNeedsWork: (needsWorkThreshold - currentValue).toFixed(2),
          distanceToGood: (goodThreshold - currentValue).toFixed(2)
        },
        actions: [
          `URGENT: ${currentValue.toFixed(2)} in Critical zone (<3.0)`,
          `Immediate: Focus on fundamentals - need +${(needsWorkThreshold - currentValue).toFixed(2)} to reach Needs Work zone`,
          `Short-term: Target Good zone (3.5) - need +${(goodThreshold - currentValue).toFixed(2)} total`,
          'Action: Comprehensive review of practice structure, player engagement, and coaching approach'
        ]
      });
    }
    
    // ===== PLAYER CORRELATION ANALYSIS (Always show) =====
    try {
      const playerCorrelations = _analyzePlayerCorrelations_(ss, tz, values, labels);
      
      // Check for successful correlations first (even if diagnostic exists)
      if (playerCorrelations && playerCorrelations.allCorrelations && playerCorrelations.allCorrelations.length > 0) {
      // Use all correlations, sorted by absolute correlation value (already sorted from function)
      const allPlayers = playerCorrelations.allCorrelations;
      const topPlayers = allPlayers.slice(0, 5); // Top 5 positive correlations
      
      // Get bottom 5 players by correlation (lowest correlations - includes negative and very low positive)
      // Sort all players by correlation value (lowest first), then take bottom 5
      const negativePlayers = [...allPlayers]
        .sort((a, b) => a.correlation - b.correlation) // Sort by correlation value (lowest first)
        .slice(0, Math.min(5, allPlayers.length)); // Take bottom 5 (or all if fewer than 5)
      
      const highImpactPlayers = allPlayers.filter(p => p.correlation > 0.5);
      const avgCorrelation = allPlayers.reduce((sum, p) => sum + Math.abs(p.correlation), 0) / allPlayers.length;
      
      // Determine priority based on current zone
      let priority = 'medium';
      let categoryMsg = 'Individual Player Impact Analysis';
      
      if (currentValue < needsWorkThreshold) {
        priority = 'critical';
        categoryMsg = 'URGENT: Player Impact Analysis';
      } else if (currentValue < goodThreshold) {
        priority = 'high';
        categoryMsg = 'Individual Player Impact Analysis';
      }
      
      // Use diagnostic data if available for better session count
      const diagnostic = playerCorrelations.diagnostic || {};
      const avgSessions = diagnostic.avgSessionsPerPlayer || topPlayers[0].sessionsCount;
      const sessionsAnalyzed = diagnostic.avgSessionsPerPlayer ? 
        `${Math.round(avgSessions * 10) / 10} sessions (avg per player)` : 
        `${topPlayers[0].sessionsCount} sessions`;
      
      insights.recommendations.push({
        priority: priority,
        category: 'player_impact',
        message: `${categoryMsg}: ${playerCorrelations.totalPlayers} players analyzed with average ${Math.round(avgSessions * 10) / 10} sessions each`,
        data: {
          totalPlayersAnalyzed: playerCorrelations.totalPlayers,
          sessionsAnalyzed: avgSessions,
          averageCorrelation: avgCorrelation.toFixed(3),
          highImpactCount: highImpactPlayers.length,
          currentTeamRating: currentValue.toFixed(2),
          teamDatesRead: diagnostic.teamDatesRead,
          teamDatesParsed: diagnostic.teamDatesParsed,
          playerDatesFound: diagnostic.playerDatesFound,
          totalMatchesFound: diagnostic.totalMatchesFound,
          avgSessionsPerPlayer: diagnostic.avgSessionsPerPlayer
        },
        diagnostic: diagnostic, // Include full diagnostic for Action Items section
        actions: [],
        // Generate summary insights based on correlation analysis
        summary: generateCorrelationSummary(topPlayers, negativePlayers),
        // Include top 5 players sorted by correlation strength (absolute value)
        playerDetails: topPlayers.map(p => ({
          player: p.player,
          correlation: p.correlation.toFixed(3),
          avgRating: p.avgRating.toFixed(2),
          impact: p.impact,
          sessions: p.sessionsCount,
          bestTrait: p.bestTrait || 'N/A'
        })),
        // Include top 5 players with negative correlations
        playerDetailsNegative: negativePlayers.map(p => ({
          player: p.player,
          correlation: p.correlation.toFixed(3),
          avgRating: p.avgRating.toFixed(2),
          impact: p.impact,
          sessions: p.sessionsCount,
          bestTrait: p.bestTrait || 'N/A'
        }))
      });
      } else if (playerCorrelations && playerCorrelations.diagnostic) {
      // Show diagnostic info if no matches found or insufficient data
        const diag = playerCorrelations.diagnostic;
        const actions = [];
        
        // If missing columns, show available columns first
        if (diag.availableColumns && diag.availableColumns.length > 0) {
          if (diag.headerRowFound) {
            actions.push(`Header row detected: Row ${diag.headerRowFound}`);
          }
          if (diag.row1Columns && diag.row1Columns.length > 0) {
            const row1NonEmpty = diag.row1Columns.filter(c => c && c !== '(empty)');
            if (row1NonEmpty.length > 0) {
              actions.push(`Row 1 columns: ${row1NonEmpty.slice(0, 10).join(', ')}`);
            }
          }
          if (diag.row2Columns && diag.row2Columns.length > 0) {
            const row2NonEmpty = diag.row2Columns.filter(c => c && c !== '(empty)');
            if (row2NonEmpty.length > 0) {
              actions.push(`Row 2 columns: ${row2NonEmpty.slice(0, 10).join(', ')}`);
            }
          }
          if (diag.allColumns && diag.allColumns.length > 0) {
            actions.push(`All columns in Daily/Log sheet: ${diag.allColumns.slice(0, 15).join(', ')}${diag.allColumns.length > 15 ? '...' : ''}`);
          } else {
            actions.push(`Available columns in Daily/Log sheet: ${diag.availableColumns.slice(0, 15).join(', ')}${diag.availableColumns.length > 15 ? '...' : ''}`);
          }
          if (diag.foundColumns) {
            const found = [];
            if (diag.foundColumns.Date) found.push(`Date: "${diag.foundColumns.Date}"`);
            if (diag.foundColumns.Player) found.push(`Player: "${diag.foundColumns.Player}"`);
            if (diag.foundColumns.Overall) found.push(`Overall: "${diag.foundColumns.Overall}"`);
            if (found.length > 0) {
              actions.push(`Found columns: ${found.join(', ')}`);
            }
          }
          actions.push('Required: Daily/Log sheet needs a "Player" column and a rating column (named "Overall", "Avg", "Rating", "Score", or column I/L)');
        } else {
          actions.push(`Team dates found: ${diag.teamDatesFound} (sample: ${diag.sampleTeamDate || 'none'})`);
          actions.push(`Player dates found: ${diag.playerDatesFound} (sample: ${diag.samplePlayerDate || 'none'})`);
        }
        
        if (diag.totalMatchesFound > 0) {
          actions.push(`Total matches: ${diag.totalMatchesFound} across ${diag.playersWithData || 0} players`);
          if (diag.playersWithInsufficientData && diag.playersWithInsufficientData.length > 0) {
            const sample = diag.playersWithInsufficientData.slice(0, 3).map(p => `${p.player} (${p.matches} matches)`).join(', ');
            actions.push(`Players with <3 matches: ${sample}${diag.playersWithInsufficientData.length > 3 ? '...' : ''}`);
            actions.push('Need: Each player needs at least 3 matching sessions for correlation analysis');
          }
        } else {
          actions.push('Issue: No dates matched between Dashboard1 and Daily/Log sheet');
          if (diag.sampleTeamLabels && diag.sampleTeamLabels.length > 0) {
            actions.push(`Sample Dashboard1 labels: ${diag.sampleTeamLabels.slice(0, 3).join(', ')}`);
          }
          if (diag.samplePlayerDateKeys && diag.samplePlayerDateKeys.length > 0) {
            actions.push(`Sample Daily/Log sheet dates: ${diag.samplePlayerDateKeys.slice(0, 3).join(', ')}`);
          }
          if (diag.dashboardDateStrings && diag.dashboardDateStrings.length > 0) {
            actions.push(`Parsed Dashboard1 dates: ${diag.dashboardDateStrings.slice(0, 3).join(', ')}`);
          }
          if (diag.playerDateStrings && diag.playerDateStrings.length > 0) {
            actions.push(`Parsed Log dates: ${diag.playerDateStrings.slice(0, 3).join(', ')}`);
          }
          actions.push('Check: Ensure dates in both sheets represent the same sessions');
        }
        
        insights.recommendations.push({
          priority: 'low',
          category: 'player_impact',
          message: `Player Impact Analysis: ${diag.message || 'Insufficient Data'}`,
          data: diag,
          actions: actions
        });
      } else {
        // If correlation analysis returned null or empty, add a note
        insights.recommendations.push({
          priority: 'low',
          category: 'player_impact',
          message: 'Player Impact Analysis: Insufficient data for correlation analysis',
          data: {
            reason: 'Need at least 3 matching sessions between player ratings and team ratings'
          },
          actions: [
            'Ensure player ratings in Daily/Log sheet match session dates in Dashboard1',
            'Need minimum 3 sessions with both individual and team ratings',
            'Check back after more sessions are recorded'
          ]
        });
      }
    } catch (corrError) {
      // If correlation analysis fails, add error note
      insights.recommendations.push({
        priority: 'low',
        category: 'player_impact',
        message: 'Player Impact Analysis: Unable to analyze player correlations',
        data: {
          error: 'Analysis failed'
        },
        actions: [
          'Check that Daily/Log sheet has player ratings with dates',
          'Verify date formats match between Daily/Log and Dashboard1 sheets'
        ]
      });
    }
    
    return {
      ok: true,
      insights: insights,
      generatedAt: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ss'Z'")
    };
    
  } catch (e) {
    return { ok: false, error: String(e) };
  }
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

/** Get player's last 10 sessions ratings from Dashboard1 (same source as daily ratings table)
 *  Returns: { ok: true, labels: [...], values: [...], sessions: [...] } 
 *  Uses the same data source as the daily ratings table (Dashboard1 grid)
 */
function getPlayerRatingSeries(playerName) {
  console.log('[getPlayerRatingSeries] Called with playerName:', playerName);
  if (!playerName) {
    console.log('[getPlayerRatingSeries] No player name provided');
    return { ok: false, reason: 'No player name' };
  }
  
  const sh = _open().getSheetByName('Dashboard1');
  if (!sh) {
    console.log('[getPlayerRatingSeries] Dashboard1 sheet not found');
    return { ok: false, reason: 'Dashboard1 sheet not found' };
  }

  // Get the grid data (same source as daily ratings table)
  const START_ROW = 4;   // header row
  const END_ROW = 34;    // last data row
  const START_COL = 1;    // A
  const END_COL = 19;    // S (expanded to include all players)

  const numRows = END_ROW - START_ROW + 1;
  const numCols = END_COL - START_COL + 1;
  const grid = sh.getRange(START_ROW, START_COL, numRows, numCols).getDisplayValues();
  if (!grid.length) {
    return { ok: false, reason: 'No data in Dashboard1' };
  }

  const headers = grid[0]; // ["Date","Abercrombie",...]
  
  // Find the player's column index
  const want = _norm(playerName);
  let playerColIndex = -1;
  for (let i = 2; i < headers.length; i++) {
    const header = String(headers[i] || '').trim();
    if (_norm(header) === want) {
      playerColIndex = i;
      break;
    }
  }

  if (playerColIndex === -1) {
    console.log('[getPlayerRatingSeries] Player column not found:', playerName);
    return { ok: false, reason: 'Player column not found' };
  }

  const dateColIndex = 1; // Column B (0-indexed: 1)
  
  const ratings = []; // { date, session, value, rowIndex }

  // Process each row (skip header row 0)
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const dateStr = String(row[dateColIndex] || '').trim();
    
    // Skip blank rows
    if (!dateStr) continue;

    // Get player's rating for this session
    const ratingStr = String(row[playerColIndex] || '').trim();
    if (!ratingStr) continue;

    // Try to parse as number (handle comma decimal separator)
    const rating = parseFloat(ratingStr.replace(',', '.'));
    if (isNaN(rating) || rating <= 0) continue;

    // Extract date and session from date column (e.g., "20-Aug ( Team Practice )")
    const dateMatch = dateStr.match(/^([^(]+)/);
    const dateLabel = dateMatch ? dateMatch[1].trim() : dateStr;
    
    // Parse session from date string if it contains parentheses
    const sessionMatch = String(dateStr || '').match(/\(([^)]+)\)/);
    const session = sessionMatch && sessionMatch[1] ? sessionMatch[1].trim() : '';

    ratings.push({ date: dateLabel, session, value: rating, rowIndex: r });
  }

  if (!ratings.length) {
    console.log('[getPlayerRatingSeries] No ratings found');
    return { ok: false, reason: 'No ratings found' };
  }
  console.log('[getPlayerRatingSeries] Found', ratings.length, 'ratings');

  // Ratings are already in row order (oldest first), take last 10 (most recent)
  // Keep them in chronological order (oldest to newest)
  const last10 = ratings.slice(-10);
  console.log('[getPlayerRatingSeries] Taking last 10:', last10.length);

  // Ensure chronological order (oldest to newest) - they should already be sorted, but sort again to be safe
  const sortedLast10 = [...last10].sort((a, b) => {
    // Compare by row index (earlier rows = older data)
    return a.rowIndex - b.rowIndex;
  });

  const labels = sortedLast10.map(r => r.date);
  const values = sortedLast10.map(r => r.value);
  const sessionLabels = sortedLast10.map(r => r.session);

  console.log('[getPlayerRatingSeries] Returning', labels.length, 'sessions');
  console.log('[getPlayerRatingSeries] Labels:', labels);
  console.log('[getPlayerRatingSeries] Values:', values);

  return { ok: true, labels, values, sessions: sessionLabels };
}

/** Get game ratings (GBL/EC) for all players from Log sheet
 *  Returns: { ok: true, players: { playerName: { avg: number, games: number } } }
 */
function getGameRatings() {
  try {
    const sh = _open().getSheetByName('Log');
    if (!sh) return { ok: false, error: 'Log sheet not found' };

    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: true, players: {} };

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
      Session: find(/^session/i),
      Player: find(/^player/i),
      Exec: find(/^execution/i),
      Energy: find(/^energy/i),
      Comm: find(/^communication/i),
      Adapt: find(/^adapt/i),
      Res: find(/^resilience/i),
      Impact: find(/^team\s*impact/i)
    };
    
    if (idx.Session == null || idx.Player == null) {
      return { ok: false, error: 'Session or Player column not found' };
    }
    
    const traitCols = [idx.Exec, idx.Energy, idx.Comm, idx.Adapt, idx.Res, idx.Impact].filter(i => i != null);
    if (!traitCols.length) {
      return { ok: false, error: 'No trait columns found' };
    }
    
    // Get date index for grouping games
    const dateIdx = find(/^date/i);
    
    const rows = sh.getRange(2, 1, lastRow - 1, colCount).getValues();
    const playerRatings = {}; // playerName -> { ratingsByGame: Map(gameKey -> [ratings]), games: Set }
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const session = String(row[idx.Session] || '').trim().toUpperCase();
      const player = String(row[idx.Player] || '').trim();
      
      // Only process GBL or EC games
      if (!session.includes('GBL') && !session.includes('EC')) continue;
      if (!player) continue;
      
      // Create unique game key from session and date
      let gameKey = session;
      if (dateIdx != null && row[dateIdx]) {
        const dateVal = row[dateIdx];
        if (dateVal instanceof Date) {
          gameKey = session + '_' + dateVal.getTime();
        } else if (dateVal) {
          gameKey = session + '_' + String(dateVal).trim();
        }
      }
      
      // Calculate average rating from traits
      const scores = traitCols.map(c => {
        const val = row[c];
        if (val == null || val === '') return null;
        if (typeof val === 'number') return val;
        const num = parseFloat(String(val).replace(',', '.'));
        return !isNaN(num) && num > 0 ? num : null;
      }).filter(n => n !== null);
      
      if (scores.length === 0) continue;
      
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      
      if (!playerRatings[player]) {
        playerRatings[player] = { ratingsByGame: new Map(), gameKeys: new Set() };
      }
      
      // Track unique games
      if (!playerRatings[player].gameKeys.has(gameKey)) {
        playerRatings[player].gameKeys.add(gameKey);
      }
      
      // Store ratings per game (in case there are multiple ratings per game)
      if (!playerRatings[player].ratingsByGame.has(gameKey)) {
        playerRatings[player].ratingsByGame.set(gameKey, []);
      }
      playerRatings[player].ratingsByGame.get(gameKey).push(avg);
    }
    
    // Calculate final averages (one rating per game, using average if multiple ratings exist for same game)
    const result = {};
    Object.keys(playerRatings).forEach(player => {
      const data = playerRatings[player];
      const allRatings = [];
      
      // For each unique game, use the average rating for that game
      data.ratingsByGame.forEach((ratings, gameKey) => {
        const gameAvg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
        allRatings.push(gameAvg);
      });
      
      if (allRatings.length > 0) {
        result[player] = {
          avg: allRatings.reduce((a, b) => a + b, 0) / allRatings.length,
          games: data.gameKeys.size
        };
      }
    });
    
    return { ok: true, players: result };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}



















/*** ====== RATINGS (Dashboard1!A4:S34) ====== ***/
function apiGetRatingsGrid() {
  const SH = 'Dashboard1';
  const START_ROW = 4;   // header row (Date, players…)
  const END_ROW   = 34;  // last heatmap row (adjust as needed)
  const START_COL = 1;   // A
  const END_COL   = 19;  // S (expanded to include all players)

  const sh = _open().getSheetByName(SH);
  if (!sh) return { ok:false, error:'Dashboard1 not found' };

  const numRows = END_ROW - START_ROW + 1;
  const numCols = END_COL - START_COL + 1;
  const grid = sh.getRange(START_ROW, START_COL, numRows, numCols).getDisplayValues();
  if (!grid.length) return { ok:false, error:'No data in A4:S34' };

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

/**
 * Get list of player names from Dashboard1 headers (for position mapping)
 */
function getPlayerNamesFromDashboard() {
  const SH = 'Dashboard1';
  const START_ROW = 4;   // header row (Date, players…)
  const START_COL = 1;   // A
  const END_COL   = 19;  // S (expanded to include all players)
  
  const sh = _open().getSheetByName(SH);
  if (!sh) return { ok: false, error: 'Dashboard1 not found' };
  
  const headers = sh.getRange(START_ROW, START_COL, 1, END_COL - START_COL + 1).getDisplayValues()[0];
  
  // Player names start from column C (index 2)
  // Skip first two columns: A (blank/label) and B (Date/Session)
  const players = [];
  for (let i = 2; i < headers.length; i++) {
    const name = String(headers[i] || '').trim();
    if (name) players.push(name);
  }
  
  return { ok: true, players };
}

/**
 * Player position mapping
 */
function getPlayerPositions() {
  return {
    'CARDEANAS': 'PG',
    'MOURATOS': 'PG',
    'ABERCROMBIE': 'PF',
    'HARRIS': 'SG',
    'ITTOUNAS': 'SF',
    'JANKOVIC': 'PF',
    'KAKLAMANAKIS': 'C',
    'NICHOLS': 'SG',
    'PAPADAKIS': 'SG',
    'PAYNE': 'C',
    'PETRAKIS': 'PF/C',  // Dual position
    'VANTUBBERGEN': 'SF'
  };
}

/**
 * Get position for a player (case-insensitive lookup)
 */
function getPlayerPosition(playerName) {
  const positions = getPlayerPositions();
  const normalized = _norm(playerName);
  
  for (const [player, position] of Object.entries(positions)) {
    if (_norm(player) === normalized) {
      return position;
    }
  }
  return null;
}

/**
 * Get aggregated rating series for a position (e.g., "PG", "SG", "SF", "PF", "C")
 * Returns averaged ratings across all players in that position
 */
function getPositionRatingSeries(position) {
  console.log('[getPositionRatingSeries] Called with position:', position);
  
  if (!position) {
    return { ok: false, reason: 'No position provided' };
  }
  
  const sh = _open().getSheetByName('Dashboard1');
  if (!sh) {
    console.log('[getPositionRatingSeries] Dashboard1 sheet not found');
    return { ok: false, reason: 'Dashboard1 sheet not found' };
  }
  
  // Get the grid data
  const START_ROW = 4;
  const END_ROW = 34;
  const START_COL = 1;
  const END_COL = 19;  // S (expanded to include all players)
  
  const numRows = END_ROW - START_ROW + 1;
  const numCols = END_COL - START_COL + 1;
  const grid = sh.getRange(START_ROW, START_COL, numRows, numCols).getDisplayValues();
  
  if (!grid.length) {
    return { ok: false, reason: 'No data in Dashboard1' };
  }
  
  const headers = grid[0];
  const positions = getPlayerPositions();
  
  // Find players in this position
  const positionPlayers = [];
  for (let i = 2; i < headers.length; i++) {
    const playerName = String(headers[i] || '').trim();
    if (!playerName) continue;
    
    const playerPos = getPlayerPosition(playerName);
    // Handle dual positions like "PF/C"
    if (playerPos === position || (playerPos && playerPos.includes(position))) {
      positionPlayers.push({ name: playerName, colIndex: i });
    }
  }
  
  if (positionPlayers.length === 0) {
    console.log('[getPositionRatingSeries] No players found for position:', position);
    return { ok: false, reason: 'No players found for this position' };
  }
  
  console.log('[getPositionRatingSeries] Found players:', positionPlayers.map(p => p.name).join(', '));
  
  const dateColIndex = 1; // Column B
  
  // Collect ratings by session
  const sessionRatings = {}; // sessionKey -> { date, session, values: [], rowIndex }
  
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const dateStr = String(row[dateColIndex] || '').trim();
    
    if (!dateStr) continue;
    
    // Extract date and session
    const dateMatch = dateStr.match(/^([^(]+)/);
    const dateLabel = dateMatch ? dateMatch[1].trim() : dateStr;
    const sessionMatch = String(dateStr || '').match(/\(([^)]+)\)/);
    const session = sessionMatch && sessionMatch[1] ? sessionMatch[1].trim() : '';
    
    const sessionKey = dateLabel + '|' + session;
    
    if (!sessionRatings[sessionKey]) {
      sessionRatings[sessionKey] = {
        date: dateLabel,
        session: session,
        values: [],
        rowIndex: r
      };
    }
    
    // Collect ratings from all players in this position
    for (const player of positionPlayers) {
      const ratingStr = String(row[player.colIndex] || '').trim();
      if (!ratingStr) continue;
      
      const rating = parseFloat(ratingStr.replace(',', '.'));
      if (!isNaN(rating) && rating > 0) {
        sessionRatings[sessionKey].values.push(rating);
      }
    }
  }
  
  // Calculate averages and filter sessions with data
  const sessions = Object.values(sessionRatings)
    .filter(s => s.values.length > 0)
    .map(s => ({
      date: s.date,
      session: s.session,
      value: s.values.reduce((a, b) => a + b, 0) / s.values.length,
      rowIndex: s.rowIndex,
      playerCount: s.values.length
    }))
    .sort((a, b) => a.rowIndex - b.rowIndex)
    .slice(-10); // Last 10 sessions
  
  if (sessions.length === 0) {
    console.log('[getPositionRatingSeries] No sessions with ratings found');
    return { ok: false, reason: 'No ratings found for this position' };
  }
  
  const labels = sessions.map(s => s.date);
  const values = sessions.map(s => s.value);
  const sessionLabels = sessions.map(s => s.session);
  
  console.log('[getPositionRatingSeries] Returning', sessions.length, 'sessions');
  console.log('[getPositionRatingSeries] Players in position:', positionPlayers.length);
  
  return {
    ok: true,
    labels,
    values,
    sessions: sessionLabels,
    playerCount: positionPlayers.length,
    players: positionPlayers.map(p => p.name)
  };
}




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

    const safePayload = payload || {};
    const title         = String(safePayload.title || '').trim();
    const audienceType  = String(safePayload.audienceType || '').trim().toLowerCase(); // player|team|group
    const audienceName  = String(safePayload.audienceName || '').trim();
    const description   = String(safePayload.description || '').trim();
    const clips         = Array.isArray(safePayload.clips) ? safePayload.clips.filter(Boolean) : [];
    const captions      = Array.isArray(safePayload.captions) ? safePayload.captions : [];

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
  
  // Also start a presence session for admin stats
  try {
    const userId = String(name).replace(/\s+/g, '_').toLowerCase() + '_' + Date.now().toString().slice(-8);
    startPresenceSession(userId, name);
  } catch (e) {
    Logger.log('Failed to auto-start presence session in recordPresence: ' + String(e));
    // Continue anyway - this is not critical
  }
  
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
    Logger.log('startPresenceSession called with userId=' + String(userId) + ', userName=' + String(userName));
    
    const sh = _presenceEnsureLogSheet_();
    if (!sh) {
      Logger.log('ERROR: _presenceEnsureLogSheet_ returned null');
      return { ok:false, error:'Failed to get Presence_Log sheet' };
    }
    
    Logger.log('Presence_Log sheet obtained, lastRow before: ' + sh.getLastRow());
    
    const now = new Date();
    const tsLocal = Utilities.formatDate(now, _getTz_(), 'dd/MM/yyyy HH:mm:ss');
    
    Logger.log('Preparing to append row: [' + tsLocal + ', ' + String(userId) + ', ' + String(userName||'') + ', login]');
    
    // If you don't want to change columns, replace r[0] with tsLocal only:
    sh.appendRow([tsLocal, String(userId), String(userName||''), 'login']);
    
    Logger.log('Row appended successfully, lastRow after: ' + sh.getLastRow());
    
    // keep heartbeat in sync
    try {
    recordHeartbeat(userId, userName);
      Logger.log('Heartbeat recorded');
    } catch (hbErr) {
      Logger.log('Heartbeat failed (non-critical): ' + String(hbErr));
    }
    
    // Store session start time for duration tracking
    try {
      const sessionKey = 'session_' + String(userId);
      PropertiesService.getScriptProperties().setProperty(sessionKey, now.getTime().toString());
      Logger.log('Session property stored');
    } catch (propErr) {
      Logger.log('Property storage failed (non-critical): ' + String(propErr));
    }
    
    // Log activity
    try {
      _logUserActivity(userName, 'login', { userId: String(userId) });
      Logger.log('Activity logged');
    } catch (err) {
      Logger.log('Activity logging failed (non-critical): ' + String(err));
    }
    
    Logger.log('startPresenceSession completed successfully');
    return { ok:true };
  } catch (e) {
    Logger.log('ERROR in startPresenceSession: ' + String(e));
    return { ok:false, error:String(e) };
  }
}

function endPresenceSession(userId, userName) {
  try {
    const sh = _presenceEnsureLogSheet_();
    const now = new Date();
    const tsLocal = Utilities.formatDate(now, _getTz_(), 'dd/MM/yyyy HH:mm:ss');
    sh.appendRow([tsLocal, String(userId), String(userName||''), 'logout']);
    
    // Calculate session duration
    const sessionKey = 'session_' + String(userId);
    const props = PropertiesService.getScriptProperties();
    const startTimeStr = props.getProperty(sessionKey);
    let durationMinutes = null;
    
    if (startTimeStr) {
      const startTime = Number(startTimeStr);
      if (isFinite(startTime)) {
        durationMinutes = Math.round((now.getTime() - startTime) / 1000 / 60);
        props.deleteProperty(sessionKey);
      }
    }
    
    // Log activity with duration
    try {
      _logUserActivity(userName, 'logout', { 
        userId: String(userId),
        durationMinutes: durationMinutes 
      });
    } catch (err) {
      console.error('Activity logging failed:', err);
    }
    
    return { ok:true, durationMinutes: durationMinutes };
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

/* ===================== Activity Logging ===================== */

function _ensureActivityLogSheet_() {
  const ss = _open();
  const name = 'Admin_ActivityLog';
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,6).setValues([['Timestamp', 'User', 'Action', 'Details', 'Session', 'Duration (min)']]);
    // Format column A as text to preserve exact string format (avoids date conversion/timezone issues)
    sh.getRange('A:A').setNumberFormat('@'); // @ means text format
  } else {
    // Ensure existing sheet also uses text format for column A
    try {
      sh.getRange('A:A').setNumberFormat('@');
    } catch (e) {
      // Ignore if can't set format
    }
  }
  return sh;
}

function _logUserActivity(userName, action, details) {
  try {
    const sh = _ensureActivityLogSheet_();
    const now = new Date();
    const tsLocal = Utilities.formatDate(now, _getTz_(), 'dd/MM/yyyy HH:mm:ss');
    const detailsJson = JSON.stringify(details || {});
    const session = details && details.session ? String(details.session) : '';
    const duration = details && details.durationMinutes ? Number(details.durationMinutes) : '';
    sh.appendRow([tsLocal, String(userName||''), String(action||''), detailsJson, session, duration]);
  } catch (e) {
    console.error('Activity log failed:', e);
  }
}

/* ===================== Admin Portal Functions ===================== */

/** Get all user activity stats - only accessible to admin (Dimitris) */
function getAdminStats() {
  try {
    Logger.log('getAdminStats called at ' + new Date().toISOString());
    
    let ss;
    try {
      ss = _open();
    } catch (openErr) {
      Logger.log('Error in _open(): ' + String(openErr));
      return { 
        ok: false, 
        error: 'Failed to open spreadsheet: ' + String(openErr),
        userStats: [],
        recentActivities: [],
        sessions: [],
        featureUsage: {},
        playerCoverage: [],
        summary: { totalUsers: 0, totalLogins: 0, totalRatings: 0, totalNotes: 0 }
      };
    }
    
    if (!ss) {
      Logger.log('_open() returned null/undefined');
      return { 
        ok: false, 
        error: 'Spreadsheet is null',
        userStats: [],
        recentActivities: [],
        sessions: [],
        featureUsage: {},
        playerCoverage: [],
        summary: { totalUsers: 0, totalLogins: 0, totalRatings: 0, totalNotes: 0 }
      };
    }
    
    Logger.log('Spreadsheet opened successfully');
    
    let activitySh, presenceSh, logSh;
    try {
      activitySh = ss.getSheetByName('Admin_ActivityLog');
      // Ensure Presence_Log exists (it's created when users log in, but might not exist yet)
      presenceSh = _presenceEnsureLogSheet_();
      logSh = ss.getSheetByName('Log');
      Logger.log('Sheets found: Activity=' + !!activitySh + ', Presence=' + !!presenceSh + ', Log=' + !!logSh);
      if (presenceSh) {
        Logger.log('Presence_Log last row: ' + presenceSh.getLastRow());
      }
    } catch (sheetErr) {
      Logger.log('Error getting sheets: ' + String(sheetErr));
      return { 
        ok: false, 
        error: 'Error accessing sheets: ' + String(sheetErr),
        userStats: [],
        recentActivities: [],
        sessions: [],
        featureUsage: {},
        playerCoverage: [],
        summary: { totalUsers: 0, totalLogins: 0, totalRatings: 0, totalNotes: 0 }
      };
    }
    
    // Get activity log
    const activities = [];
    if (activitySh && activitySh.getLastRow() > 1) {
      const actRows = activitySh.getDataRange().getValues();
      const actDisplayRows = activitySh.getDataRange().getDisplayValues(); // Get display strings
      for (let i = 1; i < actRows.length; i++) {
        const row = actRows[i];
        const displayRow = actDisplayRows[i] || [];
        let details = {};
        try {
          details = JSON.parse(String(row[3] || '{}'));
        } catch (e) {
          details = { raw: String(row[3] || '') };
        }
        let timestamp;
        try {
          if (row[0] instanceof Date) {
            timestamp = row[0].getTime();
          } else if (row[0]) {
            timestamp = new Date(row[0]).getTime();
          } else {
            timestamp = Date.now();
          }
        } catch (e) {
          timestamp = Date.now();
        }
        
        // Use display value directly from sheet to get exact string shown in sheet
        let dateString;
        if (displayRow[0] && String(displayRow[0]).trim()) {
          // Use the display value (what the sheet shows) directly - this avoids any timezone conversion
          dateString = String(displayRow[0]).trim();
          // Remove comma if present (Google Sheets sometimes adds commas in display format)
          // Handle formats like "29/10/2025, 20:44:44" -> "29/10/2025 20:44:44"
          if (dateString.includes(',')) {
            dateString = dateString.replace(/,\s*/g, ' ');
          }
          Logger.log('Activity row ' + i + ' - displayRow[0]: "' + String(displayRow[0]) + '", parsed dateString: "' + dateString + '"');
        } else if (row[0] instanceof Date) {
          // Fallback: if display value not available, format using Athens timezone
          dateString = Utilities.formatDate(row[0], _getTz_(), 'dd/MM/yyyy HH:mm:ss');
        } else if (typeof row[0] === 'string') {
          dateString = String(row[0]).trim().replace(/,/g, '');
        } else {
          dateString = Utilities.formatDate(new Date(), _getTz_(), 'dd/MM/yyyy HH:mm:ss');
        }
        
        activities.push({
          timestamp: timestamp,
          timestampString: dateString, // Format using Athens timezone
          user: String(row[1] || ''),
          action: String(row[2] || ''),
          details: details,
          session: String(row[4] || ''),
          duration: row[5] ? Number(row[5]) : null
        });
      }
    }
    
    // Get login/logout history
    const sessions = [];
    Logger.log('Checking presence sheet - lastRow: ' + (presenceSh ? presenceSh.getLastRow() : 'null'));
    if (presenceSh) {
      Logger.log('Presence_Log sheet exists');
      const lastRow = presenceSh.getLastRow();
      Logger.log('Presence_Log last row: ' + lastRow);
      
      if (lastRow > 1) {
        try {
          const sessRows = presenceSh.getDataRange().getValues();
          const sessDisplayRows = presenceSh.getDataRange().getDisplayValues(); // Get display strings to avoid timezone issues
          Logger.log('Presence_Log row count: ' + sessRows.length);
          Logger.log('First few rows: ' + JSON.stringify(sessDisplayRows.slice(0, 3)));
          
          for (let i = 1; i < sessRows.length; i++) {
            const row = sessRows[i];
            const displayRow = sessDisplayRows[i] || [];
            Logger.log('Processing row ' + i + ': ' + JSON.stringify(row));
            
            let timestamp;
            try {
              if (row[0] instanceof Date) {
                timestamp = row[0];
            } else if (typeof row[0] === 'string' && row[0]) {
              // Try to parse date string (format: dd/MM/yyyy HH:mm:ss in local timezone)
              // The string is already in local timezone format, so parse it carefully
              const dateStr = String(row[0]);
              const parts = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
              if (parts) {
                // Parse as local time (dd/MM/yyyy HH:mm:ss format)
                // The date string is in Europe/Athens timezone format
                const year = parseInt(parts[3]);
                const month = parseInt(parts[2]) - 1; // 0-indexed
                const day = parseInt(parts[1]);
                const hour = parseInt(parts[4]);
                const minute = parseInt(parts[5]);
                const second = parseInt(parts[6]);
                
                // Parse date string as if it's in Europe/Athens timezone
                // Google Apps Script Date constructor creates dates in server timezone
                // We need to account for Athens timezone offset
                const tz = _getTz_(); // 'Europe/Athens' = GMT+2 or GMT+3 (DST)
                
                // Create date assuming it's in Athens timezone
                // Use Utilities.parseDate with timezone
                try {
                  const dateStrISO = year + '-' + 
                    String(month + 1).padStart(2, '0') + '-' + 
                    String(day).padStart(2, '0') + ' ' +
                    String(hour).padStart(2, '0') + ':' +
                    String(minute).padStart(2, '0') + ':' +
                    String(second).padStart(2, '0');
                  
                  // Parse with Athens timezone
                  timestamp = Utilities.parseDate(dateStrISO, tz, 'yyyy-MM-dd HH:mm:ss');
                } catch (parseErr) {
                  // Fallback: create date and let browser handle timezone
                  timestamp = new Date(year, month, day, hour, minute, second);
                }
              } else {
                // Fallback to standard Date parsing
                timestamp = new Date(dateStr);
              }
              if (isNaN(timestamp.getTime())) {
                timestamp = new Date();
              }
              } else {
                timestamp = new Date();
              }
            } catch (e) {
              Logger.log('Error parsing timestamp: ' + String(e));
              timestamp = new Date();
            }
            
            // Convert Date to timestamp for serialization
            let timestampMs;
            try {
              if (timestamp instanceof Date) {
                timestampMs = timestamp.getTime();
              } else if (typeof timestamp === 'number') {
                timestampMs = timestamp;
              } else {
                timestampMs = new Date().getTime();
              }
            } catch (e) {
              timestampMs = new Date().getTime();
            }
            
            const name = String(row[2] || '').trim();
            const event = String(row[3] || '').trim();
            
            // Use display value directly from sheet to get exact string shown in sheet
            let dateString;
            if (displayRow[0] && String(displayRow[0]).trim()) {
              // Use the display value (what the sheet shows) directly - this avoids any timezone conversion
              dateString = String(displayRow[0]).trim();
            } else if (row[0] instanceof Date) {
              // Fallback: if display value not available, format using Athens timezone
              dateString = Utilities.formatDate(row[0], _getTz_(), 'dd/MM/yyyy HH:mm:ss');
            } else if (typeof row[0] === 'string') {
              dateString = String(row[0]).trim();
            } else {
              dateString = Utilities.formatDate(new Date(), _getTz_(), 'dd/MM/yyyy HH:mm:ss');
            }
            
            Logger.log('Parsed session: name=' + name + ', event=' + event + ', timestamp=' + timestampMs + ', dateString=' + dateString);
            
            sessions.push({
              timestamp: timestampMs,
              timestampString: dateString, // Format using Athens timezone
              userId: String(row[1] || ''),
              name: name,
              event: event
            });
          }
        } catch (e) {
          Logger.log('Error reading presence log: ' + String(e));
          console.error('Error reading presence log:', e);
        }
      } else {
        Logger.log('Presence_Log sheet exists but has no data rows (only header)');
      }
    } else {
      Logger.log('Presence_Log sheet does not exist');
    }
    
    // Get ratings count per user and player coverage
    const ratingsCount = {};
    const notesCount = {};
    const playerRatings = {}; // Track which players get rated
    const playerNotes = {}; // Track which players get notes
    if (logSh && logSh.getLastRow() > 1) {
      const logRows = logSh.getDataRange().getValues();
      const headers = logRows[0].map(h => String(h||'').trim().toLowerCase());
      const coachIdx = headers.findIndex(h => /coach/i.test(h));
      const notesIdx = headers.findIndex(h => /notes/i.test(h));
      const playerIdx = headers.findIndex(h => /player/i.test(h));
      
      for (let i = 1; i < logRows.length; i++) {
        const row = logRows[i];
        const coach = coachIdx >= 0 ? String(row[coachIdx] || '').trim() : '';
        const note = notesIdx >= 0 ? String(row[notesIdx] || '').trim() : '';
        const player = playerIdx >= 0 ? String(row[playerIdx] || '').trim() : '';
        
        if (coach) {
          ratingsCount[coach] = (ratingsCount[coach] || 0) + 1;
          if (note) {
            notesCount[coach] = (notesCount[coach] || 0) + 1;
          }
        }
        
        if (player) {
          playerRatings[player] = (playerRatings[player] || 0) + 1;
          if (note) {
            playerNotes[player] = (playerNotes[player] || 0) + 1;
          }
        }
      }
    }
    
    Logger.log('Total sessions found: ' + sessions.length);
    
    // Calculate user stats
    const userStats = {};
    const userSessions = {};
    
    // Process sessions to calculate time spent
    sessions.forEach(sess => {
      const name = sess.name;
      if (!name || name === 'Visitor') return;
      
      if (!userStats[name]) {
        userStats[name] = {
          name: name,
          logins: 0,
          logouts: 0,
          totalMinutes: 0,
          lastLogin: null,
          lastActivity: null
        };
      }
      
      if (sess.event === 'login') {
        userStats[name].logins++;
        const sessTime = typeof sess.timestamp === 'number' ? sess.timestamp : (sess.timestamp instanceof Date ? sess.timestamp.getTime() : Date.now());
        if (!userStats[name].lastLogin || sessTime > (typeof userStats[name].lastLogin === 'number' ? userStats[name].lastLogin : (userStats[name].lastLogin instanceof Date ? userStats[name].lastLogin.getTime() : 0))) {
          userStats[name].lastLogin = sessTime;
        }
        userSessions[name] = userSessions[name] || [];
        userSessions[name].push({ start: sessTime, end: null, startString: sess.timestampString || '' });
      } else if (sess.event === 'logout') {
        userStats[name].logouts++;
        if (userSessions[name] && userSessions[name].length > 0) {
          const lastSession = userSessions[name][userSessions[name].length - 1];
          if (lastSession && !lastSession.end) {
            const sessTime = typeof sess.timestamp === 'number' ? sess.timestamp : (sess.timestamp instanceof Date ? sess.timestamp.getTime() : Date.now());
            lastSession.end = sessTime;
            const startTime = typeof lastSession.start === 'number' ? lastSession.start : (lastSession.start instanceof Date ? lastSession.start.getTime() : Date.now());
            const duration = (sessTime - startTime) / 1000 / 60;
            userStats[name].totalMinutes += duration;
          }
        }
      }
    });
    
    // Add ratings and notes counts
    Object.keys(userStats).forEach(name => {
      userStats[name].ratingsCount = ratingsCount[name] || 0;
      userStats[name].notesCount = notesCount[name] || 0;
    });
    
    // Calculate login streaks for each user
    const userStreaks = {};
    const loginDates = {}; // user -> array of login dates (just dates, no time)
    
    try {
      sessions.filter(s => s && s.event === 'login' && s.timestamp).forEach(sess => {
        try {
          const name = sess.name;
          if (!name || name === 'Visitor') return;
          
      const sessTime = typeof sess.timestamp === 'number' ? sess.timestamp : (sess.timestamp instanceof Date ? sess.timestamp.getTime() : Date.now());
      const loginDate = new Date(sessTime);
      if (isNaN(loginDate.getTime())) return; // Skip invalid dates
          
          loginDate.setHours(0, 0, 0, 0);
          const dateStr = loginDate.getTime();
          
          if (!loginDates[name]) loginDates[name] = [];
          if (!loginDates[name].includes(dateStr)) {
            loginDates[name].push(dateStr);
          }
        } catch (e) {
          console.error('Error processing session for streak:', e);
        }
      });
      
      // Calculate streaks for each user
      Object.keys(loginDates).forEach(name => {
        try {
          const dates = loginDates[name].sort((a, b) => b - a); // Most recent first
          if (dates.length === 0) {
            userStreaks[name] = 0;
            return;
          }
          
          // Calculate current streak
          let streak = 0;
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const todayTime = today.getTime();
          
          // Check if logged in today or yesterday
          let checkDate = todayTime;
          while (dates.includes(checkDate)) {
            streak++;
            checkDate -= 24 * 60 * 60 * 1000; // Go back one day
          }
          
          // If no streak from today/yesterday, check longest historical streak
          if (streak === 0 && dates.length > 0) {
            // Find longest consecutive sequence
            let longest = 1;
            let current = 1;
            for (let i = 1; i < dates.length; i++) {
              const diff = dates[i-1] - dates[i];
              if (diff === 24 * 60 * 60 * 1000) { // Exactly 1 day apart
                current++;
                longest = Math.max(longest, current);
              } else {
                current = 1;
              }
            }
            streak = longest;
          }
          
          userStreaks[name] = streak;
        } catch (e) {
          console.error('Error calculating streak for user:', name, e);
          userStreaks[name] = 0;
        }
      });
    } catch (e) {
      console.error('Error in streak calculation:', e);
      // Continue with empty streaks if calculation fails
    }
    
    // Calculate engagement scores (composite metric)
    const engagementScores = {};
    Object.keys(userStats).forEach(name => {
      const stats = userStats[name];
      // Engagement formula: logins (25%) + ratings (35%) + notes (20%) + time (20%)
      const loginScore = Math.min(stats.logins / 30 * 25, 25); // Max 30 logins = 25 points
      const ratingScore = Math.min(stats.ratingsCount / 100 * 35, 35); // Max 100 ratings = 35 points
      const noteScore = Math.min(stats.notesCount / 50 * 20, 20); // Max 50 notes = 20 points
      const timeScore = Math.min((stats.totalMinutes || 0) / 1200 * 20, 20); // Max 1200 min = 20 points
      
      const totalScore = loginScore + ratingScore + noteScore + timeScore;
      engagementScores[name] = Math.round(totalScore * 10) / 10; // Round to 1 decimal
    });
    
    // Add streaks and engagement scores to user stats
    Object.keys(userStats).forEach(name => {
      userStats[name].streak = userStreaks[name] || 0;
      userStats[name].engagementScore = engagementScores[name] || 0;
    });
    
    // Get feature usage from activity log
    const featureUsage = {};
    try {
      activities.forEach(act => {
        try {
          if (act && act.action && (act.action === 'tab_view' || act.action === 'feature_use')) {
            const featureName = act.details && act.details.feature ? act.details.feature : act.action;
            if (featureName) {
              featureUsage[featureName] = (featureUsage[featureName] || 0) + 1;
            }
          }
        } catch (e) {
          console.error('Error processing activity for feature usage:', e);
        }
      });
    } catch (e) {
      console.error('Error processing feature usage:', e);
    }
    
    // Get recent activities
    let recentActivities = [];
    try {
      recentActivities = activities
        .filter(a => a && a.timestamp)
        .sort((a, b) => {
          try {
            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
          } catch (e) {
            return 0;
          }
        })
        .slice(0, 50);
    } catch (e) {
      console.error('Error sorting recent activities:', e);
    }
    
    // Sort player coverage (most rated players)
    let topPlayers = [];
    try {
      topPlayers = Object.entries(playerRatings)
        .filter(([player]) => player && player.trim())
        .map(([player, count]) => ({ player: String(player).trim(), ratings: count || 0, notes: playerNotes[player] || 0 }))
        .sort((a, b) => (b.ratings || 0) - (a.ratings || 0))
        .slice(0, 20);
    } catch (e) {
      console.error('Error processing player coverage:', e);
    }
    
    // Sort user stats by engagement score (Dimitris first, then by score)
    let sortedUserStats = [];
    try {
      sortedUserStats = Object.values(userStats)
        .filter(u => u && u.name)
        .sort((a, b) => {
          try {
            if (a.name === 'Dimitris') return -1;
            if (b.name === 'Dimitris') return 1;
            return (b.engagementScore || 0) - (a.engagementScore || 0);
          } catch (e) {
            return 0;
          }
        });
    } catch (e) {
      console.error('Error sorting user stats:', e);
      sortedUserStats = Object.values(userStats);
    }
    
    // Always return data, even if empty
    Logger.log('Building result object...');
    let result;
    try {
      // Ensure all Date objects are converted to timestamps for JSON serialization
      const serializedSessions = (sessions && sessions.slice) ? sessions.slice(-100).map(s => ({
        timestamp: typeof s.timestamp === 'number' ? s.timestamp : (s.timestamp instanceof Date ? s.timestamp.getTime() : Date.now()),
        timestampString: s.timestampString || '', // Keep original date string for display
        userId: s.userId,
        name: s.name,
        event: s.event
      })) : [];
      
      const serializedActivities = (recentActivities || []).map(a => ({
        timestamp: typeof a.timestamp === 'number' ? a.timestamp : (a.timestamp instanceof Date ? a.timestamp.getTime() : Date.now()),
        timestampString: a.timestampString || '', // Include original date string
        user: a.user,
        action: a.action,
        details: a.details,
        session: a.session,
        duration: a.duration
      }));
      
      // Find last login date string for each user from sessions
      const userLastLoginStrings = {};
      Logger.log('Finding last login strings from ' + sessions.length + ' sessions');
      sessions.forEach(s => {
        if (s.event === 'login' && s.name && s.timestampString) {
          const name = s.name;
          const ts = typeof s.timestamp === 'number' ? s.timestamp : (s.timestamp instanceof Date ? s.timestamp.getTime() : 0);
          const dateStr = String(s.timestampString || '').trim();
          
          Logger.log('Processing login for ' + name + ', timestamp=' + ts + ', dateString=' + dateStr);
          
          if (!userLastLoginStrings[name] || ts > (userLastLoginStrings[name].timestamp || 0)) {
            userLastLoginStrings[name] = {
              timestamp: ts,
              dateString: dateStr
            };
            Logger.log('Updated lastLoginString for ' + name + ': ' + dateStr);
          }
        }
      });
      
      Logger.log('User last login strings: ' + JSON.stringify(Object.keys(userLastLoginStrings)));
      
      const serializedUserStats = (sortedUserStats || []).map(u => ({
        name: u.name,
        logins: u.logins || 0,
        logouts: u.logouts || 0,
        totalMinutes: u.totalMinutes || 0,
        lastLogin: typeof u.lastLogin === 'number' ? u.lastLogin : (u.lastLogin instanceof Date ? u.lastLogin.getTime() : null),
        lastLoginString: (userLastLoginStrings[u.name] && userLastLoginStrings[u.name].dateString) ? String(userLastLoginStrings[u.name].dateString).trim() : '', // Original date string from sheet
        lastActivity: null, // Not currently used
        ratingsCount: u.ratingsCount || 0,
        notesCount: u.notesCount || 0,
        streak: u.streak || 0,
        engagementScore: u.engagementScore || 0
      }));
      
      result = {
        ok: true,
        userStats: serializedUserStats,
        recentActivities: serializedActivities,
        sessions: serializedSessions,
        featureUsage: featureUsage || {},
        playerCoverage: topPlayers || [],
        summary: {
          totalUsers: Object.keys(userStats).length || 0,
          totalLogins: sessions.filter ? sessions.filter(s => s && s.event === 'login').length || 0 : 0,
          totalRatings: Object.values(ratingsCount).reduce((a, b) => (a || 0) + (b || 0), 0) || 0,
          totalNotes: Object.values(notesCount).reduce((a, b) => (a || 0) + (b || 0), 0) || 0
        }
      };
      Logger.log('Result object built successfully, userStats count: ' + result.userStats.length);
    } catch (e) {
      Logger.log('Error building result object: ' + String(e));
      result = { 
        ok: false, 
        error: 'Error building result: ' + String(e),
        userStats: [],
        recentActivities: [],
        sessions: [],
        featureUsage: {},
        playerCoverage: [],
        summary: { totalUsers: 0, totalLogins: 0, totalRatings: 0, totalNotes: 0 }
      };
    }
    
    Logger.log('Returning result, ok=' + result.ok + ', result keys: ' + Object.keys(result).join(','));
    return result;
  } catch (e) {
    console.error('getAdminStats error:', e);
    const errorMsg = String(e || 'Unknown error');
    Logger.log('getAdminStats error details: ' + errorMsg);
    return { 
      ok: false, 
      error: errorMsg,
      userStats: [],
      recentActivities: [],
      sessions: [],
      featureUsage: {},
      playerCoverage: [],
      summary: {
        totalUsers: 0,
        totalLogins: 0,
        totalRatings: 0,
        totalNotes: 0
      }
    };
  }
}

// Test function to verify getAdminStats is callable - simpler version
function testGetAdminStats() {
  try {
    Logger.log('testGetAdminStats called');
    const ss = _open();
    if (!ss) {
      return { ok: false, error: 'Cannot open spreadsheet' };
    }
    return { ok: true, message: 'Basic connectivity works', sheetCount: ss.getSheets().length };
  } catch (e) {
    Logger.log('testGetAdminStats error: ' + String(e));
    return { ok: false, error: String(e) };
  }
}

// Simplified version for testing
function getAdminStatsSimple() {
  try {
    const ss = _open();
    return {
      ok: true,
      userStats: [],
      recentActivities: [],
      sessions: [],
      featureUsage: {},
      playerCoverage: [],
      summary: { totalUsers: 0, totalLogins: 0, totalRatings: 0, totalNotes: 0 }
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Get detailed stats for a specific user */
function getUserDetailStats(userName) {
  try {
    Logger.log('getUserDetailStats called for: ' + String(userName));
    const ss = _open();
    if (!ss) {
      Logger.log('Failed to open spreadsheet in getUserDetailStats');
      return { ok: false, error: 'Failed to open spreadsheet' };
    }
    const activitySh = ss.getSheetByName('Admin_ActivityLog');
    const presenceSh = ss.getSheetByName('Presence_Log');
    const logSh = ss.getSheetByName('Log');
    
    const userActivities = [];
    const userSessions = [];
    const userRatings = [];
    const userPlayers = {};
    const tabUsage = {};
    
    // Get all activities for this user
    if (activitySh && activitySh.getLastRow() > 1) {
      const actRows = activitySh.getDataRange().getValues();
      const actDisplayRows = activitySh.getDataRange().getDisplayValues(); // Get display strings
      for (let i = 1; i < actRows.length; i++) {
        const row = actRows[i];
        const displayRow = actDisplayRows[i] || [];
        if (String(row[1] || '').trim() !== userName) continue;
        
        let details = {};
        try {
          details = JSON.parse(String(row[3] || '{}'));
        } catch (e) {
          details = { raw: String(row[3] || '') };
        }
        
        // Parse timestamp from activity log
        let timestamp;
        let dateString;
        try {
          // Use display value directly from sheet to get exact string shown in sheet
          if (displayRow[0] && String(displayRow[0]).trim()) {
            dateString = String(displayRow[0]).trim();
          } else if (row[0] instanceof Date) {
            // Fallback: format using Athens timezone
            dateString = Utilities.formatDate(row[0], _getTz_(), 'dd/MM/yyyy HH:mm:ss');
            timestamp = row[0].getTime();
          } else if (row[0]) {
            // Try parsing date string (format: dd/MM/yyyy HH:mm:ss)
            const dateStr = String(row[0]);
            dateString = dateStr.trim(); // Use original string
            const parts = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
            if (parts) {
              const year = parseInt(parts[3]);
              const month = parseInt(parts[2]) - 1;
              const day = parseInt(parts[1]);
              const hour = parseInt(parts[4]);
              const minute = parseInt(parts[5]);
              const second = parseInt(parts[6]);
              try {
                const dateStrISO = year + '-' + 
                  String(month + 1).padStart(2, '0') + '-' + 
                  String(day).padStart(2, '0') + ' ' +
                  String(hour).padStart(2, '0') + ':' +
                  String(minute).padStart(2, '0') + ':' +
                  String(second).padStart(2, '0');
                timestamp = Utilities.parseDate(dateStrISO, _getTz_(), 'yyyy-MM-dd HH:mm:ss').getTime();
              } catch (e) {
                timestamp = new Date(year, month, day, hour, minute, second).getTime();
              }
            } else {
              timestamp = new Date(dateStr).getTime();
            }
            if (isNaN(timestamp)) timestamp = Date.now();
          } else {
            dateString = Utilities.formatDate(new Date(), _getTz_(), 'dd/MM/yyyy HH:mm:ss');
            timestamp = Date.now();
          }
        } catch (e) {
          dateString = Utilities.formatDate(new Date(), _getTz_(), 'dd/MM/yyyy HH:mm:ss');
          timestamp = Date.now();
        }
        
        const activity = {
          timestamp: timestamp,
          timestampString: dateString, // Include formatted date string
          action: String(row[2] || ''),
          details: details,
          session: String(row[4] || ''),
          duration: row[5] ? Number(row[5]) : null
        };
        
        // Convert timestamp to milliseconds if it's a Date object (shouldn't happen now)
        if (activity.timestamp instanceof Date) {
          activity.timestamp = activity.timestamp.getTime();
        } else if (typeof activity.timestamp !== 'number') {
          activity.timestamp = Date.now();
        }
        
        userActivities.push(activity);
        
        // Track tab/feature usage
        if (activity.action === 'tab_view' && details.feature) {
          tabUsage[details.feature] = (tabUsage[details.feature] || 0) + 1;
        }
      }
    }
    
    // Get all sessions for this user
    if (presenceSh && presenceSh.getLastRow() > 1) {
      const sessRows = presenceSh.getDataRange().getValues();
      for (let i = 1; i < sessRows.length; i++) {
        const row = sessRows[i];
        if (String(row[2] || '').trim() !== userName) continue;
        
        let timestamp;
        try {
          if (row[0] instanceof Date) {
            timestamp = row[0].getTime();
          } else if (typeof row[0] === 'string' && row[0]) {
            // Try parsing date string (format: dd/MM/yyyy HH:mm:ss)
            const dateStr = String(row[0]);
            const parts = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
            if (parts) {
              const year = parseInt(parts[3]);
              const month = parseInt(parts[2]) - 1;
              const day = parseInt(parts[1]);
              const hour = parseInt(parts[4]);
              const minute = parseInt(parts[5]);
              const second = parseInt(parts[6]);
              try {
                const dateStrISO = year + '-' + 
                  String(month + 1).padStart(2, '0') + '-' + 
                  String(day).padStart(2, '0') + ' ' +
                  String(hour).padStart(2, '0') + ':' +
                  String(minute).padStart(2, '0') + ':' +
                  String(second).padStart(2, '0');
                timestamp = Utilities.parseDate(dateStrISO, _getTz_(), 'yyyy-MM-dd HH:mm:ss').getTime();
              } catch (e) {
                timestamp = new Date(year, month, day, hour, minute, second).getTime();
              }
            } else {
              timestamp = new Date(dateStr).getTime();
            }
            if (isNaN(timestamp)) timestamp = Date.now();
          } else {
            timestamp = Date.now();
          }
        } catch (e) {
          timestamp = Date.now();
        }
        
        // Convert to timestamp if Date object
        let timestampMs;
        if (timestamp instanceof Date) {
          timestampMs = timestamp.getTime();
        } else if (typeof timestamp === 'number') {
          timestampMs = timestamp;
        } else {
          timestampMs = Date.now();
        }
        
        userSessions.push({
          timestamp: timestampMs,
          userId: String(row[1] || ''),
          event: String(row[3] || '')
        });
      }
    }
    
    // Get all ratings for this user
    if (logSh && logSh.getLastRow() > 1) {
      const logRows = logSh.getDataRange().getValues();
      const headers = logRows[0].map(h => String(h||'').trim().toLowerCase());
      const coachIdx = headers.findIndex(h => /coach/i.test(h));
      const playerIdx = headers.findIndex(h => /player/i.test(h));
      const dateIdx = headers.findIndex(h => /date/i.test(h));
      const notesIdx = headers.findIndex(h => /notes/i.test(h));
      const sessionIdx = headers.findIndex(h => /session/i.test(h));
      
      for (let i = 1; i < logRows.length; i++) {
        const row = logRows[i];
        const coach = coachIdx >= 0 ? String(row[coachIdx] || '').trim() : '';
        if (coach !== userName) continue;
        
        const player = playerIdx >= 0 ? String(row[playerIdx] || '').trim() : '';
        let date;
        if (dateIdx >= 0) {
          if (row[dateIdx] instanceof Date) {
            date = row[dateIdx].getTime();
          } else if (row[dateIdx]) {
            try {
              date = new Date(row[dateIdx]).getTime();
              if (isNaN(date)) date = Date.now();
            } catch (e) {
              date = Date.now();
            }
          } else {
            date = Date.now();
          }
        } else {
          date = Date.now();
        }
        const note = notesIdx >= 0 ? String(row[notesIdx] || '').trim() : '';
        const session = sessionIdx >= 0 ? String(row[sessionIdx] || '').trim() : '';
        
        userRatings.push({
          date: date,
          player: player,
          note: note,
          session: session
        });
        
        if (player) {
          userPlayers[player] = (userPlayers[player] || 0) + 1;
        }
      }
    }
    
    // Sort by date (most recent first)
    userActivities.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    userSessions.sort((a, b) => {
      const tsA = typeof a.timestamp === 'number' ? a.timestamp : (a.timestamp instanceof Date ? a.timestamp.getTime() : 0);
      const tsB = typeof b.timestamp === 'number' ? b.timestamp : (b.timestamp instanceof Date ? b.timestamp.getTime() : 0);
      return tsB - tsA;
    });
    userRatings.sort((a, b) => (b.date || 0) - (a.date || 0));
    
    // Calculate stats
    // Total time from activity durations
    let totalTime = 0;
    userActivities.forEach(a => {
      if (a.duration && typeof a.duration === 'number' && a.duration > 0) {
        totalTime += a.duration;
      }
    });
    
    // Also calculate from sessions if available
    let sessionTime = 0;
    const loginSessions = [];
    userSessions.forEach(s => {
      if (s.event === 'login') {
        loginSessions.push({ start: s.timestamp, end: null });
      } else if (s.event === 'logout' && loginSessions.length > 0) {
        const lastLogin = loginSessions[loginSessions.length - 1];
        if (lastLogin && !lastLogin.end) {
          lastLogin.end = s.timestamp;
          const duration = (s.timestamp - lastLogin.start) / 1000 / 60; // minutes
          sessionTime += duration;
        }
      }
    });
    
    // Use the larger of the two (activity durations or session durations)
    totalTime = Math.max(totalTime, sessionTime);
    
    const logins = userSessions.filter(s => s.event === 'login').length;
    const ratings = userRatings.length;
    const notes = userRatings.filter(r => r.note && String(r.note).trim()).length;
    const uniquePlayers = Object.keys(userPlayers).length;
    const topPlayers = Object.entries(userPlayers)
      .map(([player, count]) => ({ player, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    return {
      ok: true,
      userName: userName,
      activities: userActivities.slice(0, 100).map(a => ({
        timestamp: typeof a.timestamp === 'number' ? a.timestamp : (a.timestamp instanceof Date ? a.timestamp.getTime() : Date.now()),
        timestampString: a.timestampString || '', // Include original date string for display
        action: a.action,
        details: a.details,
        session: a.session,
        duration: a.duration
      })),
      sessions: userSessions.slice(0, 100).map(s => ({
        timestamp: typeof s.timestamp === 'number' ? s.timestamp : (s.timestamp instanceof Date ? s.timestamp.getTime() : Date.now()),
        timestampString: s.timestampString || '', // Include original date string for display
        userId: s.userId,
        event: s.event
      })),
      ratings: userRatings.slice(0, 100),
      tabUsage: tabUsage,
      stats: {
        totalTimeMinutes: totalTime,
        logins: logins,
        ratings: ratings,
        notes: notes,
        uniquePlayers: uniquePlayers,
        topPlayers: topPlayers.map(p => ({ player: p.player, count: p.count }))
      }
    };
    Logger.log('getUserDetailStats returning: activities=' + result.activities.length + ', sessions=' + result.sessions.length + ', ratings=' + result.ratings.length);
    return result;
  } catch (e) {
    Logger.log('ERROR in getUserDetailStats: ' + String(e));
    console.error('getUserDetailStats error:', e);
    return { ok: false, error: String(e) };
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
    const safePayload = payload || {};
    const from = String(safePayload.from || '').trim();
    const to   = String(safePayload.to || '').trim() || 'All';
    const msg  = String(safePayload.message || '').trim();
    const attachments = Array.isArray(safePayload.attachments)
      ? safePayload.attachments.filter(Boolean).map(u => String(u).trim())
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
    const safeArgs   = args || {};
    const forName    = String(safeArgs.forName || '').trim();
    const sinceEpoch = Number(safeArgs.sinceEpoch || 0);
    const limit      = Math.max(10, Math.min(300, Number(safeArgs.limit || 120)));

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

function _threePmHeader(row) {
  if (!row) return null;
  const keys = Object.keys(row);
  let fallback = null;
  for (let i=0;i<keys.length;i++) {
    const key = keys[i];
    if (!key) continue;
    const raw = String(key).trim();
    if (!raw) continue;
    const upper = raw.toUpperCase();
    const compact = upper.replace(/[^A-Z0-9]/g, '');
    if (compact === '3PMD') return key;
    if (compact === '3PM' || compact === '3PMG' || compact === '3PMGAME') return key;
    if (upper.includes('3PM') || upper.includes('3P MADE') || upper.includes('3PT MADE')) return key;
    if (compact.includes('3PMADE') || compact.includes('3PTMADE') || compact.includes('3POINTMADE')) return key;
    if (!fallback && (compact === '1500' || compact === '150000')) {
      fallback = key;
    }
  }
  return fallback;
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

function _ensureThreePmAlias(rows, aliasKey = '3PMD', opts) {
  const alias = String(aliasKey || '').trim();
  if (!alias || !Array.isArray(rows)) return;

  const aliasCompact = alias.toUpperCase().replace(/[^A-Z0-9]/g, '');
  let needsSheetFallback = false;

  rows.forEach(row => {
    if (!row || typeof row !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(row, alias)) return;

    const keys = Object.keys(row);
    let fallbackKey = null;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!key) continue;
      const raw = String(key).trim();
      if (!raw) continue;
      const upper = raw.toUpperCase();
      const compact = upper.replace(/[^A-Z0-9]/g, '');
      if (compact === aliasCompact ||
          compact === '3PM' || compact === '3PMG' || compact === '3PMGAME' ||
          upper.includes('3PM') || upper.includes('3P MADE') || upper.includes('3PT MADE') ||
          compact.includes('3PMADE') || compact.includes('3PTMADE') || compact.includes('3POINTMADE')) {
        fallbackKey = key;
        break;
      }
      if (!fallbackKey && (compact === '1500' || compact === '150000')) {
        fallbackKey = key;
      }
    }

    if (fallbackKey) {
      row[alias] = row[fallbackKey];
    } else {
      needsSheetFallback = true;
    }
  });

  if (needsSheetFallback && opts && opts.sheet && rows.length) {
    const sheet = opts.sheet;
    const column = Number.isFinite(opts.column) ? opts.column : 10; // column J by default
    const headerRow = Number.isFinite(opts.headerRow) ? opts.headerRow : 39;
    const dataStartRow = Number.isFinite(opts.dataStartRow) ? opts.dataStartRow : 41;
    try {
      const headerVal = String(sheet.getRange(headerRow, column).getDisplayValue() || '').trim();
      const headerCompact = headerVal.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (headerCompact === aliasCompact) {
        const maxRows = Math.max(0, sheet.getLastRow() - dataStartRow + 1);
        const height = Math.min(rows.length, maxRows);
        if (height > 0) {
          const values = sheet.getRange(dataStartRow, column, height, 1).getValues();
          for (let i = 0; i < height; i++) {
            const row = rows[i];
            if (!row || typeof row !== 'object') continue;
            if (Object.prototype.hasOwnProperty.call(row, alias)) continue;
            const cell = values[i] ? values[i][0] : null;
            if (cell === '' || cell == null) continue;
            row[alias] = cell;
          }
        }
      }
    } catch (err) {
      console.error('ensureThreePmAlias fallback failed:', err);
    }
  }
}

function _injectThreePmFromHeaderRow_(sheet, rows, opts) {
  if (!sheet || !Array.isArray(rows) || !rows.length) return;
  const options = opts || {};
  const alias = String(options.alias || '3PMD').trim();
  if (!alias) return;

  const aliasCompact = alias.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const headerRow = Number.isFinite(options.headerRow) ? options.headerRow : 39;
  const dataStartRow = Number.isFinite(options.dataStartRow) ? options.dataStartRow : 41;
  const startColumn = Number.isFinite(options.startColumn) ? options.startColumn : 1;
  const width = Number.isFinite(options.width) ? options.width : 23; // A:W default

  try {
    const headerVals = sheet.getRange(headerRow, startColumn, 1, width).getDisplayValues()[0] || [];
    let colOffset = -1;
    for (let i = 0; i < headerVals.length; i++) {
      const label = String(headerVals[i] || '').trim();
      if (!label) continue;
      const compact = label.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (compact === aliasCompact) {
        colOffset = i;
        break;
      }
    }
    if (colOffset < 0) return;

    const column = startColumn + colOffset;
    const maxRows = Math.max(0, sheet.getLastRow() - dataStartRow + 1);
    const height = Math.min(rows.length, maxRows);
    if (height <= 0) return;

    const values = sheet.getRange(dataStartRow, column, height, 1).getValues();
    for (let i = 0; i < height; i++) {
      const row = rows[i];
      if (!row || typeof row !== 'object') continue;
      const cell = values[i] ? values[i][0] : null;
      if (cell === '' || cell == null) continue;
      row[alias] = cell;
    }
  } catch (err) {
    console.error('injectThreePmFromHeaderRow failed:', err);
  }
}

function _parseTeamPerGameRow_(row) {
  if (!row) return null;
  const num = (key) => _num(row[key]);
  const threeMadeHeader = _threePmHeader(row);
  return {
    gp:     num('GP'),
    mpg:    num('MPG'),
    ppg:    num('PPG'),
    fgm:    num('FGM'),
    fga:    num('FGA'),
    fgPct:  num('FG%'),
    threePm: threeMadeHeader ? _num(row[threeMadeHeader]) : null,
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
    const threeHeader = _threePmHeader(r);
    const PM3    = threeHeader ? _nz(r[threeHeader]) : 0;
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
                                                                              'Efficient scorer', 90, 'off', ts != null ? ts : 0);

  // Creation
  add(has(ast40) && ast40 >= 6 && has(tov40) && tov40 > 0 && (ast40/tov40) >= 2 && has(ortg) && ortg > 110,
                                                                              'Primary creator',  88, 'off', ast40);

  // Shooting gravity
  add(has(threePar) && threePar >= 0.45 &&
      ((has(pa3) && pa3 >= 4) || (has(val('per40_3pa')) && val('per40_3pa') >= 7)) &&
      has(p3pct) && p3pct >= 0.37,                                             'Floor spacer',     86, 'off', p3pct != null ? p3pct : 0);

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

/** Team row and league means from A20:S33 (league table) */
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
    const lg    = _readBlock_(sh, 'A20:S33');   // league table (12 teams)
    const pg    = _readBlock_(sh, 'A40:W52');   // per-game (player)
    const lgPer = _readBlock_(sh, 'W20:AR33');  // league per-game (team)

    _injectThreePmFromHeaderRow_(sh, pg.rows, { alias: '3PMD', headerRow: 39, dataStartRow: 41, startColumn: 1, width: 23 });
    _ensureThreePmAlias(pg.rows, '3PMD', { sheet: sh, column: 10, headerRow: 39, dataStartRow: 41 });
    _ensureThreePmAlias(lgPer.rows, '3PMD');

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
          drbPct:_num(r['DRB%']),
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

  _injectThreePmFromHeaderRow_(sh, pg, { alias: '3PMD', headerRow: 39, dataStartRow: 41, startColumn: 1, width: 23 });
  _ensureThreePmAlias(pg, '3PMD', { sheet: sh, column: 10, headerRow: 39, dataStartRow: 41 });

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

/** Pull team row & league pace from A20:S33 (you already do similar elsewhere) */
function _getTeamLeagueRow_(){
  var sh = _openStats_();
  var lg = _readBlock_(sh, 'A20:S33').rows;
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

/** Read schedule block: stats!A66:I97 → array of games */
function getSchedule() {
  try {
    const sh = _openStats_();
    const startRow = 66, startCol = 1, numCols = 9; // A..I
    const lastRow = sh.getLastRow();
    const height = Math.max(0, Math.min(97, lastRow) - startRow + 1);
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

    // Log activity for admin portal
    try {
      _logUserActivity(coach, 'rating', {
        rowsSaved: toWrite.length,
        session: session,
        date: dateISO,
        notesCount: alertNotes.length
      });
    } catch (err) {
      console.error('Activity logging failed:', err);
    }

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
        tmi        : (function(){
          const first  = asNum(r[H['tmi (Δ vs prev 3)']]);
          const second = asNum(r[H['tmi (δ vs prev 3)']]);
          const third  = asNum(r[H['tmi']]);
          if (first != null) return first;
          if (second != null) return second;
          return third;
        })(),
        gri        : (function(){
          const primary = asNum(r[H['gri (games only)']]);
          if (primary != null) return primary;
          return asNum(r[H['gri']]);
        })(),
      });
    }

    return { ok:true, rows };
  } catch (err) {
    return { ok:false, error: String(err) };
  }
}

/**
 * Calculate practice-to-game correlation metrics
 * Compares last 3 practice session ratings with game shooting efficiency
 * Returns data for both individual players and team-wide averages
 */
function getPracticeToGameCorrelation() {
  try {
    console.log('Starting getPracticeToGameCorrelation...');
    
    const ss = _open();
    const logSheet = ss.getSheetByName('Log');
    if (!logSheet) {
      console.error('Log sheet not found');
      return { ok: false, error: 'Log sheet not found' };
    }

    // Read shot map data
    let shotMap = null;
    try {
      shotMap = shotMapGetShots();
    } catch (err) {
      return { ok: false, error: 'Shot map data unavailable: ' + String(err) };
    }
    
    if (!shotMap || !shotMap.shots || !Array.isArray(shotMap.shots) || shotMap.shots.length === 0) {
      return { ok: false, error: 'No shot data available' };
    }
    
    // Debug: log shot data info
    console.log('Shot map loaded:', shotMap.shots.length, 'shots');

    // Get full ratings grid from Dashboard1
    console.log('Getting ratings grid...');
    const ratingsGrid = apiGetRatingsGrid();
    console.log('Ratings grid:', ratingsGrid);
    if (!ratingsGrid || !ratingsGrid.ok) {
      return { ok: false, error: 'Ratings data unavailable: ' + (ratingsGrid ? ratingsGrid.error : 'no response') };
    }

    const headers = ratingsGrid.headers || [];
    const rows = ratingsGrid.rows || [];
    
    console.log('Headers:', headers.length, 'Rows:', rows.length);
    
    // Extract player names (skip empty col 0 and 'Date' col 1)
    // Headers: ['', 'Date', 'Abercrombie', 'Asimenios', ...]
    // We want: ['Abercrombie', 'Asimenios', ...]
    const players = headers.slice(2).filter(h => h && h.trim());
    
    console.log('Players extracted:', players.slice(0, 5).join(', '));
    console.log('Sample row structure (first 5 cells):', rows[0] ? rows[0].slice(0, 5).map(String).join(' | ') : 'no rows');
    
    if (!players.length || !rows.length) {
      return { ok: false, error: 'No data available - headers:' + headers.length + ' rows:' + rows.length };
    }
    
    // Get team rating series for filtering practice sessions
    console.log('Getting team rating series...');
    let teamRatings;
    try {
      teamRatings = getTeamRatingSeries();
      console.log('Team ratings result:', teamRatings ? 'got response' : 'null response');
    } catch (err) {
      console.error('Error getting team ratings:', err);
      return { ok: false, error: 'Error calling getTeamRatingSeries: ' + String(err) };
    }
    
    console.log('Team ratings:', teamRatings);
    if (!teamRatings || !teamRatings.ok) {
      return { ok: false, error: 'Team ratings data unavailable: ' + (teamRatings ? (teamRatings.reason || 'unknown reason') : 'no response') };
    }

    const labels = teamRatings.labels || [];
    const values = teamRatings.values || [];
    const sessions = teamRatings.sessions || [];
    
    console.log('Labels:', labels.length, 'Values:', values.length, 'Sessions:', sessions.length);

    // Helper function to normalize dates
    function normalizeDateString(dateStr) {
      if (!dateStr || !String(dateStr).trim()) return null;
      
      const str = String(dateStr).trim();
      
      // Try DD-MMM format first (e.g., "17-Sep")
      const ddmmyMatch = str.match(/^(\d{1,2})-([A-Za-z]{3})(?:-(\d{4}))?$/);
      if (ddmmyMatch) {
        const day = ddmmyMatch[1].padStart(2, '0');
        const monthName = ddmmyMatch[2];
        const year = ddmmyMatch[3] || '2025';
        
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthIndex = months.findIndex(m => m.toLowerCase() === monthName.toLowerCase());
        
        if (monthIndex >= 0) {
          const month = String(monthIndex + 1).padStart(2, '0');
          const result = `${year}-${month}-${day}`;
          return result;
        }
      }
      
      // Try parsing with Date object for other formats
      try {
        const d = new Date(str);
        if (!isNaN(d.getTime())) {
          const result = d.toISOString().split('T')[0];
          // If year is before 2024, it's likely a misparse, so reject it
          const resultYear = parseInt(result.split('-')[0]);
          if (resultYear >= 2024) {
            return result;
          }
        }
      } catch (e) {}
      
      return str;
    }

    // Build practice sessions map with full player data
    const practiceSessionsByDate = new Map();
    
    // Create a map of session types by date
    const sessionTypesByDate = new Map();
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      const session = sessions[i];
      const normalizedDate = normalizeDateString(label);
      if (normalizedDate) {
        sessionTypesByDate.set(normalizedDate, session);
      }
    }
    
    // Process each row and extract practice sessions
    const dateToRow = new Map();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      
      // Try column 1 first (index 1), fall back to column 0
      let dateStr = String(row[1] || '').trim();
      if (!dateStr) {
        dateStr = String(row[0] || '').trim();
      }
      
      if (!dateStr) continue;
      
      // Parse date from formats like "12-Sep ( Team Practice )"
      const dateMatch = dateStr.match(/^([\w\s-]+)\(/);
      if (dateMatch) {
        dateStr = dateMatch[1].trim();
      }
      
      const normalizedDate = normalizeDateString(dateStr);
      
      if (normalizedDate && !dateToRow.has(normalizedDate)) {
        dateToRow.set(normalizedDate, row);
      }
    }
    
    // Filter for practice sessions only (exclude games)
    const practiceDates = new Map();
    dateToRow.forEach((row, date) => {
      const sessionType = sessionTypesByDate.get(date);
      // Include "practice" sessions, exclude games ("GBL", "EC", "Friendly")
      if (sessionType && 
          (sessionType.toLowerCase().includes('practice')) &&
          !sessionType.toLowerCase().match(/gbl|ec|friendly|game/)) {
        practiceDates.set(date, row);
      }
    });
    
    console.log('Found', practiceDates.size, 'practice sessions out of', dateToRow.size, 'total sessions');
    
    if (practiceDates.size === 0) {
      return { ok: false, error: 'No practice sessions found in Dashboard1. Please add practice session ratings to Dashboard1.' };
    }

    // Build shot efficiency by game date
    // First, create a map of gameId -> game info from metadata
    const gameMetadata = new Map();
    if (shotMap.games && Array.isArray(shotMap.games)) {
      shotMap.games.forEach(game => {
        gameMetadata.set(game.id, game);
      });
    }
    
    // Debug: show game metadata with actual dates
    console.log('Game metadata from shotMap:');
    shotMap.games.forEach(game => {
      const parts = game.label.split('•');
      const datePart = parts[0].trim();
      console.log(`  Game ${game.id}: date="${datePart}", label="${game.label}"`);
    });
    
    const shotsByGame = new Map();
    shotMap.shots.forEach(shot => {
      // Only count Peristeri shots (teamSide 1)
      if (shot.teamSide !== 1) return;
      const gameId = shot.gameId;
      const player = shot.player;
      
      // Get date from game metadata (more reliable than shot.date)
      let date = null;
      const gameInfo = gameMetadata.get(gameId);
      if (gameInfo && gameInfo.label) {
        // Label format: "2025-10-25 • PAOK (GBL)"
        const parts = gameInfo.label.split('•');
        if (parts.length > 0) {
          const dateStr = parts[0].trim();
          // If it's already in YYYY-MM-DD format, use it directly
          if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
            date = dateStr;
          } else {
            // Otherwise parse it
            const d = new Date(dateStr);
            if (!isNaN(d.getTime())) {
              date = d.toISOString().split('T')[0]; // YYYY-MM-DD
            }
          }
          
          // Fix timezone offset: add 1 day to compensate for UTC conversion
          if (date) {
            const d = new Date(date + 'T12:00:00'); // Use noon to avoid DST issues
            d.setDate(d.getDate() + 1);
            date = d.toISOString().split('T')[0];
          }
        }
      }
      
      // Fallback to shot.date if no game metadata
      if (!date) {
        try {
          const d = new Date(shot.date);
          if (!isNaN(d.getTime())) {
            date = d.toISOString().split('T')[0]; // YYYY-MM-DD
          }
        } catch (e) {
          // Keep original date string
          date = shot.date;
        }
      }
      
      if (!shotsByGame.has(gameId)) {
        shotsByGame.set(gameId, {
          date,
          competition: shot.competition || '',
          opponent: shot.opponent || '',
          shotsByPlayer: new Map()
        });
      }
      
      const gameData = shotsByGame.get(gameId);
      if (!gameData.shotsByPlayer.has(player)) {
        gameData.shotsByPlayer.set(player, { attempts: 0, makes: 0 });
      }
      
      const playerShots = gameData.shotsByPlayer.get(player);
      playerShots.attempts++;
      if (shot.made) playerShots.makes++;
    });

    // For each game, find practice sessions before it and calculate correlations
    const results = [];
    
    // Debug: show game dates
    console.log('Games from shot data:');
    Array.from(shotsByGame.entries()).forEach(([gameId, gameData]) => {
      console.log(`  Game ${gameId}: date="${gameData.date}", opp="${gameData.opponent}", comp="${gameData.competition}"`);
    });
    
    Array.from(shotsByGame.entries()).forEach(([gameId, gameData]) => {
      const gameDate = gameData.date;
      let gameDateObj = null;
      
      // Try to parse game date
      if (gameDate) {
        gameDateObj = new Date(gameDate);
        if (isNaN(gameDateObj.getTime())) {
          return; // Invalid date, skip this game
        }
      } else {
        return; // No date info, skip this game
      }
      
      console.log(`\nSelecting practices for game on ${gameDate}:`);
      
      // Find the last 3 practice sessions before this game
      const selectedPracticeDates = Array.from(practiceDates.keys())
        .map(date => ({ date, obj: new Date(date), row: practiceDates.get(date) }))
        .filter(d => !isNaN(d.obj.getTime()) && d.obj < gameDateObj)
        .sort((a, b) => b.obj - a.obj) // Most recent first
        .slice(0, 3); // Keep last 3
      
      console.log(`  Selected ${selectedPracticeDates.length} practices: ${selectedPracticeDates.map(d => d.date).join(', ')}`);

      if (selectedPracticeDates.length === 0) {
        return;
      }
      
      // Extract player ratings from the 3 practice sessions
      const playerRatings = new Map();
      
      // Headers: [0:'', 1:'Date', 2:'Abercrombie', 3:'Asimenios', ...]
      // Row:     [0:'', 1:'12-Sep', 2:rating, 3:rating, ...]
      // players array now starts at headers index 2 (slice(2))
      // So players[0] maps to headers[2] which maps to row[2]
      
      for (let pidx = 0; pidx < players.length; pidx++) {
        const playerName = players[pidx];
        const ratings = [];
        
        for (const { row } of selectedPracticeDates) {
          // Now players array starts at headers[2], so ratings start at row[2]
          // players[0] (first real player) -> row[2]
          // players[1] (second player) -> row[3]
          const colIndex = pidx + 2;
          if (colIndex < row.length && colIndex < headers.length) {
            const ratingStr = String(row[colIndex] || '').trim();
            const rating = parseFloat(ratingStr);
            if (!isNaN(rating) && rating > 0) {
              ratings.push(rating);
            }
          }
        }
        
        if (ratings.length > 0) {
          const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
          playerRatings.set(playerName, avg);
          if (pidx < 3) {
            console.log(`${playerName}: extracted ${ratings.length} ratings, avg=${avg.toFixed(2)}`);
          }
        }
      }
      
      // Calculate team average from practice sessions
      const practiceAvgRating = Array.from(playerRatings.values()).reduce((a, b) => a + b, 0) / playerRatings.size || 0;
      
      // Get the actual team rating from the game day
      // Normalize game date to match the format we use for labels
      let normalizedGameDate = gameDate;
      try {
        const d = new Date(gameDate);
        if (!isNaN(d.getTime())) {
          normalizedGameDate = d.toISOString().split('T')[0]; // YYYY-MM-DD
        }
      } catch (e) {
        // Keep original if parsing fails
      }
      
      let gameDayTeamRating = 0;
      console.log(`\nLooking for game day rating: gameDate="${gameDate}" -> normalized="${normalizedGameDate}"`);
      for (let i = 0; i < labels.length; i++) {
        const normalizedLabel = normalizeDateString(labels[i]);
        if (normalizedLabel === normalizedGameDate && i < values.length) {
          gameDayTeamRating = values[i];
          console.log(`  ✓ Found: label "${labels[i]}" (normalized: "${normalizedLabel}") -> rating ${gameDayTeamRating}`);
          break;
        }
      }
      if (gameDayTeamRating === 0) {
        console.log(`  ✗ No rating found for game on ${gameDate}`);
      }

      // Calculate shooting efficiency for this game
      const gameShots = Array.from(gameData.shotsByPlayer.entries()).map(([player, stats]) => ({
        player,
        fgPct: stats.attempts > 0 ? (stats.makes / stats.attempts) * 100 : 0,
        attempts: stats.attempts,
        makes: stats.makes
      }));
      
      // Debug: log player data for inspection
      console.log(`\nFor game ${gameId}:`);
      console.log(`Sample practice ratings (first 5):`, Array.from(playerRatings.entries()).slice(0, 5).map(([name, rating]) => `${name}: ${rating.toFixed(2)}`).join(', '));
      console.log(`Sample game FG% (first 5):`, gameShots.slice(0, 5).map(s => `${s.player}: ${s.fgPct.toFixed(1)}%`).join(', '));

      // Calculate team FG% for this game
      let teamShots = 0;
      let teamMakes = 0;
      gameShots.forEach(s => {
        teamShots += s.attempts;
        teamMakes += s.makes;
      });
      const teamFG = teamShots > 0 ? (teamMakes / teamShots) * 100 : 0;

      // Helper function to normalize player names for matching
      function normalizePlayerName(name) {
        if (!name) return '';
        let n = String(name).trim();
        
        // Remove periods, commas, and normalize spaces
        n = n.replace(/[,\.]/g, ' ').replace(/\s+/g, ' ').trim();
        
        // Handle formats like:
        // "R. ABERCROMBIE" -> "ABERCROMBIE" (last word > 1 char)
        // "J. VAN TUBBERGEN" -> "VANTUBBERGEN" (last 2 words)
        // "VanTubbergen" -> "VANTUBBERGEN" (split at case)
        // "Abercrombie" -> "ABERCROMBIE" (single word)
        
        // First try: Find all capital-letter words (skip single-letter words like "R", "A", "J")
        const words = n.split(' ');
        const capsWords = words.filter(w => /^[A-Z]+$/.test(w) && w.length > 1);
        
        if (capsWords.length > 0) {
          // Take the last 1 or 2 words
          const toTake = capsWords.length > 1 ? capsWords.slice(-2) : capsWords;
          return toTake.join('').toUpperCase();
        }
        
        // Second try: Handle camelCase like "VanTubbergen"
        const camelMatch = n.match(/[a-z][A-Z]/);
        if (camelMatch) {
          // Split at case changes and join uppercase parts
          const parts = n.split(/(?=[A-Z])/);
          return parts.join('').toUpperCase().replace(/[^A-Z]/g, '');
        }
        
        // Fallback: just uppercase and remove non-letters
        return n.toUpperCase().replace(/[^A-Z]/g, '');
      }
      
      // Create a reverse lookup map: normalized name -> original name from ratings
      const ratingsNameMap = new Map();
      playerRatings.forEach((rating, origName) => {
        const normalized = normalizePlayerName(origName);
        ratingsNameMap.set(normalized, origName);
      });
      
      // Format date string
      let formattedDate = '';
      if (gameDate) {
        const dateObj = new Date(gameDate);
        if (!isNaN(dateObj.getTime())) {
          formattedDate = dateObj.toISOString().split('T')[0];
        } else {
          formattedDate = String(gameDate).split('T')[0].split(' ')[0];
        }
      }

      results.push({
        gameId,
        gameDate: formattedDate || String(gameDate || ''),
        competition: gameData.competition || '',
        opponent: gameData.opponent || '',
        practiceSessions: selectedPracticeDates.length,
        practiceAvgRating: Number(practiceAvgRating.toFixed(2)),
        gameDayRating: Number(gameDayTeamRating.toFixed(2)),
        teamFG: Number(teamFG.toFixed(1)),
        players: gameShots.map(s => {
          // Try to match player name from shot data with ratings data
          const normalizedShotName = normalizePlayerName(s.player);
          const matchedRatingName = ratingsNameMap.get(normalizedShotName);
          const practiceAvg = matchedRatingName ? (playerRatings.get(matchedRatingName) || 0) : 0;
          
          return {
            player: s.player,
            practiceAvg: Number(practiceAvg.toFixed(2)),
            gameFG: s.fgPct,
            attempts: s.attempts,
            makes: s.makes
          };
        })
      });
    });

    // Sort by date (most recent first)
    results.sort((a, b) => new Date(b.gameDate) - new Date(a.gameDate));

    // Calculate player-level correlations
    const playerCorrelations = new Map();
    results.forEach(game => {
      game.players.forEach(p => {
        if (p.practiceAvg > 0) {
          if (!playerCorrelations.has(p.player)) {
            playerCorrelations.set(p.player, { ratings: [], fgs: [] });
          }
          const data = playerCorrelations.get(p.player);
          data.ratings.push(p.practiceAvg);
          data.fgs.push(p.gameFG);
        }
      });
    });
    
    const playerCorrData = [];
    playerCorrelations.forEach((data, player) => {
      if (data.ratings.length >= 2) {
        const corr = calculateCorrelation(data.ratings, data.fgs);
        if (corr !== null && !isNaN(corr)) {
          playerCorrData.push({ p: player, c: corr, g: data.ratings.length });
        }
      }
    });
    
    playerCorrData.sort((a, b) => b.c - a.c);
    
    const teamCorr = results.length > 1 ? calculateCorrelation(
      results.map(r => r.practiceAvgRating),
      results.map(r => r.teamFG)
    ) : null;
    
    // Debug: log the correlation data
    console.log(`\nTeam correlation using ${results.length} games:`);
    results.forEach((r, idx) => {
      console.log(`  Game ${idx + 1} on ${r.gameDate}: Practice avg=${r.practiceAvgRating.toFixed(2)}, Team FG%=${r.teamFG.toFixed(1)}`);
    });
    console.log(`  Correlation: ${teamCorr?.toFixed(3) || 'N/A'}`);
    console.log(`\nTotal games processed: ${results.length}`);
    
    // Limit data size to prevent issues - use only essential fields
    const limitedResults = results.slice(0, 3).map(r => {
      const simplePlayers = r.players.map(p => ({
        n: p.player,
        pr: p.practiceAvg,
        fg: p.gameFG,
        a: p.attempts,
        m: p.makes
      }));
      return {
        g: r.gameId,
        d: r.gameDate,
        c: r.competition || '',
        o: r.opponent || '',
        ps: r.practiceSessions,
        par: r.practiceAvgRating,
        gdr: r.gameDayRating,
        tf: r.teamFG,
        p: simplePlayers
      };
    });
    
    const limitedResponse = {
      ok: true,
      data: limitedResults,
      s: {  // 's' for summary
        tg: results.length,  // totalGames
        tc: teamCorr,        // teamCorrelation
        pc: playerCorrData.slice(0, 10) // playerCorrelations
      }
    };
    
    // Ensure all values are serializable
    const cleanResponse = {
      ok: true,
      data: limitedResults.map(g => ({
        g: String(g.g || ''),
        d: String(g.d || ''),
        c: String(g.c || ''),
        o: String(g.o || ''),
        ps: Number(g.ps || 0),
        par: Number(g.par || 0),
        gdr: Number(g.gdr || 0),
        tf: Number(g.tf || 0),
        p: Array.isArray(g.p) ? g.p.map(p => ({
          n: String(p.n || ''),
          pr: Number(p.pr || 0),
          fg: Number(p.fg || 0),
          a: Number(p.a || 0),
          m: Number(p.m || 0)
        })) : []
      })),
      s: {
        tg: Number(results.length || 0),
        tc: teamCorr !== null && !isNaN(teamCorr) ? Number(teamCorr) : null,
        pc: Array.isArray(playerCorrData) ? playerCorrData.slice(0, 5).map(c => ({
          p: String(c.p || ''),
          c: Number(c.c || 0),
          g: Number(c.g || 0)
        })) : []
      }
    };
    
    // Log a sample game from the response to verify structure
    if (cleanResponse.data && cleanResponse.data.length > 0) {
      console.log('Sample game from response:', JSON.stringify(cleanResponse.data[0]).slice(0, 200));
    }
    
    return cleanResponse;

  } catch (err) {
    const errorMsg = String(err) + '\nStack: ' + (err.stack || 'no stack');
    console.error('getPracticeToGameCorrelation error:', errorMsg);
    return { ok: false, error: errorMsg };
  }
}

/**
 * Predict upcoming game FG% based on recent practice ratings and historical performance
 */
function predictNextGameFG() {
  try {
    const ss = _open();
    
    // Get upcoming games
    const schedule = getSchedule();
    if (!schedule || !schedule.ok || !schedule.games || schedule.games.length === 0) {
      return { ok: false, error: 'No upcoming games found' };
    }
    
    // Find the next upcoming game
    const now = new Date();
    const upcoming = schedule.games.filter(g => g.status === 'upcoming' && g.ts && g.ts > now.getTime());
    if (upcoming.length === 0) {
      return { ok: false, error: 'No upcoming games scheduled' };
    }
    
    const nextGame = upcoming[0];
    const nextGameDate = new Date(nextGame.ts);
    const nextGameDateISO = nextGameDate.toISOString().split('T')[0];
    
    // Get recent ratings (last 14 sessions - roughly 2 weeks)
    const ratingsGrid = apiGetRatingsGrid();
    if (!ratingsGrid || !ratingsGrid.ok) {
      return { ok: false, error: 'Ratings data unavailable' };
    }
    
    const rows = ratingsGrid.rows || [];
    const practiceSessions = [];
    
    // Filter for practice sessions only (last 14)
    for (let i = rows.length - 1; i >= 0 && practiceSessions.length < 14; i--) {
      const row = rows[i];
      const dateStr = String(row[1] || '').trim();
      if (!dateStr) continue;
      
      // Check if it's a practice session (not Friendly, GBL, EC)
      const sessionMatch = dateStr.match(/\s*\(([^)]+)\)/);
      if (sessionMatch) {
        const sessionType = sessionMatch[1].toLowerCase();
        if (sessionType.includes('practice') && !sessionType.match(/friendly|gbl|ec|game/)) {
          // Get team average rating for this session
          const playerRatings = [];
          for (let j = 2; j < row.length; j++) {
            const rating = parseFloat(row[j]) || 0;
            if (rating > 0) {
              playerRatings.push(rating);
            }
          }
          if (playerRatings.length > 0) {
            const avg = playerRatings.reduce((a, b) => a + b, 0) / playerRatings.length;
            practiceSessions.push(avg);
          }
        }
      }
    }
    
    if (practiceSessions.length < 3) {
      return { ok: false, error: 'Not enough practice data available' };
    }
    
    // Calculate features for prediction
    const recentPractice = practiceSessions.slice(0, 5); // Last 5 practices
    const avgRecentPractice = recentPractice.reduce((a, b) => a + b, 0) / recentPractice.length;
    
    // Get historical FG% data from shot map
    let shotMap;
    try {
      shotMap = shotMapGetShots();
    } catch (err) {
      shotMap = null;
    }
    
    let recentFG = null;
    let recentFG2 = null, recentFG3 = null;
    let lastGames = [];
    
    if (shotMap && shotMap.games && shotMap.games.length > 0) {
      // Get last 5 games FG%
      const gameMetadata = new Map();
      if (shotMap.games) {
        shotMap.games.forEach(game => {
          gameMetadata.set(game.id, game);
        });
      }
      
      const shotsByGame = new Map();
      shotMap.shots.forEach(shot => {
        // Only count Peristeri shots (teamSide 1)
        if (shot.teamSide !== 1) return;
        const gameId = shot.gameId;
        if (!shotsByGame.has(gameId)) {
          shotsByGame.set(gameId, { shots: 0, makes: 0, shots2: 0, makes2: 0, shots3: 0, makes3: 0 });
        }
        const game = shotsByGame.get(gameId);
        game.shots++;
        if (shot.made) game.makes++;
        
        // Track 2pt and 3pt separately
        if (shot.type === '3pt') {
          game.shots3++;
          if (shot.made) game.makes3++;
        } else {
          game.shots2++;
          if (shot.made) game.makes2++;
        }
      });
      
      // Get FG% for last 5 games (including 2pt and 3pt)
      shotsByGame.forEach((stats, gameId) => {
        if (stats.shots > 0) {
          let fg = (stats.makes / stats.shots) * 100;
          let fg2 = stats.shots2 > 0 ? (stats.makes2 / stats.shots2) * 100 : 0;
          let fg3 = stats.shots3 > 0 ? (stats.makes3 / stats.shots3) * 100 : 0;
          
          const gameInfo = gameMetadata.get(gameId);
          if (gameInfo && gameInfo.label) {
            const dateMatch = gameInfo.label.match(/^([\d-]+)/);
            if (dateMatch) {
              // Check if this is a FIBA Europe Cup game - read from stats sheet instead
              const competition = gameInfo.label.toLowerCase();
              const isEuropeCup = competition.includes('europe_cup') || competition.includes('europe cup') || competition.includes('fiba');
              
              if (isEuropeCup) {
                // Try to read FG%, 2P%, 3P% from Stats sheet row 66 (columns J, K, L)
                // Find opponent in the label
                const oppMatch = gameInfo.label.match(/•\s*([^•(]+)/);
                const opponent = oppMatch ? oppMatch[1].trim() : '';
                
                if (opponent) {
                  try {
                    const statsSheet = ss.getSheetByName('Stats');
                    if (statsSheet) {
                      // Search for opponent in column B (column 2) to find their row
                      const lastRow = statsSheet.getLastRow();
                      let oppRow = -1;
                      for (let r = 2; r <= Math.min(lastRow, 100); r++) { // Start from row 2 (skip header at row 1)
                        const cellValue = String(statsSheet.getRange(r, 2).getValue() || '').toLowerCase();
                        if (cellValue && (cellValue.includes(opponent.toLowerCase()) || opponent.toLowerCase().includes(cellValue))) {
                          oppRow = r;
                          break;
                        }
                      }
                      
                      if (oppRow > 0) {
                        // Read percentages from columns J, K, L from the opponent's row (not row 66 - that's the headers)
                        const fgPctValue = statsSheet.getRange(oppRow, 10).getValue(); // Column J (FG%)
                        const twoPctValue = statsSheet.getRange(oppRow, 11).getValue(); // Column K (2P%)
                        const threePctValue = statsSheet.getRange(oppRow, 12).getValue(); // Column L (3P%)
                        
                        if (fgPctValue) fg = Number(fgPctValue);
                        if (twoPctValue) fg2 = Number(twoPctValue);
                        if (threePctValue) fg3 = Number(threePctValue);
                        
                        Logger.log(`Using FIBA Europe Cup percentages from Stats sheet for ${opponent} (row ${oppRow}): FG=${fg}%, 2P=${fg2}%, 3P=${fg3}%`);
                      } else {
                        Logger.log(`Opponent "${opponent}" not found in Stats sheet column B`);
                      }
                    }
                  } catch (e) {
                    Logger.log('Error reading FIBA Europe Cup stats: ' + e);
                  }
                }
              }
              
              lastGames.push({ date: dateMatch[1], fg, fg2, fg3, isEuropeCup });
            }
          }
        }
      });
      
      // Sort by date descending and take last 5
      lastGames.sort((a, b) => b.date.localeCompare(a.date));
      if (lastGames.length >= 3) {
        const recentFGs = lastGames.slice(0, 5).map(g => g.fg);
        recentFG = recentFGs.reduce((a, b) => a + b, 0) / recentFGs.length;
        
        const recentFG2Vals = lastGames.slice(0, 5).filter(g => g.fg2 > 0).map(g => g.fg2);
        const recentFG3Vals = lastGames.slice(0, 5).filter(g => g.fg3 > 0).map(g => g.fg3);
        
        if (recentFG2Vals.length > 0) recentFG2 = recentFG2Vals.reduce((a, b) => a + b, 0) / recentFG2Vals.length;
        if (recentFG3Vals.length > 0) recentFG3 = recentFG3Vals.reduce((a, b) => a + b, 0) / recentFG3Vals.length;
        
        // Debug: log the games used
        console.log(`Recent FG% calculated from last ${lastGames.slice(0, 5).length} games:`);
        lastGames.slice(0, 5).forEach((g, idx) => {
          console.log(`  Game ${idx + 1} on ${g.date}: Total=${g.fg.toFixed(1)}%, 2pt=${g.fg2.toFixed(1)}%, 3pt=${g.fg3.toFixed(1)}%`);
        });
        console.log(`  Average: Total=${recentFG.toFixed(1)}%, 2pt=${recentFG2?.toFixed(1) || 'N/A'}%, 3pt=${recentFG3?.toFixed(1) || 'N/A'}%`);
      }
    }
    
    // Simple prediction model
    // Formula: FG% = base + (recent_practice_rating - 3.5) * coefficient + trend_adjustment
    let predictedFG = 40; // Base FG%
    let predictedFG2 = 45; // Base for 2pt
    let predictedFG3 = 30; // Base for 3pt
    
    // Adjust based on practice rating (teams with higher ratings tend to shoot better)
    const practiceImpact = (avgRecentPractice - 3.5) * 8; // ~8 FG% per 1 rating point
    predictedFG += practiceImpact;
    predictedFG2 += practiceImpact;
    predictedFG3 += practiceImpact * 0.7; // 3pt affected less
    
    // Adjust based on recent FG% trend
    if (recentFG !== null) {
      const trendAdjustment = (recentFG - 40) * 0.3; // Weight recent actual FG%
      predictedFG = predictedFG * 0.7 + (recentFG * 0.3); // Blend with recent average
    }
    
    // Apply recent trends for 2pt and 3pt
    if (recentFG2 !== null) predictedFG2 = predictedFG2 * 0.7 + (recentFG2 * 0.3);
    if (recentFG3 !== null) predictedFG3 = predictedFG3 * 0.7 + (recentFG3 * 0.3);
    
    // Consider competition type
    const comp = nextGame.competition || '';
    if (comp === 'GBL' || comp === 'EC') {
      predictedFG *= 0.95; // Slightly lower in official games
      predictedFG2 *= 0.95;
      predictedFG3 *= 0.95;
    }
    
    // Get historical game results and points
    let avgPoints = 70; // Base prediction
    let avgPointsAllowed = 75;
    let winLoss = [0, 0]; // [wins, losses]
    let predictedPoints = avgPoints;
    let predictedWin = null;
    let pointsScored = []; // Declare outside if block for variance calculation
    
    if (schedule && schedule.ok && schedule.games) {
      const finalGames = schedule.games.filter(g => g.status === 'final' && g.result);
      const recentGames = finalGames.slice(-10); // Last 10 games
      
      const pointsAllowed = [];
      
      recentGames.forEach(game => {
        // Parse result string (e.g., "W, 61 - 87" or "L, 82 - 76")
        // Format can be: W/L, <score1> - <score2>
        // If W (win), our score is the HIGHER value
        // If L (loss), our score is the LOWER value
        const resultMatch = game.result.match(/^(W|L),\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/i);
        if (resultMatch) {
          const won = resultMatch[1].toUpperCase() === 'W';
          const score1 = parseInt(resultMatch[2]);
          const score2 = parseInt(resultMatch[3]);
          
          // Determine which score is ours based on W/L
          const ourScore = won ? Math.max(score1, score2) : Math.min(score1, score2);
          const theirScore = won ? Math.min(score1, score2) : Math.max(score1, score2);
          
          pointsScored.push(ourScore);
          pointsAllowed.push(theirScore);
          
          if (won) winLoss[0]++;
          else winLoss[1]++;
        } else if (game.pppUs && game.pppThem) {
          // Fallback to PPP (points per possession) if available
          // Approximate score from PPP
          // Typical possessions: ~65-75
          const possessions = 70;
          const ourScore = Math.round(game.pppUs * possessions);
          const theirScore = Math.round(game.pppThem * possessions);
          pointsScored.push(ourScore);
          pointsAllowed.push(theirScore);
        }
      });
      
      if (pointsScored.length > 0) {
        avgPoints = pointsScored.reduce((a, b) => a + b, 0) / pointsScored.length;
        avgPointsAllowed = pointsAllowed.reduce((a, b) => a + b, 0) / pointsAllowed.length;
      }
    }
    
    // Predict points based on FG% and recent trends
    // Formula: points = base + (predictedFG% impact) + (recent practice quality)
    const pointsFromFG = (predictedFG / 40) * avgPoints; // Scale by expected shooting
    const practicePointsImpact = (avgRecentPractice - 3.5) * 5; // +5 points per 1 rating above average
    predictedPoints = Math.round(pointsFromFG * 0.7 + avgPoints * 0.3 + practicePointsImpact);
    
    // Ensure reasonable range
    predictedPoints = Math.max(40, Math.min(120, predictedPoints));
    
    // Calculate variance in historical points to determine uncertainty
    let pointsVariance = 0;
    let predictedPointsMin = predictedPoints;
    let predictedPointsMax = predictedPoints;
    
    if (pointsScored.length > 0) {
      // Calculate standard deviation of historical points
      const meanPoints = avgPoints;
      const variance = pointsScored.reduce((sum, points) => sum + Math.pow(points - meanPoints, 2), 0) / pointsScored.length;
      pointsVariance = Math.sqrt(variance);
      
      // Calculate range based on confidence level and variance
      // Use a tighter range for more realistic predictions
      const uncertainty = Math.round(pointsVariance * 0.5); // Narrow range
      predictedPointsMin = Math.max(40, Math.min(120, predictedPoints - uncertainty));
      predictedPointsMax = Math.max(40, Math.min(120, predictedPoints + uncertainty));
    } else {
      // Default range if no historical data
      const defaultUncertainty = 5;
      predictedPointsMin = Math.max(40, Math.min(120, predictedPoints - defaultUncertainty));
      predictedPointsMax = Math.max(40, Math.min(120, predictedPoints + defaultUncertainty));
    }
    
    // Predict win/loss based on shooting efficiency and recent form
    const wins = winLoss[0];
    const total = wins + winLoss[1];
    const winRate = total > 0 ? wins / total : 0.5;
    
    // Win prediction: combine shooting efficiency, recent form, and practice quality
    const shootingFactor = predictedFG / 40; // 1.0 = average
    const formFactor = winRate;
    const practiceFactor = avgRecentPractice / 3.5; // 1.0 = average rating
    
    const winProbability = 0.3 + (formFactor * 0.3) + (shootingFactor * 0.2) + (practiceFactor * 0.2);
    predictedWin = winProbability > 0.55; // Slightly favor win if >55% chance
    
    // Confidence level based on data availability
    let confidence = 'Low';
    if (practiceSessions.length >= 10 && recentFG !== null && schedule && schedule.games) {
      confidence = 'High';
    } else if (practiceSessions.length >= 5 && schedule && schedule.games) {
      confidence = 'Medium';
    }
    
    // Calculate quarter-by-quarter breakdown
    const quarterBreakdown = { q1: 0, q2: 0, q3: 0, q4: 0, half1: 0, half2: 0 };
    
    if (shotMap && shotMap.shots && shotMap.shots.length > 0 && shotMap.games && shotMap.games.length > 0) {
      // Get quarter-based points from recent games
      const shotsByQuarter = { q1: 0, q2: 0, q3: 0, q4: 0 };
      const recentGameIds = new Set();
      
      // Get last 3 game IDs
      const sortedGames = Array.from(shotMap.games)
        .filter(g => {
          const dateMatch = g.label && g.label.match(/^([\d-]+)/);
          return dateMatch;
        })
        .sort((a, b) => {
          const dateMatchA = a.label.match(/^([\d-]+)/);
          const dateMatchB = b.label.match(/^([\d-]+)/);
          return dateMatchB && dateMatchA ? dateMatchB[1].localeCompare(dateMatchA[1]) : 0;
        })
        .slice(0, 3);
      
      sortedGames.forEach(g => recentGameIds.add(g.id));
      
      // Count points per quarter from these games
      shotMap.shots
        .filter(shot => recentGameIds.has(shot.gameId))
        .forEach(shot => {
          const period = String(shot.period || '').trim();
          const points = shot.made ? (shot.type === '3pt' ? 3 : 2) : 0;
          
          if (period === '1') shotsByQuarter.q1 += points;
          else if (period === '2') shotsByQuarter.q2 += points;
          else if (period === '3') shotsByQuarter.q3 += points;
          else if (period === '4') shotsByQuarter.q4 += points;
        });
      
      // Calculate average points per quarter (divide by number of games)
      const numGames = Math.max(1, recentGameIds.size);
      const avgQ1 = shotsByQuarter.q1 / numGames;
      const avgQ2 = shotsByQuarter.q2 / numGames;
      const avgQ3 = shotsByQuarter.q3 / numGames;
      const avgQ4 = shotsByQuarter.q4 / numGames;
      
      const totalAvg = avgQ1 + avgQ2 + avgQ3 + avgQ4;
      
      if (totalAvg > 0) {
        // Scale to predicted total points
        const scaleFactor = predictedPoints / totalAvg;
        
        quarterBreakdown.q1 = Math.round(avgQ1 * scaleFactor);
        quarterBreakdown.q2 = Math.round(avgQ2 * scaleFactor);
        quarterBreakdown.q3 = Math.round(avgQ3 * scaleFactor);
        quarterBreakdown.q4 = Math.round(avgQ4 * scaleFactor);
      } else {
        // Fallback to equal distribution if no quarter data
        const ptsPerQ = Math.round(predictedPoints / 4);
        quarterBreakdown.q1 = ptsPerQ;
        quarterBreakdown.q2 = ptsPerQ;
        quarterBreakdown.q3 = ptsPerQ;
        quarterBreakdown.q4 = ptsPerQ;
      }
      
      // Calculate halves
      quarterBreakdown.half1 = quarterBreakdown.q1 + quarterBreakdown.q2;
      quarterBreakdown.half2 = quarterBreakdown.q3 + quarterBreakdown.q4;
    } else {
      // Default distribution (approximately equal quarters)
      const ptsPerQ = Math.round(predictedPoints / 4);
      quarterBreakdown.q1 = ptsPerQ;
      quarterBreakdown.q2 = ptsPerQ;
      quarterBreakdown.q3 = ptsPerQ;
      quarterBreakdown.q4 = ptsPerQ;
      quarterBreakdown.half1 = ptsPerQ * 2;
      quarterBreakdown.half2 = ptsPerQ * 2;
    }
    
    console.log('Quarter breakdown:', quarterBreakdown);
    
    // Calculate historical prediction accuracy and track past games
    const historicalAccuracy = { avgError: 0, gamesCount: 0 };
    const pastGames = []; // Store prediction history
    
    if (pointsScored.length > 0 && lastGames.length >= 3) {
      // Use last 5 completed games for accuracy calculation
      const last5Actual = pointsScored.slice(-5);
      const last5Games = lastGames.slice(0, 5);
      
      // Simulate predictions for these games (using same model)
      const predictions = [];
      last5Actual.forEach((actual, idx) => {
        // Simple prediction: moving average
        const recentAvg = idx > 0 ? last5Actual.slice(0, idx).reduce((a, b) => a + b, 0) / idx : actual;
        predictions.push(recentAvg);
        
        // Store game history with actual vs predicted
        const gameData = last5Games[idx];
        if (gameData) {
          pastGames.push({
            date: gameData.date,
            actualPoints: actual,
            predictedPoints: Math.round(recentAvg),
            actualFG: gameData.fg.toFixed(1),
            actualFG2: gameData.fg2.toFixed(1),
            actualFG3: gameData.fg3.toFixed(1),
            error: Math.abs(recentAvg - actual)
          });
        }
      });
      
      // Calculate average error
      let totalError = 0;
      predictions.forEach((pred, idx) => {
        totalError += Math.abs(pred - last5Actual[idx]);
      });
      
      historicalAccuracy.avgError = Math.round(totalError / predictions.length);
      historicalAccuracy.gamesCount = Math.min(5, last5Actual.length);
    }
    
    return {
      ok: true,
      prediction: {
        opponent: nextGame.opponent,
        date: nextGameDateISO,
        competition: comp,
        predictedFG: Math.round(predictedFG),
        predictedFG2: Math.round(predictedFG2),
        predictedFG3: Math.round(predictedFG3),
        predictedPoints: predictedPoints,
        predictedPointsMin: predictedPointsMin,
        predictedPointsMax: predictedPointsMax,
        quarterBreakdown: quarterBreakdown,
        historicalAccuracy: historicalAccuracy,
        pastGames: pastGames.reverse(), // Most recent first
        predictedWin: predictedWin,
        winProbability: Math.round(winProbability * 100),
        confidence,
        inputs: {
          avgRecentPractice: avgRecentPractice.toFixed(2),
          recentFGPct: recentFG !== null ? recentFG.toFixed(1) + '%' : 'N/A',
          recentFG2Pct: recentFG2 !== null ? recentFG2.toFixed(1) + '%' : 'N/A',
          recentFG3Pct: recentFG3 !== null ? recentFG3.toFixed(1) + '%' : 'N/A',
          avgPoints: avgPoints.toFixed(1),
          recentRecord: `${winLoss[0]}-${winLoss[1]}`,
          practiceSessions: practiceSessions.length
        },
        breakdown: {
          baseline: 40,
          practiceAdjustment: practiceImpact.toFixed(1),
          trendAdjustment: recentFG !== null ? (recentFG - 40).toFixed(1) : 0
        }
      }
    };
    
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Helper: Calculate Pearson correlation coefficient
 */
function calculateCorrelation(x, y) {
  if (!x || !y || x.length !== y.length || x.length < 2) return null;
  
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
  const sumYY = y.reduce((sum, yi) => sum + yi * yi, 0);
  
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
  
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(3));
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

/**
 * Get shot map data from the spreadsheet
 * Returns the same format as the external shot map sheet's getShots() function
 */
function shotMapGetShots() {
  try {
    // Check cache first to avoid quota issues
    const cacheKey = 'shotMapGetShots_data';
    const cached = CacheService.getScriptCache().get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        console.log('[shotMapGetShots] Returning cached data');
        return parsed;
      } catch (e) {
        console.log('[shotMapGetShots] Cache parse error, fetching fresh data');
      }
    }
    
    // Read from external shot map spreadsheet
    const ss = SpreadsheetApp.openById(SHOTMAP_DOC_ID);
    
    // Check if there's a 'shotMapData' sheet
    const shotMapSheet = ss.getSheetByName('shotMapData');
    if (!shotMapSheet) {
      // Return empty data if sheet doesn't exist
      return { 
        shots: [], 
        players: [], 
        opponents: [], 
        periods: [], 
        games: [], 
        srcSize: { w: 1000, h: 1000 } 
      };
    }
    
    const rng = shotMapSheet.getDataRange();
    const values = rng.getValues();
    if (values.length < 2) {
      return { 
        shots: [], 
        players: [], 
        opponents: [], 
        periods: [], 
        games: [], 
        srcSize: { w: 1000, h: 1000 } 
      };
    }
    
    // Parse header row
    const header = values[0].map(h => String(h).trim().toLowerCase());
    const idx = (name) => header.indexOf(String(name).toLowerCase());
    
    const cols = {
      gameId: idx('gameid'), 
      org: idx('org'), 
      date: idx('date'),
      opponent: idx('opponent'), 
      competition: idx('competition'),
      period: idx('period'), 
      clock: idx('clock'),
      playerId: idx('playerid'), 
      player: idx('player'),
      x: idx('x'), 
      y: idx('y'), 
      made: idx('made'),
      type: idx('type'), 
      eventKey: idx('eventkey'),
      assist: idx('assist'), 
      assistby: idx('assistby'),
      passerId: idx('passerid'),
      teamSide: idx('teamside'),
      teamName: idx('teamname'),
      teamScore: idx('teamscore'),
      oppScore: idx('oppscore')
    };
    
    const shots = [];
    const setPeristeriPlayers = new Set();  // Separate sets for each team
    const setOpponentPlayers = new Set();
    const setOpp = new Set();
    const setPeriods = new Set();
    const gamesMap = new Map();  // id -> label
    const peristeriTeamNames = new Set(['Peristeri BC', 'peristeri', 'Peristeri', 'PERISTERI', 'Peristeri Betsson', 'Peristeri bwin', 'PBC']);
    
    // Process data rows
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (!row || row.every(v => v === '' || v === null)) continue;
      
      const x = Number(row[cols.x]);
      const y = Number(row[cols.y]);
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      
      const madeRaw = String(row[cols.made]).trim().toLowerCase();
      const madeNum = (madeRaw === '1' || madeRaw === 'true') ? 1 : 0;
      
      const teamName = String(row[cols.teamName] || '').trim();
      const isPeristeri = peristeriTeamNames.has(teamName);
      
      const s = {
        gameId: String(row[cols.gameId] || ''),
        org: row[cols.org] || '',
        date: row[cols.date] instanceof Date ? row[cols.date].toISOString() : String(row[cols.date] || ''),
        opponent: String(row[cols.opponent] || ''),
        competition: String(row[cols.competition] || ''),
        period: row[cols.period] || '',
        clock: String(row[cols.clock] || ''),
        playerId: String(row[cols.playerId] || ''),
        player: String(row[cols.player] || ''),
        x, y,
        made: madeNum,
        type: String(row[cols.type] || '').toLowerCase(),
        eventKey: String(row[cols.eventKey] || ''),
        assist: Number(row[cols.assist] || 0),
        assistBy: String(row[cols.assistby] || ''),
        passerId: String(row[cols.passerId] || ''),
        teamSide: isPeristeri ? 1 : 2,
        teamName: teamName,
        teamScore: Number(row[cols.teamScore]) || 0,
        oppScore: Number(row[cols.oppScore]) || 0
      };
      
      shots.push(s);
      
      // Separate players by team
      if (s.player) {
        if (isPeristeri) {
          setPeristeriPlayers.add(s.player);
        } else {
          setOpponentPlayers.add(s.player);
        }
      }
      if (s.opponent) setOpp.add(s.opponent);
      if (s.period !== '' && s.period !== undefined) setPeriods.add(s.period);
      
      if (!gamesMap.has(s.gameId) && s.gameId) {
        const d = s.date;
        const opp = s.opponent || '';
        const cmp = s.competition || '';
        const dateStr = d instanceof Date ? d.toISOString().slice(0,10) : String(d || '');
        const parts = [dateStr, opp, cmp].filter(Boolean);
        gamesMap.set(s.gameId, parts.length ? `${parts[0]} • ${parts[1]}${parts[2] ? ' ('+parts[2]+')' : ''}` : s.gameId);
      }
    }
    
    const result = {
      shots,
      players: Array.from(setPeristeriPlayers).sort(),  // Keep this for backward compatibility
      peristeriPlayers: Array.from(setPeristeriPlayers).sort(),  // NEW: Peristeri BC players only
      opponentPlayers: Array.from(setOpponentPlayers).sort(),   // NEW: Opponent players only
      opponents: Array.from(setOpp).sort(),
      periods: Array.from(setPeriods).sort((a,b)=>Number(a)-Number(b)),
      games: Array.from(gamesMap, ([id, label]) => ({ id, label })),
      srcSize: { w: 1000, h: 1000 }
    };
    
    // Cache the result for 5 minutes to avoid quota issues
    try {
      const cache = CacheService.getScriptCache();
      cache.put(cacheKey, JSON.stringify(result), 300);
      console.log('[shotMapGetShots] Cached data for 5 minutes');
    } catch (e) {
      console.log('[shotMapGetShots] Cache put failed:', e);
    }
    
    return result;
  } catch (err) {
    console.error('shotMapGetShots error:', err);
    return { 
      shots: [], 
      players: [], 
      opponents: [], 
      periods: [], 
      games: [], 
      srcSize: { w: 1000, h: 1000 },
      error: String(err)
    };
  }
}

/**
 * Get shot map data for a specific player
 * @param {string} playerName - The player's name to filter by
 * @param {Object} options - Optional parameters (e.g., { limit: 200 })
 * @returns {Object} Shot map data filtered by player name
 */
function shotMapGetPlayerChartData(playerName, options) {
  if (!playerName) {
    return {
      ok: false,
      error: 'Player name is required',
      shots: [],
      srcSize: { w: 1000, h: 1000 }
    };
  }
  
  try {
    // Get all shots first
    const allData = shotMapGetShots();
    if (allData.error) {
      return {
        ok: false,
        error: allData.error,
        shots: [],
        srcSize: { w: 1000, h: 1000 }
      };
    }
    
    // Check if there are any shots at all
    const totalShots = (allData.shots || []).length;
    if (totalShots === 0) {
      return {
        ok: false,
        error: 'No shot data found in database',
        shots: [],
        srcSize: { w: 1000, h: 1000 }
      };
    }
    
    // Get player name aliases from Script Properties
    let aliases = [];
    try {
      const aliasesJson = PropertiesService.getScriptProperties().getProperty('SHOT_MAP_PLAYER_ALIASES');
      if (aliasesJson) {
        const aliasMap = JSON.parse(aliasesJson);
        const targetName = String(playerName).trim();
        if (aliasMap[targetName] && Array.isArray(aliasMap[targetName])) {
          aliases = aliasMap[targetName];
        }
      }
    } catch (e) {
      console.warn('Failed to parse SHOT_MAP_PLAYER_ALIASES:', e);
    }
    
    // Build list of possible names to match (original + aliases)
    const targetName = String(playerName).trim();
    const namesToMatch = [targetName, ...aliases];
    const normalizedNames = namesToMatch.map(n => _norm(String(n).trim())).filter(Boolean);
    
    // Get unique player names for debugging (Peristeri only)
    const allPlayerNames = new Set((allData.shots || []).filter(s => s.teamSide === 1).map(s => String(s.player || '').trim()).filter(Boolean));
    
    // Filter shots by player name and Peristeri team only (check against original and all aliases, case-insensitive)
    const playerShots = (allData.shots || []).filter(shot => {
      // Only include Peristeri shots (teamSide 1)
      if (shot.teamSide !== 1) return false;
      const shotPlayer = String(shot.player || '').trim();
      if (!shotPlayer) return false;
      const normalizedShot = _norm(shotPlayer);
      return normalizedNames.some(normName => normalizedShot === normName);
    });
    
    // If no shots found, provide helpful error message
    if (playerShots.length === 0) {
      const availableNames = Array.from(allPlayerNames).slice(0, 10).join(', ');
      return {
        ok: false,
        error: `No shots found for player "${targetName}". Available players: ${availableNames}${allPlayerNames.size > 10 ? '...' : ''}`,
        shots: [],
        srcSize: allData.srcSize || { w: 1000, h: 1000 }
      };
    }
    
    // Apply limit if specified
    const limit = (options && options.limit) ? Number(options.limit) : null;
    const shots = limit && limit > 0 ? playerShots.slice(-limit) : playerShots;
    
    return {
      ok: true,
      shots: shots,
      srcSize: allData.srcSize || { w: 1000, h: 1000 }
    };
  } catch (err) {
    console.error('shotMapGetPlayerChartData error:', err);
    return {
      ok: false,
      error: String(err),
      shots: [],
      srcSize: { w: 1000, h: 1000 }
    };
  }
}

// Function to regenerate tmp_script_base64.html from tmp_script.html
// Run this once after updating tmp_script.html to update the base64 file
function regenerateTmpScriptBase64() {
  try {
    const htmlContent = HtmlService.createHtmlOutputFromFile('tmp_script').getContent();
    const base64Content = Utilities.base64Encode(htmlContent);
    
    Logger.log('Base64 content generated. Length: ' + base64Content.length);
    
    // Note: You need to manually copy this to tmp_script_base64.html in Apps Script editor
    // Or use clasp to update the file
    return {
      ok: true,
      message: 'Base64 encoding successful. Update tmp_script_base64.html with this content.',
      length: base64Content.length,
      content: base64Content
    };
  } catch (e) {
    Logger.log('Error regenerating base64: ' + e.toString());
    return {
      ok: false,
      error: String(e)
    };
  }
}

/*** ====== SPIRAL FEEDBACK FUNCTIONS (Standalone - can be removed without breaking app) ====== ***/

/**
 * Get all ratings from Log sheet for a player (sorted by date, not row position)
 * Returns: [{ date, dateISO, session, coach, player, avg, note, ts }, ...]
 */
function _spiralGetAllRatingsFromLog_(logSh, playerName, tz) {
  if (!logSh) return [];
  
  const lastRow = logSh.getLastRow();
  if (lastRow < 2) return [];
  
  const colCount = logSh.getLastColumn();
  const header = logSh.getRange(1, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
  
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
    Player: find(/^player/i),
    Coach: find(/^coach/i),
    Notes: find(/^notes/i),
    Exec: find(/^execution/i),
    Energy: find(/^energy/i),
    Comm: find(/^communication/i),
    Adapt: find(/^adapt/i),
    Res: find(/^resilience/i),
    Impact: find(/^team\s*impact/i)
  };
  
  if (idx.Player == null || idx.Session == null) return [];
  
  const traitCols = [idx.Exec, idx.Energy, idx.Comm, idx.Adapt, idx.Res, idx.Impact].filter(i => i != null);
  if (traitCols.length === 0) return [];
  
  // Read ALL rows (row position doesn't matter)
  const rows = logSh.getRange(2, 1, lastRow - 1, colCount).getValues();
  const ratingRows = [];
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const player = String(row[idx.Player] || '').trim();
    
    // Filter for this player
    if (_norm(player) !== _norm(playerName)) continue;
    
    const session = String(row[idx.Session] || '').trim();
    if (!session) continue;
    
    // Parse date (this is the key - we sort by date, not row number)
    const rawDate = idx.Date != null ? row[idx.Date] : null;
    const dateObj = _homeCoerceDate_(rawDate);
    if (!dateObj) continue;
    
    const dateISO = _homeToISO_(dateObj, tz);
    const coach = idx.Coach != null ? String(row[idx.Coach] || '').trim() : '';
    const note = idx.Notes != null ? String(row[idx.Notes] || '').trim() : '';
    
    // Calculate average rating from traits
    const scores = traitCols.map(c => _homeSafeNumber_(row[c])).filter(n => n != null);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    
    if (avg == null) continue;
    
    // Store with timestamp for sorting (NOT row number)
    ratingRows.push({
      date: dateObj,
      dateISO: dateISO,
      session: session,
      coach: coach,
      player: player,
      avg: avg,
      note: note,
      ts: dateObj.getTime()
    });
  }
  
  // CRITICAL: Sort by date/timestamp, NOT by row position
  ratingRows.sort((a, b) => a.ts - b.ts);
  
  return ratingRows;
}

/**
 * Group ratings by session and average (handles multiple coaches per session)
 */
function _spiralGroupRatingsBySession_(ratingRows) {
  const sessionMap = new Map();
  
  for (const row of ratingRows) {
    const key = `${row.dateISO}|${_norm(row.session)}`;
    
    if (!sessionMap.has(key)) {
      sessionMap.set(key, {
        date: row.date,
        dateISO: row.dateISO,
        session: row.session,
        ratings: [],
        notes: [],
        coaches: []
      });
    }
    
    const session = sessionMap.get(key);
    session.ratings.push(row.avg);
    if (row.note) session.notes.push({ coach: row.coach, note: row.note });
    if (row.coach) session.coaches.push(row.coach);
  }
  
  // Convert to array and calculate session averages
  const sessions = Array.from(sessionMap.values()).map(s => {
    const avg = s.ratings.reduce((a, b) => a + b, 0) / s.ratings.length;
    
    return {
      date: s.date,
      dateISO: s.dateISO,
      session: s.session,
      value: avg,
      ratingCount: s.ratings.length,
      notes: s.notes,
      coaches: [...new Set(s.coaches)]
    };
  });
  
  // Sort chronologically
  sessions.sort((a, b) => a.date.getTime() - b.date.getTime());
  
  return sessions;
}

/**
 * Identify baseline periods (3+ consecutive sessions with low variance)
 */
function _spiralIdentifyBaselines_(sessions, minSessions = 3, maxVariance = 0.15) {
  if (sessions.length < minSessions) return [];
  
  const baselines = [];
  let currentGroup = [];
  let baselineNumber = 1;
  
  for (let i = 0; i < sessions.length; i++) {
    currentGroup.push(sessions[i]);
    
    if (currentGroup.length >= minSessions) {
      const values = currentGroup.map(s => s.value);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
      const stdDev = Math.sqrt(variance);
      const maxDeviation = Math.max(...values.map(v => Math.abs(v - avg)));
      
      if (stdDev <= maxVariance && maxDeviation <= 0.2) {
        // Stable baseline - continue adding to group
        continue;
      } else {
        // Not stable - save previous group if it was stable
        if (currentGroup.length > minSessions) {
          const prevValues = currentGroup.slice(0, -1).map(s => s.value);
          const prevAvg = prevValues.reduce((a, b) => a + b, 0) / prevValues.length;
          const prevVariance = prevValues.reduce((sum, v) => sum + Math.pow(v - prevAvg, 2), 0) / prevValues.length;
          const prevStdDev = Math.sqrt(prevVariance);
          
          if (prevStdDev <= maxVariance) {
            baselines.push({
              baselineNumber: baselineNumber++,
              startIndex: i - currentGroup.length + 1,
              endIndex: i - 1,
              baselineValue: prevAvg,
              sessions: currentGroup.slice(0, -1),
              period: `${currentGroup[0].dateISO} to ${currentGroup[currentGroup.length - 2].dateISO}`
            });
          }
        }
        // Start new group with last session
        currentGroup = [sessions[i]];
      }
    }
  }
  
  // Don't forget the last group
  if (currentGroup.length >= minSessions) {
    const values = currentGroup.map(s => s.value);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev <= maxVariance) {
      baselines.push({
        baselineNumber: baselineNumber++,
        startIndex: sessions.length - currentGroup.length,
        endIndex: sessions.length - 1,
        baselineValue: avg,
        sessions: currentGroup,
        period: `${currentGroup[0].dateISO} to ${currentGroup[currentGroup.length - 1].dateISO}`
      });
    }
  }
  
  return baselines;
}

/**
 * Classify dip type based on notes (productive vs dangerous)
 */
function _spiralClassifyDipType_(notes) {
  if (!notes || notes.length === 0) return { type: 'unknown', learningScore: 0 };
  
  const learningKeywords = [
    // Active learning/improvement
    'learning', 'new', 'adjusting', 'adapting', 'working on', 'focusing on',
    'improving', 'developing', 'practicing', 'implementing', 'trying',
    'experimenting', 'figuring out', 'getting better at', 'progress',
    'building', 'refining', 'polishing', 'mastering', 'growing',
    // Positive process indicators
    'understanding', 'grasping', 'picking up', 'catching on', 'getting it',
    'making progress', 'showing improvement', 'coming along', 'taking shape',
    'taking steps', 'moving forward', 'advancing', 'evolving',
    // Skill development
    'technique', 'skill', 'fundamentals', 'basics', 'foundation',
    'mechanics', 'form', 'execution', 'application',
    // Challenge/effort (productive)
    'challenge', 'difficult', 'hard work', 'effort', 'pushing',
    'stretching', 'expanding', 'testing', 'exploring',
    // Positive outcomes
    'breakthrough', 'clicked', 'turned corner', 'light bulb', 'aha moment',
    // Energy/effort (positive)
    'good energy', 'great energy', 'high energy', 'positive energy',
    'solid energy', 'energetic', 'full of energy',
    // Performance quality (positive)
    'solid', 'good', 'great', 'excellent', 'impressive', 'outstanding',
    'best game', 'best practice', 'best performance', 'one of his best',
    'quality', 'quality minutes', 'deserves more minutes',
    // Positive influence
    'positive', 'positive influence', 'positive impact', 'good influence',
    'carried the team', 'x factor', 'threat', 'leader', 'locked in',
    'focused', 'concentrated', 'ready', 'prepared',
    // Improvement indicators
    'improved', 'better', 'getting better', 'step forward', 'making strides',
    'fast learner', 'good learner', 'adjusting well', 'adapting well',
    // Teaching moments (productive)
    'has to work on', 'needs to work on', 'can work on', 'should work on',
    'will get better', 'can improve', 'needs improvement' // These indicate learning path
  ];
  
  const concernKeywords = [
    // Negative states
    'struggling', 'concern', 'issue', 'problem', 'worry', 'declining',
    'regressing', 'lost', 'confused', 'frustrated', 'not responding',
    // Performance decline
    'dropping', 'falling', 'slipping', 'worsening', 'deteriorating',
    'going backwards', 'losing ground', 'falling behind',
    // Mental/emotional concerns
    'anxiety', 'stress', 'pressure', 'overwhelmed', 'discouraged',
    'demotivated', 'disengaged', 'checked out', 'tuned out',
    'negative', 'down', 'low', 'unhappy', 'upset', 'angry',
    // Physical concerns
    'fatigue', 'tired', 'exhausted', 'worn out', 'burnout',
    'injured', 'hurt', 'pain', 'sore', 'ache', 'out of shape',
    'physical condition', 'not in shape', 'game shape',
    // Behavioral concerns
    'resistant', 'defensive', 'shut down', 'withdrawn', 'isolated',
    'not listening', 'not following', 'rebellious', 'defiant',
    'not willing', 'not cooperating', 'ball hogging', 'selfish',
    // Lack of progress
    'stuck', 'plateau', 'no progress', 'not improving', 'same',
    'unchanged', 'static', 'flat', 'stagnant', 'inconsistent',
    'inconsistency', 'ups and downs',
    // Serious concerns
    'alarming', 'troubling', 'disturbing', 'serious', 'critical',
    'urgent', 'immediate attention', 'needs help', 'intervention',
    // Energy/effort (negative)
    'low energy', 'no energy', 'saving energy', 'empty practice',
    'low mentality', 'low mentality practice', 'not giving 100%',
    'selective effort', 'taking plays off', 'lazy', 'lazy entries',
    'not engaged', 'not focused', 'lack of focus', 'lack of concentration',
    // Mental state (negative)
    'slow minded', 'mentally slow', 'slow', 'moving slow',
    'bad body language', 'questionable body language', 'body language was off',
    'complaining', 'not a leader', 'discipline issue',
    // Performance quality (negative)
    'bad', 'worst', 'terrible', 'awful', 'poor', 'below average',
    'below avg', 'mediocre', 'average', // when in negative context
    'zero impact', 'small impact', 'no impact', 'not hurting the team', // faint praise
    'out of control', 'overmatched', 'getting bullied', 'shocked',
    // Decision making (negative)
    'bad decisions', 'poor decisions', 'wrong decisions', 'forced',
    'gambling', 'gambling in defense', 'not decisive',
    // Engagement (negative)
    'bored', 'looked bored', 'not focused', 'lack of concentration',
    'not ready', 'not prepared', 'unprepared',
    // Physical/mental fatigue
    'tired', 'looked tired', 'exhausted', 'worn out', 'fatigue',
    'out of shape', 'physical condition', 'needs better shape'
  ];
  
  const noteText = notes.map(n => String(n.note || '').toLowerCase()).join(' ');
  
  // Find which specific keywords matched
  const matchedLearningKeywords = learningKeywords.filter(kw => noteText.includes(kw));
  const matchedConcernKeywords = concernKeywords.filter(kw => noteText.includes(kw));
  
  const learningMatches = matchedLearningKeywords.length;
  const concernMatches = matchedConcernKeywords.length;
  
  let type = 'productive'; // Default to productive (yellow) - dips are usually learning periods
  if (learningMatches > concernMatches && learningMatches >= 2) {
    type = 'productive';
  } else if (concernMatches > learningMatches && concernMatches >= 2) {
    type = 'dangerous';
  } else if (learningMatches > 0) {
    type = 'productive';
  } else if (concernMatches > 0) {
    type = 'dangerous';
  }
  // If no keywords found, default to 'productive' (already set above)
  
  const learningScore = Math.min(100, (learningMatches * 15) + (notes.length * 5));
  
  return { 
    type: type, 
    learningScore: learningScore,
    matchedLearningKeywords: matchedLearningKeywords.slice(0, 5), // Limit to 5 for display
    matchedConcernKeywords: matchedConcernKeywords.slice(0, 5) // Limit to 5 for display
  };
}

/**
 * Detect dips (when ratings drop below baseline)
 */
function _spiralDetectDips_(sessions, baselines, allSessionsWithNotes) {
  const dips = [];
  let dipNumber = 1;
  const usedIndices = new Set(); // Track which session indices are already in a dip to avoid overlaps
  
  for (let i = 0; i < baselines.length; i++) {
    const baseline = baselines[i];
    const baselineValue = baseline.baselineValue;
    const baselineEndIndex = baseline.endIndex;
    
    let dipStartIndex = null;
    let dipDepth = 0;
    let dipSessions = [];
    let dipEnded = false;
    
    for (let j = baselineEndIndex + 1; j < sessions.length; j++) {
      // Skip if this session is already part of another dip
      if (usedIndices.has(j)) {
        // If we were tracking a dip and hit an overlap, end the dip at previous session
        if (dipStartIndex !== null && dipSessions.length > 0) {
          const prevIndex = j - 1;
          if (prevIndex >= dipStartIndex) {
            const dipStartDate = sessions[dipStartIndex].date;
            const dipEndDate = sessions[prevIndex].date;
            const dipNotes = allSessionsWithNotes.filter(s => {
              const sDate = s.date instanceof Date ? s.date : new Date(s.date);
              return sDate >= dipStartDate && sDate <= dipEndDate;
            }).flatMap(s => s.notes || []);
            
            const dipAnalysis = _spiralClassifyDipType_(dipNotes);
            
            dips.push({
              dipNumber: dipNumber++,
              baselineIndex: i,
              startIndex: dipStartIndex,
              endIndex: prevIndex,
              depth: dipDepth,
              baselineValue: baselineValue,
              lowestValue: Math.min(...dipSessions.map(s => s.value)),
              sessions: dipSessions,
              notes: dipNotes,
              type: dipAnalysis.type,
              learningScore: dipAnalysis.learningScore,
              matchedLearningKeywords: dipAnalysis.matchedLearningKeywords || [],
              matchedConcernKeywords: dipAnalysis.matchedConcernKeywords || []
            });
            
            // Mark these indices as used
            for (let idx = dipStartIndex; idx <= prevIndex; idx++) {
              usedIndices.add(idx);
            }
          }
          dipEnded = true;
        }
        continue;
      }
      
      const currentValue = sessions[j].value;
      const drop = baselineValue - currentValue;
      
      // Dip starts when rating drops 0.3+ below baseline (increased threshold to avoid false positives)
      if (drop >= 0.3 && dipStartIndex === null) {
        dipStartIndex = j;
        dipDepth = drop;
        dipSessions = [sessions[j]];
      }
      // Continue dip while below baseline
      else if (dipStartIndex !== null && currentValue < baselineValue) {
        dipDepth = Math.max(dipDepth, baselineValue - currentValue);
        dipSessions.push(sessions[j]);
      }
      // Dip ends when rating returns to baseline level
      else if (dipStartIndex !== null && currentValue >= baselineValue - 0.1) {
        // Get notes during dip period
        const dipStartDate = sessions[dipStartIndex].date;
        const dipEndDate = sessions[j].date;
        const dipNotes = allSessionsWithNotes.filter(s => {
          const sDate = s.date instanceof Date ? s.date : new Date(s.date);
          return sDate >= dipStartDate && sDate <= dipEndDate;
        }).flatMap(s => s.notes || []);
        
        const dipAnalysis = _spiralClassifyDipType_(dipNotes);
        
        dips.push({
          dipNumber: dipNumber++,
          baselineIndex: i,
          startIndex: dipStartIndex,
          endIndex: j,
          depth: dipDepth,
          baselineValue: baselineValue,
          lowestValue: Math.min(...dipSessions.map(s => s.value)),
          sessions: dipSessions,
          notes: dipNotes,
          type: dipAnalysis.type,
          learningScore: dipAnalysis.learningScore,
          matchedLearningKeywords: dipAnalysis.matchedLearningKeywords || [],
          matchedConcernKeywords: dipAnalysis.matchedConcernKeywords || []
        });
        
        // Mark these indices as used
        for (let idx = dipStartIndex; idx <= j; idx++) {
          usedIndices.add(idx);
        }
        
        dipEnded = true;
        break;
      }
    }
    
    // Handle ongoing dip (dip that hasn't returned to baseline yet) - only if no completed dip was found and it's the last baseline
    if (dipStartIndex !== null && !dipEnded && dipSessions.length >= 2 && i === baselines.length - 1) {
      // Only check for ongoing dips on the most recent baseline to avoid duplicates
      const lastSessionIndex = sessions.length - 1;
      const lastSession = sessions[lastSessionIndex];
      
      // Check if any of the sessions in this potential dip are already used
      let hasOverlap = false;
      for (let idx = dipStartIndex; idx <= lastSessionIndex; idx++) {
        if (usedIndices.has(idx)) {
          hasOverlap = true;
          break;
        }
      }
      
      if (lastSession && lastSession.value < baselineValue && !hasOverlap) {
        // Get notes during dip period (from start to now)
        const dipStartDate = sessions[dipStartIndex].date;
        const dipEndDate = sessions[lastSessionIndex].date;
        const dipNotes = allSessionsWithNotes.filter(s => {
          const sDate = s.date instanceof Date ? s.date : new Date(s.date);
          return sDate >= dipStartDate && sDate <= dipEndDate;
        }).flatMap(s => s.notes || []);
        
        const dipAnalysis = _spiralClassifyDipType_(dipNotes);
        
        dips.push({
          dipNumber: dipNumber++,
          baselineIndex: i,
          startIndex: dipStartIndex,
          endIndex: lastSessionIndex,
          depth: dipDepth,
          baselineValue: baselineValue,
          lowestValue: Math.min(...dipSessions.map(s => s.value)),
          sessions: dipSessions,
          notes: dipNotes,
          type: dipAnalysis.type,
          learningScore: dipAnalysis.learningScore,
          matchedLearningKeywords: dipAnalysis.matchedLearningKeywords || [],
          matchedConcernKeywords: dipAnalysis.matchedConcernKeywords || []
        });
        
        // Mark these indices as used
        for (let idx = dipStartIndex; idx <= lastSessionIndex; idx++) {
          usedIndices.add(idx);
        }
      }
    }
  }
  
  return dips;
}

/**
 * Detect volatility periods (inconsistent performance with high variability)
 * These are periods where ratings alternate between highs and lows but don't qualify as dips
 * IMPORTANT: Volatility periods should NOT overlap with dips (dips are more specific)
 */
function _spiralDetectVolatilityPeriods_(sessions, baselines, allSessionsWithNotes, dips) {
  const volatilityPeriods = [];
  const windowSize = 5; // Analyze 5-session windows
  const stdDevThreshold = 0.35;
  const cvThreshold = 12; // 12% coefficient of variation
  const minSessions = 4; // Minimum 4 sessions for a volatility period
  
  if (sessions.length < minSessions) {
    return volatilityPeriods; // Not enough data
  }
  
  // Helper function to check if a session index is within any dip period
  const isInDip = function(sessionIdx) {
    if (!dips || dips.length === 0) return false;
    return dips.some(dip => sessionIdx >= dip.startIndex && sessionIdx <= dip.endIndex);
  };
  
  // Analyze rolling windows
  for (let i = windowSize - 1; i < sessions.length; i++) {
    const window = sessions.slice(i - windowSize + 1, i + 1);
    const values = window.map(s => s.value).filter(v => v != null);
    
    if (values.length < minSessions) continue;
    
    // Calculate statistics
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const cv = mean > 0 ? (stdDev / mean) * 100 : 0;
    
    // Check for alternating pattern (high-low-high-low)
    const differences = [];
    for (let j = 1; j < values.length; j++) {
      differences.push(values[j] - values[j-1]);
    }
    const signChanges = differences.filter((d, idx) => 
      idx > 0 && Math.sign(d) !== Math.sign(differences[idx-1])
    ).length;
    const isAlternating = signChanges >= 2; // At least 2 sign changes = alternating pattern
    
    // Detect volatility period if high variability
    // BUT exclude if this period overlaps with any dip (dips are more specific)
    const periodStartIdx = i - windowSize + 1;
    const periodEndIdx = i;
    // Check if any session in this period window is within a dip
    let overlapsWithDip = false;
    for (let checkIdx = periodStartIdx; checkIdx <= periodEndIdx; checkIdx++) {
      if (isInDip(checkIdx)) {
        overlapsWithDip = true;
        break;
      }
    }
    
    if (stdDev > stdDevThreshold && cv > cvThreshold && !overlapsWithDip) {
      // Check if this extends previous period or starts new one
      const lastPeriod = volatilityPeriods.length > 0 ? volatilityPeriods[volatilityPeriods.length - 1] : null;
      const isContinuation = lastPeriod && 
        (i - windowSize + 1) <= lastPeriod.endIndex + 1;
      
      if (isContinuation && lastPeriod) {
        // Extend existing period
        lastPeriod.endIndex = i;
        lastPeriod.sessions.push(sessions[i]);
        lastPeriod.stdDev = Math.max(lastPeriod.stdDev, stdDev);
        lastPeriod.cv = Math.max(lastPeriod.cv, cv);
        lastPeriod.minValue = Math.min(lastPeriod.minValue, ...values);
        lastPeriod.maxValue = Math.max(lastPeriod.maxValue, ...values);
        lastPeriod.mean = (lastPeriod.mean * (lastPeriod.sessions.length - 1) + mean) / lastPeriod.sessions.length;
      } else {
        // Start new period
        const periodStartIndex = i - windowSize + 1;
        const periodEndIndex = i;
        const periodSessions = window.slice();
        
        // Get notes during this period
        const periodStartDate = sessions[periodStartIndex].date;
        const periodEndDate = sessions[periodEndIndex].date;
        const periodNotes = allSessionsWithNotes.filter(s => {
          const sDate = s.date instanceof Date ? s.date : new Date(s.date);
          return sDate >= periodStartDate && sDate <= periodEndDate;
        }).flatMap(s => s.notes || []);
        
        // Classify based on notes (similar to dips)
        const periodAnalysis = _spiralClassifyDipType_(periodNotes);
        
        volatilityPeriods.push({
          periodNumber: volatilityPeriods.length + 1,
          startIndex: periodStartIndex,
          endIndex: periodEndIndex,
          sessions: periodSessions,
          mean: mean,
          stdDev: stdDev,
          cv: cv,
          minValue: Math.min(...values),
          maxValue: Math.max(...values),
          range: Math.max(...values) - Math.min(...values),
          isAlternating: isAlternating,
          signChanges: signChanges,
          notes: periodNotes,
          type: periodAnalysis.type === 'productive' ? 'volatile-learning' : 
                periodAnalysis.type === 'dangerous' ? 'volatile-concern' : 'volatile-neutral',
          learningScore: periodAnalysis.learningScore,
          matchedLearningKeywords: periodAnalysis.matchedLearningKeywords || [],
          matchedConcernKeywords: periodAnalysis.matchedConcernKeywords || []
        });
      }
    }
  }
  
  // Filter out periods shorter than minimum
  return volatilityPeriods.filter(p => (p.endIndex - p.startIndex + 1) >= minSessions);
}

/**
 * Detect flat periods (stable baselines with no improvement, not overlapping with dips or volatility)
 */
function _spiralDetectFlatPeriods_(sessions, baselines, dips, volatilityPeriods, minSessions = 3) {
  const flatPeriods = [];
  
  if (!baselines || baselines.length === 0) {
    return flatPeriods;
  }
  
  // Helper to check if an index is in a dip
  const isInDip = (idx) => {
    return dips.some(dip => idx >= dip.startIndex && idx <= dip.endIndex);
  };
  
  // Helper to check if an index is in a volatility period
  const isInVolatility = (idx) => {
    return volatilityPeriods.some(vp => idx >= vp.startIndex && idx <= vp.endIndex);
  };
  
  // Check each baseline for flat periods
  for (let i = 0; i < baselines.length; i++) {
    const baseline = baselines[i];
    const baselineStart = baseline.startIndex;
    const baselineEnd = baseline.endIndex;
    const baselineValue = baseline.baselineValue;
    
    // Check if baseline period is long enough (reduced to 3 sessions)
    const baselineLength = baselineEnd - baselineStart + 1;
    if (baselineLength < minSessions) continue;
    
    // Check for overlap with dips or volatility
    let overlapCount = 0;
    for (let idx = baselineStart; idx <= baselineEnd; idx++) {
      if (isInDip(idx) || isInVolatility(idx)) {
        overlapCount++;
      }
    }
    
    // If more than 70% overlaps, skip this baseline (more lenient - was 50%)
    const overlapPercent = overlapCount / baselineLength;
    if (overlapPercent > 0.7) continue;
    
    // Calculate improvement for reference (but don't filter based on it - detect all stable baselines)
    let improvement = 0;
    if (i > 0) {
      const prevBaseline = baselines[i - 1];
      improvement = baselineValue - prevBaseline.baselineValue;
    }
    
    // Calculate variance to ensure it's truly stable
    const baselineSessions = sessions.slice(baselineStart, baselineEnd + 1);
    const values = baselineSessions.map(s => s.value);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    // More lenient stdDev threshold - increased to 0.25
    if (stdDev <= 0.25) {
      // Adjust indices if there's partial overlap
      let adjustedStart = baselineStart;
      let adjustedEnd = baselineEnd;
      
      // Trim start if it overlaps with dip/volatility
      for (let idx = baselineStart; idx <= baselineEnd; idx++) {
        if (isInDip(idx) || isInVolatility(idx)) {
          adjustedStart = idx + 1;
        } else {
          break;
        }
      }
      
      // Trim end if it overlaps with dip/volatility
      for (let idx = baselineEnd; idx >= baselineStart; idx--) {
        if (isInDip(idx) || isInVolatility(idx)) {
          adjustedEnd = idx - 1;
        } else {
          break;
        }
      }
      
      // Only add if we still have enough sessions after trimming (reduced to 3)
      if (adjustedEnd - adjustedStart + 1 >= 3) {
        const trimmedSessions = sessions.slice(adjustedStart, adjustedEnd + 1);
        const trimmedValues = trimmedSessions.map(s => s.value);
        const trimmedAvg = trimmedValues.reduce((a, b) => a + b, 0) / trimmedValues.length;
        const trimmedVariance = trimmedValues.reduce((sum, v) => sum + Math.pow(v - trimmedAvg, 2), 0) / trimmedValues.length;
        const trimmedStdDev = Math.sqrt(trimmedVariance);
        
        flatPeriods.push({
          periodNumber: flatPeriods.length + 1,
          startIndex: adjustedStart,
          endIndex: adjustedEnd,
          sessions: trimmedSessions,
          mean: trimmedAvg,
          stdDev: trimmedStdDev,
          baselineValue: baselineValue,
          previousBaselineValue: i > 0 ? baselines[i - 1].baselineValue : null,
          improvement: improvement
        });
      }
    }
  }
  
  return flatPeriods;
}

/**
 * Perform K-means clustering on players based on multiple dimensions
 */
function _clusterPlayers_(players) {
  if (!players || players.length === 0) {
    return {
      clusters: [],
      centroids: [],
      playerAssignments: {}
    };
  }
  
  const validPlayers = players.filter(p => p.ok === true && p.developmentScore != null);
  if (validPlayers.length < 2) {
    return {
      clusters: [],
      centroids: [],
      playerAssignments: {}
    };
  }
  
  // Extract and normalize features for each player
  const features = [];
  const playerIndices = [];
  
  validPlayers.forEach((player, idx) => {
    const archetype = player.archetype || {};
    const traitAverages = archetype.traitAverages || {};
    const metrics = archetype.metrics || {};
    const traitAnalysis = archetype.traitAnalysis || {};
    
    // Feature 1: Development Score (0-100) -> normalize to 0-1
    const devScore = (player.developmentScore || 0) / 100;
    
    // Feature 2-7: Trait averages (1-5 scale) -> normalize to 0-1
    const execution = traitAverages.execution != null ? (traitAverages.execution - 1) / 4 : 0.5;
    const energy = traitAverages.energy != null ? (traitAverages.energy - 1) / 4 : 0.5;
    const communication = traitAverages.communication != null ? (traitAverages.communication - 1) / 4 : 0.5;
    const adaptability = traitAverages.adaptability != null ? (traitAverages.adaptability - 1) / 4 : 0.5;
    const resilience = traitAverages.resilience != null ? (traitAverages.resilience - 1) / 4 : 0.5;
    const impact = traitAverages.impact != null ? (traitAverages.impact - 1) / 4 : 0.5;
    
    // Feature 8: Average trait score (trait balance)
    const avgTrait = (execution + energy + communication + adaptability + resilience + impact) / 6;
    
    // Feature 9: Trait balance (std dev of traits - lower = more balanced)
    const traitValues = [execution, energy, communication, adaptability, resilience, impact].filter(v => v > 0);
    const traitMean = traitValues.length > 0 ? traitValues.reduce((a, b) => a + b, 0) / traitValues.length : avgTrait;
    const traitVariance = traitValues.length > 0 
      ? traitValues.reduce((sum, v) => sum + Math.pow(v - traitMean, 2), 0) / traitValues.length 
      : 0;
    const traitBalance = 1 - Math.min(1, Math.sqrt(traitVariance)); // Higher = more balanced
    
    // Feature 10: Pattern quality (productive dips vs dangerous dips)
    const totalDips = (player.dips || []).length;
    const productiveDips = (player.dips || []).filter(d => d.type === 'productive').length;
    const patternQuality = totalDips > 0 ? productiveDips / totalDips : 0.5;
    
    // Feature 11: Recovery rate (Line 4 %)
    const recoveryRate = (player.line4Percentage || 0) / 100;
    
    // Feature 12: Consistency (inverse of volatility)
    const volatilityIndex = metrics.volatilityIndex || 0;
    const consistency = 1 - Math.min(1, volatilityIndex / 100);
    
    // Feature 13: Growth rate (normalized)
    const growthRate = metrics.growthRate || 0;
    const normalizedGrowth = Math.max(0, Math.min(1, (growthRate + 0.5) / 1.0)); // Map -0.5 to 1.0 range to 0-1
    
    // Feature 14: Experience level (session count normalized)
    const maxSessions = Math.max(...validPlayers.map(p => p.totalSessions || 0));
    const experience = maxSessions > 0 ? Math.min(1, (player.totalSessions || 0) / maxSessions) : 0;
    
    // Feature 15: Current phase (baseline=0.5, dip=0.2, recovery=0.8)
    const phaseValue = player.phase === 'baseline' ? 0.5 : (player.phase === 'dip' ? 0.2 : (player.phase === 'recovery' ? 0.8 : 0.5));
    
    features.push([
      devScore,           // 0: Development Score
      execution,          // 1: Execution trait
      energy,            // 2: Energy trait
      communication,     // 3: Communication trait
      adaptability,      // 4: Adaptability trait
      resilience,        // 5: Resilience trait
      impact,            // 6: Impact trait
      avgTrait,          // 7: Average trait
      traitBalance,      // 8: Trait balance
      patternQuality,    // 9: Pattern quality
      recoveryRate,      // 10: Recovery rate
      consistency,       // 11: Consistency
      normalizedGrowth,  // 12: Growth rate
      experience,        // 13: Experience
      phaseValue         // 14: Current phase
    ]);
    
    playerIndices.push(idx);
  });
  
  // Determine optimal number of clusters (5-6 based on data size)
  const numClusters = Math.min(6, Math.max(3, Math.floor(validPlayers.length / 3)));
  
  // Initialize centroids randomly
  const centroids = [];
  for (let i = 0; i < numClusters; i++) {
    const randomIdx = Math.floor(Math.random() * features.length);
    centroids.push([...features[randomIdx]]);
  }
  
  // K-means iteration
  let assignments = new Array(features.length).fill(-1);
  let changed = true;
  let iterations = 0;
  const maxIterations = 50;
  
  while (changed && iterations < maxIterations) {
    changed = false;
    const newAssignments = [];
    
    // Assign each player to nearest centroid
    for (let i = 0; i < features.length; i++) {
      let minDist = Infinity;
      let closestCluster = 0;
      
      for (let j = 0; j < centroids.length; j++) {
        const dist = _euclideanDistance_(features[i], centroids[j]);
        if (dist < minDist) {
          minDist = dist;
          closestCluster = j;
        }
      }
      
      newAssignments[i] = closestCluster;
      if (newAssignments[i] !== assignments[i]) {
        changed = true;
      }
    }
    
    assignments = newAssignments;
    
    // Update centroids
    for (let j = 0; j < centroids.length; j++) {
      const clusterPoints = [];
      for (let i = 0; i < features.length; i++) {
        if (assignments[i] === j) {
          clusterPoints.push(features[i]);
        }
      }
      
      if (clusterPoints.length > 0) {
        const numFeatures = features[0].length;
        centroids[j] = [];
        for (let f = 0; f < numFeatures; f++) {
          const sum = clusterPoints.reduce((s, p) => s + p[f], 0);
          centroids[j][f] = sum / clusterPoints.length;
        }
      }
    }
    
    iterations++;
  }
  
  // Build cluster results
  const clusters = [];
  const playerAssignments = {};
  
  for (let j = 0; j < centroids.length; j++) {
    const clusterPlayers = [];
    for (let i = 0; i < assignments.length; i++) {
      if (assignments[i] === j) {
        const playerIdx = playerIndices[i];
        const player = validPlayers[playerIdx];
        clusterPlayers.push({
          playerName: player.playerName,
          developmentScore: player.developmentScore,
          archetype: player.archetype
        });
        playerAssignments[player.playerName] = j;
      }
    }
    
    if (clusterPlayers.length > 0) {
      // Calculate cluster characteristics
      const avgDevScore = clusterPlayers.reduce((sum, p) => sum + (p.developmentScore || 0), 0) / clusterPlayers.length;
      
      // Calculate additional characteristics for more specific naming
      const traitAverages = clusterPlayers.map(p => {
        const archetype = p.archetype || {};
        const traits = archetype.traitAverages || {};
        const traitValues = [
          traits.execution || 0,
          traits.energy || 0,
          traits.communication || 0,
          traits.adaptability || 0,
          traits.resilience || 0,
          traits.impact || 0
        ].filter(t => t > 0);
        return traitValues.length > 0 ? traitValues.reduce((a, b) => a + b, 0) / traitValues.length : 0;
      });
      const avgTrait = traitAverages.length > 0 ? traitAverages.reduce((a, b) => a + b, 0) / traitAverages.length : 0;
      
      // Calculate trait balance (lower std dev = more balanced)
      const traitStdDev = traitAverages.length > 1 
        ? Math.sqrt(traitAverages.reduce((sum, t) => sum + Math.pow(t - avgTrait, 2), 0) / traitAverages.length)
        : 0;
      const isBalanced = traitStdDev < 0.3;
      
      // Determine base cluster name and characteristics
      let baseName = '';
      let clusterColor = '#79839a';
      let clusterDescription = '';
      let suffix = '';
      
      if (avgDevScore >= 70) {
        baseName = 'Elite Developers';
        clusterColor = '#2ecc71';
        clusterDescription = 'High development scores with strong patterns and traits';
        if (avgTrait >= 3.5) suffix = ' - High Traits';
        else if (isBalanced) suffix = ' - Balanced Profile';
      } else if (avgDevScore >= 55) {
        baseName = 'Strong Developers';
        clusterColor = '#4aa8ff';
        clusterDescription = 'Good development with positive growth patterns';
        if (avgTrait >= 3.5) suffix = ' - High Traits';
        else if (avgTrait < 3.0) suffix = ' - Trait Focus Needed';
        else if (isBalanced) suffix = ' - Balanced';
      } else if (avgDevScore >= 40) {
        baseName = 'Moderate Developers';
        clusterColor = '#ffb020';
        clusterDescription = 'Moderate development with mixed patterns';
        // Add distinguishing suffix based on score range
        if (avgDevScore >= 50) suffix = ' - Upper Range';
        else if (avgDevScore >= 45) suffix = ' - Mid Range';
        else suffix = ' - Lower Range';
        // Add trait info if significant
        if (avgTrait >= 3.5) suffix += ' (High Traits)';
        else if (avgTrait < 2.5) suffix += ' (Low Traits)';
      } else if (avgDevScore >= 25) {
        baseName = 'Struggling Developers';
        clusterColor = '#ff9500';
        clusterDescription = 'Low development scores requiring support';
        // Add distinguishing suffix based on score range
        if (avgDevScore >= 35) suffix = ' - Upper Range';
        else if (avgDevScore >= 30) suffix = ' - Mid Range';
        else suffix = ' - Lower Range';
        // Add trait info if significant
        if (avgTrait >= 3.0) suffix += ' (Decent Traits)';
        else if (avgTrait < 2.5) suffix += ' (Trait Gaps)';
      } else {
        baseName = 'At-Risk Players';
        clusterColor = '#ff5a5f';
        clusterDescription = 'Very low development scores needing critical intervention';
        if (avgTrait >= 2.5) suffix = ' - Potential Exists';
        else suffix = ' - Critical Support';
      }
      
      // Make cluster name unique by adding cluster number if there are duplicates
      const clusterName = baseName + suffix;
      
      clusters.push({
        clusterId: j,
        clusterName: clusterName,
        clusterColor: clusterColor,
        clusterDescription: clusterDescription,
        playerCount: clusterPlayers.length,
        averageDevelopmentScore: Math.round(avgDevScore),
        players: clusterPlayers.map(p => p.playerName),
        centroid: centroids[j]
      });
    }
  }
  
  // Sort clusters by average development score (descending)
  clusters.sort((a, b) => b.averageDevelopmentScore - a.averageDevelopmentScore);
  
  // Make cluster names unique by adding letters if duplicates exist
  const nameCounts = {};
  clusters.forEach(cluster => {
    const base = cluster.clusterName;
    if (!nameCounts[base]) {
      nameCounts[base] = 0;
    }
    nameCounts[base]++;
  });
  
  // Add letter suffixes to duplicates (A, B, C, etc.)
  const nameUsed = {};
  clusters.forEach(cluster => {
    const base = cluster.clusterName;
    if (nameCounts[base] > 1) {
      if (!nameUsed[base]) {
        nameUsed[base] = 0;
      }
      const letter = String.fromCharCode(65 + nameUsed[base]); // A, B, C, etc.
      cluster.clusterName = base + ' (' + letter + ')';
      nameUsed[base]++;
    }
  });
  
  return {
    clusters: clusters,
    centroids: centroids,
    playerAssignments: playerAssignments,
    totalPlayers: validPlayers.length
  };
}

/**
 * Calculate Euclidean distance between two feature vectors
 */
function _euclideanDistance_(vec1, vec2) {
  if (vec1.length !== vec2.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < vec1.length; i++) {
    sum += Math.pow(vec1[i] - vec2[i], 2);
  }
  return Math.sqrt(sum);
}

/**
 * Calculate team archetype based on aggregated player data
 */
function _calculateTeamArchetype_(players) {
  if (!players || players.length === 0) {
    return {
      teamArchetype: 'unknown',
      position: 0,
      direction: 'stable',
      averageDevelopmentScore: 0,
      traitProfile: null,
      distribution: {}
    };
  }
  
  const validPlayers = players.filter(p => p.ok === true && p.developmentScore != null);
  if (validPlayers.length === 0) {
    return {
      teamArchetype: 'unknown',
      position: 0,
      direction: 'stable',
      averageDevelopmentScore: 0,
      traitProfile: null,
      distribution: {}
    };
  }
  
  // Calculate average development score
  const avgDevScore = validPlayers.reduce((sum, p) => sum + (p.developmentScore || 0), 0) / validPlayers.length;
  
  // Determine team archetype position (0-100 scale)
  let teamArchetype = 'moderateDevelopment';
  let position = 50; // Middle of spectrum
  
  if (avgDevScore >= 90) {
    teamArchetype = 'eliteDevelopmentCulture';
    position = 90;
  } else if (avgDevScore >= 75) {
    teamArchetype = 'strongDevelopment';
    position = 75;
  } else if (avgDevScore >= 60) {
    teamArchetype = 'moderateDevelopment';
    position = 60;
  } else if (avgDevScore >= 45) {
    teamArchetype = 'struggling';
    position = 35;
  } else {
    teamArchetype = 'atRisk';
    position = 15;
  }
  
  // Calculate trait profile (average of all player traits)
  const traitSums = {
    execution: 0,
    energy: 0,
    communication: 0,
    adaptability: 0,
    resilience: 0,
    impact: 0
  };
  const traitCounts = {
    execution: 0,
    energy: 0,
    communication: 0,
    adaptability: 0,
    resilience: 0,
    impact: 0
  };
  
  validPlayers.forEach(player => {
    if (player.archetype && player.archetype.traitAverages) {
      const traits = player.archetype.traitAverages;
      if (traits.execution != null) { traitSums.execution += traits.execution; traitCounts.execution++; }
      if (traits.energy != null) { traitSums.energy += traits.energy; traitCounts.energy++; }
      if (traits.communication != null) { traitSums.communication += traits.communication; traitCounts.communication++; }
      if (traits.adaptability != null) { traitSums.adaptability += traits.adaptability; traitCounts.adaptability++; }
      if (traits.resilience != null) { traitSums.resilience += traits.resilience; traitCounts.resilience++; }
      if (traits.impact != null) { traitSums.impact += traits.impact; traitCounts.impact++; }
    }
  });
  
  const traitProfile = {
    execution: traitCounts.execution > 0 ? traitSums.execution / traitCounts.execution : null,
    energy: traitCounts.energy > 0 ? traitSums.energy / traitCounts.energy : null,
    communication: traitCounts.communication > 0 ? traitSums.communication / traitCounts.communication : null,
    adaptability: traitCounts.adaptability > 0 ? traitSums.adaptability / traitCounts.adaptability : null,
    resilience: traitCounts.resilience > 0 ? traitSums.resilience / traitCounts.resilience : null,
    impact: traitCounts.impact > 0 ? traitSums.impact / traitCounts.impact : null
  };
  
  // Calculate direction (trending up/down/stable)
  const improvingPlayers = validPlayers.filter(p => {
    const trend = p.archetype && p.archetype.metrics ? (p.archetype.metrics.growthRate || 0) : 0;
    return trend > 0.1;
  }).length;
  
  const decliningPlayers = validPlayers.filter(p => {
    const trend = p.archetype && p.archetype.metrics ? (p.archetype.metrics.growthRate || 0) : 0;
    return trend < -0.1;
  }).length;
  
  let direction = 'stable';
  const improvingPercent = (improvingPlayers / validPlayers.length) * 100;
  const decliningPercent = (decliningPlayers / validPlayers.length) * 100;
  
  if (improvingPercent > 40 && improvingPercent > decliningPercent + 10) {
    direction = 'headingUp';
  } else if (decliningPercent > 40 && decliningPercent > improvingPercent + 10) {
    direction = 'headingDown';
  } else if (Math.abs(improvingPercent - decliningPercent) < 15) {
    direction = 'stable';
  } else {
    direction = 'mixed';
  }
  
  // Calculate archetype distribution
  const distribution = {};
  validPlayers.forEach(player => {
    const devArchetype = player.archetype && player.archetype.developmentArchetype 
      ? player.archetype.developmentArchetype 
      : 'moderateDeveloper';
    distribution[devArchetype] = (distribution[devArchetype] || 0) + 1;
  });
  
  return {
    teamArchetype: teamArchetype,
    position: position,
    direction: direction,
    averageDevelopmentScore: Math.round(avgDevScore),
    traitProfile: traitProfile,
    distribution: distribution,
    improvingPlayers: improvingPlayers,
    decliningPlayers: decliningPlayers,
    totalPlayers: validPlayers.length
  };
}

/**
 * Track recoveries (when performance returns and compare to baseline)
 */
function _spiralTrackRecoveries_(sessions, baselines, dips) {
  const recoveries = [];
  let recoveryNumber = 1;
  
  for (const dip of dips) {
    const dipEndIndex = dip.endIndex;
    const previousBaseline = baselines[dip.baselineIndex];
    const previousBaselineValue = previousBaseline.baselineValue;
    
    // Find when rating stabilizes after dip
    let recoveryIndex = null;
    let recoveryValue = null;
    
    // Look for 2-3 consecutive sessions at or above baseline level
    for (let i = dipEndIndex + 1; i < sessions.length - 1; i++) {
      const current = sessions[i].value;
      const next = sessions[i + 1].value;
      
      // Recovery: 2+ sessions at or above previous baseline
      if (current >= previousBaselineValue - 0.1 && next >= previousBaselineValue - 0.1) {
        recoveryIndex = i;
        recoveryValue = (current + next) / 2;
        
        const exceedsBaseline = recoveryValue > previousBaselineValue + 0.1;
        const improvement = recoveryValue - previousBaselineValue;
        const cycleType = exceedsBaseline ? 'Line4' : (improvement > -0.1 ? 'Line3' : 'Line2');
        
        recoveries.push({
          recoveryNumber: recoveryNumber++,
          dipIndex: dips.indexOf(dip),
          recoveryIndex: recoveryIndex,
          recoveryValue: recoveryValue,
          previousBaselineValue: previousBaselineValue,
          exceedsBaseline: exceedsBaseline,
          improvement: improvement,
          cycleType: cycleType
        });
        
        break;
      }
    }
  }
  
  return recoveries;
}

/**
 * Identify complete cycles
 */
function _spiralIdentifyCycles_(sessions, baselines, dips, recoveries) {
  const cycles = [];
  let cycleNumber = 1;
  
  for (let i = 0; i < baselines.length; i++) {
    const baseline = baselines[i];
    const dip = dips.find(d => d.baselineIndex === i);
    
    if (!dip) {
      // No dip after this baseline = Line 1 (Flat)
      cycles.push({
        cycleNumber: cycleNumber++,
        type: 'Line1',
        baseline: baseline,
        dip: null,
        recovery: null,
        improvement: 0,
        summary: `Baseline ${baseline.baselineValue.toFixed(2)} - No dip detected (Line 1 - Flat)`
      });
      continue;
    }
    
    const recovery = recoveries.find(r => r.dipIndex === dips.indexOf(dip));
    
    if (!recovery) {
      // Dip but no recovery yet = Line 2 (Dip in progress)
      cycles.push({
        cycleNumber: cycleNumber++,
        type: 'Line2',
        baseline: baseline,
        dip: dip,
        recovery: null,
        improvement: null,
        summary: `Baseline ${baseline.baselineValue.toFixed(2)} → Dip to ${dip.lowestValue.toFixed(2)} (in progress) - Line 2`
      });
      continue;
    }
    
    // Complete cycle
    const summary = recovery.exceedsBaseline
      ? `Baseline ${baseline.baselineValue.toFixed(2)} → Dip to ${dip.lowestValue.toFixed(2)} → Recovery to ${recovery.recoveryValue.toFixed(2)} (Line 4 - Spiral)`
      : `Baseline ${baseline.baselineValue.toFixed(2)} → Dip to ${dip.lowestValue.toFixed(2)} → Recovery to ${recovery.recoveryValue.toFixed(2)} (Line 3 - Return to Baseline)`;
    
    cycles.push({
      cycleNumber: cycleNumber++,
      type: recovery.cycleType,
      baseline: baseline,
      dip: dip,
      recovery: recovery,
      improvement: recovery.improvement,
      summary: summary
    });
  }
  
  return cycles;
}

/**
 * Extract trait averages for a player from Log sheet
 */
function _spiralExtractTraitAverages_(playerName, logSh, tz) {
  if (!logSh || !playerName) {
    return {
      execution: null,
      energy: null,
      communication: null,
      adaptability: null,
      resilience: null,
      impact: null
    };
  }
  
  try {
    const lastRow = logSh.getLastRow();
    if (lastRow < 2) return null;
    
    const colCount = logSh.getLastColumn();
    const header = logSh.getRange(1, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
    
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
      Player: find(/^player/i),
      Exec: find(/^execution/i),
      Energy: find(/^energy/i),
      Comm: find(/^communication/i),
      Adapt: find(/^adapt/i),
      Res: find(/^resilience/i),
      Impact: find(/^team\s*impact/i)
    };
    
    if (idx.Player == null) return null;
    
    const playerNorm = _norm(playerName);
    const rows = logSh.getRange(2, 1, lastRow - 1, colCount).getValues();
    
    const traitValues = {
      execution: [],
      energy: [],
      communication: [],
      adaptability: [],
      resilience: [],
      impact: []
    };
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowPlayer = String(row[idx.Player] || '').trim();
      if (_norm(rowPlayer) !== playerNorm) continue;
      
      if (idx.Exec != null && row[idx.Exec] != null && row[idx.Exec] !== '') {
        const val = Number(row[idx.Exec]);
        if (!isNaN(val) && val > 0) traitValues.execution.push(val);
      }
      if (idx.Energy != null && row[idx.Energy] != null && row[idx.Energy] !== '') {
        const val = Number(row[idx.Energy]);
        if (!isNaN(val) && val > 0) traitValues.energy.push(val);
      }
      if (idx.Comm != null && row[idx.Comm] != null && row[idx.Comm] !== '') {
        const val = Number(row[idx.Comm]);
        if (!isNaN(val) && val > 0) traitValues.communication.push(val);
      }
      if (idx.Adapt != null && row[idx.Adapt] != null && row[idx.Adapt] !== '') {
        const val = Number(row[idx.Adapt]);
        if (!isNaN(val) && val > 0) traitValues.adaptability.push(val);
      }
      if (idx.Res != null && row[idx.Res] != null && row[idx.Res] !== '') {
        const val = Number(row[idx.Res]);
        if (!isNaN(val) && val > 0) traitValues.resilience.push(val);
      }
      if (idx.Impact != null && row[idx.Impact] != null && row[idx.Impact] !== '') {
        const val = Number(row[idx.Impact]);
        if (!isNaN(val) && val > 0) traitValues.impact.push(val);
      }
    }
    
    const calculateAvg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    
    return {
      execution: calculateAvg(traitValues.execution),
      energy: calculateAvg(traitValues.energy),
      communication: calculateAvg(traitValues.communication),
      adaptability: calculateAvg(traitValues.adaptability),
      resilience: calculateAvg(traitValues.resilience),
      impact: calculateAvg(traitValues.impact)
    };
  } catch (e) {
    Logger.log('Error extracting trait averages: ' + String(e));
    return null;
  }
}

/**
 * Calculate player archetype based on spiral metrics
 */
function _spiralCalculateArchetype_(sessions, spiralAnalysis, dips, cycles, currentPhase, traitAverages) {
  if (!sessions || sessions.length < 5) {
    return {
      primaryArchetype: 'insufficient_data',
      archetypeScore: 0,
      secondaryTraits: [],
      metrics: {}
    };
  }
  
  // Calculate key metrics
  const ratings = sessions.map(s => s.value);
  const avgRating = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  
  // Calculate standard deviation for consistency
  const variance = ratings.reduce((sum, val) => sum + Math.pow(val - avgRating, 2), 0) / ratings.length;
  const stdDev = Math.sqrt(variance);
  const consistencyScore = Math.max(0, Math.min(100, 100 - (stdDev * 20)));
  
  // Calculate growth rate (recent avg vs early avg)
  const earlySessions = Math.max(1, Math.min(5, Math.floor(sessions.length / 3)));
  const recentSessions = Math.max(1, Math.min(5, Math.floor(sessions.length / 3)));
  const earlyAvg = earlySessions > 0 ? sessions.slice(0, earlySessions).reduce((sum, s) => sum + s.value, 0) / earlySessions : avgRating;
  const recentAvg = recentSessions > 0 ? sessions.slice(-recentSessions).reduce((sum, s) => sum + s.value, 0) / recentSessions : avgRating;
  const growthRate = recentAvg - earlyAvg;
  
  // Dip quality (productive vs dangerous)
  const totalDips = dips.length;
  const productiveDips = dips.filter(d => d.type === 'productive').length;
  const dangerousDips = dips.filter(d => d.type === 'dangerous').length;
  const dipQuality = totalDips > 0 ? (productiveDips / totalDips) * 100 : 50;
  
  // Recovery rate (Line 4 percentage)
  const recoveryRate = spiralAnalysis.line4Percentage || 0;
  
  // Volatility index (higher stdDev = higher volatility)
  const volatilityIndex = Math.min(100, stdDev * 10);
  
  // Store metrics
  const metrics = {
    avgRating: avgRating,
    spiralScore: spiralAnalysis.spiralScore || 0,
    consistencyScore: consistencyScore,
    growthRate: growthRate,
    dipQuality: dipQuality,
    recoveryRate: recoveryRate,
    volatilityIndex: volatilityIndex,
    cyclesCompleted: spiralAnalysis.cyclesCompleted || 0,
    line4Percentage: spiralAnalysis.line4Percentage || 0
  };
  
  // Calculate archetype scores (using more lenient scoring with partial matches)
  const archetypeScores = {};
  
  // 1. The Plateau Performer (High avg + Low spiral + Low variance)
  archetypeScores.plateau = (avgRating >= 3.8 ? 30 : (avgRating >= 3.5 ? 15 : 0)) + 
                            (spiralAnalysis.spiralScore < 30 ? 30 : (spiralAnalysis.spiralScore < 50 ? 15 : 0)) + 
                            (consistencyScore > 70 ? 20 : (consistencyScore > 50 ? 10 : 0)) +
                            (volatilityIndex < 20 ? 20 : (volatilityIndex < 30 ? 10 : 0));
  
  // 2. The Rising Star (Low/med avg + High spiral + High Line 4%)
  archetypeScores.risingStar = (avgRating >= 2.5 && avgRating <= 3.5 ? 25 : (avgRating >= 2.0 && avgRating <= 4.0 ? 10 : 0)) +
                               (spiralAnalysis.spiralScore >= 60 ? 30 : (spiralAnalysis.spiralScore >= 40 ? 15 : 0)) +
                               (recoveryRate >= 50 ? 25 : (recoveryRate >= 30 ? 12 : 0)) +
                               (growthRate > 0.2 ? 20 : (growthRate > 0 ? 10 : 0));
  
  // 3. The Elite Developer (High avg + High spiral + High Line 4%)
  archetypeScores.eliteDeveloper = (avgRating >= 4.0 ? 30 : (avgRating >= 3.7 ? 15 : 0)) +
                                   (spiralAnalysis.spiralScore >= 70 ? 30 : (spiralAnalysis.spiralScore >= 50 ? 15 : 0)) +
                                   (recoveryRate >= 50 ? 20 : (recoveryRate >= 30 ? 10 : 0)) +
                                   (growthRate > 0 ? 20 : 0);
  
  // 4. The Clutch Performer (Med avg + High variance + High volatility)
  archetypeScores.clutchPerformer = (avgRating >= 2.5 && avgRating <= 3.8 ? 30 : (avgRating >= 2.0 && avgRating <= 4.0 ? 15 : 0)) +
                                    (volatilityIndex >= 40 ? 30 : (volatilityIndex >= 25 ? 15 : 0)) +
                                    (consistencyScore < 60 ? 20 : (consistencyScore < 75 ? 10 : 0)) +
                                    (stdDev > 0.4 ? 20 : (stdDev > 0.25 ? 10 : 0));
  
  // 5. The Steady Eddie (Med avg + Low variance + Low spiral)
  archetypeScores.steadyEddie = (avgRating >= 3.0 && avgRating <= 3.5 ? 30 : (avgRating >= 2.8 && avgRating <= 3.7 ? 15 : 0)) +
                                (consistencyScore >= 80 ? 30 : (consistencyScore >= 60 ? 15 : 0)) +
                                (spiralAnalysis.spiralScore < 30 ? 20 : (spiralAnalysis.spiralScore < 50 ? 10 : 0)) +
                                (volatilityIndex < 25 ? 20 : (volatilityIndex < 35 ? 10 : 0));
  
  // 6. The Learner (Med avg + Many productive dips + High Line 4%)
  archetypeScores.learner = (avgRating >= 2.5 && avgRating <= 3.8 ? 25 : (avgRating >= 2.0 && avgRating <= 4.0 ? 12 : 0)) +
                            (dipQuality >= 60 ? 30 : (dipQuality >= 40 ? 15 : (totalDips > 0 ? 5 : 0))) +
                            (recoveryRate >= 50 ? 25 : (recoveryRate >= 30 ? 12 : 0)) +
                            (totalDips >= 3 ? 20 : (totalDips >= 1 ? 10 : 0));
  
  // 7. The At-Risk Player (Low/med avg + Many dangerous dips + Low Line 4%)
  archetypeScores.atRisk = (avgRating < 3.5 ? 30 : (avgRating < 4.0 ? 15 : 0)) +
                           (dangerousDips >= 2 ? 30 : (dangerousDips >= 1 ? 15 : 0)) +
                           (recoveryRate < 30 ? 20 : (recoveryRate < 50 ? 10 : 0)) +
                           (spiralAnalysis.spiralScore < 20 ? 20 : (spiralAnalysis.spiralScore < 40 ? 10 : 0));
  
  // 8. The Volatile Talent (High variance + Mixed dip types)
  archetypeScores.volatileTalent = (volatilityIndex >= 35 ? 30 : (volatilityIndex >= 20 ? 15 : 0)) +
                                   (avgRating >= 2.5 && avgRating <= 3.8 ? 25 : (avgRating >= 2.0 && avgRating <= 4.0 ? 12 : 0)) +
                                   (productiveDips > 0 && dangerousDips > 0 ? 25 : ((productiveDips > 0 || dangerousDips > 0) ? 12 : 0)) +
                                   (stdDev > 0.3 ? 20 : (stdDev > 0.2 ? 10 : 0));
  
  // 9. The Late Bloomer (Low initial + Recent high spiral)
  archetypeScores.lateBloom = (earlyAvg < 3.0 ? 25 : (earlyAvg < 3.5 ? 12 : 0)) +
                              (growthRate > 0.3 ? 30 : (growthRate > 0.1 ? 15 : (growthRate > 0 ? 5 : 0))) +
                              (spiralAnalysis.spiralScore >= 50 ? 25 : (spiralAnalysis.spiralScore >= 30 ? 12 : 0)) +
                              (recentAvg > earlyAvg + 0.5 ? 20 : (recentAvg > earlyAvg + 0.2 ? 10 : (recentAvg > earlyAvg ? 5 : 0)));
  
  // 10. The Stagnant Player (Low avg + Low spiral + Low variance + Few cycles)
  archetypeScores.stagnant = (avgRating < 2.5 ? 30 : (avgRating < 3.0 ? 15 : 0)) +
                             (spiralAnalysis.spiralScore < 20 ? 30 : (spiralAnalysis.spiralScore < 40 ? 15 : 0)) +
                             (consistencyScore > 70 ? 15 : (consistencyScore > 50 ? 7 : 0)) +
                             (spiralAnalysis.cyclesCompleted < 2 ? 25 : (spiralAnalysis.cyclesCompleted < 3 ? 12 : 0));
  
  // Find primary archetype (highest score)
  let primaryArchetype = 'unknown';
  let maxScore = 0;
  for (const [archetype, score] of Object.entries(archetypeScores)) {
    if (score > maxScore) {
      maxScore = score;
      primaryArchetype = archetype;
    }
  }
  
  // Fallback: If no archetype scored above threshold, assign based on most prominent characteristics
  if (maxScore < 20) {
    // Use simpler fallback logic
    if (avgRating >= 4.0 && spiralAnalysis.spiralScore >= 50) {
      primaryArchetype = 'eliteDeveloper';
      maxScore = 25;
    } else if (avgRating >= 3.8 && spiralAnalysis.spiralScore < 30) {
      primaryArchetype = 'plateau';
      maxScore = 25;
    } else if (spiralAnalysis.spiralScore >= 50 && avgRating < 3.5) {
      primaryArchetype = 'risingStar';
      maxScore = 25;
    } else if (volatilityIndex >= 30 && stdDev > 0.25) {
      primaryArchetype = 'volatileTalent';
      maxScore = 25;
    } else if (consistencyScore >= 70 && avgRating >= 3.0) {
      primaryArchetype = 'steadyEddie';
      maxScore = 25;
    } else if (dangerousDips >= 1) {
      primaryArchetype = 'atRisk';
      maxScore = 25;
    } else if (totalDips >= 2 && dipQuality >= 50) {
      primaryArchetype = 'learner';
      maxScore = 25;
    } else if (growthRate > 0.1) {
      primaryArchetype = 'lateBloom';
      maxScore = 25;
    } else if (avgRating < 2.5) {
      primaryArchetype = 'stagnant';
      maxScore = 25;
    } else {
      // Default to steady eddie if nothing else matches
      primaryArchetype = 'steadyEddie';
      maxScore = 20;
    }
  }
  
  // Find secondary traits (top 2-3 after primary)
  const sortedScores = Object.entries(archetypeScores)
    .filter(([name]) => name !== primaryArchetype)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .filter(([_, score]) => score >= 30)
    .map(([name]) => name);
  
  // Analyze trait patterns if available
  const traitAnalysis = traitAverages ? _analyzeTraitPatterns_(traitAverages) : null;
  
  // Determine development-based primary archetype
  // Use developmentScore if available, otherwise fall back to spiralScore
  // Use != null check to handle 0 as a valid score
  const devScore = (spiralAnalysis.developmentScore != null && spiralAnalysis.developmentScore !== undefined) 
    ? spiralAnalysis.developmentScore 
    : ((spiralAnalysis.spiralScore != null && spiralAnalysis.spiralScore !== undefined) 
      ? spiralAnalysis.spiralScore 
      : 0);
  
  let developmentArchetype = 'atRisk'; // Default to lowest, not moderate
  
  // Use more balanced thresholds to better distribute archetypes
  // Adjusted to account for typical score distribution
  if (devScore >= 85) {
    developmentArchetype = 'eliteSpiral';
  } else if (devScore >= 70) {
    developmentArchetype = 'strongDeveloper';
  } else if (devScore >= 55) {
    developmentArchetype = 'moderateDeveloper';
  } else if (devScore >= 40) {
    developmentArchetype = 'strugglingDeveloper';
  } else {
    developmentArchetype = 'atRisk';
  }
  
  // Debug log for first player to verify
  if (Math.random() < 0.05) { // Log 5% of calls
    Logger.log('Archetype classification - devScore: ' + devScore + ', developmentScore: ' + spiralAnalysis.developmentScore + ', spiralScore: ' + spiralAnalysis.spiralScore + ', archetype: ' + developmentArchetype);
  }
  
  return {
    primaryArchetype: primaryArchetype,
    developmentArchetype: developmentArchetype, // New: development-based category
    archetypeScore: maxScore,
    secondaryTraits: sortedScores,
    metrics: metrics,
    archetypeScores: archetypeScores,
    traitAnalysis: traitAnalysis, // New: trait pattern analysis
    traitAverages: traitAverages // New: raw trait averages
  };
}

/**
 * Analyze trait patterns to identify strengths and gaps
 */
function _analyzeTraitPatterns_(traitAverages) {
  if (!traitAverages) return null;
  
  const traits = [
    { name: 'execution', value: traitAverages.execution },
    { name: 'energy', value: traitAverages.energy },
    { name: 'communication', value: traitAverages.communication },
    { name: 'adaptability', value: traitAverages.adaptability },
    { name: 'resilience', value: traitAverages.resilience },
    { name: 'impact', value: traitAverages.impact }
  ];
  
  // Filter out null values and calculate average
  const validTraits = traits.filter(t => t.value != null);
  const overallAvg = validTraits.length > 0 
    ? validTraits.reduce((sum, t) => sum + t.value, 0) / validTraits.length 
    : null;
  
  if (overallAvg == null) return null;
  
  // Identify high traits (above average + 0.3)
  const highThreshold = overallAvg + 0.3;
  const highTraits = validTraits.filter(t => t.value >= highThreshold)
    .sort((a, b) => b.value - a.value);
  
  // Identify low traits (below average - 0.3)
  const lowThreshold = overallAvg - 0.3;
  const lowTraits = validTraits.filter(t => t.value <= lowThreshold)
    .sort((a, b) => a.value - b.value);
  
  // Determine pattern
  let pattern = 'balanced';
  if (highTraits.length >= 4) pattern = 'wellRounded';
  else if (highTraits.length >= 2 && lowTraits.length === 0) pattern = 'specialized';
  else if (lowTraits.length >= 2 && highTraits.length === 0) pattern = 'gapPlayer';
  else if (highTraits.length > 0 && lowTraits.length > 0) pattern = 'mixed';
  
  return {
    overallAverage: overallAvg,
    highTraits: highTraits.map(t => ({ name: t.name, value: t.value })),
    lowTraits: lowTraits.map(t => ({ name: t.name, value: t.value })),
    pattern: pattern,
    allTraits: traits
  };
}

/**
 * Analyze spiral progression across multiple cycles
 */
/**
 * Calculate comprehensive development score incorporating dips, volatility, recoveries, and other factors
 */
function _calculateComprehensiveDevelopmentScore_(cycles, dips, volatilityPeriods, recoveries, sessions, baselines) {
  let score = 0;
  const breakdown = {
    spiralGrowth: 0,
    dipQuality: 0,
    consistency: 0,
    recoveryQuality: 0,
    trendDirection: 0
  };
  
  // 1. Spiral Growth (30 points max)
  const line4Cycles = cycles.filter(c => c.type === 'Line4').length;
  const line3Cycles = cycles.filter(c => c.type === 'Line3').length;
  const line1Cycles = cycles.filter(c => c.type === 'Line1').length;
  const line2Cycles = cycles.filter(c => c.type === 'Line2').length;
  const totalCycles = cycles.length;
  
  if (totalCycles > 0) {
    const spiralGrowthRaw = (line4Cycles * 10) + (line3Cycles * 3) + (line1Cycles * 1);
    breakdown.spiralGrowth = Math.min(30, (spiralGrowthRaw / Math.max(1, totalCycles)) * 3);
    score += breakdown.spiralGrowth;
  }
  
  // 2. Dip Quality (25 points max)
  const totalDips = dips.length;
  if (totalDips > 0) {
    const productiveDips = dips.filter(d => d.type === 'productive').length;
    const dangerousDips = dips.filter(d => d.type === 'dangerous').length;
    const neutralDips = dips.filter(d => d.type === 'unknown' || !d.type).length;
    
    const dipQualityRaw = (productiveDips * 8) - (dangerousDips * 5) + (neutralDips * 2);
    breakdown.dipQuality = Math.min(25, Math.max(0, (dipQualityRaw / totalDips) * 5));
    score += breakdown.dipQuality;
  } else {
    // No dips = neutral (12.5 points)
    breakdown.dipQuality = 12.5;
    score += breakdown.dipQuality;
  }
  
  // 3. Consistency (20 points max)
  if (sessions && sessions.length > 0) {
    const ratings = sessions.map(s => s.value).filter(v => v != null);
    if (ratings.length > 0) {
      const avgRating = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      const variance = ratings.reduce((sum, val) => sum + Math.pow(val - avgRating, 2), 0) / ratings.length;
      const stdDev = Math.sqrt(variance);
      
      // Base consistency score (0-15 points)
      const baseConsistency = Math.max(0, Math.min(15, (100 - (stdDev * 20)) / 100 * 15));
      
      // Volatility penalty (-3 points per volatility period)
      const volatilityPenalty = Math.min(10, volatilityPeriods.length * 3);
      
      // Baseline stability bonus
      const stableBaselines = baselines.filter(b => {
        const baselineSessions = sessions.slice(b.startIndex, b.endIndex + 1);
        if (baselineSessions.length < 3) return false;
        const baselineValues = baselineSessions.map(s => s.value);
        const baselineAvg = baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length;
        const baselineVariance = baselineValues.reduce((sum, val) => sum + Math.pow(val - baselineAvg, 2), 0) / baselineValues.length;
        const baselineStdDev = Math.sqrt(baselineVariance);
        return baselineStdDev < 0.15; // Stable if std dev < 0.15
      }).length;
      const baselineStabilityBonus = baselines.length > 0 ? (stableBaselines / baselines.length) * 5 : 0;
      
      breakdown.consistency = Math.max(0, Math.min(20, baseConsistency - volatilityPenalty + baselineStabilityBonus));
      score += breakdown.consistency;
    }
  }
  
  // 4. Recovery Quality (15 points max)
  const totalRecoveries = recoveries.length;
  if (totalDips > 0) {
    const line4Recoveries = recoveries.filter(r => r.exceedsBaseline).length;
    const line3Recoveries = recoveries.filter(r => !r.exceedsBaseline).length;
    const unrecoveredDips = totalDips - totalRecoveries;
    
    const recoveryQualityRaw = (line4Recoveries * 5) + (line3Recoveries * 1) - (unrecoveredDips * 2);
    breakdown.recoveryQuality = Math.min(15, Math.max(0, (recoveryQualityRaw / totalDips) * 5));
    score += breakdown.recoveryQuality;
  } else {
    // No dips = neutral (7.5 points)
    breakdown.recoveryQuality = 7.5;
    score += breakdown.recoveryQuality;
  }
  
  // 5. Trend Direction (10 points max)
  if (sessions && sessions.length >= 6) {
    const earlySessions = Math.max(1, Math.min(5, Math.floor(sessions.length / 3)));
    const recentSessions = Math.max(1, Math.min(5, Math.floor(sessions.length / 3)));
    const earlyAvg = earlySessions > 0 ? sessions.slice(0, earlySessions).reduce((sum, s) => sum + s.value, 0) / earlySessions : 0;
    const recentAvg = recentSessions > 0 ? sessions.slice(-recentSessions).reduce((sum, s) => sum + s.value, 0) / recentSessions : 0;
    const growthRate = recentAvg - earlyAvg;
    
    breakdown.trendDirection = Math.min(10, Math.max(-5, growthRate * 20));
    score += breakdown.trendDirection;
  }
  
  // Normalize to 0-100
  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  
  return {
    developmentScore: finalScore,
    breakdown: breakdown,
    components: {
      spiralGrowth: breakdown.spiralGrowth,
      dipQuality: breakdown.dipQuality,
      consistency: breakdown.consistency,
      recoveryQuality: breakdown.recoveryQuality,
      trendDirection: breakdown.trendDirection
    }
  };
}

function _spiralAnalyzeProgression_(cycles, dips, volatilityPeriods, recoveries, sessions, baselines) {
  // Calculate comprehensive development score
  const developmentScoreData = _calculateComprehensiveDevelopmentScore_(
    cycles, dips, volatilityPeriods, recoveries, sessions, baselines
  );
  
  if (cycles.length < 2) {
    return {
      spiralScore: developmentScoreData.developmentScore, // Keep for backward compatibility
      developmentScore: developmentScoreData.developmentScore,
      developmentScoreBreakdown: developmentScoreData.breakdown,
      cyclesCompleted: cycles.length,
      improvingCycles: 0,
      averageImprovementPerCycle: '0.00',
      isSpiraling: developmentScoreData.developmentScore >= 60,
      line4Cycles: cycles.filter(c => c.type === 'Line4').length,
      line4Percentage: cycles.length > 0 ? Math.round((cycles.filter(c => c.type === 'Line4').length / cycles.length) * 100) : 0,
      nextBaselineTarget: null,
      message: cycles.length < 2 ? 'Need at least 2 cycles to analyze spiral progression' : 'Only one cycle completed'
    };
  }
  
  // Get baseline values from cycles
  const baselineValues = cycles
    .filter(c => c.baseline && c.baseline.baselineValue)
    .map(c => c.baseline.baselineValue);
  
  if (baselineValues.length < 2) {
    return {
      spiralScore: developmentScoreData.developmentScore, // Keep for backward compatibility
      developmentScore: developmentScoreData.developmentScore,
      developmentScoreBreakdown: developmentScoreData.breakdown,
      cyclesCompleted: cycles.length,
      improvingCycles: 0,
      averageImprovementPerCycle: '0.00',
      isSpiraling: developmentScoreData.developmentScore >= 60,
      line4Cycles: cycles.filter(c => c.type === 'Line4').length,
      line4Percentage: 0,
      nextBaselineTarget: null,
      message: 'Insufficient baseline data for spiral analysis'
    };
  }
  
  // Check if each cycle starts higher than previous
  let improvingCycles = 0;
  let totalImprovement = 0;
  
  for (let i = 1; i < baselineValues.length; i++) {
    const improvement = baselineValues[i] - baselineValues[i - 1];
    if (improvement > 0.05) {
      improvingCycles++;
      totalImprovement += improvement;
    }
  }
  
  const spiralScore = Math.round((improvingCycles / (baselineValues.length - 1)) * 100);
  const averageImprovement = totalImprovement / (baselineValues.length - 1);
  const isSpiraling = developmentScoreData.developmentScore >= 60; // Use comprehensive score for isSpiraling
  
  const line4Cycles = cycles.filter(c => c.type === 'Line4').length;
  const line4Percentage = Math.round((line4Cycles / cycles.length) * 100);
  
  const nextBaselineTarget = baselineValues.length > 0
    ? (baselineValues[baselineValues.length - 1] + averageImprovement).toFixed(2)
    : null;
  
  const message = isSpiraling
    ? `Spiral development confirmed: ${improvingCycles} of ${baselineValues.length - 1} cycles show improvement`
    : `Not spiraling: Only ${improvingCycles} of ${baselineValues.length - 1} cycles show improvement`;
  
  return {
    spiralScore: spiralScore, // Keep for backward compatibility
    developmentScore: developmentScoreData.developmentScore, // New comprehensive score
    developmentScoreBreakdown: developmentScoreData.breakdown, // Component breakdown
    cyclesCompleted: cycles.length,
    improvingCycles: improvingCycles,
    averageImprovementPerCycle: averageImprovement.toFixed(2),
    isSpiraling: isSpiraling,
    line4Cycles: line4Cycles,
    line4Percentage: line4Percentage,
    nextBaselineTarget: nextBaselineTarget,
    message: message
  };
}

/**
 * Determine current phase
 */
function _spiralDetermineCurrentPhase_(sessions, baselines, dips, recoveries) {
  if (sessions.length === 0) return { phase: 'unknown', line: 'Line1' };
  
  const lastSession = sessions[sessions.length - 1];
  const lastBaseline = baselines.length > 0 ? baselines[baselines.length - 1] : null;
  
  if (!lastBaseline) {
    return { phase: 'baseline', line: 'Line1' };
  }
  
  // Check if we're in a dip
  const activeDip = dips.find(d => {
    return d.startIndex <= sessions.length - 1 && d.endIndex >= sessions.length - 1;
  });
  
  if (activeDip) {
    return {
      phase: 'dip',
      line: 'Line2',
      dipType: activeDip.type,
      currentRating: lastSession.value,
      baselineValue: activeDip.baselineValue,
      message: activeDip.type === 'productive' 
        ? 'Currently in productive dip - learning new skills'
        : 'Currently in dip - monitor closely'
    };
  }
  
  // Check if we're in recovery
  const activeRecovery = recoveries.find(r => {
    return r.recoveryIndex >= sessions.length - 2;
  });
  
  if (activeRecovery) {
    return {
      phase: 'recovery',
      line: activeRecovery.exceedsBaseline ? 'Line4' : 'Line3',
      currentRating: lastSession.value,
      previousBaselineValue: activeRecovery.previousBaselineValue,
      improvement: activeRecovery.improvement,
      message: activeRecovery.exceedsBaseline
        ? 'Recovery exceeding baseline - Spiral Development'
        : 'Recovery returning to baseline'
    };
  }
  
  // Check if we're in baseline
  const baselineEndIndex = lastBaseline.endIndex;
  if (sessions.length - 1 <= baselineEndIndex) {
    return { 
      phase: 'baseline', 
      line: 'Line1', 
      currentRating: lastSession.value,
      message: 'Currently in stable baseline period'
    };
  }
  
  // Default: assume baseline
  return { 
    phase: 'baseline', 
    line: 'Line1', 
    currentRating: lastSession.value,
    message: 'Currently in baseline period'
  };
}

/**
 * Analyze trait correlations with team dips
 * Returns correlation data for each dip showing which traits dropped and which players were responsible
 */
function _spiralAnalyzeDipCorrelations_(teamSessions, teamDips, teamBaselines, logSh, tz) {
  if (!teamSessions || !teamDips || !logSh || teamSessions.length < 3) {
    return null;
  }
  
  try {
    const lastRow = logSh.getLastRow();
    if (lastRow < 2) return null;
    
    const colCount = logSh.getLastColumn();
    const header = logSh.getRange(1, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
    
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
      Player: find(/^player/i),
      Exec: find(/^execution/i),
      Energy: find(/^energy/i),
      Comm: find(/^communication/i),
      Adapt: find(/^adapt/i),
      Res: find(/^resilience/i),
      Impact: find(/^team\s*impact/i)
    };
    
    if (idx.Player == null || idx.Session == null) return null;
    
    const traitNames = ['Execution', 'Energy', 'Communication', 'Adapt', 'Resilience', 'Impact'];
    const traitCols = [idx.Exec, idx.Energy, idx.Comm, idx.Adapt, idx.Res, idx.Impact];
    const validTraits = traitNames.filter((_, i) => traitCols[i] != null);
    const validCols = traitCols.filter(c => c != null);
    
    if (validCols.length === 0) return null;
    
    // Read all rating rows
    const rows = logSh.getRange(2, 1, lastRow - 1, colCount).getValues();
    const allRatings = [];
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const player = String(row[idx.Player] || '').trim();
      const session = String(row[idx.Session] || '').trim();
      if (!player || !session) continue;
      
      const rawDate = idx.Date != null ? row[idx.Date] : null;
      const dateObj = _homeCoerceDate_(rawDate);
      if (!dateObj) continue;
      
      const dateISO = _homeToISO_(dateObj, tz);
      
      // Get trait ratings
      const traits = {};
      validTraits.forEach((traitName, traitIdx) => {
        const colIdx = validCols[traitIdx];
        const value = _homeSafeNumber_(row[colIdx]);
        if (value != null) {
          traits[traitName] = value;
        }
      });
      
      if (Object.keys(traits).length > 0) {
        allRatings.push({
          dateISO: dateISO,
          date: dateObj,
          session: session,
          player: player,
          traits: traits
        });
      }
    }
    
    if (allRatings.length === 0) return null;
    
    // Create date-to-session index mapping
    const dateToSessionIndex = {};
    teamSessions.forEach((s, idx) => {
      dateToSessionIndex[s.dateISO] = idx;
    });
    
    // Analyze each dip
    const correlations = [];
    
    for (let dipIdx = 0; dipIdx < teamDips.length; dipIdx++) {
      const dip = teamDips[dipIdx];
      const startIdx = dip.startIndex;
      const endIdx = dip.endIndex;
      
      // Get dates for this dip period
      const dipDates = new Set();
      for (let i = startIdx; i <= endIdx && i < teamSessions.length; i++) {
        dipDates.add(teamSessions[i].dateISO);
      }
      
      // Get baseline dates for comparison (use previous baseline if available)
      const baselineDates = new Set();
      const prevBaseline = teamBaselines.find(b => b.endIndex < startIdx);
      if (prevBaseline) {
        for (let i = prevBaseline.startIndex; i <= prevBaseline.endIndex && i < teamSessions.length; i++) {
          baselineDates.add(teamSessions[i].dateISO);
        }
      }
      
      // Get ratings during dip period
      const dipRatings = allRatings.filter(r => dipDates.has(r.dateISO));
      const baselineRatings = baselineDates.size > 0 
        ? allRatings.filter(r => baselineDates.has(r.dateISO))
        : [];
      
      if (dipRatings.length === 0) {
        correlations.push(null);
        continue;
      }
      
      // Calculate trait averages during dip vs baseline
      const traitStats = {};
      
      validTraits.forEach(traitName => {
        // Dip period averages
        const dipValues = dipRatings
          .map(r => r.traits[traitName])
          .filter(v => v != null);
        const dipAvg = dipValues.length > 0 
          ? dipValues.reduce((a, b) => a + b, 0) / dipValues.length 
          : null;
        
        // Baseline period averages
        const baselineValues = baselineRatings
          .map(r => r.traits[traitName])
          .filter(v => v != null);
        const baselineAvg = baselineValues.length > 0
          ? baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length
          : null;
        
        if (dipAvg != null) {
          const drop = baselineAvg != null ? baselineAvg - dipAvg : null;
          traitStats[traitName] = {
            dipAverage: dipAvg,
            baselineAverage: baselineAvg,
            drop: drop,
            dropPercent: baselineAvg != null && baselineAvg > 0 ? (drop / baselineAvg) * 100 : null
          };
        }
      });
      
      // Find players with lowest ratings for each trait during dip
      const playerContributions = {};
      
      validTraits.forEach(traitName => {
        const playerScores = {};
        dipRatings.forEach(r => {
          const value = r.traits[traitName];
          if (value != null) {
            if (!playerScores[r.player]) {
              playerScores[r.player] = [];
            }
            playerScores[r.player].push(value);
          }
        });
        
        // Calculate average per player
        const playerAvgs = Object.entries(playerScores).map(([player, scores]) => ({
          player: player,
          average: scores.reduce((a, b) => a + b, 0) / scores.length,
          count: scores.length
        })).filter(p => p.count >= 1); // At least 1 rating
        
        // Sort by average (lowest first)
        playerAvgs.sort((a, b) => a.average - b.average);
        
        // Get top 3 players with lowest ratings
        const lowestPlayers = playerAvgs.slice(0, 3).map(p => ({
          player: p.player,
          average: p.average,
          count: p.count
        }));
        
        if (lowestPlayers.length > 0) {
          playerContributions[traitName] = lowestPlayers;
        }
      });
      
      // Identify most correlated traits (biggest drops)
      const correlatedTraits = Object.entries(traitStats)
        .filter(([_, stats]) => stats.drop != null && stats.drop > 0)
        .map(([trait, stats]) => ({
          trait: trait,
          drop: stats.drop,
          dropPercent: stats.dropPercent,
          dipAverage: stats.dipAverage,
          baselineAverage: stats.baselineAverage
        }))
        .sort((a, b) => b.drop - a.drop) // Sort by biggest drop
        .slice(0, 3); // Top 3
      
      // Add player contributions to correlated traits
      correlatedTraits.forEach(corr => {
        if (playerContributions[corr.trait]) {
          corr.lowestPlayers = playerContributions[corr.trait];
        }
      });
      
      correlations.push({
        correlatedTraits: correlatedTraits,
        dipPeriod: {
          startDate: teamSessions[startIdx] ? teamSessions[startIdx].dateISO : null,
          endDate: teamSessions[endIdx] ? teamSessions[endIdx].dateISO : null,
          sessionCount: endIdx - startIdx + 1
        }
      });
    }
    
    return correlations;
  } catch (e) {
    Logger.log('Error analyzing dip correlations: ' + String(e));
    return null;
  }
}

/**
 * Get spiral analysis for all players (dashboard view)
 */
function getAllSpiralAnalysis() {
  try {
    const players = getPlayers();
    if (!players || players.length === 0) {
      return { ok: false, reason: 'No players found' };
    }
    
    const results = [];
    const ss = _open();
    const logSh = ss.getSheetByName('Log');
    if (!logSh) {
      return { ok: false, reason: 'Log sheet not found' };
    }
    
    const tz = (ss.getSpreadsheetTimeZone && ss.getSpreadsheetTimeZone()) || Session.getScriptTimeZone();
    
    // OPTIMIZATION: Read Log sheet ONCE for all players (major performance improvement)
    const lastRow = logSh.getLastRow();
    const colCount = logSh.getLastColumn();
    if (lastRow < 2) {
      return { ok: false, reason: 'No data in Log sheet' };
    }
    
    const header = logSh.getRange(1, 1, 1, colCount).getValues()[0].map(h => String(h || '').trim());
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
      Player: find(/^player/i),
      Coach: find(/^coach/i),
      Notes: find(/^notes/i),
      Exec: find(/^execution/i),
      Energy: find(/^energy/i),
      Comm: find(/^communication/i),
      Adapt: find(/^adapt/i),
      Res: find(/^resilience/i),
      Impact: find(/^team\s*impact/i)
    };
    
    if (idx.Player == null || idx.Session == null) {
      return { ok: false, reason: 'Required columns not found in Log sheet' };
    }
    
    const traitCols = [idx.Exec, idx.Energy, idx.Comm, idx.Adapt, idx.Res, idx.Impact].filter(i => i != null);
    if (traitCols.length === 0) {
      return { ok: false, reason: 'No trait columns found' };
    }
    
    // Read ALL rows ONCE
    const rows = logSh.getRange(2, 1, lastRow - 1, colCount).getValues();
    
    // Group ratings by player (process all players from single read)
    const ratingsByPlayer = new Map();
    const traitDataByPlayer = new Map(); // For trait averages
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const player = String(row[idx.Player] || '').trim();
      if (!player) continue;
      
      const session = String(row[idx.Session] || '').trim();
      if (!session) continue;
      
      const rawDate = idx.Date != null ? row[idx.Date] : null;
      const dateObj = _homeCoerceDate_(rawDate);
      if (!dateObj) continue;
      
      const dateISO = _homeToISO_(dateObj, tz);
      const coach = idx.Coach != null ? String(row[idx.Coach] || '').trim() : '';
      const note = idx.Notes != null ? String(row[idx.Notes] || '').trim() : '';
      
      // Calculate average rating from traits
      const scores = traitCols.map(c => _homeSafeNumber_(row[c])).filter(n => n != null);
      const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      if (avg == null) continue;
      
      // Extract individual trait values for trait averages
      const traitValues = {
        execution: idx.Exec != null ? _homeSafeNumber_(row[idx.Exec]) : null,
        energy: idx.Energy != null ? _homeSafeNumber_(row[idx.Energy]) : null,
        communication: idx.Comm != null ? _homeSafeNumber_(row[idx.Comm]) : null,
        adaptability: idx.Adapt != null ? _homeSafeNumber_(row[idx.Adapt]) : null,
        resilience: idx.Res != null ? _homeSafeNumber_(row[idx.Res]) : null,
        impact: idx.Impact != null ? _homeSafeNumber_(row[idx.Impact]) : null
      };
      
      // Store rating data
      const playerKey = _norm(player);
      if (!ratingsByPlayer.has(playerKey)) {
        ratingsByPlayer.set(playerKey, []);
        traitDataByPlayer.set(playerKey, { execution: [], energy: [], communication: [], adaptability: [], resilience: [], impact: [] });
      }
      
      ratingsByPlayer.get(playerKey).push({
        date: dateObj,
        dateISO: dateISO,
        session: session,
        coach: coach,
        player: player,
        avg: avg,
        note: note,
        ts: dateObj.getTime(),
        traitValues: traitValues
      });
      
      // Store trait values for averaging
      const traitData = traitDataByPlayer.get(playerKey);
      Object.keys(traitValues).forEach(trait => {
        if (traitValues[trait] != null) {
          traitData[trait].push(traitValues[trait]);
        }
      });
    }
    
    // Sort ratings for each player by date
    ratingsByPlayer.forEach((ratings, playerKey) => {
      ratings.sort((a, b) => a.ts - b.ts);
    });
    
    // Process each player from the pre-loaded data
    for (const playerName of players) {
      try {
        const playerKey = _norm(playerName);
        const allRatings = ratingsByPlayer.get(playerKey) || [];
        
        // Extract trait averages from pre-loaded data
        const traitData = traitDataByPlayer.get(playerKey) || { execution: [], energy: [], communication: [], adaptability: [], resilience: [], impact: [] };
        const traitAverages = {
          execution: traitData.execution.length > 0 ? traitData.execution.reduce((a, b) => a + b, 0) / traitData.execution.length : null,
          energy: traitData.energy.length > 0 ? traitData.energy.reduce((a, b) => a + b, 0) / traitData.energy.length : null,
          communication: traitData.communication.length > 0 ? traitData.communication.reduce((a, b) => a + b, 0) / traitData.communication.length : null,
          adaptability: traitData.adaptability.length > 0 ? traitData.adaptability.reduce((a, b) => a + b, 0) / traitData.adaptability.length : null,
          resilience: traitData.resilience.length > 0 ? traitData.resilience.reduce((a, b) => a + b, 0) / traitData.resilience.length : null,
          impact: traitData.impact.length > 0 ? traitData.impact.reduce((a, b) => a + b, 0) / traitData.impact.length : null
        };
        
        // Remove traitValues from rating objects (not needed after grouping)
        const cleanRatings = allRatings.map(r => ({
          date: r.date,
          dateISO: r.dateISO,
          session: r.session,
          coach: r.coach,
          player: r.player,
          avg: r.avg,
          note: r.note,
          ts: r.ts
        }));
        
        if (allRatings.length < 5) {
          results.push({
            playerName: playerName,
            ok: false,
            reason: 'Insufficient data',
            totalRatings: allRatings.length
          });
          continue;
        }
        
        // Group by session
        const sessions = _spiralGroupRatingsBySession_(cleanRatings);
        
        if (sessions.length < 3) {
          results.push({
            playerName: playerName,
            ok: false,
            reason: 'Insufficient sessions',
            totalSessions: sessions.length
          });
          continue;
        }
        
        // Run full analysis
        const baselines = _spiralIdentifyBaselines_(sessions);
        const dips = _spiralDetectDips_(sessions, baselines, sessions);
        const volatilityPeriods = _spiralDetectVolatilityPeriods_(sessions, baselines, sessions, dips);
        const recoveries = _spiralTrackRecoveries_(sessions, baselines, dips);
        const flatPeriods = _spiralDetectFlatPeriods_(sessions, baselines, dips, volatilityPeriods);
        const cycles = _spiralIdentifyCycles_(sessions, baselines, dips, recoveries);
        const spiralAnalysis = _spiralAnalyzeProgression_(cycles, dips, volatilityPeriods, recoveries, sessions, baselines);
        const currentPhase = _spiralDetermineCurrentPhase_(sessions, baselines, dips, recoveries);
        
        // Trait averages already extracted from pre-loaded data (no need to read sheet again)
        
        // Calculate player archetype (with error handling and trait data)
        let archetype = {
          primaryArchetype: 'unknown',
          developmentArchetype: 'atRisk', // Default to lowest, not moderate
          archetypeScore: 0,
          secondaryTraits: [],
          metrics: {},
          traitAnalysis: null,
          traitAverages: null
        };
        try {
          archetype = _spiralCalculateArchetype_(sessions, spiralAnalysis, dips, cycles, currentPhase, traitAverages);
          // Verify developmentArchetype was set correctly
          if (!archetype.developmentArchetype) {
            // Fallback: calculate directly from developmentScore
            const devScore = spiralAnalysis.developmentScore || spiralAnalysis.spiralScore || 0;
            if (devScore >= 85) archetype.developmentArchetype = 'eliteSpiral';
            else if (devScore >= 70) archetype.developmentArchetype = 'strongDeveloper';
            else if (devScore >= 55) archetype.developmentArchetype = 'moderateDeveloper';
            else if (devScore >= 40) archetype.developmentArchetype = 'strugglingDeveloper';
            else archetype.developmentArchetype = 'atRisk';
            Logger.log('Fallback archetype calculation for ' + playerName + ': devScore=' + devScore + ', archetype=' + archetype.developmentArchetype);
          }
        } catch (e) {
          Logger.log('Error calculating archetype for ' + playerName + ': ' + String(e));
          // Fallback calculation on error
          const devScore = spiralAnalysis.developmentScore || spiralAnalysis.spiralScore || 0;
          if (devScore >= 85) archetype.developmentArchetype = 'eliteSpiral';
          else if (devScore >= 70) archetype.developmentArchetype = 'strongDeveloper';
          else if (devScore >= 55) archetype.developmentArchetype = 'moderateDeveloper';
          else if (devScore >= 40) archetype.developmentArchetype = 'strugglingDeveloper';
          else archetype.developmentArchetype = 'atRisk';
        }
        
        // Return summary for dashboard (include session data for team timeline chart)
        results.push({
          playerName: playerName,
          ok: true,
          totalRatings: allRatings.length,
          totalSessions: sessions.length,
          currentPhase: currentPhase,
          spiralScore: spiralAnalysis.spiralScore || 0, // Keep for backward compatibility
          developmentScore: spiralAnalysis.developmentScore || spiralAnalysis.spiralScore || 0, // New comprehensive score
          developmentScoreBreakdown: spiralAnalysis.developmentScoreBreakdown || null, // Component breakdown
          isSpiraling: (spiralAnalysis.developmentScore || spiralAnalysis.spiralScore || 0) >= 60, // Use developmentScore threshold
          cyclesCompleted: spiralAnalysis.cyclesCompleted,
          line4Cycles: spiralAnalysis.line4Cycles,
          line4Percentage: spiralAnalysis.line4Percentage,
          currentRating: currentPhase.currentRating || null,
          phase: currentPhase.phase || 'unknown',
          line: currentPhase.line || 'Line1',
          archetype: archetype,
          spiralScore: spiralAnalysis.spiralScore || 0, // Keep for backward compatibility
          developmentScore: spiralAnalysis.developmentScore || spiralAnalysis.spiralScore || 0, // New comprehensive score
          developmentScoreBreakdown: spiralAnalysis.developmentScoreBreakdown || null, // Component breakdown
          // Include session data for timeline chart
          sessions: sessions.map(s => ({
            date: s.dateISO,
            value: s.value,
            session: s.session
          }))
        });
      } catch (e) {
        Logger.log('Error analyzing ' + playerName + ': ' + String(e));
        results.push({
          playerName: playerName,
          ok: false,
          reason: 'Analysis error: ' + String(e)
        });
      }
    }
    
    // Calculate team-level summary and team average timeline
    const validPlayers = results.filter(p => p.ok === true);
    
    // Read all notes from Log sheet for team keyword detection (use already-read data)
    const teamNotesByDate = new Map();
    try {
      if (idx.Notes != null && idx.Date != null) {
        // Use the rows we already read (no need to read again)
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
          const note = String(row[idx.Notes] || '').trim();
            if (!note) continue;
            
          const rawDate = row[idx.Date];
            const dateObj = _homeCoerceDate_(rawDate);
            if (!dateObj) continue;
            
            const dateISO = _homeToISO_(dateObj, tz);
            if (!teamNotesByDate.has(dateISO)) {
              teamNotesByDate.set(dateISO, []);
            }
            teamNotesByDate.get(dateISO).push(note);
        }
      }
    } catch (e) {
      Logger.log('Error reading team notes: ' + String(e));
    }
    
    // Calculate team average ratings per date for timeline chart
    const teamSessions = [];
    if (validPlayers.length > 0) {
      // Collect all dates from all players
      const allDates = new Set();
      validPlayers.forEach(p => {
        if (p.sessions) {
          p.sessions.forEach(s => allDates.add(s.date));
        }
      });
      
      // For each date, calculate team average and collect notes
      const sortedDates = Array.from(allDates).sort();
      sortedDates.forEach(date => {
        const ratingsForDate = [];
        validPlayers.forEach(p => {
          if (p.sessions) {
            const session = p.sessions.find(s => s.date === date);
            if (session && session.value != null) {
              ratingsForDate.push(session.value);
            }
          }
        });
        
        if (ratingsForDate.length > 0) {
          const avg = ratingsForDate.reduce((a, b) => a + b, 0) / ratingsForDate.length;
          // Get notes for this date and format as objects (expected by _spiralClassifyDipType_)
          const notesForDate = (teamNotesByDate.get(date) || []).map(note => ({ note: note }));
          teamSessions.push({
            date: date,
            dateISO: date,
            session: 'Team Average',
            value: avg,
            ratingCount: ratingsForDate.length,
            notes: notesForDate // Add notes for keyword detection (formatted as objects with .note property)
          });
        }
      });
      
      // Sort team sessions chronologically
      teamSessions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }
    
    // Run spiral analysis on team average data
    let teamAnalysis = null;
    if (teamSessions.length >= 3) {
      try {
        const teamBaselines = _spiralIdentifyBaselines_(teamSessions);
        const teamDips = _spiralDetectDips_(teamSessions, teamBaselines, teamSessions);
        const teamVolatilityPeriods = _spiralDetectVolatilityPeriods_(teamSessions, teamBaselines, teamSessions, teamDips);
        const teamRecoveries = _spiralTrackRecoveries_(teamSessions, teamBaselines, teamDips);
        const teamCycles = _spiralIdentifyCycles_(teamSessions, teamBaselines, teamDips, teamRecoveries);
        const teamSpiralAnalysis = _spiralAnalyzeProgression_(teamCycles, teamDips, teamVolatilityPeriods, teamRecoveries, teamSessions, teamBaselines);
        const teamCurrentPhase = _spiralDetermineCurrentPhase_(teamSessions, teamBaselines, teamDips, teamRecoveries);
        
        // Analyze trait correlations with dips
        const dipCorrelations = _spiralAnalyzeDipCorrelations_(teamSessions, teamDips, teamBaselines, logSh, tz);
        
        teamAnalysis = {
          sessions: teamSessions.map(s => ({
            date: s.dateISO,
            value: s.value,
            session: s.session
          })),
          baselines: teamBaselines.map(b => ({
            baselineNumber: b.baselineNumber,
            value: b.baselineValue,
            sessions: b.sessions.length,
            period: b.period,
            startIndex: b.startIndex,
            endIndex: b.endIndex
          })),
          dips: teamDips.map((d, idx) => ({
            dipNumber: d.dipNumber,
            depth: d.depth,
            type: d.type,
            learningScore: d.learningScore,
            sessions: d.sessions.length,
            startIndex: d.startIndex,
            endIndex: d.endIndex,
            lowestValue: d.lowestValue,
            baselineValue: d.baselineValue,
            matchedLearningKeywords: d.matchedLearningKeywords || [],
            matchedConcernKeywords: d.matchedConcernKeywords || [],
            traitCorrelations: dipCorrelations && dipCorrelations[idx] ? dipCorrelations[idx] : null
          })),
          volatilityPeriods: teamVolatilityPeriods.map(v => ({
            periodNumber: v.periodNumber,
            type: v.type,
            learningScore: v.learningScore,
            sessions: v.sessions.length,
            startIndex: v.startIndex,
            endIndex: v.endIndex,
            mean: v.mean,
            stdDev: v.stdDev,
            cv: v.cv,
            minValue: v.minValue,
            maxValue: v.maxValue,
            range: v.range,
            isAlternating: v.isAlternating,
            signChanges: v.signChanges,
            matchedLearningKeywords: v.matchedLearningKeywords || [],
            matchedConcernKeywords: v.matchedConcernKeywords || []
          })),
          recoveries: teamRecoveries.map(r => ({
            recoveryNumber: r.recoveryNumber,
            recoveryValue: r.recoveryValue,
            previousBaselineValue: r.previousBaselineValue,
            exceedsBaseline: r.exceedsBaseline,
            improvement: r.improvement,
            recoveryIndex: r.recoveryIndex
          })),
          cycles: teamCycles.map(c => ({
            cycleNumber: c.cycleNumber,
            type: c.type,
            improvement: c.improvement,
            summary: c.summary
          })),
          spiralAnalysis: teamSpiralAnalysis,
          currentPhase: teamCurrentPhase,
          trajectory: _spiralCalculateTrajectory_(teamSessions, teamBaselines, teamDips, teamRecoveries, teamCycles)
        };
      } catch (e) {
        Logger.log('Error analyzing team spiral: ' + String(e));
      }
    }
    
    // Calculate team archetype
    const teamArchetype = _calculateTeamArchetype_(results);
    
    // Perform player clustering
    const playerClusters = _clusterPlayers_(results);
    
    const teamSummary = {
      totalPlayers: players.length,
      playersWithData: validPlayers.length,
      // Count players as spiraling if they have isSpiraling=true OR are in recovery phase (matches cluster chart logic)
      playersSpiraling: validPlayers.filter(p => p.isSpiraling === true || p.phase === 'recovery').length,
      playersInDip: validPlayers.filter(p => p.phase === 'dip').length,
      playersInRecovery: validPlayers.filter(p => p.phase === 'recovery').length,
      playersInBaseline: validPlayers.filter(p => p.phase === 'baseline').length,
      averageSpiralScore: validPlayers.length > 0 
        ? Math.round(validPlayers.reduce((sum, p) => sum + (p.developmentScore || p.spiralScore || 0), 0) / validPlayers.length)
        : 0,
      averageDevelopmentScore: validPlayers.length > 0 
        ? Math.round(validPlayers.reduce((sum, p) => sum + (p.developmentScore || p.spiralScore || 0), 0) / validPlayers.length)
        : 0,
      teamArchetype: teamArchetype, // New: team archetype data
      averageLine4Percentage: validPlayers.length > 0
        ? Math.round(validPlayers.reduce((sum, p) => sum + (p.line4Percentage || 0), 0) / validPlayers.length)
        : 0,
      totalCycles: validPlayers.reduce((sum, p) => sum + (p.cyclesCompleted || 0), 0),
      averageCycles: validPlayers.length > 0
        ? (validPlayers.reduce((sum, p) => sum + (p.cyclesCompleted || 0), 0) / validPlayers.length).toFixed(1)
        : '0.0',
      line1Count: validPlayers.filter(p => p.line === 'Line1').length,
      line2Count: validPlayers.filter(p => p.line === 'Line2').length,
      line3Count: validPlayers.filter(p => p.line === 'Line3').length,
      line4Count: validPlayers.filter(p => p.line === 'Line4').length,
      averageCurrentRating: validPlayers.filter(p => p.currentRating != null).length > 0
        ? (validPlayers.filter(p => p.currentRating != null).reduce((sum, p) => sum + p.currentRating, 0) / 
           validPlayers.filter(p => p.currentRating != null).length).toFixed(2)
        : null
    };
    
    // Generate team trajectory predictions and alerts
    let teamPredictions = null;
    if (teamAnalysis && validPlayers.length > 0) {
      teamPredictions = _spiralGenerateTeamPredictions_(
        teamAnalysis,
        teamSummary,
        validPlayers
      );
    }
    
    // Get upcoming game dates from schedule
    let upcomingGames = [];
    try {
      const scheduleResult = getSchedule();
      if (scheduleResult && scheduleResult.ok && scheduleResult.games) {
        const now = new Date().getTime();
        upcomingGames = scheduleResult.games
          .filter(g => g.status === 'upcoming' && g.ts && g.ts > now)
          .map(g => ({
            dateISO: g.dateISO,
            dateStr: g.dateStr,
            ts: g.ts,
            opponent: g.opponent,
            homeAway: g.homeAway
          }))
          .sort((a, b) => a.ts - b.ts); // Sort by date
      }
    } catch (e) {
      Logger.log('Error fetching schedule for spiral: ' + String(e));
    }
    
    return { 
      ok: true, 
      players: results, 
      teamSummary: teamSummary, 
      teamAnalysis: teamAnalysis,
      teamPredictions: teamPredictions,
      upcomingGames: upcomingGames,
      playerClusters: playerClusters // New: cluster analysis results
    };
  } catch (e) {
    Logger.log('getAllSpiralAnalysis error: ' + String(e));
    return { ok: false, reason: 'Error: ' + String(e) };
  }
}

/**
 * Predict next cycle (dip and recovery) based on historical patterns
 */
function _spiralPredictNextCycle_(sessions, baselines, dips, recoveries, cycles) {
  if (!sessions || sessions.length < 5) {
    return null;
  }
  
  // Ensure arrays exist
  baselines = baselines || [];
  dips = dips || [];
  recoveries = recoveries || [];
  cycles = cycles || [];
  
  const currentPhase = _spiralDetermineCurrentPhase_(sessions, baselines, dips, recoveries);
  const lastSession = sessions[sessions.length - 1];
  const lastBaseline = baselines.length > 0 ? baselines[baselines.length - 1] : null;
  
  // Calculate average dip duration (used in multiple places)
  const dipDurations = dips.map(d => d.endIndex - d.startIndex + 1);
  const avgDipDuration = dipDurations.length > 0 
    ? dipDurations.reduce((a, b) => a + b, 0) / dipDurations.length 
    : 2;
  
  let predictedDip = null;
  let predictedRecovery = null;
  let predictedPeak = null;
  
  // If currently in baseline, predict when dip will start
  if (currentPhase.phase === 'baseline' && lastBaseline) {
    // Calculate average baseline duration
    const baselineDurations = baselines.map(b => b.endIndex - b.startIndex + 1);
    const avgBaselineDuration = baselineDurations.reduce((a, b) => a + b, 0) / baselineDurations.length;
    
    // Calculate how long we've been past the last baseline
    const sessionsSinceBaseline = sessions.length - 1 - lastBaseline.endIndex;
    const remainingBaselineTime = Math.max(0, avgBaselineDuration - sessionsSinceBaseline);
    
    // Predict dip start
    const dipStartSession = sessions.length + Math.round(remainingBaselineTime);
    
    const avgDipDepth = dips.length > 0
      ? dips.reduce((sum, d) => sum + Math.abs(d.depth), 0) / dips.length
      : 0.3;
    
    // Predict dip
    const dipStartValue = lastBaseline.baselineValue;
    const dipLowestValue = Math.max(1, dipStartValue - avgDipDepth);
    const dipEndSession = dipStartSession + Math.round(avgDipDuration);
    
    predictedDip = {
      startSession: dipStartSession,
      endSession: dipEndSession,
      startValue: dipStartValue,
      lowestValue: dipLowestValue,
      depth: avgDipDepth
    };
    
    // Predict recovery timing based on historical recovery patterns
    const avgRecoveryTime = recoveries.length > 0
      ? recoveries.reduce((sum, r) => {
          // Find the dip that preceded this recovery
          const precedingDip = dips.find(d => d.endIndex < r.recoveryIndex);
          if (precedingDip) {
            return sum + (r.recoveryIndex - precedingDip.endIndex);
          }
          return sum + 1;
        }, 0) / recoveries.length
      : 1;
    
    const recoverySession = dipEndSession + Math.round(avgRecoveryTime);
    
    // Predict recovery type (Line 3 vs Line 4) based on historical rate
    const line4Rate = cycles.length > 0
      ? cycles.filter(c => c.type === 'Line4').length / cycles.length
      : 0.5;
    
    const willExceedBaseline = line4Rate >= 0.5;
    const recoveryValue = willExceedBaseline 
      ? Math.min(5, dipStartValue + 0.2) // Line 4: exceed baseline
      : dipStartValue; // Line 3: return to baseline
    
    predictedRecovery = {
      session: recoverySession,
      value: recoveryValue,
      type: willExceedBaseline ? 'Line4' : 'Line3',
      exceedsBaseline: willExceedBaseline
    };
    
    // Predict peak (highest point after recovery)
    if (willExceedBaseline) {
      const peakSession = recoverySession + 1;
      const peakValue = Math.min(5, recoveryValue + 0.1);
      predictedPeak = {
        session: peakSession,
        value: peakValue
      };
    }
  }
  // If currently in dip, predict recovery
  else if (currentPhase.phase === 'dip') {
    const activeDip = dips.find(d => {
      return d.startIndex <= sessions.length - 1 && d.endIndex >= sessions.length - 1;
    });
    
    if (activeDip) {
      const dipDuration = sessions.length - 1 - activeDip.startIndex + 1;
      const avgDipDuration = dipDurations.length > 1
        ? dipDurations.slice(0, -1).reduce((a, b) => a + b, 0) / (dipDurations.length - 1)
        : dipDuration;
      
      const expectedRecovery = activeDip.startIndex + Math.round(avgDipDuration);
      const recoverySession = Math.max(sessions.length, expectedRecovery);
      
      // Predict recovery type
      const line4Rate = cycles.length > 0
        ? cycles.filter(c => c.type === 'Line4').length / cycles.length
        : 0.5;
      
      const willExceedBaseline = line4Rate >= 0.5;
      const baselineValue = lastBaseline ? lastBaseline.baselineValue : lastSession.value;
      const recoveryValue = willExceedBaseline
        ? Math.min(5, baselineValue + 0.2)
        : baselineValue;
      
      predictedRecovery = {
        session: recoverySession,
        value: recoveryValue,
        type: willExceedBaseline ? 'Line4' : 'Line3',
        exceedsBaseline: willExceedBaseline
      };
      
      if (willExceedBaseline) {
        predictedPeak = {
          session: recoverySession + 1,
          value: Math.min(5, recoveryValue + 0.1)
        };
      }
    }
  }
  // If currently in recovery, predict next baseline and then next dip
  else if (currentPhase.phase === 'recovery') {
    // Recovery is happening, predict when it stabilizes into baseline
    const recoverySession = sessions.length + 2; // Typically 1-2 sessions to stabilize
    const recoveryValue = currentPhase.currentRating || lastSession.value;
    
    predictedRecovery = {
      session: recoverySession,
      value: recoveryValue,
      type: currentPhase.line || 'Line3',
      exceedsBaseline: currentPhase.line === 'Line4'
    };
    
    // Then predict next dip after this recovery stabilizes
    const baselineDurations = baselines.map(b => b.endIndex - b.startIndex + 1);
    const avgBaselineDuration = baselineDurations.length > 0
      ? baselineDurations.reduce((a, b) => a + b, 0) / baselineDurations.length
      : 3;
    
    const nextDipStart = recoverySession + Math.round(avgBaselineDuration);
    const avgDipDepth = dips.length > 0
      ? dips.reduce((sum, d) => sum + Math.abs(d.depth), 0) / dips.length
      : 0.3;
    
    predictedDip = {
      startSession: nextDipStart,
      endSession: nextDipStart + 2, // Average dip duration
      startValue: recoveryValue,
      lowestValue: Math.max(1, recoveryValue - avgDipDepth),
      depth: avgDipDepth
    };
  }
  
  return {
    dip: predictedDip,
    recovery: predictedRecovery,
    peak: predictedPeak
  };
}

/**
 * Calculate trajectory projection for chart visualization
 * Enhanced to include predicted cycle (dip + recovery)
 */
function _spiralCalculateTrajectory_(sessions, baselines, dips, recoveries, cycles) {
  if (!sessions || sessions.length < 3) {
    return null;
  }
  
  // Calculate trend from last 5 sessions (or all if less)
  const recentCount = Math.min(5, sessions.length);
  const recentSessions = sessions.slice(-recentCount);
  const values = recentSessions.map(s => s.value);
  
  // Simple linear regression for trend
  const n = values.length;
  const sumX = (n * (n - 1)) / 2; // 0, 1, 2, 3, 4...
  const sumY = values.reduce((a, b) => a + b, 0);
  const sumXY = values.reduce((sum, val, idx) => sum + (idx * val), 0);
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6; // 0² + 1² + 2² + ...
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  
  // Project next 3 sessions (short-term trajectory)
  const lastValue = sessions[sessions.length - 1].value;
  const projectedSessions = [];
  for (let i = 1; i <= 3; i++) {
    const projectedValue = intercept + slope * (recentCount - 1 + i);
    // Clamp between 1 and 5
    const clampedValue = Math.max(1, Math.min(5, projectedValue));
    projectedSessions.push({
      index: sessions.length - 1 + i,
      value: clampedValue
    });
  }
  
  // Predict next cycle (dip + recovery)
  const cyclePrediction = _spiralPredictNextCycle_(sessions, baselines || [], dips || [], recoveries || [], cycles || []);
  
  // Extend projection to include predicted cycle
  const extendedProjection = [...projectedSessions];
  
  if (cyclePrediction) {
    // Add dip projection
    if (cyclePrediction.dip) {
      const dip = cyclePrediction.dip;
      // Fill in sessions from last projected to dip start
      for (let i = projectedSessions.length; i < dip.startSession - sessions.length; i++) {
        const sessionIdx = sessions.length + i;
        const prevValue = i === 0 ? lastValue : extendedProjection[i - 1].value;
        extendedProjection.push({
          index: sessionIdx,
          value: prevValue // Maintain current level until dip
        });
      }
      
      // Add dip curve (decline then recovery start)
      const dipSessions = dip.endSession - dip.startSession;
      const dipStartOffset = dip.startSession - sessions.length;
      for (let i = 0; i <= dipSessions; i++) {
        const sessionIdx = sessions.length + dipStartOffset + i;
        // Create a curve: start high, dip low in middle, start recovering
        const progress = i / dipSessions;
        const dipCurve = Math.sin(progress * Math.PI); // Creates smooth dip curve
        const value = dip.startValue - (dip.depth * dipCurve);
        extendedProjection.push({
          index: sessionIdx,
          value: Math.max(1, Math.min(5, value)),
          isDip: i === Math.floor(dipSessions / 2) // Mark middle point as dip
        });
      }
    }
    
    // Add recovery projection
    if (cyclePrediction.recovery) {
      const recovery = cyclePrediction.recovery;
      const lastProjectedIdx = extendedProjection.length > 0 
        ? extendedProjection[extendedProjection.length - 1].index 
        : sessions.length - 1;
      
      // Fill gap if needed
      for (let i = lastProjectedIdx + 1; i < recovery.session - sessions.length; i++) {
        const sessionIdx = sessions.length + (i - (lastProjectedIdx - sessions.length + 1));
        const prevValue = extendedProjection.length > 0 
          ? extendedProjection[extendedProjection.length - 1].value 
          : lastValue;
        extendedProjection.push({
          index: sessionIdx,
          value: prevValue
        });
      }
      
      // Add recovery point
      extendedProjection.push({
        index: recovery.session,
        value: recovery.value,
        isRecovery: true,
        recoveryType: recovery.type
      });
      
      // Add peak if predicted
      if (cyclePrediction.peak) {
        const peak = cyclePrediction.peak;
        extendedProjection.push({
          index: peak.session,
          value: peak.value,
          isPeak: true
        });
      }
    }
  }
  
  return {
    trend: slope,
    lastValue: lastValue,
    projected: projectedSessions,
    extendedProjection: extendedProjection.length > projectedSessions.length ? extendedProjection : null,
    cyclePrediction: cyclePrediction
  };
}

/**
 * Calculate team health score (0-100) based on multiple factors
 */
function _spiralCalculateTeamHealth_(teamAnalysis, teamSummary, allPlayers) {
  if (!teamAnalysis || !teamSummary || allPlayers.length === 0) {
    return { score: 50, trend: 'unknown', factors: [] };
  }
  
  let score = 50; // Start at neutral
  const factors = [];
  
  // Factor 1: Spiral score (0-40 points)
  const avgSpiralScore = teamSummary.averageSpiralScore || 0;
  const spiralPoints = Math.min(40, (avgSpiralScore / 100) * 40);
  score += spiralPoints;
  factors.push({ name: 'Spiral Development', value: spiralPoints.toFixed(1), max: 40 });
  
  // Factor 2: Line 4 percentage (0-20 points)
  const line4Pct = teamSummary.averageLine4Percentage || 0;
  const line4Points = (line4Pct / 100) * 20;
  score += line4Points;
  factors.push({ name: 'Line 4 Rate', value: line4Points.toFixed(1), max: 20 });
  
  // Factor 3: Players spiraling (0-20 points)
  const spiralingRate = teamSummary.playersWithData > 0 
    ? (teamSummary.playersSpiraling / teamSummary.playersWithData) * 100 
    : 0;
  const spiralingPoints = (spiralingRate / 100) * 20;
  score += spiralingPoints;
  factors.push({ name: 'Players Spiraling', value: spiralingPoints.toFixed(1), max: 20 });
  
  // Factor 4: Dangerous dips penalty (-0 to -20 points)
  const playersInDangerousDips = allPlayers.filter(p => p.phase === 'dip' && p.line === 'Line2').length;
  const dangerousDipPenalty = Math.min(20, playersInDangerousDips * 5);
  score -= dangerousDipPenalty;
  if (dangerousDipPenalty > 0) {
    factors.push({ name: 'Dangerous Dips', value: (-dangerousDipPenalty).toFixed(1), max: -20 });
  }
  
  // Factor 5: Stagnation penalty (-0 to -10 points)
  const stagnationRate = teamSummary.playersWithData > 0
    ? (teamSummary.line1Count / teamSummary.playersWithData) * 100
    : 0;
  const stagnationPenalty = stagnationRate > 40 ? Math.min(10, ((stagnationRate - 40) / 60) * 10) : 0;
  score -= stagnationPenalty;
  if (stagnationPenalty > 0) {
    factors.push({ name: 'Stagnation', value: (-stagnationPenalty).toFixed(1), max: -10 });
  }
  
  // Clamp score between 0-100
  score = Math.max(0, Math.min(100, score));
  
  // Determine trend
  const sessions = teamAnalysis.sessions || [];
  let trend = 'stable';
  if (sessions.length >= 3) {
    const recentTrend = sessions[sessions.length - 1].value - sessions[sessions.length - 3].value;
    if (recentTrend > 0.1) trend = 'improving';
    else if (recentTrend < -0.1) trend = 'declining';
  }
  
  return {
    score: Math.round(score),
    trend: trend,
    factors: factors,
    label: score >= 70 ? 'Excellent' : (score >= 50 ? 'Good' : (score >= 30 ? 'Fair' : 'Poor'))
  };
}

/**
 * Calculate team-wide dip risk prediction
 */
function _spiralCalculateTeamDipRisk_(teamAnalysis, teamSummary, allPlayers) {
  if (!teamAnalysis || allPlayers.length === 0) {
    return { risk: 0, confidence: 'low', timeframe: null };
  }
  
  const playersInDip = teamSummary.playersInDip || 0;
  const playersInDangerousDip = allPlayers.filter(p => p.phase === 'dip' && p.line === 'Line2').length;
  const playersInBaseline = teamSummary.playersInBaseline || 0;
  
  let risk = 0;
  let confidence = 'low';
  let timeframe = null;
  
  // Risk factor 1: Current dip concentration
  const dipRate = teamSummary.playersWithData > 0 
    ? (playersInDip / teamSummary.playersWithData) * 100 
    : 0;
  
  if (dipRate >= 50) {
    risk += 40;
    confidence = 'high';
    timeframe = '1-2 sessions';
  } else if (dipRate >= 30) {
    risk += 25;
    confidence = 'medium';
    timeframe = '2-4 sessions';
  } else if (dipRate >= 20) {
    risk += 15;
    confidence = 'medium';
    timeframe = '3-5 sessions';
  }
  
  // Risk factor 2: Dangerous dip presence
  if (playersInDangerousDip >= 3) {
    risk += 30;
    confidence = 'high';
  } else if (playersInDangerousDip >= 2) {
    risk += 20;
    confidence = 'medium';
  }
  
  // Risk factor 3: Baseline players approaching dip (based on historical patterns)
  if (playersInBaseline >= teamSummary.playersWithData * 0.6) {
    // Many in baseline - check if they're approaching typical dip timing
    risk += 10;
    timeframe = timeframe || '4-6 sessions';
  }
  
  // Risk factor 4: Recent trend
  const sessions = teamAnalysis.sessions || [];
  if (sessions.length >= 3) {
    const recentTrend = sessions[sessions.length - 1].value - sessions[sessions.length - 3].value;
    if (recentTrend < -0.15) {
      risk += 20;
      confidence = 'high';
      timeframe = '1-2 sessions';
    } else if (recentTrend < -0.1) {
      risk += 10;
    }
  }
  
  risk = Math.min(100, risk);
  
  return {
    risk: Math.round(risk),
    confidence: confidence,
    timeframe: timeframe,
    level: risk >= 60 ? 'high' : (risk >= 30 ? 'medium' : 'low')
  };
}

/**
 * Calculate critical mass prediction (when players align for team boost)
 */
function _spiralCalculateCriticalMass_(teamAnalysis, allPlayers) {
  if (!teamAnalysis || allPlayers.length === 0) {
    return null;
  }
  
  // Predict when players in recovery will reach Line 4
  const playersInRecovery = allPlayers.filter(p => p.phase === 'recovery');
  const playersInBaseline = allPlayers.filter(p => p.phase === 'baseline');
  
  // Estimate recovery timing based on historical patterns
  // This is simplified - in reality would use individual player recovery patterns
  const estimatedRecoveries = [];
  
  playersInRecovery.forEach(player => {
    // Assume recovery happens in 1-3 sessions (simplified)
    estimatedRecoveries.push({
      playerName: player.playerName,
      estimatedSessions: 2, // Would calculate from player history
      willBeLine4: (player.line4Percentage || 0) > 50 // Higher Line 4 rate = more likely
    });
  });
  
  // Find sessions where 3+ players might align in Line 4
  const alignmentWindows = [];
  for (let i = 1; i <= 5; i++) {
    const playersReachingLine4 = estimatedRecoveries.filter(r => 
      r.estimatedSessions <= i && r.willBeLine4
    ).length;
    
    if (playersReachingLine4 >= 3) {
      alignmentWindows.push({
        sessions: i,
        players: playersReachingLine4,
        boost: 'high'
      });
    } else if (playersReachingLine4 >= 2) {
      alignmentWindows.push({
        sessions: i,
        players: playersReachingLine4,
        boost: 'medium'
      });
    }
  }
  
  return alignmentWindows.length > 0 ? alignmentWindows[0] : null;
}

/**
 * Calculate team stability forecast
 */
function _spiralCalculateTeamStability_(teamAnalysis, teamSummary) {
  if (!teamAnalysis || !teamSummary) {
    return { stability: 'unknown', forecast: null };
  }
  
  const sessions = teamAnalysis.sessions || [];
  const baselines = teamAnalysis.baselines || [];
  const currentPhase = teamAnalysis.currentPhase || {};
  
  // Calculate variance in recent sessions
  let variance = 0;
  if (sessions.length >= 5) {
    const recentValues = sessions.slice(-5).map(s => s.value);
    const avg = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
    const varianceSum = recentValues.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0);
    variance = varianceSum / recentValues.length;
  }
  
  // Determine stability
  let stability = 'volatile';
  let forecast = null;
  
  if (variance < 0.05) {
    stability = 'very_stable';
    forecast = { period: '5+ sessions', volatility: 'low' };
  } else if (variance < 0.1) {
    stability = 'stable';
    forecast = { period: '3-5 sessions', volatility: 'low' };
  } else if (variance < 0.2) {
    stability = 'moderate';
    forecast = { period: '2-3 sessions', volatility: 'medium' };
  } else {
    stability = 'volatile';
    forecast = { period: '1-2 sessions', volatility: 'high' };
  }
  
  // Adjust based on current phase
  if (currentPhase.phase === 'baseline' && baselines.length > 0) {
    const lastBaseline = baselines[baselines.length - 1];
    const baselineDuration = lastBaseline.endIndex - lastBaseline.startIndex + 1;
    if (baselineDuration >= 5) {
      stability = 'stable';
      forecast.period = '5+ sessions';
    }
  }
  
  return {
    stability: stability,
    forecast: forecast,
    variance: variance.toFixed(3)
  };
}

/**
 * Generate team trajectory predictions and alerts based on team spiral patterns
 * Enhanced with Phase 1 and Phase 2 predictions
 */
function _spiralGenerateTeamPredictions_(teamAnalysis, teamSummary, allPlayers) {
  const alerts = [];
  
  if (!teamAnalysis || !teamAnalysis.sessions || teamAnalysis.sessions.length < 5) {
    return {
      alerts: [],
      health: null,
      dipRisk: null,
      criticalMass: null,
      stability: null
    };
  }
  
  const sessions = teamAnalysis.sessions;
  const baselines = teamAnalysis.baselines || [];
  const dips = teamAnalysis.dips || [];
  const recoveries = teamAnalysis.recoveries || [];
  const cycles = teamAnalysis.cycles || [];
  const currentPhase = teamAnalysis.currentPhase || {};
  const spiralAnalysis = teamAnalysis.spiralAnalysis || {};
  
  const lastSession = sessions[sessions.length - 1];
  const recentTrend = sessions.length >= 3 
    ? (sessions[sessions.length - 1].value - sessions[sessions.length - 3].value) / 2
    : 0;
  
  // ===== TEAM ALERTS =====
  
  // ALERT 1: Multiple Players in Dangerous Dips
  const playersInDangerousDips = allPlayers.filter(p => {
    return p.phase === 'dip' && p.line === 'Line2';
  });
  
  if (playersInDangerousDips.length >= 3) {
    alerts.push({
      type: 'multiple_dangerous_dips',
      severity: 'high',
      message: `${playersInDangerousDips.length} players in dangerous dips`,
      details: `High number of players experiencing concerning performance drops. This may indicate systemic issues.`,
      affectedPlayers: playersInDangerousDips.map(p => p.playerName).slice(0, 5),
      recommendation: 'Review training load, external stressors, and team environment'
    });
  } else if (playersInDangerousDips.length >= 2) {
    alerts.push({
      type: 'multiple_dangerous_dips',
      severity: 'medium',
      message: `${playersInDangerousDips.length} players in dangerous dips`,
      details: `Multiple players showing concerning patterns. Monitor closely.`,
      affectedPlayers: playersInDangerousDips.map(p => p.playerName),
      recommendation: 'Check for common factors affecting these players'
    });
  }
  
  // ALERT 2: Team Decline Trend
  if (recentTrend < -0.15 && sessions.length >= 5) {
    alerts.push({
      type: 'team_decline',
      severity: 'high',
      message: 'Team showing significant decline trend',
      details: `Team average dropped ${Math.abs(recentTrend).toFixed(2)} points over recent sessions`,
      trend: recentTrend,
      recommendation: 'Immediate intervention recommended - review training approach and team dynamics'
    });
  } else if (recentTrend < -0.1) {
    alerts.push({
      type: 'team_decline',
      severity: 'medium',
      message: 'Team showing decline trend',
      details: `Team average declining - monitor closely`,
      trend: recentTrend,
      recommendation: 'Review recent changes and adjust training if needed'
    });
  }
  
  // ALERT 3: Low Spiral Rate
  if (teamSummary.averageLine4Percentage < 30 && teamSummary.playersWithData >= 5) {
    alerts.push({
      type: 'low_spiral_rate',
      severity: 'medium',
      message: 'Low team spiral development rate',
      details: `Only ${teamSummary.averageLine4Percentage}% of cycles are Line 4 (spiral). Most players returning to baseline without exceeding.`,
      currentRate: teamSummary.averageLine4Percentage,
      recommendation: 'Consider increasing challenge level and supporting deeper learning from dips'
    });
  }
  
  // ALERT 4: Too Many Players Stuck in Line 1 (Flat)
  if (teamSummary.line1Count >= teamSummary.playersWithData * 0.4 && teamSummary.playersWithData >= 5) {
    alerts.push({
      type: 'team_stagnation',
      severity: 'medium',
      message: `${teamSummary.line1Count} players stuck in flat pattern (Line 1)`,
      details: `${Math.round((teamSummary.line1Count / teamSummary.playersWithData) * 100)}% of team showing no measurable improvement`,
      recommendation: 'Introduce new challenges and vary training approach to break stagnation'
    });
  }
  
  // ALERT 5: Team in Dangerous Dip
  if (currentPhase.phase === 'dip') {
    const activeDip = dips.find(d => {
      return d.startIndex <= sessions.length - 1 && d.endIndex >= sessions.length - 1;
    });
    
    if (activeDip && activeDip.type === 'dangerous') {
      alerts.push({
        type: 'team_dangerous_dip',
        severity: 'high',
        message: 'Team currently in dangerous dip',
        details: `Team performance declining with concerning indicators. Immediate attention required.`,
        dipDepth: activeDip.depth ? activeDip.depth.toFixed(2) : 'unknown',
        recommendation: 'Review team environment, training load, and external stressors immediately'
      });
    }
  }
  
  // ALERT 6: High Concentration in Single Phase
  const phaseCounts = {
    baseline: teamSummary.playersInBaseline,
    dip: teamSummary.playersInDip,
    recovery: teamSummary.playersInRecovery
  };
  const maxPhase = Math.max(phaseCounts.baseline, phaseCounts.dip, phaseCounts.recovery);
  const maxPhaseName = Object.keys(phaseCounts).find(k => phaseCounts[k] === maxPhase);
  
  if (maxPhase >= teamSummary.playersWithData * 0.6 && teamSummary.playersWithData >= 5) {
    alerts.push({
      type: 'phase_concentration',
      severity: 'low',
      message: `${Math.round((maxPhase / teamSummary.playersWithData) * 100)}% of team in ${maxPhaseName} phase`,
      details: `Unusual concentration - may indicate team-wide pattern or training cycle`,
      phase: maxPhaseName,
      recommendation: maxPhaseName === 'dip' 
        ? 'Monitor closely - team-wide dip may require adjusted training'
        : 'Normal pattern - continue monitoring'
    });
  }
  
  // Calculate Phase 1 & Phase 2 predictions (with error handling)
  let health = null;
  let dipRisk = null;
  let criticalMass = null;
  let stability = null;
  
  try {
    health = _spiralCalculateTeamHealth_(teamAnalysis, teamSummary, allPlayers);
  } catch (e) {
    Logger.log('Error calculating team health: ' + String(e));
  }
  
  try {
    dipRisk = _spiralCalculateTeamDipRisk_(teamAnalysis, teamSummary, allPlayers);
  } catch (e) {
    Logger.log('Error calculating dip risk: ' + String(e));
  }
  
  try {
    criticalMass = _spiralCalculateCriticalMass_(teamAnalysis, allPlayers);
  } catch (e) {
    Logger.log('Error calculating critical mass: ' + String(e));
  }
  
  try {
    stability = _spiralCalculateTeamStability_(teamAnalysis, teamSummary);
  } catch (e) {
    Logger.log('Error calculating stability: ' + String(e));
  }
  
  return { 
    alerts: alerts,
    health: health,
    dipRisk: dipRisk,
    criticalMass: criticalMass,
    stability: stability
  };
}

/**
 * Generate predictions and coaching advice based on spiral patterns
 */
function _spiralGeneratePredictions_(sessions, baselines, dips, recoveries, cycles, currentPhase) {
  const predictions = [];
  const advice = [];
  const warnings = [];
  
  if (sessions.length < 5) {
    return {
      predictions: [{ type: 'insufficient_data', message: 'Need at least 5 sessions for predictions' }],
      advice: [],
      warnings: []
    };
  }
  
  const lastSession = sessions[sessions.length - 1];
  const lastBaseline = baselines.length > 0 ? baselines[baselines.length - 1] : null;
  const recentTrend = sessions.length >= 3 
    ? (sessions[sessions.length - 1].value - sessions[sessions.length - 3].value) / 2
    : 0;
  
  // PREDICTION 1: Next Phase Prediction
  if (currentPhase.phase === 'baseline') {
    // Predict if entering dip soon
    if (lastBaseline && sessions.length - 1 > lastBaseline.endIndex) {
      const baselineDuration = lastBaseline.endIndex - lastBaseline.startIndex + 1;
      const avgBaselineDuration = baselines.length > 1
        ? baselines.slice(0, -1).reduce((sum, b) => sum + (b.endIndex - b.startIndex + 1), 0) / (baselines.length - 1)
        : baselineDuration;
      
      if (sessions.length - 1 - lastBaseline.endIndex >= avgBaselineDuration * 0.8) {
        predictions.push({
          type: 'phase',
          prediction: 'Likely to enter dip soon',
          confidence: 'medium',
          reasoning: `Baseline duration (${baselineDuration} sessions) is approaching historical average (${Math.round(avgBaselineDuration)} sessions)`
        });
      }
    }
  } else if (currentPhase.phase === 'dip') {
    // Predict recovery timing
    const activeDip = dips.find(d => {
      return d.startIndex <= sessions.length - 1 && d.endIndex >= sessions.length - 1;
    });
    
    if (activeDip) {
      const dipDuration = sessions.length - 1 - activeDip.startIndex + 1;
      const avgDipDuration = dips.length > 1
        ? dips.slice(0, -1).reduce((sum, d) => sum + (d.endIndex - d.startIndex + 1), 0) / (dips.length - 1)
        : dipDuration;
      
      const expectedRecovery = activeDip.startIndex + Math.round(avgDipDuration);
      const sessionsUntilRecovery = Math.max(0, expectedRecovery - (sessions.length - 1));
      
      predictions.push({
        type: 'recovery_timing',
        prediction: `Recovery expected in ${sessionsUntilRecovery} session(s)`,
        confidence: sessionsUntilRecovery <= 2 ? 'high' : 'medium',
        reasoning: `Based on average dip duration of ${Math.round(avgDipDuration)} sessions`
      });
    }
  }
  
  // PREDICTION 2: Recovery Type (Line 3 vs Line 4)
  if (currentPhase.phase === 'dip' || currentPhase.phase === 'recovery') {
    const line4Rate = cycles.length > 0 
      ? cycles.filter(c => c.type === 'Line4').length / cycles.length
      : 0;
    
    const willExceedBaseline = line4Rate >= 0.5;
    
    predictions.push({
      type: 'recovery_type',
      prediction: willExceedBaseline ? 'Likely Line 4 (Spiral)' : 'Likely Line 3 (Return)',
      confidence: line4Rate >= 0.7 || line4Rate <= 0.3 ? 'high' : 'medium',
      reasoning: `${Math.round(line4Rate * 100)}% of past cycles were Line 4`,
      expectedImprovement: willExceedBaseline ? '+0.1 to +0.3' : '0.0 to +0.1'
    });
  }
  
  // PREDICTION 3: Next Baseline Level
  if (lastBaseline && cycles.length > 0) {
    const improvingCycles = cycles.filter(c => c.improvement && c.improvement > 0);
    if (improvingCycles.length > 0) {
      const avgImprovement = improvingCycles.reduce((sum, c) => sum + c.improvement, 0) / improvingCycles.length;
      const nextBaseline = lastBaseline.baselineValue + avgImprovement;
      
      predictions.push({
        type: 'next_baseline',
        prediction: `Next baseline likely: ${nextBaseline.toFixed(2)}`,
        confidence: improvingCycles.length >= 2 ? 'medium' : 'low',
        reasoning: `Based on average improvement of ${avgImprovement.toFixed(2)} per cycle`
      });
    }
  }
  
  // ADVICE 1: Current Phase Advice
  if (currentPhase.phase === 'dip') {
    const activeDip = dips.find(d => {
      return d.startIndex <= sessions.length - 1 && d.endIndex >= sessions.length - 1;
    });
    
    if (activeDip) {
      if (activeDip.type === 'productive') {
        advice.push({
          type: 'support',
          priority: 'medium',
          message: 'This is a productive dip - maintain patience and support learning',
          actions: [
            'Continue current training approach',
            'Provide positive reinforcement',
            'Focus on process over results',
            'Monitor for signs of recovery'
          ]
        });
      } else if (activeDip.type === 'dangerous') {
        advice.push({
          type: 'intervention',
          priority: 'high',
          message: 'Dangerous dip detected - intervention recommended',
          actions: [
            'Review recent changes in training or environment',
            'Check for external stressors',
            'Consider reducing training load',
            'Increase support and communication',
            'Monitor closely for recovery signs'
          ]
        });
        warnings.push({
          type: 'dangerous_dip',
          severity: 'high',
          message: 'Player in dangerous dip - performance declining with concerning indicators'
        });
      }
    }
  } else if (currentPhase.phase === 'recovery') {
    if (currentPhase.line === 'Line4') {
      advice.push({
        type: 'reinforce',
        priority: 'high',
        message: 'Player is spiraling upward - reinforce successful patterns',
        actions: [
          'Maintain current training approach',
          'Gradually increase challenge level',
          'Celebrate the improvement',
          'Document what worked'
        ]
      });
    } else if (currentPhase.line === 'Line3') {
      advice.push({
        type: 'adjust',
        priority: 'medium',
        message: 'Recovery returning to baseline - consider adjustments',
        actions: [
          'Review what caused the dip',
          'Identify learning gaps',
          'Adjust training to address root causes',
          'Set new challenges to push beyond baseline'
        ]
      });
    }
  } else if (currentPhase.phase === 'baseline') {
    if (currentPhase.line === 'Line1') {
      advice.push({
        type: 'challenge',
        priority: 'medium',
        message: 'Player in stable baseline - introduce new challenges',
        actions: [
          'Add new skills or concepts',
          'Increase difficulty gradually',
          'Set stretch goals',
          'Monitor for productive dip response'
        ]
      });
    }
  }
  
  // ADVICE 2: Pattern-Based Advice
  if (cycles.length >= 2) {
    const recentCycles = cycles.slice(-2);
    const allLine3 = recentCycles.every(c => c.type === 'Line3');
    const allLine4 = recentCycles.every(c => c.type === 'Line4');
    
    if (allLine3) {
      advice.push({
        type: 'pattern_warning',
        priority: 'high',
        message: 'Pattern alert: Recent cycles all returning to baseline (Line 3)',
        actions: [
          'Review training approach - may need more challenge',
          'Check if dips are deep enough to drive learning',
          'Consider longer recovery periods',
          'Evaluate if player is being pushed hard enough'
        ]
      });
    } else if (allLine4) {
      advice.push({
        type: 'pattern_success',
        priority: 'low',
        message: 'Excellent pattern: Consistent spiral development (Line 4)',
        actions: [
          'Continue current approach',
          'Maintain challenge level',
          'Document successful methods'
        ]
      });
    }
  }
  
  // WARNING: Stagnation Risk
  if (currentPhase.line === 'Line1' && sessions.length >= 10) {
    const recentAvg = sessions.slice(-5).reduce((sum, s) => sum + s.value, 0) / 5;
    const earlierAvg = sessions.slice(-10, -5).reduce((sum, s) => sum + s.value, 0) / 5;
    
    if (Math.abs(recentAvg - earlierAvg) < 0.1) {
      warnings.push({
        type: 'stagnation',
        severity: 'medium',
        message: 'Performance plateau detected - no improvement in last 10 sessions',
        suggestion: 'Introduce new challenges or adjust training approach'
      });
    }
  }
  
  return { predictions, advice, warnings };
}

/**
 * Main API function: Get spiral analysis for a player
 */
function getSpiralAnalysis(playerName) {
  try {
    if (!playerName || String(playerName).trim() === '') {
      return { ok: false, reason: 'No player name provided' };
    }
    
    const ss = _open();
    const logSh = ss.getSheetByName('Log');
    if (!logSh) {
      return { ok: false, reason: 'Log sheet not found' };
    }
    
    const tz = (ss.getSpreadsheetTimeZone && ss.getSpreadsheetTimeZone()) || Session.getScriptTimeZone();
    
    // Step 1: Get all ratings (sorted by date, not row position)
    const allRatings = _spiralGetAllRatingsFromLog_(logSh, playerName, tz);
    
    if (allRatings.length < 5) {
      return { ok: false, reason: 'Insufficient data (need at least 5 ratings)' };
    }
    
    // Step 2: Group by session and average (handles multiple coaches per session)
    const sessions = _spiralGroupRatingsBySession_(allRatings);
    
    if (sessions.length < 3) {
      return { ok: false, reason: 'Insufficient sessions (need at least 3 unique sessions)' };
    }
    
    // Step 3: Identify baselines
    const baselines = _spiralIdentifyBaselines_(sessions);
    
    // Step 4: Detect dips
    const dips = _spiralDetectDips_(sessions, baselines, sessions);
    
    // Step 4.5: Detect volatility periods (inconsistent performance)
    // Pass dips to exclude overlapping periods (dips take priority)
    const volatilityPeriods = _spiralDetectVolatilityPeriods_(sessions, baselines, sessions, dips);
    
    // Step 4.6: Detect flat periods (stable baselines with no improvement)
    const flatPeriods = _spiralDetectFlatPeriods_(sessions, baselines, dips, volatilityPeriods);
    
    // Step 5: Track recoveries
    const recoveries = _spiralTrackRecoveries_(sessions, baselines, dips);
    
    // Step 6: Identify cycles
    let cycles = _spiralIdentifyCycles_(sessions, baselines, dips, recoveries);
    
    // Step 7: Determine current phase (before analysis, so we can add current cycle if needed)
    const currentPhase = _spiralDetermineCurrentPhase_(sessions, baselines, dips, recoveries);
    
    // Step 7.5: Ensure the last cycle matches the current phase
    // This fixes the issue where cycles don't reflect the current player state
    const lastCycle = cycles.length > 0 ? cycles[cycles.length - 1] : null;
    const lastBaseline = baselines.length > 0 ? baselines[baselines.length - 1] : null;
    const lastSessionIndex = sessions.length - 1;
    
    // Update the last cycle to match current phase if needed
    if (currentPhase.phase === 'dip') {
      // Player is currently in a dip - last cycle should be Line2
      const activeDip = dips.find(d => d.startIndex <= lastSessionIndex && d.endIndex >= lastSessionIndex);
      if (activeDip && lastBaseline) {
        if (!lastCycle || lastCycle.type !== 'Line2' || !lastCycle.dip || lastCycle.dip.dipNumber !== activeDip.dipNumber) {
          // Update or replace last cycle to show current dip
          if (lastCycle && lastCycle.baseline && lastCycle.baseline.baselineNumber === lastBaseline.baselineNumber) {
            // Update existing cycle
            lastCycle.type = 'Line2';
            lastCycle.dip = activeDip;
            lastCycle.recovery = null;
            lastCycle.improvement = null;
            lastCycle.summary = `Baseline ${lastBaseline.baselineValue.toFixed(2)} → Dip to ${activeDip.lowestValue.toFixed(2)} (in progress) - Line 2`;
          } else {
            // Add new cycle for current dip
            cycles.push({
              cycleNumber: cycles.length + 1,
              type: 'Line2',
              baseline: lastBaseline,
              dip: activeDip,
              recovery: null,
              improvement: null,
              summary: `Baseline ${lastBaseline.baselineValue.toFixed(2)} → Dip to ${activeDip.lowestValue.toFixed(2)} (in progress) - Line 2`
            });
          }
        }
      }
    } else if (currentPhase.phase === 'recovery') {
      // Player is currently in recovery - last cycle should be Line3 or Line4
      const activeRecovery = recoveries.find(r => r.recoveryIndex >= lastSessionIndex - 1);
      if (activeRecovery && lastBaseline) {
        const cycleType = currentPhase.line === 'Line4' ? 'Line4' : 'Line3';
        if (!lastCycle || lastCycle.type !== cycleType || !lastCycle.recovery || lastCycle.recovery.recoveryNumber !== activeRecovery.recoveryNumber) {
          // Find the dip associated with this recovery
          const associatedDip = dips.find(d => d.baselineIndex === lastBaseline.baselineNumber - 1) || 
                                dips.find(d => d.endIndex < activeRecovery.recoveryIndex && d.startIndex <= activeRecovery.recoveryIndex - 3);
          
          if (lastCycle && lastCycle.type === 'Line2' && lastCycle.dip) {
            // Update existing Line2 cycle to Line3/Line4
            lastCycle.type = cycleType;
            lastCycle.recovery = activeRecovery;
            lastCycle.improvement = activeRecovery.improvement;
            lastCycle.summary = activeRecovery.exceedsBaseline
              ? `Baseline ${lastCycle.baseline.baselineValue.toFixed(2)} → Dip to ${lastCycle.dip.lowestValue.toFixed(2)} → Recovery to ${activeRecovery.recoveryValue.toFixed(2)} (in progress - Line 4 - Spiral)`
              : `Baseline ${lastCycle.baseline.baselineValue.toFixed(2)} → Dip to ${lastCycle.dip.lowestValue.toFixed(2)} → Recovery to ${activeRecovery.recoveryValue.toFixed(2)} (in progress - Line 3)`;
          } else if (lastCycle && lastCycle.baseline && lastCycle.baseline.baselineNumber === lastBaseline.baselineNumber) {
            // Update existing cycle
            lastCycle.type = cycleType;
            lastCycle.dip = associatedDip || lastCycle.dip;
            lastCycle.recovery = activeRecovery;
            lastCycle.improvement = activeRecovery.improvement;
            lastCycle.summary = activeRecovery.exceedsBaseline
              ? `Baseline ${lastBaseline.baselineValue.toFixed(2)} → Dip → Recovery to ${activeRecovery.recoveryValue.toFixed(2)} (in progress - Line 4 - Spiral)`
              : `Baseline ${lastBaseline.baselineValue.toFixed(2)} → Dip → Recovery to ${activeRecovery.recoveryValue.toFixed(2)} (in progress - Line 3)`;
          } else {
            // Add new cycle for current recovery
            cycles.push({
              cycleNumber: cycles.length + 1,
              type: cycleType,
              baseline: lastBaseline,
              dip: associatedDip || null,
              recovery: activeRecovery,
              improvement: activeRecovery.improvement,
              summary: activeRecovery.exceedsBaseline
                ? `Baseline ${lastBaseline.baselineValue.toFixed(2)} → Dip → Recovery to ${activeRecovery.recoveryValue.toFixed(2)} (in progress - Line 4 - Spiral)`
                : `Baseline ${lastBaseline.baselineValue.toFixed(2)} → Dip → Recovery to ${activeRecovery.recoveryValue.toFixed(2)} (in progress - Line 3)`
            });
          }
        }
      }
    } else if (currentPhase.phase === 'baseline' && lastBaseline) {
      // Player is currently in baseline - ensure last cycle reflects this if it's a new baseline
      if (!lastCycle || (lastCycle.baseline && lastCycle.baseline.baselineNumber !== lastBaseline.baselineNumber && lastCycle.type !== 'Line1')) {
        // Check if we need to add a Line1 cycle for the current baseline
        const isInCurrentBaseline = lastSessionIndex <= lastBaseline.endIndex;
        if (isInCurrentBaseline && (!lastCycle || lastCycle.baseline.baselineNumber !== lastBaseline.baselineNumber)) {
          // Add Line1 cycle for current baseline if not already present
          cycles.push({
            cycleNumber: cycles.length + 1,
            type: 'Line1',
            baseline: lastBaseline,
            dip: null,
            recovery: null,
            improvement: 0,
            summary: `Baseline ${lastBaseline.baselineValue.toFixed(2)} - No dip detected (Line 1 - Flat)`
          });
        }
      }
    }
    
    // Step 8: Analyze spiral progression (with comprehensive development score)
    const spiralAnalysis = _spiralAnalyzeProgression_(cycles, dips, volatilityPeriods, recoveries, sessions, baselines);
    
    // Step 8.5: Extract trait averages from Log sheet
    const traitAverages = _spiralExtractTraitAverages_(playerName, logSh, tz);
    
    // Step 9: Calculate player archetype (with error handling and trait data)
    let archetype = {
      primaryArchetype: 'unknown',
      developmentArchetype: 'moderateDeveloper',
      archetypeScore: 0,
      secondaryTraits: [],
      metrics: {},
      traitAnalysis: null,
      traitAverages: null
    };
    try {
      archetype = _spiralCalculateArchetype_(sessions, spiralAnalysis, dips, cycles, currentPhase, traitAverages);
    } catch (e) {
      Logger.log('Error calculating archetype for ' + playerName + ': ' + String(e));
    }
    
    // Step 10: Calculate trajectory for chart projection
    const trajectory = _spiralCalculateTrajectory_(sessions, baselines, dips, recoveries, cycles);
    
    // Format output
    return {
      ok: true,
      playerName: playerName,
      totalRatings: allRatings.length,
      totalSessions: sessions.length,
      currentPhase: currentPhase,
      trajectory: trajectory,
      // Include session data for charting
      sessions: sessions.map(s => ({
        date: s.dateISO,
        value: s.value,
        session: s.session
      })),
      baselines: baselines.map(b => ({
        baselineNumber: b.baselineNumber,
        value: b.baselineValue,
        sessions: b.sessions.length,
        period: b.period,
        startIndex: b.startIndex,
        endIndex: b.endIndex
      })),
      dips: dips.map(d => ({
        dipNumber: d.dipNumber,
        depth: d.depth,
        type: d.type,
        learningScore: d.learningScore,
        sessions: d.sessions.length,
        startIndex: d.startIndex,
        endIndex: d.endIndex,
        lowestValue: d.lowestValue,
        baselineValue: d.baselineValue,
        matchedLearningKeywords: d.matchedLearningKeywords || [],
        matchedConcernKeywords: d.matchedConcernKeywords || []
      })),
      volatilityPeriods: volatilityPeriods.map(v => ({
        periodNumber: v.periodNumber,
        type: v.type,
        learningScore: v.learningScore,
        sessions: v.sessions.length,
        startIndex: v.startIndex,
        endIndex: v.endIndex,
        mean: v.mean,
        stdDev: v.stdDev,
        cv: v.cv,
        minValue: v.minValue,
        maxValue: v.maxValue,
        range: v.range,
        isAlternating: v.isAlternating,
        signChanges: v.signChanges,
        matchedLearningKeywords: v.matchedLearningKeywords || [],
        matchedConcernKeywords: v.matchedConcernKeywords || []
      })),
      flatPeriods: flatPeriods.map(f => ({
        periodNumber: f.periodNumber,
        sessions: f.sessions.length,
        startIndex: f.startIndex,
        endIndex: f.endIndex,
        mean: f.mean,
        stdDev: f.stdDev,
        baselineValue: f.baselineValue,
        previousBaselineValue: f.previousBaselineValue,
        improvement: f.improvement
      })),
      recoveries: recoveries.map(r => ({
        recoveryNumber: r.recoveryNumber,
        recoveryValue: r.recoveryValue,
        previousBaselineValue: r.previousBaselineValue,
        exceedsBaseline: r.exceedsBaseline,
        improvement: r.improvement,
        recoveryIndex: r.recoveryIndex
      })),
      cycles: cycles.map(c => ({
        cycleNumber: c.cycleNumber,
        type: c.type,
        improvement: c.improvement,
        summary: c.summary
      })),
      spiralAnalysis: spiralAnalysis,
      archetype: archetype
    };
  } catch (e) {
    Logger.log('getSpiralAnalysis error: ' + String(e));
    return { ok: false, reason: 'Error: ' + String(e) };
  }
}

/**
 * Get competition logos and schedule mapping for predicted dots
 * Returns a mapping of dates (YYYY-MM-DD) to logo URLs
 */
function getCompetitionLogosForPredictions() {
  try {
    const ss = _open();
    const picsSh = _sheet(TAB_PICS);
    
    // Read logo URLs from pics sheet
    const fibaLogo = picsSh.getRange('B21').getValue();
    const hebaLogo = picsSh.getRange('B22').getValue();
    
    // Get schedule data - try getSchedule() first, then fallback to reading sheet directly
    let scheduleData = [];
    try {
      // Try to use getSchedule() if it exists (might be defined elsewhere)
      let games = [];
      try {
        if (typeof getSchedule === 'function') {
          const scheduleResult = getSchedule();
          if (scheduleResult && scheduleResult.ok && Array.isArray(scheduleResult.games)) {
            games = scheduleResult.games;
          }
        }
      } catch (e) {
        Logger.log('getSchedule() not available, reading sheet directly: ' + String(e));
      }
      
      // If getSchedule() didn't work, read from sheet directly
      if (games.length === 0) {
        const scheduleSh = ss.getSheetByName('Schedule');
        if (!scheduleSh) {
          // Try alternative names
          const altNames = ['schedule', 'Schedule', 'Opponents', 'opponents'];
          for (let i = 0; i < altNames.length; i++) {
            const altSh = ss.getSheetByName(altNames[i]);
            if (altSh) {
              const lastRow = altSh.getLastRow();
              if (lastRow > 1) {
                const data = altSh.getRange(2, 1, lastRow - 1, 10).getValues();
                const tz = _getTz_();
                
                data.forEach(row => {
                  const dateCell = row[0];
                  const competition = String(row[1] || '').trim();
                  const opponent = String(row[2] || '').trim(); // Opponent is typically in column 3
                  const status = String(row[3] || '').trim().toLowerCase(); // Status in column 4
                  
                  if (!dateCell || !competition) return;
                  
                  let dateISO = '';
                  if (dateCell instanceof Date) {
                    dateISO = Utilities.formatDate(dateCell, tz, 'yyyy-MM-dd');
                  } else if (typeof dateCell === 'string') {
                    const dateObj = new Date(dateCell);
                    if (!isNaN(dateObj.getTime())) {
                      dateISO = Utilities.formatDate(dateObj, tz, 'yyyy-MM-dd');
                    }
                  }
                  
                  if (dateISO && (status === 'upcoming' || status === '')) {
                    games.push({
                      date: dateISO,
                      competition: competition,
                      opponent: opponent,
                      status: status
                    });
                  }
                });
                break; // Found sheet, stop trying alternatives
              }
            }
          }
        } else {
          const lastRow = scheduleSh.getLastRow();
          if (lastRow > 1) {
            const data = scheduleSh.getRange(2, 1, lastRow - 1, 10).getValues();
            const tz = _getTz_();
            
            data.forEach(row => {
              const dateCell = row[0];
              const competition = String(row[1] || '').trim();
              const opponent = String(row[2] || '').trim(); // Opponent is typically in column 3
              const status = String(row[3] || '').trim().toLowerCase(); // Status in column 4
              
              if (!dateCell || !competition) return;
              
              let dateISO = '';
              if (dateCell instanceof Date) {
                dateISO = Utilities.formatDate(dateCell, tz, 'yyyy-MM-dd');
              } else if (typeof dateCell === 'string') {
                const dateObj = new Date(dateCell);
                if (!isNaN(dateObj.getTime())) {
                  dateISO = Utilities.formatDate(dateObj, tz, 'yyyy-MM-dd');
                }
              }
              
              if (dateISO && (status === 'upcoming' || status === '')) {
                games.push({
                  date: dateISO,
                  competition: competition,
                  opponent: opponent,
                  status: status
                });
              }
            });
          }
        }
      }
      
      // Process games to create schedule data with logos
      const tz = _getTz_();
      games.forEach(game => {
        let dateISO = '';
        if (game.date) {
          if (game.date instanceof Date) {
            dateISO = Utilities.formatDate(game.date, tz, 'yyyy-MM-dd');
          } else if (typeof game.date === 'string') {
            // Try parsing date string
            const dateObj = new Date(game.date);
            if (!isNaN(dateObj.getTime())) {
              dateISO = Utilities.formatDate(dateObj, tz, 'yyyy-MM-dd');
            } else {
              // Might already be in YYYY-MM-DD format
              if (/^\d{4}-\d{2}-\d{2}$/.test(game.date)) {
                dateISO = game.date;
              }
            }
          }
        } else if (game.ts) {
          // If timestamp is available
          const dateObj = new Date(game.ts);
          dateISO = Utilities.formatDate(dateObj, tz, 'yyyy-MM-dd');
        } else if (game.dateStr) {
          // If dateStr is available (from getSchedule())
          const dateObj = new Date(game.dateStr);
          if (!isNaN(dateObj.getTime())) {
            dateISO = Utilities.formatDate(dateObj, tz, 'yyyy-MM-dd');
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(game.dateStr)) {
            dateISO = game.dateStr;
          }
        }
        
        if (!dateISO) return;
        
        const competition = String(game.competition || '').trim();
        if (!competition) return;
        
        const opponent = String(game.opponent || '').trim();
        
        // Store competition name for text initials (no logo needed)
        // Check FIBA Europe Cup first (more specific), then Greek League
        const compLower = competition.toLowerCase();
        let isRelevant = false;
        // More specific checks first
        if (compLower.includes('fiba europe cup')) {
          isRelevant = true;
        } else if (compLower.includes('fiba') && !compLower.includes('heba')) {
          isRelevant = true;
        } else if (compLower.includes('greek heba a1') || compLower.includes('heba a1') || compLower.includes('heba')) {
          isRelevant = true;
        }
        
        if (isRelevant) {
          scheduleData.push({
            date: dateISO,
            competition: competition,
            opponent: opponent
          });
        }
      });
    } catch (e) {
      Logger.log('Error reading schedule: ' + String(e));
    }
    
    // Create date to competition mapping (for text initials)
    const dateToCompetition = {};
    scheduleData.forEach(item => {
      dateToCompetition[item.date] = {
        competition: item.competition,
        opponent: item.opponent
      };
    });
    
    return {
      ok: true,
      dateToCompetition: dateToCompetition
    };
  } catch (e) {
    Logger.log('getCompetitionLogosForPredictions error: ' + String(e));
    return { ok: false, error: String(e), dateToLogo: {} };
  }
}
