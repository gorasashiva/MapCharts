import type { Candle } from '../core/types'

/**
 * Shared, pure math helpers for indicator implementations.
 *
 * Conventions:
 * - All series functions take and return arrays aligned 1:1 with the input
 *   (same length, `null` where a value cannot be computed yet).
 * - No DOM, no side effects.
 */

/** Read an integer param with a fallback default, clamped to a minimum. */
export function intParam(
  params: Record<string, number>,
  key: string,
  fallback: number,
  min = 1,
): number {
  const raw = params[key]
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : fallback
  return Math.max(min, n)
}

/** Read a (possibly fractional) numeric param with a fallback default. */
export function numParam(
  params: Record<string, number>,
  key: string,
  fallback: number,
  min = 0,
): number {
  const raw = params[key]
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
  return Math.max(min, n)
}

/** Extract close prices. */
export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close)
}

/**
 * Simple moving average over a series that may contain nulls.
 * Output[i] is non-null only when the entire trailing window of `period`
 * values is non-null. Uses a sliding sum (O(n)).
 */
export function smaSeries(
  src: ReadonlyArray<number | null>,
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(src.length).fill(null)
  if (period <= 0) return out
  let sum = 0
  let nullsInWindow = 0
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (v === null || v === undefined) nullsInWindow++
    else sum += v
    // Drop the value that just left the window.
    if (i >= period) {
      const old = src[i - period]
      if (old === null || old === undefined) nullsInWindow--
      else sum -= old
    }
    if (i >= period - 1 && nullsInWindow === 0) out[i] = sum / period
  }
  return out
}

/**
 * Exponential moving average with standard SMA seeding: the first output is
 * the SMA of the first `period` non-null values, after which the recursive
 * EMA formula applies. Leading nulls are skipped; if a null appears after the
 * series has started, the EMA state resets (defensive — in practice indicator
 * sources are contiguous once they begin).
 */
export function emaSeries(
  src: ReadonlyArray<number | null>,
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(src.length).fill(null)
  if (period <= 0) return out
  const alpha = 2 / (period + 1)
  let prev: number | null = null
  let seedSum = 0
  let seedCount = 0
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (v === null || v === undefined) {
      // Reset on gaps so we never seed across a discontinuity.
      prev = null
      seedSum = 0
      seedCount = 0
      continue
    }
    if (prev !== null) {
      prev = (v - prev) * alpha + prev
      out[i] = prev
    } else {
      seedSum += v
      seedCount++
      if (seedCount === period) {
        prev = seedSum / period
        out[i] = prev
      }
    }
  }
  return out
}

/**
 * Wilder-smoothed moving average (a.k.a. RMA / SMMA): seeded with the SMA of
 * the first `period` values, then `rma = (prev * (period - 1) + v) / period`.
 * Used by RSI and ATR. Same null semantics as `emaSeries`.
 */
export function wilderSeries(
  src: ReadonlyArray<number | null>,
  period: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(src.length).fill(null)
  if (period <= 0) return out
  let prev: number | null = null
  let seedSum = 0
  let seedCount = 0
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (v === null || v === undefined) {
      prev = null
      seedSum = 0
      seedCount = 0
      continue
    }
    if (prev !== null) {
      prev = (prev * (period - 1) + v) / period
      out[i] = prev
    } else {
      seedSum += v
      seedCount++
      if (seedCount === period) {
        prev = seedSum / period
        out[i] = prev
      }
    }
  }
  return out
}
