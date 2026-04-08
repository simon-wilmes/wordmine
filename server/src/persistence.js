const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

const SCHEMA_VERSION = 1;
const MINIMUM_READABLE_VERSION = 1;

let db = null;
let retentionDays = 90;

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error("Database not initialized."));
      return;
    }
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error("Database not initialized."));
      return;
    }
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows || []);
    });
  });
}

function openDb(dbPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    const handle = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(handle);
    });
  });
}

async function withTransaction(work) {
  await run("BEGIN");
  try {
    const result = await work();
    await run("COMMIT");
    return result;
  } catch (error) {
    try {
      await run("ROLLBACK");
    } catch {
      // Ignore rollback failures to preserve original error.
    }
    throw error;
  }
}

function serializeArchive(game, lobby, finishedAt) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    minimumReadableVersion: MINIMUM_READABLE_VERSION,
    gameId: game.id,
    lobbyId: game.lobbyId,
    lobbyName: lobby?.name || null,
    visibility: lobby?.settings?.visibility || "private",
    status: "finished",
    createdAt: Number(game.createdAt || finishedAt),
    finishedAt,
    totalRounds: Number(game.totalRounds || 0),
    roundNumber: Number(game.roundNumber || 0),
    config: { ...(game.config || {}) },
    hostId: game.hostId || null,
    players: (game.players || []).map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color || null
    })),
    scores: (game.players || []).map((p) => ({
      playerId: p.id,
      name: p.name,
      color: p.color || null,
      total: Number(game.scores?.[p.id]?.total || 0),
      rounds: [...(game.scores?.[p.id]?.rounds || [])]
    })),
    playerStats: (game.players || []).map((p) => {
      const stat = game.playerStats?.[p.id] || {
        correctGreen: 0,
        neutralGreen: 0,
        red: 0,
        black: 0
      };
      return {
        playerId: p.id,
        name: p.name,
        correctGreen: Number(stat.correctGreen || 0),
        neutralGreen: Number(stat.neutralGreen || 0),
        red: Number(stat.red || 0),
        black: Number(stat.black || 0),
        totalGuessed: Number(stat.correctGreen || 0)
          + Number(stat.neutralGreen || 0)
          + Number(stat.red || 0)
          + Number(stat.black || 0)
      };
    }),
    roundSnapshots: [...(game.roundSnapshots || [])]
  };

  return payload;
}

function normalizeBrowserId(value) {
  if (!value) return "";
  const normalized = String(value).trim();
  if (!normalized) return "";
  if (normalized.length < 16 || normalized.length > 128) {
    return "";
  }
  return normalized;
}

function normalizeUserCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{128}$/.test(normalized)) {
    return "";
  }
  return normalized;
}

function normalizeUsername(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(normalized)) {
    return "";
  }
  return normalized;
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

async function isIdentityCodeTaken(code) {
  const normalized = normalizeUserCode(code);
  if (!normalized) return true;

  const rows = await all(
    `
    SELECT 1 AS found FROM users WHERE user_code = ?
    UNION
    SELECT 1 AS found FROM user_guest_codes WHERE guest_code = ?
    UNION
    SELECT 1 AS found FROM game_participants WHERE browser_id = ?
    LIMIT 1
    `,
    [normalized, normalized, normalized]
  );
  return rows.length > 0;
}

async function generateUniqueUserCode(maxAttempts = 12) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = randomHex(64);
    // eslint-disable-next-line no-await-in-loop
    const taken = await isIdentityCodeTaken(candidate);
    if (!taken) {
      return candidate;
    }
  }
  throw new Error("Could not generate a unique identity code.");
}

async function pruneExpiredSessions(now = Date.now()) {
  if (!db) return { deletedSessions: 0 };
  const result = await run("DELETE FROM sessions WHERE expires_at < ?", [Number(now)]);
  return { deletedSessions: Number(result.changes || 0) };
}

function mapArchiveSummary(row, payload) {
  const scores = [...(payload.scores || [])].sort((a, b) => Number(b.total || 0) - Number(a.total || 0));
  const winner = scores[0] || null;
  return {
    gameId: row.game_id,
    lobbyId: row.lobby_id,
    lobbyName: row.lobby_name || payload.lobbyName || null,
    visibility: row.visibility || payload.visibility || "private",
    status: "finished",
    schemaVersion: Number(row.schema_version || payload.schemaVersion || 0),
    isLegacy: Boolean(row.legacy_reason),
    legacyReason: row.legacy_reason || null,
    createdAt: Number(row.created_at || payload.createdAt || 0),
    finishedAt: Number(row.finished_at || payload.finishedAt || 0),
    totalRounds: Number(payload.totalRounds || 0),
    roundsRecorded: Array.isArray(payload.roundSnapshots) ? payload.roundSnapshots.length : 0,
    playersCount: Array.isArray(payload.players) ? payload.players.length : 0,
    winnerName: winner?.name || null,
    winnerScore: Number(winner?.total || 0)
  };
}

function mapArchiveDetail(row, payload) {
  const isLegacy = Boolean(row.legacy_reason);
  if (isLegacy) {
    return {
      isLegacy: true,
      legacyReason: row.legacy_reason,
      game: {
        lobbyId: row.lobby_id,
        gameId: row.game_id,
        status: "finished",
        phase: "round-end",
        roundNumber: Number(payload.roundNumber || payload.totalRounds || 0),
        totalRounds: Number(payload.totalRounds || 0),
        scores: payload.scores || [],
        playerStats: payload.playerStats || [],
        roundSnapshots: payload.roundSnapshots || [],
        hostId: null,
        rematchLobbyId: null,
        canJoinRematch: false,
        myRematchJoined: false,
        rematchHostConnected: false,
        role: "viewer",
        config: payload.config || {}
      }
    };
  }

  return {
    isLegacy: false,
    legacyReason: null,
    game: {
      lobbyId: payload.lobbyId || row.lobby_id,
      gameId: payload.gameId || row.game_id,
      status: "finished",
      phase: "round-end",
      roundNumber: Number(payload.roundNumber || payload.totalRounds || 0),
      totalRounds: Number(payload.totalRounds || 0),
      scores: payload.scores || [],
      playerStats: payload.playerStats || [],
      roundSnapshots: payload.roundSnapshots || [],
      hostId: null,
      rematchLobbyId: null,
      canJoinRematch: false,
      myRematchJoined: false,
      rematchHostConnected: false,
      role: "viewer",
      config: payload.config || {}
    }
  };
}

function parseArchivePayload(row) {
  try {
    const payload = JSON.parse(row.payload_json || "{}");
    const version = Number(payload.schemaVersion || row.schema_version || 0);
    if (version < MINIMUM_READABLE_VERSION) {
      return {
        payload,
        legacyReason: `Schema version ${version} is below minimum readable version ${MINIMUM_READABLE_VERSION}.`
      };
    }
    if (version > SCHEMA_VERSION) {
      return {
        payload,
        legacyReason: `Schema version ${version} is newer than supported version ${SCHEMA_VERSION}.`
      };
    }
    return { payload, legacyReason: null };
  } catch {
    return {
      payload: {},
      legacyReason: "Stored archive payload is invalid JSON."
    };
  }
}

async function initPersistence(options = {}) {
  const dbPath = options.dbPath
    || process.env.GAME_DB_PATH
    || path.resolve(__dirname, "../data/game-history.sqlite");
  retentionDays = Number(options.retentionDays || process.env.GAME_HISTORY_RETENTION_DAYS || 90);
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    retentionDays = 90;
  }

  db = await openDb(dbPath);
  await run("PRAGMA foreign_keys = ON");

  await run(`
    CREATE TABLE IF NOT EXISTS games (
      game_id TEXT PRIMARY KEY,
      lobby_id TEXT NOT NULL,
      lobby_name TEXT,
      visibility TEXT,
      schema_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      retention_until INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      legacy_reason TEXT DEFAULT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS game_participants (
      game_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      browser_id TEXT NOT NULL,
      user_id TEXT,
      player_name TEXT,
      PRIMARY KEY (game_id, player_id),
      FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE
    )
  `);

  const participantColumns = await all("PRAGMA table_info(game_participants)");
  const hasUserIdColumn = participantColumns.some((row) => row.name === "user_id");
  if (!hasUserIdColumn) {
    await run("ALTER TABLE game_participants ADD COLUMN user_id TEXT");
  }

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      user_code TEXT UNIQUE NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS user_guest_codes (
      user_id TEXT NOT NULL,
      guest_code TEXT NOT NULL UNIQUE,
      linked_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, guest_code),
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    )
  `);

  await run("CREATE INDEX IF NOT EXISTS idx_games_lobby ON games(lobby_id)");
  await run("CREATE INDEX IF NOT EXISTS idx_games_finished_at ON games(finished_at DESC)");
  await run("CREATE INDEX IF NOT EXISTS idx_games_retention_until ON games(retention_until)");
  await run("CREATE INDEX IF NOT EXISTS idx_participants_browser ON game_participants(browser_id, game_id)");
  await run("CREATE INDEX IF NOT EXISTS idx_participants_user ON game_participants(user_id, game_id)");
  await run("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at)");

  await pruneExpiredGames();
  await pruneExpiredSessions();
}

async function pruneExpiredGames(now = Date.now()) {
  if (!db) return { deletedGames: 0 };
  const result = await run("DELETE FROM games WHERE retention_until < ?", [Number(now)]);
  return { deletedGames: Number(result.changes || 0) };
}

async function archiveFinishedGame(game, lobby) {
  if (!db || !game || !game.id || game.status !== "finished") {
    return { archived: false, reason: "skipped" };
  }

  const finishedAt = Date.now();
  const retentionUntil = finishedAt + (retentionDays * 24 * 60 * 60 * 1000);
  const payload = serializeArchive(game, lobby, finishedAt);

  await withTransaction(async () => {
    await run(
      `
      INSERT OR REPLACE INTO games (
        game_id, lobby_id, lobby_name, visibility, schema_version,
        created_at, finished_at, retention_until, payload_json, legacy_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `,
      [
        game.id,
        game.lobbyId,
        payload.lobbyName,
        payload.visibility,
        SCHEMA_VERSION,
        Number(payload.createdAt || finishedAt),
        Number(payload.finishedAt || finishedAt),
        retentionUntil,
        JSON.stringify(payload)
      ]
    );

    await run("DELETE FROM game_participants WHERE game_id = ?", [game.id]);

    for (const player of game.players || []) {
      const browserId = normalizeBrowserId(player.browserId);
      if (!browserId) {
        continue;
      }
      const userId = String(player.userId || "").trim() || null;
      await run(
        `
        INSERT INTO game_participants (game_id, player_id, browser_id, user_id, player_name)
        VALUES (?, ?, ?, ?, ?)
        `,
        [game.id, player.id, browserId, userId, player.name || null]
      );
    }
  });

  return {
    archived: true,
    gameId: game.id,
    lobbyId: game.lobbyId,
    finishedAt
  };
}

async function listHistoryForBrowser(browserId, options = {}) {
  const normalizedBrowserId = normalizeBrowserId(browserId);
  if (!normalizedBrowserId) {
    return { games: [] };
  }

  const limit = Math.min(100, Math.max(1, Number(options.limit || 30)));
  const offset = Math.max(0, Number(options.offset || 0));
  const rows = await all(
    `
    SELECT DISTINCT g.*
    FROM games g
    INNER JOIN game_participants gp ON gp.game_id = g.game_id
    WHERE gp.browser_id = ?
    ORDER BY g.finished_at DESC
    LIMIT ? OFFSET ?
    `,
    [normalizedBrowserId, limit, offset]
  );

  const games = rows.map((row) => {
    const { payload, legacyReason } = parseArchivePayload(row);
    const merged = {
      ...row,
      legacy_reason: row.legacy_reason || legacyReason || null
    };
    return mapArchiveSummary(merged, payload);
  });

  return { games };
}

async function getHistoryGameForBrowser(browserId, lobbyId) {
  const normalizedBrowserId = normalizeBrowserId(browserId);
  if (!normalizedBrowserId || !lobbyId) {
    return null;
  }

  const rows = await all(
    `
    SELECT g.*
    FROM games g
    INNER JOIN game_participants gp ON gp.game_id = g.game_id
    WHERE gp.browser_id = ? AND g.lobby_id = ?
    ORDER BY g.finished_at DESC
    LIMIT 1
    `,
    [normalizedBrowserId, String(lobbyId)]
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  const { payload, legacyReason } = parseArchivePayload(row);
  const merged = {
    ...row,
    legacy_reason: row.legacy_reason || legacyReason || null
  };
  return mapArchiveDetail(merged, payload);
}

async function listHistoryForUser(userId, options = {}) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    return { games: [] };
  }

  const limit = Math.min(100, Math.max(1, Number(options.limit || 30)));
  const offset = Math.max(0, Number(options.offset || 0));
  const rows = await all(
    `
    SELECT DISTINCT g.*
    FROM games g
    INNER JOIN game_participants gp ON gp.game_id = g.game_id
    WHERE gp.user_id = ?
    ORDER BY g.finished_at DESC
    LIMIT ? OFFSET ?
    `,
    [normalizedUserId, limit, offset]
  );

  const games = rows.map((row) => {
    const { payload, legacyReason } = parseArchivePayload(row);
    const merged = {
      ...row,
      legacy_reason: row.legacy_reason || legacyReason || null
    };
    return mapArchiveSummary(merged, payload);
  });

  return { games };
}

async function getHistoryGameForUser(userId, lobbyId) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId || !lobbyId) {
    return null;
  }

  const rows = await all(
    `
    SELECT g.*
    FROM games g
    INNER JOIN game_participants gp ON gp.game_id = g.game_id
    WHERE gp.user_id = ? AND g.lobby_id = ?
    ORDER BY g.finished_at DESC
    LIMIT 1
    `,
    [normalizedUserId, String(lobbyId)]
  );

  const row = rows[0];
  if (!row) {
    return null;
  }

  const { payload, legacyReason } = parseArchivePayload(row);
  const merged = {
    ...row,
    legacy_reason: row.legacy_reason || legacyReason || null
  };
  return mapArchiveDetail(merged, payload);
}

async function createUser({ username, passwordHash, passwordSalt, userCode }) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedUserCode = normalizeUserCode(userCode);
  if (!normalizedUsername || !passwordHash || !passwordSalt || !normalizedUserCode) {
    throw new Error("Invalid user fields.");
  }

  const now = Date.now();
  const userId = randomHex(16);
  await run(
    `
    INSERT INTO users (user_id, user_code, username, password_hash, password_salt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [userId, normalizedUserCode, normalizedUsername, String(passwordHash), String(passwordSalt), now, now]
  );
  return { userId, username: normalizedUsername, userCode: normalizedUserCode };
}

async function getUserByUsername(username) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) return null;
  const rows = await all(
    "SELECT user_id, user_code, username, password_hash, password_salt, created_at, updated_at FROM users WHERE username = ? LIMIT 1",
    [normalizedUsername]
  );
  return rows[0] || null;
}

async function getUserById(userId) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return null;
  const rows = await all(
    "SELECT user_id, user_code, username, created_at, updated_at FROM users WHERE user_id = ? LIMIT 1",
    [normalizedUserId]
  );
  return rows[0] || null;
}

async function createSession(userId, ttlMs = 14 * 24 * 60 * 60 * 1000) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    throw new Error("userId is required.");
  }
  const now = Date.now();
  const expiresAt = now + Math.max(60_000, Number(ttlMs) || 0);
  const sessionId = randomHex(32);
  await run(
    "INSERT INTO sessions (session_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [sessionId, normalizedUserId, now, expiresAt]
  );
  return { sessionId, userId: normalizedUserId, expiresAt };
}

async function getSession(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return null;
  const rows = await all(
    `
    SELECT s.session_id, s.user_id, s.created_at, s.expires_at, u.username, u.user_code
    FROM sessions s
    INNER JOIN users u ON u.user_id = s.user_id
    WHERE s.session_id = ?
    LIMIT 1
    `,
    [normalizedSessionId]
  );
  const row = rows[0] || null;
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    await run("DELETE FROM sessions WHERE session_id = ?", [normalizedSessionId]);
    return null;
  }
  return row;
}

async function deleteSession(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return;
  await run("DELETE FROM sessions WHERE session_id = ?", [normalizedSessionId]);
}

async function linkGuestCodeToUser(userId, guestCode) {
  const normalizedUserId = String(userId || "").trim();
  const normalizedGuestCode = normalizeBrowserId(guestCode);
  if (!normalizedUserId || !normalizedGuestCode) {
    return { linked: false, reason: "invalid" };
  }

  const existing = await all(
    "SELECT user_id FROM user_guest_codes WHERE guest_code = ? LIMIT 1",
    [normalizedGuestCode]
  );
  if (existing[0] && String(existing[0].user_id) !== normalizedUserId) {
    return { linked: false, reason: "belongs-to-another-user" };
  }

  await run(
    "INSERT OR IGNORE INTO user_guest_codes (user_id, guest_code, linked_at) VALUES (?, ?, ?)",
    [normalizedUserId, normalizedGuestCode, Date.now()]
  );

  return { linked: true };
}

async function backfillHistoryForGuestCode(userId, guestCode) {
  const normalizedUserId = String(userId || "").trim();
  const normalizedGuestCode = normalizeBrowserId(guestCode);
  if (!normalizedUserId || !normalizedGuestCode) {
    return { updatedRows: 0 };
  }
  const result = await run(
    `
    UPDATE game_participants
    SET user_id = ?
    WHERE browser_id = ? AND (user_id IS NULL OR user_id = '')
    `,
    [normalizedUserId, normalizedGuestCode]
  );
  return { updatedRows: Number(result.changes || 0) };
}

module.exports = {
  initPersistence,
  archiveFinishedGame,
  listHistoryForBrowser,
  getHistoryGameForBrowser,
  listHistoryForUser,
  getHistoryGameForUser,
  createUser,
  getUserByUsername,
  getUserById,
  createSession,
  getSession,
  deleteSession,
  pruneExpiredGames,
  pruneExpiredSessions,
  generateUniqueUserCode,
  linkGuestCodeToUser,
  backfillHistoryForGuestCode
};
