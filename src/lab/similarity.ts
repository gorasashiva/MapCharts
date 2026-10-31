// The Lab — pattern-similarity core.
//
// Pure math, no DOM, no React. This module powers two Lab features:
//   1. "Echoes"        — find historical windows that look like the most
//                        recent price action and study what happened next.
//   2. "Sketch Search" — the user draws a freehand shape; we resample it to a
//                        clean series and search history for lookalikes.
//
// All similarity is computed on z-normalized series (shape, not scale), using
// plain euclidean distance. Everything is written with flat loops and
// preallocated typed arrays so a 50k-candle history scans in milliseconds.

import type { Candle } from '../core/types'
import type { EchoResult, EchoScan, EchoStats, SimilarityMatch } from './types'

/**
 * Z-normalize a series: (v - mean) / std, using the population standard
 * deviation. This removes level and scale so only the *shape* remains, which
 * is what makes euclidean distance meaningful across different price regimes.
 *
 * Degenerate inputs are handled deterministically: if the std is zero (a flat
 * series) or not finite (empty input, NaN/Infinity values), every output is 0.
 */
export function zNormalize(values: number[]): number[] {
  const n = values.length
  const out = new Array<number>(n)
  if (n === 0) return out

  let sum = 0
  for (let i = 0; i < n; i++) sum += values[i]
  const mean = sum / n

  let varSum = 0
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean
    varSum += d * d
  }
  const std = Math.sqrt(varSum / n)

  if (!(std > 0) || !Number.isFinite(std) || !Number.isFinite(mean)) {
    // Flat or degenerate series -> all zeros (spec: std 0 -> all zeros).
    for (let i = 0; i < n; i++) out[i] = 0
    return out
  }

  const inv = 1 / std
  for (let i = 0; i < n; i++) out[i] = (values[i] - mean) * inv
  return out
}

/**
 * Slide a `query.length` window over `haystackCloses` (stride 1) and return
 * the k most similar windows by z-normalized euclidean distance, best first.
 *
 * Options:
 * - `k`           — maximum number of matches to return.
 * - `minGap`      — greedy non-overlap: a candidate is taken only if its start
 *                   index is at least `minGap` bars away from the start of
 *                   every already-taken window. Defaults to `query.length`
 *                   (i.e. no two matches overlap at all).
 * - `excludeTail` — skip any window whose END index falls within the last
 *                   `excludeTail` indices of the haystack (default 0). Used so
 *                   "now" never matches itself, and so every match has room
 *                   left for an aftermath.
 *
 * Performance: O(n * m) with plain loops. Per-window mean/variance come from
 * rolling sums (refreshed exactly every 1024 windows to kill floating-point
 * drift), and the normalized window is never materialized — each element is
 * normalized on the fly inside the distance loop. The only allocations are a
 * few preallocated arrays sized by the haystack.
 *
 * Numerical safety: windows containing non-finite values get distance
 * Infinity and are never selected. A flat window (std 0) z-normalizes to all
 * zeros, consistent with `zNormalize`. Returns [] if the query is shorter
 * than 2, contains non-finite values, or no window fits.
 */
export function findSimilar(
  haystackCloses: number[],
  query: number[],
  opts: { k: number; minGap?: number; excludeTail?: number },
): SimilarityMatch[] {
  const m = query.length
  const n = haystackCloses.length
  const k = Math.floor(opts.k)
  const minGap = Math.max(1, Math.floor(opts.minGap ?? m))
  const excludeTail = Math.max(0, Math.floor(opts.excludeTail ?? 0))

  if (k < 1 || m < 2) return []

  // A window starting at s covers [s, s + m - 1]; its end must avoid the last
  // `excludeTail` indices, i.e. end <= n - excludeTail - 1.
  const lastStart = n - excludeTail - m
  if (lastStart < 0) return []
  const numWindows = lastStart + 1

  // Normalize the query once. If it is degenerate (NaN/Infinity) there is
  // nothing meaningful to match against.
  const zq = zNormalize(query)
  for (let j = 0; j < m; j++) {
    if (!Number.isFinite(zq[j])) return []
  }

  // Sanitize the haystack once: copy into a typed array (fast indexed access)
  // and build a prefix count of non-finite values so any window touching bad
  // data can be rejected in O(1). Bad values are stored as 0 so the rolling
  // sums stay finite; those windows are excluded anyway.
  const clean = new Float64Array(n)
  const badPrefix = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) {
    const v = haystackCloses[i]
    if (Number.isFinite(v)) {
      clean[i] = v
      badPrefix[i + 1] = badPrefix[i]
    } else {
      clean[i] = 0
      badPrefix[i + 1] = badPrefix[i] + 1
    }
  }

  const distances = new Float64Array(numWindows)

  // Rolling window sums. Refreshed exactly every REFRESH windows so drift
  // from repeated add/subtract can never accumulate meaningfully.
  const REFRESH = 1024
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < m; i++) {
    const v = clean[i]
    sum += v
    sumSq += v * v
  }

  for (let s = 0; s < numWindows; s++) {
    if (s > 0) {
      if (s % REFRESH === 0) {
        sum = 0
        sumSq = 0
        for (let i = 0; i < m; i++) {
          const v = clean[s + i]
          sum += v
          sumSq += v * v
        }
      } else {
        const outgoing = clean[s - 1]
        const incoming = clean[s + m - 1]
        sum += incoming - outgoing
        sumSq += incoming * incoming - outgoing * outgoing
      }
    }

    // Window touching non-finite source data can never match.
    if (badPrefix[s + m] - badPrefix[s] > 0) {
      distances[s] = Infinity
      continue
    }

    const mean = sum / m
    let variance = sumSq / m - mean * mean
    if (variance < 0) variance = 0 // clamp tiny negative rounding artifacts
    const std = Math.sqrt(variance)

    let d2 = 0
    if (std > 0) {
      const inv = 1 / std
      for (let j = 0; j < m; j++) {
        const diff = (clean[s + j] - mean) * inv - zq[j]
        d2 += diff * diff
      }
    } else {
      // Flat window -> z-normalized form is all zeros.
      for (let j = 0; j < m; j++) d2 += zq[j] * zq[j]
    }
    distances[s] = Number.isFinite(d2) ? Math.sqrt(d2) : Infinity
  }

  // Rank every window by distance. The comparator never returns NaN
  // (Infinity vs Infinity compares equal), keeping the order total.
  const order = new Array<number>(numWindows)
  for (let i = 0; i < numWindows; i++) order[i] = i
  order.sort((a, b) => {
    const da = distances[a]
    const db = distances[b]
    if (da === db) return 0
    return da < db ? -1 : 1
  })

  // Greedy selection, best-distance first, honoring minGap between starts.
  const picked: SimilarityMatch[] = []
  const takenStarts: number[] = []
  for (let i = 0; i < numWindows && picked.length < k; i++) {
    const s = order[i]
    const d = distances[s]
    if (!Number.isFinite(d)) break // Infinity sorts last; nothing usable remains
    let ok = true
    for (let t = 0; t < takenStarts.length; t++) {
      if (Math.abs(s - takenStarts[t]) < minGap) {
        ok = false
        break
      }
    }
    if (!ok) continue
    takenStarts.push(s)
    picked.push({ startIndex: s, endIndex: s + m - 1, distance: d })
  }
  return picked
}

/**
 * Build a full "Echoes" scan: take the last `windowLen` closes as the query,
 * find up to `k` similar historical windows, and record what the market did
 * over the `horizon` bars following each match.
 *
 * - Search excludes the tail (`excludeTail = windowLen + horizon`) so the
 *   query never matches itself and every match has a full aftermath available
 *   in principle; matches are also non-overlapping (`minGap = windowLen`).
 * - `aftermathPct[off-1]` = (close[end+off] / close[end] - 1) * 100 for
 *   off = 1..horizon; the whole array is null if it would run past the end of
 *   history or the base close is zero / non-finite.
 * - `stats` aggregates only results with a non-null aftermath; with zero such
 *   results the median/best/worst are 0 with count 0.
 * - `queryClosePct` is the query window expressed as % change from its first
 *   close, ready for sparkline rendering.
 *
 * Returns null when there is not enough history to be meaningful
 * (fewer than `windowLen * 3` candles) or the parameters are nonsensical
 * (windowLen < 2, horizon < 1, k < 1).
 */
export function buildEchoScan(
  candles: Candle[],
  windowLen: number,
  horizon: number,
  k: number,
): EchoScan | null {
  if (windowLen < 2 || horizon < 1 || k < 1) return null
  const n = candles.length
  if (n < windowLen * 3) return null

  const closes = new Array<number>(n)
  for (let i = 0; i < n; i++) closes[i] = candles[i].close

  // Raw query slice; findSimilar z-normalizes both sides internally.
  const query = closes.slice(n - windowLen)

  const matches = findSimilar(closes, query, {
    k,
    minGap: windowLen,
    excludeTail: windowLen + horizon,
  })

  const results: EchoResult[] = []
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const end = match.endIndex
    const base = closes[end]

    let aftermathPct: number[] | null = null
    if (end + horizon < n && Number.isFinite(base) && base !== 0) {
      const arr = new Array<number>(horizon)
      let valid = true
      for (let off = 1; off <= horizon; off++) {
        const pct = (closes[end + off] / base - 1) * 100
        if (!Number.isFinite(pct)) {
          valid = false
          break
        }
        arr[off - 1] = pct
      }
      if (valid) aftermathPct = arr
    }

    results.push({ match, matchTime: candles[end].time, aftermathPct })
  }

  // Outcome stats over echoes that have a complete aftermath.
  const endPcts: number[] = []
  let upCount = 0
  for (let i = 0; i < results.length; i++) {
    const aftermath = results[i].aftermathPct
    if (aftermath === null) continue
    const endPct = aftermath[horizon - 1]
    endPcts.push(endPct)
    if (endPct > 0) upCount++
  }
  endPcts.sort((a, b) => a - b)
  const count = endPcts.length

  let medianEndPct = 0
  if (count > 0) {
    const mid = count >> 1
    medianEndPct = count % 2 === 1 ? endPcts[mid] : (endPcts[mid - 1] + endPcts[mid]) / 2
  }

  const stats: EchoStats = {
    count,
    upCount,
    medianEndPct,
    bestEndPct: count > 0 ? endPcts[count - 1] : 0,
    worstEndPct: count > 0 ? endPcts[0] : 0,
    horizon,
  }

  // Query window as % change from its first close (for sparklines).
  const first = query[0]
  const queryClosePct = new Array<number>(windowLen)
  const firstOk = Number.isFinite(first) && first !== 0
  for (let i = 0; i < windowLen; i++) {
    if (firstOk) {
      const pct = (query[i] / first - 1) * 100
      queryClosePct[i] = Number.isFinite(pct) ? pct : 0
    } else {
      queryClosePct[i] = 0
    }
  }

  return { windowLen, horizon, results, stats, queryClosePct }
}

/**
 * Convert a freehand mouse stroke into a clean series of `n` values suitable
 * as a `findSimilar` query.
 *
 * Steps:
 * 1. Clean to be x-monotonic: when the stroke revisits an x (duplicate or
 *    backtracking), the LATEST point at that x wins; points are then ordered
 *    by ascending x. Non-finite points are dropped. This also makes strokes
 *    drawn right-to-left work naturally.
 * 2. Sample `n` evenly spaced x positions across [minX, maxX] and linearly
 *    interpolate y between the surrounding stroke points.
 * 3. INVERT y (canvas y grows downward; price grows upward) and return the
 *    raw values — the caller z-normalizes via `findSimilar`, so only the
 *    shape matters.
 *
 * Throws if fewer than 2 distinct (finite) x positions remain, or if n < 2.
 */
export function resampleStroke(points: { x: number; y: number }[], n: number): number[] {
  if (!Number.isInteger(n) || n < 2) {
    throw new Error(`resampleStroke: n must be an integer >= 2 (got ${n})`)
  }

  // Latest point wins per x. Map insertion order is irrelevant here because
  // we sort the distinct x values afterwards.
  const latestYByX = new Map<number, number>()
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (Number.isFinite(p.x) && Number.isFinite(p.y)) latestYByX.set(p.x, p.y)
  }
  if (latestYByX.size < 2) {
    throw new Error('resampleStroke: need at least 2 points with distinct x')
  }

  const m = latestYByX.size
  const xs = new Float64Array(m)
  let w = 0
  for (const x of latestYByX.keys()) xs[w++] = x
  xs.sort()
  const ys = new Float64Array(m)
  for (let i = 0; i < m; i++) ys[i] = latestYByX.get(xs[i]) as number

  const minX = xs[0]
  const maxX = xs[m - 1]
  const span = maxX - minX // > 0: at least 2 distinct finite x values

  const out = new Array<number>(n)
  let seg = 0 // index of the segment [xs[seg], xs[seg+1]] containing the sample
  for (let i = 0; i < n; i++) {
    const x = minX + (span * i) / (n - 1)
    while (seg < m - 2 && xs[seg + 1] < x) seg++
    const x0 = xs[seg]
    const x1 = xs[seg + 1]
    let t = (x - x0) / (x1 - x0) // x1 > x0 guaranteed (strictly increasing xs)
    if (t < 0) t = 0
    if (t > 1) t = 1
    const y = ys[seg] + t * (ys[seg + 1] - ys[seg])
    out[i] = -y // canvas-y down -> price-up
  }
  return out
}
