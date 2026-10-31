// "1H / 4H Block" — port of "1h/4h blocks.pine" (1H / 4H High-Low Confluence Zones).
// Pure OHLCV math, no drawing.
//
// On the first chart bar of each new lower-TF candle (1H) that does not also open a
// higher-TF candle (4H), compare the last CLOSED 1H candle with the last CLOSED 4H
// candle: when their highs (or lows) are within tolerance, open a zone spanning the
// two levels from the 4H candle's start. The new zone extends right; the previous
// zone of that side stops at the new zone's bar.
//
// Pine reads both timeframes through request.security([1], lookahead_on) — closed
// candles only, so nothing repaints. Here both timeframes are resampled from the
// chart's own candles, so the chart timeframe must be <= the lower timeframe.

import type { Candle } from '../core/types'

export interface HlBlocksOptions {
  /** Lower / higher timeframe, seconds. */
  tfLow: number
  tfHigh: number
  tolMode: 'percent' | 'atr'
  /** Tolerance as % of close. */
  tolPct: number
  /** Tolerance as a multiple of the lower timeframe's ATR. */
  tolAtrMult: number
  atrLen: number
  /** Minimum zone height, as a fraction of the tolerance. */
  minHeightF: number
  /** Only one zone per side per higher-TF candle. */
  onePerHigh: boolean
  showHigh: boolean
  showLow: boolean
  /** Zones kept per side; the oldest drop off. */
  maxZones: number
}

export const HL_BLOCKS_DEFAULTS: HlBlocksOptions = {
  tfLow: 3600,
  tfHigh: 14_400,
  tolMode: 'percent',
  tolPct: 0.1,
  tolAtrMult: 0.25,
  atrLen: 14,
  minHeightF: 0.25,
  onePerHigh: true,
  showHigh: true,
  showLow: true,
  maxZones: 50,
}

export interface HlZone {
  side: 'high' | 'low'
  /** Open time of the higher-TF candle the zone comes from (box left). */
  left: number
  /** Chart bar that created the zone. */
  time: number
  /** Time the next zone of this side replaced it; null while it is the active zone (extends right). */
  right: number | null
  top: number
  bottom: number
  /** The two levels that aligned: lower-TF and higher-TF high (or low). */
  lowTfLevel: number
  highTfLevel: number
}

export interface HlBlocksResult {
  zones: HlZone[]
  /** Set when the timeframes can't be evaluated on this chart. */
  error: string | null
}

interface TfBar {
  /** Bucket open time. */
  time: number
  high: number
  low: number
  close: number
  /** False for the first bucket when history starts mid-candle. */
  complete: boolean
}

/** Zone bounds with a minimum visible height (Pine zoneBounds). */
export function zoneBounds(a: number, b: number, tol: number, minHeightF: number): { top: number; bottom: number } {
  let top = Math.max(a, b)
  let bottom = Math.min(a, b)
  const minH = tol * minHeightF
  if (top - bottom < minH) {
    const mid = (top + bottom) / 2
    top = mid + minH / 2
    bottom = mid - minH / 2
  }
  return { top, bottom }
}

export function tfName(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}H`
  return `${Math.floor(s / 86_400)}D`
}

export function computeHlBlocks(bars: Candle[], o: HlBlocksOptions, chartSec: number): HlBlocksResult {
  const label = `${tfName(o.tfLow)} / ${tfName(o.tfHigh)}`
  if (o.tfHigh <= o.tfLow) return { zones: [], error: `${label}: the higher timeframe must be above the lower one` }
  if (chartSec > o.tfLow) return { zones: [], error: `${label}: chart timeframe must be ${tfName(o.tfLow)} or lower` }

  const lowMs = o.tfLow * 1000
  const highMs = o.tfHigh * 1000
  const high: HlZone[] = []
  const low: HlZone[] = []
  let activeHi: HlZone | null = null
  let activeLo: HlZone | null = null
  let usedHiTime = NaN
  let usedLoTime = NaN

  let curL: TfBar | null = null
  let prevL: TfBar | null = null
  let curH: TfBar | null = null
  let prevH: TfBar | null = null
  // ATR of the last closed lower-TF candle (Pine ta.atr: RMA of true range, seeded with the SMA of the first atrLen).
  let atr = NaN
  let trSum = 0
  let trCount = 0

  const closeLow = (b: TfBar, prevClose: number): void => {
    const tr = Number.isFinite(prevClose) ? Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)) : b.high - b.low
    trCount++
    if (trCount < o.atrLen) trSum += tr
    else if (trCount === o.atrLen) atr = (trSum + tr) / o.atrLen
    else atr = (atr * (o.atrLen - 1) + tr) / o.atrLen
  }

  const push = (store: HlZone[], prev: HlZone | null, z: HlZone): HlZone => {
    if (prev) prev.right = z.time
    store.push(z)
    if (store.length > o.maxZones) store.shift()
    return z
  }

  for (const b of bars) {
    const kL = Math.floor(b.time / lowMs)
    const kH = Math.floor(b.time / highMs)
    const newLow = !curL || curL.time !== kL * lowMs
    const newHigh = !curH || curH.time !== kH * highMs

    if (newLow) {
      if (curL) {
        closeLow(curL, prevL ? prevL.close : NaN)
        prevL = curL
      }
      curL = { time: kL * lowMs, high: b.high, low: b.low, close: b.close, complete: curL !== null || b.time === kL * lowMs }
    } else if (curL) {
      curL.high = Math.max(curL.high, b.high)
      curL.low = Math.min(curL.low, b.low)
      curL.close = b.close
    }
    if (newHigh) {
      if (curH) prevH = curH
      curH = { time: kH * highMs, high: b.high, low: b.low, close: b.close, complete: curH !== null || b.time === kH * highMs }
    } else if (curH) {
      curH.high = Math.max(curH.high, b.high)
      curH.low = Math.min(curH.low, b.low)
      curH.close = b.close
    }

    // The lower-TF candle that closes as a new higher-TF candle opens is part of it — skip that bar.
    const checkBar = newLow && !newHigh
    if (!checkBar || !prevL || !prevH || !prevL.complete || !prevH.complete) continue
    const tol = o.tolMode === 'percent' ? (b.close * o.tolPct) / 100 : atr * o.tolAtrMult
    if (!Number.isFinite(tol)) continue

    if (o.showHigh && Math.abs(prevL.high - prevH.high) <= tol && (!o.onePerHigh || prevH.time !== usedHiTime)) {
      const { top, bottom } = zoneBounds(prevL.high, prevH.high, tol, o.minHeightF)
      activeHi = push(high, activeHi, { side: 'high', left: prevH.time, time: b.time, right: null, top, bottom, lowTfLevel: prevL.high, highTfLevel: prevH.high })
      usedHiTime = prevH.time
    }
    if (o.showLow && Math.abs(prevL.low - prevH.low) <= tol && (!o.onePerHigh || prevH.time !== usedLoTime)) {
      const { top, bottom } = zoneBounds(prevL.low, prevH.low, tol, o.minHeightF)
      activeLo = push(low, activeLo, { side: 'low', left: prevH.time, time: b.time, right: null, top, bottom, lowTfLevel: prevL.low, highTfLevel: prevH.low })
      usedLoTime = prevH.time
    }
  }
  return { zones: [...high, ...low], error: null }
}
