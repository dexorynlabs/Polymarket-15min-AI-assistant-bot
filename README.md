# Polymarket BTC 15m AI Assistant

A Node.js assistant for Polymarket **“Bitcoin Up or Down”** 15-minute markets. It streams reference prices, scores short-term structure with TA, blends that with a settlement-style probability model, estimates edge after fees and slippage, and can **paper trade** or (optionally) place **live** CLOB orders—with logs and an optional **Next.js dashboard** for paper P&L.

## What it does

- **Market data**: Selects the active 15m BTC market (or a fixed slug), reads UP/DOWN prices, spread, and liquidity from the CLOB.
- **Reference prices**: Polymarket live WebSocket **Chainlink BTC/USD** (same feed as the UI), with fallback to on-chain Chainlink on Polygon (HTTP/WSS RPC), plus Binance spot for context.
- **Indicators**: Heikin Ashi, RSI, MACD, VWAP, short-horizon deltas.
- **Probability & sizing**: Blends TA direction score with a drift/vol settlement model (Student‑t tails), then applies execution-cost filters and optional **Kelly** stake sizing.
- **Trading**: **Paper trading** is on by default. **Live trading** is off by default; enable only after testing, starting with `LIVE_DRY_RUN=true`.
- **Logs**: CSV/JSONL under `LOG_DIR` (default `./logs`) for signals, snapshots, results, and trades.
- **Dashboard** (`web/`): Local UI that reads `logs/paper_trades.jsonl` (or CSV) from the repo—run the bot first so logs exist.

## Requirements

- **Node.js 18+** and npm  
- For live trading: Polygon wallet, USDC on Polymarket, and CLOB API credentials (see below)

## Quick start

```bash
git clone https://github.com/dexorynlabs/Polymarket-15min-AI-assistant-bot.git
cd Polymarket-15min-AI-assistant-bot
cp .env.example .env   # Windows: copy .env.example .env
npm install
npm start
```

Configuration is loaded with **dotenv** from a `.env` file in the project root (optional vars fall back to defaults). See **[`.env.example`](.env.example)** for every variable and comments.

### Optional: web dashboard

From the repo root (installs and runs the `web` app):

```bash
cd web && npm install && cd ..
npm run dashboard
```

Open the URL shown (default Next.js dev server, usually [http://localhost:3000](http://localhost:3000)). The app looks for `logs/paper_trades.jsonl` relative to the repo or `web/`, or set `PAPER_TRADES_JSONL` / `PAPER_TRADES_CSV` if your logs live elsewhere.

### Other npm scripts

| Script | Purpose |
|--------|---------|
| `npm start` | Run the main assistant loop (`src/index.js`) |
| `npm run report` | Summarize logged trades/results (`src/report.js`) |
| `npm run derive-creds` | Derive Polymarket CLOB API credentials from `PRIVATE_KEY` (see `.env.example`) |
| `npm run dashboard` | Start the Next.js dashboard (`web/`) |

### Stop

Press `Ctrl+C` in the terminal.

## Configuration overview

All settings are environment variables. Prefer editing **`.env`**; the table below is a short index—details and defaults are in **`.env.example`**.

### Polymarket

- `POLYMARKET_AUTO_SELECT_LATEST`, `POLYMARKET_SERIES_ID`, `POLYMARKET_SERIES_SLUG`, optional `POLYMARKET_SLUG`
- `POLYMARKET_LIVE_WS_URL` (default `wss://ws-live-data.polymarket.com`)

### Chainlink / Polygon (fallback)

- `POLYGON_RPC_URL`, optional `POLYGON_RPC_URLS`, `POLYGON_WSS_URL`, `POLYGON_WSS_URLS`
- `CHAINLINK_BTC_USD_AGGREGATOR` (default Polygon BTC/USD feed address)

### Model & execution

- `MODEL_*` — lookback, min vol, tail df, TA blend weight (`MODEL_TA_PROB_WEIGHT`)
- `KELLY_*` — enable/fraction/min stake/bankroll for Kelly-based sizing
- `EXECUTION_*` — fees, slippage, spread/liquidity/EV gates, cooldown, allowed time phases (`EARLY` / `MID` / `LATE`)

### Paper & live trading

- `PAPER_TRADING_*` — paper mode, starting cash, fixed stake when Kelly is off
- `LIVE_TRADING_ENABLED`, `LIVE_DRY_RUN`, `PRIVATE_KEY`, `POLY_API_*`, `LIVE_WALLET_TYPE`, `LIVE_PROXY_WALLET`, risk limits (`LIVE_MAX_*`)

### Logging

- `LOG_DIR`, `LOG_SNAPSHOTS_ENABLED`, `LOG_RESULTS_ENABLED`, `LOG_TRADES_ENABLED`

### Proxy

HTTP(S) and SOCKS proxies are supported via standard env vars: `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (see `.env.example`). Usernames/passwords in the URL should be URL-encoded if they contain `@` or `:`.

## Troubleshooting

- **No Chainlink updates**: Polymarket WS may be quiet; the bot falls back to Polygon RPC. Set at least one reliable `POLYGON_RPC_URL` (or list in `POLYGON_RPC_URLS`).
- **Console flicker**: The TUI uses cursor moves and clear; some terminals render that differently.
- **Dashboard empty**: Run `npm start` with paper trading enabled so `logs/paper_trades.jsonl` is created, or point env vars at your log paths.

## Update to latest

```bash
git pull
npm install
cd web && npm install && cd ..
```

## Safety

This is **not** financial advice. Live trading risks loss of funds. Test thoroughly with paper mode and `LIVE_DRY_RUN=true` before real orders.

## Contact

📱 **Telegram**: [t.me/dexoryn_here](https://t.me/dexoryn_here) | 🎮 **Discord**: `.dexoryn`

---

**[DexorynLabs](https://github.com/dexorynlabs)** — made by **Dexoryn**. Repository: [dexorynlabs/Polymarket-15min-AI-assistant-bot](https://github.com/dexorynlabs/Polymarket-15min-AI-assistant-bot).
