import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { displayTicker, displayTickerMessage } from "../public/ticker-utils.js";

const root = new URL("..", import.meta.url).pathname;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function yahooPayload(ticker) {
  const start = Date.now() - 26 * 86_400_000;
  const closes = Array.from({ length: 25 }, (_, index) => 100 + index * 0.2);
  return {
    chart: {
      result: [{
        meta: {
          longName: `${ticker} Ltd`,
          regularMarketPrice: 105,
          chartPreviousClose: 100,
          regularMarketVolume: 3000,
          regularMarketTime: Math.floor(Date.now() / 1000),
        },
        timestamp: closes.map((_, index) => Math.floor((start + index * 86_400_000) / 1000)),
        indicators: { quote: [{ close: closes, volume: closes.map(() => 1000) }] },
      }],
    },
  };
}

async function startMockProvider() {
  const state = { chartRequests: new Map(), stooqRequests: 0, timeoutTickers: new Set() };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://mock");
    if (url.pathname.startsWith("/v8/finance/chart/")) {
      const ticker = decodeURIComponent(url.pathname.split("/").at(-1));
      state.chartRequests.set(ticker, (state.chartRequests.get(ticker) || 0) + 1);
      if (ticker === "MISSING.NS" || ticker === "MISSING") {
        response.writeHead(404).end();
        return;
      }
      if (state.timeoutTickers.has(ticker)) return;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(yahooPayload(ticker)));
      return;
    }
    if (url.pathname === "/q/l/") {
      state.stooqRequests += 1;
      if (url.searchParams.get("s") === "missing.us") {
        response.writeHead(200, { "content-type": "text/csv" }).end("Symbol,Date,Time,Open,High,Low,Close,Volume\nN/D,N/D,N/D,N/D,N/D,N/D,N/D,N/D\n");
        return;
      }
      response.writeHead(200, { "content-type": "text/csv" }).end("Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-09-04,10:00:00,100,103,99,102,1000\n");
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0);
  await once(server, "listening");
  const port = server.address().port;
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function startApp(dataDir, providerUrl) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: "0",
      DATA_DIR: dataDir,
      CACHE_MS: "25",
      FETCH_TIMEOUT_MS: "30",
      STOOQ_TIMEOUT_MS: "30",
      YAHOO_CHART_URL: `${providerUrl}/v8/finance/chart`,
      STOOQ_QUOTE_URL: `${providerUrl}/q/l/`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 2000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/localhost:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Server exited before starting (${code}).`)));
  });
  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { body: await response.json(), response };
}

test("recovers corrupted persistence and cleans abandoned atomic-write files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "signal-watch-corrupt-"));
  const provider = await startMockProvider();
  await writeFile(join(directory, "watchlist.json"), "{invalid json");
  await writeFile(join(directory, "watchlist.json.deadbeef.tmp"), "partial");
  const app = await startApp(directory, provider.url);
  t.after(async () => {
    await app.stop();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  });

  const { body, response } = await api(app.baseUrl, "/api/changes", { headers: { cookie: "signal_user=not-a-uuid" } });
  assert.equal(response.status, 200);
  assert.deepEqual(body.entries, []);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  const files = await readdir(directory);
  assert.ok(files.some((file) => file.startsWith("watchlist.corrupt-")));
  assert.ok(!files.some((file) => file.endsWith(".tmp")));
});

test("search resolves friendly NSE names and rejects empty queries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "signal-watch-search-"));
  const provider = await startMockProvider();
  const app = await startApp(directory, provider.url);
  t.after(async () => {
    await app.stop();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  });

  const search = await api(app.baseUrl, "/api/search?q=Reliance");
  assert.equal(search.response.status, 200);
  assert.equal(search.body.results[0].symbol, "RELIANCE.NS");
  const empty = await api(app.baseUrl, "/api/search?q=");
  assert.equal(empty.response.status, 400);
  assert.match(empty.body.error, /at least 2 characters/i);
});

test("display helpers hide provider suffixes without altering canonical symbols", () => {
  assert.equal(displayTicker("RELIANCE.NS"), "RELIANCE");
  assert.equal(displayTicker("TCS.NS"), "TCS");
  assert.equal(displayTicker("500325.BO"), "500325");
  assert.equal(displayTicker("AAPL"), "AAPL");
  assert.equal(displayTicker("BRK-B"), "BRK-B");
  assert.equal(displayTickerMessage("TCS.NS is already in your watchlist."), "TCS is already in your watchlist.");
  assert.equal(displayTickerMessage("500325.BO removed."), "500325 removed.");
  assert.equal(displayTickerMessage("AAPL is fine."), "AAPL is fine.");
});

test("coalesces market requests, serializes concurrent mutations, and returns stale cached data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "signal-watch-api-"));
  const provider = await startMockProvider();
  const app = await startApp(directory, provider.url);
  t.after(async () => {
    await app.stop();
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  });

  const initial = await api(app.baseUrl, "/api/changes");
  const cookie = initial.response.headers.get("set-cookie").split(";")[0];
  const post = (ticker) =>
    api(app.baseUrl, "/api/watchlist", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ticker }),
    });

  const [tcs, infy] = await Promise.all([post("TCS.NS"), post("INFY.NS")]);
  assert.equal(tcs.response.status, 201);
  assert.equal(infy.response.status, 201);
  const afterConcurrentAdds = await api(app.baseUrl, "/api/watchlist", { headers: { cookie } });
  assert.deepEqual(afterConcurrentAdds.body.entries.map((entry) => entry.ticker).sort(), ["INFY.NS", "TCS.NS"]);
  const persisted = JSON.parse(await readFile(join(directory, "watchlist.json"), "utf8"));
  const userId = cookie.split("=")[1];
  assert.equal(persisted.watchlists[userId].length, 2);

  const [firstAapl, secondAapl] = await Promise.all([post("AAPL"), post("AAPL")]);
  assert.deepEqual([firstAapl.response.status, secondAapl.response.status].sort(), [201, 409]);
  assert.equal(provider.state.chartRequests.get("AAPL"), 1);
  await wait(10);
  const crossChecked = await api(app.baseUrl, "/api/watchlist", { headers: { cookie } });
  assert.equal(crossChecked.body.entries.find((entry) => entry.ticker === "AAPL").sourceConflict, true);
  assert.equal(provider.state.stooqRequests, 1);

  await post("TIMEOUT.NS");
  provider.state.timeoutTickers.add("TIMEOUT.NS");
  await wait(35);
  const fallback = await api(app.baseUrl, "/api/watchlist", { headers: { cookie } });
  const timedOut = fallback.body.entries.find((entry) => entry.ticker === "TIMEOUT.NS");
  assert.equal(timedOut.status, "stale");
  assert.match(timedOut.fetchError, /abort|timeout/i);

  const unavailable = await post("MISSING");
  assert.equal(unavailable.response.status, 502);
  assert.match(unavailable.body.error, /Market provider returned 404/);
});
