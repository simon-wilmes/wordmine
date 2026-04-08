const STORAGE_KEY = "lobbyPlayers";
const LEGACY_KEY = "lobbySession";
const BROWSER_ID_KEY = "browserId";

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

function makeBrowserId() {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }
  // Fallback for old environments; modern browsers should always use Web Crypto above.
  return `${Date.now().toString(16).padStart(16, "0")}${Math.random().toString(16).slice(2).padEnd(112, "0")}`.slice(0, 128);
}

function normalizeBrowserId(value) {
  const normalized = String(value || "").trim();
  if (normalized.length < 16 || normalized.length > 128) {
    return "";
  }
  return normalized;
}

export function getStoredBrowserId() {
  return normalizeBrowserId(localStorage.getItem(BROWSER_ID_KEY) || "");
}

export function getOrCreateBrowserId() {
  const existing = getStoredBrowserId();
  if (existing) {
    return existing;
  }
  const next = makeBrowserId();
  localStorage.setItem(BROWSER_ID_KEY, next);
  return next;
}
