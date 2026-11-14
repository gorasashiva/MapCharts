// Volume Profile Playbook "FADE" with a minimum reward:risk — the rules tested in
// research/vp-playbook-study.ts and research/vp-fade-ltf.ts (gold, 15m recommended, 3m candidate).
//
// Day: gold days start at 18:00 New York (DST aware); other markets at 00:00 UTC.
// The previous day's profile (bullseyeModel.buildProfile) gives VAH / VAL / POC.
// Only days that open inside the previous value area trade.
// Short: the first bar that tags VAH (high ≥ VAH − 0.06·VA) and closes back below VAH.
// Long:  the first bar that tags VAL (low ≤ VAL + 0.06·VA) and closes back above VAL.
// Entry at the next bar's open. Stop = edge ± stopK·VA. T1 = POC, T2 = the far edge ∓ 0.08·VA.
// Skipped (but still reported) when T1 is less than minRR × risk away. Only the first touch of each
// edge counts; one position at a time (touches while a trade is open are ignored).
// Management: half at T1 and the stop moves to entry; the rest at T2, or at the day's last close.

import type { Candle } from '../core/types'
import { buildProfile } from './bullseyeModel'
import { nyOffsetMinutes } from './nyClock'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export interface VpFadeOptions {
  /** Stop beyond the value edge, in value-area widths. */
  stopK: number
  /** Minimum T1 reward : risk. */
  minRR: number
  /** Round-trip cost in basis points of the entry price (for net R). */
  costBps: number
  /** Gold-style day start (18:00 New York); false = 00:00 UTC. */
  goldDay: boolean
}

export const VP_FADE_DEFAULTS: VpFadeOptions = { stopK: 0.2, minRR: 2, costBps: 4, goldDay: true }

export interface VpFadeDay {
  start: number
  end: number
  vah: number
  val: number
  poc: number
  /** Where the day opened against the previous value area. */
  open: 'above' | 'inside' | 'below'
}

export type VpFadeExit = 'SL' | 'T1+BE' | 'T1+T2' | 'T1+close' | 'Day end'

export interface VpFadeSignal {
  side: 'long' | 'short'
  /** Signal bar (the bar that tagged the edge and closed back inside). */
  signalTime: number
  entryTime: number
  entry: number
  stop: number
  t1: number
  t2: number
  /** Planned reward : risk to T1 and to T2. */
  rr1: number
  rr2: number
  /** false: tagged, but T1 was closer than minRR × risk, so no trade. */
  taken: boolean
  /** Set once the trade has resolved (or its day ended); null while open. */
  exit: null | {
    time: number
    /** Blended exit price over both halves. */
    price: number
    reason: VpFadeExit
    t1Hit: boolean
    t1Time: number | null
    grossR: number
    netR: number
  }
}

export interface VpFadeResult {
  days: VpFadeDay[]
  signals: VpFadeSignal[]
}

function dayKey(t: number, gold: boolean): number {
  return gold ? Math.floor((t + nyOffsetMinutes(t) * MIN - 18 * HOUR) / DAY) : Math.floor(t / DAY)
}

function splitDays(c: Candle[], gold: boolean): Candle[][] {
  const out: Candle[][] = []
  let key: number | null = null
  for (const b of c) {
    const k = dayKey(b.time, gold)
    if (k !== key) {
      out.push([])
      key = k
    }
    out[out.length - 1].push(b)
  }
  return out
}

/**
 * Manage one trade from bar i. `dayComplete` = false leaves a still-running trade open
 * (exit null) instead of closing it at the last loaded bar.
 */
function manage(bars: Candle[], i: number, s: VpFadeSignal, dayComplete: boolean, costBps: number): { exit: VpFadeSignal['exit']; endIdx: number } {
  const long = s.side === 'long'
  const risk = Math.abs(s.entry - s.stop)
  const leg = (px: number): number => (long ? px - s.entry : s.entry - px)
  let half1: number | null = null
  let t1Time: number | null = null
  let stop = s.stop
  const done = (k: number, price: number, reason: VpFadeExit): { exit: VpFadeSignal['exit']; endIdx: number } => {
    const grossPx = half1 !== null ? 0.5 * leg(half1) + 0.5 * leg(price) : leg(price)
    const cost = (s.entry * costBps) / 10_000
    const blended = long ? s.entry + grossPx : s.entry - grossPx
    return { exit: { time: bars[k].time, price: blended, reason, t1Hit: half1 !== null, t1Time, grossR: grossPx / risk, netR: (grossPx - cost) / risk }, endIdx: k }
  }
  for (let k = i; k < bars.length; k++) {
    const b = bars[k]
    if (long ? b.low <= stop : b.high >= stop) return done(k, stop, half1 !== null ? 'T1+BE' : 'SL')
    if (half1 === null && (long ? b.high >= s.t1 : b.low <= s.t1)) {
      half1 = s.t1
      t1Time = b.time
      stop = s.entry
    }
    if (half1 !== null && (long ? b.high >= s.t2 : b.low <= s.t2)) return done(k, s.t2, 'T1+T2')
  }
  if (!dayComplete) return { exit: null, endIdx: bars.length - 1 }
  const last = bars.length - 1
  return done(last, bars[last].close, half1 !== null ? 'T1+close' : 'Day end')
}

/** The last day is treated as still running (open trades keep exit = null). */
export function computeVpFade(candles: Candle[], opts: Partial<VpFadeOptions> = {}): VpFadeResult {
  const o = { ...VP_FADE_DEFAULTS, ...opts }
  const ds = splitDays(candles, o.goldDay).filter((d) => d.length >= 6)
  const days: VpFadeDay[] = []
  const signals: VpFadeSignal[] = []
  for (let di = 1; di < ds.length; di++) {
    const prev = buildProfile(ds[di - 1], 'cash', true)
    if (!prev) continue
    const { vah, val, poc } = prev
    const R = vah - val
    if (!(R > 0)) continue
    const bars = ds[di]
    const open = bars[0].open
    const loc: VpFadeDay['open'] = open > vah ? 'above' : open < val ? 'below' : 'inside'
    days.push({ start: bars[0].time, end: bars[bars.length - 1].time, vah, val, poc, open: loc })
    if (loc !== 'inside') continue
    const dayComplete = di < ds.length - 1
    const used = { H: false, L: false }
    let busyUntil = -1
    for (let i = 0; i < bars.length - 1; i++) {
      if (i <= busyUntil) continue
      const b = bars[i]
      const tryFade = (long: boolean): boolean => {
        const side = long ? 'L' : 'H'
        if (used[side]) return false
        const tag = long ? b.low <= val + 0.06 * R && b.close > val : b.high >= vah - 0.06 * R && b.close < vah
        if (!tag) return false
        used[side] = true
        const entry = bars[i + 1].open
        const stop = long ? val - o.stopK * R : vah + o.stopK * R
        const t1 = poc
        const t2 = long ? vah - 0.08 * R : val + 0.08 * R
        const risk = long ? entry - stop : stop - entry
        if (!(risk > 0)) return false
        const reward = (px: number): number => (long ? px - entry : entry - px)
        const s: VpFadeSignal = {
          side: long ? 'long' : 'short',
          signalTime: b.time,
          entryTime: bars[i + 1].time,
          entry,
          stop,
          t1,
          t2,
          rr1: reward(t1) / risk,
          rr2: reward(t2) / risk,
          taken: reward(t1) >= o.minRR * risk,
          exit: null,
        }
        signals.push(s)
        if (!s.taken) return false
        const m = manage(bars, i + 1, s, dayComplete, o.costBps)
        s.exit = m.exit
        busyUntil = m.exit ? m.endIdx : bars.length
        return true
      }
      if (!tryFade(false)) tryFade(true)
    }
  }
  return { days, signals }
}
