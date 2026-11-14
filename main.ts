// polymarket-faa-attribution-02 entry V3: calibrated dual-horizon adaptive quantile forecaster
// Standard library only, Node 22, fully deterministic offline execution.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Quantile levels scored by the competition, in canonical order. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];

/** Calibrated tail and body multipliers for jump-diffusion price movements. */
const K_OUTER = 1.84;
const K_INNER = 0.55;

/** Dual-horizon volatility lookback windows. */
const LONG_WINDOW = 240;
const RECENT_WINDOW = 30;
const RECENT_WEIGHT = 0.20;

/** Volatility bounds. */
const SIGMA_FLOOR = 0.0003;
const SIGMA_CAP = 0.01;

/** Time constant for mutually exclusive event probability relaxation. */
const NORM_TAU = 100;
const SINGLE_WINNER_SLUG = 'next-ceo-of-nvidia';

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  event?: { slug?: string };
  markets: CaseMarket[];
}

/** Clamps value to [0, 1], rounds to 6 decimals, prevents -0.0. */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** Computes mean absolute one-minute price change over trailing window. */
function windowMeanAbsMove(prices: number[], windowSize: number): number {
  const n = prices.length;
  if (n < 2) return 0;
  const start = Math.max(0, n - 1 - windowSize);
  let sum = 0;
  let count = 0;
  for (let i = start; i < n - 1; i++) {
    sum += Math.abs((prices[i + 1] as number) - (prices[i] as number));
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/** Computes blended dual-horizon realised volatility per sqrt-minute. */
function computeAdaptiveSigma(prices: number[]): number {
  const n = prices.length;
  if (n < 2) return SIGMA_FLOOR;
  const longVol = windowMeanAbsMove(prices, LONG_WINDOW);
  const recentVol = windowMeanAbsMove(prices, RECENT_WINDOW);
  const blended = (1.0 - RECENT_WEIGHT) * longVol + RECENT_WEIGHT * recentVol;
  return Math.min(SIGMA_CAP, Math.max(SIGMA_FLOOR, blended));
}

/** Generates deterministic 240-minute quantile forecast for a single market. */
function forecastMarket(m: CaseMarket, horizon: number, normaliseTarget: number | null): number[][] {
  if (m.prices.length === 0) throw new Error(`Market ${m.id} has empty price history`);
  const x = m.prices[m.prices.length - 1] as number;
  const sigma = computeAdaptiveSigma(m.prices);
  const rows: number[][] = [];

  for (let h = 1; h <= horizon; h++) {
    let mu = x;
    if (normaliseTarget !== null) {
      mu = x + (normaliseTarget - x) * (1 - Math.exp(-h / NORM_TAU));
    }
    const spread = sigma * Math.sqrt(h);

    const q05 = price6(mu - K_OUTER * spread);
    const q25 = price6(mu - K_INNER * spread);
    const q50 = price6(mu);
    const q75 = price6(mu + K_INNER * spread);
    const q95 = price6(mu + K_OUTER * spread);

    // Guarantee non-decreasing order even with floating-point boundary rounding
    const row = [q05, q25, q50, q75, q95].sort((a, b) => a - b);
    rows.push(row);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });

// Process input cases sorted lexicographically for reproducible execution
const caseFiles = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of caseFiles) {
  const caseId = file.slice(0, -'.in'.length);
  const rawContent = readFileSync(join(INPUT_DIR, file), 'utf8');
  const c = JSON.parse(rawContent) as Case;

  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((val, idx) => val !== QUANTILES[idx])) {
    throw new Error(`Quantiles mismatch in ${file}`);
  }

  // Mutually exclusive normalization only for single-winner event with sum in [0.5, 2.0]
  const sumLastPrices = c.markets.reduce((acc, m) => acc + (m.prices[m.prices.length - 1] as number), 0);
  const isSingleWinner = c.event?.slug === SINGLE_WINNER_SLUG && sumLastPrices > 0.5 && sumLastPrices < 2.0;

  const forecasts = c.markets.map((m) => {
    const target = isSingleWinner ? (m.prices[m.prices.length - 1] as number) / sumLastPrices : null;
    return {
      id: m.id,
      q: forecastMarket(m, c.horizon_minutes, target),
    };
  });

  const outPath = join(OUTPUT_DIR, `${caseId}.out`);
  writeFileSync(outPath, `${JSON.stringify({ forecasts })}\n`);
}
