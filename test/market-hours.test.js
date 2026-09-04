import test from "node:test";
import assert from "node:assert/strict";
import { isIndianTicker, isIndianMarketOpen, freshnessStatus } from "../lib/market-hours.js";

// Wednesday, 3 September 2025, during NSE trading hours (11:00 IST).
const MARKET_OPEN_WEEKDAY = new Date("2025-09-03T05:30:00.000Z");
// Same Wednesday, after the 15:30 IST close.
const MARKET_CLOSED_SAME_DAY = new Date("2025-09-03T12:00:00.000Z");
// Saturday, 6 September 2025 (weekend, market closed all day).
const WEEKEND = new Date("2025-09-06T08:00:00.000Z");
// Monday, 8 September 2025, 08:00 IST - before the market opens for the day.
const MONDAY_BEFORE_OPEN = new Date("2025-09-08T02:30:00.000Z");

test("isIndianTicker recognizes NSE/BSE tickers and metadata", () => {
  assert.equal(isIndianTicker("RELIANCE.NS"), true);
  assert.equal(isIndianTicker("500325.BO"), true);
  assert.equal(isIndianTicker("TCS", "NSI"), true);
  assert.equal(isIndianTicker("SOMECODE", "BSE"), true);
  assert.equal(isIndianTicker("SOMECODE", null, "Asia/Kolkata"), true);
  assert.equal(isIndianTicker("AAPL"), false);
  assert.equal(isIndianTicker("AAPL", "NMS", "America/New_York"), false);
});

test("isIndianMarketOpen detects trading hours, after-hours, and weekends", () => {
  assert.equal(isIndianMarketOpen(MARKET_OPEN_WEEKDAY), true);
  assert.equal(isIndianMarketOpen(MARKET_CLOSED_SAME_DAY), false);
  assert.equal(isIndianMarketOpen(WEEKEND), false);
  assert.equal(isIndianMarketOpen(MONDAY_BEFORE_OPEN), false);
});

test("freshnessStatus flags a stale NSE quote only while the market is open", () => {
  const staleQuote = new Date(MARKET_OPEN_WEEKDAY.getTime() - 45 * 60_000).toISOString();
  const status = freshnessStatus(staleQuote, { ticker: "TCS.NS" }, MARKET_OPEN_WEEKDAY);
  assert.equal(status.stale, true);
  assert.equal(status.marketClosed, false);
  assert.equal(status.label, "45m old");
});

test("freshnessStatus does not flag a fresh NSE quote as stale during trading hours", () => {
  const freshQuote = new Date(MARKET_OPEN_WEEKDAY.getTime() - 5 * 60_000).toISOString();
  const status = freshnessStatus(freshQuote, { ticker: "TCS.NS" }, MARKET_OPEN_WEEKDAY);
  assert.equal(status.stale, false);
  assert.equal(status.marketClosed, false);
  assert.equal(status.label, "5m old");
});

test("freshnessStatus reports 'Market closed' for same-day previous-session NSE data", () => {
  const lastQuoteToday = new Date(MARKET_CLOSED_SAME_DAY.getTime() - 90 * 60_000).toISOString();
  const status = freshnessStatus(lastQuoteToday, { ticker: "RELIANCE.NS" }, MARKET_CLOSED_SAME_DAY);
  assert.equal(status.stale, false);
  assert.equal(status.marketClosed, true);
  assert.equal(status.label, "Market closed");
});

test("freshnessStatus reports 'Last session data' over a weekend gap", () => {
  const fridayClose = new Date("2025-09-05T10:00:00.000Z").toISOString();
  const status = freshnessStatus(fridayClose, { ticker: "INFY.NS" }, WEEKEND);
  assert.equal(status.stale, false);
  assert.equal(status.marketClosed, true);
  assert.equal(status.label, "Last session data");
});

test("freshnessStatus reports 'Last session data' before the Monday open", () => {
  const fridayClose = new Date("2025-09-05T10:00:00.000Z").toISOString();
  const status = freshnessStatus(fridayClose, { ticker: "INFY.NS" }, MONDAY_BEFORE_OPEN);
  assert.equal(status.stale, false);
  assert.equal(status.marketClosed, true);
  assert.equal(status.label, "Last session data");
});

test("freshnessStatus keeps ordinary staleness logic for non-Indian tickers", () => {
  const oldQuote = new Date(MARKET_CLOSED_SAME_DAY.getTime() - 45 * 60_000).toISOString();
  const status = freshnessStatus(oldQuote, { ticker: "AAPL" }, MARKET_CLOSED_SAME_DAY);
  assert.equal(status.stale, true);
  assert.equal(status.marketClosed, false);
  assert.equal(status.label, "45m old");
});

test("freshnessStatus flags unavailable quote timestamps regardless of market state", () => {
  const status = freshnessStatus("not-a-date", { ticker: "TCS.NS" }, MARKET_OPEN_WEEKDAY);
  assert.equal(status.stale, true);
  assert.equal(status.ageMinutes, null);
  assert.equal(status.label, "Quote time unavailable");
});
