import type { Candle } from '../core/types'
import type { IndicatorDef, IndicatorOutput } from './types'

/** Per-indicator cache entry for computeIndicatorIncremental(). */
export interface IndicatorCacheEntry {
  candlesRef: Candle[]
  candlesLen: number
  paramsKey: string
  outputs: IndicatorOutput[]
  /**
   * Set once a trailing-slice recompute failed to reproduce the cached history
   * (a running total such as VWAP / OBV / CVD, or any stateful custom logic):
   * that indicator is recomputed in full from then on.
   */
  nonIncremental?: boolean
}

/**
 * How many trailing bars are enough to re-seed an indicator's recurrence
 * (EMA/Wilder-style smoothing) so a warm-up-only recompute converges to the
 * same value a full-history recompute would produce. Generously sized (10x
 * the largest configured param, floor 50).
 */
export function warmupBars(def: IndicatorDef, params: Record<string, number>): number {
  let maxParam = 20
  for (const p of def.params) {
    const v = params[p.key] ?? p.default
    if (typeof v === 'number' && v > maxParam) maxParam = v
  }
  return Math.max(50, Math.round(maxParam * 10))
}

/** Same value for the splice check: both null, or equal within a relative 1e-6. */
function sameValue(a: number | null | undefined, b: number | null | undefined): boolean {
  const an = a == null || !isFinite(a)
  const bn = b == null || !isFinite(b)
  if (an || bn) return an && bn
  return Math.abs((a as number) - (b as number)) <= 1e-6 * Math.max(1, Math.abs(a as number), Math.abs(b as number))
}

/**
 * Indicator recompute, incrementalized. `def.compute()` is always a full pass
 * over the candles it's given; on a live tick only the LAST candle changed
 * (candles are mutated in place, and replaced wholesale on reload), so we can
 * recompute a warm-up-padded trailing slice and splice its tail onto the
 * cached prefix instead of re-running the whole history every frame.
 *
 * That is only valid for indicators whose value converges from recent bars
 * (moving averages, RSI…). Running totals — VWAP, OBV, CVD — restart from the
 * slice's first bar, which bent VWAP toward the latest candles and shifted
 * OBV / CVD. So each splice is verified: the slice must reproduce the cached
 * value of the last unchanged bar. If it doesn't, the indicator is marked
 * non-incremental and recomputed in full from then on (still correct, just
 * the pre-optimisation cost).
 *
 * `fullHistory` forces a full recompute (indicators that scan the whole
 * history to pick their current output).
 */
export function computeIndicatorIncremental(
  cache: Map<string, IndicatorCacheEntry>,
  key: string,
  candles: Candle[],
  def: IndicatorDef,
  params: Record<string, number>,
  fullHistory = false,
): IndicatorOutput[] {
  const paramsKey = JSON.stringify(params)
  const cached = cache.get(key)
  const n = candles.length
  const nonIncremental = cached?.paramsKey === paramsKey && cached?.nonIncremental === true
  if (
    cached &&
    !nonIncremental &&
    !fullHistory &&
    cached.candlesRef === candles &&
    cached.paramsKey === paramsKey &&
    cached.candlesLen > 1 &&
    cached.candlesLen <= n
  ) {
    const keepCount = cached.candlesLen - 1 // indices before this are immutable history
    const sliceStart = Math.max(0, keepCount - warmupBars(def, params))
    const sliceOutputs = def.compute(candles.slice(sliceStart), params)
    const skip = keepCount - sliceStart
    // A custom indicator could return a different output count for a shorter
    // slice — and any indicator whose slice doesn't reproduce the last cached
    // (unchanged) bar isn't safe to splice. Both fall through to a full pass.
    const reproduces =
      sliceOutputs.length === cached.outputs.length &&
      skip >= 1 &&
      cached.outputs.every((out, oi) => sameValue(out.values[keepCount - 1], sliceOutputs[oi].values[skip - 1]))
    if (reproduces) {
      const merged = cached.outputs.map((out, oi) => {
        const values = out.values.slice(0, keepCount).concat(sliceOutputs[oi].values.slice(skip))
        const sliceBreaks = sliceOutputs[oi].breaks
        if (!out.breaks && !sliceBreaks) return { ...out, values }
        // Line breaks: keep the cached ones in the immutable prefix, take the slice's from the splice point on.
        const breaks = [...(out.breaks ?? []).filter((b) => b < keepCount), ...(sliceBreaks ?? []).map((b) => b + sliceStart).filter((b) => b >= keepCount)]
        return { ...out, values, breaks }
      })
      cache.set(key, { candlesRef: candles, candlesLen: n, paramsKey, outputs: merged })
      return merged
    }
    const full = def.compute(candles, params)
    cache.set(key, { candlesRef: candles, candlesLen: n, paramsKey, outputs: full, nonIncremental: true })
    return full
  }
  const full = def.compute(candles, params)
  cache.set(key, { candlesRef: candles, candlesLen: n, paramsKey, outputs: full, nonIncremental })
  return full
}
