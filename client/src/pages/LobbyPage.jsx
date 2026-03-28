import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useI18n } from "../lib/i18n";
import { getLobby } from "../lib/api";
import { getSocket } from "../lib/socket";
import { clearStoredPlayerId, getStoredPlayerId } from "../lib/session";

const DEBUG = true;

function logDebug(message, payload) {
  if (!DEBUG) return;
  console.log(`[lobby-debug] ${message}`, payload ?? "");
}

export default function LobbyPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { lobbyId } = useParams();
  const playerId = getStoredPlayerId(lobbyId);

  const [lobby, setLobby] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [copiedInvite, setCopiedInvite] = useState(false);
  const [showUnsavedStartWarning, setShowUnsavedStartWarning] = useState(false);
  const [draftSettings, setDraftSettings] = useState({
    visibility: "public",
    gameConfig: {
      wordLanguage: "en",
      cycles: 1,
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
      simultaneousClue: false,
      greenCards: 14,
      redCards: 10,
      blackCards: 1
    }
  });

  const me = useMemo(() => lobby?.players?.find((p) => p.id === playerId), [lobby, playerId]);
  const isHost = !!me?.isHost;
  const settingsDirty = useMemo(() => {
    if (!lobby?.settings || !draftSettings) return false;
    return JSON.stringify(lobby.settings) !== JSON.stringify(draftSettings);
  }, [lobby?.settings, draftSettings]);

  useEffect(() => {
    if (!lobbyId) {
      setError("Missing lobby ID. Return to landing and join again.");
      setLoading(false);
      return;
    }
    if (!playerId) {
      setError("Missing player session. Return to landing and join again.");
      setLoading(false);
      return;
    }

    let mounted = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        logDebug("fetching lobby snapshot", { lobbyId, playerId });
        const data = await getLobby(lobbyId);
        if (!mounted) return;
        setLobby(data.lobby);
        setDraftSettings(data.lobby.settings);
        if (data.lobby?.status === "started") {
          navigate(`/game/${data.lobby.id}`);
          return;
        }
        logDebug("loaded lobby snapshot", data.lobby);
      } catch (err) {
        if (!mounted) return;
        setError(err.message);
        logDebug("failed to load lobby snapshot", { error: err.message, lobbyId, playerId });
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => { mounted = false; };
  }, [lobbyId, playerId]);

  useEffect(() => {
    if (!lobbyId) return;

    const socket = getSocket();

    function onLobbyUpdated(nextLobby) {
      logDebug("received lobby-updated", nextLobby);
      setLobby(nextLobby);
      setDraftSettings(nextLobby.settings);
      if (nextLobby?.status === "started") {
        navigate(`/game/${nextLobby.id}`);
      }
    }

    function onLobbyClosed() {
      logDebug("received lobby-closed", { lobbyId, playerId });
      setError("Host left. Lobby was closed.");
      setTimeout(() => navigate("/"), 1200);
    }

    function onGameStarted(payload) {
      logDebug("received game-started", payload);
      navigate(`/game/${payload.lobbyId}`);
    }

    socket.on("lobby-updated", onLobbyUpdated);
    socket.on("lobby-closed", onLobbyClosed);
    socket.on("game-started", onGameStarted);
    socket.on("kicked-from-lobby", () => {
      clearStoredPlayerId(lobbyId);
      setError("You were kicked from the lobby.");
      setTimeout(() => navigate("/"), 1000);
    });

    logDebug("emitting join-lobby", { lobbyId, playerId });
    socket.emit("join-lobby", { lobbyId, playerId }, (ack) => {
      logDebug("join-lobby ack", ack);
      if (!ack?.ok) {
        setError(ack?.error || "Failed to join lobby socket.");
        return;
      }
      setLobby(ack.lobby);
    });

    return () => {
      socket.off("lobby-updated", onLobbyUpdated);
      socket.off("lobby-closed", onLobbyClosed);
      socket.off("game-started", onGameStarted);
      socket.off("kicked-from-lobby");
    };
  }, [lobbyId, playerId, navigate]);

  function leaveLobbyAndGoHome() {
    const socket = getSocket();
    logDebug("emitting leave-lobby", { lobbyId, playerId });
    socket.emit("leave-lobby", { lobbyId, playerId }, (ack) => {
      logDebug("leave-lobby ack", ack);
      clearStoredPlayerId(lobbyId);
      navigate("/");
    });
  }

  function updateSettingField(key, value) {
    setDraftSettings((prev) => ({ ...prev, [key]: value }));
  }

  function updateGameConfigField(key, value) {
    setDraftSettings((prev) => ({
      ...prev,
      gameConfig: { ...(prev.gameConfig || {}), [key]: value }
    }));
  }

  function saveSettings() {
    const socket = getSocket();
    setMessage("");
    setError("");

    socket.emit(
      "update-settings",
      {
        lobbyId,
        playerId,
        settings: {
          visibility: draftSettings.visibility,
          gameConfig: {
            wordLanguage: String(draftSettings.gameConfig?.wordLanguage || "en"),
            cycles: Number(draftSettings.gameConfig?.cycles),
            cluePhaseSeconds: Number(draftSettings.gameConfig?.cluePhaseSeconds),
            guessPhaseSeconds: Number(draftSettings.gameConfig?.guessPhaseSeconds),
            betweenRoundsSeconds: Number(draftSettings.gameConfig?.betweenRoundsSeconds),
            clueCardValue: Number(draftSettings.gameConfig?.clueCardValue),
            guesserCardPool: Number(draftSettings.gameConfig?.guesserCardPool),
            rankBonus1: Number(draftSettings.gameConfig?.rankBonus1),
            rankBonus2: Number(draftSettings.gameConfig?.rankBonus2),
            rankBonus3: Number(draftSettings.gameConfig?.rankBonus3),
            redPenalty: Number(draftSettings.gameConfig?.redPenalty),
            blackPenalty: Number(draftSettings.gameConfig?.blackPenalty),
            penalizeClueGiverForWrongGuesses: Boolean(
              draftSettings.gameConfig?.penalizeClueGiverForWrongGuesses
            ),
            simultaneousClue: Boolean(draftSettings.gameConfig?.simultaneousClue),
            greenCards: Number(draftSettings.gameConfig?.greenCards),
            redCards: Number(draftSettings.gameConfig?.redCards),
            blackCards: Number(draftSettings.gameConfig?.blackCards)
          }
        }
      },
      (ack) => {
        if (!ack?.ok) {
          setError(ack?.error || "Could not save settings.");
          return;
        }
        setMessage("Settings saved.");
      }
    );
  }

  function kickPlayer(targetPlayerId) {
    const socket = getSocket();
    setError("");
    setMessage("");
    socket.emit("kick-player", { lobbyId, playerId, targetPlayerId }, (ack) => {
      if (!ack?.ok) {
        setError(ack?.error || "Could not kick player.");
        return;
      }
      setMessage("Player removed.");
    });
  }

  function startGameNow() {
    const socket = getSocket();
    setMessage("");
    setError("");
    socket.emit("start-game", { lobbyId, playerId }, (ack) => {
      if (!ack?.ok) {
        setError(ack?.error || "Could not start game.");
      }
    });
  }

  function onStartGameClick() {
    if (settingsDirty) {
      setShowUnsavedStartWarning(true);
      return;
    }
    startGameNow();
  }

  async function copyInviteLink() {
    if (!lobby?.id) return;
    const link = `${window.location.origin}/${import.meta.env.VITE_GAME_NAME || "wordmine"}/?join=${lobby.id}&joinSource=invite`;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedInvite(true);
      setTimeout(() => setCopiedInvite(false), 1400);
    } catch {
      setError("Could not copy invite link.");
    }
  }

  if (loading) {
    return (
      <main className="page">
        <section className="card">
          <p style={{ color: "var(--text-muted)" }}>{t("loadingLobby")}</p>
        </section>
      </main>
    );
  }

  if (error && !lobby) {
    return (
      <main className="page">
        <section className="card">
          <p className="error">{error}</p>
          <button onClick={() => navigate("/")}>{t("backToLanding")}</button>
        </section>
      </main>
    );
  }

  const inviteLink = `${window.location.origin}/${import.meta.env.VITE_GAME_NAME || "wordmine"}/?join=${lobby.id}&joinSource=invite`;

  return (
    <main className="page">
      <section className="card">
        <div className="section-head">
          <div>
            <h1>{t("lobby")} {lobby.id}</h1>
            <p style={{ color: "var(--text-muted)", fontSize: "0.82rem", margin: 0 }}>
              {t("status")}: <strong style={{ color: "var(--text)" }}>{lobby.status}</strong>
            </p>
          </div>
          <button className="ghost" onClick={leaveLobbyAndGoHome}>{t("exit")}</button>
        </div>

        {error && <p className="error">{error}</p>}
        {message && <p className="success">{message}</p>}

        <h2 style={{ marginBottom: "14px" }}>{t("players")} ({lobby.players.length})</h2>
        <ul className="player-list">
          {lobby.players.map((player) => (
            <li
              key={player.id}
              className={`agent-badge${player.isHost ? " is-host" : ""}${player.id === playerId ? " is-self" : ""}`}
            >
              <div className="agent-avatar" style={player.color ? { background: player.color } : undefined}>{player.name.charAt(0)}</div>
              <div className="agent-info">
                <span className="agent-name" style={player.color ? { color: player.color } : undefined}>{player.name}</span>
                {player.isHost && <span className="agent-role-tag">Handler</span>}
                {player.id === playerId && <span className="agent-self-tag">{t("you")}</span>}
                {!player.connected && <span className="agent-offline">{t("offline")}</span>}
              </div>
              {isHost && !player.isHost && (
                <button
                  type="button"
                  className="agent-kick-btn"
                  onClick={() => kickPlayer(player.id)}
                  title={`Kick ${player.name}`}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>

        <div style={{ marginTop: "20px" }}>
          <h2>{t("inviteLink")}</h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>{t("inviteHelp")}</p>
          <div className="button-row">
            <button className="ghost" onClick={copyInviteLink} type="button">
              {copiedInvite ? t("copied") : t("copyInviteLink")}
            </button>
          </div>
          <div style={{ marginTop: "10px" }}>
            <span className="invite-link-display">{inviteLink}</span>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>{t("lobbySettings")}</h2>
        {!isHost && (
          <p style={{ color: "var(--text-muted)", fontSize: "0.82rem", marginBottom: "18px" }}>
            {t("hostOnlySettings")}
          </p>
        )}

        {/* Game mode */}
        <div className="settings-section">
          <p className="settings-section-title">{t("gameMode")}</p>
          <div className="settings-grid">
            <label className="span-full">
              {t("simultaneousClue")}
              <select
                value={draftSettings.gameConfig?.simultaneousClue ? "yes" : "no"}
                onChange={(e) =>
                  updateGameConfigField("simultaneousClue", e.target.value === "yes")
                }
                disabled={!isHost}
              >
                <option value="no">{t("no")}</option>
                <option value="yes">{t("yes")}</option>
              </select>
              <small>{t("simultaneousClueHelp")}</small>
            </label>
          </div>
        </div>

        {/* Lobby visibility */}
        <div className="settings-section">
          <p className="settings-section-title">Lobby</p>
          <div className="settings-grid">
            <label>
              {t("lobbyVisibility")}
              <select
                value={draftSettings.visibility}
                onChange={(e) => updateSettingField("visibility", e.target.value)}
                disabled={!isHost}
              >
                <option value="public">{t("public")}</option>
                <option value="private">{t("private")}</option>
              </select>
            </label>
            <label>
              {t("wordLanguage")}
              <select
                value={draftSettings.gameConfig?.wordLanguage ?? "en"}
                onChange={(e) => updateGameConfigField("wordLanguage", e.target.value)}
                disabled={!isHost}
              >
                <option value="en">{t("english")}</option>
                <option value="de">{t("german")}</option>
              </select>
            </label>
            <label>
              {t("cycles")}
              <input
                type="number" min="1" max="30"
                value={draftSettings.gameConfig?.cycles ?? 1}
                onChange={(e) => updateGameConfigField("cycles", e.target.value)}
                disabled={!isHost}
              />
            </label>
          </div>
        </div>

        {/* Card Distribution */}
        <div className="settings-section">
          <p className="settings-section-title">{t("cardDistribution")}</p>
          <div className="settings-grid">
            <label>
              {t("greenCards")}
              <input
                type="number" min="1" max="23"
                value={draftSettings.gameConfig?.greenCards ?? 14}
                onChange={(e) => updateGameConfigField("greenCards", e.target.value)}
                disabled={!isHost}
              />
            </label>
            <label>
              {t("redCards")}
              <input
                type="number" min="0" max="24"
                value={draftSettings.gameConfig?.redCards ?? 10}
                onChange={(e) => updateGameConfigField("redCards", e.target.value)}
                disabled={!isHost}
              />
            </label>
            <label>
              {t("blackCards")}
              <input
                type="number" min="0" max="24"
                value={draftSettings.gameConfig?.blackCards ?? 1}
                onChange={(e) => updateGameConfigField("blackCards", e.target.value)}
                disabled={!isHost}
              />
            </label>
          </div>
          {(() => {
            const sum = Number(draftSettings.gameConfig?.greenCards || 0)
              + Number(draftSettings.gameConfig?.redCards || 0)
              + Number(draftSettings.gameConfig?.blackCards || 0);
            return sum !== 25 ? (
              <p className="error" style={{ marginTop: "6px" }}>
                {t("cardSumError")} ({sum}/25)
              </p>
            ) : null;
          })()}
        </div>

        {/* Timing */}
        <div className="settings-section">
          <p className="settings-section-title">Timing</p>
          <div className="settings-grid">
            <label>
              {t("cluePhaseSeconds")}
              <input
                type="number" min="-1" max="600"
                value={draftSettings.gameConfig?.cluePhaseSeconds ?? 60}
                onChange={(e) => updateGameConfigField("cluePhaseSeconds", e.target.value)}
                disabled={!isHost}
              />
              <small>{t("cluePhaseHelp")}</small>
            </label>
            <label>
              {t("guessPhaseSeconds")}
              <input
                type="number" min="10" max="600"
                value={draftSettings.gameConfig?.guessPhaseSeconds ?? 60}
                onChange={(e) => updateGameConfigField("guessPhaseSeconds", e.target.value)}
                disabled={!isHost}
              />
            </label>
            <label>
              {t("betweenRoundsSeconds")}
              <input
                type="number" min="0" max="120"
                value={draftSettings.gameConfig?.betweenRoundsSeconds ?? 15}
                onChange={(e) => updateGameConfigField("betweenRoundsSeconds", e.target.value)}
                disabled={!isHost}
              />
            </label>
          </div>
        </div>

        {/* Scoring */}
        <div className="settings-section">
          <p className="settings-section-title">Scoring</p>
          <div className="settings-grid">
            <label>
              {t("clueCardValue")}
              <input
                type="number" min="1" max="2000"
                value={draftSettings.gameConfig?.clueCardValue ?? 300}
                onChange={(e) => updateGameConfigField("clueCardValue", e.target.value)}
                disabled={!isHost}
              />
            </label>
            <label>
              {t("guesserCardPool")}
              <input
                type="number" min="1" max="2000"
                value={draftSettings.gameConfig?.guesserCardPool ?? 200}
                onChange={(e) => updateGameConfigField("guesserCardPool", e.target.value)}
                disabled={!isHost}
              />
            </label>
            <label>
              {t("rankBonus1")}
              <input
                type="number" min="0" max="2000"
                value={draftSettings.gameConfig?.rankBonus1 ?? 50}
                onChange={(e) => updateGameConfigField("rankBonus1", e.target.value)}
                disabled={!isHost}
              />
            </label>
            <label>
              {t("rankBonus2")}
              <input
                type="number" min="0" max="2000"
                value={draftSettings.gameConfig?.rankBonus2 ?? 25}
                onChange={(e) => updateGameConfigField("rankBonus2", e.target.value)}
                disabled={!isHost}
              />
            </label>
            <label>
              {t("rankBonus3")}
              <input
                type="number" min="0" max="2000"
                value={draftSettings.gameConfig?.rankBonus3 ?? 15}
                onChange={(e) => updateGameConfigField("rankBonus3", e.target.value)}
                disabled={!isHost}
              />
            </label>
          </div>
        </div>

        {/* Penalties */}
        <div className="settings-section">
          <p className="settings-section-title">Penalties</p>
          <div className="settings-grid">
            <label>
              {t("redPenalty")}
              <input
                type="number" min="0" max="2000"
                value={draftSettings.gameConfig?.redPenalty ?? 50}
                onChange={(e) => updateGameConfigField("redPenalty", e.target.value)}
                disabled={!isHost}
              />
            </label>
            <label>
              {t("blackPenalty")}
              <input
                type="number" min="0" max="5000"
                value={draftSettings.gameConfig?.blackPenalty ?? 200}
                onChange={(e) => updateGameConfigField("blackPenalty", e.target.value)}
                disabled={!isHost}
              />
            </label>
            <label className="span-full">
              {t("penalizeClueGiverWrong")}
              <select
                value={draftSettings.gameConfig?.penalizeClueGiverForWrongGuesses ? "yes" : "no"}
                onChange={(e) =>
                  updateGameConfigField("penalizeClueGiverForWrongGuesses", e.target.value === "yes")
                }
                disabled={!isHost}
              >
                <option value="yes">{t("yes")}</option>
                <option value="no">{t("no")}</option>
              </select>
            </label>
          </div>
        </div>

        <div className="button-row">
          {isHost && (
            <button className="ghost" onClick={saveSettings}>
              {t("saveSettings")}
            </button>
          )}
          <button
            className="cta"
            onClick={onStartGameClick}
            disabled={!isHost || lobby.players.length < 2 || lobby.status !== "waiting"}
          >
            {t("startGame")}
          </button>
        </div>

        {isHost && settingsDirty && (
          <p className="error" style={{ marginTop: "10px" }}>{t("unsavedSettingsDetected")}</p>
        )}
      </section>

      {showUnsavedStartWarning && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Unsaved settings warning">
          <div className="modal">
            <h3>{t("unsavedSettingsTitle")}</h3>
            <p style={{ color: "var(--text-muted)", fontSize: "0.88rem" }}>{t("unsavedSettingsText")}</p>
            <div className="button-row">
              <button
                className="ghost"
                onClick={() => {
                  setShowUnsavedStartWarning(false);
                  saveSettings();
                }}
              >
                {t("saveFirst")}
              </button>
              <button
                onClick={() => {
                  setShowUnsavedStartWarning(false);
                  startGameNow();
                }}
              >
                {t("continueAnyway")}
              </button>
              <button className="ghost" onClick={() => setShowUnsavedStartWarning(false)}>
                {t("cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
