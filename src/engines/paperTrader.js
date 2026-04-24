export function createPaperTradingState({ enabled = true, startingCash = 0 } = {}) {
  return {
    enabled,
    startingCash,
    cash: startingCash,
    realizedPnl: 0,
    tradeCount: 0,
    wins: 0,
    losses: 0,
    lastTradeAtMs: null,
    positions: {}
  };
}

export function getOpenPaperPosition(state, marketSlug) {
  if (!state || !marketSlug) return null;
  return state.positions[marketSlug] ?? null;
}

export function openPaperPosition(state, {
  timestamp,
  marketSlug,
  question,
  side,
  strikePrice,
  entryPrice,
  quotedPrice,
  shares,
  totalCost,
  probability,
  closeTimeMs
}) {
  if (!state?.enabled) return { opened: false, reason: "disabled", position: null, event: null };
  if (!marketSlug || !side || !Number.isFinite(entryPrice) || !Number.isFinite(shares) || !Number.isFinite(totalCost)) {
    return { opened: false, reason: "invalid_order", position: null, event: null };
  }
  if (state.positions[marketSlug]) {
    return { opened: false, reason: "position_exists", position: state.positions[marketSlug], event: null };
  }
  if (state.cash < totalCost) {
    return { opened: false, reason: "insufficient_cash", position: null, event: null };
  }

  const position = {
    marketSlug,
    question: question ?? null,
    side,
    strikePrice: Number.isFinite(strikePrice) ? strikePrice : null,
    entryPrice,
    quotedPrice: Number.isFinite(quotedPrice) ? quotedPrice : null,
    shares,
    totalCost,
    probability: Number.isFinite(probability) ? probability : null,
    closeTimeMs: Number.isFinite(closeTimeMs) ? closeTimeMs : null,
    openedAt: timestamp,
    updatedAt: timestamp,
    markPrice: entryPrice,
    markValue: shares * entryPrice,
    unrealizedPnl: (shares * entryPrice) - totalCost
  };

  state.positions[marketSlug] = position;
  state.cash -= totalCost;
  state.tradeCount += 1;
  state.lastTradeAtMs = Date.parse(timestamp) || Date.now();

  return {
    opened: true,
    reason: "opened",
    position,
    event: {
      timestamp,
      event: "OPEN",
      marketSlug,
      side,
      shares,
      strikePrice: position.strikePrice,
      entryPrice,
      quotedPrice: position.quotedPrice,
      probability: position.probability,
      totalCost,
      cashBalance: state.cash
    }
  };
}

export function markPaperPosition(state, {
  timestamp,
  marketSlug,
  markPrice,
  probability
}) {
  const position = getOpenPaperPosition(state, marketSlug);
  if (!position || !Number.isFinite(markPrice)) return { marked: false, position: null, event: null };

  position.markPrice = markPrice;
  position.markValue = position.shares * markPrice;
  position.unrealizedPnl = position.markValue - position.totalCost;
  position.updatedAt = timestamp;
  if (Number.isFinite(probability)) position.probability = probability;

  return {
    marked: true,
    position,
    event: {
      timestamp,
      event: "MARK",
      marketSlug,
      side: position.side,
      shares: position.shares,
      markPrice,
      probability: position.probability,
      unrealizedPnl: position.unrealizedPnl,
      cashBalance: state.cash
    }
  };
}

export function settlePaperPosition(state, {
  timestamp,
  marketSlug,
  winningSide,
  finalReferencePrice
}) {
  const position = getOpenPaperPosition(state, marketSlug);
  if (!position || !winningSide) return { settled: false, position: null, event: null };

  const payout = position.side === winningSide ? position.shares : 0;
  const realizedPnl = payout - position.totalCost;
  state.cash += payout;
  state.realizedPnl += realizedPnl;
  state.wins += realizedPnl >= 0 ? 1 : 0;
  state.losses += realizedPnl < 0 ? 1 : 0;

  delete state.positions[marketSlug];

  return {
    settled: true,
    position: {
      ...position,
      closedAt: timestamp,
      winningSide,
      finalReferencePrice: Number.isFinite(finalReferencePrice) ? finalReferencePrice : null,
      payout,
      realizedPnl
    },
    event: {
      timestamp,
      event: "SETTLE",
      marketSlug,
      side: position.side,
      winningSide,
      shares: position.shares,
      finalReferencePrice: Number.isFinite(finalReferencePrice) ? finalReferencePrice : null,
      payout,
      realizedPnl,
      cashBalance: state.cash
    }
  };
}

export function summarizePaperTrading(state) {
  const positions = Object.values(state?.positions ?? {});
  const markedValue = positions.reduce((sum, position) => sum + (Number.isFinite(position.markValue) ? position.markValue : 0), 0);
  const unrealizedPnl = positions.reduce((sum, position) => sum + (Number.isFinite(position.unrealizedPnl) ? position.unrealizedPnl : 0), 0);

  return {
    enabled: Boolean(state?.enabled),
    cash: state?.cash ?? 0,
    realizedPnl: state?.realizedPnl ?? 0,
    unrealizedPnl,
    equity: (state?.cash ?? 0) + markedValue,
    openPositions: positions.length,
    tradeCount: state?.tradeCount ?? 0,
    wins: state?.wins ?? 0,
    losses: state?.losses ?? 0
  };
}
