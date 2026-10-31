// The Lab — The Oracle: block-bootstrap simulated futures.
//
// Pure math, no DOM, no React. Powers the Oracle particle storm, the
// percentile probability cones, and the price-target odds readout.
//
// ── STATISTICAL HONESTY ─────────────────────────────────────────────────────
// Every simulated path is stitched together from BLOCKS of this asset's own
// historical log returns, resampled at random (a moving-block bootstrap).
// Nothing is fitted and no distribution is assumed: fat tails, skew and
// short-range volatility clustering survive because real consecutive returns
// are kept together inside each block. The one assumption — and it is a big
// one — is that the future keeps drawing from the same return distribution as
// the loaded past. Regime changes, news, and anything not in the sample are
// invisible to it. The output is an empirical "what histories like this one
// did next", NOT a prediction.
// ────────────────────────────────────────────────────────────────────────────

import type { Candle } from '../core/types'
import type { OracleResult, TargetOdds } from './types'

/** Minimum candles required for honest resampling. */
const MIN_CANDLES = 200

/** How many full paths are copied out for the storm animation. */
const SAMPLE_PATH_COUNT = 120

/**
 * Percentile over an ASCENDING-sorted array, with linear interpolation
 * between ranks (the classic "type 7" estimator: rank = q * (n - 1)).
 */
function percentileSorted(sorted: Float32Array, q: number): number {
  const n = sorted.length
  if (n === 1) return sorted[0]
  const rank = q * (n - 1)
  const lo = Math.floor(rank)
  const hi = lo + 1 < n ? lo + 1 : lo
  const frac = rank - lo
  return sorted[lo] + frac * (sorted[hi] - sorted[lo])
}

/**
 * Simulate `nPaths` futures of `horizon` bars by moving-block bootstrap over
 * the candles' close-to-close log returns.
 *
 * How one path is built: repeatedly pick a uniform random start index into
 * the historical return series and append the next `blockLen` consecutive
 * returns, until `horizon` returns have been collected (the last block is
 * truncated if it would overflow). Blocks are always drawn whole from inside
 * the series (start <= nReturns - blockLen), so short-range autocorrelation
 * and volatility clustering inside each block are real, not synthetic.
 *
 * The value stored at bar offset t+1 (flat index p * horizon + t, per the
 * OracleResult contract) is the cumulative percent change implied by the
 * first t+1 sampled log returns: (exp(sum) - 1) * 100.
 *
 * Cleaning: closes that are non-finite or <= 0 are skipped; a log return is
 * taken between each surviving close and the previous surviving one, so a
 * stray junk candle cannot poison the return pool.
 *
 * Returns null when the simulation would not be honest or is nonsensical:
 * fewer than 200 candles, fewer than `blockLen` clean returns, or
 * horizon/nPaths/blockLen < 1 (all are floored first).
 *
 * Performance: one Float32Array of nPaths*horizon for the ensemble, one
 * nPaths-long scratch column reused (refill + sort) for every offset's
 * percentile band — no per-step allocation. 2000 paths x 96 bars runs well
 * under the 150ms budget; the 96 column sorts are the bulk of the work.
 *
 * Honesty caveat (see module header): the ensemble resamples the loaded
 * history and assumes the future draws from the same distribution. It is an
 * empirical base rate, not a forecast.
 */
export function buildOracle(
  candles: Candle[],
  horizon: number,
  nPaths: number,
  blockLen = 12,
): OracleResult | null {
  horizon = Math.floor(horizon)
  nPaths = Math.floor(nPaths)
  blockLen = Math.floor(blockLen)
  if (horizon < 1 || nPaths < 1 || blockLen < 1) return null
  if (candles.length < MIN_CANDLES) return null

  // Log returns between consecutive valid closes. Sized for the best case;
  // nReturns tracks how many we actually kept.
  const returns = new Float64Array(candles.length - 1)
  let nReturns = 0
  let prev = NaN
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i].close
    if (!Number.isFinite(c) || c <= 0) continue
    if (prev === prev) {
      // prev is a real close (not the initial NaN)
      const r = Math.log(c / prev)
      if (Number.isFinite(r)) returns[nReturns++] = r
    }
    prev = c
  }
  // Too little clean history to draw even one full block.
  if (nReturns < blockLen) return null

  // ── Simulate the ensemble ────────────────────────────────────────────────
  // Every block is drawn whole: start index uniform in [0, nReturns - blockLen].
  const lastStart = nReturns - blockLen
  const pathsPct = new Float32Array(nPaths * horizon)
  for (let p = 0; p < nPaths; p++) {
    const base = p * horizon
    let cum = 0 // running sum of sampled log returns
    let filled = 0
    while (filled < horizon) {
      const start = Math.floor(Math.random() * (lastStart + 1))
      const remaining = horizon - filled
      const take = blockLen < remaining ? blockLen : remaining // truncate overflow
      for (let j = 0; j < take; j++) {
        cum += returns[start + j]
        pathsPct[base + filled] = (Math.exp(cum) - 1) * 100
        filled++
      }
    }
  }

  // ── Percentile bands per bar offset ──────────────────────────────────────
  // One reused scratch column: gather the ensemble at offset t, sort
  // (TypedArray#sort is numeric ascending), interpolate the five percentiles.
  const scratch = new Float32Array(nPaths)
  const bandsPct: OracleResult['bandsPct'] = new Array(horizon)
  for (let t = 0; t < horizon; t++) {
    for (let p = 0; p < nPaths; p++) scratch[p] = pathsPct[p * horizon + t]
    scratch.sort()
    bandsPct[t] = {
      p5: percentileSorted(scratch, 0.05),
      p25: percentileSorted(scratch, 0.25),
      p50: percentileSorted(scratch, 0.5),
      p75: percentileSorted(scratch, 0.75),
      p95: percentileSorted(scratch, 0.95),
    }
  }

  const medianEndPct = bandsPct[horizon - 1].p50

  // ── Animation subsample: ~120 evenly-strided full paths ─────────────────
  const sampleCount = nPaths < SAMPLE_PATH_COUNT ? nPaths : SAMPLE_PATH_COUNT
  const samplePathsPct: number[][] = new Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    const p = Math.floor((i * nPaths) / sampleCount)
    const base = p * horizon
    const row = new Array<number>(horizon)
    for (let t = 0; t < horizon; t++) row[t] = pathsPct[base + t]
    samplePathsPct[i] = row
  }

  return { horizon, nPaths, pathsPct, bandsPct, medianEndPct, samplePathsPct }
}

/**
 * Empirical odds for a percent target over the full ensemble.
 *
 * - `endAbovePct` — % of paths whose FINAL value is strictly above `targetPct`.
 * - `touchPct`    — % of paths that reach the target at ANY bar offset of the
 *   horizon. Direction-aware: for `targetPct >= 0` a path touches when some
 *   offset value is >= the target; for a negative target, when some offset
 *   value is <= it.
 *
 * Both are 0..100 at full precision (round in the UI). A non-finite
 * `targetPct` yields { 0, 0 } (NaN comparisons are all false).
 *
 * These are bootstrap base rates from this asset's own history — how often
 * resampled pasts hit such a target — not a forecast of the actual future.
 */
export function targetOdds(result: OracleResult, targetPct: number): TargetOdds {
  const { horizon, nPaths, pathsPct } = result
  if (nPaths < 1 || horizon < 1) return { endAbovePct: 0, touchPct: 0 }

  const up = targetPct >= 0
  let endAbove = 0
  let touched = 0
  for (let p = 0; p < nPaths; p++) {
    const base = p * horizon
    if (pathsPct[base + horizon - 1] > targetPct) endAbove++
    if (up) {
      for (let t = 0; t < horizon; t++) {
        if (pathsPct[base + t] >= targetPct) {
          touched++
          break
        }
      }
    } else {
      for (let t = 0; t < horizon; t++) {
        if (pathsPct[base + t] <= targetPct) {
          touched++
          break
        }
      }
    }
  }
  return {
    endAbovePct: (endAbove / nPaths) * 100,
    touchPct: (touched / nPaths) * 100,
  }
}

/**
 * % of paths (0..100) whose FINAL value moves at least `|movePct|` in the
 * SAME direction as `movePct`'s sign: for movePct >= 0 a path counts when its
 * final value >= movePct, for negative when final value <= movePct. (A
 * movePct of exactly 0 therefore counts paths ending flat-or-up.) Used for
 * the quick stat chips.
 *
 * Same honesty caveat as the rest of the Oracle: this is the share of
 * bootstrap-resampled histories, not a real-world probability.
 */
export function probabilityAtLeast(result: OracleResult, movePct: number): number {
  const { horizon, nPaths, pathsPct } = result
  if (nPaths < 1 || horizon < 1 || !Number.isFinite(movePct)) return 0

  const last = horizon - 1
  let hits = 0
  if (movePct >= 0) {
    for (let p = 0; p < nPaths; p++) {
      if (pathsPct[p * horizon + last] >= movePct) hits++
    }
  } else {
    for (let p = 0; p < nPaths; p++) {
      if (pathsPct[p * horizon + last] <= movePct) hits++
    }
  }
  return (hits / nPaths) * 100
}
