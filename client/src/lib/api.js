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

export function createLobby(name, visibility, lobbyName = null) {
  return request("/api/lobbies", {
    method: "POST",
    body: JSON.stringify({ name, visibility, lobbyName })
  });
}

export function joinLobby(lobbyId, name, viaInvite = false) {
  return request(`/api/lobbies/${lobbyId}/join`, {
    method: "POST",
    body: JSON.stringify({ name, viaInvite })
  });
}

export function getLobby(lobbyId) {
  return request(`/api/lobbies/${lobbyId}`);
}
