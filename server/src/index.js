const http = require("http");
const express = require("express");
const cors = require("cors");
const path = require("path");
const { Server } = require("socket.io");
const {
  createLobby,
  addAIAgent,
  getLobby,
  getSerializedLobby,
  joinLobby,
  listPublicLobbies,
  listStartedPublicLobbies,
  markPlayerConnected,
  kickPlayer,
  removePlayer,
  removePlayerFromStartedLobby,
  startGame,
  updateLobbyName,
  updateLobbySettings
} = require("./store");
const {
  advanceRound,
  clearGameTimers,
  finishRound,
  getGame,
  getGameViewForPlayer,
  guessCard,
  markTimedOutGuessers,
  shouldEndRound,
  startGame: startEngineGame,
  stopGame,
  submitClue,
  transitionClueAllToFirstSubRound,
  toggleMark,
  validateChatMessage,
  appendChatMessage,
  registerChatSend,
  removePlayerFromActiveGame,
  markPlayerReadyForNextPhase
} = require("./gameEngine");
const {
  archiveFinishedGame,
  getHistoryGameForBrowser,
  initPersistence,
  listHistoryForBrowser,
  pruneExpiredGames
} = require("./persistence");
const { generateAIAgentClueAttempt, generateAIAgentGuessPlan } = require("./llmClueService");

const PORT = process.env.PORT || 3001;
const GAME_NAME = process.env.GAME_NAME || "wordmine";
const HISTORY_RETENTION_DAYS = Number(process.env.GAME_HISTORY_RETENTION_DAYS || 90);
const HISTORY_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEBUG = String(process.env.SERVER_DEBUG || "false").toLowerCase() === "true";
const HTTP_DEBUG_THROTTLE_MS = Number(process.env.SERVER_DEBUG_HTTP_THROTTLE_MS || 20000);
const app = express();
const gameRouter = express.Router();
const clientDist = path.resolve(__dirname, "../../client/dist");
const httpDebugLastLogAt = new Map();

function logDebug(message, payload) {
  if (!DEBUG) return;
  console.log(`[server-debug] ${message}`, payload ?? "");
}

function logHttpDebug(method, pathName, payload) {
  if (!DEBUG) return;
  const key = `${String(method || "").toUpperCase()} ${pathName}`;
  const now = Date.now();
  const lastAt = httpDebugLastLogAt.get(key) || 0;
  if (now - lastAt < Math.max(0, HTTP_DEBUG_THROTTLE_MS)) {
    return;
  }
  httpDebugLastLogAt.set(key, now);
  console.log(`[server-debug] HTTP ${key}`, payload ?? {});
}

function logLLM(message, payload) {
  console.log(`[llm-clue] ${message}`, payload ?? "");
}

function logLLMText(title, value) {
  const text = String(value || "");
  console.log(`[llm-clue] ${title}\n${text}`);
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  logHttpDebug(req.method, req.path, req.body || {});
  next();
});

// Canonicalize the game base URL so clients always load from /<game>/.
app.get(`/${GAME_NAME}`, (req, res) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, `/${GAME_NAME}/${query}`);
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

gameRouter.get("/api/games/history", async (req, res) => {
  const browserId = String(req.query?.browserId || "").trim();
  if (!browserId) {
    return res.status(400).json({ error: "browserId is required." });
  }

  const limit = Number(req.query?.limit || 30);
  const offset = Number(req.query?.offset || 0);

  try {
    const history = await listHistoryForBrowser(browserId, { limit, offset });
    return res.json(history);
  } catch (error) {
    console.error("[history] list failed", error);
    return res.status(500).json({ error: "Could not load game history." });
  }
});

gameRouter.get("/api/games/history/:id", async (req, res) => {
  const browserId = String(req.query?.browserId || "").trim();
  if (!browserId) {
    return res.status(400).json({ error: "browserId is required." });
  }

  try {
    const detail = await getHistoryGameForBrowser(browserId, req.params.id);
    if (!detail) {
      return res.status(404).json({ error: "Historical game not found." });
    }
    return res.json(detail);
  } catch (error) {
    console.error("[history] detail failed", error);
    return res.status(500).json({ error: "Could not load historical game." });
  }
});

gameRouter.post("/api/lobbies", (req, res) => {
  const result = createLobby(
    req.body?.name,
    req.body?.visibility || "public",
    null,
    req.body?.lobbyName || null,
    null,
    req.body?.browserId || ""
  );
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
    viaInvite: Boolean(req.body?.viaInvite),
    browserId: req.body?.browserId || ""
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
    const viewWithRematch = addRematchMetaToView(game, playerId, view);
    roomSocket.emit("game-state", viewWithRematch);
  }
}

function getRematchHostConnected(game) {
  if (!game?.rematchLobbyId) return false;
  const rematchLobby = getLobby(game.rematchLobbyId);
  if (!rematchLobby?.hostId) return false;
  const rematchHost = rematchLobby.players.find((p) => p.id === rematchLobby.hostId);
  return Boolean(rematchHost?.connected);
}

function addRematchMetaToView(game, playerId, view) {
  if (!view) return view;

  const myRematchJoined = Boolean(playerId && game.rematchJoinedByPlayerId?.[playerId]);
  const rematchHostConnected = getRematchHostConnected(game);
  const canJoinRematch = Boolean(
    game.rematchLobbyId
    && playerId
    && !myRematchJoined
    && rematchHostConnected
  );

  return {
    ...view,
    lobbyId: game.lobbyId,
    myRematchJoined,
    rematchHostConnected,
    canJoinRematch
  };
}

async function clearRematchIfNeeded(removedLobbyDetails) {
  const rematchSourceLobbyId = removedLobbyDetails?.rematchSourceLobbyId;
  const rematchLobbyId = removedLobbyDetails?.id;
  if (!rematchSourceLobbyId || !rematchLobbyId) {
    return;
  }

  const sourceGame = getGame(rematchSourceLobbyId);
  if (!sourceGame || sourceGame.rematchLobbyId !== rematchLobbyId) {
    return;
  }

  sourceGame.rematchLobbyId = null;
  io.to(rematchSourceLobbyId).emit("game:rematch-closed", {
    lobbyId: rematchSourceLobbyId,
    rematchLobbyId
  });
  await emitGameStateToLobby(rematchSourceLobbyId);
}

async function archiveFinishedGameForLobby(lobbyId) {
  const game = getGame(lobbyId);
  if (!game || game.status !== "finished" || game.archivedAt) {
    return;
  }

  const lobby = getLobby(lobbyId) || null;
  try {
    const archived = await archiveFinishedGame(game, lobby);
    if (archived?.archived) {
      game.archivedAt = archived.finishedAt;
    }
  } catch (error) {
    console.error("[history] archive failed", { lobbyId, gameId: game.id, error });
  }
}

function isAIGiverTurn(game) {
  const round = game?.round;
  if (!game || !round || round.phase !== "clue") return false;
  if (game.config?.simultaneousClue) return false;
  const clueGiver = game.players.find((p) => p.id === round.clueGiverId);
  return Boolean(clueGiver?.isAI);
}

function getAIGuesserIds(game) {
  const round = game?.round;
  if (!game || !round || round.phase !== "guess") return [];
  return round.guesserIds.filter((id) => {
    const player = game.players.find((p) => p.id === id);
    const guesser = round.guessers?.[id];
    return Boolean(player?.isAI && guesser && !guesser.finished);
  });
}

function formatGuesserHistory(round) {
  if (!round?.board?.cards) return "";
  const cardByIndex = new Map(round.board.cards.map((card) => [card.index, card]));
  const entries = [];
  for (const idx of round?.clueSelectedIndexes || []) {
    const card = cardByIndex.get(idx);
    if (card) entries.push(`${card.word}: target-green`);
  }
  return entries.join(", ");
}

function formatOwnClicks(round, guesserId) {
  const guesser = round?.guessers?.[guesserId];
  if (!guesser) return "none";
  const cardByIndex = new Map((round?.board?.cards || []).map((card) => [card.index, card]));
  const out = [];
  for (const idx of guesser.guessedCorrect || []) {
    const card = cardByIndex.get(idx);
    if (card) out.push(`${card.word}: target-green`);
  }
  for (const idx of guesser.guessedNeutral || []) {
    const card = cardByIndex.get(idx);
    if (card) out.push(`${card.word}: non-target-green`);
  }
  for (const idx of guesser.guessedWrongRed || []) {
    const card = cardByIndex.get(idx);
    if (card) out.push(`${card.word}: red`);
  }
  for (const idx of guesser.guessedWrongBlack || []) {
    const card = cardByIndex.get(idx);
    if (card) out.push(`${card.word}: black`);
  }
  return out.length > 0 ? out.join(", ") : "none";
}

function setAIGuesserStop(round, guesserId, reason = "ai-stop") {
  const guesser = round?.guessers?.[guesserId];
  if (!guesser || guesser.finished) return;
  guesser.finished = true;
  guesser.finishReason = reason;
}

function clearClueTimersForGame(game) {
  if (!game?.timers) return;
  if (game.timers.clue) {
    clearTimeout(game.timers.clue);
    game.timers.clue = null;
  }
  if (game.timers.clueGrace) {
    clearTimeout(game.timers.clueGrace);
    game.timers.clueGrace = null;
  }
}

async function runAIAgentClueTurn(lobbyId) {
  const game = getGame(lobbyId);
  if (!isAIGiverTurn(game)) return;
  const round = game.round;
  if (round.aiClueInProgress || round.aiClueResolved) return;

  round.aiClueInProgress = true;
  const maxAttempts = 3;
  let previousError = "";

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const liveGame = getGame(lobbyId);
      if (!liveGame || liveGame.round !== round || !isAIGiverTurn(liveGame)) {
        return;
      }

      let proposal;
      try {
        proposal = await generateAIAgentClueAttempt({
          game: liveGame,
          lobbyId,
          attempt,
          previousError
        });
      } catch (error) {
        previousError = error?.message || "Claude CLI call failed.";
        logLLM("attempt failed before parse", {
          lobbyId,
          roundNumber: liveGame.roundNumber,
          attempt,
          error: previousError,
          code: error?.code || null
        });
        continue;
      }

      logLLM("attempt meta", proposal.meta);
      logLLMText(`prompt attempt ${attempt}`, proposal.prompt);
      logLLMText(`raw output attempt ${attempt}`, proposal.rawOutput);
      logLLM("parsed attempt", proposal.parsed);

      if (!proposal.ok) {
        previousError = proposal.error;
        logLLM("attempt rejected", {
          lobbyId,
          roundNumber: liveGame.roundNumber,
          attempt,
          reason: proposal.error,
          status: "invalid-proposal"
        });
        continue;
      }

      logLLM("submit payload", {
        lobbyId,
        roundNumber: liveGame.roundNumber,
        attempt,
        clue: proposal.payload.clue,
        clueCount: proposal.payload.clueCount,
        selectedIndexes: proposal.payload.selectedIndexes
      });

      const minRevealAt = Number(liveGame.round?.phaseStartedAt || Date.now()) + 5000;
      const delayMs = Math.max(0, minRevealAt - Date.now());
      if (delayMs > 0) {
        logLLM("minimum clue delay", {
          lobbyId,
          roundNumber: liveGame.roundNumber,
          waitMs: delayMs,
          status: "waiting-before-reveal"
        });
        await sleep(delayMs);
      }

      const latestBeforeSubmit = getGame(lobbyId);
      if (!latestBeforeSubmit || latestBeforeSubmit.round !== round || latestBeforeSubmit.round.phase !== "clue") {
        return;
      }

      const delayedSubmit = submitClue(latestBeforeSubmit, latestBeforeSubmit.round.clueGiverId, proposal.payload);
      if (delayedSubmit.error) {
        previousError = delayedSubmit.error;
        logLLM("attempt rejected by game engine after delay", {
          lobbyId,
          roundNumber: latestBeforeSubmit.roundNumber,
          attempt,
          reason: delayedSubmit.error,
          status: "engine-rejected-after-delay"
        });
        continue;
      }

      clearClueTimersForGame(latestBeforeSubmit);
      scheduleGuessTimer(lobbyId);
      round.aiClueResolved = true;
      logLLM("final status", {
        lobbyId,
        roundNumber: liveGame.roundNumber,
        attempt,
        status: "submitted"
      });
      await emitGameStateToLobby(lobbyId);
      return;
    }

    const latest = getGame(lobbyId);
    if (!latest || latest.round !== round || latest.round.phase !== "clue") {
      return;
    }

    clearClueTimersForGame(latest);
    finishRound(latest);
    scheduleRoundEndTimer(lobbyId);
    round.aiClueResolved = true;
    logLLM("final status", {
      lobbyId,
      roundNumber: latest.roundNumber,
      status: "skipped_after_retries",
      lastError: previousError || null
    });
    await emitGameStateToLobby(lobbyId);
  } finally {
    round.aiClueInProgress = false;
  }
}

async function runSingleAIGuesserTurn(lobbyId, guesserId) {
  const game = getGame(lobbyId);
  if (!game?.round || game.round.phase !== "guess") return { roundEnded: false };
  const round = game.round;
  const guesser = round.guessers?.[guesserId];
  if (!guesser || guesser.finished) return { roundEnded: false };

  round.aiGuessersInProgress = round.aiGuessersInProgress || {};
  if (round.aiGuessersInProgress[guesserId]) {
    return { roundEnded: false };
  }
  round.aiGuessersInProgress[guesserId] = true;

  let feedback = "";
  let previousError = "";
  const maxGuessRetries = 3;
  round.aiGuessRetryCounts = round.aiGuessRetryCounts || {};
  let retryCount = Number(round.aiGuessRetryCounts[guesserId] || 0);

  try {
    while (true) {
      const liveGame = getGame(lobbyId);
      if (!liveGame?.round || liveGame.round !== round || liveGame.round.phase !== "guess") {
        return { roundEnded: false };
      }
      const liveGuesser = liveGame.round.guessers?.[guesserId];
      if (!liveGuesser || liveGuesser.finished) {
        return { roundEnded: false };
      }

      if (retryCount >= maxGuessRetries) {
        setAIGuesserStop(round, guesserId, "ai-plan-failed");
        logLLM("ai guesser stopped", {
          lobbyId,
          roundNumber: liveGame.roundNumber,
          guesserId,
          reason: "retry-limit-reached",
          retries: retryCount
        });
        await emitGameStateToLobby(lobbyId);
        return { roundEnded: false };
      }

      const attempt = retryCount + 1;
      let plan;
      try {
        plan = await generateAIAgentGuessPlan({
          game: liveGame,
          lobbyId,
          guesserId,
          attempt,
          previousError,
          feedback
        });
      } catch (error) {
        retryCount += 1;
        round.aiGuessRetryCounts[guesserId] = retryCount;
        previousError = error?.message || "Guess planning call failed.";
        logLLM("guess planning call failed", {
          lobbyId,
          roundNumber: liveGame.roundNumber,
          guesserId,
          attempt,
          retriesUsed: retryCount,
          reason: previousError,
          code: error?.code || null
        });
        continue;
      }

      logLLM("guess plan meta", plan.meta);
      logLLMText(`guess prompt attempt ${attempt} for ${guesserId}`, plan.prompt);
      logLLMText(`guess raw output attempt ${attempt} for ${guesserId}`, plan.rawOutput);
      logLLM("guess parsed attempt", plan.parsed);

      if (!plan.ok) {
        retryCount += 1;
        round.aiGuessRetryCounts[guesserId] = retryCount;
        previousError = plan.error;
        const parsingIssue = /json|parse|output/i.test(String(plan.error || ""));
        logLLM("guess plan rejected", {
          lobbyId,
          roundNumber: liveGame.roundNumber,
          guesserId,
          attempt,
          retriesUsed: retryCount,
          reason: plan.error,
          parsingIssue
        });
        continue;
      }

      if (!Array.isArray(plan.orderedIndexes) || plan.orderedIndexes.length === 0) {
        setAIGuesserStop(round, guesserId, "ai-stop");
        logLLM("ai guesser stopped", {
          lobbyId,
          roundNumber: liveGame.roundNumber,
          guesserId,
          reason: "empty-plan"
        });
        await emitGameStateToLobby(lobbyId);
        return { roundEnded: false };
      }

      let needsReplanAfterNeutral = false;
      for (const idx of plan.orderedIndexes) {
        const currentGame = getGame(lobbyId);
        if (!currentGame?.round || currentGame.round !== round || currentGame.round.phase !== "guess") {
          return { roundEnded: false };
        }
        const currentGuesser = currentGame.round.guessers?.[guesserId];
        if (!currentGuesser || currentGuesser.finished) {
          return { roundEnded: false };
        }

        const card = currentGame.round.board.cards[idx];
        const result = guessCard(currentGame, guesserId, idx);
        if (result.error) {
          logLLM("ai guess click skipped", {
            lobbyId,
            roundNumber: currentGame.roundNumber,
            guesserId,
            cardIndex: idx,
            reason: result.error
          });
          continue;
        }

        logLLM("ai guess click", {
          lobbyId,
          roundNumber: currentGame.roundNumber,
          guesserId,
          cardIndex: idx,
          word: card?.word || null,
          outcome: result.outcome
        });
        await emitGameStateToLobby(lobbyId);

        if (shouldEndRound(currentGame)) {
          markTimedOutGuessers(currentGame);
          finishRound(currentGame);
          clearGameTimers(currentGame);
          scheduleRoundEndTimer(lobbyId);
          await emitGameStateToLobby(lobbyId);
          return { roundEnded: true };
        }

        if (result.outcome === "neutral") {
          const ownClicks = formatOwnClicks(currentGame.round, guesserId);
          feedback = [
            `Your latest click '${card?.word || idx}' was non-target green.`,
            `Your clicks so far: ${ownClicks}.`,
            `Current target clue cards: ${formatGuesserHistory(currentGame.round)}.`,
            "Update your remaining ordered guesses."
          ].join(" ");
          needsReplanAfterNeutral = true;
          logLLM("ai guess neutral feedback", {
            lobbyId,
            roundNumber: currentGame.roundNumber,
            guesserId,
            feedback
          });
          break;
        }

        if (result.outcome === "red" || result.outcome === "black") {
          break;
        }
      }

      const afterPlanGame = getGame(lobbyId);
      if (!afterPlanGame?.round || afterPlanGame.round !== round || afterPlanGame.round.phase !== "guess") {
        return { roundEnded: false };
      }
      const afterPlanGuesser = afterPlanGame.round.guessers?.[guesserId];
      if (!afterPlanGuesser || afterPlanGuesser.finished) {
        return { roundEnded: false };
      }

      if (needsReplanAfterNeutral) {
        continue;
      }

      // AI returned a finite list; stopping here mirrors a human choosing to stop guessing.
      setAIGuesserStop(round, guesserId, "ai-stop");
      logLLM("ai guesser stopped", {
        lobbyId,
        roundNumber: afterPlanGame.roundNumber,
        guesserId,
        reason: "plan-exhausted"
      });
      await emitGameStateToLobby(lobbyId);
      return { roundEnded: false };
    }
  } finally {
    if (round.aiGuessersInProgress) {
      round.aiGuessersInProgress[guesserId] = false;
    }
  }
}

async function runAIGuesserTurns(lobbyId) {
  const game = getGame(lobbyId);
  if (!game?.round || game.round.phase !== "guess") return;
  const round = game.round;
  if (round.aiGuessCycleInProgress) return;
  round.aiGuessCycleInProgress = true;

  try {
    const guesserIds = getAIGuesserIds(game);
    for (const guesserId of guesserIds) {
      const result = await runSingleAIGuesserTurn(lobbyId, guesserId);
      if (result.roundEnded) {
        return;
      }
      const live = getGame(lobbyId);
      if (!live?.round || live.round !== round || live.round.phase !== "guess") {
        return;
      }
    }

    const latest = getGame(lobbyId);
    if (latest?.round && latest.round === round && latest.round.phase === "guess" && shouldEndRound(latest)) {
      markTimedOutGuessers(latest);
      finishRound(latest);
      clearGameTimers(latest);
      scheduleRoundEndTimer(lobbyId);
      await emitGameStateToLobby(lobbyId);
    }
  } finally {
    round.aiGuessCycleInProgress = false;
  }
}

function triggerAIGuessersIfNeeded(lobbyId) {
  const game = getGame(lobbyId);
  if (!game?.round || game.round.phase !== "guess") return;
  if (getAIGuesserIds(game).length === 0) return;
  runAIGuesserTurns(lobbyId).catch((error) => {
    logLLM("unexpected ai guesser failure", {
      lobbyId,
      error: error?.message || String(error)
    });
  });
}

function triggerAIAgentClueIfNeeded(lobbyId) {
  const game = getGame(lobbyId);
  if (!isAIGiverTurn(game)) return;
  runAIAgentClueTurn(lobbyId).catch((error) => {
    logLLM("unexpected runner failure", {
      lobbyId,
      error: error?.message || String(error)
    });
  });
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
    markTimedOutGuessers(liveGame);
    finishRound(liveGame);
    scheduleRoundEndTimer(lobbyId);
    await emitGameStateToLobby(lobbyId);
  }, waitMs);

  triggerAIGuessersIfNeeded(lobbyId);
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

  // 0 means unlimited clue time.
  if ((game.config?.cluePhaseSeconds || 0) <= 0) {
    triggerAIAgentClueIfNeeded(lobbyId);
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
    // Notify clients that clue time is up — give the clue giver a chance to auto-submit
    io.to(lobbyId).emit("clue-time-up");
    // Fallback: if no submit/cant-submit arrives within 5s, skip the round
    liveGame.timers.clueGrace = setTimeout(async () => {
      const g = getGame(lobbyId);
      if (!g || !g.round || g.round.phase !== "clue") return;
      finishRound(g);
      scheduleRoundEndTimer(lobbyId);
      await emitGameStateToLobby(lobbyId);
    }, 5000);
  }, Math.max(0, game.config.cluePhaseSeconds * 1000));

  triggerAIAgentClueIfNeeded(lobbyId);
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
    await advanceFromRoundEnd(lobbyId);
  }, waitMs);
}

async function advanceFromRoundEnd(lobbyId) {
  const liveGame = getGame(lobbyId);
  if (!liveGame || !liveGame.round || liveGame.round.phase !== "round-end") {
    return;
  }

  const result = advanceRound(liveGame);
  if (result.error || result.finishedGame) {
    if (result.finishedGame) {
      await archiveFinishedGameForLobby(lobbyId);
    }
    await emitGameStateToLobby(lobbyId);
    return;
  }

  if (result.newBoard === false) {
    scheduleGuessTimer(lobbyId);
  } else {
    scheduleClueTimer(lobbyId);
  }
  await emitGameStateToLobby(lobbyId);
}

io.on("connection", (socket) => {
  logDebug("socket connected", { socketId: socket.id });

  async function processActiveGameQuit(lobbyId, playerId, ack) {
    const game = getGame(lobbyId);
    if (!game) {
      if (ack) ack({ ok: false, error: "Game not found." });
      return;
    }

    const gameResult = removePlayerFromActiveGame(game, playerId);
    if (gameResult.error) {
      if (ack) ack({ ok: false, error: gameResult.error });
      return;
    }

    const lobbyResult = removePlayerFromStartedLobby(lobbyId, playerId);
    logDebug("game-quit processed", {
      socketId: socket.id,
      lobbyId,
      playerId,
      endedGame: gameResult.endedGame,
      removedLobby: lobbyResult.removedLobby,
      hostReassignedTo: lobbyResult.hostReassignedTo || null
    });

    socket.leave(lobbyId);
    socket.data.lobbyId = null;
    socket.data.playerId = null;

    if (lobbyResult.removedLobby) {
      clearGameTimers(game);
      stopGame(lobbyId);
      io.to(lobbyId).emit("lobby-closed");
      await clearRematchIfNeeded(lobbyResult.removedLobbyDetails);
      if (ack) ack({ ok: true, endedGame: gameResult.endedGame, finishedReason: game.finishedReason || null });
      return;
    }

    if (lobbyResult.hostReassignedTo) {
      game.hostId = lobbyResult.hostReassignedTo;
    }

    if (lobbyResult.lobby) {
      io.to(lobbyId).emit("lobby-updated", lobbyResult.lobby);
    }

    clearGameTimers(game);
    if (gameResult.endedGame) {
      await archiveFinishedGameForLobby(lobbyId);
    } else if (gameResult.roundEnded) {
      scheduleRoundEndTimer(lobbyId);
    } else if (gameResult.transitionedToGuess) {
      scheduleGuessTimer(lobbyId);
    } else if (game.round?.phase === "clue-all") {
      scheduleClueAllTimer(lobbyId);
    } else if (game.round?.phase === "clue") {
      scheduleClueTimer(lobbyId);
    } else if (game.round?.phase === "guess") {
      scheduleGuessTimer(lobbyId);
    }

    await emitGameStateToLobby(lobbyId);
    if (ack) ack({ ok: true, endedGame: gameResult.endedGame, finishedReason: game.finishedReason || null });
  }

  socket.on("join-lobby", async (payload, ack) => {
    const lobbyId = payload?.lobbyId;
    const playerId = payload?.playerId;

    const previousLobbyId = socket.data.lobbyId;
    const previousPlayerId = socket.data.playerId;
    if (previousLobbyId && previousLobbyId !== lobbyId) {
      socket.leave(previousLobbyId);
      if (previousPlayerId) {
        const previousLobbyUpdated = markPlayerConnected(previousLobbyId, previousPlayerId, false);
        if (previousLobbyUpdated) {
          io.to(previousLobbyId).emit("lobby-updated", previousLobbyUpdated);
        }
      }
      const previousLobby = getLobby(previousLobbyId);
      if (previousLobby?.rematchSourceLobbyId) {
        await emitGameStateToLobby(previousLobby.rematchSourceLobbyId);
      }
    }

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
    if (lobby.rematchSourceLobbyId) {
      await emitGameStateToLobby(lobby.rematchSourceLobbyId);
    }
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

  socket.on("update-lobby-name", (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const result = updateLobbyName(lobbyId, playerId, payload?.name);

    if (result.error) {
      logDebug("update-lobby-name failed", { socketId: socket.id, lobbyId, playerId, error: result.error });
      if (ack) ack({ ok: false, error: result.error });
      return;
    }

    logDebug("update-lobby-name success", { socketId: socket.id, lobbyId, playerId, name: payload?.name });
    io.to(lobbyId).emit("lobby-updated", result.lobby);
    if (ack) ack({ ok: true, lobby: result.lobby });
  });

  socket.on("lobby:add-ai-agent", (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const result = addAIAgent(lobbyId, playerId, payload?.aiPassword || "");

    if (result.error) {
      logDebug("add-ai-agent failed", { socketId: socket.id, lobbyId, playerId, error: result.error });
      if (ack) ack({ ok: false, error: result.error });
      return;
    }

    logDebug("add-ai-agent success", { socketId: socket.id, lobbyId, playerId, aiPlayerId: result.playerId });
    io.to(lobbyId).emit("lobby-updated", result.lobby);
    if (ack) ack({ ok: true, lobby: result.lobby, playerId: result.playerId });
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

    const engineStart = startEngineGame(result.lobbyRaw || result.lobby);
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
    const viewWithRematch = addRematchMetaToView(game, playerId, view);
    if (ack) ack({ ok: true, game: viewWithRematch });
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
    if (gameAfterClue?.timers?.clueGrace) {
      clearTimeout(gameAfterClue.timers.clueGrace);
      gameAfterClue.timers.clueGrace = null;
    }
    await emitGameStateToLobby(lobbyId);
    if (ack) ack({ ok: true });
  });

  socket.on("game:cant-submit-clue", async (payload) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const game = getGame(lobbyId);
    if (!game || !game.round || game.round.phase !== "clue") return;
    if (game.timers.clueGrace) {
      clearTimeout(game.timers.clueGrace);
      game.timers.clueGrace = null;
    }
    finishRound(game);
    scheduleRoundEndTimer(lobbyId);
    await emitGameStateToLobby(lobbyId);
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
      markTimedOutGuessers(game);
      finishRound(game);
      clearGameTimers(game);
      scheduleRoundEndTimer(lobbyId);
    }

    await emitGameStateToLobby(lobbyId);
    if (ack) ack({ ok: true, outcome: result.outcome });
  });

  socket.on("game:ready-next-phase", async (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const game = getGame(lobbyId);
    const result = markPlayerReadyForNextPhase(game, playerId);
    if (result.error) {
      if (ack) ack({ ok: false, error: result.error });
      return;
    }

    if (result.allReady) {
      if (game?.timers?.roundEnd) {
        clearTimeout(game.timers.roundEnd);
        game.timers.roundEnd = null;
      }
      await advanceFromRoundEnd(lobbyId);
      if (ack) ack({ ok: true, advanced: true, readyCount: result.readyCount, readyTarget: result.readyTarget });
      return;
    }

    await emitGameStateToLobby(lobbyId);
    if (ack) ack({ ok: true, advanced: false, readyCount: result.readyCount, readyTarget: result.readyTarget });
  });

  socket.on("game:request-rematch", async (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;
    const playerColor = payload?.playerColor || null;
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
        if (ack) {
          ack({
            ok: true,
            rematchLobbyId: game.rematchLobbyId,
            newPlayerId: game.rematchJoinedByPlayerId?.[playerId] || null
          });
        }
        return;
      }

      const clonedSettings = {
        visibility: "private",
        gameConfig: { ...game.config }
      };
      const result = createLobby(
        player.name,
        "private",
        clonedSettings,
        lobby.name || null,
        playerColor || player.color || null,
        player.browserId || ""
      );
      if (result.error) {
        if (ack) ack({ ok: false, error: result.error });
        return;
      }

      const rematchLobby = getLobby(result.lobby.id);
      if (rematchLobby) {
        rematchLobby.rematchSourceLobbyId = lobbyId;
      }
      game.rematchLobbyId = result.lobby.id;
      game.rematchJoinedByPlayerId[playerId] = result.playerId;
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

      const alreadyJoinedPlayerId = game.rematchJoinedByPlayerId?.[playerId];
      if (alreadyJoinedPlayerId) {
        if (ack) {
          ack({
            ok: true,
            rematchLobbyId: game.rematchLobbyId,
            newPlayerId: alreadyJoinedPlayerId
          });
        }
        return;
      }

      if (!getRematchHostConnected(game)) {
        if (ack) ack({ ok: false, error: "Host is not currently in the rematch lobby." });
        return;
      }

      const joinResult = joinLobby(game.rematchLobbyId, player.name, {
        viaInvite: true,
        preferredColor: playerColor || player.color || null,
        browserId: player.browserId || ""
      });
      if (joinResult.error) {
        if (ack) ack({ ok: false, error: joinResult.error });
        return;
      }

      game.rematchJoinedByPlayerId[playerId] = joinResult.playerId;

      logDebug("player joined rematch", { player: player.name, newLobbyId: game.rematchLobbyId });

      // Notify the rematch lobby about the new player
      io.to(game.rematchLobbyId).emit("lobby-updated", joinResult.lobby);
      await emitGameStateToLobby(lobbyId);

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
      await clearRematchIfNeeded(result.removedLobbyDetails);
    } else if (result.lobby) {
      io.to(lobbyId).emit("lobby-updated", result.lobby);
    }

    if (result.removedLobbyDetails?.rematchSourceLobbyId) {
      await emitGameStateToLobby(result.removedLobbyDetails.rematchSourceLobbyId);
    }

    if (ack) ack({ ok: true });
  });

  socket.on("leave-lobby", async (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;

    if (!lobbyId || !playerId) {
      logDebug("leave-lobby failed", { socketId: socket.id, lobbyId, playerId, reason: "Missing data" });
      if (ack) ack({ ok: false, error: "Missing lobby or player." });
      return;
    }

    const lobby = getLobby(lobbyId);
    if (lobby?.status === "started") {
      await processActiveGameQuit(lobbyId, playerId, ack);
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
      await clearRematchIfNeeded(result.removedLobbyDetails);
    } else if (result.lobby) {
      io.to(lobbyId).emit("lobby-updated", result.lobby);
    }

    if (result.removedLobbyDetails?.rematchSourceLobbyId) {
      await emitGameStateToLobby(result.removedLobbyDetails.rematchSourceLobbyId);
    }

    if (ack) ack({ ok: true });
  });

  socket.on("game:quit", async (payload, ack) => {
    const lobbyId = payload?.lobbyId || socket.data.lobbyId;
    const playerId = payload?.playerId || socket.data.playerId;

    if (!lobbyId || !playerId) {
      if (ack) ack({ ok: false, error: "Missing lobby or player." });
      return;
    }

    const lobby = getLobby(lobbyId);
    if (!lobby) {
      if (ack) ack({ ok: false, error: "Lobby not found." });
      return;
    }

    if (lobby.status !== "started") {
      if (ack) ack({ ok: false, error: "Game is not active." });
      return;
    }

    await processActiveGameQuit(lobbyId, playerId, ack);
  });

  socket.on("disconnect", async () => {
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

      const disconnectedLobby = getLobby(lobbyId);
      if (disconnectedLobby?.rematchSourceLobbyId) {
        await emitGameStateToLobby(disconnectedLobby.rematchSourceLobbyId);
      }
    }
  });
});

async function bootstrap() {
  try {
    await initPersistence({ retentionDays: HISTORY_RETENTION_DAYS });
    setInterval(async () => {
      try {
        await pruneExpiredGames();
      } catch (error) {
        console.error("[history] prune failed", error);
      }
    }, HISTORY_PRUNE_INTERVAL_MS);
  } catch (error) {
    console.error("Failed to initialize persistence", error);
    process.exit(1);
    return;
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

bootstrap();
