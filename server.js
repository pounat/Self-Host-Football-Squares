const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const app = express();
const db = new sqlite3.Database('./squares.db');

// --- CONFIGURATION ---
const PORT = 3000;
const ADMIN_PASSWORD = ""; 

app.use(bodyParser.json());
app.use(express.static('public')); 

// --- DATABASE SETUP ---
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS squares (row INT, col INT, name TEXT, UNIQUE(row, col))`);
  try { db.run("ALTER TABLE squares ADD COLUMN is_paid INT DEFAULT 0", () => {}); } catch(e) {}

  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT UNIQUE, value TEXT)`);
  
  // Default Meta Values
  const defaults = {
      'locked': 'false',
      'team_top': 'Broncos', 'team_left': 'Chiefs',
      'color_top': '#FB4F14', 'color_left': '#E31837',
      'cost_per_square': '5',
      'score_q1_top': '', 'score_q1_left': '',
      'score_q2_top': '', 'score_q2_left': '',
      'score_q3_top': '', 'score_q3_left': '',
      'score_final_top': '', 'score_final_left': '',
      'live_score_top': '0', 'live_score_left': '0',
      'top_headers': JSON.stringify(['?','?','?','?','?','?','?','?','?','?']),
      'left_headers': JSON.stringify(['?','?','?','?','?','?','?','?','?','?'])
  };

  for(let key in defaults) {
      db.run(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`, [key, defaults[key]]);
  }
});

// --- HELPER ---
const checkAuth = (req, res, next) => {
    if (req.body.password === ADMIN_PASSWORD) next();
    else res.status(403).json({ error: "Unauthorized" });
};

// --- ROUTES ---

// THIS WAS MISSING - IT FIXES THE "CANNOT GET /ADMIN" ERROR
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- PUBLIC API ---
app.get('/api/squares', (req, res) => {
    db.all("SELECT * FROM squares", (err, rows) => {
        db.all("SELECT * FROM meta", (err2, metaRows) => {
            const meta = {};
            metaRows.forEach(r => meta[r.key] = r.value);
            
            res.json({
                squares: rows,
                teamTop: meta.team_top,
                teamLeft: meta.team_left,
                colorTop: meta.color_top,
                colorLeft: meta.color_left,
                cost: meta.cost_per_square,
                isLocked: meta.locked === 'true',
                topHeaders: JSON.parse(meta.top_headers),
                leftHeaders: JSON.parse(meta.left_headers),
                liveTop: meta.live_score_top,
                liveLeft: meta.live_score_left,
                scores: {
                    q1: { top: meta.score_q1_top, left: meta.score_q1_left },
                    q2: { top: meta.score_q2_top, left: meta.score_q2_left },
                    q3: { top: meta.score_q3_top, left: meta.score_q3_left },
                    final: { top: meta.score_final_top, left: meta.score_final_left }
                }
            });
        });
    });
});

app.post('/api/claim-batch', (req, res) => {
    const { squares, name } = req.body;
    if (!squares || !name) return res.json({ error: "Missing data" });

    let errors = 0;
    let completed = 0;

    db.get("SELECT value FROM meta WHERE key='locked'", (err, row) => {
        if(row && row.value === 'true') return res.json({ errors: 1, message: "Game is locked" });

        const stmt = db.prepare("INSERT OR IGNORE INTO squares (row, col, name, is_paid) VALUES (?, ?, ?, 0)");
        squares.forEach(s => {
            stmt.run(s.r, s.c, name, function(err) {
                if (this.changes === 0) errors++;
                completed++;
                if (completed === squares.length) res.json({ success: true, errors: errors });
            });
        });
        stmt.finalize();
    });
});

// --- ADMIN API ---
app.post('/api/admin/verify', checkAuth, (req, res) => res.json({ success: true }));

app.post('/api/admin/lock', checkAuth, (req, res) => {
    db.run("UPDATE meta SET value = ? WHERE key = 'locked'", [req.body.locked ? 'true' : 'false'], () => res.json({success:true}));
});

app.post('/api/admin/clear-headers', checkAuth, (req, res) => {
    const qMarks = JSON.stringify(Array(10).fill('?'));
    db.run("UPDATE meta SET value = ? WHERE key = 'top_headers'", [qMarks]);
    db.run("UPDATE meta SET value = ? WHERE key = 'left_headers'", [qMarks], () => res.json({success:true}));
});

app.post('/api/admin/randomize', checkAuth, (req, res) => {
    const shuffle = () => [0,1,2,3,4,5,6,7,8,9].sort(() => Math.random() - 0.5);
    db.run("UPDATE meta SET value = ? WHERE key = 'top_headers'", [JSON.stringify(shuffle())]);
    db.run("UPDATE meta SET value = ? WHERE key = 'left_headers'", [JSON.stringify(shuffle())], () => res.json({success:true}));
});

app.post('/api/admin/reset-board', checkAuth, (req, res) => {
    db.run("DELETE FROM squares", () => res.json({ success: true }));
});

app.post('/api/admin/rename', checkAuth, (req, res) => {
    db.run("UPDATE squares SET name = ? WHERE row = ? AND col = ?", [req.body.name, req.body.row, req.body.col], () => res.json({success:true}));
});
app.post('/api/admin/clear', checkAuth, (req, res) => {
    db.run("DELETE FROM squares WHERE row = ? AND col = ?", [req.body.row, req.body.col], () => res.json({success:true}));
});
app.post('/api/admin/assign', checkAuth, (req, res) => {
    db.run("INSERT OR REPLACE INTO squares (row, col, name, is_paid) VALUES (?, ?, ?, 0)", [req.body.row, req.body.col, req.body.name], () => res.json({success:true}));
});
app.post('/api/admin/toggle-pay', checkAuth, (req, res) => {
    db.run(`UPDATE squares SET is_paid = CASE WHEN is_paid = 1 THEN 0 ELSE 1 END WHERE name = ?`, [req.body.name], () => res.json({success:true}));
});

app.post('/api/admin/teams', checkAuth, (req, res) => {
    const { teamTop, colorTop, teamLeft, colorLeft } = req.body;
    db.serialize(() => {
        db.run("UPDATE meta SET value = ? WHERE key = 'team_top'", [teamTop]);
        db.run("UPDATE meta SET value = ? WHERE key = 'team_left'", [teamLeft]);
        db.run("UPDATE meta SET value = ? WHERE key = 'color_top'", [colorTop]);
        db.run("UPDATE meta SET value = ? WHERE key = 'color_left'", [colorLeft], () => res.json({ success: true }));
    });
});

app.post('/api/admin/settings', checkAuth, (req, res) => {
    db.run("UPDATE meta SET value = ? WHERE key = 'cost_per_square'", [req.body.cost], () => res.json({ success: true }));
});

app.post('/api/admin/scores', checkAuth, (req, res) => {
    const { q1, q2, q3, final } = req.body;
    db.serialize(() => {
        db.run("UPDATE meta SET value = ? WHERE key = 'score_q1_top'", [q1.top]);
        db.run("UPDATE meta SET value = ? WHERE key = 'score_q1_left'", [q1.left]);
        db.run("UPDATE meta SET value = ? WHERE key = 'score_q2_top'", [q2.top]);
        db.run("UPDATE meta SET value = ? WHERE key = 'score_q2_left'", [q2.left]);
        db.run("UPDATE meta SET value = ? WHERE key = 'score_q3_top'", [q3.top]);
        db.run("UPDATE meta SET value = ? WHERE key = 'score_q3_left'", [q3.left]);
        db.run("UPDATE meta SET value = ? WHERE key = 'score_final_top'", [final.top]);
        db.run("UPDATE meta SET value = ? WHERE key = 'score_final_left'", [final.left], () => res.json({ success: true }));
    });
});

app.post('/api/admin/live-score', checkAuth, (req, res) => {
    const { top, left } = req.body;
    db.serialize(() => {
        db.run("UPDATE meta SET value = ? WHERE key = 'live_score_top'", [top]);
        db.run("UPDATE meta SET value = ? WHERE key = 'live_score_left'", [left], () => res.json({ success: true }));
    });
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
