# Self-Host Football Squares

A self-hosted football squares (Super Bowl Squares) web app. Players claim squares on a 10x10 grid, and winners are determined by the last digit of each team's score at the end of each quarter.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)

### Installation

```bash
git clone https://github.com/pounat/self-host-football-squares.git
cd self-host-football-squares
npm install
```

### Configuration

Open `server.js` and set your admin password:

```js
const ADMIN_PASSWORD = "your-secret-password";
```

### Start the Server

```bash
npm start
```

The app runs at `http://localhost:3000`.

## How It Works

### For Players

1. Go to `http://localhost:3000`
2. Enter your name
3. Click on empty squares to select them, then hit **Claim Selected Squares**
4. Each square costs a set amount (default $5) — pay the organizer via Venmo or however you arrange it
5. Once all squares are claimed, the row/column headers get randomized with digits 0–9
6. Winners are determined at the end of each quarter: find the cell where the last digit of each team's score intersects — that person wins the quarter pot

### For the Admin

Go to `http://localhost:3000/admin` and log in with your password.

#### Game Settings
- **Lock/Unlock** the board to prevent or allow players from claiming squares
- Set team **names** and **colors**
- Set the **cost per square**

#### Live Game Tracker
- Use the quick-add buttons (+1, +3, +6) to track the score in real time
- Hit **Submit as Q1/Q2/Q3/Final** to lock in quarter scores — this determines winners

#### Scoreboard
- Manually edit or correct quarter scores at any time

#### Grid & Names
- **Randomize** the row/column header numbers (0–9)
- **Reset** headers back to `?`
- Click any taken square to **rename** or **delete** it
- Use quick-select chips or type a name to **assign** squares manually
- **Wipe Board** clears all claimed squares (requires typing RESET to confirm)

#### Money & Stats
- See how many squares each player has and what they owe
- Toggle payment status per player (paid/unpaid)
- View estimated payouts (prize pool split 25% per quarter)

## Tech Stack

- **Backend:** Node.js, Express
- **Database:** SQLite (auto-created as `squares.db`)
- **Frontend:** Vanilla HTML/CSS/JS

## File Structure

```
├── server.js          # Express server and API routes
├── public/
│   ├── index.html     # Player-facing board
│   └── admin.html     # Admin control panel
├── package.json
└── squares.db         # SQLite database (auto-created on first run)
```
