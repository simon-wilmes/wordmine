const API_BASE = `/${import.meta.env.VITE_GAME_NAME || "wordmine"}`;

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

export function listLobbies() {
  return request("/api/lobbies");
}

export function listGames() {
  return request("/api/games");
}

export function createLobby(name, visibility, lobbyName = null, browserId = "", wordLanguage = "en") {
  return request("/api/lobbies", {
    method: "POST",
    body: JSON.stringify({ name, visibility, lobbyName, browserId, wordLanguage })
  });
}

export function joinLobby(lobbyId, name, viaInvite = false, browserId = "") {
  return request(`/api/lobbies/${lobbyId}/join`, {
    method: "POST",
    body: JSON.stringify({ name, viaInvite, browserId })
  });
}

export function getLobby(lobbyId) {
  return request(`/api/lobbies/${lobbyId}`);
}

export function getGameHistory(browserId, limit = 30, offset = 0) {
  const params = new URLSearchParams({
    browserId,
    limit: String(limit),
    offset: String(offset)
  });
  return request(`/api/games/history?${params.toString()}`);
}

export function getHistoricalGame(lobbyId, browserId) {
  const params = new URLSearchParams({ browserId });
  return request(`/api/games/history/${lobbyId}?${params.toString()}`);
}
