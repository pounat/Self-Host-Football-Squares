const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const crypto = require('crypto');
const path = require('path');

const app = express();
const db = new sqlite3.Database('./squares.db');

const PORT = 3000;
const DEFAULT_HEADERS = JSON.stringify(['?', '?', '?', '?', '?', '?', '?', '?', '?', '?']);

// --- PROMISE HELPERS ---
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbExec = (sql) => new Promise((res, rej) => db.exec(sql, (e) => e ? rej(e) : res()));

// Wrap async route handlers so rejected promises become 500s instead of crashing.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => res.status(500).json({ error: e.message }));

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
function computeWinners(squares, topHeaders, leftHeaders, scores) {
    const winners = {};
    for (const q of ['q1', 'q2', 'q3', 'final']) {
        const s = scores[q];
        if (!s || s.top === '' || s.left === '') continue;
        const dTop = lastDigit(s.top);
        const dLeft = lastDigit(s.left);
        if (dTop === null || dLeft === null) continue;

        const c = topHeaders.indexOf(dTop);
        const r = leftHeaders.indexOf(dLeft);
        if (c === -1 || r === -1) continue; // numbers not drawn yet

        let searchR = r;
        let searchC = c;
        let winner = null;
        for (let i = 0; i < 100; i++) {
            const found = squares.find((sq) => sq.row === searchR && sq.col === searchC);
            if (found) { winner = { r: searchR, c: searchC, name: found.name }; break; }
            searchC++;
            if (searchC > 9) { searchC = 0; searchR++; if (searchR > 9) searchR = 0; }
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

app.use(bodyParser.json());
app.use(express.static('public', { index: false }));

// --- PAGES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/p/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
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
        SELECT p.id, p.name, p.admin_token, p.locked, p.created_at,
               (SELECT COUNT(*) FROM squares s WHERE s.pool_id = p.id) AS filled
        FROM pools p ORDER BY p.created_at DESC
    `);
    res.json({
        pools: pools.map((p) => ({
            id: p.id, name: p.name, locked: p.locked === 1, created: p.created_at, filled: p.filled,
            shareUrl: `/p/${p.id}`, adminUrl: `/p/${p.id}/admin#${p.admin_token}`,
        })),
    });
}));

app.post('/api/owner/pools', ownerAuth, ah(async (req, res) => {
    const name = cleanName(req.body.name) || 'Squares Pool';
    const id = await uniquePoolId();
    const adminToken = genToken();
    await dbRun(
        `INSERT INTO pools (id, admin_token, name, team_top, team_left, color_top, color_left,
            cost_per_square, venmo_url, locked, number_mode, top_headers, left_headers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'once', ?, ?)`,
        [
            id, adminToken, name,
            (req.body.teamTop || 'Top').slice(0, 30), (req.body.teamLeft || 'Left').slice(0, 30),
            req.body.colorTop || '#002244', req.body.colorLeft || '#4b92db',
            String(req.body.cost ?? '0'), req.body.venmoUrl || null,
            DEFAULT_HEADERS, DEFAULT_HEADERS,
        ]
    );
    res.json({ id, adminToken, shareUrl: `/p/${id}`, adminUrl: `/p/${id}/admin#${adminToken}` });
}));

app.delete('/api/owner/pools/:id', ownerAuth, ah(async (req, res) => {
    await dbRun('DELETE FROM squares WHERE pool_id = ?', [req.params.id]);
    await dbRun('DELETE FROM scores WHERE pool_id = ?', [req.params.id]);
    await dbRun('DELETE FROM pools WHERE id = ?', [req.params.id]);
    res.json({ success: true });
}));

// --- PUBLIC BOARD STATE ---
app.get('/api/pool/:id', ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const pool = await dbGet('SELECT * FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });

    const squares = await dbAll('SELECT row, col, name, is_paid, claimed_at FROM squares WHERE pool_id = ?', [req.params.id]);
    const scoreRows = await dbAll('SELECT period, top_score, left_score FROM scores WHERE pool_id = ?', [req.params.id]);

    const scores = { q1: { top: '', left: '' }, q2: { top: '', left: '' }, q3: { top: '', left: '' }, final: { top: '', left: '' } };
    scoreRows.forEach((r) => { if (scores[r.period]) scores[r.period] = { top: r.top_score || '', left: r.left_score || '' }; });

    const topHeaders = JSON.parse(pool.top_headers || DEFAULT_HEADERS);
    const leftHeaders = JSON.parse(pool.left_headers || DEFAULT_HEADERS);
    const winners = computeWinners(squares, topHeaders, leftHeaders, scores);

    res.json({
        poolId: pool.id,
        name: pool.name,
        squares,
        isLocked: pool.locked === 1,
        topHeaders,
        leftHeaders,
        winners,
        teamTop: pool.team_top || 'Top',
        teamLeft: pool.team_left || 'Left',
        colorTop: pool.color_top || '#333',
        colorLeft: pool.color_left || '#333',
        cost: pool.cost_per_square || '0',
        venmoUrl: pool.venmo_url || '',
        paymentDeadline: pool.payment_deadline || '',
        numberMode: pool.number_mode || 'once',
        scores,
    });
}));

// --- CLAIMING ---
app.post('/api/pool/:id/claim', ah(async (req, res) => {
    const { row, col } = req.body;
    const name = cleanName(req.body.name);
    if (!isDigit(row) || !isDigit(col) || !name) return res.status(400).json({ error: 'Invalid square or name.' });

    const pool = await dbGet('SELECT locked FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    if (pool.locked === 1) return res.status(403).json({ error: 'Game is locked!' });

    try {
        await dbRun('INSERT INTO squares (pool_id, row, col, name, claimed_at) VALUES (?, ?, ?, ?, ?)', [req.params.id, row, col, name, new Date().toISOString()]);
    } catch (e) {
        return res.status(400).json({ error: 'Square taken.' });
    }
    res.json({ success: true });
}));

app.post('/api/pool/:id/claim-batch', ah(async (req, res) => {
    const name = cleanName(req.body.name);
    const squares = Array.isArray(req.body.squares) ? req.body.squares : [];
    if (!name) return res.status(400).json({ error: 'Name required.' });
    if (!squares.length || !squares.every((s) => isDigit(s.r) && isDigit(s.c))) {
        return res.status(400).json({ error: 'Invalid squares.' });
    }

    const pool = await dbGet('SELECT locked FROM pools WHERE id = ?', [req.params.id]);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    if (pool.locked === 1) return res.status(403).json({ error: 'Game is locked!' });

    let claimed = 0;
    let errors = 0;
    await dbRun('BEGIN');
    try {
        for (const sq of squares) {
            try {
                await dbRun('INSERT INTO squares (pool_id, row, col, name, claimed_at) VALUES (?, ?, ?, ?, ?)', [req.params.id, sq.r, sq.c, name, new Date().toISOString()]);
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
    res.json({ success: true, claimed, errors });
}));

// --- ADMIN ---
app.get('/api/pool/:id/admin/check', poolAdmin, (req, res) => res.json({ ok: true }));

app.post('/api/pool/:id/admin/lock', poolAdmin, ah(async (req, res) => {
    await dbRun('UPDATE pools SET locked = ? WHERE id = ?', [req.body.locked ? 1 : 0, req.params.id]);
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
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/rename', poolAdmin, ah(async (req, res) => {
    const { row, col } = req.body;
    const name = cleanName(req.body.name);
    if (!isDigit(row) || !isDigit(col) || !name) return res.status(400).json({ error: 'Invalid square or name.' });
    await dbRun('UPDATE squares SET name = ? WHERE pool_id = ? AND row = ? AND col = ?', [name, req.params.id, row, col]);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/clear', poolAdmin, ah(async (req, res) => {
    await dbRun('DELETE FROM squares WHERE pool_id = ? AND row = ? AND col = ?', [req.params.id, req.body.row, req.body.col]);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/randomize', poolAdmin, ah(async (req, res) => {
    const shuffle = (arr) => {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    };
    const top = JSON.stringify(shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const left = JSON.stringify(shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    await dbRun('UPDATE pools SET top_headers = ?, left_headers = ? WHERE id = ?', [top, left, req.params.id]);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/clear-headers', poolAdmin, ah(async (req, res) => {
    await dbRun('UPDATE pools SET top_headers = ?, left_headers = ? WHERE id = ?', [DEFAULT_HEADERS, DEFAULT_HEADERS, req.params.id]);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/reset-board', poolAdmin, ah(async (req, res) => {
    await dbRun('DELETE FROM squares WHERE pool_id = ?', [req.params.id]);
    await dbRun('UPDATE pools SET locked = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/teams', poolAdmin, ah(async (req, res) => {
    const { teamTop, teamLeft, colorTop, colorLeft } = req.body;
    await dbRun(
        'UPDATE pools SET team_top = ?, team_left = ?, color_top = ?, color_left = ? WHERE id = ?',
        [teamTop, teamLeft, colorTop, colorLeft, req.params.id]
    );
    res.json({ success: true });
}));

app.post('/api/pool/:id/admin/settings', poolAdmin, ah(async (req, res) => {
    // Partial update: only touch the fields actually provided.
    const sets = [];
    const vals = [];
    if (req.body.cost !== undefined) { sets.push('cost_per_square = ?'); vals.push(String(req.body.cost)); }
    if (req.body.venmoUrl !== undefined) { sets.push('venmo_url = ?'); vals.push(req.body.venmoUrl || null); }
    if (req.body.numberMode !== undefined) { sets.push('number_mode = ?'); vals.push(req.body.numberMode); }
    if (req.body.paymentDeadline !== undefined) { sets.push('payment_deadline = ?'); vals.push(req.body.paymentDeadline || null); }
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
    res.json({ success: true });
}));

migrate()
    .then(() => app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`)))
    .catch((e) => { console.error('Migration failed:', e); process.exit(1); });
