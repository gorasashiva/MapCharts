// The Lab — Market Clock statistics.
//
// Pure math, no DOM, no React. Buckets candles by UTC hour-of-day and UTC
// weekday to reveal *when* a market tends to move: which hours are volatile,
// which lean up or down, and where the volume concentrates.

import type { Candle } from '../core/types'
import type { ClockBucket, MarketClockStats } from './types'

const HOURS = 24
const WEEKDAYS = 7

/**
 * Compute Market Clock statistics over a candle series.
 *
 * Every candle is assigned to two buckets keyed by its OPEN time:
 *   - UTC hour of day  (`new Date(time).getUTCHours()`, 0..23)
 *   - UTC weekday      (`new Date(time).getUTCDay()`,  0 = Sunday)
 *
 * Per bucket (see ClockBucket):
 *   - meanAbsReturnPct — mean of |close/open - 1| * 100 (a volatility proxy)
 *   - meanReturnPct    — signed mean of (close/open - 1) * 100 (directional lean)
 *   - meanVolume       — mean base-asset volume
 *   - samples          — number of candles aggregated into the bucket
 *
 * Empty buckets are all zeros with samples 0, so consumers can render a full
 * 24-hour / 7-day grid without guards.
 *
 * Numerical safety: candles with a non-finite time/open/close/volume or a
 * zero open are skipped entirely (not counted in `samples`) — a single junk
 * candle must not poison a bucket's means. `candleCount` still reports the
 * raw input length; `fromTime`/`toTime` are the min/max open times present
 * (0 when the input is empty).
 *
 * Intended input is ~90 days of 1h candles, but any interval works: each
 * candle simply lands in the bucket of its open time.
 */
export function computeMarketClock(candles: Candle[]): MarketClockStats {
  // Flat accumulators: [abs-return sum, signed-return sum, volume sum, count]
  const hourAbs = new Float64Array(HOURS)
  const hourSigned = new Float64Array(HOURS)
  const hourVol = new Float64Array(HOURS)
  const hourCount = new Int32Array(HOURS)

  const dayAbs = new Float64Array(WEEKDAYS)
  const daySigned = new Float64Array(WEEKDAYS)
  const dayVol = new Float64Array(WEEKDAYS)
  const dayCount = new Int32Array(WEEKDAYS)

  let fromTime = Infinity
  let toTime = -Infinity

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    if (
      !Number.isFinite(c.time) ||
      !Number.isFinite(c.open) ||
      !Number.isFinite(c.close) ||
      !Number.isFinite(c.volume) ||
      c.open === 0
    ) {
      continue // junk candle: keep it out of every bucket
    }

    if (c.time < fromTime) fromTime = c.time
    if (c.time > toTime) toTime = c.time

    const d = new Date(c.time)
    const hour = d.getUTCHours()
    const weekday = d.getUTCDay()

    const returnPct = (c.close / c.open - 1) * 100
    const absReturnPct = Math.abs(returnPct)

    hourAbs[hour] += absReturnPct
    hourSigned[hour] += returnPct
    hourVol[hour] += c.volume
    hourCount[hour]++

    dayAbs[weekday] += absReturnPct
    daySigned[weekday] += returnPct
    dayVol[weekday] += c.volume
    dayCount[weekday]++
  }

  const toBucket = (abs: number, signed: number, vol: number, count: number): ClockBucket =>
    count > 0
      ? {
          meanAbsReturnPct: abs / count,
          meanReturnPct: signed / count,
          meanVolume: vol / count,
          samples: count,
        }
      : { meanAbsReturnPct: 0, meanReturnPct: 0, meanVolume: 0, samples: 0 }

  const byHourUtc: ClockBucket[] = new Array(HOURS)
  for (let h = 0; h < HOURS; h++) {
    byHourUtc[h] = toBucket(hourAbs[h], hourSigned[h], hourVol[h], hourCount[h])
  }

  const byWeekdayUtc: ClockBucket[] = new Array(WEEKDAYS)
  for (let w = 0; w < WEEKDAYS; w++) {
    byWeekdayUtc[w] = toBucket(dayAbs[w], daySigned[w], dayVol[w], dayCount[w])
  }

  return {
    byHourUtc,
    byWeekdayUtc,
    candleCount: candles.length,
    fromTime: Number.isFinite(fromTime) ? fromTime : 0,
    toTime: Number.isFinite(toTime) ? toTime : 0,
  }
}
