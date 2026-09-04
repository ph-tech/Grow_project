import assert from "node:assert/strict";
import test from "node:test";
import { applyPeerDivergence, peerGroupFor } from "../lib/peers.js";

function entry(ticker, changePercent, volatility = 0.5) {
  return { ticker, status: "live", signal: { changePercent, volatility, volumeRatio: 1 } };
}

test("identifies the configured Indian peer groups", () => {
  assert.equal(peerGroupFor("TCS.NS").name, "IT services");
  assert.equal(peerGroupFor("HDFCBANK.NS").name, "Private banks");
  assert.equal(peerGroupFor("AAPL"), null);
});

test("flags meaningful peer divergence only when enough tracked peers exist", () => {
  const entries = applyPeerDivergence([
    entry("TCS.NS", 1.8),
    entry("INFY.NS", -0.7),
    entry("WIPRO.NS", -0.8),
  ]);
  assert.equal(entries[0].peer.meaningful, true);
  assert.match(entries[0].peer.explanation, /outperforming its it services peers/i);

  const insufficient = applyPeerDivergence([entry("TCS.NS", 1.8), entry("INFY.NS", -0.7)]);
  assert.equal(insufficient[0].peer, undefined);
});
