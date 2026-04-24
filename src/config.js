function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

const logDir = process.env.LOG_DIR || "./logs";

export const CONFIG = {
  symbol: "BTCUSDT",
  binanceBaseUrl: "https://api.binance.com",
  gammaBaseUrl: "https://gamma-api.polymarket.com",
  clobBaseUrl: "https://clob.polymarket.com",

  pollIntervalMs: 1_000,
  candleWindowMinutes: 15,

  vwapSlopeLookbackMinutes: 5,
  rsiPeriod: 14,
  rsiMaPeriod: 14,

  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,

  polymarket: {
    marketSlug: process.env.POLYMARKET_SLUG || "",
    seriesId: process.env.POLYMARKET_SERIES_ID || "10192",
    seriesSlug: process.env.POLYMARKET_SERIES_SLUG || "btc-up-or-down-15m",
    autoSelectLatest: (process.env.POLYMARKET_AUTO_SELECT_LATEST || "true").toLowerCase() === "true",
    liveDataWsUrl: process.env.POLYMARKET_LIVE_WS_URL || "wss://ws-live-data.polymarket.com",
    upOutcomeLabel: process.env.POLYMARKET_UP_LABEL || "Up",
    downOutcomeLabel: process.env.POLYMARKET_DOWN_LABEL || "Down"
  },

  chainlink: {
    polygonRpcUrls: (process.env.POLYGON_RPC_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonRpcUrl: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    polygonWssUrls: (process.env.POLYGON_WSS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean),
    polygonWssUrl: process.env.POLYGON_WSS_URL || "",
    btcUsdAggregator: process.env.CHAINLINK_BTC_USD_AGGREGATOR || "0xc907E116054Ad103354f2D350FD2514433D57F6f"
  },

  model: {
    realizedVolLookbackMinutes: toNumber(process.env.MODEL_REALIZED_VOL_LOOKBACK_MINUTES, 30),
    driftLookbackMinutes: toNumber(process.env.MODEL_DRIFT_LOOKBACK_MINUTES, 5),
    minVolPctPerMinute: toNumber(process.env.MODEL_MIN_VOL_PCT_PER_MINUTE, 0.00035),
    // Degrees of freedom for the Student-t settlement CDF.
    // Lower = fatter tails (less overconfident on big price gaps).
    // Typical range: 3–6. At ~30 it approximates a normal distribution.
    tailDf: toNumber(process.env.MODEL_TAIL_DF, 4),
    // Weight given to the TA score when blending with the settlement model.
    // 0 = pure model, 1 = pure TA. Recommended: 0.20–0.30.
    taProbWeight: toNumber(process.env.MODEL_TA_PROB_WEIGHT, 0.25)
  },

  kelly: {
    // Set to false to use fixed stake sizes from paper/live config instead.
    enabled: toBoolean(process.env.KELLY_ENABLED, true),
    // Fraction of full-Kelly to apply (0.5 = half-Kelly, safest default).
    fraction: toNumber(process.env.KELLY_FRACTION, 0.5),
    // Minimum stake regardless of Kelly output.
    minStakeUsd: toNumber(process.env.KELLY_MIN_STAKE_USD, 5),
    // Reference bankroll for live trading (USD). Paper trading uses live cash balance.
    liveBankrollUsd: toNumber(process.env.KELLY_LIVE_BANKROLL_USD, 500)
  },

  execution: {
    feeRate: toNumber(process.env.EXECUTION_FEE_RATE, 0.002),
    slippageBps: toNumber(process.env.EXECUTION_SLIPPAGE_BPS, 12),
    maxSpread: toNumber(process.env.EXECUTION_MAX_SPREAD, 0.035),
    minLiquidityShares: toNumber(process.env.EXECUTION_MIN_LIQUIDITY_SHARES, 40),
    minNetEvUsd: toNumber(process.env.EXECUTION_MIN_NET_EV_USD, 0.75),
    maxReferenceAgeMs: toNumber(process.env.EXECUTION_MAX_REFERENCE_AGE_MS, 6_000),
    cooldownMs: toNumber(process.env.EXECUTION_COOLDOWN_MS, 30_000),
    allowedPhases: (process.env.EXECUTION_ALLOWED_PHASES || "MID,LATE").split(",").map((s) => s.trim()).filter(Boolean)
  },

  paper: {
    enabled: toBoolean(process.env.PAPER_TRADING_ENABLED, true),
    startingCash: toNumber(process.env.PAPER_TRADING_STARTING_CASH, 1_000),
    stakeUsd: toNumber(process.env.PAPER_TRADING_STAKE_USD, 25)
  },

  live: {
    enabled:             toBoolean(process.env.LIVE_TRADING_ENABLED, false),
    dryRun:              toBoolean(process.env.LIVE_DRY_RUN, true),
    walletType:          toNumber(process.env.LIVE_WALLET_TYPE, 0),
    proxyWallet:         process.env.LIVE_PROXY_WALLET || null,
    maxStakeUsd:         toNumber(process.env.LIVE_MAX_STAKE_USD, 25),
    useMarketOrder:      toBoolean(process.env.LIVE_USE_MARKET_ORDER, true),
    limitAggressionTicks: toNumber(process.env.LIVE_LIMIT_AGGRESSION_TICKS, 3),
    maxDailyLossUsd:  toNumber(process.env.LIVE_MAX_DAILY_LOSS_USD, 50),
    maxOpenPositions: toNumber(process.env.LIVE_MAX_OPEN_POSITIONS, 1),
    tradesPath:       `${logDir}/live_trades.jsonl`,
    tradesCsvPath:    `${logDir}/live_trades.csv`
  },

  logs: {
    dir: logDir,
    enableSnapshots: toBoolean(process.env.LOG_SNAPSHOTS_ENABLED, true),
    enableResults: toBoolean(process.env.LOG_RESULTS_ENABLED, true),
    enableTrades: toBoolean(process.env.LOG_TRADES_ENABLED, true),
    signalsCsvPath: `${logDir}/signals.csv`,
    snapshotsPath: `${logDir}/snapshots.jsonl`,
    resultsPath: `${logDir}/results.jsonl`,
    tradesPath: `${logDir}/paper_trades.jsonl`,
    tradesCsvPath: `${logDir}/paper_trades.csv`,
    marketDumpDir: `${logDir}/markets`
  }
};
