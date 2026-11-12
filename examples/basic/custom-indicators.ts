// Demo-side custom indicators, registered alongside the library's built-ins.
//
// The library has no Pine Script runtime — but its indicator model is just a
// pure `compute(candles, params) => IndicatorOutput[]` function, so porting a
// Pine indicator is a direct translation. This file ports the *plottable* part
// of "CHOTA pandit V3" (customindicator.pine): the EMA-basis Bollinger bands
// plus the EMA-7/EMA-53 overlays.
//
// NOT ported (the library plots series only — it has no strategy/label engine):
//   • strategy.entry / strategy.close / strategy.cancel  (backtest orders)
//   • label.new BUY / SELL markers
//   • fill(p1, p2)  (shaded band between upper & lower)
//   • input(close, "Source")  — params are numeric, so source is fixed to close.
import { INDICATORS, getIndicator, type Candle, type IndicatorDef, type IndicatorOutput } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { parabolicSar } from '../../src/overlays/parabolicSar'
import type { StrategyTrade } from '../../src/strategy/types'
import { shankyCombo, computeShankyModel, drawShankyCombo, type CanvasIndicatorContext, type ShankyModel } from './shankyCombo'
import { zigzagFib, computeZigzagFibModel, drawZigzagFib, type ZigzagFibModel } from './zigzagFib'
import { sessionReversal, computeSessionReversalModel, drawSessionReversal, type SessionReversalModel } from './sessionReversal'
import { rangeBreakout, computeRangeBreakoutModel, drawRangeBreakout, rangeBreakoutTrades, type RangeBreakoutModel } from './rangeBreakout'
import { sessionsIndicator, computeSessionsModel, drawSessions, type SessionsModel } from './sessions'
import { sessionsV2Indicator, computeSessionsV2Model, drawSessionsV2, type SessionsV2Model } from './sessionsV2'
import { marketStructure, computeMarketStructureModel, drawMarketStructure, marketStructureTrades, type MarketStructureModel } from './marketStructure'
import { theMap, computeTheMapModel, drawTheMap, type TheMapModel } from './theMap'
import { theMapV2, computeTheMapV2Model, drawTheMapV2, type TheMapV2Model } from './theMapV2'
import { theMapV3, computeTheMapV3Model, drawTheMapV3, mapV3StrategyTrades, type TheMapV3Model } from './theMapV3'
import { gexSabers, computeGexSabersModel, drawGexSabers, type GexSabersModel } from './gexSabers'
import {
  gexSummary,
  gexHeatmap,
  gexProfileSplit,
  computeGexSummaryModel,
  drawGexSummary,
  computeGexHeatmapModel,
  drawGexHeatmap,
  computeGexProfileModel,
  drawGexProfileSplit,
  type GexSummaryModel,
  type GexHeatmapModel,
  type GexProfileModel,
} from './gexDeep'
import { renkoFade, computeRenkoFadeModel, drawRenkoFade, renkoFadeTrades, type RenkoFadeModel } from './renkoFade'
import { mtfCisd, computeMtfCisdModel, drawMtfCisd, type MtfCisdModel } from './mtfCisd'
import { hlBlocks, computeHlBlocksModel, drawHlBlocks, type HlBlocksModel } from './hlBlocks'
import { aiTrades, computeAiTradesModel, drawAiTrades, type AiTradesModel } from './aiTrades'
import { bulbArrow, computeBulbArrowModel, drawBulbArrow, type BulbArrowModel } from './bulbArrow'
import { flyingCpr, computeFlyingCprModel, drawFlyingCpr, type FlyingCprModel } from './flyingCpr'
import { tpoFade, computeTpoFadeModel, drawTpoFade, tpoFadeTrades, type TpoFadeModel } from './tpoFade'
import { tpoTv, computeTpoTvModel, drawTpoTv, type TpoTvModel } from './tpoTv'
import { fvgMid, computeFvgMidModel, drawFvgMid, type FvgMidModel } from './fvgMid'
import { vwapEmaAngle, computeVwapEmaAngleModel, drawVwapEmaAngle, type VwapEmaAngleModel } from './vwapEmaAngle'
import { dcCprBb, computeDcCprBbModel, drawDcCprBb, type DcCprBbModel } from './dcCprBb'
import { nyFade, computeNyFadeModel, drawNyFade, nyFadeTrades, type NyFadeModel } from './nyFade'
import { computeVortex } from '../../src/overlays/vortexModel'

// ---- Pine-style helpers (ta.*) ----

/** ta.ema(src, length): recursive EMA seeded with the first value (Pine semantics). */
function ema(values: number[], length: number): (number | null)[] {
  const alpha = 2 / (length + 1)
  const out: (number | null)[] = new Array(values.length).fill(null)
  let prev: number | null = null
  for (let i = 0; i < values.length; i++) {
    prev = prev === null ? values[i] : alpha * values[i] + (1 - alpha) * prev
    out[i] = prev
  }
  return out
}

/** ta.stdev(src, length): rolling population standard deviation (Pine default biased=true). */
function stdev(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0
    for (let j = i - length + 1; j <= i; j++) sum += values[j]
    const mean = sum / length
    let variance = 0
    for (let j = i - length + 1; j <= i; j++) {
      const d = values[j] - mean
      variance += d * d
    }
    out[i] = Math.sqrt(variance / length)
  }
  return out
}

// ---- Vortex Indicator (vortexindicator.txt): VI+ / VI− in their own pane ----

export const vortex: IndicatorDef = {
  id: 'vortex',
  label: 'Vortex Indicator',
  shortLabel: 'VI',
  placement: 'pane',
  params: [{ key: 'length', label: 'Length', default: 14, min: 2, max: 500, step: 1 }],
  compute(candles, params): IndicatorOutput[] {
    const { plus, minus } = computeVortex(candles, Math.max(2, Math.round(params['length'])))
    return [
      { name: 'plus', values: plus, color: '#2962FF' },
      { name: 'minus', values: minus, color: '#E91E63' },
    ]
  },
}

// ---- ported indicator ----

export const chotaPanditV3: IndicatorDef = {
  id: 'chota_pandit_v3',
  label: 'CHOTA pandit V3',
  shortLabel: 'CHOTA V3',
  placement: 'overlay',
  params: [
    { key: 'length', label: 'Length', default: 30, min: 1, max: 1000, step: 1 },
    { key: 'mult', label: 'StdDev', default: 2, min: 0.001, max: 50, step: 0.1 },
  ],
  compute(candles, params): IndicatorOutput[] {
    const length = Math.max(1, Math.round(params['length']))
    const mult = params['mult']
    const close = candles.map((c) => c.close)
    const low = candles.map((c) => c.low)

    // basis = ta.ema(close, length); bands = basis ± mult * ta.stdev(close, length)
    const basis = ema(close, length)
    const dev = stdev(close, length)
    const upper = basis.map((b, i) => (b !== null && dev[i] !== null ? b + mult * dev[i]! : null))
    const lower = basis.map((b, i) => (b !== null && dev[i] !== null ? b - mult * dev[i]! : null))

    // extra EMAs
    const ema7 = ema(close, 7)
    const ema53 = ema(low, 53)

    return [
      { name: 'Basis', values: basis, color: '#2962FF' }, // plot(basis) #2962FF
      { name: 'Upper', values: upper, color: '#F23645' }, // plot(upper) #F23645
      { name: 'Lower', values: lower, color: '#089981' }, // plot(lower) #089981
      { name: 'EMA 7', values: ema7, color: '#FFEB3B' }, // plot(ema7) yellow
      { name: 'EMA 53', values: ema53, color: '#9C27B0' }, // plot(ema53) purple
    ]
  },
}

// ---- signals (BUY / SELL markers) ----
//
// The library's indicator API plots series only, so the strategy's BUY/SELL
// markers can't be an IndicatorOutput. Instead an indicator may expose a signal
// generator; the pane renders the results as labels on a chart-synced overlay.

export interface Signal {
  time: number // candle open time
  price: number // anchor price (low for buy, high for sell/flag)
  kind: 'buy' | 'sell' | 'flag' // 'flag' = neutral marker (e.g. Blast Candle), not a directional call
  text: string
  shape?: 'label' | 'dot' // default 'label' (pill + pointer); 'dot' = plain filled circle, no text/offset
  color?: string // explicit color override; omit to use the kind-based default
}

/** Pine: buy = ta.crossover(ema7, basis); sell = ta.crossunder(ema7, basis). */
function chotaSignals(candles: Candle[], params: Record<string, number>): Signal[] {
  const length = Math.max(1, Math.round(params['length']))
  const close = candles.map((c) => c.close)
  const ema7 = ema(close, 7)
  const basis = ema(close, length)
  const out: Signal[] = []
  for (let i = 1; i < candles.length; i++) {
    const a = ema7[i]
    const b = basis[i]
    const ap = ema7[i - 1]
    const bp = basis[i - 1]
    if (a === null || b === null || ap === null || bp === null) continue
    if (ap <= bp && a > b) out.push({ time: candles[i].time, price: candles[i].low, kind: 'buy', text: 'BUY' })
    else if (ap >= bp && a < b) out.push({ time: candles[i].time, price: candles[i].high, kind: 'sell', text: 'SELL' })
  }
  return out
}

// ---------------------------------------------------------------------------
// Shared TA helpers for the ported Supertrend strategies (ta.wma/hma/atr/supertrend).
// ---------------------------------------------------------------------------
const ri = (params: Record<string, number>, key: string, def: number): number =>
  Math.max(1, Math.round(params[key] ?? def))

/**
 * ta.wma — weighted moving average (most recent bar weighted highest).
 * Rolling O(n) instead of O(n·len): N[i] = N[i-1] + len·v[i] − Σ(prev window).
 * Resets at any null so leading-null prefixes (e.g. HMA's diff) are handled.
 */
function wma(values: (number | null)[], len: number): (number | null)[] {
  const n = values.length
  const out: (number | null)[] = new Array(n).fill(null)
  const denom = (len * (len + 1)) / 2
  let runStart = 0 // start of the current non-null run
  let num = 0 // weighted numerator of the current full window
  let total = 0 // simple sum of the current full window
  let primed = false
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (v === null) {
      runStart = i + 1
      primed = false
      continue
    }
    const windowLen = i - runStart + 1
    if (windowLen < len) continue
    if (!primed) {
      // First full window of this run — build numerator/sum directly.
      num = 0
      total = 0
      for (let k = 0; k < len; k++) {
        const x = values[i - k] as number
        num += (len - k) * x
        total += x
      }
      primed = true
    } else {
      // Roll the window forward by one bar.
      num = num + len * v - total
      total = total - (values[i - len] as number) + v
    }
    out[i] = num / denom
  }
  return out
}

/** ta.hma — Hull MA = WMA(2·WMA(n/2) − WMA(n), √n). */
function hma(values: number[], len: number): (number | null)[] {
  const half = Math.max(1, Math.round(len / 2))
  const root = Math.max(1, Math.round(Math.sqrt(len)))
  const wHalf = wma(values, half)
  const wFull = wma(values, len)
  const diff = wHalf.map((v, i) => (v === null || wFull[i] === null ? null : 2 * v - (wFull[i] as number)))
  return wma(diff, root)
}

/** ta.atr — Wilder ATR (RMA of true range). */
function atrSeries(candles: Candle[], len: number): (number | null)[] {
  const n = candles.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (n === 0) return out
  const tr: number[] = new Array(n)
  tr[0] = candles[0].high - candles[0].low
  for (let i = 1; i < n; i++) {
    const c = candles[i]
    const p = candles[i - 1]
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  if (n < len) return out
  let sum = 0
  for (let i = 0; i < len; i++) sum += tr[i]
  out[len - 1] = sum / len
  for (let i = len; i < n; i++) out[i] = ((out[i - 1] as number) * (len - 1) + tr[i]) / len
  return out
}

/** ta.supertrend(factor, atrLen) → { st, dir }. Pine semantics: dir < 0 = uptrend. */
function supertrend(candles: Candle[], factor: number, atrLen: number): { st: (number | null)[]; dir: number[] } {
  const n = candles.length
  const atr = atrSeries(candles, atrLen)
  const st: (number | null)[] = new Array(n).fill(null)
  const dir: number[] = new Array(n).fill(1)
  let prevUpper = NaN
  let prevLower = NaN
  let prevST = NaN
  for (let i = 0; i < n; i++) {
    const c = candles[i]
    const a = atr[i]
    if (a === null) {
      dir[i] = 1
      continue
    }
    const hl2 = (c.high + c.low) / 2
    let upper = hl2 + factor * a
    let lower = hl2 - factor * a
    const prevClose = i > 0 ? candles[i - 1].close : c.close
    if (!isNaN(prevLower)) lower = lower > prevLower || prevClose < prevLower ? lower : prevLower
    if (!isNaN(prevUpper)) upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper

    const aPrev = i > 0 ? atr[i - 1] : null
    let direction: number
    if (aPrev === null) direction = 1
    else if (prevST === prevUpper) direction = c.close > upper ? -1 : 1
    else direction = c.close < lower ? 1 : -1

    const stv = direction === -1 ? lower : upper
    st[i] = stv
    dir[i] = direction
    prevUpper = upper
    prevLower = lower
    prevST = stv
  }
  return { st, dir }
}

/** Bend angle (degrees) of a series over `lookback` bars: atan(slope). */
function bendAngle(series: (number | null)[], lookback: number): (number | null)[] {
  return series.map((v, i) => {
    const p = series[i - lookback]
    if (v === null || i < lookback || p === undefined || p === null) return null
    return (Math.atan((v - p) / lookback) * 180) / Math.PI
  })
}

/** Split a Supertrend line into up/down outputs so each renders a single color. */
function stSplit(st: (number | null)[], dir: number[]): { up: (number | null)[]; dn: (number | null)[] } {
  return {
    up: st.map((v, i) => (dir[i] < 0 ? v : null)),
    dn: st.map((v, i) => (dir[i] > 0 ? v : null)),
  }
}

// ---------------------------------------------------------------------------
// indicator1 — HMA31 + Supertrend (validated)
// ---------------------------------------------------------------------------
export const hma31Supertrend: IndicatorDef = {
  id: 'hma31_st',
  label: 'HMA31 + Supertrend',
  shortLabel: 'HMA+ST',
  placement: 'overlay',
  params: [
    { key: 'hmaLen', label: 'HMA length', default: 31, min: 1, max: 500, step: 1 },
    { key: 'slowLen', label: 'Slow HMA length', default: 300, min: 1, max: 1000, step: 1 },
    { key: 'atrLen', label: 'Supertrend ATR length', default: 14, min: 1, max: 100, step: 1 },
    { key: 'factor', label: 'Supertrend factor', default: 3, min: 0.5, max: 20, step: 0.5 },
    { key: 'bendLB', label: 'Bend lookback', default: 3, min: 1, max: 50, step: 1 },
    { key: 'bendT', label: 'Bend angle threshold', default: 50, min: 0, max: 90, step: 1 },
    { key: 'useBend', label: 'Require bend (1/0)', default: 1, min: 0, max: 1, step: 1 },
  ],
  compute(candles, params): IndicatorOutput[] {
    const close = candles.map((c) => c.close)
    const hm = hma(close, ri(params, 'hmaLen', 31))
    const hmSlow = hma(close, ri(params, 'slowLen', 300))
    const { st, dir } = supertrend(candles, params['factor'], ri(params, 'atrLen', 14))
    const split = stSplit(st, dir)
    return [
      { name: 'HMA fast', values: hm, color: '#2962ff' },
      { name: 'HMA slow', values: hmSlow, color: '#9c27b0' },
      { name: 'Supertrend up', values: split.up, color: '#26a69a' },
      { name: 'Supertrend down', values: split.dn, color: '#ef5350' },
    ]
  },
}
/** CE = buy flip (+ bend up); PE = sell flip (+ bend down). */
function hma31Signals(candles: Candle[], params: Record<string, number>): Signal[] {
  const close = candles.map((c) => c.close)
  const hm = hma(close, ri(params, 'hmaLen', 31))
  const { dir } = supertrend(candles, params['factor'], ri(params, 'atrLen', 14))
  const angle = bendAngle(hm, ri(params, 'bendLB', 3))
  const bendT = params['bendT'] ?? 50
  const useBend = (params['useBend'] ?? 1) >= 0.5
  const out: Signal[] = []
  for (let i = 1; i < candles.length; i++) {
    const buyFlip = dir[i] < 0 && dir[i - 1] > 0
    const sellFlip = dir[i] > 0 && dir[i - 1] < 0
    const a = angle[i]
    if (buyFlip && (!useBend || (a !== null && a > bendT))) out.push({ time: candles[i].time, price: candles[i].low, kind: 'buy', text: 'CE' })
    else if (sellFlip && (!useBend || (a !== null && a < -bendT))) out.push({ time: candles[i].time, price: candles[i].high, kind: 'sell', text: 'PE' })
  }
  return out
}

// ---------------------------------------------------------------------------
// HMA 31 + Supertrend 2,2 + Coppock 9,13,17 (hma-coppock.pine, ported)
// Two defs: the overlay carries HMA, Supertrend and the BUY/SELL signals;
// the Coppock curve lives in its own pane (one IndicatorDef = one placement).
// ---------------------------------------------------------------------------

/** ta.roc(src, length): percent change versus `length` bars ago. */
function roc(values: number[], length: number): (number | null)[] {
  return values.map((v, i) => {
    const p = i >= length ? values[i - length] : undefined
    if (p === undefined || p === 0) return null
    return (100 * (v - p)) / p
  })
}

/** Coppock: WMA( ROC(close, longRoc) + ROC(close, shortRoc), wmaLen ). */
function coppockCurve(close: number[], wmaLen: number, longRoc: number, shortRoc: number): (number | null)[] {
  const rl = roc(close, longRoc)
  const rs = roc(close, shortRoc)
  const sum = rl.map((v, i) => (v === null || rs[i] === null ? null : v + (rs[i] as number)))
  return wma(sum, wmaLen)
}

/** SAR split by trend: the value sits below price in an uptrend and above it in a downtrend. */
function sarSplit(sar: (number | null)[], candles: Candle[]): { up: (number | null)[]; dn: (number | null)[] } {
  const up: (number | null)[] = sar.map((v, i) => (v !== null && v < candles[i].close ? v : null))
  const dn: (number | null)[] = sar.map((v, i) => (v !== null && v >= candles[i].close ? v : null))
  return { up, dn }
}

export const parabolicSarIndicator: IndicatorDef = {
  id: 'parabolic_sar',
  label: 'Parabolic SAR',
  shortLabel: 'PSAR',
  placement: 'overlay',
  params: [
    { key: 'step', label: 'Acceleration step', default: 0.02, min: 0.001, max: 1, step: 0.001 },
    { key: 'maxStep', label: 'Maximum acceleration', default: 0.2, min: 0.01, max: 1, step: 0.01 },
  ],
  compute(candles, params): IndicatorOutput[] {
    const sar = parabolicSar(candles, params['step'] ?? 0.02, params['maxStep'] ?? 0.2)
    const split = sarSplit(sar, candles)
    return [
      { name: 'PSAR up', values: split.up, color: '#26a69a', style: 'dots' },
      { name: 'PSAR down', values: split.dn, color: '#ef5350', style: 'dots' },
    ]
  },
}

export const hmaCoppockTrend: IndicatorDef = {
  id: 'hma_coppock',
  label: 'HMA 31 + Supertrend 2,2 + Coppock signals',
  shortLabel: 'HMA+ST+Cop',
  placement: 'overlay',
  params: [
    { key: 'hmaLen', label: 'HMA length', default: 31, min: 1, max: 500, step: 1 },
    { key: 'stAtrLen', label: 'Supertrend ATR period', default: 2, min: 1, max: 100, step: 1 },
    { key: 'stFactor', label: 'Supertrend factor', default: 2, min: 0.5, max: 20, step: 0.1 },
    { key: 'showProbable', label: 'Show probable buy / sell (1/0)', default: 1, min: 0, max: 1, step: 1 },
    { key: 'showRawST', label: 'Show raw Supertrend flips (1/0)', default: 0, min: 0, max: 1, step: 1 },
  ],
  compute(candles, params): IndicatorOutput[] {
    const close = candles.map((c) => c.close)
    const hm = hma(close, ri(params, 'hmaLen', 31))
    const { st, dir } = supertrend(candles, params['stFactor'] ?? 2, ri(params, 'stAtrLen', 2))
    const split = stSplit(st, dir)
    return [
      { name: 'HMA 31', values: hm, color: '#26a69a', style: 'line' },
      { name: 'Supertrend up', values: split.up, color: '#26a69a' },
      { name: 'Supertrend down', values: split.dn, color: '#ef5350' },
    ]
  },
}

/** BUY/SELL = Supertrend flip + price vs HMA + Coppock side of zero (Pine's confirmed signal).
 *  PROB = Supertrend already in trend + Coppock crosses zero (skipped on bars with a confirmed signal). */
function hmaCoppockSignals(candles: Candle[], params: Record<string, number>): Signal[] {
  const close = candles.map((c) => c.close)
  const hm = hma(close, ri(params, 'hmaLen', 31))
  const { dir } = supertrend(candles, params['stFactor'] ?? 2, ri(params, 'stAtrLen', 2))
  const cop = coppockCurve(close, 9, 13, 17)
  const showProb = (params['showProbable'] ?? 1) >= 0.5
  const showRaw = (params['showRawST'] ?? 0) >= 0.5
  const out: Signal[] = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    const h = hm[i]
    const cv = cop[i]
    const cvPrev = cop[i - 1]
    const stBull = dir[i] < 0
    const stBear = dir[i] > 0
    const stBullFlip = stBull && dir[i - 1] >= 0
    const stBearFlip = stBear && dir[i - 1] <= 0
    const copUp = cv !== null && cvPrev !== null && cv > 0 && cvPrev <= 0
    const copDn = cv !== null && cvPrev !== null && cv < 0 && cvPrev >= 0

    const buy = stBullFlip && h !== null && c.close > h && cv !== null && cv > 0
    const sell = stBearFlip && h !== null && c.close < h && cv !== null && cv < 0
    if (buy) out.push({ time: c.time, price: c.low, kind: 'buy', text: 'BUY' })
    else if (sell) out.push({ time: c.time, price: c.high, kind: 'sell', text: 'SELL' })
    else if (showProb && stBull && copUp) out.push({ time: c.time, price: c.low, kind: 'buy', text: 'PROB BUY', color: 'rgba(0, 230, 118, 0.55)' })
    else if (showProb && stBear && copDn) out.push({ time: c.time, price: c.high, kind: 'sell', text: 'PROB SELL', color: 'rgba(255, 82, 82, 0.55)' })

    if (showRaw && stBullFlip) out.push({ time: c.time, price: c.low, kind: 'flag', text: '', shape: 'dot', color: 'rgba(0, 230, 118, 0.6)' })
    if (showRaw && stBearFlip) out.push({ time: c.time, price: c.high, kind: 'flag', text: '', shape: 'dot', color: 'rgba(255, 82, 82, 0.6)' })
  }
  return out
}

export const coppockCurveIndicator: IndicatorDef = {
  id: 'coppock_curve',
  label: 'Coppock Curve (WMA 9, RoC 13 + 17)',
  shortLabel: 'Coppock',
  placement: 'pane',
  params: [
    { key: 'wmaLen', label: 'WMA length', default: 9, min: 1, max: 200, step: 1 },
    { key: 'longRoc', label: 'Long RoC length', default: 13, min: 1, max: 200, step: 1 },
    { key: 'shortRoc', label: 'Short RoC length', default: 17, min: 1, max: 200, step: 1 },
  ],
  compute(candles, params): IndicatorOutput[] {
    const close = candles.map((c) => c.close)
    const cop = coppockCurve(close, ri(params, 'wmaLen', 9), ri(params, 'longRoc', 13), ri(params, 'shortRoc', 17))
    return [
      { name: 'Zero Line', values: candles.map(() => 0), color: '#787b86', style: 'dashed' },
      { name: 'Coppock', values: cop, color: '#00e676' },
    ]
  },
}

// ---------------------------------------------------------------------------
// indicator2 — EMA47 Band + Supertrend (validated)
// ---------------------------------------------------------------------------
export const ema47Supertrend: IndicatorDef = {
  id: 'ema47_st',
  label: 'EMA47 Band + Supertrend',
  shortLabel: 'EMA47+ST',
  placement: 'overlay',
  params: [
    { key: 'emaLen', label: 'EMA length', default: 47, min: 1, max: 500, step: 1 },
    { key: 'atrLen', label: 'Supertrend ATR length', default: 14, min: 1, max: 100, step: 1 },
    { key: 'factor', label: 'Supertrend factor', default: 3, min: 0.5, max: 20, step: 0.5 },
    { key: 'bendLB', label: 'Bend lookback', default: 3, min: 1, max: 50, step: 1 },
    { key: 'bendT', label: 'Bend angle threshold', default: 50, min: 0, max: 90, step: 1 },
  ],
  compute(candles, params): IndicatorOutput[] {
    const len = ri(params, 'emaLen', 47)
    const emaH = ema(candles.map((c) => c.high), len)
    const emaL = ema(candles.map((c) => c.low), len)
    const { st, dir } = supertrend(candles, params['factor'], ri(params, 'atrLen', 14))
    const split = stSplit(st, dir)
    return [
      { name: 'EMA47 high', values: emaH, color: '#26a69a' },
      { name: 'EMA47 low', values: emaL, color: '#26a69a' },
      { name: 'Supertrend up', values: split.up, color: '#16c784' },
      { name: 'Supertrend down', values: split.dn, color: '#ef5350' },
    ]
  },
}
/** CE = buy flip + band bend up; PE = sell flip + band bend down. */
function ema47Signals(candles: Candle[], params: Record<string, number>): Signal[] {
  const len = ri(params, 'emaLen', 47)
  const emaH = ema(candles.map((c) => c.high), len)
  const emaL = ema(candles.map((c) => c.low), len)
  const mid = emaH.map((h, i) => (h === null || emaL[i] === null ? null : (h + (emaL[i] as number)) / 2))
  const { dir } = supertrend(candles, params['factor'], ri(params, 'atrLen', 14))
  const angle = bendAngle(mid, ri(params, 'bendLB', 3))
  const bendT = params['bendT'] ?? 50
  const out: Signal[] = []
  for (let i = 1; i < candles.length; i++) {
    const buyFlip = dir[i] < 0 && dir[i - 1] > 0
    const sellFlip = dir[i] > 0 && dir[i - 1] < 0
    const a = angle[i]
    if (buyFlip && a !== null && a > bendT) out.push({ time: candles[i].time, price: candles[i].low, kind: 'buy', text: 'CE' })
    else if (sellFlip && a !== null && a < -bendT) out.push({ time: candles[i].time, price: candles[i].high, kind: 'sell', text: 'PE' })
  }
  return out
}

// ---------------------------------------------------------------------------
// Blast Candle — ported from blastcandle.pine ("Blast Candle with Alert").
//
// Pine flags a bar as a "blast candle" when its high/low range spans ALL of
// EMA8 / EMA20 / EMA50 / SMA200 at once (high above every MA, low below every
// MA) — a single bar violent enough to blow through the whole MA stack. The
// original also fetches EMA8 from a separate NSE index-futures VWAP series
// (request.security) as an index-specific volume proxy; that has no
// equivalent here (indicators are pure functions of one symbol's own OHLCV,
// and this demo's data is Delta India crypto, not NSE), so EMA8 uses this symbol's
// own close like the other three MAs. barcolor()/alertcondition() have no
// direct analogue in a series-plotting engine, so the "blast" condition is
// surfaced as a BLAST flag marker (the existing signal mechanism) instead of
// a bar recolor, and the four MAs are plotted so the engulfing is visible.
// ---------------------------------------------------------------------------

/** ta.sma(src, length): simple moving average via a rolling sum. */
function sma(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= length) sum -= values[i - length]
    if (i >= length - 1) out[i] = sum / length
  }
  return out
}

export const blastCandle: IndicatorDef = {
  id: 'blast_candle',
  label: 'Blast Candle',
  shortLabel: 'Blast',
  placement: 'overlay',
  params: [
    { key: 'fastLen', label: 'Fast EMA', default: 8, min: 1, max: 500, step: 1 },
    { key: 'midLen', label: 'Mid EMA', default: 20, min: 1, max: 500, step: 1 },
    { key: 'slowLen', label: 'Slow EMA', default: 50, min: 1, max: 500, step: 1 },
    { key: 'baseLen', label: 'Base SMA', default: 200, min: 1, max: 1000, step: 1 },
  ],
  compute(candles, params): IndicatorOutput[] {
    const close = candles.map((c) => c.close)
    const fast = ema(close, ri(params, 'fastLen', 8))
    const mid = ema(close, ri(params, 'midLen', 20))
    const slow = ema(close, ri(params, 'slowLen', 50))
    const base = sma(close, ri(params, 'baseLen', 200))
    return [
      { name: 'EMA fast', values: fast, color: '#42a5f5' },
      { name: 'EMA mid', values: mid, color: '#ffca28' },
      { name: 'EMA slow', values: slow, color: '#ab47bc' },
      { name: 'SMA base', values: base, color: '#78909c' },
    ]
  },
}

/** Blast: high clears every MA and low is under every MA — the bar's whole range engulfs the MA stack. */
function blastSignals(candles: Candle[], params: Record<string, number>): Signal[] {
  const close = candles.map((c) => c.close)
  const fast = ema(close, ri(params, 'fastLen', 8))
  const mid = ema(close, ri(params, 'midLen', 20))
  const slow = ema(close, ri(params, 'slowLen', 50))
  const base = sma(close, ri(params, 'baseLen', 200))
  const out: Signal[] = []
  for (let i = 0; i < candles.length; i++) {
    const f = fast[i]
    const m = mid[i]
    const s = slow[i]
    const b = base[i]
    if (f === null || m === null || s === null || b === null) continue
    const c = candles[i]
    const aboveAll = c.high > f && c.high > m && c.high > s && c.high > b
    const belowAll = c.low < f && c.low < m && c.low < s && c.low < b
    if (aboveAll && belowAll) out.push({ time: c.time, price: c.high, kind: 'flag', text: 'BLAST' })
  }
  return out
}

// ---------------------------------------------------------------------------
// Daddy Home — ported from daddyhome.pine ("HH LL Zones + VWAP High-Winrate
// Order Flow"). Every plot in the source has a home here:
//   • plot() VWAP / BUY ZONE (lowest low) / SELL ZONE (highest high) → the 3
//     line outputs below (Pine's plot.style_stepline has no direct analogue —
//     see PlotStyle in src/indicators/types.ts — but ta.highest/ta.lowest are
//     already piecewise-constant, so a plain line still renders the same
//     flat-then-jump shape, just with a diagonal instead of a right-angle
//     transition).
//   • the 4 plotshape(style=shape.circle) absorption/initiation markers →
//     'dot'-shaped Signals (flag kind — informational, not a trade call — see
//     backtest note below), colors/alpha matched to Pine's named color.teal /
//     color.fuchsia / color.lime / color.red at transp=60.
//   • the 2 plotshape(style=shape.circle) BUY/SELL neon dots (#00E676 /
//     #FF1744) → 'dot'-shaped Signals, also flag kind.
//   • the 2 plotshape(style=shape.labelup/labeldown) BUY/SELL text tags →
//     'label'-shaped (the default) buy/sell Signals — these are the ones kind
//     'buy'/'sell' is reserved for, so the Strategy Tester's backtest (which
//     filters signals to kind buy/sell) enters once per bar, not twice from
//     also counting the reinforcing neon dot at the same timestamp.
// ta.vwap resets every session in Pine; this port accumulates from the first
// loaded candle instead, same documented adaptation as the library's built-in
// VWAP indicator (src/indicators/vwap.ts) — there's no session boundary
// concept here.
// ---------------------------------------------------------------------------

/** ta.rsi(src, length): Wilder RSI, seeded with a simple average of the first `length` gains/losses. */
function rsi(values: number[], length: number): (number | null)[] {
  const n = values.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (n <= length) return out
  const gains: number[] = new Array(n).fill(0)
  const losses: number[] = new Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    const change = values[i] - values[i - 1]
    if (change > 0) gains[i] = change
    else losses[i] = -change
  }
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= length; i++) {
    avgGain += gains[i]
    avgLoss += losses[i]
  }
  avgGain /= length
  avgLoss /= length
  out[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = length + 1; i < n; i++) {
    avgGain = (avgGain * (length - 1) + gains[i]) / length
    avgLoss = (avgLoss * (length - 1) + losses[i]) / length
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

/** ta.vwap(close): cumulative from the first loaded candle (see adaptation note above). */
function cumulativeVwap(candles: Candle[]): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null)
  let cumPV = 0
  let cumVol = 0
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    cumPV += ((c.high + c.low + c.close) / 3) * c.volume
    cumVol += c.volume
    out[i] = cumVol > 0 ? cumPV / cumVol : null
  }
  return out
}

/** ta.highest(source, length): rolling max including the current bar. */
function rollingHigh(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  for (let i = length - 1; i < values.length; i++) {
    let m = -Infinity
    for (let j = i - length + 1; j <= i; j++) if (values[j] > m) m = values[j]
    out[i] = m
  }
  return out
}

/** ta.lowest(source, length): rolling min including the current bar. */
function rollingLow(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  for (let i = length - 1; i < values.length; i++) {
    let m = Infinity
    for (let j = i - length + 1; j <= i; j++) if (values[j] < m) m = values[j]
    out[i] = m
  }
  return out
}

export const daddyHome: IndicatorDef = {
  id: 'daddy_home',
  label: 'HH LL Zones + VWAP Order Flow',
  shortLabel: 'Daddy Home',
  placement: 'overlay',
  params: [
    { key: 'swingLen', label: 'Swing length (HH/LL)', default: 20, min: 1, max: 500, step: 1 },
    { key: 'showVWAP', label: 'Show VWAP (1/0)', default: 1, min: 0, max: 1, step: 1 },
    { key: 'len', label: 'Delta smoothing length', default: 14, min: 1, max: 200, step: 1 },
    { key: 'mult', label: 'Delta strength multiplier', default: 1.8, min: 0.1, max: 10, step: 0.1 },
    { key: 'useRsiFilter', label: 'Filter by RSI 14 (1/0)', default: 1, min: 0, max: 1, step: 1 },
    { key: 'useEmaFilter', label: 'Filter by EMA 200 (1/0)', default: 0, min: 0, max: 1, step: 1 },
    { key: 'minCandleRange', label: 'Min candle range (noise filter)', default: 3, min: 0, max: 1000, step: 0.5 },
  ],
  compute(candles, params): IndicatorOutput[] {
    const swingLen = ri(params, 'swingLen', 20)
    const showVWAP = (params['showVWAP'] ?? 1) >= 0.5
    const high = candles.map((c) => c.high)
    const low = candles.map((c) => c.low)
    const buyZone = rollingLow(low, swingLen) // plot(buyZone) color.green — lowest low
    const sellZone = rollingHigh(high, swingLen) // plot(sellZone) color.red — highest high
    const vwapVal = showVWAP ? cumulativeVwap(candles) : new Array(candles.length).fill(null)
    return [
      { name: 'VWAP', values: vwapVal, color: '#2196F3' },
      { name: 'BUY ZONE', values: buyZone, color: '#4CAF50' },
      { name: 'SELL ZONE', values: sellZone, color: '#FF5252' },
    ]
  },
}

/** All 8 plotshape() markers from daddyhome.pine — see the port note above for the shape/kind mapping. */
function daddyHomeSignals(candles: Candle[], params: Record<string, number>): Signal[] {
  const n = candles.length
  const close = candles.map((c) => c.close)
  const open = candles.map((c) => c.open)
  const high = candles.map((c) => c.high)
  const low = candles.map((c) => c.low)
  const volume = candles.map((c) => c.volume)

  const len = ri(params, 'len', 14)
  const mult = params['mult'] ?? 1.8
  const useRsiFilter = (params['useRsiFilter'] ?? 1) >= 0.5
  const useEmaFilter = (params['useEmaFilter'] ?? 0) >= 0.5
  const minCandleRange = params['minCandleRange'] ?? 3

  // vwapVal feeds the crossover signal unconditionally in Pine, regardless of
  // the showVWAP display toggle — only the plot() call is gated on it.
  const vwapVal = cumulativeVwap(candles)
  const ema200 = ema(close, 200)
  const rsi14 = rsi(close, 14)

  const eps = 1e-9
  const delta: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    delta[i] = (volume[i] * (close[i] - open[i])) / (high[i] - low[i] + eps)
  }
  const avgDelta = sma(delta.map(Math.abs), len)

  const out: Signal[] = []
  for (let i = 1; i < n; i++) {
    const ad = avgDelta[i]
    if (ad === null) continue
    const range = high[i] - low[i]
    const d = delta[i]
    const buyPressure = d > ad * mult
    const sellPressure = d < -ad * mult
    const posInRange = (close[i] - low[i]) / (range + eps)

    const buyerAbsorption = buyPressure && posInRange < 0.4
    const sellerAbsorption = sellPressure && posInRange > 0.6
    const buyerInitiation = buyPressure && posInRange > 0.6
    const sellerInitiation = sellPressure && posInRange < 0.4
    const t = candles[i].time

    if (buyerAbsorption)
      out.push({ time: t, price: low[i] + range * 0.1, kind: 'flag', text: '', shape: 'dot', color: 'rgba(0,150,136,0.4)' })
    if (sellerAbsorption)
      out.push({ time: t, price: high[i] - range * 0.1, kind: 'flag', text: '', shape: 'dot', color: 'rgba(224,64,251,0.4)' })
    if (buyerInitiation)
      out.push({ time: t, price: close[i], kind: 'flag', text: '', shape: 'dot', color: 'rgba(205,220,57,0.4)' })
    if (sellerInitiation)
      out.push({ time: t, price: close[i], kind: 'flag', text: '', shape: 'dot', color: 'rgba(255,82,82,0.4)' })

    const v = vwapVal[i]
    const vPrev = vwapVal[i - 1]
    if (v === null || vPrev === null) continue
    const crossover = close[i - 1] <= vPrev && close[i] > v
    const crossunder = close[i - 1] >= vPrev && close[i] < v

    const baseBuySignal = crossover && buyerInitiation
    const baseSellSignal = crossunder && sellerInitiation

    const r = rsi14[i]
    const buyRsiOk = !useRsiFilter || (r !== null && r > 50)
    const sellRsiOk = !useRsiFilter || (r !== null && r < 50)
    const e = ema200[i]
    const buyEmaOk = !useEmaFilter || (e !== null && close[i] > e)
    const sellEmaOk = !useEmaFilter || (e !== null && close[i] < e)
    const noiseOk = range >= minCandleRange

    const buySignal = baseBuySignal && buyRsiOk && buyEmaOk && noiseOk
    const sellSignal = baseSellSignal && sellRsiOk && sellEmaOk && noiseOk

    if (buySignal) {
      out.push({ time: t, price: low[i] - range * 0.15, kind: 'flag', text: '', shape: 'dot', color: '#00E676' })
      out.push({ time: t, price: low[i], kind: 'buy', text: 'BUY', color: '#00C853' })
    }
    if (sellSignal) {
      out.push({ time: t, price: high[i] + range * 0.15, kind: 'flag', text: '', shape: 'dot', color: '#FF1744' })
      out.push({ time: t, price: high[i], kind: 'sell', text: 'SELL', color: '#D50000' })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Candle Buy/Sell Dominance — one dot per bar, colored by which side of the
// tape (taker buy vs. sell volume) won that candle. Uses Candle.buyVolume,
// so its accuracy follows whatever the data source can supply:
//   - Sources that publish the split on the candle itself (Binance klines,
//     see src/data/binance.ts) give exact dots across the FULL loaded
//     history, and switching intervals just loads different candles with
//     their own server-side split — no per-timeframe tracking needed.
//   - Delta Exchange candles carry total volume only, so the split is
//     rebuilt from the live trade tape instead (see TakerTape in
//     src/data/delta.ts). Dots then appear for bars this session watched
//     form, and not for history loaded before it started.
// Not available for the re-binned chart types (Renko/Kagi/Point&Figure/Range
// bars/Line break) — their synthetic bars don't have a well-defined buy/sell
// split, so those simply show no dots (compute() below returns no lines
// either; this is a pure marker indicator).
// ---------------------------------------------------------------------------
export const candleDominance: IndicatorDef = {
  id: 'candle_dominance',
  label: 'Candle Buy/Sell Dominance',
  shortLabel: 'Dominance',
  placement: 'overlay',
  params: [],
  compute(): IndicatorOutput[] {
    return []
  },
}

/**
 * Which side of the tape won this candle, from its own taker buy/sell volume
 * split — null if the split isn't available (see Candle.buyVolume) or it's an
 * exact tie. This is the ONE place the rule is expressed; both the chart-dot
 * indicator below and Dominance V2's table (examples/basic/dominanceTable.ts)
 * call this rather than each computing it themselves, so the two presentations
 * can never silently drift apart.
 */
export function candleDominanceSide(c: Candle): 'buy' | 'sell' | null {
  if (c.buyVolume === undefined || !Number.isFinite(c.volume) || c.volume <= 0) return null
  const sellVolume = c.volume - c.buyVolume
  if (c.buyVolume === sellVolume) return null // exact tie — no lean either way
  return c.buyVolume > sellVolume ? 'buy' : 'sell'
}

function candleDominanceSignals(candles: Candle[]): Signal[] {
  const out: Signal[] = []
  for (const c of candles) {
    const dom = candleDominanceSide(c)
    if (dom === null) continue
    out.push({
      time: c.time,
      price: c.low - (c.high - c.low) * 0.12,
      kind: 'flag',
      text: '',
      shape: 'dot',
      color: dom === 'buy' ? '#0ecb81' : '#f6465d',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Lion with 50% level — ported from lionindicator.pine ("Lion with 50%
// level"). Pine recomputes this every bar but only actually plots on
// barstate.islast: it zigzags confirmed swing pivots, then walks backward
// from the newest pivot until it finds a leg whose latest same-side pivot
// retraces 23.6%-100% of the leg before it (a standard Fibonacci retracement
// check), and projects Stop-Loss / 50% / Entry / T1 / T2 / T3 levels off that
// leg's size. Ported as flat IndicatorOutput lines running from the anchor
// pivot forward to the most recent candle — the levels project onto current
// price action, same as Pine's rendering — plus signal labels at the anchor.
//
// NOT ported: `themecolor` is assigned in the source but never read anywhere
// else in it (dead code). Stop-Loss's Pine color is pure black; swapped for
// light gray here since this demo's candle pane is dark and plain black would
// be invisible. The "Entry-Exit" toggle (SPR) is kept as the one param —
// Pine's own last-bar block only runs the retracement search inside `if SPR`,
// so off, there's nothing left to search for and this plots nothing.
// ---------------------------------------------------------------------------

const LION_UPPER_THRESHOLD = 0.236
const LION_LOWER_THRESHOLD = 1.0

const LION_COLORS = {
  stopLoss: '#9E9E9E', // Pine: pure black — see port note above
  fifty: '#FFFFFF',
  entry: '#FFFFFF',
  t1: '#00F500',
  t2: '#0004FD',
  t3: '#FF0000',
}

// The demo's Signal label pill always draws its text in hardcoded white
// (see drawSignal() in pane.ts), unlike Pine's transparent-background label
// (color=#00000000) with just colored text — so a label reusing LION_COLORS'
// white line colors as its pill background would be invisible white-on-white.
// These are label-only substitutes; the reference lines above keep the
// Pine-faithful colors.
const LION_LABEL_COLORS = {
  stopLoss: '#616161',
  fifty: '#546E7A',
  entry: '#2962FF',
  t1: LION_COLORS.t1,
  t2: LION_COLORS.t2,
  t3: LION_COLORS.t3,
}

interface LionPivotArr {
  idx: number[]
  price: number[]
}

/** Confirmed swing highs/lows, each array kept alternating by replacing a run
 *  of same-side pivots with its most extreme point — mirrors Pine's `pivots()`
 *  plus the array push/replace state machine that follows it. */
function lionPivots(candles: Candle[], depth: number): { highs: LionPivotArr; lows: LionPivotArr } {
  const length = Math.max(1, Math.round(depth / 2))
  const n = candles.length
  const high = candles.map((c) => c.high)
  const low = candles.map((c) => c.low)
  const highs: LionPivotArr = { idx: [], price: [] }
  const lows: LionPivotArr = { idx: [], price: [] }

  for (let i = length; i < n - length; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - length; j <= i + length; j++) {
      if (j === i) continue
      if (high[j] > high[i]) isHigh = false
      if (low[j] < low[i]) isLow = false
    }
    let newH = isHigh ? high[i] : null
    let newL = isLow ? low[i] : null

    if (highs.idx.length > 0 && lows.idx.length > 0) {
      const isHighLast = highs.idx[highs.idx.length - 1] > lows.idx[lows.idx.length - 1]
      if (isHighLast) {
        if (newH !== null) {
          if (newH > highs.price[highs.price.length - 1]) {
            highs.idx[highs.idx.length - 1] = i
            highs.price[highs.price.length - 1] = newH
          }
          newH = null
        }
      } else if (newL !== null) {
        if (newL < lows.price[lows.price.length - 1]) {
          lows.idx[lows.idx.length - 1] = i
          lows.price[lows.price.length - 1] = newL
        }
        newL = null
      }
    }
    if (newH !== null) {
      highs.idx.push(i)
      highs.price.push(newH)
    }
    if (newL !== null) {
      lows.idx.push(i)
      lows.price.push(newL)
    }
  }
  return { highs, lows }
}

/** Walk backward from the newest pivots until a leg's retracement lands in
 *  [upperThreshold, lowerThreshold] of the leg before it. Returns null if no
 *  such leg exists (mirrors Pine's `for j = bar_index to 0` giving up once
 *  either copy array runs dry). */
function lionFindLeg(
  highs: LionPivotArr,
  lows: LionPivotArr,
): { endIdx: number; endPrice: number; signedDiff: number; prevIdx: number; prevPrice: number } | null {
  const hIdx = [...highs.idx]
  const hPrice = [...highs.price]
  const lIdx = [...lows.idx]
  const lPrice = [...lows.price]

  while (hIdx.length > 0 && lIdx.length > 0) {
    let iLastH = hIdx.pop()!
    let pLastH = hPrice.pop()!
    let iLastL = lIdx.pop()!
    let pLastL = lPrice.pop()!
    let isHighLast = iLastH > iLastL

    // Fold in any older same-side pivot more extreme than this one, as long
    // as it's still more recent than the opposite side's last pivot.
    if (isHighLast) {
      while (hIdx.length > 0 && hIdx[hIdx.length - 1] >= iLastL) {
        if (hPrice[hPrice.length - 1] > pLastH) {
          iLastH = hIdx.pop()!
          pLastH = hPrice.pop()!
        } else {
          hIdx.pop()
          hPrice.pop()
        }
      }
    } else {
      while (lIdx.length > 0 && lIdx[lIdx.length - 1] >= iLastH) {
        if (lPrice[lPrice.length - 1] < pLastL) {
          iLastL = lIdx.pop()!
          pLastL = lPrice.pop()!
        } else {
          lIdx.pop()
          lPrice.pop()
        }
      }
    }
    if (hIdx.length === 0 || lIdx.length === 0) return null
    isHighLast = iLastH > iLastL

    const iPrevPivot = isHighLast ? hIdx[hIdx.length - 1] : lIdx[lIdx.length - 1]
    const pPrevPivot = isHighLast ? hPrice[hPrice.length - 1] : lPrice[lPrice.length - 1]
    const startPrice = pPrevPivot
    const endPrice = isHighLast ? pLastL : pLastH
    const diff = Math.abs(startPrice - endPrice)
    const outOfBand = isHighLast
      ? pLastH > endPrice + diff * LION_LOWER_THRESHOLD || pLastH < endPrice + diff * LION_UPPER_THRESHOLD
      : pLastL < endPrice - diff * LION_LOWER_THRESHOLD || pLastL > endPrice - diff * LION_UPPER_THRESHOLD

    if (outOfBand) {
      // Put this side's pivot back and retry against an older leg.
      if (isHighLast) {
        lIdx.push(iLastL)
        lPrice.push(pLastL)
      } else {
        hIdx.push(iLastH)
        hPrice.push(pLastH)
      }
      continue
    }

    return {
      endIdx: isHighLast ? iLastL : iLastH,
      endPrice,
      signedDiff: isHighLast ? -diff : diff,
      prevIdx: iPrevPivot,
      prevPrice: pPrevPivot,
    }
  }
  return null
}

/** Pine's fixed `depth = 10` (not a user input in the source). */
const LION_DEPTH = 10

function lionLeg(candles: Candle[], params: Record<string, number>) {
  const showEntryExit = (params['entryExit'] ?? 1) >= 0.5
  if (!showEntryExit || candles.length < LION_DEPTH + 2) return null
  const { highs, lows } = lionPivots(candles, LION_DEPTH)
  return lionFindLeg(highs, lows)
}

export const lionIndicator: IndicatorDef = {
  id: 'lion_50',
  label: 'Lion with 50% level',
  shortLabel: 'Lion',
  placement: 'overlay',
  params: [{ key: 'entryExit', label: 'Show Entry-Exit (1/0)', default: 1, min: 0, max: 1, step: 1 }],
  compute(candles, params): IndicatorOutput[] {
    const leg = lionLeg(candles, params)
    if (!leg) return []
    const { endIdx, endPrice, signedDiff, prevIdx, prevPrice } = leg
    const line = (price: number): (number | null)[] => {
      const values: (number | null)[] = new Array(candles.length).fill(null)
      for (let i = endIdx; i < candles.length; i++) values[i] = price
      return values
    }
    // The swing leg itself (prevPivot -> anchor pivot), matching Pine's
    // lineLastHL/lineLastLH dashed diagonal — shown so it's clear which
    // swing the levels above were measured from.
    const swing: (number | null)[] = new Array(candles.length).fill(null)
    for (let i = prevIdx; i <= endIdx; i++) {
      const t = endIdx === prevIdx ? 0 : (i - prevIdx) / (endIdx - prevIdx)
      swing[i] = prevPrice + (endPrice - prevPrice) * t
    }
    const outs: IndicatorOutput[] = [
      { name: 'Swing', values: swing, color: '#BDBDBD', style: 'dashed' },
      { name: 'T3 (upper)', values: line(endPrice + 0.618 * signedDiff), color: LION_COLORS.t3 },
      { name: 'T2 (upper)', values: line(endPrice + 0.414 * signedDiff), color: LION_COLORS.t2 },
      { name: 'T1 (upper)', values: line(endPrice + 0.272 * signedDiff), color: LION_COLORS.t1 },
      { name: 'Entry (upper)', values: line(endPrice), color: LION_COLORS.entry },
      { name: '50% (upper)', values: line(endPrice - 0.5 * signedDiff), color: LION_COLORS.fifty },
      { name: 'Stop-Loss', values: line(endPrice - signedDiff), color: LION_COLORS.stopLoss },
      { name: '50% (lower)', values: line(endPrice - 1.5 * signedDiff), color: LION_COLORS.fifty },
      { name: 'Entry (lower)', values: line(endPrice - 2 * signedDiff), color: LION_COLORS.entry },
      { name: 'T1 (lower)', values: line(endPrice - 2.272 * signedDiff), color: LION_COLORS.t1 },
      { name: 'T2 (lower)', values: line(endPrice - 2.414 * signedDiff), color: LION_COLORS.t2 },
      { name: 'T3 (lower)', values: line(endPrice - 2.618 * signedDiff), color: LION_COLORS.t3 },
    ]
    // Project the level lines right by their own length, so each spans 2x.
    for (const o of outs) if (o.name !== 'Swing') o.extendRight = candles.length - endIdx
    return outs
  },
}

/** Stop-Loss/50%/Entry/T1/T2/T3 text labels, at the same pivot/price the lines above anchor to. */
function lionSignals(candles: Candle[], params: Record<string, number>): Signal[] {
  const leg = lionLeg(candles, params)
  if (!leg) return []
  const { endIdx, endPrice, signedDiff } = leg
  const time = candles[endIdx].time
  const mark = (price: number, text: string, color: string): Signal => ({ time, price, kind: 'flag', text, color })
  return [
    mark(endPrice - signedDiff, 'Stop-Loss', LION_LABEL_COLORS.stopLoss),
    mark(endPrice - 0.5 * signedDiff, '50%', LION_LABEL_COLORS.fifty),
    mark(endPrice - 1.5 * signedDiff, '50%', LION_LABEL_COLORS.fifty),
    mark(endPrice, 'Entry', LION_LABEL_COLORS.entry),
    mark(endPrice - 2 * signedDiff, 'Entry', LION_LABEL_COLORS.entry),
    mark(endPrice + 0.272 * signedDiff, 'T1', LION_LABEL_COLORS.t1),
    mark(endPrice - 2.272 * signedDiff, 'T1', LION_LABEL_COLORS.t1),
    mark(endPrice + 0.414 * signedDiff, 'T2', LION_LABEL_COLORS.t2),
    mark(endPrice - 2.414 * signedDiff, 'T2', LION_LABEL_COLORS.t2),
    mark(endPrice + 0.618 * signedDiff, 'T3', LION_LABEL_COLORS.t3),
    mark(endPrice - 2.618 * signedDiff, 'T3', LION_LABEL_COLORS.t3),
  ]
}

// ---------------------------------------------------------------------------
// Shadow 1SC — ported from the "Theshadow171" Fibo Storyline PDF, a
// smart-money-concepts setup: a Market Structure Shift (MSS) into a new
// trend, confirmed by a Break of Structure (BOS), with an Inducement (IDM)
// pullback swing in between anchoring a Fibonacci retracement — the "Zone
// Fibo Entry" — between the IDM point and the BOS extreme. Entry is the
// first candle to retrace into the 0.5-0.636 zone (the PDF's CE/"Buy model"
// & "Sell model" markers sit right on 0.5); target is the prior opposing
// swing extreme (the PDF's "TP LIQUIDITY").
//
// NOT ported: the PDF's separate "Ts" liquidity-sweep annotation and its
// Order-Block POI box aren't modeled as distinct steps — the swing point
// that originates the MSS already IS that local extreme (the thing price
// swept before reversing), so a dedicated sweep-detection pass would be
// redundant. This is a faithful structural approximation of a discretionary,
// hand-drawn strategy, not a certified 1:1 reproduction — the source has no
// numeric swing-lookback, so a standard 5-bar fractal is used (matches
// src/overlays/ict.ts's default).
// ---------------------------------------------------------------------------

const SHADOW_FIB_NEAR = 0.5 // CE — the PDF marks entries starting right at 0.5
const SHADOW_FIB_FAR = 0.636

interface ShadowSwing {
  index: number
  price: number
  isHigh: boolean
}

/** 5-bar (default) fractal swing highs/lows. */
function shadowSwings(candles: Candle[], lookback: number): ShadowSwing[] {
  const out: ShadowSwing[] = []
  const n = candles.length
  for (let i = lookback; i < n - lookback; i++) {
    const c = candles[i]
    let isHigh = true
    let isLow = true
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue
      if (candles[j].high >= c.high) isHigh = false
      if (candles[j].low <= c.low) isLow = false
    }
    if (isHigh) out.push({ index: i, price: c.high, isHigh: true })
    if (isLow) out.push({ index: i, price: c.low, isHigh: false })
  }
  return out
}

interface ShadowSetup {
  bullish: boolean
  idmIdx: number
  idmPrice: number
  bosIdx: number
  bosPrice: number
  zoneTop: number // nearer the BOS extreme (0.5 retrace)
  zoneBottom: number // deeper retrace (0.636)
  targetPrice: number // TP liquidity — prior opposing swing extreme
}

/**
 * Walks swings in order, tracking structure like ICT's BOS/CHoCH: a close
 * beyond the active swing extreme against the prevailing trend is the MSS: a
 * further close beyond the NEXT swing extreme, same direction, is the BOS
 * that confirms it. IDM is the deepest pullback swing between the two — the
 * point the Fibo (POI/"Zone Fibo Entry") is anchored from.
 */
function detectShadowSetups(candles: Candle[], lookback: number): ShadowSetup[] {
  const swings = shadowSwings(candles, lookback)
  const setups: ShadowSetup[] = []
  let trend: 'up' | 'down' | null = null
  let activeHigh: ShadowSwing | null = null
  let activeLow: ShadowSwing | null = null
  let priorHighBeforeLow: ShadowSwing | null = null // liquidity above, before the low that got swept
  let priorLowBeforeHigh: ShadowSwing | null = null
  let pending: { bullish: boolean; mssIdx: number; target: number } | null = null
  let si = 0

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    while (si < swings.length && swings[si].index <= i) {
      const s = swings[si++]
      if (s.isHigh) {
        priorLowBeforeHigh = activeLow
        activeHigh = s
      } else {
        priorHighBeforeLow = activeHigh
        activeLow = s
      }
    }

    // MSS: close breaks the active swing extreme against the prevailing trend.
    if (activeHigh && c.close > activeHigh.price && trend !== 'up') {
      pending = {
        bullish: true,
        mssIdx: i,
        target: priorHighBeforeLow ? Math.max(priorHighBeforeLow.price, activeHigh.price) : activeHigh.price,
      }
      trend = 'up'
      activeHigh = null
    } else if (activeLow && c.close < activeLow.price && trend !== 'down') {
      pending = {
        bullish: false,
        mssIdx: i,
        target: priorLowBeforeHigh ? Math.min(priorLowBeforeHigh.price, activeLow.price) : activeLow.price,
      }
      trend = 'down'
      activeLow = null
    }

    // BOS: a further close beyond the NEXT swing extreme, same direction, confirms — anchor the Fibo zone off the IDM pullback in between.
    if (pending?.bullish && trend === 'up' && activeHigh && c.close > activeHigh.price && i > pending.mssIdx) {
      let idmIdx = pending.mssIdx
      let idmPrice = Infinity
      for (let k = pending.mssIdx; k <= i; k++) {
        if (candles[k].low < idmPrice) {
          idmPrice = candles[k].low
          idmIdx = k
        }
      }
      const bosPrice = activeHigh.price
      const range = bosPrice - idmPrice
      if (range > 0) {
        setups.push({
          bullish: true,
          idmIdx,
          idmPrice,
          bosIdx: i,
          bosPrice,
          zoneTop: bosPrice - SHADOW_FIB_NEAR * range,
          zoneBottom: bosPrice - SHADOW_FIB_FAR * range,
          targetPrice: pending.target,
        })
      }
      pending = null
      activeHigh = null
    } else if (pending && !pending.bullish && trend === 'down' && activeLow && c.close < activeLow.price && i > pending.mssIdx) {
      let idmIdx = pending.mssIdx
      let idmPrice = -Infinity
      for (let k = pending.mssIdx; k <= i; k++) {
        if (candles[k].high > idmPrice) {
          idmPrice = candles[k].high
          idmIdx = k
        }
      }
      const bosPrice = activeLow.price
      const range = idmPrice - bosPrice
      if (range > 0) {
        setups.push({
          bullish: false,
          idmIdx,
          idmPrice,
          bosIdx: i,
          bosPrice,
          zoneTop: bosPrice + SHADOW_FIB_FAR * range,
          zoneBottom: bosPrice + SHADOW_FIB_NEAR * range,
          targetPrice: pending.target,
        })
      }
      pending = null
      activeLow = null
    }
  }
  return setups
}

export const shadow1sc: IndicatorDef = {
  id: 'shadow_1sc',
  label: 'Shadow 1SC (MSS/BOS Fibo)',
  shortLabel: 'Shadow 1SC',
  placement: 'overlay',
  params: [{ key: 'lookback', label: 'Swing lookback', default: 5, min: 2, max: 20, step: 1 }],
  compute(candles, params): IndicatorOutput[] {
    const lookback = Math.max(2, Math.round(params['lookback'] ?? 5))
    const setups = detectShadowSetups(candles, lookback)
    if (!setups.length) return []
    // Only the latest setup is plotted — older ones are either resolved or invalidated.
    const s = setups[setups.length - 1]
    const line = (price: number): (number | null)[] => {
      const values: (number | null)[] = new Array(candles.length).fill(null)
      for (let i = s.idmIdx; i < candles.length; i++) values[i] = price
      return values
    }
    return [
      { name: '0.5 (CE)', values: line(s.zoneTop), color: '#FFC107' },
      { name: '0.636', values: line(s.zoneBottom), color: '#FF9800' },
      { name: 'TP Liquidity', values: line(s.targetPrice), color: '#2962FF', style: 'dashed' },
    ]
  },
}

/** BUY/SELL fires on the first candle to retrace into the 0.5-0.636 zone after BOS, unless price already closed back past the IDM (setup invalidated). */
function shadow1scSignals(candles: Candle[], params: Record<string, number>): Signal[] {
  const lookback = Math.max(2, Math.round(params['lookback'] ?? 5))
  const setups = detectShadowSetups(candles, lookback)
  const out: Signal[] = []
  for (const s of setups) {
    for (let i = s.bosIdx + 1; i < candles.length; i++) {
      const c = candles[i]
      if (s.bullish) {
        if (c.close < s.idmPrice) break // invalidated — closed back below the IDM low
        if (c.low <= s.zoneTop && c.low >= s.zoneBottom) {
          out.push({ time: c.time, price: c.low, kind: 'buy', text: 'BUY' })
          break
        }
      } else {
        if (c.close > s.idmPrice) break // invalidated — closed back above the IDM high
        if (c.high >= s.zoneBottom && c.high <= s.zoneTop) {
          out.push({ time: c.time, price: c.high, kind: 'sell', text: 'SELL' })
          break
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Salaar — ported from "Salaar" (Pine v6 strategy): a MACD zero-line
// continuation system (bull cross while MACD > 0, bear cross while MACD < 0)
// optionally confirmed by an Awesome Oscillator ("JAILBAR") continuation
// arrow firing within a confluence window either side of the MACD cross,
// alternating-direction filtered (won't fire the same side twice without an
// opposite signal in between), with a fixed-points stop and an optional
// intraday session/time filter.
//
// NOT ported: strategy.entry/exit and position sizing (no backtest engine in
// this library — signals are markers only, same as every other indicator in
// this file); the MACD-zero-regime and in-session bgcolor shading (the
// library plots line series only, no background fills — see the port note
// on chotaPanditV3 above); the on-chart status table (no table widget in
// this overlay model, and Setup Checklist already covers a dashboard-style
// summary elsewhere). Pine's session filter uses a hardcoded "Asia/Kolkata"
// tz string; ported as a numeric UTC-offset-minutes param instead (IST =
// 330) since there's no timezone database here — this also makes the
// session usable for non-IST instruments, which the original couldn't do.
// ---------------------------------------------------------------------------

interface SalaarBar {
  buyHi: boolean // MACD + AO agree — Pine's traded "BUY ★"
  sellHi: boolean // MACD + AO agree — Pine's traded "SELL ★"
  buyStd: boolean // MACD alone (AO didn't confirm in time) — informational "BUY"
  sellStd: boolean // MACD alone — informational "SELL"
  aoBull: boolean
  aoBear: boolean
  slHit: boolean
  slHitLevel: number | null // the level that was hit, for the SL marker
  slLevel: number | null // current live stop level, for the plotted line — null while flat
}

function salaarCompute(candles: Candle[], params: Record<string, number>): SalaarBar[] {
  const n = candles.length
  const macdFastP = Math.max(1, Math.round(params['macdFast'] ?? 12))
  const macdSlowP = Math.max(1, Math.round(params['macdSlow'] ?? 26))
  const macdSigP = Math.max(1, Math.round(params['macdSig'] ?? 9))
  const aoFastP = Math.max(1, Math.round(params['aoFast'] ?? 5))
  const aoSlowP = Math.max(2, Math.round(params['aoSlow'] ?? 34))
  const aoLB = Math.max(1, Math.round(params['aoLB'] ?? 2))
  const useAO = (params['useAO'] ?? 1) !== 0
  const confWin = Math.max(1, Math.round(params['confWin'] ?? 5))
  const slPts = Math.max(0.0001, params['slPts'] ?? 10)
  const useSL = (params['useSL'] ?? 1) !== 0
  const useTimeFilter = (params['useTimeFilter'] ?? 1) !== 0
  const sessStartHHMM = Math.round(params['sessStartHHMM'] ?? 330)
  const sessEndHHMM = Math.round(params['sessEndHHMM'] ?? 1000)
  const tzOffsetMin = Math.round(params['tzOffsetMin'] ?? 330)

  const close = candles.map((c) => c.close)
  const maFast = ema(close, macdFastP)
  const maSlow = ema(close, macdSlowP)
  // ema(close, len) never actually returns null (seeds on the first bar) —
  // only its type says (number | null)[], so these casts are safe.
  const macdLine: number[] = maFast.map((f, i) => (f as number) - (maSlow[i] as number))
  const signalLine = ema(macdLine, macdSigP)

  const aoFastEma = ema(close, aoFastP)
  const aoSlowEma = ema(close, aoSlowP)
  const ao: number[] = aoFastEma.map((f, i) => (f as number) - (aoSlowEma[i] as number))

  const sessStartMin = Math.floor(sessStartHHMM / 100) * 60 + (sessStartHHMM % 100)
  const sessEndMin = Math.floor(sessEndHHMM / 100) * 60 + (sessEndHHMM % 100)
  const DAY_MS = 86_400_000
  const inSession = (t: number): boolean => {
    if (!useTimeFilter) return true
    const local = (((t + tzOffsetMin * 60_000) % DAY_MS) + DAY_MS) % DAY_MS
    const minutesOfDay = Math.floor(local / 60_000)
    return sessStartMin <= sessEndMin
      ? minutesOfDay >= sessStartMin && minutesOfDay < sessEndMin
      : minutesOfDay >= sessStartMin || minutesOfDay < sessEndMin // overnight session wraps midnight
  }

  const out: SalaarBar[] = new Array(n)
  let lastDir = 0 // 1 = last fired signal was buy, -1 = sell, 0 = none yet (Pine's `var lastDir`)
  let posDir = 0 // simulated open position, for SL tracking (Pine's `var posDir`)
  let slLevel: number | null = null
  let lastAoBull = -9999
  let lastAoBear = -9999
  let prevInSession = true

  for (let i = 0; i < n; i++) {
    const c = candles[i]
    const curInSession = inSession(c.time)
    const sessionEnded = useTimeFilter && i > 0 && prevInSession && !curInSession
    prevInSession = curInSession

    const m = macdLine[i]
    const s = signalLine[i] as number
    const mp = i > 0 ? macdLine[i - 1] : m
    const sp = i > 0 ? (signalLine[i - 1] as number) : s
    const bullCross = mp <= sp && m > s
    const bearCross = mp >= sp && m < s
    const macdBuy = bullCross && m > 0
    const macdSell = bearCross && m < 0

    const diffNow = i >= aoLB ? ao[i] - ao[i - aoLB] : null
    const diffPrev = i - 1 >= aoLB ? ao[i - 1] - ao[i - 1 - aoLB] : null
    const aoArrowUp = diffPrev !== null && diffNow !== null && diffPrev <= 0 && diffNow > 0
    const aoArrowDn = diffPrev !== null && diffNow !== null && diffPrev >= 0 && diffNow < 0
    const aoBull = aoArrowUp && ao[i] > 0
    const aoBear = aoArrowDn && ao[i] < 0
    if (aoBull) lastAoBull = i
    if (aoBear) lastAoBear = i
    const aoBullRecent = i - lastAoBull <= confWin
    const aoBearRecent = i - lastAoBear <= confWin

    const rawBuy = macdBuy && (!useAO || aoBullRecent) && curInSession
    const rawSell = macdSell && (!useAO || aoBearRecent) && curInSession
    const buyOK = rawBuy && lastDir !== 1
    const sellOK = rawSell && lastDir !== -1
    if (buyOK) lastDir = 1
    if (sellOK) lastDir = -1

    const buyHi = buyOK && aoBullRecent
    const sellHi = sellOK && aoBearRecent
    const buyStd = buyOK && !aoBullRecent
    const sellStd = sellOK && !aoBearRecent

    if (sessionEnded && posDir !== 0) {
      posDir = 0
      lastDir = 0
      slLevel = null
    }

    if (buyHi) {
      slLevel = c.close - slPts
      posDir = 1
    } else if (sellHi) {
      slLevel = c.close + slPts
      posDir = -1
    }

    let slHit = false
    let slHitLevel: number | null = null
    if (useSL && posDir === 1 && slLevel !== null && c.low <= slLevel) {
      slHit = true
      slHitLevel = slLevel
      posDir = 0
      lastDir = 0
    }
    if (useSL && posDir === -1 && slLevel !== null && c.high >= slLevel) {
      slHit = true
      slHitLevel = slLevel
      posDir = 0
      lastDir = 0
    }

    out[i] = {
      buyHi,
      sellHi,
      buyStd,
      sellStd,
      aoBull,
      aoBear,
      slHit,
      slHitLevel,
      slLevel: useSL && posDir !== 0 ? slLevel : null,
    }
  }
  return out
}

export const salaarIndicator: IndicatorDef = {
  id: 'salaar_macd_ao',
  label: 'Salaar (MACD + AO Continuation)',
  shortLabel: 'Salaar',
  placement: 'overlay',
  params: [
    { key: 'macdFast', label: 'MACD Fast', default: 12, min: 1, max: 200, step: 1 },
    { key: 'macdSlow', label: 'MACD Slow', default: 26, min: 1, max: 200, step: 1 },
    { key: 'macdSig', label: 'MACD Signal', default: 9, min: 1, max: 200, step: 1 },
    { key: 'aoFast', label: 'AO Fast', default: 5, min: 1, max: 200, step: 1 },
    { key: 'aoSlow', label: 'AO Slow', default: 34, min: 2, max: 200, step: 1 },
    { key: 'aoLB', label: 'AO Diff Lookback', default: 2, min: 1, max: 50, step: 1 },
    { key: 'useAO', label: 'Require AO Agreement (0/1)', default: 1, min: 0, max: 1, step: 1 },
    { key: 'confWin', label: 'Confluence Window (bars)', default: 5, min: 1, max: 20, step: 1 },
    { key: 'slPts', label: 'Stop Loss (points)', default: 10, min: 0.01, max: 100000, step: 0.01 },
    { key: 'useSL', label: 'Enable Stop Loss (0/1)', default: 1, min: 0, max: 1, step: 1 },
    { key: 'useTimeFilter', label: 'Enable Time Filter (0/1)', default: 1, min: 0, max: 1, step: 1 },
    { key: 'sessStartHHMM', label: 'Session Start (HHMM)', default: 330, min: 0, max: 2359, step: 1 },
    { key: 'sessEndHHMM', label: 'Session End (HHMM)', default: 1000, min: 0, max: 2359, step: 1 },
    { key: 'tzOffsetMin', label: 'Session TZ Offset (min)', default: 330, min: -720, max: 840, step: 15 },
  ],
  compute(candles, params): IndicatorOutput[] {
    const bars = salaarCompute(candles, params)
    return [
      { name: 'Stop Loss', values: bars.map((b) => b.slLevel), color: '#FFA726', style: 'dashed' },
    ]
  },
}

/** BUY ★/SELL ★ = MACD+AO confluence (Pine's traded signal); BUY/SELL = MACD alone; AO bull/bear = raw continuation arrows; SL = stop hit. */
function salaarSignals(candles: Candle[], params: Record<string, number>): Signal[] {
  const bars = salaarCompute(candles, params)
  const out: Signal[] = []
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const b = bars[i]
    if (b.buyHi) out.push({ time: c.time, price: c.low, kind: 'buy', text: 'BUY ★', color: '#00C853' })
    if (b.sellHi) out.push({ time: c.time, price: c.high, kind: 'sell', text: 'SELL ★', color: '#D50000' })
    if (b.buyStd) out.push({ time: c.time, price: c.low, kind: 'buy', text: 'BUY', color: 'rgba(0, 230, 118, 0.7)' })
    if (b.sellStd) out.push({ time: c.time, price: c.high, kind: 'sell', text: 'SELL', color: 'rgba(255, 82, 82, 0.7)' })
    if (b.aoBull) out.push({ time: c.time, price: c.low, kind: 'flag', text: '', shape: 'dot', color: 'rgba(0, 230, 118, 0.4)' })
    if (b.aoBear) out.push({ time: c.time, price: c.high, kind: 'flag', text: '', shape: 'dot', color: 'rgba(244, 67, 54, 0.4)' })
    if (b.slHit) out.push({ time: c.time, price: b.slHitLevel ?? c.close, kind: 'flag', text: 'SL', shape: 'dot', color: '#FF9800' })
  }
  return out
}

/** Indicator ids whose compute() needs the ENTIRE candle history recomputed
 *  every time — not a bounded-memory recurrence like an EMA/SMA that converges
 *  within a fixed trailing window. pane.ts's incremental "trailing warmup
 *  slice" cache (computeIndicatorOutputs) assumes the latter and must skip it
 *  for these, or a live tick's slice-local pivot search can miss/replace the
 *  leg a full recompute would find, silently freezing the plotted levels.
 *  See lionPivots/lionFindLeg above: the swing search needs pivots from the
 *  full loaded history, not just the last `warmupBars` candles. */
export const FULL_HISTORY_INDICATOR_IDS = new Set<string>([lionIndicator.id, shadow1sc.id, zigzagFib.id, sessionReversal.id, rangeBreakout.id, renkoFade.id, sessionsIndicator.id, sessionsV2Indicator.id, marketStructure.id, mtfCisd.id, hlBlocks.id, aiTrades.id, bulbArrow.id, flyingCpr.id, tpoFade.id, fvgMid.id, tpoTv.id, vwapEmaAngle.id, dcCprBb.id, nyFade.id])

const SIGNAL_SOURCES: Record<string, (candles: Candle[], params: Record<string, number>) => Signal[]> = {
  [chotaPanditV3.id]: chotaSignals,
  [hma31Supertrend.id]: hma31Signals,
  [hmaCoppockTrend.id]: hmaCoppockSignals,
  [ema47Supertrend.id]: ema47Signals,
  [blastCandle.id]: blastSignals,
  [daddyHome.id]: daddyHomeSignals,
  [candleDominance.id]: candleDominanceSignals,
  [lionIndicator.id]: lionSignals,
  [shadow1sc.id]: shadow1scSignals,
  [salaarIndicator.id]: salaarSignals,
}

/**
 * Canvas indicators: for plots an IndicatorOutput can't express (per-bar
 * colours, dots, fills, bar colouring, labels, boxes), an indicator may
 * compute a model and draw it on the pane's chart-synced overlay.
 */
export interface CanvasSource {
  compute(candles: Candle[], params: Record<string, number>, ctx: CanvasIndicatorContext): unknown
  draw(
    g: CanvasRenderingContext2D,
    conv: Converters,
    rect: { x: number; y: number; width: number; height: number },
    candles: Candle[],
    model: unknown,
    ctx: CanvasIndicatorContext,
  ): void
  /** Strategy-style indicators: their simulated trades, listed in the Strategy Tester while the indicator is visible. */
  strategy?: {
    name: string
    trades(model: unknown): StrategyTrade[]
  }
}
export type { CanvasIndicatorContext }

const CANVAS_SOURCES: Record<string, CanvasSource> = {
  [shankyCombo.id]: {
    compute: computeShankyModel,
    draw: (g, conv, rect, candles, model, ctx) => drawShankyCombo(g, conv, rect, candles, model as ShankyModel, ctx),
  },
  [zigzagFib.id]: {
    compute: computeZigzagFibModel,
    draw: (g, conv, rect, candles, model, ctx) => drawZigzagFib(g, conv, rect, candles, model as ZigzagFibModel, ctx),
  },
  [sessionReversal.id]: {
    compute: computeSessionReversalModel,
    draw: (g, conv, rect, candles, model, ctx) => drawSessionReversal(g, conv, rect, candles, model as SessionReversalModel, ctx),
  },
  [rangeBreakout.id]: {
    compute: computeRangeBreakoutModel,
    draw: (g, conv, rect, candles, model, ctx) => drawRangeBreakout(g, conv, rect, candles, model as RangeBreakoutModel, ctx),
    strategy: { name: 'IST 05:30–05:45 Range Breakout v2', trades: rangeBreakoutTrades },
  },
  [renkoFade.id]: {
    compute: computeRenkoFadeModel,
    draw: (g, conv, rect, candles, model, ctx) => drawRenkoFade(g, conv, rect, candles, model as RenkoFadeModel, ctx),
    strategy: { name: 'Renko Exhaustion Fade', trades: renkoFadeTrades },
  },
  [sessionsIndicator.id]: {
    compute: computeSessionsModel,
    draw: (g, conv, rect, candles, model, ctx) => drawSessions(g, conv, rect, candles, model as SessionsModel, ctx),
  },
  [sessionsV2Indicator.id]: {
    compute: computeSessionsV2Model,
    draw: (g, conv, rect, candles, model, ctx) => drawSessionsV2(g, conv, rect, candles, model as SessionsV2Model, ctx),
  },
  [marketStructure.id]: {
    compute: computeMarketStructureModel,
    draw: (g, conv, rect, candles, model, ctx) => drawMarketStructure(g, conv, rect, candles, model as MarketStructureModel, ctx),
    strategy: { name: 'Market Structure breaks (quality filtered)', trades: marketStructureTrades },
  },
  [theMap.id]: {
    compute: computeTheMapModel,
    draw: (g, conv, rect, candles, model, ctx) => drawTheMap(g, conv, rect, candles, model as TheMapModel, ctx),
  },
  [theMapV2.id]: {
    compute: computeTheMapV2Model,
    draw: (g, conv, rect, candles, model, ctx) => drawTheMapV2(g, conv, rect, candles, model as TheMapV2Model, ctx),
  },
  [theMapV3.id]: {
    compute: computeTheMapV3Model,
    draw: (g, conv, rect, candles, model, ctx) => drawTheMapV3(g, conv, rect, candles, model as TheMapV3Model, ctx),
    strategy: { name: 'MAP V3 · SYNDICATE playbook', trades: mapV3StrategyTrades },
  },
  [gexSabers.id]: {
    compute: computeGexSabersModel,
    draw: (g, conv, rect, candles, model, ctx) => drawGexSabers(g, conv, rect, candles, model as GexSabersModel, ctx),
  },
  [gexSummary.id]: {
    compute: computeGexSummaryModel,
    draw: (g, conv, rect, candles, model, ctx) => drawGexSummary(g, conv, rect, candles, model as GexSummaryModel, ctx),
  },
  [gexHeatmap.id]: {
    compute: computeGexHeatmapModel,
    draw: (g, conv, rect, candles, model, ctx) => drawGexHeatmap(g, conv, rect, candles, model as GexHeatmapModel, ctx),
  },
  [gexProfileSplit.id]: {
    compute: computeGexProfileModel,
    draw: (g, conv, rect, candles, model, ctx) => drawGexProfileSplit(g, conv, rect, candles, model as GexProfileModel, ctx),
  },
  [mtfCisd.id]: {
    compute: computeMtfCisdModel,
    draw: (g, conv, rect, candles, model, ctx) => drawMtfCisd(g, conv, rect, candles, model as MtfCisdModel, ctx),
  },
  [hlBlocks.id]: {
    compute: computeHlBlocksModel,
    draw: (g, conv, rect, candles, model) => drawHlBlocks(g, conv, rect, candles, model as HlBlocksModel),
  },
  [aiTrades.id]: {
    compute: computeAiTradesModel,
    draw: (g, conv, rect, candles, model, ctx) => drawAiTrades(g, conv, rect, candles, model as AiTradesModel, ctx),
  },
  [bulbArrow.id]: {
    compute: computeBulbArrowModel,
    draw: (g, conv, rect, candles, model, ctx) => drawBulbArrow(g, conv, rect, candles, model as BulbArrowModel, ctx),
  },
  [flyingCpr.id]: {
    compute: computeFlyingCprModel,
    draw: (g, conv, rect, candles, model, ctx) => drawFlyingCpr(g, conv, rect, candles, model as FlyingCprModel, ctx),
  },
  [tpoFade.id]: {
    compute: computeTpoFadeModel,
    draw: (g, conv, rect, candles, model, ctx) => drawTpoFade(g, conv, rect, candles, model as TpoFadeModel, ctx),
    strategy: { name: 'TPO VA Fade (prev-session value-area fade)', trades: tpoFadeTrades },
  },
  [fvgMid.id]: {
    compute: computeFvgMidModel,
    draw: (g, conv, rect, candles, model, ctx) => drawFvgMid(g, conv, rect, candles, model as FvgMidModel, ctx),
  },
  [tpoTv.id]: {
    compute: computeTpoTvModel,
    draw: (g, conv, rect, candles, model, ctx) => drawTpoTv(g, conv, rect, candles, model as TpoTvModel, ctx),
  },
  [vwapEmaAngle.id]: {
    compute: computeVwapEmaAngleModel,
    draw: (g, conv, rect, candles, model, ctx) => drawVwapEmaAngle(g, conv, rect, candles, model as VwapEmaAngleModel, ctx),
  },
  [dcCprBb.id]: {
    compute: computeDcCprBbModel,
    draw: (g, conv, rect, candles, model, ctx) => drawDcCprBb(g, conv, rect, candles, model as DcCprBbModel, ctx),
  },
  [nyFade.id]: {
    compute: computeNyFadeModel,
    draw: (g, conv, rect, candles, model, ctx) => drawNyFade(g, conv, rect, candles, model as NyFadeModel, ctx),
    strategy: { name: 'NY First-Hour Fade (sessions)', trades: nyFadeTrades },
  },
}

/** The canvas renderer for an indicator id, if it has one. */
export function getCanvasSource(id: string): CanvasSource | undefined {
  return CANVAS_SOURCES[id]
}

/** The signal generator for an indicator id, if it has one. */
export function getSignalSource(
  id: string,
): ((candles: Candle[], params: Record<string, number>) => Signal[]) | undefined {
  return SIGNAL_SOURCES[id]
}


// ---- registry: built-ins + custom ----

export const CUSTOM_INDICATORS: IndicatorDef[] = [
  chotaPanditV3,
  hma31Supertrend,
  hmaCoppockTrend,
  coppockCurveIndicator,
  parabolicSarIndicator,
  ema47Supertrend,
  blastCandle,
  daddyHome,
  candleDominance,
  lionIndicator,
  shadow1sc,
  salaarIndicator,
  shankyCombo,
  zigzagFib,
  sessionReversal,
  rangeBreakout,
  renkoFade,
  sessionsIndicator,
  sessionsV2Indicator,
  marketStructure,
  theMap,
  theMapV2,
  theMapV3,
  gexSabers,
  gexSummary,
  gexHeatmap,
  gexProfileSplit,
  mtfCisd,
  hlBlocks,
  aiTrades,
  bulbArrow,
  flyingCpr,
  tpoFade,
  fvgMid,
  tpoTv,
  vwapEmaAngle,
  dcCprBb,
  nyFade,
  vortex,
]

/** All indicators offered in the demo (built-ins first, then custom). */
export const ALL_INDICATORS: IndicatorDef[] = [...INDICATORS, ...CUSTOM_INDICATORS]

const customById = new Map(CUSTOM_INDICATORS.map((d) => [d.id, d]))

/** Look up any indicator by id — built-in or custom. */
export function resolveIndicator(id: string): IndicatorDef | undefined {
  return getIndicator(id) ?? customById.get(id)
}
