const crypto = require("crypto");
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

function validateName(name) {
  const trimmed = normalizeName(name);
  if (!trimmed) {
    return "Name is required.";
  }
  if (trimmed.length < 2 || trimmed.length > 20) {
    return "Name must be 2-20 characters.";
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
      color: p.color
    }))
  };
}

function getDefaultLobbySettings(visibility) {
  return {
    visibility,
    gameConfig: getDefaultGameConfig()
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

function createLobby(hostName, visibility = "public", overrideSettings = null, lobbyName = null, preferredColor = null) {
  const nameError = validateName(hostName);
  if (nameError) {
    return { error: nameError };
  }
  if (!["public", "private"].includes(visibility)) {
    return { error: "visibility must be public or private." };
  }
  if (lobbyName !== null) {
    const lobbyNameError = validateLobbyName(lobbyName);
    if (lobbyNameError) {
      return { error: lobbyNameError };
    }
  }

  const lobbyId = makeId();
  const hostId = makeId();
  const createdAt = nowIso();

  const lobby = {
    id: lobbyId,
    name: lobbyName ? String(lobbyName).trim() : null,
    hostId,
    status: "waiting",
    createdAt,
    updatedAt: createdAt,
    settings: overrideSettings
      ? { ...overrideSettings, visibility }
      : getDefaultLobbySettings(visibility),
    players: [
      {
        id: hostId,
        name: normalizeName(hostName),
        isHost: true,
        connected: false,
        color: pickColor([], preferredColor)
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
    .filter((lobby) => lobby.status === "waiting")
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
  const { viaInvite = false, preferredColor = null } = options;
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
  if (lobby.players.length >= 8) {
    return { error: "Lobby is full (max 8 players)." };
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
    color: pickColor(lobby.players, preferredColor)
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

  const nextVisibility = patch.visibility ?? lobby.settings.visibility;
  const nextConfig = {
    ...(lobby.settings.gameConfig || getDefaultGameConfig()),
    ...(patch.gameConfig || {})
  };

  if (!["public", "private"].includes(nextVisibility)) {
    return { error: "visibility must be public or private." };
  }

  if (!Number.isInteger(Number(nextConfig.cycles)) || Number(nextConfig.cycles) < 1 || Number(nextConfig.cycles) > 30) {
    return { error: "cycles must be 1-30." };
  }

  const rangedFields = [
    ["guessPhaseSeconds", 10, 600],
    ["betweenRoundsSeconds", 0, 120],
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
  if (!Number.isInteger(cluePhase) || cluePhase < -1 || cluePhase > 600) {
    return { error: "cluePhaseSeconds must be -1, 0, or an integer up to 600." };
  }
  nextConfig.cluePhaseSeconds = cluePhase;

  const nextWordLanguage = String(nextConfig.wordLanguage || "en").toLowerCase();
  if (!["en", "de"].includes(nextWordLanguage)) {
    return { error: "wordLanguage must be one of: en, de." };
  }
  nextConfig.wordLanguage = nextWordLanguage;

  nextConfig.cycles = Number(nextConfig.cycles);
  nextConfig.penalizeClueGiverForWrongGuesses = Boolean(nextConfig.penalizeClueGiverForWrongGuesses);
  nextConfig.simultaneousClue = Boolean(nextConfig.simultaneousClue);

  lobby.settings.visibility = nextVisibility;
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
  return { lobby: serializeLobby(lobby) };
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
  removePlayer,
  startGame,
  updateLobbyName,
  updateLobbySettings
};
