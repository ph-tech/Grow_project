const HIGH_CONFIDENCE_SCORE = 1.5;

export function isHighConfidence(entry) {
  const signalHigh = Boolean(entry?.signal?.meaningful && Number(entry.signal.score) >= HIGH_CONFIDENCE_SCORE);
  const peerHigh = Boolean(entry?.peer?.meaningful && Number(entry.peer.score) >= HIGH_CONFIDENCE_SCORE);
  return signalHigh || peerHigh;
}

export function shouldShowInDigest(entry, alertLevel = "high") {
  const meaningful = Boolean(entry?.signal?.meaningful || entry?.peer?.meaningful);
  if (!meaningful || alertLevel === "off") return false;
  if (alertLevel === "all") return true;
  return isHighConfidence(entry);
}

export function attentionStateForEntries(entries) {
  return Object.fromEntries(
    (entries || [])
      .filter((entry) => entry?.ticker && entry?.status !== "unavailable" && entry?.signal)
      .map((entry) => [entry.ticker, {
        signalMeaningful: Boolean(entry.signal.meaningful),
        peerMeaningful: Boolean(entry.peer?.meaningful),
      }]),
  );
}

export function attentionTransitions(previousState, currentState, entries = []) {
  const previous = previousState && typeof previousState === "object" ? previousState : null;
  const current = currentState && typeof currentState === "object" ? currentState : {};
  const firstVisit = !previous || Object.keys(previous).length === 0;
  const byTicker = {};
  const becameUnusual = [];
  const stillUnusual = [];
  const returnedToNormal = [];
  const newPeerDivergence = [];

  if (!firstVisit) {
    for (const [ticker, now] of Object.entries(current)) {
      const before = previous[ticker];
      if (!before) continue;
      const transition = {
        becameUnusual: !before.signalMeaningful && now.signalMeaningful,
        stillUnusual: before.signalMeaningful && now.signalMeaningful,
        returnedToNormal: before.signalMeaningful && !now.signalMeaningful,
        newPeerDivergence: !before.peerMeaningful && now.peerMeaningful,
      };
      byTicker[ticker] = transition;
      if (transition.becameUnusual) becameUnusual.push(ticker);
      if (transition.stillUnusual) stillUnusual.push(ticker);
      if (transition.returnedToNormal) returnedToNormal.push(ticker);
      if (transition.newPeerDivergence) newPeerDivergence.push(ticker);
    }
  }

  const largestMove = (entries || [])
    .filter((entry) => Number.isFinite(entry?.sinceVisitPercent))
    .map((entry) => ({ ticker: entry.ticker, percent: entry.sinceVisitPercent }))
    .sort((a, b) => Math.abs(b.percent) - Math.abs(a.percent))[0] || null;

  return {
    firstVisit,
    byTicker,
    becameUnusual,
    stillUnusual,
    returnedToNormal,
    newPeerDivergence,
    largestMove,
  };
}

export const ATTENTION_RULES = { highConfidenceScore: HIGH_CONFIDENCE_SCORE };
