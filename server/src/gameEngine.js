const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const activeGames = new Map();

const FALLBACK_WORDS = [
  "bridge", "planet", "forest", "camera", "castle", "rocket", "pirate", "doctor", "puzzle", "island",
  "magnet", "thunder", "window", "garden", "river", "silver", "dragon", "piano", "market", "desert",
  "spider", "coffee", "signal", "orange", "winter", "summer", "autumn", "spring", "jungle", "saturn",
  "mercury", "comet", "hammer", "engine", "singer", "monkey", "viking", "wizard", "fossil", "harbor",
  "candle", "helmet", "school", "forest", "marble", "anchor", "violet", "museum", "border", "battle",
  "future", "mirror", "button", "planet", "needle", "blanket", "storm", "ladder", "temple", "signal",
  "guitar", "ticket", "bubble", "valley", "falcon", "laptop", "orange", "canal", "bronze", "islander",
  "cookie", "shelter", "voyage", "oxygen", "shadow", "pepper", "sapphire", "rhythm", "jigsaw", "legend",
  "lantern", "compass", "summit", "harvest", "canvas", "throne", "crystal", "plasma", "nebula", "portal"
];

function loadWordsFromFile(fileName, fallbackWords) {
  try {
    const absolute = path.resolve(__dirname, "../../", fileName);
    const raw = fs.readFileSync(absolute, "utf8");
    const words = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (words.length >= 25) {
      return words;
    }
  } catch {
    // Fallback below.
  }
  return fallbackWords;
}

const WORDS_BY_LANGUAGE = {
  en: loadWordsFromFile("words-en.txt", FALLBACK_WORDS),
  de: loadWordsFromFile("words-de.txt", FALLBACK_WORDS)
};

const CHAT_MAX_MESSAGE_LENGTH = 1000;
const CHAT_MAX_TOTAL_LENGTH = 10000;
const CHAT_RATE_LIMIT_MS = 1000;
const CHAT_LINK_REGEX = /(https?:\/\/|www\.)/i;

function makeId() {
  return crypto.randomBytes(8).toString("hex");
}

function shuffle(input) {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickWords(count, language = "en") {
  const pool = WORDS_BY_LANGUAGE[language] || WORDS_BY_LANGUAGE.en;
  return shuffle(pool).slice(0, count);
}

function buildBoard(language = "en", greenCards = 14, redCards = 10, blackCards = 1) {
  const totalCards = greenCards + redCards + blackCards;
  const words = pickWords(totalCards, language);
  const indexes = shuffle(Array.from({ length: totalCards }, (_, i) => i));
  const green = new Set(indexes.slice(0, greenCards));
  const red = new Set(indexes.slice(greenCards, greenCards + redCards));
  const black = new Set(indexes.slice(greenCards + redCards, greenCards + redCards + blackCards));

  const cards = words.map((word, index) => {
    let role = "red";
    if (green.has(index)) role = "green";
    else if (black.has(index)) role = "black";
    else if (red.has(index)) role = "red";

    return {
      index,
      word,
      role
    };
  });
  return { cards };
}

function sanitizeChatMessage(message) {
  if (!message) return "";
  return String(message).replace(/\s+/g, " ").trim();
}

function getChatTotalLength(chatLog) {
  return (chatLog || []).reduce((sum, entry) => sum + (entry.text?.length || 0), 0);
}

function trimChatLog(game) {
  if (!game?.chatLog) return;
  let total = getChatTotalLength(game.chatLog);
  while (total > CHAT_MAX_TOTAL_LENGTH && game.chatLog.length > 0) {
    const removed = game.chatLog.shift();
    total -= removed?.text?.length || 0;
  }
}

function canSendChat(game, playerId) {
  if (!game?.chatRate) return true;
  const last = game.chatRate[playerId] || 0;
  return Date.now() - last >= CHAT_RATE_LIMIT_MS;
}

function registerChatSend(game, playerId) {
  if (!game?.chatRate) return;
  game.chatRate[playerId] = Date.now();
}

function appendChatMessage(game, entry) {
  if (!game.chatLog) {
    game.chatLog = [];
  }
  game.chatLog.push(entry);
  trimChatLog(game);
}

function getDefaultGameConfig() {
  return {
    wordLanguage: "en",
    cycles: 1,
    simultaneousClue: false,
    cluePhaseSeconds: 60,
    guessPhaseSeconds: 60,
    betweenRoundsSeconds: 15,
    clueCardValue: 300,
    guesserCardPool: 200,
    rankBonus1: 50,
    rankBonus2: 25,
    rankBonus3: 15,
    redPenalty: 50,
    blackPenalty: 200,
    penalizeClueGiverForWrongGuesses: true,
    greenCards: 14,
    redCards: 10,
    blackCards: 1
  };
}

function coerceConfig(config) {
  return {
    ...getDefaultGameConfig(),
    ...(config || {})
  };
}

function buildGuessersState(guesserIds) {
  const guessers = {};
  for (const guesserId of guesserIds) {
    guessers[guesserId] = {
      marks: [],
      guessedCorrect: [],
      guessedWrong: [],
      guessedWrongRed: [],
      guessedWrongBlack: [],
      guessedNeutral: [],
      redHits: 0,
      blackHit: false,
      finished: false,
      guessTimes: {}
    };
  }
  return guessers;
}

function buildBoardsByPlayerId(game) {
  const boards = {};
  for (const player of game.players) {
    boards[player.id] = buildBoard(game.config?.wordLanguage || "en", game.config?.greenCards || 14, game.config?.redCards || 10, game.config?.blackCards || 1);
  }
  return boards;
}

function buildRoundState(game) {
  const clueGiverId = game.clueOrder[game.turnIndex % game.clueOrder.length];
  const boardsByPlayerId = game.config?.simultaneousClue ? buildBoardsByPlayerId(game) : null;
  const fallbackBoard = buildBoard(game.config?.wordLanguage || "en", game.config?.greenCards || 14, game.config?.redCards || 10, game.config?.blackCards || 1);
  const board = boardsByPlayerId?.[clueGiverId] || fallbackBoard;
  const guesserIds = game.config?.simultaneousClue
    ? game.players.map((p) => p.id)
    : game.players.filter((p) => p.id !== clueGiverId).map((p) => p.id);
  const guessers = buildGuessersState(guesserIds);

  const baseRound = {
    board,
    clue: null,
    clueCount: 0,
    clueSelectedIndexes: [],
    clueSubmittedAt: null,
    guessStartedAt: null,
    guessEndsAt: null,
    roundEndEndsAt: null,
    guessers,
    clueGiverId,
    guesserIds,
    phase: "clue",
    phaseStartedAt: Date.now()
  };

  if (game.config?.simultaneousClue) {
    const cluePhaseSeconds = Number(game.config?.cluePhaseSeconds || 0);
    return {
      ...baseRound,
      simultaneousMode: true,
      submittedClues: {},
      boardsByPlayerId,
      clueAllEndsAt: cluePhaseSeconds > 0 ? Date.now() + cluePhaseSeconds * 1000 : null,
      subRoundIndex: 0,
      activeClueGiverIds: [],
      phase: "clue-all"
    };
  }

  return baseRound;
}

function initScores(players) {
  const scores = {};
  for (const player of players) {
    scores[player.id] = {
      total: 0,
      rounds: []
    };
  }
  return scores;
}

function initPlayerStats(players) {
  const stats = {};
  for (const player of players) {
    stats[player.id] = {
      correctGreen: 0,
      neutralGreen: 0,
      red: 0,
      black: 0
    };
  }
  return stats;
}

function startGame(lobby) {
  if (!lobby || !lobby.id) {
    return { error: "Lobby not found." };
  }

  const config = coerceConfig(lobby.settings?.gameConfig);
  const clueOrder = shuffle(lobby.players.map((p) => p.id));
  const totalRounds = config.simultaneousClue
    ? Math.max(1, config.cycles)
    : Math.max(1, config.cycles) * lobby.players.length;

  const game = {
    id: makeId(),
    lobbyId: lobby.id,
    hostId: lobby.hostId,
    config,
    status: "active",
    createdAt: Date.now(),
    players: lobby.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
    clueOrder,
    turnIndex: 0,
    roundNumber: 1,
    totalRounds,
    scores: initScores(lobby.players),
    playerStats: initPlayerStats(lobby.players),
    round: null,
    chatLog: [],
    chatRate: {},
    timers: {
      clue: null,
      guess: null,
      roundEnd: null
    }
  };

  game.round = buildRoundState(game);
  activeGames.set(game.lobbyId, game);
  return { game };
}

function validateChatMessage(game, playerId, message) {
  if (!game) return { error: "Game not found." };
  if (!ensurePlayer(game, playerId)) return { error: "Only players can send chat." };
  const cleaned = sanitizeChatMessage(message);
  if (!cleaned) return { error: "Message cannot be empty." };
  if (cleaned.length > CHAT_MAX_MESSAGE_LENGTH) {
    return { error: `Message must be ${CHAT_MAX_MESSAGE_LENGTH} characters or less.` };
  }
  if (CHAT_LINK_REGEX.test(cleaned)) {
    return { error: "Links are not allowed." };
  }
  if (!canSendChat(game, playerId)) {
    return { error: "You are sending messages too quickly." };
  }
  return { ok: true, cleaned };
}

function buildScoreBreakdown(game, round) {
  const cfg = game.config;
  const guesserIds = round.guesserIds;
  const guesserCount = Math.max(1, guesserIds.length);
  const breakdown = {};

  for (const player of game.players) {
    breakdown[player.id] = [];
  }

  for (const cardIndex of round.clueSelectedIndexes) {
    const foundBy = guesserIds.filter((gid) => round.guessers[gid].guessedCorrect.includes(cardIndex)).length;
    const points = Math.round(cfg.clueCardValue * (foundBy / guesserCount));
    breakdown[round.clueGiverId].push({
      label: `for card (${round.board.cards[cardIndex]?.word || cardIndex}) with ${foundBy}/${guesserCount} found`,
      points
    });
  }

  if (cfg.penalizeClueGiverForWrongGuesses) {
    for (const gid of guesserIds) {
      const g = round.guessers[gid];
      if (g.redHits > 0) {
        const points = -Math.round((g.redHits * cfg.redPenalty) / guesserCount);
        breakdown[round.clueGiverId].push({
          label: `red cards by guessers (${g.redHits})`,
          points
        });
      }
      if (g.blackHit) {
        const points = -Math.round(cfg.blackPenalty / guesserCount);
        breakdown[round.clueGiverId].push({
          label: "black card by guesser",
          points
        });
      }
    }
  }

  for (const cardIndex of round.clueSelectedIndexes) {
    const winners = guesserIds
      .filter((gid) => round.guessers[gid].guessedCorrect.includes(cardIndex))
      .map((gid) => ({ gid, at: round.guessers[gid].guessTimes[cardIndex] }))
      .sort((a, b) => a.at - b.at);

    if (winners.length === 0) {
      continue;
    }

    const bonuses = [cfg.rankBonus1, cfg.rankBonus2, cfg.rankBonus3];
    let distributedBonus = 0;
    winners.forEach((w, idx) => {
      const bonus = idx < bonuses.length ? bonuses[idx] : 0;
      distributedBonus += bonus;
      if (bonus > 0) {
        breakdown[w.gid].push({
          label: idx === 0
            ? `first finder bonus (${round.board.cards[cardIndex]?.word || cardIndex})`
            : `finder bonus (${round.board.cards[cardIndex]?.word || cardIndex})`,
          points: bonus
        });
      }
    });

    const remaining = Math.max(0, cfg.guesserCardPool - distributedBonus);
    const endAt = round.guessEndsAt || Date.now();
    const totalWeight = winners.reduce((acc, w) => {
      const timeLeft = Math.max(0, (endAt - w.at) / 1000);
      return acc + timeLeft;
    }, 0);

    if (totalWeight > 0) {
      winners.forEach((w) => {
        const timeLeft = Math.max(0, (endAt - w.at) / 1000);
        const score = Math.round((remaining * timeLeft) / totalWeight);
        breakdown[w.gid].push({
          label: `remaining pool share (${round.board.cards[cardIndex]?.word || cardIndex})`,
          points: score
        });
      });
    }
  }

  for (const gid of guesserIds) {
    const g = round.guessers[gid];
    if (g.redHits > 0) {
      breakdown[gid].push({
        label: `clicked red card${g.redHits === 1 ? "" : "s"} (${g.redHits})`,
        points: -g.redHits * cfg.redPenalty
      });
    }
    if (g.blackHit) {
      breakdown[gid].push({
        label: "clicked black card",
        points: -cfg.blackPenalty
      });
    }
  }

  return breakdown;
}

function buildScoreChatEntry(game, playerId, items, roundDelta) {
  const player = game.players.find((p) => p.id === playerId);
  const role = playerId === game.round.clueGiverId ? "clue giver" : "guesser";
  const total = roundDelta[playerId] || 0;
  const parts = items.map((item) => item.label).join(", ");
  const totalLabel = total >= 0 ? `+${total}` : `${total}`;
  return {
    id: makeId(),
    at: Date.now(),
    playerId: null,
    name: "System",
    type: "system-score",
    actorName: player?.name || playerId,
    actorColor: player?.color || null,
    role,
    items,
    total,
    text: `${player?.name || playerId} (${role}): ${parts || "no scoring events"} (total ${totalLabel})`
  };
}

function getGame(lobbyId) {
  return activeGames.get(lobbyId) || null;
}

function clearGameTimers(game) {
  if (!game) return;
  if (game.timers.clue) {
    clearTimeout(game.timers.clue);
    game.timers.clue = null;
  }
  if (game.timers.guess) {
    clearTimeout(game.timers.guess);
    game.timers.guess = null;
  }
  if (game.timers.roundEnd) {
    clearTimeout(game.timers.roundEnd);
    game.timers.roundEnd = null;
  }
}

function stopGame(lobbyId) {
  const game = getGame(lobbyId);
  if (!game) return;
  clearGameTimers(game);
  activeGames.delete(lobbyId);
}

function ensurePlayer(game, playerId) {
  return game.players.some((p) => p.id === playerId);
}

function getRound(game) {
  return game.round;
}

function parseCluePayload(board, payload) {
  const clue = String(payload?.clue || "").trim();
  const clueCount = Number(payload?.clueCount || 0);
  const selectedIndexes = Array.isArray(payload?.selectedIndexes) ? payload.selectedIndexes : [];
  const uniqueIndexes = [...new Set(selectedIndexes.map((n) => Number(n)))].filter((n) => Number.isInteger(n));

  if (!clue || clue.length < 2 || clue.length > 30) {
    return { error: "Clue must be 2-30 characters." };
  }
  if (!Number.isInteger(clueCount) || clueCount < 1 || clueCount > 8) {
    return { error: "Clue count must be between 1 and 8." };
  }
  if (uniqueIndexes.length !== clueCount) {
    return { error: "Number of selected cards must match clue count." };
  }

  const invalid = uniqueIndexes.find((idx) => {
    const card = board.cards[idx];
    return !card || card.role !== "green";
  });
  if (invalid !== undefined) {
    return { error: "You can only select light-green cards." };
  }

  return { clue, clueCount, uniqueIndexes };
}

function submitClue(game, playerId, payload) {
  if (!game) return { error: "Game not found." };
  if (!ensurePlayer(game, playerId)) return { error: "Player is not part of this game." };

  const round = getRound(game);
  if (round.phase === "clue-all") {
    const personalBoard = round.boardsByPlayerId?.[playerId] || round.board;
    const parsed = parseCluePayload(personalBoard, payload);
    if (parsed.error) return { error: parsed.error };

    round.submittedClues[playerId] = {
      clue: parsed.clue,
      clueCount: parsed.clueCount,
      clueSelectedIndexes: parsed.uniqueIndexes,
      submittedAt: Date.now()
    };

    const allSubmitted = Object.keys(round.submittedClues).length === game.players.length;
    return { ok: true, allSubmitted };
  }

  if (round.phase !== "clue") {
    return { error: "Not in clue phase." };
  }
  if (round.clueGiverId !== playerId) {
    return { error: "Only the clue giver can submit clue." };
  }

  const parsed = parseCluePayload(round.board, payload);
  if (parsed.error) return { error: parsed.error };

  round.clue = parsed.clue;
  round.clueCount = parsed.clueCount;
  round.clueSelectedIndexes = parsed.uniqueIndexes;
  round.clueSubmittedAt = Date.now();
  round.guessStartedAt = Date.now();
  round.guessEndsAt = round.guessStartedAt + game.config.guessPhaseSeconds * 1000;
  round.phase = "guess";
  round.phaseStartedAt = Date.now();

  return { ok: true };
}

function activateSubRound(game) {
  const round = getRound(game);
  const cgId = round.activeClueGiverIds[round.subRoundIndex];
  const sub = round.submittedClues[cgId];

  round.clueGiverId = cgId;
  round.clue = sub.clue;
  round.clueCount = sub.clueCount;
  round.clueSelectedIndexes = sub.clueSelectedIndexes;
  round.clueSubmittedAt = sub.submittedAt;
  round.board = round.boardsByPlayerId?.[cgId] || round.board;
  round.guesserIds = game.players.filter((p) => p.id !== cgId).map((p) => p.id);
  round.guessers = buildGuessersState(round.guesserIds);
  round.phase = "guess";
  round.phaseStartedAt = Date.now();
  round.guessStartedAt = Date.now();
  round.guessEndsAt = round.guessStartedAt + game.config.guessPhaseSeconds * 1000;
}

function transitionClueAllToFirstSubRound(game) {
  const round = getRound(game);
  round.activeClueGiverIds = game.clueOrder.filter((id) => round.submittedClues[id]);
  if (round.activeClueGiverIds.length === 0) {
    finishRound(game);
    return { skippedToRoundEnd: true };
  }
  round.subRoundIndex = 0;
  activateSubRound(game);
  return { ok: true };
}

function toggleMark(game, playerId, index) {
  if (!game) return { error: "Game not found." };
  const round = getRound(game);
  if (round.phase !== "guess") return { error: "Marks only allowed during guess phase." };

  const guesser = round.guessers[playerId];
  if (!guesser) return { error: "Only guessers can mark cards." };
  if (guesser.finished) return { error: "You are finished for this round." };

  const numeric = Number(index);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 24) {
    return { error: "Invalid card index." };
  }

  if (guesser.marks.includes(numeric)) {
    guesser.marks = guesser.marks.filter((v) => v !== numeric);
  } else {
    guesser.marks.push(numeric);
  }

  return { ok: true };
}

function guessCard(game, playerId, index) {
  if (!game) return { error: "Game not found." };
  const round = getRound(game);
  if (round.phase !== "guess") return { error: "Guesses only allowed during guess phase." };

  const guesser = round.guessers[playerId];
  if (!guesser) return { error: "Only guessers can guess cards." };
  if (guesser.finished) return { error: "You are finished for this round." };

  const numeric = Number(index);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 24) {
    return { error: "Invalid card index." };
  }

  if (
    guesser.guessedCorrect.includes(numeric)
    || guesser.guessedWrong.includes(numeric)
    || guesser.guessedNeutral.includes(numeric)
  ) {
    return { error: "Card already guessed by you." };
  }

  const card = round.board.cards[numeric];
  const now = Date.now();

  // Check if this is one of the clue giver's selected target cards
  const isTargetCard = round.clueSelectedIndexes.includes(numeric);

  if (isTargetCard) {
    // Correctly guessed a selected card
    guesser.guessedCorrect.push(numeric);
    guesser.guessTimes[numeric] = now;
    if (game.playerStats?.[playerId]) {
      game.playerStats[playerId].correctGreen += 1;
    }
    // Guesser is done once they personally find every target card
    const allTargetsFound = round.clueSelectedIndexes.every((idx) =>
      guesser.guessedCorrect.includes(idx)
    );
    if (allTargetsFound) {
      guesser.finished = true;
    }
    return { ok: true, outcome: "correct", cardIndex: numeric };
  }

  if (card.role === "green") {
    // Non-selected green card: neutral, nothing happens
    guesser.guessedNeutral.push(numeric);
    if (game.playerStats?.[playerId]) {
      game.playerStats[playerId].neutralGreen += 1;
    }
    return { ok: true, outcome: "neutral", cardIndex: numeric };
  }

  if (card.role === "red") {
    guesser.guessedWrong.push(numeric);
    guesser.guessedWrongRed.push(numeric);
    if (game.playerStats?.[playerId]) {
      game.playerStats[playerId].red += 1;
    }
    guesser.redHits += 1;
    if (guesser.redHits >= 2) {
      guesser.finished = true;
    }
    return { ok: true, outcome: "red", cardIndex: numeric };
  }

  if (card.role === "black") {
    guesser.guessedWrong.push(numeric);
    guesser.guessedWrongBlack.push(numeric);
    if (game.playerStats?.[playerId]) {
      game.playerStats[playerId].black += 1;
    }
    guesser.blackHit = true;
    guesser.finished = true;
    return { ok: true, outcome: "black", cardIndex: numeric };
  }

  return { ok: true, outcome: "neutral", cardIndex: numeric };
}

function computeRoundScores(game) {
  const round = getRound(game);
  const cfg = game.config;

  const clueGiverId = round.clueGiverId;
  const guesserIds = round.guesserIds;
  const guesserCount = Math.max(1, guesserIds.length);

  const roundDelta = {};
  for (const p of game.players) {
    roundDelta[p.id] = 0;
  }

  // Clue giver scoring: selected card value weighted by fraction of guessers that found each card.
  let clueScore = 0;
  for (const cardIndex of round.clueSelectedIndexes) {
    const foundBy = guesserIds.filter((gid) => round.guessers[gid].guessedCorrect.includes(cardIndex)).length;
    clueScore += cfg.clueCardValue * (foundBy / guesserCount);
  }

  if (cfg.penalizeClueGiverForWrongGuesses) {
    for (const gid of guesserIds) {
      const g = round.guessers[gid];
      clueScore -= (g.redHits * cfg.redPenalty) / guesserCount;
      if (g.blackHit) {
        clueScore -= cfg.blackPenalty / guesserCount;
      }
    }
  }

  roundDelta[clueGiverId] += Math.round(clueScore);

  // Guesser scoring per selected card with rank bonuses and time-weighted split.
  for (const cardIndex of round.clueSelectedIndexes) {
    const winners = guesserIds
      .filter((gid) => round.guessers[gid].guessedCorrect.includes(cardIndex))
      .map((gid) => ({ gid, at: round.guessers[gid].guessTimes[cardIndex] }))
      .sort((a, b) => a.at - b.at);

    if (winners.length === 0) {
      continue;
    }

    const bonuses = [cfg.rankBonus1, cfg.rankBonus2, cfg.rankBonus3];
    let distributedBonus = 0;
    winners.forEach((w, idx) => {
      const bonus = idx < bonuses.length ? bonuses[idx] : 0;
      distributedBonus += bonus;
      roundDelta[w.gid] += bonus;
    });

    const remaining = Math.max(0, cfg.guesserCardPool - distributedBonus);
    const endAt = round.guessEndsAt || Date.now();
    const totalWeight = winners.reduce((acc, w) => {
      const timeLeft = Math.max(0, (endAt - w.at) / 1000);
      return acc + timeLeft;
    }, 0);

    if (totalWeight > 0) {
      winners.forEach((w) => {
        const timeLeft = Math.max(0, (endAt - w.at) / 1000);
        const score = Math.round((remaining * timeLeft) / totalWeight);
        roundDelta[w.gid] += score;
      });
    }
  }

  for (const gid of guesserIds) {
    const g = round.guessers[gid];
    roundDelta[gid] -= g.redHits * cfg.redPenalty;
    if (g.blackHit) {
      roundDelta[gid] -= cfg.blackPenalty;
    }
  }

  for (const player of game.players) {
    const entry = game.scores[player.id];
    const delta = Math.round(roundDelta[player.id] || 0);
    entry.total += delta;
    entry.rounds.push({
      roundNumber: game.roundNumber,
      delta,
      total: entry.total
    });
  }

  return roundDelta;
}

function shouldEndRound(game) {
  const round = getRound(game);
  if (round.phase !== "guess") return false;

  // A guesser is finished when they: found all targets, hit 2 red cards, or hit the black card.
  // The round ends only when every guesser is finished, or time runs out.
  const allGuessersFinished = round.guesserIds.every((gid) => round.guessers[gid].finished);
  const timedOut = Date.now() >= (round.guessEndsAt || 0);
  return allGuessersFinished || timedOut;
}

function finishRound(game) {
  const round = getRound(game);
  if (!round || (round.phase !== "guess" && round.phase !== "clue" && round.phase !== "clue-all")) {
    return { error: "Round cannot be finished in current phase." };
  }

  round.phase = "round-end";
  round.phaseStartedAt = Date.now();
  round.roundEndEndsAt = round.phaseStartedAt + (game.config?.betweenRoundsSeconds || 15) * 1000;
  const roundDelta = computeRoundScores(game);
  const breakdown = buildScoreBreakdown(game, round);
  for (const player of game.players) {
    const entry = buildScoreChatEntry(game, player.id, breakdown[player.id] || [], roundDelta);
    appendChatMessage(game, entry);
  }

  return { ok: true, roundDelta };
}

function advanceRound(game) {
  const round = getRound(game);
  if (!round || round.phase !== "round-end") {
    return { error: "Round cannot be advanced in current phase." };
  }

  if (game.config?.simultaneousClue) {
    const nextIdx = (round.subRoundIndex || 0) + 1;
    if (nextIdx < (round.activeClueGiverIds || []).length) {
      round.subRoundIndex = nextIdx;
      activateSubRound(game);
      return { finishedGame: false, newBoard: false };
    }

    const gameCompleted = game.roundNumber >= game.totalRounds;
    if (gameCompleted) {
      game.status = "finished";
      return { finishedGame: true };
    }

    game.roundNumber += 1;
    game.round = buildRoundState(game);
    return { finishedGame: false, newBoard: true };
  }

  const gameCompleted = game.roundNumber >= game.totalRounds;
  if (gameCompleted) {
    game.status = "finished";
    return { finishedGame: true };
  }

  game.turnIndex += 1;
  game.roundNumber += 1;
  game.round = buildRoundState(game);
  return { finishedGame: false };
}

function getRole(game, playerId) {
  const round = getRound(game);
  if (!round) return "viewer";
  if (!ensurePlayer(game, playerId)) return "viewer";
  if (round.phase === "clue-all") return "clue-all";
  if (round.clueGiverId === playerId) return "clue-giver";
  if (round.guessers[playerId]) return "guesser";
  return "viewer";
}

function getGameViewForPlayer(game, playerId) {
  if (!game) return null;

  const round = getRound(game);
  const role = getRole(game, playerId);
  const clueGiver = game.players.find((p) => p.id === round.clueGiverId);

  const isSpectator = !ensurePlayer(game, playerId);
  const revealBoardToAll = round.phase === "round-end"
    || game.status === "finished"
    || (!isSpectator && round.phase === "clue-all");
  const viewBoard = round.phase === "clue-all"
    ? (round.boardsByPlayerId?.[playerId] || round.board)
    : round.board;
  const targetIndexes = round.phase === "clue-all"
    ? (round.submittedClues?.[playerId]?.clueSelectedIndexes || [])
    : round.clueSelectedIndexes;

  const cards = viewBoard.cards.map((card) => {
    const base = {
      index: card.index,
      word: card.word,
      isTarget: targetIndexes.includes(card.index)
    };

    if (role === "clue-giver" || role === "clue-all" || revealBoardToAll) {
      return {
        ...base,
        role: card.role
      };
    }

    return {
      ...base,
      role: null
    };
  });

  const guessersProgress = round.guesserIds.map((gid) => {
    const g = round.guessers[gid];
    const player = game.players.find((p) => p.id === gid);
    return {
      playerId: gid,
      name: player?.name || gid,
      color: player?.color || null,
      correctCount: g.guessedCorrect.length,
      neutralCount: g.guessedNeutral.length,
      redCount: g.guessedWrongRed.length,
      blackCount: g.guessedWrongBlack.length,
      wrongCount: g.guessedWrong.length,
      finished: g.finished
    };
  });

  const myGuesserState = round.guessers[playerId]
    ? {
        marks: [...round.guessers[playerId].marks],
        guessedCorrect: [...round.guessers[playerId].guessedCorrect],
        guessedWrong: [...round.guessers[playerId].guessedWrong],
        guessedWrongRed: [...round.guessers[playerId].guessedWrongRed],
        guessedWrongBlack: [...round.guessers[playerId].guessedWrongBlack],
        guessedNeutral: [...round.guessers[playerId].guessedNeutral],
        redHits: round.guessers[playerId].redHits,
        blackHit: round.guessers[playerId].blackHit,
        finished: round.guessers[playerId].finished
      }
    : null;

  const clueGiverMarks = role === "clue-giver"
    ? round.guesserIds.reduce((acc, gid) => {
        acc[gid] = {
          marks: [...round.guessers[gid].marks],
          guessedCorrect: [...round.guessers[gid].guessedCorrect],
          guessedWrong: [...round.guessers[gid].guessedWrong],
          guessedWrongRed: [...round.guessers[gid].guessedWrongRed],
          guessedWrongBlack: [...round.guessers[gid].guessedWrongBlack],
          guessedNeutral: [...round.guessers[gid].guessedNeutral],
          finished: round.guessers[gid].finished
        };
        return acc;
      }, {})
    : null;

  const allGuesserActions = (role === "clue-giver" || revealBoardToAll)
    ? round.guesserIds.map((gid) => {
        const g = round.guessers[gid];
        const player = game.players.find((p) => p.id === gid);
        return {
          playerId: gid,
          name: player?.name || gid,
          color: player?.color || null,
          marks: [...g.marks],
          guessedCorrect: [...g.guessedCorrect],
          guessedWrong: [...g.guessedWrong],
          guessedWrongRed: [...g.guessedWrongRed],
          guessedWrongBlack: [...g.guessedWrongBlack],
          guessedNeutral: [...g.guessedNeutral],
          finished: g.finished
        };
      })
    : [];

  const scores = game.players.map((p) => ({
    playerId: p.id,
    name: p.name,
    color: p.color || null,
    total: game.scores[p.id].total
  }));

  const playerStats = game.players.map((p) => {
    const stat = game.playerStats?.[p.id] || {
      correctGreen: 0,
      neutralGreen: 0,
      red: 0,
      black: 0
    };
    return {
      playerId: p.id,
      name: p.name,
      correctGreen: stat.correctGreen,
      neutralGreen: stat.neutralGreen,
      red: stat.red,
      black: stat.black,
      totalGuessed: stat.correctGreen + stat.neutralGreen + stat.red + stat.black
    };
  });

  return {
    lobbyId: game.lobbyId,
    gameId: game.id,
    status: game.status,
    phase: round.phase,
    roundNumber: game.roundNumber,
    totalRounds: game.totalRounds,
    totalPlayersCount: game.players.length,
    role,
    clueGiver: {
      id: round.clueGiverId,
      name: clueGiver?.name || "Unknown"
    },
    clue: round.clue,
    clueCount: round.clueCount,
    clueSelectedIndexes: role === "clue-giver"
      ? [...round.clueSelectedIndexes]
      : role === "clue-all"
        ? [...(round.submittedClues?.[playerId]?.clueSelectedIndexes || [])]
        : [],
    guessEndsAt: round.guessEndsAt,
    roundEndEndsAt: round.roundEndEndsAt,
    phaseStartedAt: round.phaseStartedAt,
    cards,
    scores,
    playerStats,
    config: game.config,
    isSimultaneous: round.simultaneousMode ?? false,
    submittedClueCount: round.phase === "clue-all" ? Object.keys(round.submittedClues || {}).length : undefined,
    mySubmittedClue: round.submittedClues?.[playerId]
      ? {
          clue: round.submittedClues[playerId].clue,
          clueCount: round.submittedClues[playerId].clueCount,
          clueSelectedIndexes: [...round.submittedClues[playerId].clueSelectedIndexes]
        }
      : null,
    subRoundIndex: round.subRoundIndex ?? 0,
    subRoundTotal: round.activeClueGiverIds?.length ?? 0,
    clueAllEndsAt: round.clueAllEndsAt ?? null,
    chatLog: game.chatLog || [],
    rematchLobbyId: game.rematchLobbyId || null,
    hostId: game.hostId || null,
    myGuesserState,
    clueGiverMarks,
    allGuesserActions,
    guessersProgress
  };
}

module.exports = {
  advanceRound,
  finishRound,
  getDefaultGameConfig,
  getGame,
  getGameViewForPlayer,
  guessCard,
  shouldEndRound,
  startGame,
  stopGame,
  submitClue,
  transitionClueAllToFirstSubRound,
  toggleMark,
  validateChatMessage,
  appendChatMessage,
  registerChatSend,
  clearGameTimers
};
