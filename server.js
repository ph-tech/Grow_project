import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YahooFinance from "yahoo-finance2";
import { calculateSignal, explainSignal } from "./lib/scoring.js";
import { freshnessStatus } from "./lib/market-hours.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(root, "data");
const databasePath = join(dataDir, "watchlist.json");
const port = Number(process.env.PORT || 3000);
const CACHE_MS = Number(process.env.CACHE_MS || 60_000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 7_000);
const STOOQ_TIMEOUT_MS = Number(process.env.STOOQ_TIMEOUT_MS || 5_000);
const YAHOO_CHART_URL = process.env.YAHOO_CHART_URL || "https://query1.finance.yahoo.com/v8/finance/chart";
const STOOQ_QUOTE_URL = process.env.STOOQ_QUOTE_URL || "https://stooq.com/q/l/";
const MAX_WATCHLIST_SIZE = 40;
let writeChain = Promise.resolve();
let database = { users: {}, watchlists: {}, snapshots: {}, cache: {} };
const inFlightMarketRequests = new Map();
const userLocks = new Map();
const searchCache = new Map();
const yahooFinance = new YahooFinance();
const knownSymbols = new Map([
  ["TCS", "TCS.NS"], ["RELIANCE", "RELIANCE.NS"], ["RELIANCE INDUSTRIES", "RELIANCE.NS"],
  ["INFOSYS", "INFY.NS"], ["INFY", "INFY.NS"], ["HDFC BANK", "HDFCBANK.NS"],
  ["APPLE", "AAPL"], ["AAPL", "AAPL"], ["MICROSOFT", "MSFT"], ["MSFT", "MSFT"],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function emptyDatabase() {
  return { users: {}, watchlists: {}, snapshots: {}, cache: {} };
}

function objectRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry)));
}

function arrayRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => Array.isArray(entry)));
}

function normalizeDatabase(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyDatabase();
  return {
    users: objectRecord(value.users),
    watchlists: arrayRecord(value.watchlists),
    snapshots: arrayRecord(value.snapshots),
    cache: objectRecord(value.cache),
  };
}

async function removeOrphanedTempFiles() {
  const files = await readdir(dataDir);
  await Promise.all(
    files
      .filter((file) => /^watchlist\.json\.[0-9a-f-]+\.tmp$/i.test(file))
      .map((file) => unlink(join(dataDir, file))),
  );
}

async function loadDatabase() {
  await mkdir(dataDir, { recursive: true });
  await removeOrphanedTempFiles();
  try {
    database = normalizeDatabase(JSON.parse(await readFile(databasePath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") {
      const recoveryPath = join(dataDir, `watchlist.corrupt-${Date.now()}.json`);
      await rename(databasePath, recoveryPath);
      console.error(`Recovered from corrupt watchlist store at ${recoveryPath}.`);
    }
    database = emptyDatabase();
    await persist();
  }
}

function persist() {
  const snapshot = JSON.stringify(database, null, 2);
  writeChain = writeChain.catch((error) => {
    console.error(`Previous watchlist persistence failed: ${error.message}`);
  }).then(async () => {
    const tempPath = `${databasePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, snapshot);
    await rename(tempPath, databasePath);
  });
  return writeChain;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 50_000) throw new HttpError(413, "Request body is too large.");
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function cookies(request) {
  return Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .filter(Boolean)
      .map((value) => {
        const separator = value.indexOf("=");
        return separator === -1 ? [value.trim(), ""] : [value.slice(0, separator).trim(), value.slice(separator + 1)];
      }),
  );
}

async function currentUser(request, response) {
  let id = cookies(request).signal_user;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id || "") || !database.users[id]) {
    id = randomUUID();
    database.users[id] = { id, createdAt: new Date().toISOString(), lastSeenAt: null };
    await persist();
    response.setHeader("set-cookie", `signal_user=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  }
  return database.users[id];
}

function normalizeTicker(value) {
  const ticker = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,30}$/.test(ticker)) {
    throw new HttpError(400, "Use a valid ticker, such as RELIANCE.NS or TCS.NS.");
  }
  return ticker;
}

function normalizeSearchQuery(value) {
  const query = String(value || "").trim().replace(/\s+/g, " ");
  if (query.length < 2) throw new HttpError(400, "Search query must contain at least 2 characters.");
  if (query.length > 80) throw new HttpError(400, "Search query is too long.");
  return query;
}

function searchResult(quote) {
  const symbol = String(quote.symbol || "").toUpperCase();
  if (!/^[A-Z0-9.^-]{1,30}$/.test(symbol)) return null;
  return {
    symbol,
    name: quote.longname || quote.shortname || symbol,
    exchange: quote.exchangeDisplay || quote.exchange || null,
    exchangeCode: quote.exchange || null,
    currency: quote.currency || null,
  };
}

async function searchSymbols(query) {
  const normalized = normalizeSearchQuery(query);
  const cached = searchCache.get(normalized.toUpperCase());
  if (cached && cached.expiresAt > Date.now()) return cached.results;
  const local = knownSymbols.get(normalized.toUpperCase());
  let results = [];
  if (local) {
    results = [{ symbol: local, name: normalized, exchange: local.endsWith(".NS") ? "NSE" : "NASDAQ", exchangeCode: local.endsWith(".NS") ? "NSI" : "NMS", currency: local.endsWith(".NS") ? "INR" : "USD" }];
  } else {
    try {
      const response = await yahooFinance.search(normalized, { quotesCount: 12, newsCount: 0 });
      results = (response.quotes || []).map(searchResult).filter(Boolean);
    } catch (error) {
      throw new HttpError(502, `Search provider unavailable: ${error.message}`);
    }
  }
  results.sort((a, b) => {
    const aNse = a.symbol.endsWith(".NS") ? 0 : 1;
    const bNse = b.symbol.endsWith(".NS") ? 0 : 1;
    return aNse - bNse;
  });
  results = results.slice(0, 8);
  searchCache.set(normalized.toUpperCase(), { results, expiresAt: Date.now() + 5 * 60_000 });
  return results;
}

async function resolveTicker(value) {
  const input = String(value || "").trim();
  if (!input) throw new HttpError(400, "Enter a ticker or company name.");
  const known = knownSymbols.get(input.toUpperCase());
  if (known) return known;
  if (/^[A-Za-z0-9-]+(?:\.[A-Za-z]+)?$/.test(input)) return normalizeTicker(input);
  const results = await searchSymbols(input);
  if (!results.length) throw new HttpError(400, "No matching company or ticker was found.");
  return results[0].symbol;
}

function timestamp() {
  return new Date().toISOString();
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "SignalWatch/1.0 (market watchlist)" },
    });
    if (!response.ok) throw new HttpError(502, `Market provider returned ${response.status}.`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahoo(ticker) {
  const chart = await fetchJson(
    `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?range=2mo&interval=1d`,
  );
  const result = chart.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote || !Array.isArray(result.timestamp) || !Array.isArray(quote.close)) {
    throw new HttpError(422, "No market data was returned for this ticker.");
  }
  const history = result.timestamp
    .map((time, index) => ({
      close: quote.close[index],
      volume: quote.volume?.[index],
      at: new Date(time * 1000).toISOString(),
    }))
    .filter((day) => Number.isFinite(day.close));
  const latest = history.at(-1);
  const previous = history.at(-2);
  if (!latest || !previous) throw new HttpError(422, "Not enough price history is available yet.");
  const price = Number(result.meta.regularMarketPrice ?? latest.close);
  const previousClose = Number(result.meta.chartPreviousClose ?? previous.close);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(previousClose) || previousClose <= 0) {
    throw new HttpError(422, "The provider returned an invalid market price.");
  }
  return {
    ticker,
    name: result.meta.longName || result.meta.shortName || ticker,
    price,
    previousClose,
    volume: Number(result.meta.regularMarketVolume ?? latest.volume) || null,
    history,
    provider: "Yahoo Finance",
    currency: result.meta.currency || null,
    exchange: result.meta.exchangeName || null,
    exchangeCode: result.meta.exchange || null,
    exchangeTimezone: result.meta.exchangeTimezoneName || null,
    providerAt: result.meta.regularMarketTime
      ? new Date(result.meta.regularMarketTime * 1000).toISOString()
      : latest.at,
  };
}

async function fetchStooq(ticker) {
  if (!/^[A-Z]{1,5}(?:\.[A-Z])?$/.test(ticker)) return { quote: null, error: null };
  const symbol = `${ticker.toLowerCase()}.us`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STOOQ_TIMEOUT_MS);
  try {
    const response = await fetch(`${STOOQ_QUOTE_URL}?s=${symbol}&f=sd2t2ohlcv&h&e=csv`, {
      signal: controller.signal,
      headers: { "user-agent": "SignalWatch/1.0" },
    });
    if (!response.ok) return { quote: null, error: `Stooq returned ${response.status}.` };
    const [header, row] = (await response.text()).trim().split(/\r?\n/);
    if (!header || !row || row.includes("N/D")) return { quote: null, error: "Stooq has no quote for this ticker." };
    const fields = row.split(",");
    const close = Number(fields[6]);
    return Number.isFinite(close)
      ? { quote: { price: close, at: `${fields[1]}T${fields[2]}Z`, provider: "Stooq" }, error: null }
      : { quote: null, error: "Stooq returned an invalid quote." };
  } catch (error) {
    return { quote: null, error: `Stooq cross-check unavailable: ${error.name === "AbortError" ? "timed out" : error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

function freshness(providerAt, market = {}) {
  return freshnessStatus(providerAt, market);
}

function applySecondaryQuote(ticker, fetchedAt, primaryPrice, result) {
  const current = database.cache[ticker];
  if (!current || current.fetchedAt !== fetchedAt) return;
  const secondary = result.quote;
  const discrepancy = secondary && primaryPrice > 0 ? Math.abs(secondary.price - primaryPrice) / primaryPrice : 0;
  current.secondary = secondary;
  current.secondaryError = result.error;
  current.sourceConflict = discrepancy > 0.015;
  persist().catch((error) => console.error(`Unable to persist Stooq cross-check for ${ticker}: ${error.message}`));
}

async function fetchAndCacheMarketData(ticker, cached) {
  const secondaryPromise = fetchStooq(ticker);
  try {
    const primary = await fetchYahoo(ticker);
    const data = {
      ...primary,
      fetchedAt: timestamp(),
      secondary: null,
      secondaryError: null,
      sourceConflict: false,
      freshness: freshness(primary.providerAt, primary),
    };
    database.cache[ticker] = data;
    await persist();
    secondaryPromise
      .then((result) => applySecondaryQuote(ticker, data.fetchedAt, data.price, result))
      .catch((error) => console.error(`Unexpected Stooq cross-check failure for ${ticker}: ${error.message}`));
    return data;
  } catch (error) {
    if (cached) {
      return { ...cached, fetchError: error.message, freshness: { ...freshness(cached.providerAt, cached), stale: true } };
    }
    throw error;
  }
}

async function marketData(ticker) {
  const cached = database.cache[ticker];
  const fetchedAt = new Date(cached?.fetchedAt).getTime();
  if (cached && Number.isFinite(fetchedAt) && Date.now() - fetchedAt < CACHE_MS) return cached;
  if (!inFlightMarketRequests.has(ticker)) {
    const request = fetchAndCacheMarketData(ticker, cached).finally(() => inFlightMarketRequests.delete(ticker));
    inFlightMarketRequests.set(ticker, request);
  }
  return inFlightMarketRequests.get(ticker);
}

function recordedPrice(ticker, when) {
  const snapshots = database.snapshots[ticker] || [];
  return [...snapshots].reverse().find((snapshot) => new Date(snapshot.at) <= new Date(when));
}

function saveSnapshot(data) {
  if (!Number.isFinite(data.price) || data.price <= 0) return;
  const previous = (database.snapshots[data.ticker] || []).at(-1);
  if (previous && Math.abs(previous.price - data.price) < 0.000001) return;
  database.snapshots[data.ticker] = [...(database.snapshots[data.ticker] || []), {
    // Snapshot timing is when this user observed the quote, not the exchange quote timestamp.
    at: timestamp(),
    price: data.price,
    volume: data.volume,
    provider: data.provider,
    currency: data.currency || null,
    exchange: data.exchange || null,
    exchangeCode: data.exchangeCode || null,
    exchangeTimezone: data.exchangeTimezone || null,
  }].slice(-100);
}

function withUserLock(userId, mutation) {
  const previous = userLocks.get(userId) || Promise.resolve();
  const next = previous.then(mutation, mutation);
  userLocks.set(userId, next);
  return next.finally(() => {
    if (userLocks.get(userId) === next) userLocks.delete(userId);
  });
}

async function watchlistPayload(user, markSeen = false) {
  const items = database.watchlists[user.id] || [];
  const previousVisit = user.lastSeenAt;
  const entries = await Promise.all(
    items.map(async (item) => {
      try {
        const market = await marketData(item.ticker);
        const signal = calculateSignal(market);
        const baseline = previousVisit ? recordedPrice(item.ticker, previousVisit) : null;
        const sinceVisitPercent = baseline?.price ? ((market.price - baseline.price) / baseline.price) * 100 : null;
        saveSnapshot(market);
        return {
          ...market,
          addedAt: item.addedAt,
          signal: { ...signal, explanation: explainSignal(signal) },
          sinceVisitPercent,
          status: market.fetchError ? "stale" : market.freshness.stale ? "delayed" : market.freshness.marketClosed ? "closed" : "live",
        };
      } catch (error) {
        return {
          ticker: item.ticker,
          name: item.ticker,
          status: "unavailable",
          error: error.message,
          addedAt: item.addedAt,
        };
      }
    }),
  );
  entries.sort((a, b) => (b.signal?.score || -1) - (a.signal?.score || -1));
  if (markSeen) user.lastSeenAt = timestamp();
  await persist();
  return { entries, lastSeenAt: previousVisit };
}

async function api(request, response, user, path) {
  if (request.method === "GET" && path === "/api/search") {
    const query = new URL(request.url || "/", "http://localhost").searchParams.get("q");
    return send(response, 200, { results: await searchSymbols(query) });
  }
  if (request.method === "GET" && path === "/api/watchlist") {
    return send(response, 200, await watchlistPayload(user));
  }
  if (request.method === "GET" && path === "/api/changes") {
    return send(response, 200, await watchlistPayload(user, true));
  }
  if (request.method === "POST" && path === "/api/watchlist") {
    const ticker = await resolveTicker((await readJson(request)).ticker);
    const market = await marketData(ticker);
    await withUserLock(user.id, async () => {
      const items = database.watchlists[user.id] || [];
      if (items.length >= MAX_WATCHLIST_SIZE) {
        throw new HttpError(409, `A watchlist is limited to ${MAX_WATCHLIST_SIZE} stocks.`);
      }
      if (items.some((item) => item.ticker === ticker)) {
        throw new HttpError(409, `${ticker} is already in your watchlist.`);
      }
      database.watchlists[user.id] = [...items, { ticker, addedAt: timestamp() }];
      saveSnapshot(market);
      await persist();
    });
    return send(response, 201, { ok: true, ticker });
  }
  if (request.method === "DELETE" && path.startsWith("/api/watchlist/")) {
    const ticker = normalizeTicker(decodeURIComponent(path.split("/").at(-1)));
    await withUserLock(user.id, async () => {
      database.watchlists[user.id] = (database.watchlists[user.id] || []).filter((item) => item.ticker !== ticker);
      await persist();
    });
    return send(response, 200, { ok: true });
  }
  return send(response, 404, { error: "API route not found." });
}

const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

const server = createServer(async (request, response) => {
  const path = new URL(request.url || "/", "http://localhost").pathname;
  try {
    const user = await currentUser(request, response);
    if (path.startsWith("/api/")) return await api(request, response, user, path);
    const requested = path === "/" ? "index.html" : normalize(path).replace(/^[/\\]+/, "");
    if (requested.startsWith("..")) throw new HttpError(404, "Not found.");
    const file = await readFile(join(publicDir, requested));
    response.writeHead(200, { "content-type": mimeTypes[extname(requested)] || "application/octet-stream" });
    response.end(file);
  } catch (error) {
    if (path.startsWith("/api/")) {
      return send(response, error instanceof HttpError ? error.status : 500, {
        error: error.message || "Unexpected server error.",
      });
    }
    response.writeHead(error.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error.code === "ENOENT" ? "Not found" : "Server error");
  }
});

await loadDatabase();
server.listen(port, () => console.log(`Signal Watch is running at http://localhost:${server.address().port}`));
