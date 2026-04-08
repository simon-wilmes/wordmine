# Codename Competition aka Wordmine

Realtime multiplayer Codenames-inspired party game with private/public lobbies, invite links, host-configurable rules, per-round scoring, in-game chat, and bilingual support (English/German).

## What This Project Does

- Create and join lobbies (public or private) with invite links
- Route split: new homepage at `/${GAME_NAME}/`, lobby browser/history view at `/${GAME_NAME}/lobbies`
- Start realtime matches over Socket.io with configurable rules
- Two game modes: **standard** (rotating clue giver) and **simultaneous clue** (all players give clues, then guess in sequence)
- Track guesses, penalties, round timing, and cumulative scores
- In-game chat with rate limiting and automatic round-score breakdowns
- In-game HUD with live phase status text (for example `HANDLER TRANSMITTING`, `MISSION DEBRIEF`) including animated transmission dots
- Adaptive tablet-height layout for live games: `Past Rounds` timeline and `Terminal` stay docked at the bottom when space allows, and automatically move below the game content (scrollable page flow) on shorter viewports to prevent overlap
- Player names are validated to `2-25` characters; game UI uses adaptive name-size tiers (`0-14` normal, `15-19` small, `20-25` tiny) in constrained areas (scores, operatives status, card markers, past-round timeline), while lobby and final game overview keep non-scaled name text
- Operatives sidebar status labels: `waiting` during clue transmission phases, `guessing` during guess phase, `finished` when done, and `timed out` when guess timer expires before finishing
- Round-end board reveal + end-game podium with detailed stats
- Past-round replay timeline with per-cluegiver snapshots (available during live play and on final overview)
- Rematch flow: host creates a new lobby with same settings and name, other players see a popup and can join with one click
- Spectator mode for watching live games
- Reconnect on page refresh (player identity stored in localStorage per lobby)
- Persistent finished-game history per browser, shown on the landing page
- Bilingual: board word language per lobby (`en`/`de`) + UI language toggle (`en`/`de`)
- Optional AI clue agent (Claude Code CLI) that can be added by host in lobby (max 1 AI per game)

## Tech Stack

- **Client:** React 18 + Vite 5 + React Router 6 + Socket.io Client 4
- **Server:** Node.js + Express 4 + Socket.io 4
- **State:** In-memory for active sessions + SQLite archive for finished games
- **Styling:** Plain CSS with design tokens (`styles/tokens.css`)
- **i18n:** Custom context-based provider (`lib/i18n.jsx`), no external library
- **Production:** Server serves built client at `/${GAME_NAME}` (default: `/wordmine`), configured for Cloudflare Tunnel via `https://games.wilmes.dev`

## Quick Start

### 1) Server

```bash
cd server
npm install
npm run dev
```

Server default: `http://localhost:3001`

### 2) Client

```bash
cd client
npm install
npm run dev
```

Client default: `http://localhost:5173`

### Configuration

The game name prefix is defined in `.env` at the project root:

```
GAME_NAME=wordmine
```

All URLs are served under `/${GAME_NAME}/` (e.g., `/wordmine/`, `/wordmine/lobbies`, `/wordmine/api/...`, `/wordmine/lobby/:id`). Both the production Node server and Vite dev/preview server automatically redirect `/${GAME_NAME}` to `/${GAME_NAME}/` (for example `/wordmine` -> `/wordmine/`) so the app always runs from its canonical base URL. To rename the game, change this single value and restart. No domain is hardcoded — the app works on `localhost`, `games.wilmes.dev`, or any other host.

Cloudflare does not need a special rule for this specific slash redirect when traffic reaches this Node server; the app handles it itself. If you terminate traffic somewhere else before Node, add the equivalent redirect at that layer.

### Production Build

```bash
cd client && npm run build
cd ../server && node src/index.js
```

Or use the startup script (sources `.env` automatically):

```bash
./start-production.sh
```

The server serves the built client from `client/dist` at the `/${GAME_NAME}` path.

## Game Modes

### Standard Mode

Each round, one player is the clue giver and the rest are guessers. The clue giver role rotates. Total rounds = `cycles * playerCount`.

### Simultaneous Clue Mode (`simultaneousClue: true`)

All players give clues on the same board during a shared clue phase. Then each clue is played out as a sub-round where all other players guess. Total rounds = `cycles` (each round has N sub-rounds where N = playerCount).

## Game Rules

Each round uses a 5x5 board:

- 14 green cards (possible correct targets)
- 10 red cards (penalty)
- 1 black card (heavy penalty / instant stop)

Flow per round:

1. Clue giver selects a subset of green cards and submits a one-word clue + count (Enter key or button)
2. Guessers single-click to mark cards, double-click to commit a guess
3. Each guesser may make at most **clueCount + 1** guesses per round
4. Outcomes:
   - Green card that was selected by clue giver: **correct** (points)
   - Green card not selected: **neutral** (no points, no penalty, counts toward guess limit)
   - Red card: **penalty**; guesser is **immediately finished** for the round
   - Black card: **heavy penalty**; guesser finished immediately
5. Round ends when all targets found, all guessers finished (guess limit, red, or black), or timer expires
6. If the guess timer expires, any still-active guessers are force-marked as finished with timeout status for that round
7. Reveal phase shows the full board for a configurable pause, then next round
8. During `MISSION DEBRIEF`, human players can press `Skip to Next Section`; once all non-AI players have pressed continue, the game advances immediately (AI agents are excluded from this vote)

## AI Clue Agent (Claude Code CLI)

- Host can add at most one AI agent in the lobby via `Add AI Agent`
- `Add AI Agent` is password-protected; server verifies a SHA-512 hash before allowing the AI to be added
- AI agents use deterministic AI-themed names (`Cipher`, `Nova`, `Atlas`, `Echo`, then numbered variants)
- AI agents are clue-only in v1:
  - If AI is clue giver in standard mode, server auto-generates clue + targets
  - If AI is guesser in standard mode, server auto-generates an ordered click plan from clue context
- AI clue generation uses local Claude Code CLI (not paid API) with language-aware prompts:
  - English prompt for `wordLanguage=en`
  - German prompt for `wordLanguage=de`
- Output is validated server-side against live board constraints
- If invalid, server retries up to 3 times with corrective feedback
- If still invalid after 3 tries, clue is skipped as if time ran out and round advances
- AI clue reveal has a minimum delay of 5 seconds from clue-phase start (human-like pacing)
- AI guesser behavior:
  - Returns ordered words to click by likelihood
  - Can stop early by returning fewer guesses
  - On non-target green clicks, receives feedback and can re-plan remaining guesses
  - Parsing/planning failures are retried up to 3 times per AI guesser per round
  - After retry limit, AI guesser stops for that round

### Claude CLI Setup

The server expects a local Claude Code CLI command to be available on the host machine.

If you deploy with `deploy-pi.sh`, the script now:

- Installs Claude Code CLI automatically if `claude` is missing
- Requires a token file at `/home/pi/.claude-oauth` (token only)
- Injects that token into the generated systemd service as `CLAUDE_CODE_OAUTH_TOKEN`

Token file setup on the Pi:

```bash
printf '%s\n' 'YOUR_OAUTH_TOKEN_HERE' > /home/pi/.claude-oauth
chmod 600 /home/pi/.claude-oauth
```

Optional environment variables:

- `CLAUDE_CLI_COMMAND` (default: `claude`)
- `CLAUDE_CLI_ARGS_JSON` (JSON array; default: `["-p","{prompt}"]`)
- `CLAUDE_CLI_TIMEOUT_MS` (default: `20000`)

### AI Logging

For each AI clue attempt, server logs include:

- Prompt metadata (`lobbyId`, round, clue giver, language, attempt, latency)
- Full prompt text (verbatim)
- Raw Claude output (verbatim)
- Parsed JSON output and validation status
- Retry/failure reason and final status (`submitted` or `skipped_after_retries`)

Note: logs can contain live board words and clues.

### Scoring

- `clueCardValue` (default 300): points distributed among guessers who found each target card
- `guesserCardPool` (default 200): points distributed by time-weighted ranking per card
- `rankBonus1/2/3` (default 50/25/15): bonus for 1st/2nd/3rd guesser to find each card
- `redPenalty` (default 50): deducted for guessing a red card
- `blackPenalty` (default 200): deducted for guessing the black card
- `penalizeClueGiverForWrongGuesses`: optionally deduct from clue giver when their guessers hit red/black

## Configuration (Host)

All settings are per-lobby, editable before game start:

| Setting | Range | Description |
|---------|-------|-------------|
| `visibility` | `public` / `private` | Whether lobby appears in public list |
| `wordLanguage` | `en` / `de` | Board word source file |
| `cycles` | 1-30 | Number of full rotations through players |
| `simultaneousClue` | bool | Enable simultaneous clue mode |
| `cluePhaseSeconds` | 0+ | Clue time limit (`0` = unlimited) |
| `guessPhaseSeconds` | 5+ | Guess time limit |
| `betweenRoundsSeconds` | 0+ | Reveal/pause duration (`0` = no pause) |
| `clueCardValue` | 1-2000 | Points per target card |
| `guesserCardPool` | 1-2000 | Bonus pool per card |
| `rankBonus1/2/3` | 0-2000 | Rank bonuses |
| `redPenalty` | 0-2000 | Red card penalty |
| `blackPenalty` | 0-5000 | Black card penalty |
| `penalizeClueGiverForWrongGuesses` | bool | Clue giver shares penalties |

## Chat System

In-game chat panel ("Terminal") with:

- Player messages with rate limiting (1 message/second)
- Max message length: 1000 chars, max total chat: 10000 chars
- Link blocking (URLs filtered)
- Automatic system messages after each round showing per-player score breakdowns with itemized point gains/losses
- Spectators can read chat but not send messages

## Past-Round Replay

During a running game, all players and spectators can open a replay timeline directly above the Terminal.

- One replay entry is created after each completed clue+guess cycle
- In standard mode: one entry per round
- In simultaneous clue mode: one entry per sub-round (per clue giver)
- Timeline entries are labeled by clue giver and sequence (for example `Alex 1`, `Alex 2`, `Sam 1`)
- Clicking an entry opens a popup with the final board state for that cycle:
  - Real card colors (green/red/black)
  - Clue targets
  - Who marked/guessed what
- The popup supports left/right arrow navigation to adjacent replay entries
- Live gameplay continues in the background while replay is open (timers keep running)

Replay popup auto-closes only when the local player must act in the current live phase (for example they become the active clue giver or an active guesser who is not finished).

The same replay overview is also available on the final game overview screen (`Game Over`).

## Lobby & Session Flow

1. **Create lobby** (`POST /api/lobbies`) — body includes `name` (player, `2-25` chars), `visibility`, `lobbyName`, `browserId`, and optional `wordLanguage`; if `lobbyName` is omitted, server auto-generates `Mission <random-word>` using the selected word language; returns `lobbyId` + `playerId` (host)
2. **Join lobby** (`POST /api/lobbies/:id/join`) — body includes `name` (`2-25` chars), `viaInvite`, and `browserId`; returns `playerId` for the new player (lobby hard limit: 8 players)
3. **Connect socket** (`join-lobby` event) — joins the Socket.io room, marks player connected
4. **Start game** (`start-game` event) — host only, requires 2+ players
5. **Play** — game state pushed to each player via `game-state` with role-appropriate views
6. **Game over** — podium screen with stats; host can create a rematch lobby
7. **Quit game (explicit)** — player is removed from the active game and sent back to landing; if the host quits, host role is reassigned to the first remaining player
8. **Disconnect** — player marked offline but not removed; reconnect via stored `playerId` in localStorage

If explicit quits reduce active players below 2, the game ends immediately as incomplete (`finishedReason: "insufficient_players"`).

Player identity is stored in `localStorage` as a map of `lobbyId -> playerId`, allowing reconnect on page refresh and tracking "Your Games" on the landing page.

A persistent browser-scoped `browserId` is also stored in `localStorage` and used to load finished games from server storage in the `Past Games` section.

## API & Realtime Contracts

### REST

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/lobbies` | List public waiting lobbies |
| `GET` | `/api/games` | List public in-progress games |
| `GET` | `/api/games/history?browserId=...` | List finished games for this browser |
| `GET` | `/api/games/history/:id?browserId=...` | Get archived finished game details |
| `POST` | `/api/lobbies` | Create lobby (body: `name`, `visibility`, `lobbyName`, `browserId`, optional `wordLanguage`; if `lobbyName` omitted, name defaults to `Mission <random-word>`) |
| `GET` | `/api/lobbies/:id` | Get lobby + game status |
| `POST` | `/api/lobbies/:id/join` | Join lobby (body: `name`, `viaInvite`, `browserId`) |

### Socket Events

**Client -> Server:**

| Event | Description |
|-------|-------------|
| `join-lobby` | Join socket room (with or without `playerId` for spectating) |
| `leave-lobby` | Leave and remove player from lobby (waiting/pre-game) |
| `update-settings` | Host updates lobby settings |
| `update-lobby-name` | Host renames the lobby |
| `start-game` | Host starts the game |
| `lobby:add-ai-agent` | Host adds an AI agent player while lobby is waiting |
| `kick-player` | Host kicks a player |
| `game:get-state` | Request current game view |
| `game:submit-clue` | Submit clue word + selected card indexes |
| `game:mark-card` | Toggle mark on a card (visual only) |
| `game:guess-card` | Commit a guess on a card |
| `game:quit` | Leave an active game immediately (removes player from game/lobby) |
| `game:send-message` | Send chat message |
| `game:request-rematch` | Host: create rematch lobby; others: join it (payload includes `playerColor` so rematch players can keep their color when available) |

**Server -> Client:**

| Event | Description |
|-------|-------------|
| `lobby-updated` | Lobby state changed (players, settings) |
| `lobby-closed` | Lobby was deleted (host left or kicked) |
| `game-started` | Game has begun, navigate to game page |
| `game-state` | Per-player game view (role-filtered) |
| `game:rematch-closed` | Rematch lobby was closed; hide the join-rematch button |
| `kicked-from-lobby` | You were kicked by the host |

## Project Structure

```text
codename-competition/
  README.md
  words-en.txt              # English word list (one word per line, 25+ required)
  words-de.txt              # German word list
  client/
    src/
      App.jsx               # React Router setup (/, /landing, /lobbies, /lobby/:id, /game/:id)
      styles.css             # All component styles + responsive breakpoints
      styles/tokens.css      # CSS custom properties (colors, spacing, fonts)
      lib/
        api.js              # REST client (fetch wrappers)
        socket.js           # Socket.io client singleton
        i18n.jsx            # I18n context provider + translation maps (en/de)
        gameViewModel.js    # Card CSS class logic + marker name resolution
        session.js          # localStorage read/write for playerId per lobby
      components/
        common/LanguageToggle.jsx   # UI language switcher
        game/StatsChips.jsx         # Colored stat badges (correct/neutral/red/black)
      pages/
        NewLandingPage.jsx  # New homepage: name + private lobby creation + browse button
        LandingPage.jsx     # Legacy lobby browser/history page (mounted at /lobbies)
        LobbyPage.jsx       # Lobby waiting room, settings, player list, invite link
        GamePage.jsx        # Active game board + chat + game-over podium
  server/
    src/
      index.js              # Express server, Socket.io event handlers, phase timers
      store.js              # Lobby CRUD, player management, settings validation
      gameEngine.js         # Game state machine, board gen, scoring, chat, view payloads
```

## Where Logic Lives

- **Lobby management & validation:** `server/src/store.js` — create/join/leave/kick, settings validation with range checks
- **Game state machine:** `server/src/gameEngine.js` — board generation (random card placement), round lifecycle, clue submission, guess resolution, scoring algorithm, chat management, per-player view filtering (clue giver sees all, guesser sees own state, spectator sees reveal)
- **Orchestration & timers:** `server/src/index.js` — HTTP routes, Socket.io event wiring, phase timeout scheduling (clue → guess → round-end → next round), game state broadcasting
- **Client state:** GamePage holds game state received from `game-state` socket events; no client-side game logic beyond UI interaction (mark/guess/submit)

## Language Features

### Board Word Language (per lobby)

Words loaded from `words-en.txt` / `words-de.txt` at server startup. Host selects language in lobby settings. The server uses the selected file when generating each round's board.

### UI Language (per browser)

Global toggle in top-right corner. Switches all interface text between English and German. Stored in `localStorage` (`uiLanguage` key). Falls back to English for missing keys.

## Troubleshooting

- **`EADDRINUSE:3001`** — Another server process is running. Stop it or free port 3001.
- **Empty/failed build after refactor** — Run `npm run build` in `client/` and `node --check server/src/*.js`.
- **Words not changing by language** — Verify `wordLanguage` is saved in lobby settings before starting. Ensure word files exist with 25+ lines.
- **Player can't rejoin after refresh** — Check that `localStorage` has the `lobbyPlayers` entry for that lobby. The server keeps the player slot on disconnect; only explicit `leave-lobby` removes it.
- **Past games missing** — Check that `localStorage` still contains the same `browserId`; clearing site storage creates a new browser identity.
- **Game state not updating** — Verify the socket is connected and joined to the correct lobby room. Check browser console for socket errors.
- **Deploy fails with missing Claude token file** — Create `/home/pi/.claude-oauth` and place only the OAuth token string in the file (no `export`, no quotes), then rerun `deploy-pi.sh`.
- **Claude runs manually but fails in systemd service** — Ensure the generated service has `ProtectHome=false` so the runtime user can access home-based Claude auth/config files.

## Notes

- If the server restarts during an active game, that active game is lost.
- Finished games are archived in SQLite and can be reloaded from `Past Games` for participating browsers.
- Private lobbies are not visible in the public list but are joinable via invite link.
- The rematch flow creates a new private lobby with cloned settings; the old game is not reused.
- Spectators join by navigating to a game URL without a stored `playerId` for that lobby.
