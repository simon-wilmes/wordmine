import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getHistoricalGame, getLobby } from "../lib/api";
import StatsChips from "../components/game/StatsChips";
import { useI18n } from "../lib/i18n";
import { cardClass, getCardMarkerNames, getWordLengthClass } from "../lib/gameViewModel";
import { getMarkerPillStyle, getPlayerNameRender, getPlayerNameRenderNoScale } from "../lib/playerNameDisplay";
import { clearStoredPlayerId, getOrCreateBrowserId, getStoredPlayerId, setStoredPlayerId } from "../lib/session";
import { getSocket } from "../lib/socket";

const PHASE_LABELS = {
  clue: "HANDLER TRANSMITTING",
  "clue-all": "HANDLERS TRANSMITTING",
  guess: "OPERATIVES ACTIVE",
  "round-end": "MISSION DEBRIEF",
};

const PHASES_WITH_TRANSMISSION_DOTS = new Set(["clue", "clue-all", "round-end"]);

const ROLE_LABEL_KEYS = {
  "clue-giver": "roleClueGiver",
  guesser: "roleGuesser",
  "clue-all": "roleClueAll",
  viewer: "roleViewer"
};

export default function GamePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { lobbyId } = useParams();
  const resolvedPlayerId = getStoredPlayerId(lobbyId) || null;
  const playerId = resolvedPlayerId;
  const browserId = getOrCreateBrowserId();

  const [game, setGame] = useState(null);
  const [isArchivedGame, setIsArchivedGame] = useState(false);
  const [error, setError] = useState("");
  const [clue, setClue] = useState("");
  const [selectedCards, setSelectedCards] = useState([]);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [chatInput, setChatInput] = useState("");
  const [isChatOpen, setIsChatOpen] = useState(true);
  const [showRematchPopup, setShowRematchPopup] = useState(false);
  const [showReplayPopup, setShowReplayPopup] = useState(false);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState(null);
  const [timelineBottomPx, setTimelineBottomPx] = useState(176);
  const [shouldFloatBottomPanels, setShouldFloatBottomPanels] = useState(true);
  const [phaseDotCount, setPhaseDotCount] = useState(0);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  const [isQuitting, setIsQuitting] = useState(false);
  const rematchPopupShownForLobbyId = useRef(null);
  const chatShellRef = useRef(null);
  const chatLogRef = useRef(null);
  const chatShouldStickToBottomRef = useRef(true);
  const lastChatCountRef = useRef(0);
  const gamePageRef = useRef(null);
  const replayTimelineRef = useRef(null);

  const isClueGiver = game?.role === "clue-giver";
  const isClueAll = game?.role === "clue-all";
  const isGuesser = game?.role === "guesser";

  const clueRef = useRef(clue);
  const selectedCardsRef = useRef(selectedCards);
  clueRef.current = clue;
  selectedCardsRef.current = selectedCards;
  const myFinished = Boolean(game?.myGuesserState?.finished);
  const roundSnapshots = game?.roundSnapshots || [];

  const selectedSnapshotIndex = useMemo(
    () => roundSnapshots.findIndex((snapshot) => snapshot.id === selectedSnapshotId),
    [roundSnapshots, selectedSnapshotId]
  );

  const selectedSnapshot = selectedSnapshotIndex >= 0 ? roundSnapshots[selectedSnapshotIndex] : null;

  const snapshotSequenceById = useMemo(() => {
    const perGiver = new Map();
    const seqById = {};
    for (const snapshot of roundSnapshots) {
      const giverId = snapshot.clueGiverId || "unknown";
      const next = (perGiver.get(giverId) || 0) + 1;
      perGiver.set(giverId, next);
      seqById[snapshot.id] = next;
    }
    return seqById;
  }, [roundSnapshots]);

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

  const clueGiverColor = useMemo(() => {
    if (game?.clueGiver?.color) return game.clueGiver.color;
    const clueGiverId = game?.clueGiver?.id;
    if (!clueGiverId) return null;
    return scoreRows.find((row) => row.playerId === clueGiverId)?.color || null;
  }, [game?.clueGiver?.color, game?.clueGiver?.id, scoreRows]);

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
    let socket = null;
    let hasLiveSocketFlow = false;

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

    async function init() {
      try {
        const lobbyData = await getLobby(lobbyId);
        if (lobbyData?.lobby?.status !== "started") {
          const archived = await getHistoricalGame(lobbyId, browserId);
          if (!mounted) return;
          if (archived?.game) {
            setGame(archived.game);
            setIsArchivedGame(true);
            setError("");
            return;
          }
          setError(t("gameNotStarted"));
          return;
        }
      } catch (err) {
        try {
          const archived = await getHistoricalGame(lobbyId, browserId);
          if (!mounted) return;
          if (archived?.game) {
            setGame(archived.game);
            setIsArchivedGame(true);
            setError("");
            return;
          }
        } catch {
          // No archived game available.
        }
        setError(err.message);
        return;
      }

      socket = getSocket();
      hasLiveSocketFlow = true;

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
          setIsArchivedGame(false);
        });
      });

      socket.on("game-state", onGameState);
    }

    init();

    return () => {
      mounted = false;
      if (socket && hasLiveSocketFlow) {
        socket.off("game-state", onGameState);
      }
    };
  }, [browserId, lobbyId, resolvedPlayerId, t]);

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
    if (!showReplayPopup) return;
    if (!selectedSnapshotId) {
      setShowReplayPopup(false);
      return;
    }
    const exists = roundSnapshots.some((snapshot) => snapshot.id === selectedSnapshotId);
    if (!exists) {
      setShowReplayPopup(false);
      setSelectedSnapshotId(null);
    }
  }, [showReplayPopup, selectedSnapshotId, roundSnapshots]);

  useEffect(() => {
    if (isArchivedGame) return;
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

  useEffect(() => {
    if (!showReplayPopup || !game) return;
    const requiresInput = (
      (game.phase === "clue" && game.role === "clue-giver")
      || (game.phase === "clue-all" && game.role === "clue-all" && !game.mySubmittedClue)
      || (game.phase === "guess" && game.role === "guesser" && !game.myGuesserState?.finished)
    );
    if (requiresInput) {
      setShowReplayPopup(false);
    }
  }, [
    showReplayPopup,
    game?.phase,
    game?.role,
    game?.mySubmittedClue,
    game?.myGuesserState?.finished,
    game
  ]);

  useEffect(() => {
    if (game?.status === "finished") {
      setShouldFloatBottomPanels(false);
      return;
    }

    const chatShell = chatShellRef.current;
    const gamePage = gamePageRef.current;
    if (!chatShell || !gamePage) return;

    const updateBottomPanelsLayout = () => {
      const chatHeight = Number(chatShell.offsetHeight || 0);
      const timelineHeight = roundSnapshots.length > 0
        ? Number(replayTimelineRef.current?.offsetHeight || 0)
        : 0;

      const nextBottom = Math.max(70, chatHeight + 8);
      setTimelineBottomPx((prev) => (prev === nextBottom ? prev : nextBottom));

      const gameBottom = gamePage.getBoundingClientRect().bottom;
      const freeSpaceBelowGame = window.innerHeight - gameBottom;
      const requiredBottomSpace = chatHeight + timelineHeight + 16;
      const canFloat = freeSpaceBelowGame >= requiredBottomSpace;
      setShouldFloatBottomPanels((prev) => (prev === canFloat ? prev : canFloat));
    };

    updateBottomPanelsLayout();
    const rafId = requestAnimationFrame(updateBottomPanelsLayout);
    window.addEventListener("resize", updateBottomPanelsLayout);
    window.addEventListener("scroll", updateBottomPanelsLayout, { passive: true });

    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => updateBottomPanelsLayout());
      observer.observe(chatShell);
      observer.observe(gamePage);
      if (replayTimelineRef.current) observer.observe(replayTimelineRef.current);
    }

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", updateBottomPanelsLayout);
      window.removeEventListener("scroll", updateBottomPanelsLayout);
      if (observer) observer.disconnect();
    };
  }, [game?.status, isChatOpen, game?.chatLog?.length, roundSnapshots.length]);

  useEffect(() => {
    chatShouldStickToBottomRef.current = true;
    lastChatCountRef.current = 0;
  }, [lobbyId]);

  useEffect(() => {
    const chatLog = chatLogRef.current;
    if (!chatLog || !isChatOpen) return;

    const nextCount = game?.chatLog?.length || 0;
    const hasNewMessages = nextCount > lastChatCountRef.current;

    if (chatShouldStickToBottomRef.current && (hasNewMessages || nextCount > 0)) {
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    lastChatCountRef.current = nextCount;
  }, [game?.chatLog?.length, isChatOpen]);

  // Auto-submit clue when server signals time is up
  useEffect(() => {
    if (isArchivedGame) return;
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
  }, [isArchivedGame, lobbyId, playerId, isClueGiver, isClueAll]);

  useEffect(() => {
    if (!game?.phase || !PHASES_WITH_TRANSMISSION_DOTS.has(game.phase)) {
      setPhaseDotCount(0);
      return;
    }

    const interval = setInterval(() => {
      setPhaseDotCount((prev) => (prev + 1) % 4);
    }, 450);

    return () => clearInterval(interval);
  }, [game?.phase]);

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

  function readyNextPhase() {
    if (!playerId) return;
    setError("");
    getSocket().emit("game:ready-next-phase", { lobbyId, playerId }, (ack) => {
      if (!ack?.ok) {
        setError(ack?.error || "Failed to continue.");
      }
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

  function quitGame() {
    if (isArchivedGame || !playerId || isQuitting) return;
    setIsQuitting(true);
    setError("");
    const socket = getSocket();
    socket.emit("game:quit", { lobbyId, playerId }, (ack) => {
      setIsQuitting(false);
      if (!ack?.ok) {
        setError(ack?.error || "Failed to quit game.");
        return;
      }
      clearStoredPlayerId(lobbyId);
      navigate("/");
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

  function handleChatLogScroll(event) {
    const element = event.currentTarget;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    chatShouldStickToBottomRef.current = distanceToBottom <= 12;
  }

  function openSnapshot(snapshotId) {
    setSelectedSnapshotId(snapshotId);
    setShowReplayPopup(true);
  }

  function closeReplayPopup() {
    setShowReplayPopup(false);
  }

  function showPreviousSnapshot() {
    if (selectedSnapshotIndex <= 0) return;
    setSelectedSnapshotId(roundSnapshots[selectedSnapshotIndex - 1].id);
  }

  function showNextSnapshot() {
    if (selectedSnapshotIndex < 0 || selectedSnapshotIndex >= roundSnapshots.length - 1) return;
    setSelectedSnapshotId(roundSnapshots[selectedSnapshotIndex + 1].id);
  }

  const replayPopup = showReplayPopup && selectedSnapshot ? (
    <div className="modal-backdrop replay-backdrop" role="dialog" aria-modal="true" aria-label={t("pastRoundReview") || "Past Round Review"}>
      <div className="modal replay-modal">
        <div className="replay-modal-header">
          <div>
            <h3>{t("pastRoundReview") || "Past Round Review"}</h3>
            <p className="replay-subtitle">
              {(t("round") || "Round")} {selectedSnapshot.roundNumber}
              {selectedSnapshot.subRoundTotal > 0
                ? `.${(selectedSnapshot.subRoundIndex ?? 0) + 1}`
                : ""}
              {selectedSnapshot.clueGiverName && (
                <>
                  {" - "}
                  <span style={selectedSnapshot.clueGiverColor ? { color: selectedSnapshot.clueGiverColor } : undefined}>
                    {selectedSnapshot.clueGiverName}
                  </span>
                </>
              )}
            </p>
          </div>
          <button className="replay-close-btn" onClick={closeReplayPopup} aria-label={t("dismiss") || "Close"}>
            X
          </button>
        </div>

        <div className="replay-nav-row">
          <div className="replay-clue-chip">
            <span>{t("currentClue") || "Current clue"}:</span>
            <strong>{selectedSnapshot.clue || "-"}</strong>
            <span>x{selectedSnapshot.clueCount || 0}</span>
          </div>
        </div>

        <div className="replay-board-wrap">
          <button
            className="ghost replay-side-arrow"
            onClick={showPreviousSnapshot}
            disabled={selectedSnapshotIndex <= 0}
            aria-label={t("previousRound") || "Previous"}
          >
            &lt;
          </button>
          <div className="game-grid replay-grid">
            {(selectedSnapshot.board?.cards || []).map((card) => {
              const markerNames = getCardMarkerNames(card.index, selectedSnapshot.allGuesserActions);
              return (
                <button
                  key={`replay-${selectedSnapshot.id}-${card.index}`}
                  className={[
                    cardClass(
                      { ...card, isTarget: (selectedSnapshot.clueSelectedIndexes || []).includes(card.index) },
                      { phase: "round-end", status: "active", role: "clue-giver" },
                      false,
                      false,
                      false,
                      false,
                      false
                    ),
                    getWordLengthClass(card.word)
                  ].join(" ")}
                  type="button"
                  disabled
                >
                  <span>{card.word}</span>
                  {markerNames.length > 0 && (
                    <div className="card-markers">
                      {markerNames.map((entry) => (
                        (() => {
                          const nameRender = getPlayerNameRender(entry);
                          return (
                        <span
                          key={`${selectedSnapshot.id}-${entry.key}`}
                            className={`card-marker-pill ${entry.state} ${nameRender.className}`.trim()}
                            style={{ ...(nameRender.style || {}), ...(getMarkerPillStyle(entry) || {}) }}
                        >
                            {nameRender.text}
                        </span>
                          );
                        })()
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          <button
            className="ghost replay-side-arrow"
            onClick={showNextSnapshot}
            disabled={selectedSnapshotIndex < 0 || selectedSnapshotIndex >= roundSnapshots.length - 1}
            aria-label={t("nextRound") || "Next"}
          >
            &gt;
          </button>
        </div>

        <ul className="replay-summary-list">
          {(selectedSnapshot.allGuesserActions || []).map((actor) => (
            (() => {
              const nameRender = getPlayerNameRenderNoScale(actor);
              return (
                <li key={`${selectedSnapshot.id}-${actor.playerId}`} className="replay-summary-item">
                  <span className={nameRender.className} style={nameRender.style}>{nameRender.text}</span>
                  <span>{(actor.guessedCorrect || []).length}✓</span>
                  <span>{(actor.guessedNeutral || []).length}~</span>
                  <span>{(actor.guessedWrongRed || []).length}R</span>
                  <span>{(actor.guessedWrongBlack || []).length}B</span>
                  <span>{(actor.marks || []).length}M</span>
                </li>
              );
            })()
          ))}
        </ul>
      </div>
    </div>
  ) : null;

  const quitConfirmModal = showQuitConfirm ? (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t("quitGameConfirmTitle")}>
      <div className="modal">
        <h3>{t("quitGameConfirmTitle")}</h3>
        <p style={{ color: "var(--text-muted)", fontSize: "0.88rem" }}>{t("quitGameConfirmText")}</p>
        <div className="button-row">
          <button className="cta" onClick={quitGame} disabled={isQuitting}>
            {isQuitting ? t("working") : t("confirmQuitGame")}
          </button>
          <button className="ghost" onClick={() => setShowQuitConfirm(false)} disabled={isQuitting}>
            {t("stayInGame")}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const replayTimeline = roundSnapshots.length > 0 ? (
    <section
      ref={replayTimelineRef}
      className={[
        "replay-timeline-shell",
        game?.status === "finished" ? "replay-timeline-finished" : "",
        shouldFloatBottomPanels ? "replay-timeline-floating" : "replay-timeline-inline"
      ].filter(Boolean).join(" ")}
      style={
        game?.status === "finished" || !shouldFloatBottomPanels
          ? undefined
          : { bottom: `${timelineBottomPx}px` }
      }
    >
      <div className="replay-timeline-inner">
        <p className="replay-timeline-title">{t("pastRounds") || "Past Rounds"}</p>
        <div className="replay-timeline-row">
          {roundSnapshots.map((snapshot) => (
            (() => {
              const clueGiverRender = getPlayerNameRender({
                name: snapshot.clueGiverName || "Unknown",
                color: snapshot.clueGiverColor || null
              });
              return (
            <button
              key={snapshot.id}
              type="button"
              className={[
                "replay-thumb",
                showReplayPopup && selectedSnapshotId === snapshot.id ? "is-active" : ""
              ].filter(Boolean).join(" ")}
              onClick={() => openSnapshot(snapshot.id)}
              title={`${snapshot.clueGiverName || "Unknown"} ${snapshotSequenceById[snapshot.id] || 1}`}
            >
              <span className="replay-thumb-label">
                <span className={`replay-thumb-name ${clueGiverRender.className}`.trim()} style={clueGiverRender.style}>
                  {clueGiverRender.text || "Unknown"}
                </span>
                <span className="replay-thumb-seq">{snapshotSequenceById[snapshot.id] || 1}</span>
              </span>
              <span className="replay-thumb-grid" aria-hidden="true">
                {(snapshot.board?.cards || []).map((card) => (
                  <span
                    key={`${snapshot.id}-thumb-${card.index}`}
                    className={[
                      "replay-thumb-cell",
                      `role-${card.role}`,
                      (snapshot.clueSelectedIndexes || []).includes(card.index) ? "is-target" : ""
                    ].filter(Boolean).join(" ")}
                  />
                ))}
              </span>
            </button>
              );
            })()
          ))}
        </div>
      </div>
    </section>
  ) : null;

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

  const canContinueRoundEnd = Boolean(
    playerId
    && game?.phase === "round-end"
    && game?.status !== "finished"
    && myScoreRow
    && !myScoreRow.isAI
  );

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
      <>
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
              (() => {
                const nameRender = getPlayerNameRenderNoScale(p);
                return (
              <div
                key={p.playerId}
                className={`podium-card place-${idx + 1} tie-group-${podiumColorGroupByScore[p.total] ?? idx}`}
              >
                <p className="podium-place">#{idx + 1}</p>
                <h3 className={nameRender.className} style={nameRender.style}>{nameRender.text}</h3>
                <p className="podium-score">{p.total} {t("pts")}</p>
                <StatsChips stats={p} />
                <p className="podium-total-guessed">{t("totalGuessed")}: {p.totalGuessed}</p>
              </div>
                );
              })()
            ))}
          </div>

          {others.length > 0 && (
            <div className="end-list">
              <h3>{t("remainingPlayers")}</h3>
              <ul className="end-list-items">
                {others.map((p, idx) => (
                  (() => {
                    const nameRender = getPlayerNameRenderNoScale(p);
                    return (
                      <li key={p.playerId} className="end-list-item">
                        <span className="end-list-rank">#{idx + 4}</span>
                        <span className={`end-list-name ${nameRender.className}`.trim()} style={nameRender.style}>{nameRender.text}</span>
                        <span className="end-list-score">{p.total} {t("pts")}</span>
                        <StatsChips stats={p} />
                      </li>
                    );
                  })()
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
      {replayTimeline}
      {replayPopup}
      </>
    );
  }

  // ── ACTIVE GAME ───────────────────────────────────────────────────────────
  return (
    <>
      <main className="page game-page" ref={gamePageRef}>

      {/* LEFT — Scores */}
      <section className="card game-left-panel">
        <h2>{t("scores")}</h2>
        <ul className="score-list">
          {scoreRows.map((row) => (
            (() => {
              const nameRender = getPlayerNameRender(row);
              return (
                <li key={row.playerId} className="score-row">
                  <span className="score-rank" />
                  <span className={`score-name ${nameRender.className}`.trim()} style={nameRender.style}>
                    {nameRender.text}
                    {row.isAI ? ` [${t("aiAgentTag")}]` : ""}
                  </span>
                  <span className="score-pts">{row.total}</span>
                </li>
              );
            })()
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
        <button className="game-quit-button" onClick={() => setShowQuitConfirm(true)} disabled={isQuitting}>
          {t("quitGame")}
        </button>
        <button className="ghost game-back-button" onClick={() => navigate("/")}>{t("backToLanding")}</button>
      </section>

      {/* CENTER — Board */}
      <section className="card game-center-panel">
        <div className="game-header">
          <div className="game-title-block">
            <h1 className="game-phase-title" aria-live="polite">
              <span>{PHASE_LABELS[game.phase] || String(game.phase || "").toUpperCase()}</span>
              {PHASES_WITH_TRANSMISSION_DOTS.has(game.phase) && (
                <span className="game-phase-dots" aria-hidden="true">{".".repeat(phaseDotCount)}</span>
              )}
            </h1>
            <div className="game-badges-row">
              <span className="role-badge">
                {t("role")}: {t(ROLE_LABEL_KEYS[game.role] || game.role)}
              </span>
              {game.phase !== "clue-all" && (
                (() => {
                  const clueGiverRender = getPlayerNameRenderNoScale(game?.clueGiver || {});
                  return (
                <span className="handler-badge">
                  {t("clueGiver")}: <span className={clueGiverRender.className} style={clueGiverRender.style || (clueGiverColor ? { color: clueGiverColor } : undefined)}>{clueGiverRender.text}</span>
                  {game.clueGiver?.isAI ? ` [${t("aiAgentTag")}]` : ""}
                </span>
                  );
                })()
              )}
              {game.phase === "clue-all" && (
                <span className="handler-badge">
                  {t("simultaneousCluePhase")}
                </span>
              )}
            </div>
          </div>
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
                  getWordLengthClass(card.word),
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
                        (() => {
                          const nameRender = getPlayerNameRender(entry);
                          return (
                            <span
                              key={entry.key}
                              className={`card-marker-pill ${entry.state} ${nameRender.className}`.trim()}
                              style={{ ...(nameRender.style || {}), ...(getMarkerPillStyle(entry) || {}) }}
                              title={`${entry.name} ${entry.state === "mark" ? "marked" : "guessed"} this card`}
                            >
                              {nameRender.text}
                            </span>
                          );
                        })()
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
              else if (g.finishReason === "timeout") barClass += " bar-timeout";
              else if (g.finished && game.clueCount > 0 && g.correctCount >= game.clueCount) barClass += " bar-green";
              else if (g.finished) barClass += " bar-exhausted";

              let statusKey = "finished";
              let statusTone = "waiting";
              let statusTooltip = t("finished");
              if (!g.finished) {
                statusKey = game.phase === "guess" ? "guessing" : "waiting";
                statusTone = game.phase === "guess" ? "guessing" : "waiting";
                statusTooltip = t(game.phase === "guess" ? "guessing" : "waiting");
              } else if (g.finishReason === "timeout") {
                statusKey = "timedOut";
                statusTone = "timeout";
                statusTooltip = t("statusTimedOutLong");
              } else if (g.blackCount > 0) {
                statusTone = "black";
                statusTooltip = t("statusFinishedWithBlackCard");
              } else if (g.redCount > 0) {
                statusTone = "red";
                statusTooltip = t("statusFinishedWithRedCard");
              } else if (game.clueCount > 0 && g.correctCount >= game.clueCount) {
                statusTone = "green";
                statusTooltip = t("statusFinishedAllTargets");
              } else {
                statusTone = "exhausted";
                statusTooltip = t("statusFinishedNoGuessesLeft");
              }

              return (
                <li key={g.playerId} className={barClass}>
                  {(() => {
                    const nameRender = getPlayerNameRender(g);
                    return (
                      <span className={`operative-bar-name ${nameRender.className}`.trim()} style={nameRender.style}>{nameRender.text}</span>
                    );
                  })()}
                  <span
                    className={`operative-bar-status status-${statusKey} tone-${statusTone}`}
                    data-status={statusTooltip}
                    aria-label={statusTooltip}
                    title={statusTooltip}
                  >
                    <span className="operative-status-icon" aria-hidden="true">i</span>
                    <span className="operative-status-text">{t(statusKey)}</span>
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
      {(game.clue || game.phase === "round-end") && (
        <section className="card clue-bar">
          <span className="clue-bar-label">Clue</span>
          <span className="clue-bar-word">{game.clue || "-"}</span>
          {isGuesser && game.clue && (
            <span className="clue-bar-fraction">
              <span className="clue-bar-found">{foundCount}</span>
              <span className="clue-bar-sep"> / </span>
              <span className="clue-bar-total">{game.clueCount}</span>
            </span>
          )}
          {game.phase === "round-end" && game.roundEndReadyTarget > 0 && (
            <span className="clue-bar-ready-progress">
              {t("continueVotes")}: {game.roundEndReadyCount} / {game.roundEndReadyTarget}
            </span>
          )}
          {canContinueRoundEnd && (
            <button
              type="button"
              className="cta clue-bar-continue"
              onClick={readyNextPhase}
              disabled={game.myRoundEndReady}
            >
              {game.myRoundEndReady ? t("readyForNextPhase") : t("skipToNextSection")}
            </button>
          )}
        </section>
      )}

      </main>
      {replayTimeline}
      {replayPopup}
      {quitConfirmModal}

      <section
        className={`game-chat-shell ${shouldFloatBottomPanels ? "is-floating" : "is-inline"}`.trim()}
        ref={chatShellRef}
      >
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
            <div className="chat-log" ref={chatLogRef} onScroll={handleChatLogScroll}>
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
                        {(() => {
                          const nameRender = getPlayerNameRenderNoScale({ name: entry.actorName, color: entry.actorColor });
                          return <span className={`chat-name ${nameRender.className}`.trim()} style={nameRender.style}>{nameRender.text}</span>;
                        })()}
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
                      {(() => {
                        const nameRender = getPlayerNameRenderNoScale(entry);
                        return <span className={`chat-name ${nameRender.className}`.trim()} style={nameRender.style}>{nameRender.text}:</span>;
                      })()}
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
