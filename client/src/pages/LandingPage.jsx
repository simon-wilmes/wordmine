import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createLobby, getLobby, joinLobby, listGames, listLobbies } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { clearStoredPlayerId, getStoredLobbyIds, getStoredPlayerId, setStoredPlayerId } from "../lib/session";
import AgentCard from "../components/common/AgentCard";

function NameModal({ title, submitLabel, onSubmit, onClose, showVisibility, showLobbyName, t }) {
  const [name, setName] = useState("");
  const [lobbyName, setLobbyName] = useState("");
  const [visibility, setVisibility] = useState("public");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await onSubmit({ name: name.trim(), visibility, lobbyName: lobbyName.trim() || null });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>{title}</h2>
        <form onSubmit={handleSubmit}>
          {showLobbyName && (
            <label>
              {t("lobbyName")}
              <input
                value={lobbyName}
                onChange={(e) => setLobbyName(e.target.value)}
                placeholder={t("enterLobbyName")}
                minLength={2}
                maxLength={30}
                required
              />
            </label>
          )}
          <label style={showLobbyName ? { marginTop: "14px" } : undefined}>
            {t("yourName")}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("enterYourName")}
              minLength={2}
              maxLength={20}
              required
            />
          </label>
          {showVisibility && (
            <label style={{ marginTop: "14px" }}>
              {t("lobbyVisibility")}
              <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                <option value="public">{t("public")}</option>
                <option value="private">{t("private")}</option>
              </select>
            </label>
          )}
          {error && <p className="error" style={{ marginTop: "12px" }}>{error}</p>}
          <div className="button-row">
            <button type="button" className="ghost" onClick={onClose} disabled={loading}>
              {t("cancel")}
            </button>
            <button type="submit" disabled={loading}>
              {loading ? t("working") : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const [lobbies, setLobbies] = useState([]);
  const [loadingLobbies, setLoadingLobbies] = useState(true);
  const [listError, setListError] = useState("");
  const [games, setGames] = useState([]);
  const [loadingGames, setLoadingGames] = useState(true);
  const [gamesError, setGamesError] = useState("");
  const [myGames, setMyGames] = useState([]);
  const [modalMode, setModalMode] = useState(null);
  const [selectedLobbyId, setSelectedLobbyId] = useState("");
  const [inviteJoinMode, setInviteJoinMode] = useState(false);

  const modalTitle = useMemo(() => {
    if (modalMode === "create") return t("startNewGameTitle");
    if (modalMode === "join") return t("joinLobbyTitle");
    return "";
  }, [modalMode, t]);

  async function refreshLobbies() {
    setLoadingLobbies(true);
    setListError("");
    try {
      const data = await listLobbies();
      setLobbies(data.lobbies || []);
    } catch (err) {
      setListError(err.message);
    } finally {
      setLoadingLobbies(false);
    }
  }

  async function refreshGames() {
    setLoadingGames(true);
    setGamesError("");
    try {
      const data = await listGames();
      setGames(data.games || []);
    } catch (err) {
      setGamesError(err.message);
    } finally {
      setLoadingGames(false);
    }
  }

  async function refreshMyGames() {
    const lobbyIds = getStoredLobbyIds();
    if (lobbyIds.length === 0) {
      setMyGames([]);
      return;
    }
    const results = await Promise.all(
      lobbyIds.map(async (id) => {
        try {
          const data = await getLobby(id);
          if (data?.lobby?.status !== "started") return null;
          return { ...data.lobby, gameStatus: data?.gameStatus || null };
        } catch {
          clearStoredPlayerId(id);
          return null;
        }
      })
    );
    setMyGames(results.filter(Boolean));
  }

  useEffect(() => {
    refreshLobbies();
    refreshGames();
    refreshMyGames();
    const id = setInterval(refreshLobbies, 3000);
    const gamesId = setInterval(() => {
      refreshGames();
      refreshMyGames();
    }, 5000);
    return () => {
      clearInterval(id);
      clearInterval(gamesId);
    };
  }, []);

  useEffect(() => {
    const inviteLobbyId = search.get("join");
    if (!inviteLobbyId) return;
    const next = new URLSearchParams(search);
    next.delete("join");
    next.delete("joinSource");
    setSearch(next, { replace: true });
    if (getStoredPlayerId(inviteLobbyId)) {
      navigate(`/lobby/${inviteLobbyId}`);
      return;
    }
    const isInvite = search.get("joinSource") === "invite";
    setSelectedLobbyId(inviteLobbyId);
    setInviteJoinMode(isInvite);
    setModalMode("join");
  }, [search, setSearch, navigate]);

  async function handleCreate({ name, visibility, lobbyName }) {
    const data = await createLobby(name, visibility, lobbyName);
    setStoredPlayerId(data.lobby.id, data.playerId);
    navigate(`/lobby/${data.lobby.id}`);
  }

  async function handleJoin({ name }) {
    const data = await joinLobby(selectedLobbyId, name, inviteJoinMode);
    setStoredPlayerId(data.lobby.id, data.playerId);
    navigate(`/lobby/${data.lobby.id}`);
  }

  return (
    <main className="page">
      <div className="hero-row">
        <AgentCard />
        <section className="card mission-hero">
          <h1>{t("quickLobbyGame")}</h1>
          <p>{t("heroText")}</p>
          <button
            className="cta"
            onClick={() => {
              setSelectedLobbyId("");
              setModalMode("create");
            }}
          >
            {t("startNewGame")}
          </button>
        </section>
      </div>

      <section className="card">
        <div className="active-missions-header">
          <h2>{t("activeLobbies")}</h2>
          <button className="ghost" onClick={refreshLobbies} disabled={loadingLobbies}>
            {t("refresh")}
          </button>
        </div>

        {listError && <p className="error">{listError}</p>}
        {!listError && lobbies.length === 0 && (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t("noActiveLobbies")}</p>
        )}

        <ul className="lobby-list">
          {lobbies.map((lobby) => (
            <li key={lobby.id} className="lobby-item">
              <div>
                <div className="lobby-mission-code">{lobby.name || `Mission ${lobby.id}`}</div>
                <p className="lobby-meta">
                  {lobby.players} {t("players")} &nbsp;·&nbsp;
                  <span className={`lobby-status-badge ${lobby.visibility}`}>
                    {lobby.visibility === "public" ? t("public") : t("private")}
                  </span>
                </p>
              </div>
              <button
                onClick={() => {
                  if (getStoredPlayerId(lobby.id)) {
                    navigate(`/lobby/${lobby.id}`);
                    return;
                  }
                  setSelectedLobbyId(lobby.id);
                  setInviteJoinMode(false);
                  setModalMode("join");
                }}
                disabled={lobby.visibility === "private" && !getStoredPlayerId(lobby.id)}
              >
                {getStoredPlayerId(lobby.id) ? t("rejoinGame") : lobby.visibility === "private" ? t("privateLobby") : t("join")}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="active-missions-header">
          <h2>{t("ongoingGames")}</h2>
          <button className="ghost" onClick={refreshGames} disabled={loadingGames}>
            {t("refresh")}
          </button>
        </div>

        {gamesError && <p className="error">{gamesError}</p>}
        {!gamesError && games.length === 0 && (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t("noOngoingGames")}</p>
        )}

        <ul className="lobby-list">
          {games.filter((game) => !getStoredPlayerId(game.id)).map((game) => (
            <li key={game.id} className="lobby-item">
              <div>
                <div className="lobby-mission-code">{game.name || `Mission ${game.id}`}</div>
                <p className="lobby-meta">
                  {game.players} {t("players")}
                </p>
              </div>
              <button onClick={() => navigate(`/game/${game.id}`)}>
                {t("spectateGame")}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="active-missions-header">
          <h2>{t("yourGames")}</h2>
          <button className="ghost" onClick={refreshMyGames}>
            {t("refresh")}
          </button>
        </div>

        {myGames.length === 0 && (
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t("noYourGames")}</p>
        )}

        <ul className="lobby-list">
          {myGames.map((game) => (
            <li key={game.id} className="lobby-item">
              <div>
                <div className="lobby-mission-code">{game.name || `Mission ${game.id}`}</div>
                <p className="lobby-meta">
                  {game.players.length} {t("players")}
                  {game.gameStatus === "finished" && (
                    <>
                      &nbsp;·&nbsp;
                      <span className="lobby-status-badge finished">{t("finished")}</span>
                    </>
                  )}
                </p>
              </div>
              <button onClick={() => navigate(`/game/${game.id}`)}>
                {game.gameStatus === "finished" ? t("viewResults") : t("rejoinGame")}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {modalMode === "create" && (
        <NameModal
          title={modalTitle}
          submitLabel={t("continue")}
          onSubmit={handleCreate}
          showVisibility
          showLobbyName
          t={t}
          onClose={() => setModalMode(null)}
        />
      )}

      {modalMode === "join" && (
        <NameModal
          title={`${modalTitle}: ${selectedLobbyId}`}
          submitLabel={t("joinLobby")}
          onSubmit={handleJoin}
          t={t}
          onClose={() => {
            setModalMode(null);
            setInviteJoinMode(false);
          }}
        />
      )}
    </main>
  );
}
