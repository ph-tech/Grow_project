# Signal Watch

Signal Watch is a volatility-aware market watchlist for CODE 2026. It makes attention a relative concept: a calm stock moving 1% can be more important than a volatile stock moving 4%.

## Run locally

Requires Node.js 20 or later.

```bash
npm test
npm start
```

Open `http://localhost:3000`. Add NSE symbols such as `RELIANCE.NS`, `TCS.NS`, `INFY.NS`, or `HDFCBANK.NS`; prices are formatted in Indian rupees. The application creates a server-side device session cookie on first use and stores its data in `data/watchlist.json`. No market-data API key is required.

## Engineering decisions

### Meaningful change

For each stock, Signal Watch calculates the standard deviation of its recent daily percentage returns (up to 20 observations, with a 0.25% floor). A current move is meaningful when it is at least **1.25x that stock's normal daily swing**, or at least **0.9x normal with 2x average volume**. The ranked signal score multiplies that relative move by a capped volume-confidence boost. This keeps routine volatility out of the feed while promoting moves with real participation. Each card exposes the raw daily move, its normal-range multiple, volume multiple, score, and a plain-language reason.

### Persistence and sessions

The client stores no watchlist state. On the first request, the server issues an HTTP-only, long-lived device-session cookie and creates a user record. Watchlist entries, provider cache records, and timestamped price snapshots live in the server-side persistence file. A user's last-view timestamp plus the most recent snapshot from that point provides the “since you left” comparison after a later visit. In production, this file maps directly to tables in Postgres (`users`, `watchlist_items`, `market_snapshots`, and `market_cache`); it is deliberately a single-file backend store here to remove setup friction.

### Market data, stale data, and conflicts

Yahoo Finance chart data is the primary source and is cached server-side for 60 seconds. For plain U.S. tickers, Stooq is queried as a secondary cross-check. A discrepancy above 1.5% is visible as a source-conflict health label; the primary price remains displayed because its intraday metadata and history drive the scoring calculation. Provider time is always shown through data health. If a refresh times out, the last cached result is returned with a stale status and error context instead of silently showing it as live. Symbols without enough history, delisted instruments, and no-activity instruments remain in the list as unavailable rather than disappearing.

### Scale and concurrency

The immediate bottleneck is upstream market-data rate limits, not scoring: calculations are linear in a maximum 30 daily points. Server caching means concurrent viewers of the same ticker share one result. Writes serialize through an atomic temp-file rename so simultaneous requests do not corrupt state. A production evolution would replace the in-process cache with Redis, persist snapshots in Postgres, and refresh subscribed symbols in a bounded worker queue rather than fetching per request.

### Time-pressure trade-off

I chose an HTTP-only device identity over full account authentication and a file-backed server store over provisioning Postgres. That preserves the essential cross-visit backend persistence and makes the app runnable in one command, but it does not yet let a user deliberately merge their watchlist across separate devices.

## Product pitch

I built Signal Watch to answer the question I actually have when reopening a watchlist: what deserves my attention now? Instead of rewarding the largest percentage move, it compares each move with that stock’s own recent behavior and uses volume to decide whether the move has conviction. The ranked feed says why a stock rose to the top in plain language, while the latest view keeps the full list available. I used a warm, compact market-desk interface with amber reserved for attention and separate up/down colors. I chose device-backed persistence over full login so the complete flow runs immediately; the trade-off is no intentional cross-device identity merge yet.
