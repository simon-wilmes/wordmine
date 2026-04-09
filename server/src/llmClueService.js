const { runClaudePrompt } = require("./claudeBridge");

function normalizeWord(value) {
  return String(value || "").trim().toLowerCase();
}

function extractJsonObject(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return { error: "Empty model output." };
  }

  try {
    return { parsed: JSON.parse(text) };
  } catch {
    // Fall through to tolerant extraction for mixed model output.
  }

  // Tolerant extractor: collect all top-level JSON object slices in order.
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  if (candidates.length === 0) {
    return { error: "Model output does not contain JSON." };
  }

  // Prefer the last valid object because models often self-correct with a second JSON block.
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      return { parsed: JSON.parse(candidates[i]) };
    } catch {
      // Keep trying older candidates.
    }
  }

  return { error: "Model JSON could not be parsed." };
}

function buildPrompt({ language, greenWords, redWords, blackWords, previousError }) {
  const list = (items) => (items.length > 0 ? items.join(", ") : "(none)");

  if (language === "de") {
    return [
      "Du bist ein KI-Hinweisgeber in einem Codenames-ähnlichen Spiel.",
      "Kurze Regeln:",
      "- Gib EIN Hinweiswort (clue), das zu möglichst vielen grünen Karten passt.",
      "- Wähle targetWords nur aus der grünen Liste.",
      "- Vermeide rote Karten, und vermeide schwarze Karten auf jeden Fall.",
      "- Wenn ein großer Hinweis unsicher ist, nimm lieber weniger sichere Zielwörter.",
      "- Prüfe VOR dem Antworten jedes Wort in targetWords: es muss exakt (gleiche Schreibweise) in 'Grüne Wörter' vorkommen.",
      "- Wenn ein targetWord nicht exakt in 'Grüne Wörter' steht oder in Rot/Schwarz vorkommt, entferne es aus targetWords.",
      "",
      `Grüne Wörter (erlaubte Ziele): ${list(greenWords)}`,
      `Rote Wörter (vermeiden): ${list(redWords)}`,
      `Schwarze Wörter (unbedingt vermeiden): ${list(blackWords)}`,
      previousError ? `Letzter Fehler, bitte korrigieren: ${previousError}` : "",
      "",
      "Antworte NUR als JSON-Objekt, ohne weiteren Text:",
      '{"clue":"<ein wort>","targetWords":["wort1","wort2"]}'
    ].filter(Boolean).join("\n");
  }

  return [
    "You are an AI clue giver in a Codenames-like game.",
    "Brief rules:",
    "- Give ONE clue word that covers as many green cards as is safely understandable.",
    "- targetWords must be chosen only from the green list.",
    "- Avoid red cards and absolutely avoid black cards.",
    "- If a large clue is risky or unclear, prefer fewer safer target words.",
    "- Before replying, check every word in targetWords: it must exactly match (same spelling) a word in 'Green words'.",
    "- If a targetWord is not an exact green-list match, or appears in red/black lists, remove it from targetWords.",
    "",
    `Green words (allowed targets): ${list(greenWords)}`,
    `Red words (avoid): ${list(redWords)}`,
    `Black words (absolutely avoid): ${list(blackWords)}`,
    previousError ? `Previous error to fix: ${previousError}` : "",
    "",
    "Respond ONLY as a JSON object, no additional text:",
    '{"clue":"<one word>","targetWords":["word1","word2"]}'
  ].filter(Boolean).join("\n");
}

function buildPayloadFromParsed(parsed, boardCards) {
  const clue = String(parsed?.clue || "").trim();
  if (!clue) {
    return { error: "Missing clue in model output." };
  }
  if (clue.length < 2 || clue.length > 30) {
    return { error: "Clue length must be 2-30 characters." };
  }

  const targetWords = Array.isArray(parsed?.targetWords) ? parsed.targetWords : [];
  if (targetWords.length < 1) {
    return { error: "targetWords must contain at least one word." };
  }

  const normalizedTargets = [...new Set(targetWords.map(normalizeWord).filter(Boolean))];
  const byWord = new Map();
  for (const card of boardCards) {
    byWord.set(normalizeWord(card.word), card);
  }

  const selectedIndexes = [];
  for (const targetWord of normalizedTargets) {
    const card = byWord.get(targetWord);
    if (!card) {
      return { error: `Target word '${targetWord}' is not on the board.` };
    }
    if (card.role !== "green") {
      return { error: `Target word '${card.word}' is not green.` };
    }
    selectedIndexes.push(card.index);
  }

  if (selectedIndexes.length > 8) {
    return { error: "At most 8 target words are allowed." };
  }

  return {
    payload: {
      clue,
      clueCount: selectedIndexes.length,
      selectedIndexes
    }
  };
}

function getWordsByRole(cards, role) {
  return cards.filter((card) => card.role === role).map((card) => card.word);
}

async function generateAIAgentClueAttempt({ game, lobbyId, attempt, previousError, clueGiverId, boardCards }) {
  const round = game?.round;
  const cards = Array.isArray(boardCards) && boardCards.length > 0
    ? boardCards
    : (round?.board?.cards || []);
  const language = String(game?.config?.wordLanguage || "en").toLowerCase() === "de" ? "de" : "en";

  const prompt = buildPrompt({
    language,
    greenWords: getWordsByRole(cards, "green"),
    redWords: getWordsByRole(cards, "red"),
    blackWords: getWordsByRole(cards, "black"),
    previousError
  });

  const meta = {
    lobbyId,
    roundNumber: game?.roundNumber,
    clueGiverId: clueGiverId || round?.clueGiverId,
    wordLanguage: language,
    attempt
  };

  const startedAt = Date.now();
  const cliResult = await runClaudePrompt(prompt);
  const elapsedMs = Date.now() - startedAt;

  const rawOutput = cliResult.stdout || cliResult.stderr || "";
  const extracted = extractJsonObject(rawOutput);
  if (extracted.error) {
    return {
      ok: false,
      error: extracted.error,
      prompt,
      rawOutput,
      parsed: null,
      payload: null,
      meta: { ...meta, elapsedMs }
    };
  }

  const mapped = buildPayloadFromParsed(extracted.parsed, cards);
  if (mapped.error) {
    return {
      ok: false,
      error: mapped.error,
      prompt,
      rawOutput,
      parsed: extracted.parsed,
      payload: null,
      meta: { ...meta, elapsedMs }
    };
  }

  return {
    ok: true,
    prompt,
    rawOutput,
    parsed: extracted.parsed,
    payload: mapped.payload,
    meta: { ...meta, elapsedMs }
  };
}

function buildGuessPrompt({
  language,
  boardCards,
  clue,
  clueCount,
  remainingGuesses,
  guessedWords,
  previousError,
  feedback
}) {
  const boardWords = boardCards.map((card) => card.word).join(", ");
  const guessedList = guessedWords.length > 0 ? guessedWords.join(", ") : "(none)";

  if (language === "de") {
    return [
      "Du bist ein KI-Rater in einem Codenames-ähnlichen Spiel.",
      "Kurze Regeln:",
      "- Du kennst nur Hinweiswort und Zahl.",
      "- Gib eine geordnete Liste von Wörtern zur Auswahl nach Wahrscheinlichkeit.",
      "- Wenn unsicher, gib lieber weniger Wörter.",
      "- Nutze nur Wörter, die auf dem Board stehen und noch nicht geraten wurden.",
      "- Prüfe VOR dem Antworten jedes Wort in guesses: es muss exakt (gleiche Schreibweise) in 'Board-Wörter' vorkommen.",
      "- Wenn ein Wort nicht exakt auf dem Board steht, entferne es aus guesses.",
      "",
      `Hinweis: '${clue}' x${clueCount}`,
      `Verbleibende mögliche Klicks in dieser Runde: ${remainingGuesses}`,
      `Board-Wörter: ${boardWords}`,
      `Bereits geraten: ${guessedList}`,
      feedback ? `Zusatzkontext nach letztem Klick: ${feedback}` : "",
      previousError ? `Letzter Fehler, bitte korrigieren: ${previousError}` : "",
      "",
      "Antworte NUR als JSON-Objekt:",
      '{"guesses":["wort1","wort2","wort3"]}'
    ].filter(Boolean).join("\n");
  }

  return [
    "You are an AI guesser in a Codenames-like game.",
    "Brief rules:",
    "- You only know the clue word and count.",
    "- Return an ordered list of words to click by likelihood.",
    "- If uncertain, return fewer words.",
    "- Use only words present on the board that have not been guessed yet.",
    "- Before replying, check every word in guesses: it must exactly match (same spelling) a word in 'Board words'.",
    "- If a word is not an exact match to a board word, remove it from guesses.",
    "",
    `Clue: '${clue}' x${clueCount}`,
    `Remaining possible clicks this round: ${remainingGuesses}`,
    `Board words: ${boardWords}`,
    `Already guessed: ${guessedList}`,
    feedback ? `Extra context after latest click: ${feedback}` : "",
    previousError ? `Previous error to fix: ${previousError}` : "",
    "",
    "Respond ONLY as a JSON object:",
    '{"guesses":["word1","word2","word3"]}'
  ].filter(Boolean).join("\n");
}

function buildGuessIndexesFromParsed(parsed, boardCards, excludedIndexes) {
  const guesses = Array.isArray(parsed?.guesses) ? parsed.guesses : [];
  const normalizedGuesses = [...new Set(guesses.map(normalizeWord).filter(Boolean))];
  const excluded = new Set(excludedIndexes || []);

  const byWord = new Map();
  for (const card of boardCards) {
    byWord.set(normalizeWord(card.word), card);
  }

  const orderedIndexes = [];
  for (const word of normalizedGuesses) {
    const card = byWord.get(word);
    if (!card) {
      return { error: `Guessed word '${word}' is not on the board.` };
    }
    if (excluded.has(card.index)) {
      continue;
    }
    orderedIndexes.push(card.index);
    excluded.add(card.index);
  }

  return { orderedIndexes };
}

async function generateAIAgentGuessPlan({
  game,
  lobbyId,
  guesserId,
  attempt,
  previousError,
  feedback
}) {
  const round = game?.round;
  const cards = round?.board?.cards || [];
  const language = String(game?.config?.wordLanguage || "en").toLowerCase() === "de" ? "de" : "en";
  const guesser = round?.guessers?.[guesserId];
  const guessedIndexes = [
    ...(guesser?.guessedCorrect || []),
    ...(guesser?.guessedNeutral || []),
    ...(guesser?.guessedWrongRed || []),
    ...(guesser?.guessedWrongBlack || [])
  ];
  const guessedWords = guessedIndexes
    .map((idx) => cards[idx]?.word)
    .filter(Boolean);
  const usedGuessCount = guessedIndexes.length;
  const remainingGuesses = Math.max(0, Number(round?.clueCount || 0) + 1 - usedGuessCount);

  const prompt = buildGuessPrompt({
    language,
    boardCards: cards,
    clue: round?.clue || "",
    clueCount: Number(round?.clueCount || 0),
    remainingGuesses,
    guessedWords,
    previousError,
    feedback
  });

  const meta = {
    lobbyId,
    roundNumber: game?.roundNumber,
    clueGiverId: round?.clueGiverId,
    guesserId,
    wordLanguage: language,
    attempt,
    remainingGuesses
  };

  const startedAt = Date.now();
  const cliResult = await runClaudePrompt(prompt);
  const elapsedMs = Date.now() - startedAt;
  const rawOutput = cliResult.stdout || cliResult.stderr || "";

  const extracted = extractJsonObject(rawOutput);
  if (extracted.error) {
    return {
      ok: false,
      error: extracted.error,
      prompt,
      rawOutput,
      parsed: null,
      orderedIndexes: null,
      meta: { ...meta, elapsedMs }
    };
  }

  const mapped = buildGuessIndexesFromParsed(extracted.parsed, cards, guessedIndexes);
  if (mapped.error) {
    return {
      ok: false,
      error: mapped.error,
      prompt,
      rawOutput,
      parsed: extracted.parsed,
      orderedIndexes: null,
      meta: { ...meta, elapsedMs }
    };
  }

  return {
    ok: true,
    prompt,
    rawOutput,
    parsed: extracted.parsed,
    orderedIndexes: mapped.orderedIndexes,
    meta: { ...meta, elapsedMs }
  };
}

module.exports = {
  generateAIAgentClueAttempt,
  generateAIAgentGuessPlan
};
