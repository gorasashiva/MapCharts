/**
 * Zigzag Fib Pullback — swing legs from a pivot zigzag, a limit order at a
 * Fibonacci retracement of each new leg, stop / target at fib levels.
 *
 * Long:  up leg (low -> high), fib drawn top -> bottom, buy at `entryFib`.
 * Short: down leg (high -> low), fib drawn bottom -> top, sell at `entryFib`.
 * Fib 0 is the leg's end, 1 its start, negatives are extensions past the end.
 *
 * Defaults are the London-session setup researched on Delta's XAUTUSD /
 * PAXGUSD 5m data (Oct 2026). Orders only fill inside the session window and
 * an unfilled order is cancelled when the window closes, when price makes a
 * new extreme past the leg end, or when the next leg forms.
 *
 * Pure — no DOM / engine. No look-ahead: a pivot is used only once its
 * `depth` right-side bars have closed.
 */

export interface ZzFibBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface ZzFibOptions {
  depth: number // pivot bars each side
  minLegAtr: number // min leg size in ATR(14) multiples
  entryFib: number
  stopFib: number
  targetFib: number
  minStopBps: number // skip setups whose stop is closer than this (fees dominate)
  sessionStartUTC: number // hours, fractional ok; start === end => all day
  sessionEndUTC: number
  weekdaysOnly: boolean
  maxHoldHours: number
  makerFee: number // fraction, incl. tax
  takerFee: number
}

export const ZZFIB_DEFAULTS: ZzFibOptions = {
  depth: 12,
  minLegAtr: 5,
  entryFib: 0.382,
  stopFib: 1.05,
  targetFib: -0.272,
  minStopBps: 40,
  sessionStartUTC: 7, // 12:30 IST
  sessionEndUTC: 12, // 17:30 IST
  weekdaysOnly: true,
  maxHoldHours: 24,
  // Delta India futures: maker 0.02% / taker 0.05%, plus 18% GST.
  makerFee: 0.0002 * 1.18,
  takerFee: 0.0005 * 1.18,
}

export interface ZzFibPivot {
  time: number
  price: number
  high: boolean
}

export type ZzFibStatus = 'pending' | 'cancelled' | 'open' | 'closed'

export interface ZzFibSetup {
  dir: 1 | -1
  legStart: { time: number; price: number }
  legEnd: { time: number; price: number }
  armedTime: number // bar the order goes live
  entry: number
  stop: number
  target: number
  status: ZzFibStatus
  /** Last bar the order was working (pending / cancelled) — or the fill bar. */
  pendingEndTime: number
  fillTime?: number
  fillPrice?: number
  exitTime?: number
  exitPrice?: number
  exitReason?: 'TP' | 'SL' | 'TIME'
  /** Net of fees, in multiples of the initial risk. */
  r?: number
}

export interface ZzFibResult {
  pivots: ZzFibPivot[]
  setups: ZzFibSetup[]
  stats: { trades: number; wins: number; avgR: number; totalR: number }
}

const HOUR_MS = 3_600_000

export function inZzFibSession(time: number, o: Pick<ZzFibOptions, 'sessionStartUTC' | 'sessionEndUTC' | 'weekdaysOnly'>): boolean {
  const d = new Date(time)
  if (o.weekdaysOnly) {
    const wd = d.getUTCDay()
    if (wd === 0 || wd === 6) return false
  }
  if (o.sessionStartUTC === o.sessionEndUTC) return true
  const h = d.getUTCHours() + d.getUTCMinutes() / 60
  const s = ((o.sessionStartUTC % 24) + 24) % 24
  const e = ((o.sessionEndUTC % 24) + 24) % 24
  return s < e ? h >= s && h < e : h >= s || h < e
}

function atr14(bars: ZzFibBar[]): number[] {
  const n = 14
  const out = new Array<number>(bars.length).fill(NaN)
  let sum = 0
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close))
    if (i <= n) {
      sum += tr
      if (i === n) out[i] = sum / n
    } else out[i] = (out[i - 1] * (n - 1) + tr) / n
  }
  return out
}

interface Leg {
  dir: 1 | -1
  start: { i: number; price: number }
  end: { i: number; price: number }
  confirm: number // first bar the leg is known on (pivot + depth + 1)
}

export function computeZigzagFib(bars: ZzFibBar[], opts: Partial<ZzFibOptions> = {}): ZzFibResult {
  const o = { ...ZZFIB_DEFAULTS, ...opts }
  const depth = Math.max(1, Math.round(o.depth))
  const atr = atr14(bars)
  const pivots: { i: number; price: number; high: boolean }[] = []
  const legs: Leg[] = []

  for (let c = 2 * depth; c < bars.length; c++) {
    const p = c - depth
    let isH = true
    let isL = true
    for (let k = p - depth; k <= p + depth; k++) {
      if (k === p) continue
      if (bars[k].high >= bars[p].high) isH = false
      if (bars[k].low <= bars[p].low) isL = false
    }
    for (const high of [true, false]) {
      if (high ? !isH : !isL) continue
      const price = high ? bars[p].high : bars[p].low
      const last = pivots[pivots.length - 1]
      if (last && last.high === high) {
        // Same side again: a more extreme pivot extends the current leg.
        if (high ? price <= last.price : price >= last.price) continue
        pivots[pivots.length - 1] = { i: p, price, high }
      } else pivots.push({ i: p, price, high })
      const prev = pivots[pivots.length - 2]
      if (!prev) continue
      if (!(Math.abs(price - prev.price) >= o.minLegAtr * atr[p])) continue
      legs.push({ dir: high ? 1 : -1, start: { i: prev.i, price: prev.price }, end: { i: p, price }, confirm: c + 1 })
    }
  }

  const setups: ZzFibSetup[] = []
  let busyUntil = 0 // one position at a time
  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li]
    if (leg.confirm >= bars.length || leg.confirm < busyUntil) continue
    const next = legs[li + 1]
    const d = leg.dir
    const end = leg.end.price
    const range = Math.abs(end - leg.start.price)
    const lvl = (f: number): number => end - d * f * range
    const entry = lvl(o.entryFib)
    const stop = lvl(o.stopFib)
    const target = lvl(o.targetFib)
    if ((Math.abs(entry - stop) / entry) * 1e4 < o.minStopBps) continue
    const s: ZzFibSetup = {
      dir: d,
      legStart: { time: bars[leg.start.i].time, price: leg.start.price },
      legEnd: { time: bars[leg.end.i].time, price: end },
      armedTime: bars[leg.confirm].time,
      entry,
      stop,
      target,
      status: 'pending',
      pendingEndTime: bars[leg.confirm].time,
    }
    setups.push(s)

    let fill = -1
    const stopAt = next ? next.confirm : bars.length
    for (let k = leg.confirm; k < bars.length; k++) {
      const b = bars[k]
      s.pendingEndTime = b.time
      if (k >= stopAt || (d === 1 ? b.high > end : b.low < end)) {
        s.status = 'cancelled'
        break
      }
      const inSess = inZzFibSession(b.time, o)
      if (!inSess && k > leg.confirm && inZzFibSession(bars[k - 1].time, o)) {
        s.status = 'cancelled' // window closed unfilled
        break
      }
      if (inSess && (d === 1 ? b.low <= entry : b.high >= entry)) {
        fill = k
        break
      }
    }
    if (fill < 0) continue

    const fillPrice = d === 1 ? Math.min(bars[fill].open, entry) : Math.max(bars[fill].open, entry)
    if (d === 1 ? fillPrice <= stop : fillPrice >= stop) {
      s.status = 'cancelled' // gapped through the stop
      continue
    }
    s.status = 'open'
    s.fillTime = bars[fill].time
    s.fillPrice = fillPrice
    busyUntil = bars.length
    for (let x = fill; x < bars.length; x++) {
      const b = bars[x]
      let reason: 'TP' | 'SL' | 'TIME' | null = null
      let px = 0
      // Stop first on the fill bar and on any bar that touches both (conservative).
      if (d === 1 ? b.low <= stop : b.high >= stop) [reason, px] = ['SL', stop]
      else if (x > fill && (d === 1 ? b.high >= target : b.low <= target)) [reason, px] = ['TP', target]
      else if (b.time - bars[fill].time >= o.maxHoldHours * HOUR_MS) [reason, px] = ['TIME', b.close]
      if (!reason) continue
      const fees = fillPrice * o.makerFee + px * (reason === 'TP' ? o.makerFee : o.takerFee)
      s.status = 'closed'
      s.exitTime = b.time
      s.exitPrice = px
      s.exitReason = reason
      s.r = (d * (px - fillPrice) - fees) / Math.abs(fillPrice - stop)
      busyUntil = x + 1
      break
    }
  }

  const closed = setups.filter((s) => s.status === 'closed')
  const totalR = closed.reduce((a, s) => a + (s.r ?? 0), 0)
  return {
    pivots: pivots.map((p) => ({ time: bars[p.i].time, price: p.price, high: p.high })),
    setups,
    stats: { trades: closed.length, wins: closed.filter((s) => (s.r ?? 0) > 0).length, avgR: closed.length ? totalR / closed.length : 0, totalR },
  }
}
