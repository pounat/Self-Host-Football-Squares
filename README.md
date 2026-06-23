# Squares

A self-hosted football (and basketball) squares pool. Create a board, share a link, and let people claim squares from their phone. It can pull a real game from ESPN to fill in team names, colors and live scores, draw the numbers when the board locks, rotate the numbers each quarter or half, track who has paid, and includes a per-board chat and announcements.

No accounts for players: they just open the share link and pick squares. One owner password protects the dashboard where you create and manage every board.

## Features

- Board sizes: 10x10 (100 squares), 10x5 (50), and 5x5 (25)
- Pick a real game from ESPN (NFL, college football, NBA, WNBA, college basketball) or set the teams and colors yourself
- Auto-lock at kickoff, auto-draw the numbers, live score highlight
- Rotating numbers: one set all game, re-draw each quarter, or re-draw at halftime
- Payouts for Q1, Q2, Q3 and the final score, with a rollover rule for empty winning squares
- Payment tracking (per person, per square, or by dollar amount)
- Player nicknames, per-board live chat, and one-time organizer announcements
- A setup wizard for creating boards

## Run with Docker (easiest)

You do not need Node installed, just Docker. Install Docker Desktop, then from this folder run:

```
docker compose up -d
```

Open http://localhost:3000 and set an owner password on first run. That is it.

The database is stored in a Docker volume named `squares-data`, so your boards survive restarts and updates. To stop it: `docker compose down` (this keeps your data). To update after pulling new code: `docker compose up -d --build`.

## Run with Node (no Docker)

Requires Node 18 or newer.

```
npm install
npm start
```

Then open http://localhost:3000. The database is written to `squares.db` in the project folder.

## First run

The first time you open the dashboard it asks you to set an owner password. Keep it safe, it is how you get back in to manage your boards. After that, log in to create boards, copy their player and admin links, show a QR code, or delete them.

Each board has two links:

- Player link (`/p/<id>`): share this with everyone playing.
- Admin link (`/p/<id>/admin#<token>`): keep this private. It manages one board (lock, scores, payments, chat) and can be handed to a co-organizer without giving them your owner password.

## Data and backups

All data lives in a single SQLite file.

- Docker: inside the `squares-data` volume at `/data/squares.db`.
- Node: `squares.db` in the project folder.

To back up, copy that file while the server is stopped (or use `sqlite3 squares.db ".backup backup.db"`).

## Configuration

Set these as environment variables if you need to:

- `PORT`: the port to listen on (default `3000`).
- `DB_PATH`: where to store the SQLite file (default `./squares.db`, or `/data/squares.db` in Docker).

## Outside access

To reach it from outside your network, put a reverse proxy in front of it. Caddy works well and gives you HTTPS automatically. A minimal `Caddyfile`:

```
squares.example.com {
    reverse_proxy localhost:3000
}
```

The live chat and live board updates use Server-Sent Events, which Caddy streams through without any extra configuration.

## Notes

- ESPN scores come from a free public API with no key required.
- Scores can also be entered by hand if you do not link a game.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
