import { clamp } from "../utils.js";

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

// ─── Student-t CDF (fat-tail model) ──────────────────────────────────────────
// BTC returns exhibit fat tails far beyond what a Gaussian predicts.
// A Student-t distribution with low df (e.g. 4) naturally accounts for this,
// pulling extreme probabilities back toward 0.5 and reducing overconfident signals.

// Lanczos log-gamma (g=7, accurate to ~15 digits)
function lgamma(x) {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  let z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < c.length; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// Regularized incomplete beta I_x(a,b) via Lentz continued fraction.
// Uses symmetry relation when x > (a+1)/(a+b+2) for faster convergence.
function betaIncReg(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - betaIncReg(1 - x, b, a);

  const FPMIN = 1e-30;
  const EPS = 3e-10;
  const MAXIT = 200;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;

  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAXIT; m++) {
    // Even step
    let num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + num * d; if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    h *= d * c;

    // Odd step
    num = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d; if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }

  return front * h;
}

// Student-t CDF: P(T ≤ t) with `df` degrees of freedom.
// Uses the incomplete beta identity: P = I(df/(df+t²), df/2, 1/2) / 2
function studentTCdf(t, df) {
  const x = df / (df + t * t);
  const p = 0.5 * betaIncReg(x, df / 2, 0.5);
  return t >= 0 ? 1 - p : p;
}

export function computeRealizedVolatility(candles, lookbackMinutes = 30) {
  const recent = Array.isArray(candles) ? candles.slice(-(Math.max(lookbackMinutes, 2) + 1)) : [];
  const returns = [];

  for (let i = 1; i < recent.length; i += 1) {
    const prev = Number(recent[i - 1]?.close);
    const cur = Number(recent[i]?.close);
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0 || cur <= 0) continue;
    returns.push(Math.log(cur / prev));
  }

  const sigmaLog1m = stddev(returns);
  const meanReturn1m = mean(returns);

  return {
    lookbackUsed: returns.length,
    sigmaLog1m,
    sigmaPct1m: sigmaLog1m,
    meanReturn1m,
    annualizedVol: sigmaLog1m === null ? null : sigmaLog1m * Math.sqrt(365 * 24 * 60)
  };
}

export function computeDrift(candles, lookbackMinutes = 5) {
  const recent = Array.isArray(candles) ? candles.slice(-(Math.max(lookbackMinutes, 2))) : [];
  if (recent.length < 2) return { driftPctPerMinute: null, totalMovePct: null };

  const first = Number(recent[0]?.close);
  const last = Number(recent[recent.length - 1]?.close);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) {
    return { driftPctPerMinute: null, totalMovePct: null };
  }

  const totalMovePct = (last - first) / first;
  return {
    driftPctPerMinute: totalMovePct / Math.max(recent.length - 1, 1),
    totalMovePct
  };
}

export function computeSettlementProbability({
  currentPrice,
  strikePrice,
  timeLeftMin,
  realizedVol,
  driftPctPerMinute = 0,
  minVolPct = 0.00035,
  tailDf = 4
}) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(strikePrice) || !Number.isFinite(timeLeftMin)) {
    return {
      probUp: null,
      probDown: null,
      projectedMean: null,
      sigmaPrice: null,
      distanceToStrike: null,
      distancePct: null,
      zScore: null
    };
  }

  const effectiveTime = Math.max(timeLeftMin, 0.25);
  const sigmaPct1m = Math.max(realizedVol?.sigmaPct1m ?? 0, minVolPct);
  const projectedMean = currentPrice * (1 + ((driftPctPerMinute ?? 0) * effectiveTime));
  const sigmaPrice = Math.max(currentPrice * sigmaPct1m * Math.sqrt(effectiveTime), currentPrice * minVolPct);
  const distanceToStrike = currentPrice - strikePrice;
  const distancePct = strikePrice !== 0 ? distanceToStrike / strikePrice : null;
  const zScore = sigmaPrice > 0 ? (projectedMean - strikePrice) / sigmaPrice : (projectedMean > strikePrice ? Infinity : -Infinity);

  // Student-t CDF: fat tails mean extreme z-scores are pulled toward 0.5,
  // reducing overconfidence on large-gap situations.
  const df = Number.isFinite(tailDf) && tailDf >= 1 ? tailDf : 4;
  const probUp = clamp(studentTCdf(zScore, df), 0.001, 0.999);

  return {
    probUp,
    probDown: 1 - probUp,
    projectedMean,
    sigmaPrice,
    sigmaPct1m,
    distanceToStrike,
    distancePct,
    zScore
  };
}

export function classifySettlementSide(probUp) {
  if (!Number.isFinite(probUp)) return "NEUTRAL";
  if (probUp > 0.5) return "UP";
  if (probUp < 0.5) return "DOWN";
  return "NEUTRAL";
}
