const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { getDefaultGameConfig } = require("./gameEngine");

const lobbies = new Map();

const PLAYER_COLORS = [
  "#e05555", // red
  "#3dc46a", // green
  "#4a9eff", // blue
  "#f5a623", // orange
  "#ab6bdb", // purple
  "#e86bb4", // pink
  "#20c5c5", // teal
  "#c8b632", // gold
];

const AI_NAME_BASES = ["Cipher", "Nova", "Atlas", "Echo"];
const MAX_LOBBY_PLAYERS = PLAYER_COLORS.length;
const MAX_AI_AGENTS_PER_LOBBY = 1;
const AI_AGENT_ADD_PASSWORD_SHA512 = "ab33fe5f2945bbd61915f931177f39811f775d11675b29f4f078af0890fa180f3b849ec6cf0061ad1aa3f08f43f12b5fb279d6886a12944fb3c9e7e25b83f556";

function loadWordsFromFile(fileName) {
  const absolute = path.resolve(__dirname, "../../", fileName);
  const raw = fs.readFileSync(absolute, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const LOBBY_WORDS_BY_LANGUAGE = {
  en: loadWordsFromFile("words-en.txt"),
  de: loadWordsFromFile("words-de.txt")
};

function pickRandomLobbyWord(language = "en") {
  const pool = LOBBY_WORDS_BY_LANGUAGE[language] || LOBBY_WORDS_BY_LANGUAGE.en;
  if (!pool || pool.length === 0) return "Briefing";
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildAutoLobbyName(language = "en") {
  const prefix = "Mission";
  const maxWordLength = 30 - (prefix.length + 1);
  const safeWordLength = Math.max(1, maxWordLength);

  // Retry a few times to pick a naturally fitting word before truncating.
  for (let i = 0; i < 8; i += 1) {
    const word = String(pickRandomLobbyWord(language) || "").trim();
    if (!word) continue;
    if (word.length <= safeWordLength) {
      return `${prefix} ${word}`;
    }
  }

  const fallbackWord = String(pickRandomLobbyWord(language) || "Briefing").trim();
  return `${prefix} ${fallbackWord.slice(0, safeWordLength)}`;
}

function hashSha512(value) {
  return crypto.createHash("sha512").update(String(value || ""), "utf8").digest("hex");
}

function pickColor(existingPlayers, preferredColor = null) {
  const used = new Set(existingPlayers.map((p) => p.color));
  if (preferredColor && !used.has(preferredColor)) {
    return preferredColor;
  }
  const available = PLAYER_COLORS.filter((c) => !used.has(c));
  const pool = available.length > 0 ? available : PLAYER_COLORS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return crypto.randomBytes(4).toString("hex");
}

function normalizeName(name) {
  return String(name || "").trim();
}

function normalizeBrowserId(browserId) {
  const normalized = String(browserId || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length < 16 || normalized.length > 128) {
    return "";
  }
  return normalized;
}

function validateName(name) {
  const trimmed = normalizeName(name);
  if (!trimmed) {
    return "Name is required.";
  }
  if (trimmed.length < 2 || trimmed.length > 25) {
    return "Name must be 2-25 characters.";
  }
  return null;
}

function serializeLobby(lobby) {
  return {
    id: lobby.id,
    name: lobby.name || null,
    hostId: lobby.hostId,
    status: lobby.status,
    createdAt: lobby.createdAt,
    updatedAt: lobby.updatedAt,
    settings: { ...lobby.settings },
    players: lobby.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      connected: p.connected,
      color: p.color,
      isAI: Boolean(p.isAI)
    }))
  };
}

function pickNextAIName(players) {
  const used = new Set(players.map((p) => String(p.name || "").trim().toLowerCase()));

  for (const base of AI_NAME_BASES) {
    if (!used.has(base.toLowerCase())) {
      return base;
    }
  }

  for (let suffix = 2; suffix <= 99; suffix += 1) {
    for (const base of AI_NAME_BASES) {
      const candidate = `${base} ${suffix}`;
      if (!used.has(candidate.toLowerCase())) {
        return candidate;
      }
    }
  }

  return `AI Agent ${players.length + 1}`;
}

function getDefaultLobbySettings(visibility) {
  return {
    visibility,
    gameConfig: getDefaultGameConfig()
  };
}

function mergeLobbySettings(visibility, overrideSettings = null) {
  const defaults = getDefaultLobbySettings(visibility);
  if (!overrideSettings || typeof overrideSettings !== "object") {
    return defaults;
  }

  return {
    ...defaults,
    ...overrideSettings,
    visibility,
    gameConfig: {
      ...defaults.gameConfig,
      ...(overrideSettings.gameConfig || {})
    }
  };
}

function validateLobbyName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return "Lobby name is required.";
  }
  if (trimmed.length < 2 || trimmed.length > 30) {
    return "Lobby name must be 2-30 characters.";
  }
  return null;
}

function createLobby(hostName, visibility = "public", overrideSettings = null, lobbyName = null, preferredColor = null, browserId = "") {
  const nameError = validateName(hostName);
  if (nameError) {
    return { error: nameError };
  }
  if (!["public", "private"].includes(visibility)) {
    return { error: "visibility must be public or private." };
  }
  const effectiveWordLanguage = String(overrideSettings?.gameConfig?.wordLanguage || "en").toLowerCase();
  const normalizedWordLanguage = ["en", "de"].includes(effectiveWordLanguage) ? effectiveWordLanguage : "en";
  const resolvedLobbyName = lobbyName ? String(lobbyName).trim() : buildAutoLobbyName(normalizedWordLanguage);

  if (resolvedLobbyName !== null) {
    const lobbyNameError = validateLobbyName(resolvedLobbyName);
    if (lobbyNameError) {
      return { error: lobbyNameError };
    }
  }

  const lobbyId = makeId();
  const hostId = makeId();
  const createdAt = nowIso();

  const lobby = {
    id: lobbyId,
    name: resolvedLobbyName,
    hostId,
    status: "waiting",
    createdAt,
    updatedAt: createdAt,
    settings: mergeLobbySettings(visibility, overrideSettings),
    players: [
      {
        id: hostId,
        name: normalizeName(hostName),
        isHost: true,
        connected: false,
        color: pickColor([], preferredColor),
        isAI: false,
        browserId: normalizeBrowserId(browserId)
      }
    ]
  };

  lobbies.set(lobbyId, lobby);
  return { lobby: serializeLobby(lobby), playerId: hostId };
}

function updateLobbyName(lobbyId, playerId, newName) {
  const lobby = getLobby(lobbyId);
  if (!lobby) {
    return { error: "Lobby not found." };
  }
  if (lobby.hostId !== playerId) {
    return { error: "Only the host can rename the lobby." };
  }
  const lobbyNameError = validateLobbyName(newName);
  if (lobbyNameError) {
    return { error: lobbyNameError };
  }
  lobby.name = String(newName).trim();
  lobby.updatedAt = nowIso();
  return { lobby: serializeLobby(lobby) };
}

function listPublicLobbies() {
  return Array.from(lobbies.values())
    .filter((lobby) => lobby.status === "waiting" && lobby.settings.visibility === "public")
    .map((lobby) => ({
      id: lobby.id,
      name: lobby.name || null,
      players: lobby.players.length,
      visibility: lobby.settings.visibility,
      createdAt: lobby.createdAt
    }));
}

function listStartedPublicLobbies() {
  return Array.from(lobbies.values())
    .filter((lobby) => lobby.status === "started" && lobby.settings.visibility === "public")
    .map((lobby) => ({
      id: lobby.id,
      name: lobby.name || null,
      players: lobby.players.length,
      visibility: lobby.settings.visibility,
      createdAt: lobby.createdAt,
      updatedAt: lobby.updatedAt
    }));
}

function getLobby(lobbyId) {
  return lobbies.get(lobbyId) || null;
}

function getSerializedLobby(lobbyId) {
  const lobby = getLobby(lobbyId);
  return lobby ? serializeLobby(lobby) : null;
}

function joinLobby(lobbyId, playerName, options = {}) {
  const { viaInvite = false, preferredColor = null, browserId = "" } = options;
  const nameError = validateName(playerName);
  if (nameError) {
    return { error: nameError };
  }

  const lobby = getLobby(lobbyId);
  if (!lobby) {
    return { error: "Lobby not found." };
  }
  if (lobby.status !== "waiting") {
    return { error: "Lobby already started." };
  }
  if (lobby.settings.visibility === "private" && !viaInvite) {
    return { error: "Private lobby cannot be joined from the overview." };
  }
  if (lobby.players.length >= MAX_LOBBY_PLAYERS) {
    return { error: `Lobby is full (max ${MAX_LOBBY_PLAYERS} players).` };
  }

  const cleanName = normalizeName(playerName);
  const duplicate = lobby.players.some((p) => p.name.toLowerCase() === cleanName.toLowerCase());
  if (duplicate) {
    return { error: "Name is already taken in this lobby." };
  }

  const playerId = makeId();
  lobby.players.push({
    id: playerId,
    name: cleanName,
    isHost: false,
    connected: false,
    color: pickColor(lobby.players, preferredColor),
    isAI: false,
    browserId: normalizeBrowserId(browserId)
  });
  lobby.updatedAt = nowIso();

  return { lobby: serializeLobby(lobby), playerId };
}

function addAIAgent(lobbyId, hostId, password) {
  const lobby = getLobby(lobbyId);
  if (!lobby) {
    return { error: "Lobby not found." };
  }
  if (lobby.hostId !== hostId) {
    return { error: "Only the host can add AI agents." };
  }
  if (lobby.status !== "waiting") {
    return { error: "Cannot add AI agents after game start." };
  }

  if (hashSha512(password) !== AI_AGENT_ADD_PASSWORD_SHA512) {
    return { error: "Invalid AI agent password." };
  }

  const aiCount = lobby.players.filter((player) => player.isAI).length;
  if (aiCount >= MAX_AI_AGENTS_PER_LOBBY) {
    return { error: "Only one AI agent can be added per game." };
  }

  if (lobby.players.length >= MAX_LOBBY_PLAYERS) {
    return { error: `Lobby is full (max ${MAX_LOBBY_PLAYERS} players).` };
  }

  const aiName = pickNextAIName(lobby.players);
  const playerId = makeId();
  lobby.players.push({
    id: playerId,
    name: aiName,
    isHost: false,
    connected: true,
    color: pickColor(lobby.players),
    isAI: true,
    browserId: ""
  });
  lobby.updatedAt = nowIso();

  return { lobby: serializeLobby(lobby), playerId };
}

function markPlayerConnected(lobbyId, playerId, connected) {
  const lobby = getLobby(lobbyId);
  if (!lobby) {
    return null;
  }
  const player = lobby.players.find((p) => p.id === playerId);
  if (!player) {
    return null;
  }
  player.connected = connected;
  lobby.updatedAt = nowIso();
  return serializeLobby(lobby);
}

function updateLobbySettings(lobbyId, playerId, patch) {
  const hasGeneralPatch = Object.prototype.hasOwnProperty.call(patch || {}, "visibility")
    || Object.prototype.hasOwnProperty.call(patch || {}, "name");
  const hasGamePatch = Object.prototype.hasOwnProperty.call(patch || {}, "gameConfig");

  if (!hasGeneralPatch && !hasGamePatch) {
    return { error: "No settings provided." };
  }

  if (hasGeneralPatch) {
    const generalResult = updateLobbyGeneralSettings(lobbyId, playerId, {
      visibility: patch?.visibility,
      name: patch?.name
    });
    if (generalResult.error) {
      return generalResult;
    }
  }

  if (hasGamePatch) {
    const gameResult = updateLobbyGameSettings(lobbyId, playerId, patch?.gameConfig || {});
    if (gameResult.error) {
      return gameResult;
    }
  }

  return { lobby: getSerializedLobby(lobbyId) };
}

function updateLobbyGeneralSettings(lobbyId, playerId, patch) {
  const lobby = getLobby(lobbyId);
  if (!lobby) {
    return { error: "Lobby not found." };
  }
  if (lobby.hostId !== playerId) {
    return { error: "Only the host can update settings." };
  }
  if (lobby.status !== "waiting") {
    return { error: "Lobby already started." };
  }

  const nextVisibility = patch?.visibility ?? lobby.settings.visibility;
  const hasNamePatch = Object.prototype.hasOwnProperty.call(patch || {}, "name");

  if (!["public", "private"].includes(nextVisibility)) {
    return { error: "visibility must be public or private." };
  }

  if (hasNamePatch) {
    const nameError = validateLobbyName(patch?.name);
    if (nameError) {
      return { error: nameError };
    }
    lobby.name = String(patch?.name || "").trim();
  }

  lobby.settings.visibility = nextVisibility;
  lobby.updatedAt = nowIso();

  return { lobby: serializeLobby(lobby) };
}

function updateLobbyGameSettings(lobbyId, playerId, gameConfigPatch) {
  const lobby = getLobby(lobbyId);
  if (!lobby) {
    return { error: "Lobby not found." };
  }
  if (lobby.hostId !== playerId) {
    return { error: "Only the host can update settings." };
  }
  if (lobby.status !== "waiting") {
    return { error: "Lobby already started." };
  }

  const nextConfig = {
    ...(lobby.settings.gameConfig || getDefaultGameConfig()),
    ...(gameConfigPatch || {})
  };

  if (!Number.isInteger(Number(nextConfig.cycles)) || Number(nextConfig.cycles) < 1 || Number(nextConfig.cycles) > 30) {
    return { error: "cycles must be 1-30." };
  }

  const rangedFields = [
    ["clueCardValue", 1, 2000],
    ["guesserCardPool", 1, 2000],
    ["rankBonus1", 0, 2000],
    ["rankBonus2", 0, 2000],
    ["rankBonus3", 0, 2000],
    ["redPenalty", 0, 2000],
    ["blackPenalty", 0, 5000],
    ["greenCards", 1, 23],
    ["redCards", 0, 24],
    ["blackCards", 0, 24]
  ];

  for (const [field, min, max] of rangedFields) {
    const value = Number(nextConfig[field]);
    if (!Number.isInteger(value) || value < min || value > max) {
      return { error: `${field} must be an integer between ${min} and ${max}.` };
    }
    nextConfig[field] = value;
  }

  const cardSum = nextConfig.greenCards + nextConfig.redCards + nextConfig.blackCards;
  if (cardSum !== 25) {
    return { error: `Green + Red + Black cards must equal 25 (currently ${cardSum}).` };
  }

  const cluePhase = Number(nextConfig.cluePhaseSeconds);
  if (!Number.isInteger(cluePhase) || cluePhase < 0) {
    return { error: "cluePhaseSeconds must be an integer >= 0 (0 means unlimited)." };
  }
  nextConfig.cluePhaseSeconds = cluePhase;

  const guessPhase = Number(nextConfig.guessPhaseSeconds);
  if (!Number.isInteger(guessPhase) || guessPhase < 5) {
    return { error: "guessPhaseSeconds must be an integer >= 5." };
  }
  nextConfig.guessPhaseSeconds = guessPhase;

  const betweenRounds = Number(nextConfig.betweenRoundsSeconds);
  if (!Number.isInteger(betweenRounds) || betweenRounds < 0) {
    return { error: "betweenRoundsSeconds must be an integer >= 0." };
  }
  nextConfig.betweenRoundsSeconds = betweenRounds;

  const nextWordLanguage = String(nextConfig.wordLanguage || "en").toLowerCase();
  if (!["en", "de"].includes(nextWordLanguage)) {
    return { error: "wordLanguage must be one of: en, de." };
  }
  nextConfig.wordLanguage = nextWordLanguage;

  nextConfig.cycles = Number(nextConfig.cycles);
  nextConfig.penalizeClueGiverForWrongGuesses = Boolean(nextConfig.penalizeClueGiverForWrongGuesses);
  nextConfig.simultaneousClue = Boolean(nextConfig.simultaneousClue);

  lobby.settings.gameConfig = nextConfig;
  lobby.updatedAt = nowIso();

  return { lobby: serializeLobby(lobby) };
}

function startGame(lobbyId, playerId) {
  const lobby = getLobby(lobbyId);
  if (!lobby) {
    return { error: "Lobby not found." };
  }
  if (lobby.hostId !== playerId) {
    return { error: "Only the host can start the game." };
  }
  if (lobby.status !== "waiting") {
    return { error: "Game already started." };
  }
  if (lobby.players.length < 2) {
    return { error: "At least 2 players are required." };
  }

  lobby.status = "started";
  lobby.updatedAt = nowIso();
  return { lobby: serializeLobby(lobby), lobbyRaw: lobby };
}

function removePlayer(lobbyId, playerId) {
  const lobby = getLobby(lobbyId);
  if (!lobby) {
    return { removedLobby: false, lobby: null, removedPlayer: null, removedLobbyDetails: null };
  }

  const idx = lobby.players.findIndex((p) => p.id === playerId);
  if (idx < 0) {
    return { removedLobby: false, lobby: serializeLobby(lobby), removedPlayer: null, removedLobbyDetails: null };
  }

  const [removedPlayer] = lobby.players.splice(idx, 1);
  lobby.updatedAt = nowIso();
  const removedLobbyDetails = {
    id: lobby.id,
    rematchSourceLobbyId: lobby.rematchSourceLobbyId || null
  };

  const removedHost = removedPlayer.id === lobby.hostId;
  if (removedHost || lobby.players.length === 0) {
    lobbies.delete(lobbyId);
    return { removedLobby: true, lobby: null, removedPlayer, removedLobbyDetails };
  }

  return { removedLobby: false, lobby: serializeLobby(lobby), removedPlayer, removedLobbyDetails: null };
}

function removePlayerFromStartedLobby(lobbyId, playerId) {
  const lobby = getLobby(lobbyId);
  if (!lobby) {
    return { removedLobby: false, lobby: null, removedPlayer: null, removedLobbyDetails: null, hostReassignedTo: null };
  }

  const idx = lobby.players.findIndex((p) => p.id === playerId);
  if (idx < 0) {
    return {
      removedLobby: false,
      lobby: serializeLobby(lobby),
      removedPlayer: null,
      removedLobbyDetails: null,
      hostReassignedTo: null
    };
  }

  const [removedPlayer] = lobby.players.splice(idx, 1);
  lobby.updatedAt = nowIso();
  const removedLobbyDetails = {
    id: lobby.id,
    rematchSourceLobbyId: lobby.rematchSourceLobbyId || null
  };

  if (lobby.players.length === 0) {
    lobbies.delete(lobbyId);
    return {
      removedLobby: true,
      lobby: null,
      removedPlayer,
      removedLobbyDetails,
      hostReassignedTo: null
    };
  }

  let hostReassignedTo = null;
  if (removedPlayer.id === lobby.hostId) {
    const nextHost = lobby.players[0];
    lobby.hostId = nextHost.id;
    hostReassignedTo = nextHost.id;
  }

  for (const player of lobby.players) {
    player.isHost = player.id === lobby.hostId;
  }

  return {
    removedLobby: false,
    lobby: serializeLobby(lobby),
    removedPlayer,
    removedLobbyDetails: null,
    hostReassignedTo
  };
}

function kickPlayer(lobbyId, hostId, targetPlayerId) {
  const lobby = getLobby(lobbyId);
  if (!lobby) {
    return { error: "Lobby not found." };
  }
  if (lobby.hostId !== hostId) {
    return { error: "Only host can kick players." };
  }
  if (hostId === targetPlayerId) {
    return { error: "Host cannot kick themselves." };
  }

  const target = lobby.players.find((p) => p.id === targetPlayerId);
  if (!target) {
    return { error: "Player not found in lobby." };
  }

  const result = removePlayer(lobbyId, targetPlayerId);
  return { ...result, kickedPlayer: target };
}

module.exports = {
  createLobby,
  getLobby,
  getSerializedLobby,
  joinLobby,
  listPublicLobbies,
  listStartedPublicLobbies,
  markPlayerConnected,
  kickPlayer,
  addAIAgent,
  removePlayer,
  removePlayerFromStartedLobby,
  startGame,
  updateLobbyName,
  updateLobbySettings,
  updateLobbyGeneralSettings,
  updateLobbyGameSettings
};
