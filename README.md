# Signal Watch

Signal Watch is a volatility-aware market watchlist for CODE 2026. It makes attention a relative concept: a calm stock moving 1% can be more important than a volatile stock moving 4%.

**Live demo:** https://growproject-production.up.railway.app/

## Run locally

Requires Node.js 22 or later.

```bash
npm test
npm start
```

Open `http://localhost:3000`. Search for companies or tickers such as `Reliance`, `TCS`, `Infosys`, `HDFC Bank`, `Apple`, or `AAPL`; canonical provider symbols are retained internally and prices use provider currency metadata. The application creates a server-side device session cookie on first use and stores its data in `data/watchlist.json`. No market-data API key is required.

For Railway, mount a persistent volume at `/data` and set `DATA_DIR=/data`.

## Architecture

```
Browser
  |  fetch() / HTML
  v
Node HTTP API (server.js)
  |
  +--> Watchlist / session layer (device-session cookie, user + watchlist records)
  |
  +--> Signal engine (lib/scoring.js: relative volatility + volume confirmation)
  |
  +--> Quote cache / snapshots (in-memory cache + timestamped price history)
  |         |
  |         +--> Yahoo Finance (primary provider: price, history, currency, exchange)
  |         |
  |         +--> Stooq (secondary cross-check for plain U.S. tickers)
  |
  v
Persistent Railway volume (data/watchlist.json, atomic writes)
```

Production evolution (not implemented, described for judging only):

```
Postgres (users, watchlist_items, market_snapshots)
  + Redis (shared quote cache across instances)
  + bounded background worker queue (scheduled refreshes instead of per-request fetches)
```

For Railway, mount a persistent volume at `/data` and set `DATA_DIR=/data`.

## Engineering decisions

### Beyond the basic watchlist

Signal Watch includes four focused product surfaces beyond the dashboard. **Peer divergence** compares a stock with two or more watched sector peers and flags an unusual outperformer or underperformer; the first groups cover IT services, private banks, auto, and energy. **Stock detail** exposes the 30-session range, usual swing, volume baseline, and recorded signals. **Signal history** is a dated record of meaningful daily moves. **Settings** offers a persisted high-confidence/all/off signal-digest filter and explains the current NSE session status. A password-protected account can merge the device watchlist into a server account and restore it on another device.

### Meaningful change

For each stock, Signal Watch calculates the **sample** standard deviation of its recent daily percentage returns (up to 20 observations, with a 0.25% floor applied before the comparison). A current move is meaningful when it is at least **1.25x that stock's normal daily swing**, or at least **0.9x normal with 2x average volume**. The ranked signal score multiplies that relative move by a capped volume-confidence boost (at most 1.7x the range score). This keeps routine volatility out of the feed while promoting moves with real participation. Each card exposes the raw daily move, its normal-range multiple, volume multiple, score, and a plain-language reason.

### Persistence and sessions

The client stores no watchlist state. On the first request, the server issues an HTTP-only, long-lived device-session cookie and creates a user record. Watchlist entries, provider cache records, and timestamped price snapshots live in the server-side persistence file. A user's last-view timestamp plus the most recent snapshot from that point provides the “since you left” comparison after a later visit. In production, this file maps directly to tables in Postgres (`users`, `watchlist_items`, `market_snapshots`, and `market_cache`); it is deliberately a single-file backend store here to remove setup friction.

### Market data, stale data, and conflicts

Yahoo Finance chart data is the primary source and is cached server-side for 60 seconds. For plain U.S. tickers, Stooq is queried as a secondary cross-check. A discrepancy above 1.5% is visible as a source-conflict health label; the primary price remains displayed because its intraday metadata and history drive the scoring calculation. Provider time is always shown through data health. If a refresh times out, the last cached result is returned with a stale status and error context instead of silently showing it as live. For NSE/BSE tickers, the freshness check also detects Indian market hours and weekends: previous-session data is labelled "Market closed" or "Last session data" instead of being flagged stale, while genuinely outdated data during active trading hours still shows as stale. Symbols without enough history, delisted instruments, and no-activity instruments remain in the list as unavailable rather than disappearing.

### Scale and concurrency

The immediate bottleneck is upstream market-data rate limits, not scoring: calculations are linear in a maximum 30 daily points. Server caching means concurrent viewers of the same ticker share one result. Writes serialize through an atomic temp-file rename so simultaneous requests do not corrupt state. A production evolution would map this single-file store onto dedicated services:

| Current (this build) | Production evolution |
| --- | --- |
| Watchlist entries in `data/watchlist.json` | `watchlist_items` table in Postgres |
| User/session records in `data/watchlist.json` | `users` table in Postgres |
| Timestamped price snapshots in `data/watchlist.json` | `market_snapshots` table in Postgres |
| In-process quote cache (per Node instance) | Shared quote cache in Redis (across instances) |
| Per-request Yahoo/Stooq fetch with in-flight de-duplication | Bounded background worker queue refreshing subscribed symbols on a schedule |

### Time-pressure trade-off

I chose a self-contained email/password account over a third-party OAuth integration and a file-backed server store over provisioning Postgres. It makes cross-device watchlist restoration possible without requiring external credentials, but it does not provide password reset, email verification, or multi-instance coordination. The atomic write queue and in-flight market-request deduplication operate inside one Node process; a multi-instance deployment still needs Postgres and Redis before it can coordinate writes and cache refreshes across instances.

## Why I made these choices

- **Relative volatility instead of raw percentage change** — a 1% move in a normally-quiet stock is more informative than a 4% move in a stock that swings that much most days. Comparing each move against the stock's own recent standard deviation surfaces genuinely unusual behavior instead of just ranking the biggest raw movers.
- **Volume as confirmation, not a standalone trigger** — a large relative price move without participation is often noise (thin trading, a single print). Requiring average-volume confirmation (or allowing a lower price threshold when volume is very high) reduces false positives while still catching high-conviction moves.
- **Anonymous device identity instead of authentication** — a device-scoped, HTTP-only session cookie gives the "since you last visited" comparison and persistent watchlist without building sign-up, password/OAuth flows, or account recovery in a 72-hour window. It is intentionally the smallest mechanism that satisfies the core challenge requirement.
- **File-backed persistence instead of Postgres for this 72-hour build** — a single atomically-written JSON file removes all setup friction (no database provisioning, migrations, or connection pooling) while still giving real cross-visit durability on a mounted Railway volume. The data shape is already table-shaped (`users`, `watchlist_items`, `market_snapshots`, `market_cache`), so moving to Postgres later is a storage-layer swap, not a redesign.
- **No WebSockets** — the watchlist is refreshed on page load/visit, not streamed tick-by-tick. Polling on demand with server-side caching is simpler, cheaper against upstream rate limits, and matches how someone actually checks a watchlist (open the tab, glance, close it) rather than a trading terminal use case.
- **Yahoo + Stooq instead of introducing more providers** — Yahoo's chart endpoint gives price, history, currency, and exchange metadata in one call, which is what scoring and display need. Stooq adds a free, independent second opinion for plain U.S. tickers to catch provider drift. Adding more providers would add rate-limit surface and reconciliation complexity without changing what the core signal needs.

### Cross-device trade-off

Same-browser/device revisits persist automatically through the device-session cookie: the watchlist, snapshots, and "since last visit" comparison all come back without any login step. Cross-device account sync — seeing the same watchlist from a phone and a laptop — is intentionally not implemented in this build. The device-session cookie could later be replaced by an authenticated user ID (from a real login) without changing the watchlist or snapshot data model at all: the `users`, `watchlist_items`, and `market_snapshots` shapes are already keyed by a user identifier, so swapping in an authenticated ID is a session-layer change, not a data-model change.

## Edge cases handled

- **Stale provider fallback** — if a refresh fails or times out, the last cached quote is returned with a `stale` status and the underlying error message, instead of silently presenting old data as live.
- **Market-closed handling** — for NSE/BSE tickers, weekend and after-hours quotes are labelled "Market closed" or "Last session data" rather than being flagged stale, while genuinely outdated data during active market hours is still flagged.
- **Source conflicts** — when the Stooq cross-check disagrees with the Yahoo primary price by more than 1.5%, the entry is marked with a source-conflict health label instead of failing silently.
- **Unavailable/delisted symbols** — tickers with no usable price history (delisted, no activity, or an invalid symbol) stay in the watchlist as "unavailable" with an explanatory message rather than disappearing.
- **Duplicate/concurrent mutations** — concurrent add/remove requests for the same user serialize through a per-user mutation lock, and concurrent requests for the same ticker share one in-flight market-data fetch instead of issuing duplicate provider calls.

## Product pitch

I built Signal Watch to answer a practical question: what changed in my stocks since I last checked? Instead of ranking the largest percentage moves, it compares each move with the stock's own recent volatility and checks whether volume confirms it. A calm stock moving 1% can matter more than a volatile stock moving 4%. The feed explains each signal in plain language and keeps the full watchlist below it. I designed it for NSE symbols and rupee prices. I chose device-backed server persistence over full login for quicker setup; the trade-off is that watchlists cannot yet merge across devices.
