const STORAGE_KEY = "lobbyPlayers";
const LEGACY_KEY = "lobbySession";

function readLobbyPlayers() {
  try {
    const map = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (map && Object.keys(map).length > 0) {
      return map;
    }
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "{}");
    if (legacy?.lobbyId && legacy?.playerId) {
      const next = { [legacy.lobbyId]: legacy.playerId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      localStorage.removeItem(LEGACY_KEY);
      return next;
    }
    return map;
  } catch {
    return {};
  }
}

export function getStoredPlayerId(lobbyId) {
  if (!lobbyId) return "";
  const map = readLobbyPlayers();
  return String(map[lobbyId] || "");
}

export function getStoredLobbyIds() {
  const map = readLobbyPlayers();
  return Object.keys(map);
}

export function setStoredPlayerId(lobbyId, playerId) {
  if (!lobbyId) return;
  const map = readLobbyPlayers();
  if (playerId) {
    map[lobbyId] = playerId;
  } else {
    delete map[lobbyId];
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function clearStoredPlayerId(lobbyId) {
  if (!lobbyId) return;
  const map = readLobbyPlayers();
  delete map[lobbyId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}
