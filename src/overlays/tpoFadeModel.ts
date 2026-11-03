/**
 * TPO Value-Area Fade — the strategy researched on XAUTUSD 5m (Apr–Nov 2026).
 *
 * Levels: the previous trading session's TPO profile (30-min brackets, fixed row
 * size, 70% value area) → VAH / POC / VAL. Sessions open at the symbol's session
 * hour (22:00 UTC for gold); dead weekend sessions (Sat / Sun) are skipped, so
 * Monday trades off Friday's profile.
 *
 * Each session, at the order-window open (07:00 UTC):
 *   ATR    = ATR(14) of 5-minute bars, last completed bar before the window
 *   stop   = max(stopMin, stopAtr × ATR) beyond the level
 *   R:R    = |POC − level| / stop distance — a side is skipped below minRR
 *   order  = limit entryAtr × ATR past the level (sell above VAH, buy below VAL),
 *            skipped when the first window bar already trades at the level
 *   target = POC, targetAtr × ATR short of it
 * Orders rest until the window closes (17:00 UTC). A fill needs a fillTol
 * trade-through; on the fill bar a stop hit counts but a target hit does not.
 * Trades run to stop / target or the session end. After a stop-out the other
 * side's order is cancelled for the day.
 *
 * Sizing: risk % by volatility regime (ATR ÷ median of the prior 20 sessions'
 * window-open ATR), halved after `halveAfter` consecutive losses.
 *
 * Pure — no DOM / engine. Bar i uses bars <= i only, so bar replay matches live.
 */

export interface TfBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface TpoFadeOptions {
  /** UTC hour the trading session opens (22 for gold). */
  openHourUTC: number
  /** Skip sessions whose trading day is Saturday / Sunday. */
  skipWeekends: boolean
  /** TPO row height in price; 0 = automatic (≈ price / 4000 on a 1-2-5 step: $1 for gold). */
  rowSize: number
  bracketMin: number
  valueAreaPct: number
  windowStartUTC: number
  windowEndUTC: number
  atrLen: number
  stopAtr: number
  stopMin: number
  minRR: number
  entryAtr: number
  targetAtr: number
  fillTol: number
  longs: boolean
  shorts: boolean
  oneLossPerDay: boolean
  /** ATR ratio below which a day is "quiet", and at or above which it is "busy". */
  quietBelow: number
  busyFrom: number
  riskQuiet: number
  riskNormal: number
  riskBusy: number
  /** Consecutive losses after which risk is halved (0 = never). */
  halveAfter: number
  account: number
  regimeLookback: number
}

export const TPO_FADE_DEFAULTS: TpoFadeOptions = {
  openHourUTC: 22,
  skipWeekends: true,
  rowSize: 0,
  bracketMin: 30,
  valueAreaPct: 0.7,
  windowStartUTC: 7,
  windowEndUTC: 17,
  atrLen: 14,
  stopAtr: 2,
  stopMin: 8,
  minRR: 2,
  entryAtr: 0.5,
  targetAtr: 0.25,
  fillTol: 0.1,
  longs: true,
  shorts: true,
  oneLossPerDay: true,
  quietBelow: 0.8,
  busyFrom: 1.0,
  riskQuiet: 1.5,
  riskNormal: 1,
  riskBusy: 0.5,
  halveAfter: 2,
  account: 10_000,
  regimeLookback: 20,
}

export type OrderStatus = 'skipped-rr' | 'skipped-through' | 'skipped-side' | 'pending' | 'filled' | 'expired' | 'cancelled'

export interface FadeTrade {
  side: 1 | -1
  /** Index into result.sessions. */
  session: number
  entryIndex: number
  entryTime: number
  entry: number
  stop: number
  target: number
  exitIndex: number | null
  exitTime: number | null
  exitPrice: number | null
  exitReason: 'TP' | 'SL' | 'Session end' | null
  /** Result in R (gross, no costs); null while open. */
  r: number | null
  riskPct: number
  qty: number
}

export interface FadeOrder {
  side: 1 | -1
  level: number
  entry: number
  stop: number
  target: number
  /** Planned R:R from the level (the filter) and from the entry (what the trade pays). */
  rrLevel: number
  rrEntry: number
  status: OrderStatus
  /** Bar index the order starts resting / stops (fill, cancel or window close). */
  from: number
  to: number
  trade?: FadeTrade
}

export interface FadeSession {
  /** Session open (epoch ms) and its bar range in the input. */
  start: number
  i0: number
  i1: number
  /** Session has run its full 24h in the data. */
  complete: boolean
  /** Previous session's TPO levels (the ones traded in this session). */
  vah: number
  poc: number
  val: number
  /** Order-window bar range (-1 while the window isn't reached). */
  windowStart: number
  windowEnd: number
  atr: number
  atrRatio: number
  regime: 'quiet' | 'normal' | 'busy' | 'n/a'
  riskPct: number
  orders: FadeOrder[]
}

export interface TpoFadeResult {
  sessions: FadeSession[]
  trades: FadeTrade[]
  /** Levels for the session that has not opened yet (from the last completed one), e.g. Monday's over a weekend. */
  next: { start: number; vah: number; poc: number; val: number } | null
  rowSize: number
  /** ATR read from 5-minute bars (false when the chart is coarser than 5m). */
  atrFrom5m: boolean
}

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** Smallest positive gap among the first bars. */
function barSpan(bars: TfBar[]): number {
  let best = Infinity
  for (let i = 1; i < Math.min(bars.length, 50); i++) {
    const d = bars[i].time - bars[i - 1].time
    if (d > 0 && d < best) best = d
  }
  return Number.isFinite(best) ? best : 5 * MIN
}

/** A 1-2-5 step near price / 4000 ($1 for gold near 4000, $20 for BTC near 78k). */
export function autoRowSize(price: number): number {
  const raw = Math.max(price / 4000, 1e-8)
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p
}

/** POC = most TPOs; value area grown one row at a time toward the busier neighbour. */
export function valueArea(counts: ArrayLike<number>, pct: number): { poc: number; lo: number; hi: number } {
  let poc = 0
  let mx = -1
  let tot = 0
  for (let b = 0; b < counts.length; b++) {
    tot += counts[b]
    if (counts[b] > mx) {
      mx = counts[b]
      poc = b
    }
  }
  let lo = poc
  let hi = poc
  let cov = counts[poc]
  while (cov < tot * pct && (lo > 0 || hi < counts.length - 1)) {
    const up = hi < counts.length - 1 ? counts[hi + 1] : -1
    const dn = lo > 0 ? counts[lo - 1] : -1
    if (up >= dn) cov += counts[++hi]
    else cov += counts[--lo]
  }
  return { poc, lo, hi }
}

/** TPO VAH / POC / VAL of bars[i0..i1]: one TPO per bracket per row it touched. */
export function tpoLevels(bars: TfBar[], i0: number, i1: number, start: number, row: number, bracketMin: number, pct: number): { vah: number; poc: number; val: number } {
  let lo = Infinity
  let hi = -Infinity
  for (let i = i0; i <= i1; i++) {
    lo = Math.min(lo, bars[i].low)
    hi = Math.max(hi, bars[i].high)
  }
  const counts = new Float64Array(Math.floor((hi - lo) / row) + 1)
  const bMs = bracketMin * MIN
  let key = -1
  let bl = Infinity
  let bh = -Infinity
  const flush = (): void => {
    if (key < 0) return
    for (let x = Math.floor((bl - lo) / row); x <= Math.floor((bh - lo) / row); x++) counts[x]++
  }
  for (let i = i0; i <= i1; i++) {
    const k = Math.floor((bars[i].time - start) / bMs)
    if (k !== key) {
      flush()
      key = k
      bl = Infinity
      bh = -Infinity
    }
    bl = Math.min(bl, bars[i].low)
    bh = Math.max(bh, bars[i].high)
  }
  flush()
  const va = valueArea(counts, pct)
  return { vah: lo + (va.hi + 1) * row, poc: lo + (va.poc + 0.5) * row, val: lo + va.lo * row }
}

/**
 * ATR (Pine-style RMA, warm-up averaged) of 5-minute bars rebuilt from `bars`.
 * Value per input bar = the ATR as of the last COMPLETED 5m bar before it.
 * Charts coarser than 5m fall back to their own bars.
 */
function atrBefore(bars: TfBar[], len: number, span: number): Float64Array {
  const out = new Float64Array(bars.length).fill(Number.NaN)
  const bucket = Math.max(span, 5 * MIN)
  let p = 0
  let cnt = 0
  let prevClose = Number.NaN
  let curKey = Number.NaN
  let h = -Infinity
  let l = Infinity
  let c = Number.NaN
  let done = Number.NaN
  for (let i = 0; i < bars.length; i++) {
    const k = Math.floor(bars[i].time / bucket)
    if (k !== curKey) {
      if (!Number.isNaN(curKey)) {
        const tr = Number.isNaN(prevClose) ? h - l : Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose))
        p = cnt < len ? (p * cnt + tr) / (cnt + 1) : (p * (len - 1) + tr) / len
        cnt++
        prevClose = c
        done = p
      }
      curKey = k
      h = -Infinity
      l = Infinity
    }
    out[i] = done
    h = Math.max(h, bars[i].high)
    l = Math.min(l, bars[i].low)
    c = bars[i].close
  }
  return out
}

const median = (a: number[]): number => {
  const b = a.filter(Number.isFinite).sort((x, y) => x - y)
  return b.length ? b[b.length >> 1] : Number.NaN
}

export function computeTpoFade(bars: TfBar[], opts: Partial<TpoFadeOptions> = {}): TpoFadeResult {
  const o: TpoFadeOptions = { ...TPO_FADE_DEFAULTS, ...opts }
  const n = bars.length
  const span = barSpan(bars)
  const row = o.rowSize > 0 ? o.rowSize : autoRowSize(n ? bars[n - 1].close : 1)
  const result: TpoFadeResult = { sessions: [], trades: [], next: null, rowSize: row, atrFrom5m: span <= 5 * MIN }
  if (n < 2 || span >= DAY) return result
  const atr = atrBefore(bars, o.atrLen, span)
  const lastTime = bars[n - 1].time

  // ---- sessions ----
  type Raw = { k: number; i0: number; i1: number }
  const raw: Raw[] = []
  for (let i = 0; i < n; i++) {
    const k = Math.floor((bars[i].time - o.openHourUTC * HOUR) / DAY)
    if (!raw.length || raw[raw.length - 1].k !== k) raw.push({ k, i0: i, i1: i })
    raw[raw.length - 1].i1 = i
  }
  const start = (r: Raw): number => r.k * DAY + o.openHourUTC * HOUR
  // trading day = the calendar day the session closes on (a 22:00 UTC Sunday open is Monday's)
  const tradingDay = (r: Raw): number => new Date(start(r) + DAY - 1).getUTCDay()
  const live = raw.filter((r) => !o.skipWeekends || (tradingDay(r) !== 0 && tradingDay(r) !== 6))
  // a usable profile starts near its session open (not mid-day where the chart's data begins)
  // and spans most of a day (holiday stubs are skipped)
  const fullProfile = (r: Raw): boolean => bars[r.i0].time - start(r) <= 2 * HOUR && bars[r.i1].time - bars[r.i0].time >= 8 * HOUR

  const windowAtrs: number[] = []
  for (let s = 1; s < live.length; s++) {
    const prev = live[s - 1]
    const cur = live[s]
    const t0 = start(cur)
    const complete = cur.i1 < n - 1 || lastTime + span >= t0 + DAY
    if (!fullProfile(prev)) continue
    const lv = tpoLevels(bars, prev.i0, prev.i1, start(prev), row, o.bracketMin, o.valueAreaPct)

    let ws = -1
    let we = -1
    for (let i = cur.i0; i <= cur.i1; i++) {
      const h = new Date(bars[i].time).getUTCHours()
      if (h >= o.windowStartUTC && h < o.windowEndUTC) {
        if (ws < 0) ws = i
        we = i
      } else if (ws >= 0) break
    }
    const sess: FadeSession = { start: t0, i0: cur.i0, i1: cur.i1, complete, ...lv, windowStart: ws, windowEnd: we, atr: Number.NaN, atrRatio: Number.NaN, regime: 'n/a', riskPct: o.riskNormal, orders: [] }
    result.sessions.push(sess)
    if (ws < 1) continue

    const a = atr[ws]
    const med = median(windowAtrs.slice(-o.regimeLookback))
    windowAtrs.push(a)
    sess.atr = a
    sess.atrRatio = windowAtrs.length > 5 ? a / med : Number.NaN
    sess.regime = Number.isNaN(sess.atrRatio) ? 'n/a' : sess.atrRatio < o.quietBelow ? 'quiet' : sess.atrRatio >= o.busyFrom ? 'busy' : 'normal'
    sess.riskPct = sess.regime === 'quiet' ? o.riskQuiet : sess.regime === 'busy' ? o.riskBusy : o.riskNormal
    if (!Number.isFinite(a) || a <= 0) continue

    const stopDist = Math.max(o.stopMin, o.stopAtr * a)
    const off = o.entryAtr * a
    const windowOver = complete || new Date(bars[cur.i1].time).getUTCHours() >= o.windowEndUTC || we < cur.i1

    for (const side of [-1, 1] as const) {
      const level = side < 0 ? lv.vah : lv.val
      const entry = level - side * off
      const stop = level - side * stopDist
      const target = lv.poc - side * o.targetAtr * a
      const order: FadeOrder = { side, level, entry, stop, target, rrLevel: Math.abs(lv.poc - level) / stopDist, rrEntry: Math.abs(target - entry) / Math.abs(entry - stop), status: 'pending', from: ws, to: we }
      sess.orders.push(order)
      if ((side < 0 && !o.shorts) || (side > 0 && !o.longs)) {
        order.status = 'skipped-side'
        continue
      }
      if (order.rrLevel < o.minRR || side * (target - entry) <= 0) {
        order.status = 'skipped-rr'
        continue
      }
      if (side < 0 ? bars[ws].high >= level : bars[ws].low <= level) {
        order.status = 'skipped-through'
        continue
      }
      // rests from the bar after the window open
      let fill = -1
      for (let i = ws + 1; i <= we; i++) {
        if (side < 0 ? bars[i].high >= entry + o.fillTol : bars[i].low <= entry - o.fillTol) {
          fill = i
          break
        }
      }
      if (fill < 0) {
        order.status = windowOver ? 'expired' : 'pending'
        continue
      }
      order.status = 'filled'
      order.to = fill
      const t: FadeTrade = { side, session: result.sessions.length - 1, entryIndex: fill, entryTime: bars[fill].time, entry, stop, target, exitIndex: null, exitTime: null, exitPrice: null, exitReason: null, r: null, riskPct: 0, qty: 0 }
      for (let j = fill; j <= cur.i1; j++) {
        const b = bars[j]
        const hitS = side > 0 ? b.low <= stop : b.high >= stop
        const hitT = j > fill && (side > 0 ? b.high >= target : b.low <= target)
        if (hitS || hitT || (j === cur.i1 && complete)) {
          t.exitIndex = j
          t.exitTime = b.time
          t.exitPrice = hitS ? stop : hitT ? target : b.close
          t.exitReason = hitS ? 'SL' : hitT ? 'TP' : 'Session end'
          t.r = (side * (t.exitPrice - entry)) / Math.abs(entry - stop)
          break
        }
      }
      order.trade = t
    }

    // one loss per day: after a stop-out the other side's order is cancelled
    if (o.oneLossPerDay) {
      const stopped = sess.orders
        .filter((x) => x.trade?.exitReason === 'SL')
        .sort((x, y) => (x.trade!.exitIndex as number) - (y.trade!.exitIndex as number))[0]
      const at = stopped?.trade?.exitIndex
      if (at != null) {
        for (const x of sess.orders) {
          if (x === stopped) continue
          if ((x.trade && x.trade.entryIndex > at) || x.status === 'pending' || (x.status === 'expired' && x.to > at)) {
            x.status = 'cancelled'
            x.to = at
            x.trade = undefined
          }
        }
      }
    }

    // sizing: regime risk, halved after a losing streak of trades closed before this entry
    const fills = sess.orders.filter((x) => x.trade).map((x) => x.trade!).sort((p, q) => p.entryIndex - q.entryIndex)
    for (const t of fills) {
      let streak = 0
      for (let k = result.trades.length - 1; k >= 0; k--) {
        const pt = result.trades[k]
        if (pt.exitTime === null || pt.exitTime > t.entryTime) continue
        if ((pt.r ?? 0) < 0) streak++
        else break
      }
      t.riskPct = sess.riskPct * (o.halveAfter > 0 && streak >= o.halveAfter ? 0.5 : 1)
      t.qty = (o.account * t.riskPct) / 100 / Math.abs(t.entry - t.stop)
      result.trades.push(t)
    }
  }

  // the last session has closed (e.g. Friday over the weekend): publish the next session's levels
  const lastLive = live[live.length - 1]
  if (lastLive && lastTime + span >= start(lastLive) + DAY && fullProfile(lastLive)) {
    let nextStart = start(lastLive) + DAY
    const nextDay = (t: number): number => new Date(t + DAY - 1).getUTCDay()
    while (o.skipWeekends && (nextDay(nextStart) === 0 || nextDay(nextStart) === 6)) nextStart += DAY
    result.next = { start: nextStart, ...tpoLevels(bars, lastLive.i0, lastLive.i1, start(lastLive), row, o.bracketMin, o.valueAreaPct) }
  }
  return result
}

/** Summary over closed trades, in R (gross of costs). */
export function fadeStats(trades: FadeTrade[]): { n: number; wins: number; winRate: number; netR: number; avgR: number; pf: number; maxDD: number } {
  let eq = 0
  let pk = 0
  let dd = 0
  let gp = 0
  let gl = 0
  let wins = 0
  let n = 0
  for (const t of trades) {
    if (t.r === null) continue
    n++
    eq += t.r
    pk = Math.max(pk, eq)
    dd = Math.max(dd, pk - eq)
    if (t.r > 0) {
      wins++
      gp += t.r
    } else gl -= t.r
  }
  return { n, wins, winRate: n ? (100 * wins) / n : 0, netR: eq, avgR: n ? eq / n : 0, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0, maxDD: dd }
}
