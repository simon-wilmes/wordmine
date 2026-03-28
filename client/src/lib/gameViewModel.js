export function cardClass(card, game, selectedForClue, mineCorrect, mineNeutral, mineWrongRed, mineWrongBlack) {
  const classes = ["game-card"];
  const revealBoard = game?.phase === "round-end" || game?.status === "finished";

  if (revealBoard) {
    if (card.role === "green") {
      classes.push(card.isTarget ? "reveal-target" : "reveal-green");
    } else if (card.role === "red") {
      classes.push("reveal-red");
    } else if (card.role === "black") {
      classes.push("reveal-black");
    }
  } else if (game?.role === "clue-giver" || game?.role === "clue-all") {
    if (card.role === "green") {
      classes.push("cg-green");
    } else if (card.role === "red") {
      classes.push("cg-red");
    } else if (card.role === "black") {
      classes.push("cg-black");
    }
  } else {
    if (mineCorrect) {
      classes.push("guess-correct");
    } else if (mineWrongRed) {
      classes.push("guess-red");
    } else if (mineWrongBlack) {
      classes.push("guess-black");
    } else if (mineNeutral) {
      classes.push("guess-neutral");
    } else if (card.role === "green") {
      classes.push("guess-neutral");
    } else if (card.role === "red") {
      classes.push("guess-red");
    } else if (card.role === "black") {
      classes.push("guess-black");
    }
  }
  if (selectedForClue) classes.push("chosen");
  return classes.join(" ");
}

export function getCardMarkerNames(cardIndex, actions) {
  const names = [];
  for (const actor of actions || []) {
    let state = null;
    if (actor.guessedCorrect?.includes(cardIndex)) state = "correct";
    else if (actor.guessedWrongRed?.includes(cardIndex)) state = "wrong-red";
    else if (actor.guessedWrongBlack?.includes(cardIndex)) state = "wrong-black";
    else if (actor.guessedNeutral?.includes(cardIndex)) state = "neutral";
    else if (actor.marks?.includes(cardIndex)) state = "mark";

    if (state) {
      names.push({ key: actor.playerId, name: actor.name, color: actor.color || null, state });
    }
  }
  return names;
}
