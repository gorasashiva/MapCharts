/**
 * IST 05:30–05:45 Range Breakout v2 — port of "5.30-5.45 breakout v2.pine" (Pine v6 strategy).
 *
 * Each day the high / low of the range window (default 05:30–05:45 IST) is
 * recorded. Once the window closes, a bar CLOSING above the high goes long, below
 * the low goes short. Stop = other side of the range, target = R × that distance
 * (or fixed % distances in "average run-up / drawdown" mode). One long and one
 * short per day at most; the opposite-direction trade only after the first lost
 * (optional). Anything still open is closed at the next day's range start.
 * Filters: Mon–Fri only, skip Fridays, minimum range size, direction, entry
 * window. Optional profit lock moves the stop into profit after +X R.
 *
 * Fill model = TradingView's broker emulator, as the Pine strategy runs:
 *   - orders placed on a bar's close fill at the NEXT bar's open (entries and
 *     the new-day close_all);
 *   - stop / limit fill intrabar along TV's assumed path (open -> nearer
 *     extreme -> farther extreme -> close); an open beyond the level fills at
 *     the open;
 *   - the profit-lock stop update is decided on a bar's close and works from
 *     the next bar;
 *   - size = `pctEquity` % of equity at the signal close (percent_of_equity).
 *
 * Pure and bar-by-bar with no look-ahead: a clipped series (bar replay) gives
 * exactly the state the strategy had at that bar, with the trade at the
 * cursor left open.
 */

export interface RbBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface RbOptions {
  /** Range window [start, end) in IST minutes of day. */
  rangeStart: number
  rangeEnd: number
  exitMode: 'range' | 'avg'
  rr: number
  avgRunupPct: number
  avgDrawPct: number
  onlyAfterLoss: boolean
  weekdaysOnly: boolean
  skipFriday: boolean
  minRangeBps: number
  direction: 'both' | 'long' | 'short'
  useEntryWin: boolean
  /** Entry window [start, end) in IST minutes of day. */
  entryStart: number
  entryEnd: number
  useLock: boolean
  lockAtR: number
  lockToR: number
  initialCapital: number
  pctEquity: number
}

export const RB_DEFAULTS: RbOptions = {
  rangeStart: 5 * 60 + 30,
  rangeEnd: 5 * 60 + 45,
  exitMode: 'range',
  rr: 3,
  avgRunupPct: 0.5,
  avgDrawPct: 0.22,
  onlyAfterLoss: true,
  weekdaysOnly: true,
  skipFriday: true,
  minRangeBps: 0,
  direction: 'both',
  useEntryWin: false,
  entryStart: 5 * 60 + 45,
  entryEnd: 8 * 60,
  useLock: false,
  lockAtR: 0.75,
  lockToR: 0.25,
  initialCapital: 10_000,
  pctEquity: 10,
}

export interface RbDay {
  /** First bar of the range window. */
  start: number
  /** Last bar inside the range window. */
  windowEnd: number
  /** Bar the range became tradable on (first bar after the window); undefined while still building. */
  readyTime?: number
  /** Last bar before the next day's range (or the last loaded bar). */
  end: number
  high: number
  low: number
  /** False when a filter (weekend / Friday) skips the day. */
  tradable: boolean
}
export interface RbTrade {
  dir: 1 | -1
  signalTime: number
  entryTime: number
  entry: number
  /** Initial stop / target. */
  stop: number
  target: number
  /** Profit-lock stop moves: from `time` on, the stop is `price`. */
  stopMoves: { time: number; price: number }[]
  qty: number
  exitTime: number | null
  exitPrice: number | null
  exitReason?: 'TP' | 'SL' | 'Lock stop' | 'New day'
  pnl?: number
  /** Result in multiples of the initial risk (entry -> initial stop). */
  r?: number
}
export interface RbSignal {
  time: number
  dir: 1 | -1
}
export interface RbResult {
  days: RbDay[]
  trades: RbTrade[]
  signals: RbSignal[]
  /** Order placed on the last bar's close, filling at the next open (shown as a pending entry). */
  pending: { dir: 1 | -1; stop: number; target: number } | null
  equity: number
  /** Chart timeframe above 15 minutes — the Pine script refuses to run there. */
  tfTooLarge: boolean
}

const MIN = 60_000
const IST = 330 * MIN

function inWin(m: number, s: number, e: number): boolean {
  return s < e ? m >= s && m < e : m >= s || m < e
}

export function computeRangeBreakout(bars: RbBar[], opts: Partial<RbOptions> = {}): RbResult {
  const o: RbOptions = { ...RB_DEFAULTS, ...opts }
  const res: RbResult = { days: [], trades: [], signals: [], pending: null, equity: o.initialCapital, tfTooLarge: false }
  if (bars.length > 1 && bars[bars.length - 1].time - bars[bars.length - 2].time > 15 * MIN) {
    res.tfTooLarge = true
    return res
  }

  let equity = o.initialCapital
  let rHi = Number.NaN
  let rLo = Number.NaN
  let rangeReady = false
  let longDone = false
  let shortDone = false
  let dayOK = true
  let day: RbDay | null = null
  let pos: (RbTrade & { sl: number; risk: number; locked: boolean }) | null = null
  interface PendingEntry {
    dir: 1 | -1
    qty: number
    stop: number
    target: number
    signalTime: number
  }
  let pendEntry: PendingEntry | null = null
  let pendClose = false
  let lastProfit = 0
  let nClosed = 0

  const istMin = (t: number): number => Math.floor(((t + IST) % 86_400_000) / MIN)
  const inRangeAt = (t: number): boolean => inWin(istMin(t), o.rangeStart, o.rangeEnd)

  const close = (t: number, px: number, reason: RbTrade['exitReason']): void => {
    const p = pos!
    const pnl = p.dir * (px - p.entry) * p.qty
    equity += pnl
    p.exitTime = t
    p.exitPrice = px
    p.exitReason = reason
    p.pnl = pnl
    p.r = p.risk > 0 ? (p.dir * (px - p.entry)) / p.risk : 0
    lastProfit = pnl
    nClosed++
    pos = null
  }
  const exits = (b: RbBar): void => {
    if (!pos) return
    const { dir, sl, target } = pos
    const stopReason = pos.locked ? 'Lock stop' : 'SL'
    if (dir === 1 ? b.open <= sl : b.open >= sl) return close(b.time, b.open, stopReason)
    if (dir === 1 ? b.open >= target : b.open <= target) return close(b.time, b.open, 'TP')
    const highFirst = Math.abs(b.high - b.open) < Math.abs(b.open - b.low)
    for (const up of highFirst ? [true, false] : [false, true]) {
      if (up) {
        if (dir === 1 && b.high >= target) return close(b.time, target, 'TP')
        if (dir === -1 && b.high >= sl) return close(b.time, sl, stopReason)
      } else {
        if (dir === 1 && b.low <= sl) return close(b.time, sl, stopReason)
        if (dir === -1 && b.low <= target) return close(b.time, target, 'TP')
      }
    }
  }

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]

    // ---- fills at this bar's open (orders from the previous close) ----
    if (pendClose && pos) close(b.time, b.open, 'New day')
    pendClose = false
    if (pendEntry && !pos) {
      const e: PendingEntry = pendEntry
      pos = {
        dir: e.dir, signalTime: e.signalTime, entryTime: b.time, entry: b.open, stop: e.stop, target: e.target, stopMoves: [], qty: e.qty,
        exitTime: null, exitPrice: null, sl: e.stop, risk: Math.abs(b.open - e.stop), locked: false,
      }
      res.trades.push(pos)
    }
    pendEntry = null
    exits(b)

    // ---- the script, on this bar's close ----
    const inRange = inRangeAt(b.time)
    const prevIn = i > 0 && inRangeAt(bars[i - 1].time)
    if (inRange && !prevIn) {
      if (pos) pendClose = true // strategy.close_all -> next open
      rHi = b.high
      rLo = b.low
      rangeReady = false
      longDone = false
      shortDone = false
      const dow = new Date(b.time + IST).getUTCDay()
      dayOK = (!o.weekdaysOnly || (dow !== 0 && dow !== 6)) && !(o.skipFriday && dow === 5)
      day = { start: b.time, windowEnd: b.time, end: b.time, high: b.high, low: b.low, tradable: dayOK }
      res.days.push(day)
    } else if (inRange) {
      rHi = Math.max(rHi, b.high)
      rLo = Math.min(rLo, b.low)
      if (day) Object.assign(day, { windowEnd: b.time, high: rHi, low: rLo })
    }
    if (!inRange && prevIn) {
      rangeReady = true
      if (day) day.readyTime = b.time
    }
    if (day) day.end = b.time

    const lastLost = nClosed > 0 && lastProfit < 0
    const longAllowed = !longDone && (!shortDone || !o.onlyAfterLoss || lastLost)
    const shortAllowed = !shortDone && (!longDone || !o.onlyAfterLoss || lastLost)
    const rangeBps = rLo > 0 ? ((rHi - rLo) / rLo) * 10_000 : 0
    const rangeOK = o.minRangeBps <= 0 || rangeBps >= o.minRangeBps
    const entryOK = !o.useEntryWin || inWin(istMin(b.time), o.entryStart, o.entryEnd)
    const filterOK: boolean = rangeReady && pos === null && dayOK && rangeOK && entryOK
    const longSig: boolean = filterOK && longAllowed && o.direction !== 'short' && b.close > rHi
    const shortSig: boolean = filterOK && shortAllowed && o.direction !== 'long' && b.close < rLo
    const avg = o.exitMode === 'avg'
    const sigs: [boolean, 1 | -1][] = [
      [longSig, 1],
      [shortSig, -1],
    ]
    for (const [sig, dir] of sigs) {
      if (!sig) continue
      const stop = avg ? b.close * (1 - (dir * o.avgDrawPct) / 100) : dir === 1 ? rLo : rHi
      const target = avg ? b.close * (1 + (dir * o.avgRunupPct) / 100) : b.close + o.rr * (b.close - stop)
      pendEntry = { dir, qty: (equity * o.pctEquity) / 100 / b.close, stop, target, signalTime: b.time }
      res.signals.push({ time: b.time, dir })
      if (dir === 1) longDone = true
      else shortDone = true
    }

    // ---- optional profit lock (decided on close, active from the next bar) ----
    if (o.useLock && pos && !pos.locked && pos.risk > 0) {
      const p = pos
      if (p.dir === 1 ? b.high >= p.entry + o.lockAtR * p.risk : b.low <= p.entry - o.lockAtR * p.risk) {
        p.sl = p.entry + p.dir * o.lockToR * p.risk
        p.locked = true
        p.stopMoves.push({ time: i + 1 < bars.length ? bars[i + 1].time : b.time, price: p.sl })
      }
    }
  }

  res.pending = pendEntry ? { dir: pendEntry.dir, stop: pendEntry.stop, target: pendEntry.target } : null
  res.equity = equity
  return res
}
