import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getLobby } from "../lib/api";
import StatsChips from "../components/game/StatsChips";
import { useI18n } from "../lib/i18n";
import { cardClass, getCardMarkerNames } from "../lib/gameViewModel";
import { getStoredPlayerId, setStoredPlayerId } from "../lib/session";
import { getSocket } from "../lib/socket";

const PHASE_LABELS = {
  clue: "⟡ Handler Transmitting",
  "clue-all": "⟡ All Handlers Transmitting",
  guess: "⚡ Operatives Active",
  "round-end": "⟐ Mission Debrief",
};

export default function GamePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { lobbyId } = useParams();
  const resolvedPlayerId = getStoredPlayerId(lobbyId) || null;
  const playerId = resolvedPlayerId;

  const [game, setGame] = useState(null);
  const [error, setError] = useState("");
  const [clue, setClue] = useState("");
  const [selectedCards, setSelectedCards] = useState([]);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [chatInput, setChatInput] = useState("");
  const [isChatOpen, setIsChatOpen] = useState(true);
  const [showRematchPopup, setShowRematchPopup] = useState(false);
  const rematchPopupShownForLobbyId = useRef(null);

  const isClueGiver = game?.role === "clue-giver";
  const isClueAll = game?.role === "clue-all";
  const isGuesser = game?.role === "guesser";

  const clueRef = useRef(clue);
  const selectedCardsRef = useRef(selectedCards);
  clueRef.current = clue;
  selectedCardsRef.current = selectedCards;
  const myFinished = Boolean(game?.myGuesserState?.finished);

  // How many target cards have been correctly found:
  // - Clue giver sees aggregate across all guessers (has clueSelectedIndexes + allGuesserActions)
  // - Guesser sees their personal count only
  const foundCount = useMemo(() => {
    if (!game?.clue) return 0;
    if (isClueGiver && game.clueSelectedIndexes?.length > 0) {
      const foundIndexes = new Set();
      for (const actor of game.allGuesserActions || []) {
        for (const idx of actor.guessedCorrect || []) {
          if (game.clueSelectedIndexes.includes(idx)) foundIndexes.add(idx);
        }
      }
      return foundIndexes.size;
    }
    return game.myGuesserState?.guessedCorrect?.length ?? 0;
  }, [game, isClueGiver]);

  const scoreRows = useMemo(() => {
    if (!game?.scores) return [];
    return [...game.scores].sort((a, b) => b.total - a.total);
  }, [game]);

  const myScoreRow = useMemo(
    () => scoreRows.find((row) => row.playerId === playerId) || null,
    [scoreRows, playerId]
  );

  const endStatsRows = useMemo(() => {
    if (!game?.playerStats || !game?.scores) return [];
    const statsById = Object.fromEntries(game.playerStats.map((s) => [s.playerId, s]));
    return scoreRows.map((row) => ({
      ...row,
      ...(statsById[row.playerId] || {
        correctGreen: 0,
        neutralGreen: 0,
        red: 0,
        black: 0,
        totalGuessed: 0
      })
    }));
  }, [game, scoreRows]);

  const podiumColorGroupByScore = useMemo(() => {
    const topThree = endStatsRows.slice(0, 3);
    const groups = {};
    let groupIndex = 0;
    for (const row of topThree) {
      if (groups[row.total] === undefined) {
        groups[row.total] = groupIndex;
        groupIndex += 1;
      }
    }
    return groups;
  }, [endStatsRows]);

  useEffect(() => {
    if (!lobbyId) {
      setError(t("missingLobbyInfo"));
      return;
    }

    let mounted = true;
    const socket = getSocket();

    async function init() {
      try {
        const lobbyData = await getLobby(lobbyId);
        if (lobbyData?.lobby?.status !== "started") {
          setError(t("gameNotStarted"));
          return;
        }
      } catch (err) {
        setError(err.message);
        return;
      }

      socket.emit("join-lobby", { lobbyId, playerId: resolvedPlayerId }, () => {
        socket.emit("game:get-state", { lobbyId, playerId: resolvedPlayerId }, (ack) => {
          if (!mounted) return;
          if (!ack?.ok) {
            setError(ack?.error || "Could not load game state.");
            return;
          }
          if (ack.game?.lobbyId && ack.game.lobbyId !== lobbyId) {
            return;
          }
          setGame(ack.game);
        });
      });
    }

    function onGameState(nextGame) {
      if (!mounted) return;
      if (nextGame?.lobbyId && nextGame.lobbyId !== lobbyId) {
        return;
      }
      setGame(nextGame);
      if (nextGame?.phase !== "clue" && nextGame?.phase !== "clue-all") {
        setSelectedCards([]);
      }
    }

    socket.on("game-state", onGameState);
    init();

    return () => {
      mounted = false;
      socket.off("game-state", onGameState);
    };
  }, [lobbyId, resolvedPlayerId]);

  // Show rematch popup to non-host players when host creates a rematch
  useEffect(() => {
    const rematchId = game?.rematchLobbyId || null;
    const canJoinRematch = Boolean(game?.canJoinRematch);
    const isNonHostPlayer = Boolean(playerId && game?.hostId !== playerId);

    if (!canJoinRematch) {
      setShowRematchPopup(false);
    }

    // Reset one-time popup memory when rematch is cleared.
    if (!rematchId) {
      rematchPopupShownForLobbyId.current = null;
      return;
    }

    // Show exactly once per rematch lobby, and only for non-host players.
    if (
      canJoinRematch
      && isNonHostPlayer
      && rematchPopupShownForLobbyId.current !== rematchId
    ) {
      setShowRematchPopup(true);
      rematchPopupShownForLobbyId.current = rematchId;
    }
  }, [game?.canJoinRematch, game?.rematchLobbyId, game?.hostId, playerId]);

  useEffect(() => {
    const socket = getSocket();

    function onRematchClosed() {
      setShowRematchPopup(false);
      rematchPopupShownForLobbyId.current = null;
      setGame((prev) => (
        prev
          ? {
              ...prev,
              rematchLobbyId: null,
              rematchHostConnected: false,
              canJoinRematch: false
            }
          : prev
      ));
    }

    socket.on("game:rematch-closed", onRematchClosed);
    return () => socket.off("game:rematch-closed", onRematchClosed);
  }, []);

  // Timer countdown
  useEffect(() => {
    if (!game?.phaseStartedAt || !game?.config) return;

    const interval = setInterval(() => {
      const config = game.config;
      const now = Date.now();
      const elapsedMs = now - game.phaseStartedAt;
      let phaseDurationMs = 0;

      if (game.phase === "clue-all") {
        if (!game.clueAllEndsAt) {
          setSecondsRemaining(-1);
          return;
        }
        const remainingMs = Math.max(0, game.clueAllEndsAt - Date.now());
        setSecondsRemaining(Math.ceil(remainingMs / 1000));
        return;
      }
      if (game.phase === "clue") {
        const clueSeconds = config.cluePhaseSeconds;
        if (clueSeconds <= 0) { setSecondsRemaining(-1); return; }
        phaseDurationMs = clueSeconds * 1000;
      } else if (game.phase === "guess") {
        phaseDurationMs = (config.guessPhaseSeconds || 60) * 1000;
      } else if (game.phase === "round-end") {
        phaseDurationMs = (config.betweenRoundsSeconds || 15) * 1000;
      }

      const remainingMs = Math.max(0, phaseDurationMs - elapsedMs);
      setSecondsRemaining(Math.ceil(remainingMs / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [game?.phaseStartedAt, game?.phase, game?.config]);

  // Auto-submit clue when server signals time is up
  useEffect(() => {
    const socket = getSocket();
    function onClueTimeUp() {
      if (!isClueGiver && !isClueAll) {
        return;
      }
      const pendingClue = clueRef.current.trim();
      const pendingCards = selectedCardsRef.current;
      if (pendingClue.length >= 2 && pendingCards.length >= 1) {
        socket.emit("game:submit-clue", {
          lobbyId, playerId, clue: pendingClue,
          clueCount: pendingCards.length, selectedIndexes: pendingCards,
        });
      } else {
        socket.emit("game:cant-submit-clue", { lobbyId, playerId });
      }
    }
    socket.on("clue-time-up", onClueTimeUp);
    return () => socket.off("clue-time-up", onClueTimeUp);
  }, [lobbyId, playerId, isClueGiver, isClueAll]);

  function toggleClueCard(index) {
    if (!isClueGiver && !isClueAll) return;
    if (game?.phase !== "clue" && game?.phase !== "clue-all") return;
    const card = game.cards[index];
    if (!card || card.role !== "green") return;

    setSelectedCards((prev) =>
      prev.includes(index) ? prev.filter((v) => v !== index) : [...prev, index]
    );
  }

  function submitClue() {
    const socket = getSocket();
    setError("");
    socket.emit(
      "game:submit-clue",
      { lobbyId, playerId, clue: clue.trim(), clueCount: selectedCards.length, selectedIndexes: selectedCards },
      (ack) => {
        if (!ack?.ok) { setError(ack?.error || "Failed to submit clue."); return; }
        setClue("");
      }
    );
  }

  function markCard(index) {
    if (!isGuesser || game?.phase !== "guess" || myFinished) return;
    getSocket().emit("game:mark-card", { lobbyId, playerId, cardIndex: index });
  }

  function guessCard(index) {
    if (!isGuesser || game?.phase !== "guess" || myFinished) return;
    setError("");
    getSocket().emit("game:guess-card", { lobbyId, playerId, cardIndex: index }, (ack) => {
      if (!ack?.ok) setError(ack?.error || "Guess failed.");
    });
  }

  function requestRematch() {
    const socket = getSocket();
    setError("");
    socket.emit("game:request-rematch", { lobbyId, playerId, playerColor: myScoreRow?.color || null }, (ack) => {
      if (!ack?.ok) {
        setError(ack?.error || "Failed to create rematch.");
        return;
      }
      if (ack.newPlayerId && ack.rematchLobbyId) {
        setStoredPlayerId(ack.rematchLobbyId, ack.newPlayerId);
        navigate(`/lobby/${ack.rematchLobbyId}`);
      }
    });
  }

  function sendChat() {
    if (!playerId) return;
    const message = chatInput.trim();
    if (!message) return;
    setError("");
    getSocket().emit("game:send-message", { lobbyId, playerId, message }, (ack) => {
      if (!ack?.ok) {
        setError(ack?.error || "Failed to send message.");
        return;
      }
      setChatInput("");
    });
  }

  if (error && !game) {
    return (
      <main className="page">
        <section className="card">
          <h1>{t("game")}</h1>
          <p className="error">{error}</p>
          <button onClick={() => navigate("/")}>{t("backToLanding")}</button>
        </section>
      </main>
    );
  }

  if (!game) {
    return (
      <main className="page">
        <section className="card">
          <p style={{ color: "var(--text-muted)" }}>{t("loadingGame")}</p>
        </section>
      </main>
    );
  }

  // ── END GAME ──────────────────────────────────────────────────────────────
  if (game.status === "finished") {
    const podium = endStatsRows.slice(0, 3);
    const others = endStatsRows.slice(3);
    return (
      <main className="page game-page game-end-page">
        <section className="card game-center-panel">
          <div className="end-game-header">
            <div>
              <h1>{t("gameOver")}</h1>
              <p>{t("finalRankingStats")}</p>
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {playerId && (
                game.hostId === playerId ? (
                  <button className="cta" onClick={requestRematch}>
                    {game.rematchLobbyId ? t("goToRematch") : t("rematch")}
                  </button>
                ) : game.canJoinRematch ? (
                  <button className="cta" onClick={requestRematch}>
                    {t("joinRematch")}
                  </button>
                ) : null
              )}
              <button className="ghost" onClick={() => navigate("/")}>{t("backToLanding")}</button>
            </div>
          </div>

          <div className="podium-grid">
            {podium.map((p, idx) => (
              <div
                key={p.playerId}
                className={`podium-card place-${idx + 1} tie-group-${podiumColorGroupByScore[p.total] ?? idx}`}
              >
                <p className="podium-place">#{idx + 1}</p>
                <h3 style={p.color ? { color: p.color } : undefined}>{p.name}</h3>
                <p className="podium-score">{p.total} {t("pts")}</p>
                <StatsChips stats={p} />
                <p className="podium-total-guessed">{t("totalGuessed")}: {p.totalGuessed}</p>
              </div>
            ))}
          </div>

          {others.length > 0 && (
            <div className="end-list">
              <h3>{t("remainingPlayers")}</h3>
              <ul className="end-list-items">
                {others.map((p, idx) => (
                  <li key={p.playerId} className="end-list-item">
                    <span className="end-list-rank">#{idx + 4}</span>
                    <span className="end-list-name" style={p.color ? { color: p.color } : undefined}>{p.name}</span>
                    <span className="end-list-score">{p.total} {t("pts")}</span>
                    <StatsChips stats={p} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {showRematchPopup && (
          <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t("rematchPopupTitle")}>
            <div className="modal">
              <h3>{t("rematchPopupTitle")}</h3>
              <p style={{ color: "var(--text-muted)", fontSize: "0.88rem" }}>{t("rematchPopupText")}</p>
              <div className="button-row">
                <button className="cta" onClick={() => { setShowRematchPopup(false); requestRematch(); }}>
                  {t("joinRematch")}
                </button>
                <button className="ghost" onClick={() => setShowRematchPopup(false)}>
                  {t("dismiss")}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    );
  }

  // ── ACTIVE GAME ───────────────────────────────────────────────────────────
  return (
    <>
      <main className="page game-page">

      {/* LEFT — Scores */}
      <section className="card game-left-panel">
        <h2>{t("scores")}</h2>
        <ul className="score-list">
          {scoreRows.map((row) => (
            <li key={row.playerId} className="score-row">
              <span className="score-rank" />
              <span className="score-name" style={row.color ? { color: row.color } : undefined}>{row.name}</span>
              <span className="score-pts">{row.total}</span>
            </li>
          ))}
        </ul>
        <p className="round-indicator">
          {t("round")} {game.roundNumber} / {game.totalRounds}
        </p>
        {game.subRoundTotal > 0 && game.phase === "guess" && (
          <p className="round-indicator">
            {t("subRound")} {(game.subRoundIndex ?? 0) + 1} / {game.subRoundTotal}
          </p>
        )}
      </section>

      {/* CENTER — Board */}
      <section className="card game-center-panel">
        <div className="game-header">
          <div className="game-title-block">
            <h1>{t("codenamesVariant")}</h1>
            <div className="game-badges-row">
              <span className={`phase-badge phase-${game.phase}`}>
                {PHASE_LABELS[game.phase] || game.phase}
              </span>
              <span className="role-badge">
                {t("role")}: {game.role}
              </span>
              {game.phase !== "clue-all" && (
                <span className="handler-badge">
                  {t("clueGiver")}: {game.clueGiver.name}
                </span>
              )}
              {game.phase === "clue-all" && (
                <span className="handler-badge">
                  {t("simultaneousCluePhase")}
                </span>
              )}
            </div>
          </div>
          <button className="ghost" onClick={() => navigate("/")}>{t("backToLanding")}</button>
        </div>

        {error && <p className="error">{error}</p>}

        <div className="game-grid">
          {game.cards.map((card) => {
            const selectedForClue =
              selectedCards.includes(card.index) ||
              ((isClueGiver || isClueAll) && (game.clueSelectedIndexes || []).includes(card.index));
            const markerNames = getCardMarkerNames(card.index, game.allGuesserActions);
            const mineMarked = game.myGuesserState?.marks?.includes(card.index);
            const mineCorrect = game.myGuesserState?.guessedCorrect?.includes(card.index);
            const mineWrong = game.myGuesserState?.guessedWrong?.includes(card.index);
            const mineWrongRed = game.myGuesserState?.guessedWrongRed?.includes(card.index);
            const mineWrongBlack = game.myGuesserState?.guessedWrongBlack?.includes(card.index);
            const mineNeutral = game.myGuesserState?.guessedNeutral?.includes(card.index);
            const mineGuessed = Boolean(
              mineCorrect || mineWrong || mineWrongRed || mineWrongBlack || mineNeutral
            );
            const alreadyGuessed = Boolean(mineCorrect || mineWrong || mineNeutral);

            return (
              <button
                key={card.index}
                className={[
                  cardClass(card, game, selectedForClue, mineCorrect, mineNeutral, mineWrongRed, mineWrongBlack),
                  game.phase === "guess" && mineMarked && !mineGuessed ? "mine-mark" : "",
                  game.phase === "guess" && mineGuessed ? "mine-guessed" : "",
                  mineCorrect ? "mine-correct" : "",
                  mineWrong ? "mine-wrong" : "",
                ].filter(Boolean).join(" ")}
                type="button"
                onClick={() => {
                  if (isClueGiver || isClueAll) toggleClueCard(card.index);
                  else if (!alreadyGuessed) markCard(card.index);
                }}
                onDoubleClick={() => {
                  if (isGuesser && !alreadyGuessed) guessCard(card.index);
                }}
                disabled={game.status === "finished" || (isGuesser && alreadyGuessed)}
              >
                <span>{card.word}</span>
                {(isClueGiver || game.phase === "round-end" || game.status === "finished") &&
                  markerNames.length > 0 && (
                    <div className="card-markers">
                      {markerNames.map((entry) => (
                        <span
                          key={entry.key}
                          className={`card-marker-pill ${entry.state}`}
                          style={entry.color ? { color: entry.color, borderColor: entry.color } : undefined}
                          title={`${entry.name} ${entry.state === "mark" ? "marked" : "guessed"} this card`}
                        >
                          {entry.name}
                        </span>
                      ))}
                    </div>
                  )}
              </button>
            );
          })}
        </div>

        {isClueGiver && game.phase === "clue" && (
          <div className="clue-box">
            <h3>{t("submitClue")}</h3>
            <div style={{ display: "grid", gap: "12px" }}>
              <label>
                {t("clueWord")}
                <input
                  value={clue}
                  onChange={(e) => setClue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitClue(); }}
                  placeholder={t("oneClue")}
                />
              </label>
              <p className="selected-count-hint">
                {t("selectedCardsHint")}: <strong>{selectedCards.length}</strong>
              </p>
            </div>
            <button className="cta" onClick={submitClue} style={{ marginTop: "12px" }}>
              {t("sendClue")}
            </button>
          </div>
        )}

        {isClueAll && game.phase === "clue-all" && !game.mySubmittedClue && (
          <div className="clue-box">
            <h3>{t("submitYourClue")}</h3>
            <p style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>
              {t("submittedSoFar")}: {game.submittedClueCount} / {game.totalPlayersCount}
            </p>
            <label>
              {t("clueWord")}
              <input
                value={clue}
                onChange={(e) => setClue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitClue(); }}
                placeholder={t("oneClue")}
              />
            </label>
            <p className="selected-count-hint">
              {t("selectedCardsHint")}: <strong>{selectedCards.length}</strong>
            </p>
            <button className="cta" onClick={submitClue}>{t("sendClue")}</button>
          </div>
        )}

        {isClueAll && game.phase === "clue-all" && game.mySubmittedClue && (
          <div className="clue-box">
            <p>
              {t("clueSubmitted")}: <strong>{game.mySubmittedClue.clue}</strong>
              {" "}(×{game.mySubmittedClue.clueCount})
            </p>
            <p style={{ color: "var(--text-muted)" }}>
              {t("waitingForOthers")}: {game.submittedClueCount} / {game.totalPlayersCount}
            </p>
          </div>
        )}
      </section>

      {/* RIGHT — Timer + Operatives */}
      <section className="card game-right-panel">
        <div className="timer-badges">
          {game.phase === "clue" && (
            <div className="timer-badge clue-timer">
              <span className="timer-label">{t("clueTime")}</span>
              <span className="timer-value">
                {secondsRemaining === -1 ? "∞" : `${secondsRemaining}`}
              </span>
            </div>
          )}
          {game.phase === "clue-all" && (
            <div className="timer-badge clue-timer">
              <span className="timer-label">{t("clueAllTime")}</span>
              <span className="timer-value">
                {secondsRemaining === -1 ? "∞" : secondsRemaining}
              </span>
            </div>
          )}
          {game.phase === "guess" && (
            <div className="timer-badge guess-timer">
              <span className="timer-label">{t("guessTime")}</span>
              <span className="timer-value">{secondsRemaining}</span>
            </div>
          )}
          {game.phase === "round-end" && (
            <div className="timer-badge reveal-timer">
              <span className="timer-label">{t("nextRoundIn")}</span>
              <span className="timer-value">{secondsRemaining}</span>
            </div>
          )}
        </div>

        <div className="operatives-section">
          <p className="operatives-section-title">Operatives</p>
          <p className="instructions-hint">
            {t("guessersHint")}
            {(isClueGiver || game.phase === "round-end" || game.status === "finished")
              ? ` ${t("markerHint")}` : ""}
          </p>
          <ul className="operative-list">
            {game.guessersProgress.map((g) => {
              let barClass = "operative-bar";
              if (g.blackCount > 0) barClass += " bar-black";
              else if (g.redCount > 0) barClass += " bar-red";
              else if (g.finished && game.clueCount > 0 && g.correctCount >= game.clueCount) barClass += " bar-green";
              else if (g.finished) barClass += " bar-exhausted";
              return (
                <li key={g.playerId} className={barClass}>
                  <span className="operative-bar-name">{g.name}</span>
                  <span className="operative-bar-status">
                    {g.finished ? t("finished") : t("active")}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {isGuesser && game.myGuesserState && (
          <div className="my-status-box">
            <h3>{t("yourStatus")}</h3>
            <div className="my-status-row">
              <div className="my-status-item">
                <span className="my-status-item-label">{t("correct")}</span>
                <span className="my-status-item-value" style={{ color: "var(--success)" }}>
                  {game.myGuesserState.guessedCorrect.length}
                </span>
              </div>
              <div className="my-status-item">
                <span className="my-status-item-label">{t("wrong")}</span>
                <span className="my-status-item-value" style={{ color: "var(--error)" }}>
                  {game.myGuesserState.guessedWrong.length}
                </span>
              </div>
              <div className="my-status-item">
                <span className="my-status-item-label">{t("redHits")}</span>
                <span className="my-status-item-value" style={{ color: "var(--error)" }}>
                  {game.myGuesserState.redHits}
                </span>
              </div>
              <div className="my-status-item">
                <span className="my-status-item-label">{t("blackHit")}</span>
                <span className="my-status-item-value">
                  {game.myGuesserState.blackHit ? "☠" : "—"}
                </span>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* BOTTOM — Clue bar (spans all columns) */}
      {game.clue && (
        <section className="card clue-bar">
          <span className="clue-bar-label">Clue</span>
          <span className="clue-bar-word">{game.clue}</span>
          {isGuesser && (
            <span className="clue-bar-fraction">
              <span className="clue-bar-found">{foundCount}</span>
              <span className="clue-bar-sep"> / </span>
              <span className="clue-bar-total">{game.clueCount}</span>
            </span>
          )}
        </section>
      )}
      </main>

      <section className="game-chat-shell">
        <div className="game-chat-inner">
          <div className={`chat-panel ${isChatOpen ? "" : "is-collapsed"}`.trim()}>
            <div className="chat-header">
              <h3>{t("chat")}</h3>
              <div className="chat-header-actions">
                {!playerId && <span className="chat-readonly">{t("chatReadOnly")}</span>}
                <button
                  type="button"
                  className="chat-toggle"
                  onClick={() => setIsChatOpen((prev) => !prev)}
                  aria-expanded={isChatOpen}
                >
                  {isChatOpen ? t("hide") : t("show")}
                </button>
              </div>
            </div>
            <div className="chat-log">
              {(game.chatLog || []).length === 0 && (
                <p className="chat-empty">{t("chatEmpty")}</p>
              )}
              {(game.chatLog || []).map((entry) => (
                <div
                  key={entry.id}
                  className={`chat-message ${entry.type === "system-score" ? "system" : "user"}`}
                >
                  {entry.type === "system-score" && entry.items ? (
                    <div className="chat-score-block">
                      <div className="chat-score-header">
                        <span className="chat-name" style={entry.actorColor ? { color: entry.actorColor } : undefined}>{entry.actorName}</span>
                        <span className="chat-role">({entry.role})</span>
                        <span className={`chat-total ${entry.total >= 0 ? "positive" : "negative"}`}>
                          {entry.total >= 0 ? `+${entry.total}` : entry.total}
                        </span>
                      </div>
                      <ul className="chat-score-list">
                        {entry.items.map((item, idx) => (
                          <li key={`${entry.id}-${idx}`} className="chat-score-item">
                            <span className={`chat-points ${item.points >= 0 ? "positive" : "negative"}`}>
                              {item.points >= 0 ? `+${item.points}` : item.points}
                            </span>
                            <span className="chat-text">{item.label}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <>
                      <span className="chat-name" style={entry.color ? { color: entry.color } : undefined}>{entry.name}:</span>
                      <span className="chat-text">{entry.text}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="chat-input-row">
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder={t("chatPlaceholder")}
                disabled={!playerId}
              />
              <button type="button" onClick={sendChat} disabled={!playerId}>
                {t("chatSend")}
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
