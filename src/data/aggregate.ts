import type { Candle, Interval } from '../core/types'
import { INTERVAL_MS } from '../core/types'

/**
 * Roll a base candle series UP into coarser fixed-time buckets.
 *
 * Every CandL interval is an integer multiple of every smaller one, so a single
 * base series (ideally 1-second) can be aggregated into any larger timeframe:
 * open = first bar's open, high = max, low = min, close = last bar's close,
 * volume = sum.
 *
 * `base` must be ascending by time, and `bucketMs` must be a multiple of the
 * base interval so each base candle falls cleanly inside one bucket. Buckets are
 * aligned to the epoch (`floor(time / bucketMs) * bucketMs`), which is exact for
 * sub-minute frames (15s/30s align to minute boundaries). For daily/weekly bars,
 * prefer the exchange's own bars instead — epoch-aligned weeks start on a
 * Thursday and won't match the exchange's session boundaries.
 */
export function aggregateCandles(base: Candle[], bucketMs: number): Candle[] {
  if (bucketMs <= 0) throw new Error(`aggregateCandles: bucketMs must be > 0, got ${bucketMs}`)
  const out: Candle[] = []
  let cur: Candle | null = null
  for (const c of base) {
    const start = Math.floor(c.time / bucketMs) * bucketMs
    if (cur === null || start !== cur.time) {
      cur = { time: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, buyVolume: c.buyVolume, tradeCount: c.tradeCount }
      out.push(cur)
    } else {
      if (c.high > cur.high) cur.high = c.high
      if (c.low < cur.low) cur.low = c.low
      cur.close = c.close
      cur.volume += c.volume
      if (c.buyVolume !== undefined) cur.buyVolume = (cur.buyVolume ?? 0) + c.buyVolume
      if (c.tradeCount !== undefined) cur.tradeCount = (cur.tradeCount ?? 0) + c.tradeCount
    }
  }
  return out
}

/** Convenience wrapper: aggregate a base series into a named CandL interval. */
export function rollupToInterval(base: Candle[], interval: Interval): Candle[] {
  return aggregateCandles(base, INTERVAL_MS[interval])
}
