/**
 * VWAP + EMA Angle confluence — ported from the "VWAP and EMA Angle
 * Confluence" Pine script (v6, shorttitle "VWAP + EMA Angle").
 *
 *   VWAP: anchored (session / week / month / quarter / year), Pine's
 *   ta.vwap(src, newPeriod, 1) with ±stdev or ±% bands (×3 multipliers).
 *   EMA angle: atan(ema − ema[1]) in degrees; > +threshold = BUY, < −threshold
 *   = SELL, otherwise WAIT. Added option: the slope can be measured in ATRs
 *   (atan(Δema / ATR14)) so one threshold works on every symbol — Pine's raw
 *   price slope reads ~90° on BTC and a few degrees on cheap coins.
 *   Confluence: the script's setups from signal × price vs VWAP / bands.
 *
 * Pure maths, no drawing — examples/basic/vwapEmaAngle.ts draws it.
 */
import type { Candle } from '../core/types'
import { computePeriodKeys } from './periodKeys'

export type VeaAnchor = 'session' | 'week' | 'month' | 'quarter' | 'year'
export type VeaSource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4'

export interface VeaOptions {
  anchor: VeaAnchor
  source: VeaSource
  bandsMode: 'stdev' | 'pct'
  mult1: number
  mult2: number
  mult3: number
  emaLength: number
  angleThreshold: number
  /** 'price' = Pine (atan of the raw price change); 'atr' = change measured in ATR(14). */
  angleBasis: 'price' | 'atr'
}

export const VEA_DEFAULTS: VeaOptions = {
  anchor: 'session',
  source: 'hlc3',
  bandsMode: 'stdev',
  mult1: 1,
  mult2: 2,
  mult3: 3,
  emaLength: 25,
  angleThreshold: 10,
  angleBasis: 'price',
}

/** Confluence setups, in the order of the Pine script's branches. */
export const VEA_SETUPS = [
  'Neutral / Consolidation',
  'Overbought Extension (Caution)',
  'Strong Bullish Trend (Long)',
  'Bullish Recovery / Pullback',
  'Bullish Momentum',
  'Oversold Extension (Caution)',
  'Strong Bearish Trend (Short)',
  'Bearish Pullback / Recovery',
  'Bearish Momentum',
  'Bearish Mean Reversion',
  'Bullish Mean Reversion',
  'Consolidation / Range',
] as const

/** The script's colour for each setup (index-aligned with VEA_SETUPS). */
export const VEA_SETUP_COLORS = [
  '#787B86', '#FF9800', '#4CAF50', '#00897B', '#00E676', '#FF9800',
  '#FF5252', '#880E4F', '#FF9800', '#9C27B0', '#2196F3', '#787B86',
]

export interface VeaResult {
  vwap: Float64Array
  /** Band distance for multiplier 1 (stdev or 1% of VWAP); band k = vwap ± dist × mult_k. */
  dist: Float64Array
  ema: Float64Array
  angle: Float64Array
  /** 1 = BUY, -1 = SELL, 0 = WAIT. */
  signal: Int8Array
  setup: Int8Array
  /** True on the first bar of a new VWAP period. */
  newPeriod: Uint8Array
}

export function sourceOf(c: Candle, s: VeaSource): number {
  switch (s) {
    case 'close': return c.close
    case 'open': return c.open
    case 'high': return c.high
    case 'low': return c.low
    case 'hl2': return (c.high + c.low) / 2
    case 'ohlc4': return (c.open + c.high + c.low + c.close) / 4
    default: return (c.high + c.low + c.close) / 3
  }
}

export function computeVwapEmaAngle(candles: Candle[], symbol: string, o: VeaOptions): VeaResult {
  const n = candles.length
  const r: VeaResult = {
    vwap: new Float64Array(n).fill(NaN),
    dist: new Float64Array(n).fill(NaN),
    ema: new Float64Array(n).fill(NaN),
    angle: new Float64Array(n).fill(NaN),
    signal: new Int8Array(n),
    setup: new Int8Array(n),
    newPeriod: new Uint8Array(n),
  }
  if (n === 0) return r
  const keys = computePeriodKeys(candles.map((c) => c.time), symbol)
  const key = o.anchor === 'week' ? keys.week : o.anchor === 'month' ? keys.month : o.anchor === 'quarter' ? keys.quarter : o.anchor === 'year' ? keys.year : keys.day

  // ---- VWAP (Pine ta.vwap with stdev) ----
  let sPV = 0
  let sV = 0
  let sPV2 = 0
  for (let i = 0; i < n; i++) {
    const c = candles[i]
    if (i === 0 || key[i] !== key[i - 1]) {
      r.newPeriod[i] = 1
      sPV = sV = sPV2 = 0
    }
    const src = sourceOf(c, o.source)
    const v = c.volume > 0 ? c.volume : 0
    sPV += src * v
    sV += v
    sPV2 += src * src * v
    const vwap = sV > 0 ? sPV / sV : src
    r.vwap[i] = vwap
    const variance = sV > 0 ? Math.max(0, sPV2 / sV - vwap * vwap) : 0
    r.dist[i] = o.bandsMode === 'stdev' ? Math.sqrt(variance) : vwap * 0.01
  }

  // ---- EMA (Pine ta.ema: seeded with the SMA of the first `len` values) ----
  const len = Math.max(1, Math.round(o.emaLength))
  const alpha = 2 / (len + 1)
  let seed = 0
  for (let i = 0; i < n; i++) {
    const x = candles[i].close
    if (i < len - 1) {
      seed += x
      continue
    }
    if (i === len - 1) r.ema[i] = (seed + x) / len
    else r.ema[i] = alpha * x + (1 - alpha) * r.ema[i - 1]
  }

  // ---- ATR(14), Wilder — only for the ATR angle basis ----
  let atr: Float64Array | null = null
  if (o.angleBasis === 'atr') {
    atr = new Float64Array(n).fill(NaN)
    const p = 14
    let sum = 0
    for (let i = 0; i < n; i++) {
      const c = candles[i]
      const tr = i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))
      if (i < p) {
        sum += tr
        if (i === p - 1) atr[i] = sum / p
      } else atr[i] = (atr[i - 1] * (p - 1) + tr) / p
    }
  }

  // ---- angle, signal, confluence ----
  const th = Math.abs(o.angleThreshold)
  for (let i = 0; i < n; i++) {
    const e = r.ema[i]
    const e1 = i > 0 ? r.ema[i - 1] : NaN
    let slope = e - e1
    if (atr) slope = atr[i] > 0 ? slope / atr[i] : NaN
    const angle = (Math.atan(slope) * 180) / Math.PI
    r.angle[i] = angle
    const sig = angle > th ? 1 : angle < -th ? -1 : 0 // NaN compares false → WAIT, as Pine's na
    r.signal[i] = sig

    const close = candles[i].close
    const vw = r.vwap[i]
    const d = r.dist[i]
    const above = close > vw
    const below = close < vw
    const aboveU1 = close >= vw + d * o.mult1
    const aboveU2 = close >= vw + d * o.mult2
    const belowL1 = close <= vw - d * o.mult1
    const belowL2 = close <= vw - d * o.mult2
    let s: number
    if (sig === 1) s = above ? (aboveU2 ? 1 : 2) : below ? 3 : 4
    else if (sig === -1) s = below ? (belowL2 ? 5 : 6) : above ? 7 : 8
    else s = aboveU1 || aboveU2 ? 9 : belowL1 || belowL2 ? 10 : 11
    r.setup[i] = s
  }
  return r
}
