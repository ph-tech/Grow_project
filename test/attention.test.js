import assert from "node:assert/strict";
import test from "node:test";
import { attentionStateForEntries, attentionTransitions, shouldShowInDigest } from "../lib/attention.js";

function entry(ticker, { meaningful = false, score = 0, peer = false, peerScore = 0, since = null } = {}) {
  return {
    ticker,
    status: "live",
    signal: { meaningful, score },
    peer: peer ? { meaningful: true, score: peerScore } : undefined,
    sinceVisitPercent: since,
  };
}

test("digest levels high/all/off use existing scores without changing signals", () => {
  const medium = entry("TCS.NS", { meaningful: true, score: 1.3 });
  const high = entry("INFY.NS", { meaningful: true, score: 1.7 });
  const peerHigh = entry("WIPRO.NS", { peer: true, peerScore: 1.6 });
  assert.equal(shouldShowInDigest(medium, "all"), true);
  assert.equal(shouldShowInDigest(medium, "high"), false);
  assert.equal(shouldShowInDigest(high, "high"), true);
  assert.equal(shouldShowInDigest(peerHigh, "high"), true);
  assert.equal(shouldShowInDigest(high, "off"), false);
});

test("attention transitions cover new, persistent, resolved, and peer states", () => {
  const previous = {
    "TCS.NS": { signalMeaningful: false, peerMeaningful: false },
    "INFY.NS": { signalMeaningful: true, peerMeaningful: false },
    "WIPRO.NS": { signalMeaningful: true, peerMeaningful: false },
    "HCLTECH.NS": { signalMeaningful: false, peerMeaningful: false },
  };
  const entries = [
    entry("TCS.NS", { meaningful: true, score: 2, since: 2.1 }),
    entry("INFY.NS", { meaningful: true, score: 2 }),
    entry("WIPRO.NS", { meaningful: false }),
    entry("HCLTECH.NS", { peer: true, peerScore: 2 }),
  ];
  const transitions = attentionTransitions(previous, attentionStateForEntries(entries), entries);
  assert.deepEqual(transitions.becameUnusual, ["TCS.NS"]);
  assert.deepEqual(transitions.stillUnusual, ["INFY.NS"]);
  assert.deepEqual(transitions.returnedToNormal, ["WIPRO.NS"]);
  assert.deepEqual(transitions.newPeerDivergence, ["HCLTECH.NS"]);
  assert.deepEqual(transitions.largestMove, { ticker: "TCS.NS", percent: 2.1 });
});

test("first baseline and newly-added tickers do not create fake transitions", () => {
  const entries = [entry("TCS.NS", { meaningful: true, score: 2 })];
  const current = attentionStateForEntries(entries);
  assert.equal(attentionTransitions(null, current, entries).firstVisit, true);
  const previous = { "INFY.NS": { signalMeaningful: false, peerMeaningful: false } };
  assert.deepEqual(attentionTransitions(previous, current, entries).becameUnusual, []);
});

test("a largest move alone is not an attention-state transition", () => {
  const previous = { "TCS.NS": { signalMeaningful: false, peerMeaningful: false } };
  const entries = [entry("TCS.NS", { since: 4.2 })];
  const transitions = attentionTransitions(previous, attentionStateForEntries(entries), entries);
  assert.deepEqual(transitions.becameUnusual, []);
  assert.deepEqual(transitions.returnedToNormal, []);
  assert.deepEqual(transitions.newPeerDivergence, []);
  assert.deepEqual(transitions.largestMove, { ticker: "TCS.NS", percent: 4.2 });
});
