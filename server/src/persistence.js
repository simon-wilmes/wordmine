const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

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
      player_name TEXT,
      PRIMARY KEY (game_id, player_id),
      FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE
    )
  `);

  await run("CREATE INDEX IF NOT EXISTS idx_games_lobby ON games(lobby_id)");
  await run("CREATE INDEX IF NOT EXISTS idx_games_finished_at ON games(finished_at DESC)");
  await run("CREATE INDEX IF NOT EXISTS idx_games_retention_until ON games(retention_until)");
  await run("CREATE INDEX IF NOT EXISTS idx_participants_browser ON game_participants(browser_id, game_id)");

  await pruneExpiredGames();
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
      await run(
        `
        INSERT INTO game_participants (game_id, player_id, browser_id, player_name)
        VALUES (?, ?, ?, ?)
        `,
        [game.id, player.id, browserId, player.name || null]
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

module.exports = {
  initPersistence,
  archiveFinishedGame,
  listHistoryForBrowser,
  getHistoryGameForBrowser,
  pruneExpiredGames
};
