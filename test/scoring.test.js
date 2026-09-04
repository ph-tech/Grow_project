import test from "node:test";
import assert from "node:assert/strict";
import { calculateSignal, explainSignal } from "../lib/scoring.js";

const history = Array.from({ length: 25 }, (_, index) => ({
  close: 100 + index * 0.1,
  volume: 1000,
}));

test("ranks a move against its own volatility and volume", () => {
  const signal = calculateSignal({ price: 103, previousClose: 100, volume: 3000, history });
  assert.equal(signal.meaningful, true);
  assert.ok(signal.rangeMultiple > 1.25);
  assert.ok(signal.volumeRatio > 2);
  assert.match(explainSignal(signal), /usual daily swing/);
});

test("does not flag an ordinary move for a volatile stock", () => {
  const volatileHistory = Array.from({ length: 25 }, (_, index) => ({
    close: 100 + (index % 2 ? 4 : -4),
    volume: 1000,
  }));
  const signal = calculateSignal({
    price: 104,
    previousClose: 100,
    volume: 1000,
    history: volatileHistory,
  });
  assert.equal(signal.meaningful, false);
});
