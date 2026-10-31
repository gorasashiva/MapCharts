/**
 * IV × FV Strategy — pure model behind ivFvStrategy.ts. Combines the two
 * studies backtested on weekday XAUTUSD 1m / 3m / 5m (May–Oct 2026):
 *
 *  1. FV signals (fvVwapEmaModel.ts, auto-tuned per timeframe): aligned flip
 *     / EMA21 pullback, within 0.75σ of VWAP, 03:30–18:00 IST. Stop at the
 *     fractal vector; half off at TP1 = 1R with the stop to breakeven; TP2 =
 *     3R or the next IV expected-move zone in the trade's direction, whichever
 *     is nearer, as long as that zone is at least `zoneMinR` R away. Capping
 *     at the zone matched or beat a flat 3R on every timeframe
 *     (1m +0.36R, 3m +0.42R, 5m +0.19R per trade after a $0.30 spread).
 *  2. Optional ±1× zone fade: a resting limit at the near edge of the
 *     session's ±1× EM zone (first touch only), stop just beyond the zone's
 *     far edge, target the previous close, flat at the session end. 64 trades,
 *     28% hit, +0.32R — a few big winners carry it, so it's off by default.
 *
 * Zones come from ivZonesModel.ts: prev close ± 0.5 / 1 / 1.5 × EM, EM from
 * the live option IV for today and realized vol for past sessions. Sessions
 * without zones (weekends on gold) get no fades and an uncapped 3R.
 */
import type { Candle } from '../core/types'
import { sessionIndex, SESSION_DAY_MS } from '../core/session'
import { computeFvVwapEma, FV_VWAP_EMA_DEFAULTS, type FvEntry, type FvTrade, type FvVwapEmaOptions } from './fvVwapEmaModel'
import type { OHLCBar } from './ivWallsModel'
import { computeIvZones, IV_ZONES_DEFAULTS, type IvZoneSession } from './ivZonesModel'

const MIN_MS = 60_000
const IST_OFFSET_MS = 330 * MIN_MS

/** Delta Exchange India: taker 0.05%, maker 0.02%, +18% GST on the fee. */
const FEE_TAKER = 0.0005 * 1.18
const FEE_MAKER = 0.0002 * 1.18

export interface IvFvStrategyOptions extends FvVwapEmaOptions {
  /** Cap TP2 at the next IV zone. */
  zoneTargets: boolean
  /** Only cap when that zone is at least this many R away. */
  zoneMinR: number
  /** Trade the ±1× zone fade too. */
  fadeSetup: boolean
  /** Typed IV % for the zones (e.g. GVZ); null = option IV today, HV before. */
  ivOverridePct: number | null
  hvLookback: number
}

export const IV_FV_STRATEGY_DEFAULTS: IvFvStrategyOptions = {
  ...FV_VWAP_EMA_DEFAULTS,
  zoneTargets: true,
  zoneMinR: 2,
  fadeSetup: false,
  ivOverridePct: null,
  hvLookback: 20,
}

export type IvFvTrade = Omit<FvTrade, 'setup'> & {
  setup: FvTrade['setup'] | 'fade'
  /** True when the final target is an IV zone (capped TP2, or a fade's prev-close target). */
  zoneTarget: boolean
}

export interface IvFvResult {
  trades: IvFvTrade[]
  /** Zones per session (used for targets and the card — not drawn). */
  zones: IvZoneSession[]
}

/** Zone edges price meets first coming from inside, plus the previous close. */
export function zoneLevels(z: IvZoneSession): number[] {
  const out = z.zones.map((q) => (q.kind === 'res' ? q.bottom : q.top))
  if (z.prevClose !== null) out.push(z.prevClose)
  return out
}

function istMinutes(time: number): number {
  return Math.floor(((time + IST_OFFSET_MS) % SESSION_DAY_MS) / MIN_MS)
}

/**
 * First-touch ±1× fades over the chart candles, one per side per session.
 * Fills at the near edge (or the open if a bar gaps through it); the stop is
 * checked from the fill bar on, the target from the next bar.
 */
function fadeTrades(candles: Candle[], zones: Map<number, IvZoneSession>, opts: IvFvStrategyOptions, openHourUTC: number): IvFvTrade[] {
  const out: IvFvTrade[] = []
  const n = candles.length
  let a = 0
  while (a < n) {
    const sess = sessionIndex(candles[a].time, openHourUTC)
    let b = a
    while (b < n && sessionIndex(candles[b].time, openHourUTC) === sess) b++
    const z = zones.get(sess)
    if (z && z.prevClose !== null && z.em !== null) {
      const P = z.prevClose
      const em = z.em
      for (const kind of ['res', 'sup'] as const) {
        const zone = z.zones.find((q) => q.tag === (kind === 'res' ? '+1x' : '-1x'))
        if (!zone) continue
        const s: 1 | -1 = kind === 'res' ? -1 : 1 // fade: short the upper zone, buy the lower
        const near = kind === 'res' ? zone.bottom : zone.top
        const stop = kind === 'res' ? zone.top + 0.05 * em : zone.bottom - 0.05 * em
        let j = a
        for (; j < b; j++) {
          const m = istMinutes(candles[j].time)
          if (opts.entryWindowIST && !(m >= opts.entryWindowIST[0] && m < opts.entryWindowIST[1])) continue
          if (kind === 'res' ? candles[j].high >= near : candles[j].low <= near) break
        }
        if (j >= b) continue
        const c0 = candles[j]
        const entry = kind === 'res' ? Math.max(near, c0.open) : Math.min(near, c0.open)
        const risk = (entry - stop) * s
        if (!(risk > 0)) continue
        const t: IvFvTrade = {
          setup: 'fade',
          side: s === 1 ? 'long' : 'short',
          entryTime: c0.time,
          entryPrice: entry,
          stop,
          tp1: null,
          tp1Time: null,
          target: P,
          exitTime: null,
          exitPrice: null,
          exitReason: null,
          avgExitPrice: null,
          barHigh: c0.high,
          barLow: c0.low,
          r: 0,
          grossR: 0,
          zoneTarget: true,
        }
        for (let k = j; k < b; k++) {
          const c = candles[k]
          if (s === 1 ? c.low <= stop : c.high >= stop) {
            Object.assign(t, { exitTime: c.time, exitPrice: stop, exitReason: 'SL' })
            break
          }
          if (k > j && (s === 1 ? c.high >= P : c.low <= P)) {
            Object.assign(t, { exitTime: c.time, exitPrice: P, exitReason: 'TP' })
            break
          }
        }
        // The session is over once a later session's candle exists.
        if (t.exitTime === null && b < n) Object.assign(t, { exitTime: candles[b - 1].time, exitPrice: candles[b - 1].close, exitReason: 'Day end' })
        const px = t.exitPrice ?? candles[n - 1].close
        const gross = (px - entry) * s
        const fees = entry * FEE_MAKER + px * (t.exitReason === 'TP' ? FEE_MAKER : FEE_TAKER)
        t.r = (gross - fees) / risk
        t.grossR = gross / risk
        if (t.exitTime !== null) t.avgExitPrice = px
        out.push(t)
      }
    }
    a = b
  }
  return out
}

/**
 * Trades for the chart candles. `hourly` should reach back over the chart's
 * first session plus `hvLookback` sessions; `liveIV` is today's ATM option IV
 * (decimal) or null.
 */
export function computeIvFvStrategy(
  candles: Candle[],
  hourly: OHLCBar[],
  opts: IvFvStrategyOptions,
  openHourUTC: number,
  closedWeekends: boolean,
  liveIV: number | null,
  barMs: number,
  lastClosed = true,
): IvFvResult {
  const zoneOpts = { ...IV_ZONES_DEFAULTS, showHistory: true, historyDays: 10_000, ivOverridePct: opts.ivOverridePct, hvLookback: opts.hvLookback }
  const zones = hourly.length ? computeIvZones(hourly, zoneOpts, openHourUTC, closedWeekends, liveIV) : []
  const bySession = new Map<number, IvZoneSession>()
  for (const z of zones) bySession.set(sessionIndex(z.start, openHourUTC), z)

  const capped = new Set<number>()
  const cap = (e: FvEntry): number | null => {
    const z = bySession.get(sessionIndex(e.entryTime, openHourUTC))
    if (!z || z.em === null) return null
    const ahead = zoneLevels(z).filter((lv) => (lv - e.entry) * e.side >= opts.zoneMinR * e.risk)
    if (ahead.length === 0) return null
    const next = e.side === 1 ? Math.min(...ahead) : Math.max(...ahead)
    if ((next - e.target) * e.side >= 0) return null // 3R comes first
    capped.add(e.entryTime)
    return next
  }
  const fv = computeFvVwapEma(candles, opts, openHourUTC, barMs, lastClosed, opts.zoneTargets ? cap : undefined)
  const trades: IvFvTrade[] = fv.trades.map((t) => ({ ...t, zoneTarget: capped.has(t.entryTime) }))
  if (opts.fadeSetup) trades.push(...fadeTrades(candles, bySession, opts, openHourUTC))
  trades.sort((x, y) => x.entryTime - y.entryTime)
  return { trades, zones }
}
