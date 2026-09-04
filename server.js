import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { calculateSignal, explainSignal } from "./lib/scoring.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dataDir = join(root, "data");
const databasePath = join(dataDir, "watchlist.json");
const port = Number(process.env.PORT || 3000);
const CACHE_MS = 60_000;
const MAX_WATCHLIST_SIZE = 40;
let writeChain = Promise.resolve();
let database = { users: {}, watchlists: {}, snapshots: {}, cache: {} };

async function loadDatabase() {
  await mkdir(dataDir, { recursive: true });
  try {
    database = JSON.parse(await readFile(databasePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await persist();
  }
}

function persist() {
  const snapshot = JSON.stringify(database, null, 2);
  writeChain = writeChain.then(async () => {
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
    if (body.length > 50_000) throw new Error("Request body is too large.");
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function cookies(request) {
  return Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .filter(Boolean)
      .map((value) => value.trim().split("=")),
  );
}

async function currentUser(request, response) {
  let id = cookies(request).signal_user;
  if (!id || !database.users[id]) {
    id = randomUUID();
    database.users[id] = { id, createdAt: new Date().toISOString(), lastSeenAt: null };
    await persist();
    response.setHeader("set-cookie", `signal_user=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  }
  return database.users[id];
}

function normalizeTicker(value) {
  const ticker = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,15}$/.test(ticker)) throw new Error("Use a valid ticker, such as AAPL or RELIANCE.NS.");
  return ticker;
}

function timestamp() {
  return new Date().toISOString();
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "SignalWatch/1.0 (market watchlist)" },
    });
    if (!response.ok) throw new Error(`Market provider returned ${response.status}.`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahoo(ticker) {
  const chart = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2mo&interval=1d`,
  );
  const result = chart.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote) throw new Error("No market data was returned for this ticker.");
  const history = result.timestamp
    .map((time, index) => ({
      close: quote.close[index],
      volume: quote.volume[index],
      at: new Date(time * 1000).toISOString(),
    }))
    .filter((day) => Number.isFinite(day.close));
  const latest = history.at(-1);
  const previous = history.at(-2);
  if (!latest || !previous) throw new Error("Not enough price history is available yet.");
  return {
    ticker,
    name: result.meta.longName || result.meta.shortName || ticker,
    price: result.meta.regularMarketPrice ?? latest.close,
    previousClose: result.meta.chartPreviousClose ?? previous.close,
    volume: result.meta.regularMarketVolume ?? latest.volume,
    history,
    provider: "Yahoo Finance",
    providerAt: result.meta.regularMarketTime
      ? new Date(result.meta.regularMarketTime * 1000).toISOString()
      : latest.at,
  };
}

async function fetchStooq(ticker) {
  if (!/^[A-Z.]+$/.test(ticker)) return null;
  const symbol = `${ticker.toLowerCase()}.us`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcv&h&e=csv`, {
      signal: controller.signal,
      headers: { "user-agent": "SignalWatch/1.0" },
    });
    if (!response.ok) return null;
    const [header, row] = (await response.text()).trim().split(/\r?\n/);
    if (!header || !row || row.includes("N/D")) return null;
    const fields = row.split(",");
    const close = Number(fields[6]);
    return Number.isFinite(close) ? { price: close, at: `${fields[1]}T${fields[2]}Z`, provider: "Stooq" } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function freshness(providerAt) {
  const ageMinutes = Math.round((Date.now() - new Date(providerAt).getTime()) / 60_000);
  return { ageMinutes, stale: ageMinutes > 20, label: ageMinutes <= 1 ? "Just updated" : `${ageMinutes}m old` };
}

async function marketData(ticker) {
  const cached = database.cache[ticker];
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_MS) return cached;

  try {
    const primary = await fetchYahoo(ticker);
    const secondary = await fetchStooq(ticker);
    const discrepancy =
      secondary && primary.price > 0 ? Math.abs(secondary.price - primary.price) / primary.price : 0;
    const sourceConflict = discrepancy > 0.015;
    const data = {
      ...primary,
      fetchedAt: timestamp(),
      secondary,
      sourceConflict,
      freshness: freshness(primary.providerAt),
    };
    database.cache[ticker] = data;
    await persist();
    return data;
  } catch (error) {
    if (cached) {
      return { ...cached, fetchError: error.message, freshness: { ...freshness(cached.providerAt), stale: true } };
    }
    throw error;
  }
}

function recordedPrice(ticker, when) {
  const snapshots = database.snapshots[ticker] || [];
  return [...snapshots].reverse().find((snapshot) => new Date(snapshot.at) <= new Date(when));
}

function saveSnapshot(data) {
  const previous = (database.snapshots[data.ticker] || []).at(-1);
  if (previous && Math.abs(previous.price - data.price) < 0.000001) return;
  database.snapshots[data.ticker] = [...(database.snapshots[data.ticker] || []), {
    // Snapshot timing is when this user observed the quote, not the exchange quote timestamp.
    at: timestamp(),
    price: data.price,
    volume: data.volume,
    provider: data.provider,
  }].slice(-100);
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
          status: market.fetchError ? "stale" : market.freshness.stale ? "delayed" : "live",
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
  if (markSeen) {
    user.lastSeenAt = timestamp();
    await persist();
  } else {
    await persist();
  }
  return { entries, lastSeenAt: previousVisit };
}

async function api(request, response, user, path) {
  if (request.method === "GET" && path === "/api/watchlist") {
    return send(response, 200, await watchlistPayload(user));
  }
  if (request.method === "GET" && path === "/api/changes") {
    return send(response, 200, await watchlistPayload(user, true));
  }
  if (request.method === "POST" && path === "/api/watchlist") {
    const ticker = normalizeTicker((await readJson(request)).ticker);
    const items = database.watchlists[user.id] || [];
    if (items.length >= MAX_WATCHLIST_SIZE) throw new Error(`A watchlist is limited to ${MAX_WATCHLIST_SIZE} stocks.`);
    if (items.some((item) => item.ticker === ticker)) throw new Error(`${ticker} is already in your watchlist.`);
    const market = await marketData(ticker);
    database.watchlists[user.id] = [...items, { ticker, addedAt: timestamp() }];
    saveSnapshot(market);
    await persist();
    return send(response, 201, { ok: true, ticker });
  }
  if (request.method === "DELETE" && path.startsWith("/api/watchlist/")) {
    const ticker = normalizeTicker(decodeURIComponent(path.split("/").at(-1)));
    database.watchlists[user.id] = (database.watchlists[user.id] || []).filter((item) => item.ticker !== ticker);
    await persist();
    return send(response, 200, { ok: true });
  }
  return send(response, 404, { error: "API route not found." });
}

const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

const server = createServer(async (request, response) => {
  const path = new URL(request.url, `http://${request.headers.host}`).pathname;
  try {
    const user = await currentUser(request, response);
    if (path.startsWith("/api/")) return await api(request, response, user, path);
    const requested = path === "/" ? "index.html" : normalize(path).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = await readFile(join(publicDir, requested));
    response.writeHead(200, { "content-type": mimeTypes[extname(requested)] || "application/octet-stream" });
    response.end(file);
  } catch (error) {
    if (path.startsWith("/api/")) return send(response, 400, { error: error.message || "Unexpected server error." });
    response.writeHead(error.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error.code === "ENOENT" ? "Not found" : "Server error");
  }
});

await loadDatabase();
server.listen(port, () => console.log(`Signal Watch is running at http://localhost:${port}`));
