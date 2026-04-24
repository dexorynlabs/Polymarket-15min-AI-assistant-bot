export function computeEdge({
  modelUp,
  modelDown,
  marketYes,
  marketNo,
  upAnalysis,
  downAnalysis
}) {
  return {
    marketUp: marketYes,
    marketDown: marketNo,
    edgeUp: upAnalysis?.netEdge ?? null,
    edgeDown: downAnalysis?.netEdge ?? null,
    up: {
      modelProb: modelUp,
      marketPrice: marketYes,
      ...upAnalysis
    },
    down: {
      modelProb: modelDown,
      marketPrice: marketNo,
      ...downAnalysis
    }
  };
}

function phaseFromMinutes(remainingMinutes) {
  if (!Number.isFinite(remainingMinutes)) return "UNKNOWN";
  if (remainingMinutes > 10) return "EARLY";
  if (remainingMinutes > 5) return "MID";
  return "LATE";
}

function sortCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const evA = Number.isFinite(a?.netEvUsd) ? a.netEvUsd : Number.NEGATIVE_INFINITY;
    const evB = Number.isFinite(b?.netEvUsd) ? b.netEvUsd : Number.NEGATIVE_INFINITY;
    return evB - evA;
  });
}

export function decide({ remainingMinutes, analysis, cooldownRemainingMs = 0, allowedPhases = ["MID", "LATE"], regime, taDirection }) {
  const phase = phaseFromMinutes(remainingMinutes);

  if (regime === "CHOP") {
    return { action: "NO_TRADE", side: null, phase, reason: "chop_regime", reasons: ["chop_regime"] };
  }

  const allowed = Array.isArray(allowedPhases) ? allowedPhases : ["MID", "LATE"];
  if (!allowed.includes(phase)) {
    return { action: "NO_TRADE", side: null, phase, reason: "phase_not_allowed", reasons: ["phase_not_allowed"] };
  }

  const candidates = [analysis?.up, analysis?.down].filter(Boolean);
  const ranked = sortCandidates(candidates);
  const best = ranked[0] ?? null;

  if (!best) {
    return { action: "NO_TRADE", side: null, phase, reason: "missing_market_data", reasons: ["missing_market_data"] };
  }

  if (cooldownRemainingMs > 0) {
    return {
      action: "NO_TRADE",
      side: null,
      phase,
      reason: "cooldown_active",
      reasons: ["cooldown_active"],
      cooldownRemainingMs
    };
  }

  const tradable = ranked.filter((candidate) => candidate.tradable);
  if (tradable.length === 0) {
    return {
      action: "NO_TRADE",
      side: best.side ?? null,
      phase,
      reason: best.reasons?.[0] ?? "no_viable_candidate",
      reasons: best.reasons ?? []
    };
  }

  const chosen = tradable[0];

  if (taDirection && taDirection !== chosen.side) {
    return {
      action: "NO_TRADE",
      side: chosen.side,
      phase,
      reason: "ta_model_disagreement",
      reasons: ["ta_model_disagreement"]
    };
  }

  const strength = chosen.roi >= 0.2 ? "STRONG" : chosen.roi >= 0.08 ? "GOOD" : "OPTIONAL";

  return {
    action: "ENTER",
    side: chosen.side,
    phase,
    strength,
    reason: "net_ev_positive",
    reasons: [],
    edge: chosen.netEdge,
    netEvUsd: chosen.netEvUsd,
    roi: chosen.roi
  };
}
