const http = require("http");
const express = require("express");
const cors = require("cors");
const path = require("path");
const { Server } = require("socket.io");
const {
  createLobby,
  getLobby,
  getSerializedLobby,
  joinLobby,
  listPublicLobbies,
  listStartedPublicLobbies,
  markPlayerConnected,
  kickPlayer,
  removePlayer, // used by leave-lobby only
  startGame,
  updateLobbySettings
} = require("./store");
const {
  advanceRound,
  clearGameTimers,
  finishRound,
  getGame,
  getGameViewForPlayer,
  guessCard,
  shouldEndRound,
  startGame: startEngineGame,
  stopGame,
  submitClue,
  transitionClueAllToFirstSubRound,
  toggleMark,
  validateChatMessage,
  appendChatMessage,
  registerChatSend
} = require("./gameEngine");

const PORT = process.env.PORT || 3001;
const GAME_NAME = process.env.GAME_NAME || "wordmine";
const DEBUG = true;
const app = express();
const gameRouter = express.Router();
const clientDist = path.resolve(__dirname, "../../client/dist");

function logDebug(message, payload) {
  if (!DEBUG) return;
  console.log(`[server-debug] ${message}`, payload ?? "");
}

app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  logDebug(`HTTP ${req.method} ${req.path}`, req.body || {});
  next();
});

gameRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

gameRouter.get("/api/lobbies", (_req, res) => {
  const lobbies = listPublicLobbies();
  logDebug("list lobbies", { count: lobbies.length, lobbies });
  res.json({ lobbies });
});

gameRouter.get("/api/games", (_req, res) => {
  const started = listStartedPublicLobbies();
  const games = started.filter((lobby) => {
    const game = getGame(lobby.id);
    return game && game.status !== "finished";
  });
  logDebug("list games", { count: games.length, games });
  res.json({ games });
});

gameRouter.post("/api/lobbies", (req, res) => {
  const result = createLobby(req.body?.name, req.body?.visibility || "public");
  if (result.error) {
    logDebug("create lobby failed", { error: result.error, body: req.body || {} });
    return res.status(400).json({ error: result.error });
  }
  logDebug("created lobby", { lobbyId: result.lobby.id, hostId: result.playerId });
  return res.status(201).json(result);
});

gameRouter.get("/api/lobbies/:id", (req, res) => {
  const lobby = getSerializedLobby(req.params.id);
  if (!lobby) {
    logDebug("get lobby failed", { lobbyId: req.params.id });
    return res.status(404).json({ error: "Lobby not found." });
  }
  const game = getGame(lobby.id);
  const gameStatus = game?.status || null;
  logDebug("get lobby success", { lobbyId: req.params.id, players: lobby.players.length, status: lobby.status });
  return res.json({ lobby, gameStatus });
});

gameRouter.post("/api/lobbies/:id/join", (req, res) => {
  const result = joinLobby(req.params.id, req.body?.name, {
    viaInvite: Boolean(req.body?.viaInvite)
  });
  if (result.error) {
    logDebug("join lobby failed", { lobbyId: req.params.id, error: result.error, body: req.body || {} });
    return res.status(400).json({ error: result.error });
  }
  logDebug("joined lobby", { lobbyId: req.params.id, playerId: result.playerId });
  return res.status(201).json(result);
});

gameRouter.use(express.static(clientDist));
gameRouter.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

app.use(`/${GAME_NAME}`, gameRouter);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  },
  path: `/${GAME_NAME}/socket.io`
});

async function emitGameStateToLobby(lobbyId) {
  const game = getGame(lobbyId);
  if (!game) return;

  const sockets = await io.in(lobbyId).fetchSockets();
  for (const roomSocket of sockets) {
    const playerId = roomSocket.data.playerId;
    const view = getGameViewForPlayer(game, playerId);
    roomSocket.emit("game-state", view);
  }
}

function scheduleGuessTimer(lobbyId) {
  const game = getGame(lobbyId);
  if (!game || !game.round || game.round.phase !== "guess") {
    return;
  }

  if (game.timers.guess) {
    clearTimeout(game.timers.guess);
  }

  const waitMs = Math.max(0, (game.round.guessEndsAt || Date.now()) - Date.now());
  game.timers.guess = setTimeout(async () => {
    const liveGame = getGame(lobbyId);
    if (!liveGame || !liveGame.round || liveGame.round.phase !== "guess") {
      return;
    }
    finishRound(liveGame);
    scheduleRoundEndTimer(lobbyId);
    await emitGameStateToLobby(lobbyId);
  }, waitMs);
}

function scheduleClueTimer(lobbyId) {
  const game = getGame(lobbyId);
  if (game?.config?.simultaneousClue) {
    scheduleClueAllTimer(lobbyId);
    return;
  }
  if (!game || !game.round || game.round.phase !== "clue") {
    return;
  }

  // -1 or 0 means unlimited clue time.
  if ((game.config?.cluePhaseSeconds || 0) <= 0) {
    return;
  }

  if (game.timers.clue) {
    clearTimeout(game.timers.clue);
  }

  game.timers.clue = setTimeout(async () => {
    const liveGame = getGame(lobbyId);
    if (!liveGame || !liveGame.round || liveGame.round.phase !== "clue") {
      return;
    }
    finishRound(liveGame);
    scheduleRoundEndTimer(lobbyId);
    await emitGameStateToLobby(lobbyId);
  }, Math.max(0, game.config.cluePhaseSeconds * 1000));
}

function scheduleClueAllTimer(lobbyId) {
  const game = getGame(lobbyId);
  if (!game?.round || game.round.phase !== "clue-all") return;
  if ((game.config?.cluePhaseSeconds || 0) <= 0) return;

  if (game.timers.clue) {
    clearTimeout(game.timers.clue);
  }

  const waitMs = Math.max(0, (game.round.clueAllEndsAt || Date.now()) - Date.now());
  game.timers.clue = setTimeout(async () => {
    const liveGame = getGame(lobbyId);
    if (!liveGame?.round || liveGame.round.phase !== "clue-all") return;
    const result = transitionClueAllToFirstSubRound(liveGame);
    if (result.skippedToRoundEnd) {
      scheduleRoundEndTimer(lobbyId);
    } else {
      scheduleGuessTimer(lobbyId);
    }
    await emitGameStateToLobby(lobbyId);
  }, waitMs);
}

function scheduleRoundEndTimer(lobbyId) {
  const game = getGame(lobbyId);
  if (!game || !game.round || game.round.phase !== "round-end") {
    return;
  }

  if (game.timers.roundEnd) {
    clearTimeout(game.timers.roundEnd);
  }

  const waitMs = Math.max(0, (game.round.roundEndEndsAt || Date.now()) - Date.now());
  game.timers.roundEnd = setTimeout(async () => {
    const liveGame = getGame(lobbyId);
    if (!liveGame || !liveGame.round || liveGame.round.phase !== "round-end") {
      return;
    }

    const result = advanceRound(liveGame);
    if (result.error || result.finishedGame) {
      await emitGameStateToLobby(lobbyId);
      return;
    }

    if (result.newBoard === false) {
      scheduleGuessTimer(lobbyId);
    } else {
      scheduleClueTimer(lobbyId);
    }
    await emitGameStateToLobby(lobbyId);
  }, waitMs);
}

io.on("connection", (socket) => {
  logDebug("socket connected", { socketId: socket.id });
  socket.on("join-lobby", (payload, ack) => {
    const lobbyId = payload?.lobbyId;
    const playerId = payload?.playerId;

    const lobby = getLobby(lobbyId);
    if (!lobby) {
      logDebug("join-lobby failed", { socketId: socket.id, lobbyId, playerId, reason: "Lobby not found" });
      if (ack) ack({ ok: false, error: "Lobby not found." });
      return;
    }

    if (!playerId) {
      if (lobby.status !== "started") {
        if (ack) ack({ ok: false, error: "Game not started." });
        return;
      }
      socket.join(lobbyId);
      socket.data.lobbyId = lobbyId;
      socket.data.playerId = null;
      logDebug("join-lobby spectator", { socketId: socket.id, lobbyId });
      if (ack) ack({ ok: true, lobby: getSerializedLobby(lobbyId) });
      return;
    }

    const player = lobby.players.find((p) => p.id === playerId);
    if (!player) {
      logDebug("join-lobby failed", { socketId: socket.id, lobbyId, playerId, reason: "Player not in lobby" });
      if (ack) ack({ ok: false, error: "Player is not in this lobby." });
      return;
    }

    socket.join(lobbyId);
    socket.data.lobbyId = lobbyId;
    socket.data.playerId = playerId;

    const updated = markPlayerConnected(lobbyId, playerId, true);
    logDebug("join-lobby success", { socketId: socket.id, lobbyId, playerId });
    io.to(lobbyId).emit("lobby-updated", updated);
    if (ack) ack({ ok: true, lobby: updated });
  });

  socket.on("update-settings", (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const result = updateLobbySettings(lobbyId, playerId, payload?.settings || {});

    if (result.error) {
      logDebug("update-settings failed", { socketId: socket.id, lobbyId, playerId, error: result.error });
      if (ack) ack({ ok: false, error: result.error });
      return;
    }

    logDebug("update-settings success", { socketId: socket.id, lobbyId, playerId, settings: payload?.settings || {} });
    io.to(lobbyId).emit("lobby-updated", result.lobby);
    if (ack) ack({ ok: true, lobby: result.lobby });
  });

  socket.on("start-game", (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const result = startGame(lobbyId, playerId);

    if (result.error) {
      logDebug("start-game failed", { socketId: socket.id, lobbyId, playerId, error: result.error });
      if (ack) ack({ ok: false, error: result.error });
      return;
    }

    const engineStart = startEngineGame(result.lobby);
    if (engineStart.error) {
      if (ack) ack({ ok: false, error: engineStart.error });
      return;
    }

    logDebug("start-game success", { socketId: socket.id, lobbyId, playerId });
    io.to(lobbyId).emit("lobby-updated", result.lobby);
    io.to(lobbyId).emit("game-started", { lobbyId });
    scheduleClueTimer(lobbyId);
    emitGameStateToLobby(lobbyId);
    if (ack) ack({ ok: true, lobby: result.lobby });
  });

  socket.on("game:get-state", async (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const game = getGame(lobbyId);
    if (!game) {
      if (ack) ack({ ok: false, error: "Game not started." });
      return;
    }

    const view = getGameViewForPlayer(game, playerId);
    if (ack) ack({ ok: true, game: view });
  });

  socket.on("game:submit-clue", async (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const game = getGame(lobbyId);
    const result = submitClue(game, playerId, payload || {});
    if (result.error) {
      if (ack) ack({ ok: false, error: result.error });
      return;
    }

    if (game?.config?.simultaneousClue) {
      if (result.allSubmitted) {
        if (game?.timers?.clue) {
          clearTimeout(game.timers.clue);
          game.timers.clue = null;
        }
        const transitionResult = transitionClueAllToFirstSubRound(game);
        if (transitionResult.skippedToRoundEnd) {
          scheduleRoundEndTimer(lobbyId);
        } else {
          scheduleGuessTimer(lobbyId);
        }
      }
      await emitGameStateToLobby(lobbyId);
      if (ack) ack({ ok: true });
      return;
    }

    scheduleGuessTimer(lobbyId);
    const gameAfterClue = getGame(lobbyId);
    if (gameAfterClue?.timers?.clue) {
      clearTimeout(gameAfterClue.timers.clue);
      gameAfterClue.timers.clue = null;
    }
    await emitGameStateToLobby(lobbyId);
    if (ack) ack({ ok: true });
  });

  socket.on("game:send-message", async (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const game = getGame(lobbyId);
    const result = validateChatMessage(game, playerId, payload?.message);
    if (result.error) {
      if (ack) ack({ ok: false, error: result.error });
      return;
    }

    const player = game.players.find((p) => p.id === playerId);
    appendChatMessage(game, {
      id: playerId ? `${playerId}-${Date.now()}` : String(Date.now()),
      at: Date.now(),
      playerId,
      name: player?.name || "Player",
      color: player?.color || null,
      type: "user",
      text: result.cleaned
    });
    registerChatSend(game, playerId);
    await emitGameStateToLobby(lobbyId);
    if (ack) ack({ ok: true });
  });

  socket.on("game:mark-card", async (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const game = getGame(lobbyId);
    const result = toggleMark(game, playerId, payload?.cardIndex);
    if (result.error) {
      if (ack) ack({ ok: false, error: result.error });
      return;
    }

    await emitGameStateToLobby(lobbyId);
    if (ack) ack({ ok: true });
  });

  socket.on("game:guess-card", async (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const game = getGame(lobbyId);
    const result = guessCard(game, playerId, payload?.cardIndex);
    if (result.error) {
      if (ack) ack({ ok: false, error: result.error });
      return;
    }

    if (shouldEndRound(game)) {
      finishRound(game);
      clearGameTimers(game);
      scheduleRoundEndTimer(lobbyId);
    }

    await emitGameStateToLobby(lobbyId);
    if (ack) ack({ ok: true, outcome: result.outcome });
  });

  socket.on("game:request-rematch", async (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const game = getGame(lobbyId);

    if (!game) {
      if (ack) ack({ ok: false, error: "Game not found." });
      return;
    }
    if (game.status !== "finished") {
      if (ack) ack({ ok: false, error: "Game is not finished yet." });
      return;
    }

    const lobby = getLobby(lobbyId);
    if (!lobby) {
      if (ack) ack({ ok: false, error: "Lobby not found." });
      return;
    }

    const player = game.players.find((p) => p.id === playerId);
    if (!player) {
      if (ack) ack({ ok: false, error: "Player not in game." });
      return;
    }

    const isHost = lobby.hostId === playerId;

    if (isHost) {
      // Host creates rematch lobby
      if (game.rematchLobbyId) {
        // Already created — just return it
        if (ack) ack({ ok: true, rematchLobbyId: game.rematchLobbyId, newPlayerId: null });
        return;
      }

      const clonedSettings = {
        visibility: "private",
        gameConfig: { ...game.config }
      };
      const result = createLobby(player.name, "private", clonedSettings);
      if (result.error) {
        if (ack) ack({ ok: false, error: result.error });
        return;
      }

      game.rematchLobbyId = result.lobby.id;
      logDebug("rematch lobby created", { oldLobbyId: lobbyId, newLobbyId: result.lobby.id });

      // Broadcast to all players so they see the rematch button
      await emitGameStateToLobby(lobbyId);

      if (ack) ack({ ok: true, rematchLobbyId: result.lobby.id, newPlayerId: result.playerId });
    } else {
      // Non-host joins existing rematch lobby
      if (!game.rematchLobbyId) {
        if (ack) ack({ ok: false, error: "Host has not created a rematch lobby yet." });
        return;
      }

      const joinResult = joinLobby(game.rematchLobbyId, player.name, { viaInvite: true });
      if (joinResult.error) {
        if (ack) ack({ ok: false, error: joinResult.error });
        return;
      }

      logDebug("player joined rematch", { player: player.name, newLobbyId: game.rematchLobbyId });

      // Notify the rematch lobby about the new player
      io.to(game.rematchLobbyId).emit("lobby-updated", joinResult.lobby);

      if (ack) ack({ ok: true, rematchLobbyId: game.rematchLobbyId, newPlayerId: joinResult.playerId });
    }
  });

  socket.on("kick-player", async (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const hostId = payload?.playerId || socket.data.playerId;
    const targetPlayerId = payload?.targetPlayerId;

    const result = kickPlayer(lobbyId, hostId, targetPlayerId);
    if (result.error) {
      if (ack) ack({ ok: false, error: result.error });
      return;
    }

    const sockets = await io.in(lobbyId).fetchSockets();
    for (const roomSocket of sockets) {
      if (roomSocket.data.playerId === targetPlayerId) {
        roomSocket.emit("kicked-from-lobby", { lobbyId });
        roomSocket.leave(lobbyId);
        roomSocket.data.lobbyId = null;
        roomSocket.data.playerId = null;
      }
    }

    if (result.removedLobby) {
      stopGame(lobbyId);
      io.to(lobbyId).emit("lobby-closed");
    } else if (result.lobby) {
      io.to(lobbyId).emit("lobby-updated", result.lobby);
    }

    if (ack) ack({ ok: true });
  });

  socket.on("leave-lobby", (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;

    if (!lobbyId || !playerId) {
      logDebug("leave-lobby failed", { socketId: socket.id, lobbyId, playerId, reason: "Missing data" });
      if (ack) ack({ ok: false, error: "Missing lobby or player." });
      return;
    }

    const result = removePlayer(lobbyId, playerId);
    logDebug("leave-lobby processed", {
      socketId: socket.id,
      lobbyId,
      playerId,
      removedLobby: result.removedLobby
    });
    socket.leave(lobbyId);
    socket.data.lobbyId = null;
    socket.data.playerId = null;

    if (result.removedLobby) {
      stopGame(lobbyId);
      io.to(lobbyId).emit("lobby-closed");
    } else if (result.lobby) {
      io.to(lobbyId).emit("lobby-updated", result.lobby);
    }

    if (ack) ack({ ok: true });
  });

  socket.on("disconnect", () => {
    const lobbyId = socket.data.lobbyId;
    const playerId = socket.data.playerId;
    logDebug("socket disconnected", { socketId: socket.id, lobbyId, playerId });

    if (!lobbyId || !playerId) {
      return;
    }

    // Mark offline only — do not remove the player. Removal only happens on explicit leave-lobby.
    // This allows players to reload the page and reconnect without losing their place.
    const updated = markPlayerConnected(lobbyId, playerId, false);
    logDebug("disconnect cleanup", { socketId: socket.id, lobbyId, playerId });
    if (updated) {
      io.to(lobbyId).emit("lobby-updated", updated);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
