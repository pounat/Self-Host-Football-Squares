const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const db = new sqlite3.Database(process.env.DB_PATH || './squares.db');

const PORT = process.env.PORT || 3000;
const DEFAULT_HEADERS = JSON.stringify(['?', '?', '?', '?', '?', '?', '?', '?', '?', '?']);

// --- PROMISE HELPERS ---
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbExec = (sql) => new Promise((res, rej) => db.exec(sql, (e) => e ? rej(e) : res()));

// Wrap async route handlers so rejected promises become 500s instead of crashing.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => res.status(500).json({ error: e.message }));

// --- LIVE STREAM (Server-Sent Events) ---
// One long-lived connection per viewer, grouped by pool. Pushes board changes
// and chat messages instantly instead of polling. Plain HTTP, and a reverse
// proxy like Caddy streams text/event-stream straight through.
const streams = new Map(); // poolId -> Set<res>
function sseSend(res, event, data) {
    try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) { /* a dead connection is cleaned up by its own close handler */ }
}
function broadcast(poolId, event, data) {
    const set = streams.get(poolId);
    if (!set) return;
    for (const res of set) sseSend(res, event, data);
}
// "Something about this board changed, refetch it."
function bump(poolId) { broadcast(poolId, 'board', {}); }

// --- ID / TOKEN GENERATION ---
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function genId(len) {
    const bytes = crypto.randomBytes(len);
    let s = '';
    for (let i = 0; i < len; i++) s += ALPHA[bytes[i] % ALPHA.length];
    return s;
}
function genToken() {
    return crypto.randomBytes(18).toString('base64url');
}
async function uniquePoolId() {
    for (let i = 0; i < 6; i++) {
        const id = genId(7);
        const exists = await dbGet('SELECT 1 FROM pools WHERE id = ?', [id]);
        if (!exists) return id;
    }
    throw new Error('Could not generate a unique pool id');
}
function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}
function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

// --- MIGRATIONS (PRAGMA user_version) ---
async function migrate() {
    const { user_version } = await dbGet('PRAGMA user_version');

    if (user_version < 1) {
        await migrateToV1();
        await dbRun('PRAGMA user_version = 1');
    }
    if (user_version < 2) {
        await migrateToV2();
        await dbRun('PRAGMA user_version = 2');
    }
    if (user_version < 3) {
        await migrateToV3();
        await dbRun('PRAGMA user_version = 3');
    }
    if (user_version < 4) {
        await migrateToV4();
        await dbRun('PRAGMA user_version = 4');
    }
    if (user_version < 5) {
        await migrateToV5();
        await dbRun('PRAGMA user_version = 5');
    }
    if (user_version < 6) {
        await migrateToV6();
        await dbRun('PRAGMA user_version = 6');
    }
    if (user_version < 7) {
        await migrateToV7();
        await dbRun('PRAGMA user_version = 7');
    }
    if (user_version < 8) {
        await migrateToV8();
        await dbRun('PRAGMA user_version = 8');
    }
    if (user_version < 9) {
        await migrateToV9();
        await dbRun('PRAGMA user_version = 9');
    }
    if (user_version < 10) {
        await migrateToV10();
        await dbRun('PRAGMA user_version = 10');
    }
    if (user_version < 11) {
        await migrateToV11();
        await dbRun('PRAGMA user_version = 11');
    }
    if (user_version < 12) {
        await migrateToV12();
        await dbRun('PRAGMA user_version = 12');
    }
    if (user_version < 13) {
        await migrateToV13();
        await dbRun('PRAGMA user_version = 13');
    }
    if (user_version < 14) {
        await migrateToV14();
        await dbRun('PRAGMA user_version = 14');
    }
    if (user_version < 15) {
        await migrateToV15();
        await dbRun('PRAGMA user_version = 15');
    }
    if (user_version < 16) {
        await migrateToV16();
        await dbRun('PRAGMA user_version = 16');
    }
    if (user_version < 17) {
        await migrateToV17();
        await dbRun('PRAGMA user_version = 17');
    }
    if (user_version < 18) {
        await migrateToV18();
        await dbRun('PRAGMA user_version = 18');
    }
    if (user_version < 19) {
        await migrateToV19();
        await dbRun('PRAGMA user_version = 19');
    }
}

async function migrateToV1() {
    await dbExec(`
        CREATE TABLE IF NOT EXISTS pools (
            id TEXT PRIMARY KEY,
            admin_token TEXT NOT NULL,
            name TEXT,
            team_top TEXT,
            team_left TEXT,
            color_top TEXT,
            color_left TEXT,
            cost_per_square TEXT,
            venmo_url TEXT,
            locked INTEGER DEFAULT 0,
            number_mode TEXT DEFAULT 'once',
            top_headers TEXT,
            left_headers TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS scores (
            pool_id TEXT,
            period TEXT,
            top_score TEXT,
            left_score TEXT,
            UNIQUE(pool_id, period)
        );
    `);

    const cols = await dbAll('PRAGMA table_info(squares)');
    const squaresExists = cols.length > 0;
    const hasPoolId = cols.some((c) => c.name === 'pool_id');

    if (squaresExists && !hasPoolId) {
        // Legacy single-board DB: fold the existing game into one default pool.
        const metaRows = await dbAll('SELECT key, value FROM meta');
        const meta = {};
        metaRows.forEach((r) => { meta[r.key] = r.value; });

        const id = await uniquePoolId();
        const adminToken = genToken();

        await dbRun(
            `INSERT INTO pools (id, admin_token, name, team_top, team_left, color_top, color_left,
                cost_per_square, venmo_url, locked, number_mode, top_headers, left_headers)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'once', ?, ?)`,
            [
                id, adminToken, 'Super Bowl Squares',
                meta.team_top || 'Top', meta.team_left || 'Left',
                meta.color_top || '#333', meta.color_left || '#333',
                meta.cost_per_square || '0', null,
                meta.locked === 'true' ? 1 : 0,
                meta.top_headers || DEFAULT_HEADERS, meta.left_headers || DEFAULT_HEADERS,
            ]
        );

        for (const q of ['q1', 'q2', 'q3', 'final']) {
            await dbRun(
                'INSERT INTO scores (pool_id, period, top_score, left_score) VALUES (?, ?, ?, ?)',
                [id, q, meta[`score_${q}_top`] || '', meta[`score_${q}_left`] || '']
            );
        }

        await dbExec('ALTER TABLE squares RENAME TO squares_old');
        await dbExec(`
            CREATE TABLE squares (
                pool_id TEXT, row INTEGER, col INTEGER, name TEXT, is_paid INTEGER DEFAULT 0,
                UNIQUE(pool_id, row, col)
            );
        `);
        await dbRun(
            'INSERT INTO squares (pool_id, row, col, name, is_paid) SELECT ?, row, col, name, COALESCE(is_paid, 0) FROM squares_old',
            [id]
        );
        await dbExec('DROP TABLE squares_old');
        await dbExec('DROP TABLE IF EXISTS meta');

        console.log('--- Migrated existing board into a default pool ---');
        console.log(`    Public:  /p/${id}`);
        console.log(`    Admin:   /p/${id}/admin#${adminToken}`);
        console.log('    Save the admin link above. It is the only way back into admin.');
    } else if (!squaresExists) {
        // Fresh database.
        await dbExec(`
            CREATE TABLE squares (
                pool_id TEXT, row INTEGER, col INTEGER, name TEXT, is_paid INTEGER DEFAULT 0,
                UNIQUE(pool_id, row, col)
            );
        `);
    }
}

async function migrateToV2() {
    await dbExec(`
        CREATE TABLE IF NOT EXISTS site (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            password_hash TEXT,
            password_salt TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

async function migrateToV3() {
    const cols = await dbAll('PRAGMA table_info(squares)');
    if (!cols.some((c) => c.name === 'claimed_at')) {
        await dbExec('ALTER TABLE squares ADD COLUMN claimed_at TEXT');
    }
}

async function migrateToV4() {
    const cols = await dbAll('PRAGMA table_info(pools)');
    if (!cols.some((c) => c.name === 'payment_deadline')) {
        await dbExec('ALTER TABLE pools ADD COLUMN payment_deadline TEXT');
    }
}

async function migrateToV5() {
    const cols = await dbAll('PRAGMA table_info(pools)');
    const has = (n) => cols.some((c) => c.name === n);
    if (!has('color_top2')) await dbExec('ALTER TABLE pools ADD COLUMN color_top2 TEXT');
    if (!has('color_left2')) await dbExec('ALTER TABLE pools ADD COLUMN color_left2 TEXT');
    if (!has('espn_league')) await dbExec('ALTER TABLE pools ADD COLUMN espn_league TEXT');
    if (!has('espn_event_id')) await dbExec('ALTER TABLE pools ADD COLUMN espn_event_id TEXT');
    if (!has('score_source')) await dbExec("ALTER TABLE pools ADD COLUMN score_source TEXT DEFAULT 'manual'");
}

async function migrateToV6() {
    const cols = await dbAll('PRAGMA table_info(pools)');
    if (!cols.some((c) => c.name === 'espn_start')) await dbExec('ALTER TABLE pools ADD COLUMN espn_start TEXT');
}

async function migrateToV7() {
    await dbExec(`
        CREATE TABLE IF NOT EXISTS grid_numbers (
            pool_id TEXT, slot TEXT, top_headers TEXT, left_headers TEXT,
            UNIQUE(pool_id, slot)
        );
    `);
}

async function migrateToV8() {
    const cols = await dbAll('PRAGMA table_info(pools)');
    if (!cols.some((c) => c.name === 'live_state')) await dbExec('ALTER TABLE pools ADD COLUMN live_state TEXT');
}

async function migrateToV9() {
    const cols = await dbAll('PRAGMA table_info(pools)');
    if (!cols.some((c) => c.name === 'note')) await dbExec('ALTER TABLE pools ADD COLUMN note TEXT');
}

async function migrateToV10() {
    await dbExec(`
        CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id TEXT, text TEXT, at TEXT
        );
        CREATE TABLE IF NOT EXISTS annotations (
            pool_id TEXT, row INTEGER, col INTEGER, text TEXT, icon TEXT,
            UNIQUE(pool_id, row, col)
        );
    `);
}

async function migrateToV11() {
    const cols = await dbAll('PRAGMA table_info(pools)');
    if (!cols.some((c) => c.name === 'live_done')) await dbExec('ALTER TABLE pools ADD COLUMN live_done INTEGER DEFAULT 0');
}

async function migrateToV12() {
    await dbExec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id TEXT NOT NULL,
            sender TEXT,
            body TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0,
            created_at INTEGER
        );
    `);
    await dbExec('CREATE INDEX IF NOT EXISTS idx_messages_pool ON messages(pool_id, id)');
}

async function migrateToV13() {
    await dbExec(`
        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at INTEGER
        );
    `);
    await dbExec('CREATE INDEX IF NOT EXISTS idx_announcements_pool ON announcements(pool_id, id)');
}

async function migrateToV14() {
    const cols = await dbAll('PRAGMA table_info(squares)');
    if (!cols.some((c) => c.name === 'nickname')) await dbExec('ALTER TABLE squares ADD COLUMN nickname TEXT');
}

async function migrateToV15() {
    const cols = await dbAll('PRAGMA table_info(pools)');
    if (!cols.some((c) => c.name === 'grid_cols')) await dbExec('ALTER TABLE pools ADD COLUMN grid_cols INTEGER DEFAULT 10');
    if (!cols.some((c) => c.name === 'grid_rows')) await dbExec('ALTER TABLE pools ADD COLUMN grid_rows INTEGER DEFAULT 10');
}

// Sticky notes replaced the one-time announcement popups and the single board note.
// Carry any existing single note into the notes list so it is not lost.
async function migrateToV16() {
    const pools = await dbAll("SELECT id, note FROM pools WHERE note IS NOT NULL AND TRIM(note) != ''");
    for (const p of pools) {
        await dbRun('INSERT INTO announcements (pool_id, body, created_at) VALUES (?, ?, ?)', [p.id, p.note, Date.now()]);
    }
}

async function migrateToV17() {
    const cols = await dbAll('PRAGMA table_info(pools)');
    if (!cols.some((c) => c.name === 'logo_top')) await dbExec('ALTER TABLE pools ADD COLUMN logo_top TEXT');
    if (!cols.some((c) => c.name === 'logo_left')) await dbExec('ALTER TABLE pools ADD COLUMN logo_left TEXT');
}

async function migrateToV18() {
    const cols = await dbAll('PRAGMA table_info(pools)');
    if (!cols.some((c) => c.name === 'numbers_drawn_at')) await dbExec('ALTER TABLE pools ADD COLUMN numbers_drawn_at INTEGER');
}

// Soccer "goal-minute" boards: a scoring format flag on the pool, plus a table of
// goals (each carries the minute it was scored and which number set it locked against).
async function migrateToV19() {
    const cols = await dbAll('PRAGMA table_info(pools)');
    if (!cols.some((c) => c.name === 'scoring')) await dbExec("ALTER TABLE pools ADD COLUMN scoring TEXT DEFAULT 'digits'");
    await dbExec(`
        CREATE TABLE IF NOT EXISTS goals (
            pool_id TEXT, idx INTEGER, minute INTEGER, label TEXT, team_side TEXT, slot TEXT,
            UNIQUE(pool_id, idx)
        );
    `);
}

async function logActivity(poolId, text) {
    try {
        await dbRun('INSERT INTO activity (pool_id, text, at) VALUES (?, ?, ?)', [poolId, text, new Date().toISOString()]);
    } catch (e) { /* logging must never block the action */ }
}

// --- VALIDATION ---
const isDigit = (n) => Number.isInteger(n) && n >= 0 && n <= 9;
function cleanName(name) {
    if (typeof name !== 'string') return null;
    const t = name.trim();
    if (!t || t.length > 40) return null;
    return t;
}

const lastDigit = (v) => {
    const n = parseInt(String(v).slice(-1), 10);
    return Number.isNaN(n) ? null : n;
};

// Winner per completed period, including the house "rollover" rule: if the exact
// score square is empty, the winner is the next filled square reading
// left-to-right, top-to-bottom (wrapping). Kept generic so board size and
// per-period number sets can slot in later.
function computeWinners(squares, scores, mode, slotsMap, cols, rows) {
    cols = cols || 10;
    rows = rows || 10;
    const winners = {};
    for (const q of ['q1', 'q2', 'q3', 'final']) {
        const s = scores[q];
        if (!s || s.top === '' || s.left === '') continue;
        const dTop = lastDigit(s.top);
        const dLeft = lastDigit(s.left);
        if (dTop === null || dLeft === null) continue;

        const hdr = slotsMap[slotFor(mode, q)];
        if (!hdr) continue; // this period's numbers have not been drawn yet
        const topHeaders = hdr.top;
        const leftHeaders = hdr.left;
        const c = slotIndexOf(topHeaders, dTop);
        const r = slotIndexOf(leftHeaders, dLeft);
        if (c === -1 || r === -1) continue;

        let searchR = r;
        let searchC = c;
        let winner = null;
        for (let i = 0; i < cols * rows; i++) {
            const found = squares.find((sq) => sq.row === searchR && sq.col === searchC);
            if (found) { winner = { r: searchR, c: searchC, name: found.nickname || found.name }; break; }
            searchC++;
            if (searchC >= cols) { searchC = 0; searchR++; if (searchR >= rows) searchR = 0; }
        }
        winners[q] = {
            target: { r, c },
            winner,
            rolledOver: !!(winner && (winner.r !== r || winner.c !== c)),
            scores: { top: s.top, left: s.left },
        };
    }
    return winners;
}

// --- GOAL-MINUTE (soccer) scoring ---
// The two axes are the tens and ones digits of the minute a goal is scored, not
// team scores. A goal at 63' pays the square at (tens 6, ones 3). Added time keeps
// its real minute, capped at 99: 90+9 -> 99, 45+2 -> 47.
function gmFindWinner(squares, r, c, cols, rows) {
    let sr = r, sc = c;
    for (let i = 0; i < cols * rows; i++) {
        const f = squares.find((s) => s.row === sr && s.col === sc);
        if (f) return { r: sr, c: sc, name: f.nickname || f.name, rolledOver: (sr !== r || sc !== c) };
        sc++; if (sc >= cols) { sc = 0; sr++; if (sr >= rows) sr = 0; }
    }
    return null;
}
// Resolve one minute to its target square and rolled-over winner. Top axis = ones
// digit, left axis = tens digit. Handles single-digit and grouped (small-board) headers.
function minuteToWinner(squares, minute, hdr, cols, rows) {
    if (!hdr || minute == null) return { target: null, winner: null, rolledOver: false };
    const tens = Math.floor(minute / 10), ones = minute % 10;
    const c = slotIndexOf(hdr.top, ones);
    const r = slotIndexOf(hdr.left, tens);
    if (c === -1 || r === -1) return { target: null, winner: null, rolledOver: false };
    const w = gmFindWinner(squares, r, c, cols, rows);
    return {
        target: { r, c },
        winner: w ? { r: w.r, c: w.c, name: w.name } : null,
        rolledOver: w ? w.rolledOver : false,
    };
}
function computeGoalMinuteWinners(squares, goals, slotsMap, cols, rows) {
    return goals.map((g) => {
        const hdr = slotsMap[g.slot] || slotsMap.all;
        const res = minuteToWinner(squares, g.minute, hdr, cols, rows);
        return { idx: g.idx, minute: g.minute, label: g.label, side: g.team_side, target: res.target, winner: res.winner, rolledOver: res.rolledOver };
    });
}

// --- ESPN (free public scoreboard API, no key) ---
const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const LEAGUES = {
    nfl: { path: 'football/nfl', label: 'NFL' },
    ncaaf: { path: 'football/college-football', label: 'College Football' },
    nba: { path: 'basketball/nba', label: 'NBA' },
    wnba: { path: 'basketball/wnba', label: 'WNBA' },
    ncaab: { path: 'basketball/mens-college-basketball', label: 'College Basketball' },
    wc: { path: 'soccer/fifa.world', label: 'World Cup', soccer: true },
    wwc: { path: 'soccer/fifa.wwc', label: "Women's World Cup", soccer: true },
    ucl: { path: 'soccer/uefa.champions', label: 'Champions League', soccer: true },
    epl: { path: 'soccer/eng.1', label: 'Premier League', soccer: true },
    mls: { path: 'soccer/usa.1', label: 'MLS', soccer: true },
};
const isSoccerLeague = (league) => !!(LEAGUES[league] && LEAGUES[league].soccer);

async function espnFetch(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('ESPN responded ' + res.status);
    return res.json();
}

function parseCompetitor(c) {
    const t = c.team || {};
    return {
        id: t.id,
        name: t.displayName || t.name || t.shortDisplayName || 'Team',
        abbrev: t.abbreviation || '',
        color: t.color ? '#' + t.color : '',
        altColor: t.alternateColor ? '#' + t.alternateColor : '',
        score: c.score != null ? String(c.score) : '0',
        linescores: Array.isArray(c.linescores) ? c.linescores.map((l) => Number(l.value) || 0) : [],
    };
}

function parseEvent(ev) {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const competitors = comp.competitors || [];
    const home = competitors.find((c) => c.homeAway === 'home') || competitors[0] || {};
    const away = competitors.find((c) => c.homeAway === 'away') || competitors[1] || {};
    const st = (comp.status || ev.status || {}).type || {};
    return {
        espnId: String(ev.id),
        name: ev.name || ev.shortName || '',
        date: ev.date || '',
        state: st.state || 'pre', // pre | in | post
        statusDetail: st.shortDetail || st.description || '',
        home: parseCompetitor(home),
        away: parseCompetitor(away),
    };
}

async function espnScoreboard(league, dates) {
    const lg = LEAGUES[league];
    if (!lg) throw new Error('Unknown league');
    let url = ESPN_BASE + '/' + lg.path + '/scoreboard';
    if (dates) url += '?dates=' + dates + '&limit=300';
    const data = await espnFetch(url);
    return (data.events || []).map(parseEvent);
}

const teamCache = {};
async function espnTeams(league) {
    if (teamCache[league]) return teamCache[league];
    const lg = LEAGUES[league];
    if (!lg) throw new Error('Unknown league');
    const data = await espnFetch(ESPN_BASE + '/' + lg.path + '/teams?limit=1000');
    const group = (((data.sports || [])[0] || {}).leagues || [])[0] || {};
    const teams = (group.teams || []).map((t) => ({
        id: t.team.id,
        name: t.team.displayName || t.team.name || '',
        abbrev: t.team.abbreviation || '',
        location: t.team.location || '',
        nick: t.team.name || '',
        color: t.team.color ? '#' + t.team.color : '',
        altColor: t.team.alternateColor ? '#' + t.team.alternateColor : '',
    }));
    teamCache[league] = teams;
    return teams;
}

function matchTeam(teams, term) {
    const q = term.toLowerCase();
    return teams.find((t) => t.abbrev.toLowerCase() === q)
        || teams.find((t) => (t.name || '').toLowerCase().startsWith(q))
        || teams.find((t) => (t.location || '').toLowerCase().startsWith(q) || (t.nick || '').toLowerCase().startsWith(q))
        || teams.find((t) => (t.name || '').toLowerCase().includes(q));
}

function parseScheduleGame(ev) {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const st = (comp.status && comp.status.type) || {};
    return {
        espnId: String(ev.id),
        label: ev.shortName || ev.name || '',
        date: ev.date || comp.date || '',
        status: st.shortDetail || st.description || '',
        state: st.state || 'pre',
    };
}

async function espnSchedule(league, teamId) {
    const lg = LEAGUES[league];
    if (!lg) throw new Error('Unknown league');
    const url = ESPN_BASE + '/' + lg.path + '/teams/' + encodeURIComponent(teamId) + '/schedule';
    let data = await espnFetch(url);
    let events = data.events || [];
    // In the offseason the default schedule can come back empty (esp. college);
    // fall back to the regular season so a team search still returns games.
    if (!events.length) {
        try { data = await espnFetch(url + '?seasontype=2'); events = data.events || []; } catch (e) { /* keep empty */ }
    }
    return events.map(parseScheduleGame);
}

// "63'" -> 63 ; "90'+9'" -> 99. Regulation + stoppage summed, capped at 99.
function parseGoalMinute(clockDisp) {
    if (clockDisp == null) return null;
    const nums = String(clockDisp).replace(/[^0-9+]/g, '').split('+').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
    if (!nums.length) return null;
    return Math.max(0, Math.min(99, nums.reduce((a, b) => a + b, 0)));
}
// Pull scoring events (goals, penalties, own goals) with their minute, plus the
// full-time whistle minute, from an ESPN soccer summary's keyEvents feed.
function extractSoccerEvents(sum, home, away) {
    const events = Array.isArray(sum && sum.keyEvents) ? sum.keyEvents : [];
    const goals = [];
    let whistleMinute = null;
    for (const k of events) {
        const typeText = (k.type && k.type.text) || '';
        const clock = (k.clock && k.clock.displayValue) || '';
        if (/end regular time|full[\s-]?time|^ft$|match ends|end second half/i.test(typeText)) {
            const wm = parseGoalMinute(clock);
            if (wm != null) whistleMinute = wm;
        }
        if (/shootout/i.test(typeText)) continue; // a penalty shootout is not a match-minute event
        const scored = k.scoringPlay === true || /(^|\s)goal(\s|$)/i.test(typeText) || (/penalty/i.test(typeText) && /scored|goal/i.test(typeText));
        if (!scored || /missed|saved|no goal/i.test(typeText)) continue;
        const minute = parseGoalMinute(clock);
        if (minute == null) continue;
        const teamId = (k.team && k.team.id) || '';
        const isHome = home && home.id && String(teamId) === String(home.id);
        const side = isHome ? 'left' : 'top'; // home = left axis, away = top axis
        const scorer = (k.participants && k.participants[0] && k.participants[0].athlete && (k.participants[0].athlete.displayName || k.participants[0].athlete.shortName)) || '';
        const isOwn = /own goal/i.test(typeText);
        const isPen = /penalty/i.test(typeText);
        let label = scorer || (isOwn ? 'Own goal' : 'Goal');
        if (isOwn) label += ' (OG)'; else if (isPen) label += ' (pen)';
        goals.push({ minute, label, side });
    }
    goals.sort((a, b) => a.minute - b.minute);
    return { goals, whistleMinute };
}

function parseSummary(sum, espnId) {
    const comp = ((sum.header && sum.header.competitions) || [])[0] || {};
    const competitors = comp.competitors || [];
    const st = (comp.status && comp.status.type) || {};
    const mk = (c) => {
        const t = (c && c.team) || {};
        const logo = t.logo || ((Array.isArray(t.logos) && t.logos[0] && t.logos[0].href) || '');
        return {
            id: t.id,
            name: t.displayName || t.name || 'Team',
            abbrev: t.abbreviation || '',
            color: t.color ? '#' + t.color : '',
            altColor: t.alternateColor ? '#' + t.alternateColor : '',
            logo: logo,
            score: c && c.score != null ? String(c.score) : '0',
            linescores: c && Array.isArray(c.linescores) ? c.linescores.map((l) => Number(l.value != null ? l.value : l.displayValue) || 0) : [],
        };
    };
    const home = competitors.find((c) => c.homeAway === 'home') || competitors[0] || {};
    const away = competitors.find((c) => c.homeAway === 'away') || competitors[1] || {};
    const homeObj = mk(home), awayObj = mk(away);
    const soccer = extractSoccerEvents(sum, homeObj, awayObj);
    return {
        espnId: String(espnId),
        date: comp.date || '',
        state: st.state || 'pre',
        statusDetail: st.shortDetail || st.description || '',
        period: (comp.status && comp.status.period) || 0,
        clock: (comp.status && comp.status.displayClock) || '',
        home: homeObj,
        away: awayObj,
        goals: soccer.goals,
        whistleMinute: soccer.whistleMinute,
    };
}

async function espnSummary(league, espnId) {
    const lg = LEAGUES[league];
    if (!lg) throw new Error('Unknown league');
    const data = await espnFetch(ESPN_BASE + '/' + lg.path + '/summary?event=' + encodeURIComponent(espnId));
    return parseSummary(data, espnId);
}

// Shared game search: by team name (the team's schedule, scans ahead) or by date.
const espnSearch = ah(async (req, res) => {
    const league = req.query.league;
    if (!LEAGUES[league]) return res.status(400).json({ error: 'Unknown league' });
    const team = String(req.query.team || '').trim();
    const dates = String(req.query.date || '').replace(/[^0-9]/g, '') || undefined;
    try {
        let games;
        if (team) {
            const teams = await espnTeams(league);
            const t = matchTeam(teams, team);
            if (!t) return res.json({ games: [], note: 'No team matched "' + team + '"' });
            games = await espnSchedule(league, t.id);
        } else {
            games = (await espnScoreboard(league, dates)).map((g) => ({
                espnId: g.espnId,
                label: (g.away.abbrev || g.away.name) + ' @ ' + (g.home.abbrev || g.home.name),
                date: g.date, status: g.statusDetail, state: g.state,
            }));
        }
        res.json({ games });
    } catch (e) {
        res.status(502).json({ error: 'Could not reach ESPN: ' + e.message });
    }
});

// Pull a game's teams, colors, and scores onto a pool, and switch it to live.
async function linkGameToPool(poolId, league, espnId) {
    const g = await espnSummary(league, espnId);
    await dbRun(
        `UPDATE pools SET team_top = ?, color_top = ?, color_top2 = ?, logo_top = ?,
            team_left = ?, color_left = ?, color_left2 = ?, logo_left = ?,
            espn_league = ?, espn_event_id = ?, espn_start = ?, score_source = 'live', live_done = 0 WHERE id = ?`,
        [
            g.away.name, g.away.color || '#333', g.away.altColor || g.away.color || '#555', g.away.logo || null,
            g.home.name, g.home.color || '#333', g.home.altColor || g.home.color || '#555', g.home.logo || null,
            league, String(espnId), g.date || null, poolId,
        ]
    );
    const sc = (await dbGet('SELECT scoring FROM pools WHERE id = ?', [poolId]) || {}).scoring;
    await applyLiveScores(poolId, g, sc);
}

// Write a linked game's scores into the pool. Top axis = away team, left axis =
// home team. Scores are cumulative per period and only written once a period has
// a linescore (started/finished), so winners only show for periods that exist.
async function applyLiveScores(poolId, g, scoring) {
    if (scoring === 'goal_minute') return applyGoalMinuteLive(poolId, g);
    const away = g.away, home = g.home;
    const len = Math.min(away.linescores.length, home.linescores.length);
    const cum = (arr, n) => arr.slice(0, n).reduce((a, b) => a + b, 0);
    const finalState = g.state === 'post';
    // A period's payout score is written only once that period is COMPLETE (the
    // game moved on or finished), so the per-period winner does not flicker mid-quarter.
    const periods = {};
    if (len >= 1 && (g.period >= 2 || finalState)) periods.q1 = { top: String(cum(away.linescores, 1)), left: String(cum(home.linescores, 1)) };
    if (len >= 2 && (g.period >= 3 || finalState)) periods.q2 = { top: String(cum(away.linescores, 2)), left: String(cum(home.linescores, 2)) };
    if (len >= 3 && (g.period >= 4 || finalState)) periods.q3 = { top: String(cum(away.linescores, 3)), left: String(cum(home.linescores, 3)) };
    if (finalState) periods.final = { top: away.score, left: home.score };
    for (const q of Object.keys(periods)) {
        const s = periods[q];
        await dbRun(
            `INSERT INTO scores (pool_id, period, top_score, left_score) VALUES (?, ?, ?, ?)
             ON CONFLICT(pool_id, period) DO UPDATE SET top_score = excluded.top_score, left_score = excluded.left_score`,
            [poolId, q, s.top, s.left]
        );
    }
    // Current live state for the on-board scoreboard and the "currently winning" highlight.
    const live = JSON.stringify({ top: away.score, left: home.score, period: g.period, state: g.state, statusDetail: g.statusDetail });
    // Once a game is final, mark it done so the poll stops fetching it.
    await dbRun('UPDATE pools SET live_state = ?, live_done = ? WHERE id = ?', [live, finalState ? 1 : 0, poolId]);
}

// Goal-minute boards: append any newly-seen goals from the ESPN feed. In per_goal
// mode each new goal snapshots the current numbers as its own slot, then the board
// reshuffles for the next goal. Goals are matched by minute+scorer so a re-poll
// never double-counts one.
async function applyGoalMinuteLive(poolId, g) {
    const mode = await poolMode(poolId);
    const { cols, rows } = await poolDims(poolId);
    await drawNumbersIfNeeded(poolId); // ensure an initial set exists to lock goals against
    const existing = await dbAll('SELECT idx, minute, label FROM goals WHERE pool_id = ? ORDER BY idx', [poolId]);
    const seen = new Set(existing.map((r) => r.minute + '|' + r.label));
    let nextIdx = existing.reduce((m, r) => Math.max(m, r.idx), 0);
    for (const gl of (g.goals || [])) {
        const sig = gl.minute + '|' + gl.label;
        if (seen.has(sig)) continue;
        seen.add(sig);
        nextIdx += 1;
        const slot = await lockGoalSlot(poolId, mode, nextIdx, cols, rows);
        await dbRun(
            `INSERT INTO goals (pool_id, idx, minute, label, team_side, slot) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(pool_id, idx) DO UPDATE SET minute = excluded.minute, label = excluded.label, team_side = excluded.team_side, slot = excluded.slot`,
            [poolId, nextIdx, gl.minute, gl.label, gl.side, slot]
        );
    }
    const finalState = g.state === 'post';
    const whistle = (g.whistleMinute != null) ? g.whistleMinute : (finalState ? 90 : null);
    const live = JSON.stringify({ top: g.away.score, left: g.home.score, period: g.period, state: g.state, statusDetail: g.statusDetail, clock: g.clock || '', whistleMinute: whistle });
    await dbRun('UPDATE pools SET live_state = ?, live_done = ? WHERE id = ?', [live, finalState ? 1 : 0, poolId]);
}
// Decide which number set a goal locks against. 'once' -> the single 'all' set.
// 'per_goal' -> snapshot the live display as 'gN', then reshuffle the display for the next goal.
async function lockGoalSlot(poolId, mode, idx, cols, rows) {
    if (mode !== 'per_goal') return 'all';
    const slot = 'g' + idx;
    const pool = await dbGet('SELECT top_headers, left_headers FROM pools WHERE id = ?', [poolId]);
    await dbRun(
        `INSERT INTO grid_numbers (pool_id, slot, top_headers, left_headers) VALUES (?, ?, ?, ?)
         ON CONFLICT(pool_id, slot) DO UPDATE SET top_headers = excluded.top_headers, left_headers = excluded.left_headers`,
        [poolId, slot, pool.top_headers, pool.left_headers]
    );
    await dbRun('UPDATE pools SET top_headers = ?, left_headers = ?, numbers_drawn_at = ? WHERE id = ?',
        [JSON.stringify(drawAxis(cols)), JSON.stringify(drawAxis(rows)), Date.now(), poolId]);
    return slot;
}

async function pollLiveScores() {
    let pools;
    try {
        pools = await dbAll("SELECT id, espn_league, espn_event_id, number_mode, locked, espn_start, scoring FROM pools WHERE score_source = 'live' AND espn_event_id IS NOT NULL AND espn_league IS NOT NULL AND (live_done IS NULL OR live_done = 0)");
    } catch (e) { return; }
    if (!pools.length) return;
    // Fetch each distinct game from ESPN once per tick, then apply to every board using it.
    const now = Date.now();
    const cache = {};
    for (const p of pools) {
        if (!LEAGUES[p.espn_league]) continue;
        // Skip games more than 2 minutes from kickoff (no live data yet; auto-lock handles start).
        if (p.espn_start) { const t = new Date(p.espn_start).getTime(); if (!isNaN(t) && t > now + 120000) continue; }
        const key = p.espn_league + ':' + p.espn_event_id;
        try {
            if (!(key in cache)) cache[key] = await espnSummary(p.espn_league, p.espn_event_id);
            const g = cache[key];
            if (!g) continue;
            await applyLiveScores(p.id, g, p.scoring);
            const mode = p.number_mode || 'once';
            if (p.locked === 1 && mode !== 'once' && p.scoring !== 'goal_minute') await autoAdvanceForPeriod(p.id, mode, g.period);
            bump(p.id);
        } catch (e) { cache[key] = null; /* skip */ }
    }
}

// --- Locking + number drawing (with per-period rotation) ---
// per_goal is a soccer/goal-minute rotation: a fresh draw locks in behind each goal.
// Its slots are dynamic ('g1', 'g2', ...); 'g1' is the first set drawn when the board locks.
const SLOTS = { once: ['all'], per_quarter: ['q1', 'q2', 'q3', 'final'], per_half: ['h1', 'h2'], per_goal: ['g1'] };
function slotFor(mode, period) {
    if (mode === 'per_quarter') return period; // q1, q2, q3, final
    if (mode === 'per_half') return (period === 'q1' || period === 'q2') ? 'h1' : 'h2';
    return 'all';
}
// Grid types: a header axis has either 10 slots (one digit each) or 5 slots
// (two digits each). squares = cols * rows.
const GRID_TYPES = {
    std100: { cols: 10, rows: 10 },
    std50: { cols: 10, rows: 5 },
    std25: { cols: 5, rows: 5 },
};
function shuffleDigits() {
    const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
// Build one axis with `slotCount` headers. 10 slots: a single digit each.
// 5 slots: two digits each (stored as a 2-element array).
function drawAxis(slotCount) {
    const digits = shuffleDigits();
    const per = Math.max(1, Math.round(10 / slotCount));
    const slots = [];
    for (let i = 0; i < slotCount; i++) {
        const group = digits.slice(i * per, i * per + per);
        slots.push(group.length === 1 ? group[0] : group);
    }
    return slots;
}
function placeholderHeaders(slotCount) { return Array(Math.max(1, slotCount)).fill('?'); }
// Index of the slot whose digit(s) contain `digit`. Handles single-digit (number)
// and grouped (array) headers, and undrawn ('?') headers (returns -1).
function slotIndexOf(headers, digit) {
    for (let i = 0; i < headers.length; i++) {
        const el = headers[i];
        if (Array.isArray(el)) { if (el.includes(digit)) return i; }
        else if (el === digit) return i;
    }
    return -1;
}
async function poolDims(poolId) {
    const pool = await dbGet('SELECT grid_cols, grid_rows FROM pools WHERE id = ?', [poolId]);
    return { cols: (pool && pool.grid_cols) || 10, rows: (pool && pool.grid_rows) || 10 };
}
async function resetHeaders(poolId) {
    const { cols, rows } = await poolDims(poolId);
    await dbRun('UPDATE pools SET top_headers = ?, left_headers = ?, numbers_drawn_at = NULL WHERE id = ?',
        [JSON.stringify(placeholderHeaders(cols)), JSON.stringify(placeholderHeaders(rows)), poolId]);
}
// Draw (or re-draw) one slot's numbers and mirror them to the pool's current
// top/left headers, which are what the board displays.
async function setSlotNumbers(poolId, slot) {
    const { cols, rows } = await poolDims(poolId);
    const top = JSON.stringify(drawAxis(cols));
    const left = JSON.stringify(drawAxis(rows));
    await dbRun(
        `INSERT INTO grid_numbers (pool_id, slot, top_headers, left_headers) VALUES (?, ?, ?, ?)
         ON CONFLICT(pool_id, slot) DO UPDATE SET top_headers = excluded.top_headers, left_headers = excluded.left_headers`,
        [poolId, slot, top, left]
    );
    await dbRun('UPDATE pools SET top_headers = ?, left_headers = ?, numbers_drawn_at = ? WHERE id = ?', [top, left, Date.now(), poolId]);
}
async function drawnSlots(poolId) {
    const rows = await dbAll('SELECT slot FROM grid_numbers WHERE pool_id = ?', [poolId]);
    return new Set(rows.map((r) => r.slot));
}
async function currentSlot(poolId, mode) {
    const have = await drawnSlots(poolId);
    const order = SLOTS[mode] || SLOTS.once;
    let cur = null;
    for (const s of order) if (have.has(s)) cur = s;
    return cur;
}
async function nextSlot(poolId, mode) {
    const have = await drawnSlots(poolId);
    const order = SLOTS[mode] || SLOTS.once;
    for (const s of order) if (!have.has(s)) return s;
    return null;
}
async function numbersAreDrawn(poolId) {
    const pool = await dbGet('SELECT top_headers FROM pools WHERE id = ?', [poolId]);
    const top = JSON.parse((pool && pool.top_headers) || DEFAULT_HEADERS);
    return Array.isArray(top) && top.length > 0 && top.every((n) => typeof n === 'number' || Array.isArray(n));
}
async function poolMode(poolId) {
    const pool = await dbGet('SELECT number_mode FROM pools WHERE id = ?', [poolId]);
    return (pool && pool.number_mode) || 'once';
}
// Draw the first period's numbers if nothing has been drawn yet.
async function drawNumbersIfNeeded(poolId) {
    if (await numbersAreDrawn(poolId)) return;
    const mode = await poolMode(poolId);
    await setSlotNumbers(poolId, SLOTS[mode][0]);
}
// Lock a board and draw its numbers (only if not already drawn, so a re-lock or
// a second trigger leaves an already-numbered board untouched).
async function lockPoolAndDraw(poolId) {
    await dbRun('UPDATE pools SET locked = 1 WHERE id = ?', [poolId]);
    await drawNumbersIfNeeded(poolId);
    bump(poolId);
}
async function maybeAutoLockFull(poolId) {
    const row = await dbGet('SELECT COUNT(*) AS c FROM squares WHERE pool_id = ?', [poolId]);
    const { cols, rows } = await poolDims(poolId);
    if (row && row.c >= cols * rows) await lockPoolAndDraw(poolId);
}
async function autoLockStartedGames() {
    let pools;
    try { pools = await dbAll("SELECT id, espn_start FROM pools WHERE locked = 0 AND espn_start IS NOT NULL"); }
    catch (e) { return; }
    const nowMs = Date.now();
    for (const p of pools) {
        const t = new Date(p.espn_start).getTime();
        if (!isNaN(t) && t <= nowMs) {
            try { await lockPoolAndDraw(p.id); } catch (e) { /* skip one pool */ }
        }
    }
}
// In a rotating mode, draw all period slots up to the live game's current period,
// and mirror the current slot to the board.
async function autoAdvanceForPeriod(poolId, mode, espnPeriod) {
    const order = SLOTS[mode];
    if (!order || order.length <= 1) return;
    let count;
    if (mode === 'per_quarter') count = Math.min(4, Math.max(1, espnPeriod || 1));
    else count = (espnPeriod >= 3) ? 2 : 1;
    const have = await drawnSlots(poolId);
    for (let i = 0; i < count; i++) {
        if (!have.has(order[i])) await setSlotNumbers(poolId, order[i]);
    }
    const cur = order[count - 1];
    const row = await dbGet('SELECT top_headers, left_headers FROM grid_numbers WHERE pool_id = ? AND slot = ?', [poolId, cur]);
    if (row) await dbRun('UPDATE pools SET top_headers = ?, left_headers = ? WHERE id = ?', [row.top_headers, row.left_headers, poolId]);
}
// Manual equivalent: once a period has a score entered, make sure the next
// period's numbers are drawn (only on a locked, rotating board).
async function advanceFromScores(poolId, mode) {
    if (!SLOTS[mode] || mode === 'once') return;
    const pool = await dbGet('SELECT locked FROM pools WHERE id = ?', [poolId]);
    if (!pool || pool.locked !== 1) return;
    const rows = await dbAll('SELECT period, top_score, left_score FROM scores WHERE pool_id = ?', [poolId]);
    const sc = {};
    rows.forEach((r) => { sc[r.period] = { top: r.top_score || '', left: r.left_score || '' }; });
    let scored = 0;
    for (const p of ['q1', 'q2', 'q3', 'final']) {
        const s = sc[p];
        if (s && s.top !== '' && s.left !== '') scored++;
        else break;
    }
    const order = SLOTS[mode];
    const slotCount = (mode === 'per_quarter') ? Math.min(order.length, scored + 1) : (scored >= 2 ? 2 : 1);
    const have = await drawnSlots(poolId);
    for (let i = 0; i < slotCount; i++) {
        if (!have.has(order[i])) await setSlotNumbers(poolId, order[i]);
    }
    const cur = order[Math.min(slotCount, order.length) - 1];
    const row = await dbGet('SELECT top_headers, left_headers FROM grid_numbers WHERE pool_id = ? AND slot = ?', [poolId, cur]);
    if (row) await dbRun('UPDATE pools SET top_headers = ?, left_headers = ? WHERE id = ?', [row.top_headers, row.left_headers, poolId]);
}

app.use(bodyParser.json());
app.use(express.static('public', { index: false }));

// --- PAGES ---
function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
// Inject per-board link-preview tags so a shared link shows the board name and a card image.
app.get('/p/:id', ah(async (req, res) => {
    let playerHtml;
    try { playerHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'); }
    catch (e) { return res.sendFile(path.join(__dirname, 'public', 'index.html')); }
    const pool = await dbGet('SELECT name, team_top, team_left, cost_per_square FROM pools WHERE id = ?', [req.params.id]);
    const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
    const base = proto + '://' + (req.get('host') || ('localhost:' + PORT));
    const name = (pool && pool.name) ? pool.name : 'Squares';
    const parts = [];
    if (pool && pool.team_top && pool.team_left && pool.team_top !== 'Top' && pool.team_left !== 'Left') parts.push(pool.team_top + ' vs ' + pool.team_left);
    if (pool && pool.cost_per_square) parts.push('$' + pool.cost_per_square + ' per square');
    parts.push('Tap a square to claim it.');
    const desc = parts.join(' · ');
    const og = [
        '<meta property="og:title" content="' + escapeAttr(name) + '">',
        '<meta property="og:description" content="' + escapeAttr(desc) + '">',
        '<meta property="og:image" content="' + base + '/og.png">',
        '<meta property="og:type" content="website">',
        '<meta property="og:url" content="' + base + '/p/' + escapeAttr(req.params.id) + '">',
        '<meta name="twitter:card" content="summary_large_image">',
        '<meta name="twitter:title" content="' + escapeAttr(name) + '">',
        '<meta name="twitter:description" content="' + escapeAttr(desc) + '">',
        '<meta name="twitter:image" content="' + base + '/og.png">',
    ].join('\n    ');
    res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-cache').send(playerHtml.replace('<!--OG-->', og));
}));
app.get('/p/:id/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- POOL AUTH ---
const poolAdmin = ah(async (req, res, next) => {
    const token = req.get('X-Admin-Token');
    const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    if (!token || !safeEqual(token, pool.admin_token)) return res.status(401).json({ error: 'Unauthorized' });
    req.pool = pool;
    next();
});

// --- SITE OWNER: setup, login, sessions ---
async function createSession() {
    const token = genToken();
    await dbRun('INSERT INTO sessions (token) VALUES (?)', [token]);
    return token;
}
const ownerAuth = ah(async (req, res, next) => {
    const token = req.get('X-Owner-Token');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const row = await dbGet('SELECT token FROM sessions WHERE token = ?', [token]);
    if (!row) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

app.get('/api/site', ah(async (req, res) => {
    const site = await dbGet('SELECT password_hash FROM site WHERE id = 1');
    res.json({ setup: !!(site && site.password_hash) });
}));

app.post('/api/site/setup', ah(async (req, res) => {
    const password = String(req.body.password || '');
    if (password.length < 4) return res.status(400).json({ error: 'Password too short (min 4 characters).' });
    const site = await dbGet('SELECT password_hash FROM site WHERE id = 1');
    if (site && site.password_hash) return res.status(403).json({ error: 'Already set up.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    await dbRun(
        `INSERT INTO site (id, password_hash, password_salt) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, password_salt = excluded.password_salt`,
        [hash, salt]
    );
    res.json({ token: await createSession() });
}));

app.post('/api/site/login', ah(async (req, res) => {
    const password = String(req.body.password || '');
    const site = await dbGet('SELECT password_hash, password_salt FROM site WHERE id = 1');
    if (!site || !site.password_hash) return res.status(400).json({ error: 'Not set up yet.' });
    if (!safeEqual(hashPassword(password, site.password_salt), site.password_hash)) {
        return res.status(401).json({ error: 'Wrong password.' });
    }
    res.json({ token: await createSession() });
}));

app.post('/api/site/logout', ownerAuth, ah(async (req, res) => {
    await dbRun('DELETE FROM sessions WHERE token = ?', [req.get('X-Owner-Token')]);
    res.json({ success: true });
}));

app.get('/api/owner/session', ownerAuth, (req, res) => res.json({ ok: true }));

// --- OWNER: manage all pools ---
app.get('/api/owner/pools', ownerAuth, ah(async (req, res) => {
    const pools = await dbAll(`
        SELECT p.id, p.name, p.admin_token, p.locked, p.created_at, p.grid_cols, p.grid_rows,
               (SELECT COUNT(*) FROM squares s WHERE s.pool_id = p.id) AS filled
        FROM pools p ORDER BY p.created_at DESC
    `);
    res.json({
        pools: pools.map((p) => ({
            id: p.id, name: p.name, locked: p.locked === 1, created: p.created_at, filled: p.filled,
            total: ((p.grid_cols || 10) * (p.grid_rows || 10)),
            shareUrl: `/p/${p.id}`, adminUrl: `/p/${p.id}/admin#${p.admin_token}`,
        })),
    });
}));

app.get('/api/owner/espn', ownerAuth, espnSearch);

// Look up a team's two colors by name, for the manual create path.
app.get('/api/owner/team-colors', ownerAuth, ah(async (req, res) => {
    const league = req.query.league;
    const term = String(req.query.team || '').trim();
    if (!LEAGUES[league] || !term) return res.json({ team: null });
    try {
        const teams = await espnTeams(league);
        const t = matchTeam(teams, term);
        if (!t) return res.json({ team: null });
        res.json({ team: { name: t.name, color: t.color || '', color2: t.altColor || t.color || '' } });
    } catch (e) { res.json({ team: null }); }
}));

app.post('/api/owner/pools', ownerAuth, ah(async (req, res) => {
    const name = cleanName(req.body.name) || 'Squares Pool';
    const id = await uniquePoolId();
    const adminToken = genToken();
    const gt = GRID_TYPES[req.body.gridType] || GRID_TYPES.std100;
    const scoring = req.body.scoring === 'goal_minute' ? 'goal_minute' : 'digits';
    const validModes = scoring === 'goal_minute' ? ['once', 'per_goal'] : ['once', 'per_quarter', 'per_half'];
    const mode = validModes.includes(req.body.numberMode) ? req.body.numberMode : 'once';
    const topPlaceholder = JSON.stringify(placeholderHeaders(gt.cols));
    const leftPlaceholder = JSON.stringify(placeholderHeaders(gt.rows));
    await dbRun(
        `INSERT INTO pools (id, admin_token, name, team_top, team_left, color_top, color_left, color_top2, color_left2,
            cost_per_square, venmo_url, locked, number_mode, grid_cols, grid_rows, scoring, top_headers, left_headers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        [
            id, adminToken, name,
            (req.body.teamTop || 'Top').slice(0, 30), (req.body.teamLeft || 'Left').slice(0, 30),
            req.body.colorTop || '#002244', req.body.colorLeft || '#4b92db',
            req.body.colorTop2 || null, req.body.colorLeft2 || null,
            String(req.body.cost ?? '0'), req.body.venmoUrl || null,
            mode, gt.cols, gt.rows, scoring,
            topPlaceholder, leftPlaceholder,
        ]
    );
    if (req.body.game && LEAGUES[req.body.game.league] && req.body.game.espnId) {
        try { await linkGameToPool(id, req.body.game.league, req.body.game.espnId); } catch (e) { /* ignore link failure */ }
    }
    res.json({ id, adminToken, shareUrl: `/p/${id}`, adminUrl: `/p/${id}/admin#${adminToken}` });
}));

app.delete('/api/owner/pools/:id', ownerAuth, ah(async (req, res) => {
    await dbRun('DELETE FROM squares WHERE pool_id = ?', [req.params.id]);
    await dbRun('DELETE FROM scores WHERE pool_id = ?', [req.params.id]);
    await dbRun('DELETE FROM pools WHERE id = ?', [req.params.id]);
    res.json({ success: true });
}));

// After any successful pool mutation, tell connected viewers the board changed
// so they refetch. Chat routes opt out (they push their own message events).
app.use('/api/pool', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const m = req.path.match(/^\/([^/]+)/);
    if (!m || req.path.includes('/messages') || req.path.includes('/announcements')) return next();
    const poolId = m[1];
    const origJson = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode < 400) { try { bump(poolId); } catch (e) { /* never block the response */ } }
        return origJson(body);
    };
    next();
});

// --- LIVE STREAM + CHAT ---
app.get('/api/pool/:id/stream', ah(async (req, res) => {
    const pool = await dbGet('SELECT id FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).end();
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');
    let set = streams.get(req.params.id);
    if (!set) { set = new Set(); streams.set(req.params.id, set); }
    set.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* close handler cleans up */ } }, 20000);
    req.on('close', () => {
        clearInterval(ping);
        const s = streams.get(req.params.id);
        if (s) { s.delete(res); if (s.size === 0) streams.delete(req.params.id); }
    });
}));

app.get('/api/pool/:id/messages', ah(async (req, res) => {
    const pool = await dbGet('SELECT id FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    const rows = await dbAll('SELECT id, sender, body, is_admin, created_at FROM messages WHERE pool_id = ? ORDER BY id DESC LIMIT 200', [req.params.id]);
    rows.reverse();
    res.json({ messages: rows });
}));

app.post('/api/pool/:id/messages', ah(async (req, res) => {
    const pool = await dbGet('SELECT id FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    const sender = (String(req.body.sender || '').trim().slice(0, 40)) || 'Guest';
    const body = String(req.body.body || '').trim().slice(0, 500);
    if (!body) return res.status(400).json({ error: 'Message is empty' });
    const created_at = Date.now();
    const r = await dbRun('INSERT INTO messages (pool_id, sender, body, is_admin, created_at) VALUES (?, ?, ?, 0, ?)', [req.params.id, sender, body, created_at]);
    const msg = { id: r.lastID, sender, body, is_admin: 0, created_at };
    broadcast(req.params.id, 'chat', msg);
    res.json({ message: msg });
}));

// Organizer announcements: broadcast notices that pop up once on the player board.
app.get('/api/pool/:id/announcements', ah(async (req, res) => {
    const pool = await dbGet('SELECT id FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    const rows = await dbAll('SELECT id, body, created_at FROM announcements WHERE pool_id = ? ORDER BY id DESC LIMIT 100', [req.params.id]);
    res.json({ announcements: rows });
}));

// --- PUBLIC BOARD STATE ---
app.get('/api/pool/:id', ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });

    const squares = await dbAll('SELECT row, col, name, nickname, is_paid, claimed_at FROM squares WHERE pool_id = ?', [req.params.id]);
    const scoreRows = await dbAll('SELECT period, top_score, left_score FROM scores WHERE pool_id = ?', [req.params.id]);
    const annRows = await dbAll('SELECT row, col, text, icon FROM annotations WHERE pool_id = ?', [req.params.id]);
    const annotations = {};
    annRows.forEach((a) => { annotations[a.row + ',' + a.col] = { text: a.text || '', icon: a.icon || '' }; });
    const noteRows = await dbAll('SELECT id, body, created_at FROM announcements WHERE pool_id = ? ORDER BY id', [req.params.id]);

    const scores = { q1: { top: '', left: '' }, q2: { top: '', left: '' }, q3: { top: '', left: '' }, final: { top: '', left: '' } };
    scoreRows.forEach((r) => { if (scores[r.period]) scores[r.period] = { top: r.top_score || '', left: r.left_score || '' }; });

    const topHeaders = JSON.parse(pool.top_headers || DEFAULT_HEADERS);
    const leftHeaders = JSON.parse(pool.left_headers || DEFAULT_HEADERS);
    const mode = pool.number_mode || 'once';
    const gnRows = await dbAll('SELECT slot, top_headers, left_headers FROM grid_numbers WHERE pool_id = ?', [pool.id]);
    const numberSets = {};
    gnRows.forEach((gr) => { numberSets[gr.slot] = { top: JSON.parse(gr.top_headers), left: JSON.parse(gr.left_headers) }; });
    const slotsMap = Object.assign({}, numberSets);
    if (!slotsMap.all) slotsMap.all = { top: topHeaders, left: leftHeaders };
    const gridCols = pool.grid_cols || 10;
    const gridRows = pool.grid_rows || 10;
    const scoring = pool.scoring || 'digits';
    const winners = computeWinners(squares, scores, mode, slotsMap, gridCols, gridRows);
    const slotOrder = SLOTS[mode] || SLOTS.once;
    let currentPeriod = null;
    for (const sl of slotOrder) if (slotsMap[sl]) currentPeriod = sl;

    let live = null;
    try { live = pool.live_state ? JSON.parse(pool.live_state) : null; } catch (e) { live = null; }
    // Live highlight: liveTarget is the exact square the score points to (current
    // period numbers); liveWinner is the rolled-over filled square that would win if
    // the period ended now. When the target is filled, the two are the same cell.
    let liveTarget = null, liveWinner = null;
    // Only highlight the "currently winning" square while the game is in progress.
    // Once it is final, the gold winner styling takes over and the white outline drops.
    if (scoring !== 'goal_minute' && live && live.state === 'in' && currentPeriod && slotsMap[currentPeriod]) {
        const dTop = lastDigit(String(live.top));
        const dLeft = lastDigit(String(live.left));
        const hdr = slotsMap[currentPeriod];
        const c0 = (dTop === null) ? -1 : slotIndexOf(hdr.top, dTop);
        const r0 = (dLeft === null) ? -1 : slotIndexOf(hdr.left, dLeft);
        if (c0 !== -1 && r0 !== -1) {
            liveTarget = { r: r0, c: c0 };
            let sr = r0, sc = c0;
            for (let i = 0; i < gridCols * gridRows; i++) {
                const f = squares.find((s) => s.row === sr && s.col === sc);
                if (f) { liveWinner = { r: sr, c: sc }; break; }
                sc++; if (sc >= gridCols) { sc = 0; sr++; if (sr >= gridRows) sr = 0; }
            }
        }
    }

    // Goal-minute boards: resolve each goal's winning square, the 0-0 whistle
    // fallback, and (while live) the square the current match minute points to.
    let goalMinute = null;
    if (scoring === 'goal_minute') {
        const goalRows = await dbAll('SELECT idx, minute, label, team_side, slot FROM goals WHERE pool_id = ? ORDER BY idx', [pool.id]);
        const goalWinners = computeGoalMinuteWinners(squares, goalRows, slotsMap, gridCols, gridRows);
        const whistleMinute = (live && live.whistleMinute != null) ? live.whistleMinute : null;
        const isFinal = !!(live && live.state === 'post');
        let whistle = null;
        if (isFinal && goalRows.length === 0 && whistleMinute != null) {
            const res0 = minuteToWinner(squares, whistleMinute, slotsMap.all, gridCols, gridRows);
            whistle = { minute: whistleMinute, target: res0.target, winner: res0.winner, rolledOver: res0.rolledOver };
        }
        goalMinute = { goals: goalWinners, whistle, whistleMinute, totalGoals: goalRows.length, isFinal };
        // Live "if a goal happened now" highlight from the current match clock.
        if (live && live.state === 'in') {
            const nowMin = parseGoalMinute(live.clock || live.statusDetail);
            if (nowMin != null) {
                const res1 = minuteToWinner(squares, nowMin, slotsMap.all, gridCols, gridRows);
                if (res1.target) { liveTarget = res1.target; if (res1.winner) liveWinner = { r: res1.winner.r, c: res1.winner.c }; }
            }
        }
    }

    res.json({
        scoring,
        goalMinute,
        poolId: pool.id,
        name: pool.name,
        squares,
        isLocked: pool.locked === 1,
        cols: gridCols,
        rows: gridRows,
        topHeaders,
        leftHeaders,
        winners,
        currentPeriod,
        numberSets,
        numbersDrawnAt: pool.numbers_drawn_at || null,
        annotations,
        notes: noteRows,
        live,
        liveTarget,
        liveWinner,
        teamTop: pool.team_top || 'Top',
        teamLeft: pool.team_left || 'Left',
        logoTop: pool.logo_top || '',
        logoLeft: pool.logo_left || '',
        colorTop: pool.color_top || '#333',
        colorLeft: pool.color_left || '#333',
        colorTop2: pool.color_top2 || '',
        colorLeft2: pool.color_left2 || '',
        espnLeague: pool.espn_league || '',
        espnEventId: pool.espn_event_id || '',
        espnStart: pool.espn_start || '',
        scoreSource: pool.score_source || 'manual',
        cost: pool.cost_per_square || '0',
        venmoUrl: pool.venmo_url || '',
        note: pool.note || '',
        paymentDeadline: pool.payment_deadline || '',
        numberMode: pool.number_mode || 'once',
        scores,
    });
}));

// --- CLAIMING ---
app.post('/api/pool/:id/claim', ah(async (req, res) => {
    const { row, col } = req.body;
    const name = cleanName(req.body.name);
    const nickname = cleanName(req.body.nickname) || name;
    if (!isDigit(row) || !isDigit(col) || !name) return res.status(400).json({ error: 'Invalid square or name.' });

    const pool = await dbGet('SELECT locked, grid_cols, grid_rows FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    if (pool.locked === 1) return res.status(403).json({ error: 'Game is locked!' });
    if (col >= (pool.grid_cols || 10) || row >= (pool.grid_rows || 10)) return res.status(400).json({ error: 'Square out of range.' });

    try {
        await dbRun('INSERT INTO squares (pool_id, row, col, name, nickname, claimed_at) VALUES (?, ?, ?, ?, ?, ?)', [req.params.id, row, col, name, nickname, new Date().toISOString()]);
    } catch (e) {
        return res.status(400).json({ error: 'Square taken.' });
    }
    await maybeAutoLockFull(req.params.id);
    res.json({ success: true });
}));

app.post('/api/pool/:id/claim-batch', ah(async (req, res) => {
    const name = cleanName(req.body.name);
    const nickname = cleanName(req.body.nickname) || name;
    const squares = Array.isArray(req.body.squares) ? req.body.squares : [];
    if (!name) return res.status(400).json({ error: 'Name required.' });
    if (!squares.length || !squares.every((s) => isDigit(s.r) && isDigit(s.c))) {
        return res.status(400).json({ error: 'Invalid squares.' });
    }

    const pool = await dbGet('SELECT locked, grid_cols, grid_rows FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    if (pool.locked === 1) return res.status(403).json({ error: 'Game is locked!' });
    const gc = pool.grid_cols || 10, gr = pool.grid_rows || 10;
    if (!squares.every((s) => s.c < gc && s.r < gr)) return res.status(400).json({ error: 'Square out of range.' });

    let claimed = 0;
    let errors = 0;
    await dbRun('BEGIN');
    try {
        for (const sq of squares) {
            try {
                await dbRun('INSERT INTO squares (pool_id, row, col, name, nickname, claimed_at) VALUES (?, ?, ?, ?, ?, ?)', [req.params.id, sq.r, sq.c, name, nickname, new Date().toISOString()]);
                claimed++;
            } catch (e) {
                errors++;
            }
        }
        await dbRun('COMMIT');
    } catch (e) {
        await dbRun('ROLLBACK');
        throw e;
    }
    await maybeAutoLockFull(req.params.id);
    if (claimed > 0) await logActivity(req.params.id, `${name} claimed ${claimed} square${claimed !== 1 ? 's' : ''}`);
    res.json({ success: true, claimed, errors });
}));

// --- ADMIN ---
app.get('/api/pool/:id/admin/check', poolAdmin, (req, res) => res.json({ ok: true }));

app.post('/api/pool/:id/admin/lock', poolAdmin, ah(async (req, res) => {
    if (req.body.locked) await lockPoolAndDraw(req.params.id);
    else await dbRun('UPDATE pools SET locked = 0 WHERE id = ?', [req.params.id]);
    await logActivity(req.params.id, req.body.locked ? 'Locked the board' : 'Unlocked the board');
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/toggle-pay', poolAdmin, ah(async (req, res) => {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Name required.' });
    // Decide from the whole set, not one arbitrary square: if everything is already
    // paid, unmark all; otherwise (none or only some paid) mark all paid. This way a
    // person who pays, then claims more squares, gets marked fully paid in one click.
    const stats = await dbGet('SELECT COUNT(*) AS total, SUM(is_paid) AS paid FROM squares WHERE pool_id = ? AND name = ?', [req.params.id, name]);
    if (!stats || stats.total === 0) return res.json({ success: true });
    const newStatus = (stats.paid === stats.total) ? 0 : 1;
    await dbRun('UPDATE squares SET is_paid = ? WHERE pool_id = ? AND name = ?', [newStatus, req.params.id, name]);
    await logActivity(req.params.id, `Marked ${name} ${newStatus === 1 ? 'paid' : 'unpaid'}`);
    res.json({ success: true, isPaid: newStatus === 1 });
}));

// Toggle the paid status of a single square (for partial payments).
app.post('/api/pool/:id/admin/toggle-pay-cell', poolAdmin, ah(async (req, res) => {
    const { row, col } = req.body;
    if (!isDigit(row) || !isDigit(col)) return res.status(400).json({ error: 'Invalid square.' });
    const sq = await dbGet('SELECT is_paid FROM squares WHERE pool_id = ? AND row = ? AND col = ?', [req.params.id, row, col]);
    if (!sq) return res.status(404).json({ error: 'Square not claimed.' });
    const newStatus = sq.is_paid === 1 ? 0 : 1;
    await dbRun('UPDATE squares SET is_paid = ? WHERE pool_id = ? AND row = ? AND col = ?', [newStatus, req.params.id, row, col]);
    await logActivity(req.params.id, `Marked cell #${row * 10 + col + 1} ${newStatus === 1 ? 'paid' : 'unpaid'}`);
    res.json({ success: true, isPaid: newStatus === 1 });
}));

// Mark squares paid based on a dollar amount: floor(amount / cost) of a person's
// squares get marked paid (in board order), the rest unpaid. Handles partial payments.
app.post('/api/pool/:id/admin/set-paid', poolAdmin, ah(async (req, res) => {
    const name = cleanName(req.body.name);
    const amount = Number(req.body.amount);
    if (!name || !(amount >= 0)) return res.status(400).json({ error: 'Invalid input.' });
    const pool = await dbGet('SELECT cost_per_square FROM pools WHERE id = ?', [req.params.id]);
    const cost = Number(pool && pool.cost_per_square) || 0;
    const sqs = await dbAll('SELECT row, col FROM squares WHERE pool_id = ? AND name = ? ORDER BY row, col', [req.params.id, name]);
    const total = sqs.length;
    if (total === 0) return res.json({ success: true });
    let paidCount = cost > 0 ? Math.floor(amount / cost) : (amount > 0 ? total : 0);
    paidCount = Math.max(0, Math.min(total, paidCount));
    await dbRun('BEGIN');
    try {
        await dbRun('UPDATE squares SET is_paid = 0 WHERE pool_id = ? AND name = ?', [req.params.id, name]);
        for (let i = 0; i < paidCount; i++) {
            await dbRun('UPDATE squares SET is_paid = 1 WHERE pool_id = ? AND row = ? AND col = ?', [req.params.id, sqs[i].row, sqs[i].col]);
        }
        await dbRun('COMMIT');
    } catch (e) { await dbRun('ROLLBACK'); throw e; }
    await logActivity(req.params.id, `${name}: marked ${paidCount}/${total} paid`);
    res.json({ success: true, paidCount, total });
}));

app.post('/api/pool/:id/admin/assign', poolAdmin, ah(async (req, res) => {
    const { row, col } = req.body;
    const name = cleanName(req.body.name);
    if (!isDigit(row) || !isDigit(col) || !name) return res.status(400).json({ error: 'Invalid square or name.' });
    try {
        await dbRun('INSERT INTO squares (pool_id, row, col, name, claimed_at) VALUES (?, ?, ?, ?, ?)', [req.params.id, row, col, name, new Date().toISOString()]);
    } catch (e) {
        return res.status(400).json({ error: 'Square taken.' });
    }
    await maybeAutoLockFull(req.params.id);
    await logActivity(req.params.id, `Assigned cell #${row * 10 + col + 1} to ${name}`);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/rename', poolAdmin, ah(async (req, res) => {
    const { row, col } = req.body;
    const name = cleanName(req.body.name);
    if (!isDigit(row) || !isDigit(col) || !name) return res.status(400).json({ error: 'Invalid square or name.' });
    await dbRun('UPDATE squares SET name = ? WHERE pool_id = ? AND row = ? AND col = ?', [name, req.params.id, row, col]);
    await logActivity(req.params.id, `Renamed cell #${row * 10 + col + 1} to ${name}`);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/clear', poolAdmin, ah(async (req, res) => {
    await dbRun('DELETE FROM squares WHERE pool_id = ? AND row = ? AND col = ?', [req.params.id, req.body.row, req.body.col]);
    await logActivity(req.params.id, `Cleared cell #${Number(req.body.row) * 10 + Number(req.body.col) + 1}`);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/randomize', poolAdmin, ah(async (req, res) => {
    const mode = await poolMode(req.params.id);
    const slot = (await currentSlot(req.params.id, mode)) || SLOTS[mode][0];
    await setSlotNumbers(req.params.id, slot);
    res.json({ success: true });
}));

// Rotating modes: draw the next period's numbers (becomes the current set).
app.post('/api/pool/:id/admin/advance-numbers', poolAdmin, ah(async (req, res) => {
    const mode = await poolMode(req.params.id);
    const slot = await nextSlot(req.params.id, mode);
    if (slot) await setSlotNumbers(req.params.id, slot);
    res.json({ success: true, slot: slot || null });
}));

app.post('/api/pool/:id/admin/number-mode', poolAdmin, ah(async (req, res) => {
    const mode = SLOTS[req.body.mode] ? req.body.mode : 'once';
    await dbRun('UPDATE pools SET number_mode = ? WHERE id = ?', [mode, req.params.id]);
    // Changing the rotation resets any drawn numbers.
    await dbRun('DELETE FROM grid_numbers WHERE pool_id = ?', [req.params.id]);
    await resetHeaders(req.params.id);
    // If the board is already locked, draw the first slot so it is not left blank.
    const pool = await dbGet('SELECT locked FROM pools WHERE id = ?', [req.params.id]);
    if (pool && pool.locked === 1) await setSlotNumbers(req.params.id, SLOTS[mode][0]);
    res.json({ success: true });
}));

// Switch a board between classic digits and soccer goal-minute. Resets numbers and
// goals since the two formats don't share a grid meaning.
app.post('/api/pool/:id/admin/format', poolAdmin, ah(async (req, res) => {
    const scoring = req.body.scoring === 'goal_minute' ? 'goal_minute' : 'digits';
    const mode = scoring === 'goal_minute'
        ? (req.body.numberMode === 'per_goal' ? 'per_goal' : 'once')
        : (['per_quarter', 'per_half'].includes(req.body.numberMode) ? req.body.numberMode : 'once');
    await dbRun('UPDATE pools SET scoring = ?, number_mode = ? WHERE id = ?', [scoring, mode, req.params.id]);
    await dbRun('DELETE FROM grid_numbers WHERE pool_id = ?', [req.params.id]);
    await dbRun('DELETE FROM goals WHERE pool_id = ?', [req.params.id]);
    await resetHeaders(req.params.id);
    const pool = await dbGet('SELECT locked FROM pools WHERE id = ?', [req.params.id]);
    if (pool && pool.locked === 1) await setSlotNumbers(req.params.id, SLOTS[mode][0]);
    res.json({ success: true });
}));

// Manually add a goal (for boards not on ESPN, or to test before kickoff).
// Minute accepts "63" or stoppage "90+9".
app.post('/api/pool/:id/admin/goals', poolAdmin, ah(async (req, res) => {
    const minute = parseGoalMinute(String(req.body.minute == null ? '' : req.body.minute));
    if (minute == null) return res.status(400).json({ error: 'Enter a minute, e.g. 63 or 90+9.' });
    const label = (String(req.body.label || '').trim().slice(0, 40)) || 'Goal';
    const side = req.body.side === 'top' ? 'top' : (req.body.side === 'left' ? 'left' : '');
    const mode = await poolMode(req.params.id);
    const { cols, rows } = await poolDims(req.params.id);
    await drawNumbersIfNeeded(req.params.id);
    const existing = await dbAll('SELECT idx FROM goals WHERE pool_id = ? ORDER BY idx', [req.params.id]);
    const nextIdx = existing.reduce((m, r) => Math.max(m, r.idx), 0) + 1;
    const slot = await lockGoalSlot(req.params.id, mode, nextIdx, cols, rows);
    await dbRun('INSERT INTO goals (pool_id, idx, minute, label, team_side, slot) VALUES (?, ?, ?, ?, ?, ?)',
        [req.params.id, nextIdx, minute, label, side, slot]);
    bump(req.params.id);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/goals/clear', poolAdmin, ah(async (req, res) => {
    await dbRun('DELETE FROM goals WHERE pool_id = ?', [req.params.id]);
    await dbRun("DELETE FROM grid_numbers WHERE pool_id = ? AND slot LIKE 'g%'", [req.params.id]);
    bump(req.params.id);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/clear-headers', poolAdmin, ah(async (req, res) => {
    await dbRun('DELETE FROM grid_numbers WHERE pool_id = ?', [req.params.id]);
    await resetHeaders(req.params.id);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/reset-board', poolAdmin, ah(async (req, res) => {
    await dbRun('DELETE FROM squares WHERE pool_id = ?', [req.params.id]);
    await dbRun('DELETE FROM grid_numbers WHERE pool_id = ?', [req.params.id]);
    await dbRun('UPDATE pools SET locked = 0 WHERE id = ?', [req.params.id]);
    await resetHeaders(req.params.id);
    await logActivity(req.params.id, 'Wiped all squares');
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/teams', poolAdmin, ah(async (req, res) => {
    const { teamTop, teamLeft, colorTop, colorLeft, colorTop2, colorLeft2 } = req.body;
    // A manual team edit overrides ESPN, so drop the linked logos to avoid showing stale ones.
    await dbRun(
        'UPDATE pools SET team_top = ?, team_left = ?, color_top = ?, color_left = ?, color_top2 = ?, color_left2 = ?, logo_top = NULL, logo_left = NULL WHERE id = ?',
        [teamTop, teamLeft, colorTop, colorLeft, colorTop2 || null, colorLeft2 || null, req.params.id]
    );
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/settings', poolAdmin, ah(async (req, res) => {
    // Partial update: only touch the fields actually provided.
    const sets = [];
    const vals = [];
    if (req.body.name !== undefined) { sets.push('name = ?'); vals.push(cleanName(req.body.name) || 'Squares Pool'); }
    if (req.body.cost !== undefined) { sets.push('cost_per_square = ?'); vals.push(String(req.body.cost)); }
    if (req.body.venmoUrl !== undefined) { sets.push('venmo_url = ?'); vals.push(req.body.venmoUrl || null); }
    if (req.body.note !== undefined) { sets.push('note = ?'); vals.push((req.body.note || '').slice(0, 500) || null); }
    if (req.body.numberMode !== undefined) { sets.push('number_mode = ?'); vals.push(req.body.numberMode); }
    if (req.body.paymentDeadline !== undefined) { sets.push('payment_deadline = ?'); vals.push(req.body.paymentDeadline || null); }
    if (req.body.startTime !== undefined) { sets.push('espn_start = ?'); vals.push(req.body.startTime || null); }
    if (!sets.length) return res.json({ success: true });
    vals.push(req.params.id);
    await dbRun(`UPDATE pools SET ${sets.join(', ')} WHERE id = ?`, vals);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/scores', poolAdmin, ah(async (req, res) => {
    for (const q of ['q1', 'q2', 'q3', 'final']) {
        const s = req.body[q] || {};
        await dbRun(
            `INSERT INTO scores (pool_id, period, top_score, left_score) VALUES (?, ?, ?, ?)
             ON CONFLICT(pool_id, period) DO UPDATE SET top_score = excluded.top_score, left_score = excluded.left_score`,
            [req.params.id, q, s.top || '', s.left || '']
        );
    }
    const mode = await poolMode(req.params.id);
    if (mode !== 'once') await advanceFromScores(req.params.id, mode);
    res.json({ success: true });
}));

// Manually drive the on-board live scoreboard and "winning now" highlight (for boards
// not pulling from ESPN). Mirrors what the ESPN poll writes into live_state.
app.post('/api/pool/:id/admin/live-score', poolAdmin, ah(async (req, res) => {
    if (req.body.clear) {
        await dbRun('UPDATE pools SET live_state = NULL WHERE id = ?', [req.params.id]);
        return res.json({ success: true });
    }
    const top = String(req.body.top == null ? '' : req.body.top).trim().slice(0, 6);
    const left = String(req.body.left == null ? '' : req.body.left).trim().slice(0, 6);
    const state = req.body.state === 'post' ? 'post' : 'in';
    const period = ['q1', 'q2', 'q3', 'final'].includes(req.body.period) ? req.body.period : 'q1';
    const label = { q1: 'Q1', q2: 'Q2', q3: 'Q3', final: 'Final' }[period];
    // Soccer boards can carry a match clock (for the "if a goal happened now" highlight)
    // and a final-whistle minute (for the 0-0 fallback winner).
    const clock = String(req.body.clock == null ? '' : req.body.clock).trim().slice(0, 8);
    const whistleMinute = req.body.whistleMinute != null ? parseGoalMinute(String(req.body.whistleMinute)) : null;
    const statusDetail = state === 'post' ? 'Final' : (clock ? clock : (label + ' in progress'));
    const payload = { top, left, period, state, statusDetail, clock };
    if (whistleMinute != null) payload.whistleMinute = whistleMinute;
    const live = JSON.stringify(payload);
    await dbRun('UPDATE pools SET live_state = ? WHERE id = ?', [live, req.params.id]);
    res.json({ success: true });
}));

app.get('/api/pool/:id/admin/activity', poolAdmin, ah(async (req, res) => {
    const rows = await dbAll('SELECT text, at FROM activity WHERE pool_id = ? ORDER BY id DESC LIMIT 100', [req.params.id]);
    res.json({ activity: rows });
}));

// Organizer posts into the shared board chat (marked so it stands out).
app.post('/api/pool/:id/admin/messages', poolAdmin, ah(async (req, res) => {
    const sender = (String(req.body.sender || '').trim().slice(0, 40)) || 'Organizer';
    const body = String(req.body.body || '').trim().slice(0, 500);
    if (!body) return res.status(400).json({ error: 'Message is empty' });
    const created_at = Date.now();
    const r = await dbRun('INSERT INTO messages (pool_id, sender, body, is_admin, created_at) VALUES (?, ?, ?, 1, ?)', [req.params.id, sender, body, created_at]);
    const msg = { id: r.lastID, sender, body, is_admin: 1, created_at };
    broadcast(req.params.id, 'chat', msg);
    res.json({ message: msg });
}));

app.post('/api/pool/:id/admin/messages/:mid/delete', poolAdmin, ah(async (req, res) => {
    await dbRun('DELETE FROM messages WHERE id = ? AND pool_id = ?', [req.params.mid, req.params.id]);
    broadcast(req.params.id, 'chat-delete', { id: Number(req.params.mid) });
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/announcements', poolAdmin, ah(async (req, res) => {
    const body = String(req.body.body || '').trim().slice(0, 500);
    if (!body) return res.status(400).json({ error: 'Announcement is empty' });
    const created_at = Date.now();
    const r = await dbRun('INSERT INTO announcements (pool_id, body, created_at) VALUES (?, ?, ?)', [req.params.id, body, created_at]);
    const ann = { id: r.lastID, body, created_at };
    broadcast(req.params.id, 'announce', ann);
    res.json({ announcement: ann });
}));

app.post('/api/pool/:id/admin/announcements/:aid/delete', poolAdmin, ah(async (req, res) => {
    await dbRun('DELETE FROM announcements WHERE id = ? AND pool_id = ?', [req.params.aid, req.params.id]);
    broadcast(req.params.id, 'announce-delete', { id: Number(req.params.aid) });
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/annotate', poolAdmin, ah(async (req, res) => {
    const { row, col } = req.body;
    if (!isDigit(row) || !isDigit(col)) return res.status(400).json({ error: 'Invalid square.' });
    const text = String(req.body.text || '').slice(0, 120);
    const icon = String(req.body.icon || '').slice(0, 8);
    if (!text && !icon) {
        await dbRun('DELETE FROM annotations WHERE pool_id = ? AND row = ? AND col = ?', [req.params.id, row, col]);
    } else {
        await dbRun(
            `INSERT INTO annotations (pool_id, row, col, text, icon) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(pool_id, row, col) DO UPDATE SET text = excluded.text, icon = excluded.icon`,
            [req.params.id, row, col, text, icon]
        );
    }
    res.json({ success: true });
}));

// --- ESPN: find games, link a game, choose score source ---
app.get('/api/pool/:id/admin/espn', poolAdmin, espnSearch);

app.post('/api/pool/:id/admin/set-game', poolAdmin, ah(async (req, res) => {
    const { league, espnId } = req.body;
    if (!LEAGUES[league] || !espnId) return res.status(400).json({ error: 'Invalid game.' });
    try { await linkGameToPool(req.params.id, league, espnId); }
    catch (e) { return res.status(502).json({ error: 'Could not reach ESPN: ' + e.message }); }
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/score-source', poolAdmin, ah(async (req, res) => {
    const source = req.body.source === 'live' ? 'live' : 'manual';
    if (source === 'live') await dbRun('UPDATE pools SET score_source = ?, live_done = 0 WHERE id = ?', [source, req.params.id]);
    else await dbRun('UPDATE pools SET score_source = ? WHERE id = ?', [source, req.params.id]);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/unlink-game', poolAdmin, ah(async (req, res) => {
    await dbRun("UPDATE pools SET espn_league = NULL, espn_event_id = NULL, espn_start = NULL, score_source = 'manual', logo_top = NULL, logo_left = NULL WHERE id = ?", [req.params.id]);
    res.json({ success: true });
}));

migrate()
    .then(() => {
        app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
        setInterval(pollLiveScores, 15000);
        setInterval(autoLockStartedGames, 30000);
    })
    .catch((e) => { console.error('Migration failed:', e); process.exit(1); });
