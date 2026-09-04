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

test("applies the volatility floor before calculating a zero-variance stock's range multiple", () => {
  const flatHistory = Array.from({ length: 25 }, () => ({ close: 100, volume: 1000 }));
  const signal = calculateSignal({ price: 100.5, previousClose: 100, volume: 1000, history: flatHistory });
  assert.equal(signal.volatility, 0.25);
  assert.equal(signal.rangeMultiple, 2);
  assert.equal(signal.meaningful, true);
});

test("handles short history, a single point, and missing volume without NaN values", () => {
  const signal = calculateSignal({
    price: 101,
    previousClose: 100,
    volume: null,
    history: [{ close: 100, volume: null }],
  });
  assert.equal(signal.volatility, 0.25);
  assert.equal(signal.volumeRatio, null);
  assert.equal(signal.averageVolume, 0);
  assert.equal(Number.isFinite(signal.score), true);
  assert.match(explainSignal(signal), /volume unavailable/);

  const missingHistory = calculateSignal({ price: 101, previousClose: 100, volume: undefined, history: undefined });
  assert.equal(missingHistory.volatility, 0.25);
  assert.equal(missingHistory.volumeRatio, null);
});

test("uses volume as an alternate threshold rather than requiring it for every signal", () => {
  const flatHistory = Array.from({ length: 25 }, () => ({ close: 100, volume: 1000 }));
  const withoutVolume = calculateSignal({ price: 100.25, previousClose: 100, volume: 1000, history: flatHistory });
  const withVolume = calculateSignal({ price: 100.25, previousClose: 100, volume: 3000, history: flatHistory });
  assert.ok(withoutVolume.rangeMultiple > 0.9 && withoutVolume.rangeMultiple < 1.25);
  assert.equal(withoutVolume.meaningful, false);
  assert.equal(withVolume.meaningful, true);
  assert.ok(withVolume.score <= withVolume.rangeMultiple * 1.7);
});
