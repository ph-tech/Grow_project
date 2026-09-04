const PEER_GROUPS = [
  { name: "IT services", tickers: ["TCS.NS", "INFY.NS", "WIPRO.NS", "HCLTECH.NS", "TECHM.NS"] },
  { name: "Private banks", tickers: ["HDFCBANK.NS", "ICICIBANK.NS", "KOTAKBANK.NS", "AXISBANK.NS", "INDUSINDBK.NS"] },
  { name: "Auto", tickers: ["MARUTI.NS", "M&M.NS", "TATAMOTORS.NS", "BAJAJ-AUTO.NS", "EICHERMOT.NS"] },
  { name: "Energy", tickers: ["RELIANCE.NS", "ONGC.NS", "NTPC.NS", "POWERGRID.NS", "COALINDIA.NS"] },
];

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function peerGroupFor(ticker) {
  return PEER_GROUPS.find((group) => group.tickers.includes(ticker)) || null;
}

export function applyPeerDivergence(entries) {
  return entries.map((entry) => {
    if (!entry.signal || entry.status === "unavailable") return entry;
    const group = peerGroupFor(entry.ticker);
    if (!group) return entry;
    const peers = entries.filter(
      (candidate) => candidate.ticker !== entry.ticker && group.tickers.includes(candidate.ticker) && candidate.signal,
    );
    if (peers.length < 2) return entry;

    const peerMove = median(peers.map((peer) => peer.signal.changePercent));
    const divergence = entry.signal.changePercent - peerMove;
    const threshold = Math.max(entry.signal.volatility * 1.25, 0.75);
    const meaningful = Math.abs(divergence) >= threshold;
    const peerVolume = median(peers.map((peer) => peer.signal.volumeRatio).filter(Boolean));
    const score = Math.abs(divergence) / threshold;
    const direction = divergence > 0 ? "outperforming" : "underperforming";

    return {
      ...entry,
      peer: {
        group: group.name,
        peerMove,
        divergence,
        meaningful,
        score,
        explanation: meaningful
          ? `${entry.ticker.replace(/\.(NS|BO)$/, "")} is ${direction} its ${group.name.toLowerCase()} peers by ${Math.abs(divergence).toFixed(2)}%.`
          : null,
        peerVolume,
      },
    };
  });
}
