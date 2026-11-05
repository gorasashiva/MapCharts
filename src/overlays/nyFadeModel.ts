// NY First-Hour Fade — pure model (no DOM).
//
// Researched on gold 1m (research/xau-ny-fade.mjs, research/xau-sessions.mjs): on most days the rest of the
// New York session moves against its first hour. Rule, per FX trading day (NY 17:00 -> NY 17:00, Mon-Fri):
//   1. first hour = NY 08:00-09:00 (New York wall clock, so daylight saving is automatic)
//   2. at NY 09:00, enter AGAINST that hour's move at the next bar's open
//   3. stop: `stopRange` x the typical FX-day range (median of the previous `rangeDays` weekdays), or just
//      beyond the first hour's extreme
//   4. TP1 = the first hour's open (a full retrace; 1R if price is already past it), TP2 = `targetR` x risk
//   5. exit mode: hold to NY 17:00 (the backtest's best) | at TP1 | at TP2 | half at TP1 + stop to breakeven,
//      rest at TP2 or NY 17:00
// Every decision uses bars up to the one being processed, so bar replay shows what the rule knew at the time.
import type { Candle } from '../core/types'

export type NyFadeStopMode = 'range' | 'extreme'
export type NyFadeExitMode = 'close' | 'tp1' | 'tp2' | 'half'

export interface NyFadeOptions {
  /** NY minute of day the first hour starts (480 = 08:00). */
  sessionStartNY: number
  /** Length of the "first hour" in minutes. */
  firstMinutes: number
  /** NY minute of day everything is closed (1020 = 17:00). */
  exitNY: number
  stopMode: NyFadeStopMode
  /** Stop distance as a multiple of the typical FX-day range ('range' mode, and the fallback). */
  stopRange: number
  /** Extra distance beyond the first hour's extreme, x typical day range ('extreme' mode). */
  extremeBuffer: number
  exitMode: NyFadeExitMode
  /** TP2 in R. */
  targetR: number
  /** Skip days whose first-hour move is smaller than this x typical day range. */
  minMove: number
  /** Weekdays in the typical-range median. */
  rangeDays: number
  longs: boolean
  shorts: boolean
}

export const NY_FADE_DEFAULTS: NyFadeOptions = {
  sessionStartNY: 480,
  firstMinutes: 60,
  exitNY: 1020,
  stopMode: 'range',
  stopRange: 0.25,
  extremeBuffer: 0.02,
  exitMode: 'close',
  targetR: 2,
  minMove: 0,
  rangeDays: 20,
  longs: true,
  shorts: true,
}

export type NyFadeExitReason = 'SL' | 'TP1' | 'TP2' | 'BE' | 'Session end'

export interface NyFadeTrade {
  side: 1 | -1
  entryIndex: number
  entryTime: number
  entry: number
  stop: number
  tp1: number
  tp2: number
  /** When half was banked at TP1 ('half' mode). */
  tp1Index: number | null
  tp1Time: number | null
  exitIndex: number | null
  exitTime: number | null
  /** Final fill of what was still open (the banked half filled at tp1 in 'half' mode). */
  exitPrice: number | null
  exitReason: NyFadeExitReason | null
  /** Average exit price over the whole position (for the Strategy Tester). */
  avgExit: number | null
  /** Result per 1 unit, in price, and in R. */
  pnl: number | null
  r: number | null
}

export type NyFadeStatus = 'first-hour' | 'waiting-entry' | 'traded' | 'skipped-small' | 'skipped-side' | 'skipped-no-range'

export interface NyFadeDay {
  /** FX day, YYYY-MM-DD (its NY date). */
  day: string
  /** First-hour bars [i0, i1]. */
  i0: number
  i1: number
  open: number
  close: number
  high: number
  low: number
  /** close - open of the first hour. */
  move: number
  /** Typical FX-day range used for sizing, and how many weekdays it came from. */
  scale: number
  scaleDays: number
  /** Fade direction: +1 buy, -1 sell, 0 none yet. */
  dir: 1 | -1 | 0
  status: NyFadeStatus
  /** Epoch ms of the entry time (first hour end) and of the session exit. */
  entryAt: number
  exitAt: number
  /** Planned levels from the first hour's close (the actual entry is the next bar's open). */
  plan: { entry: number; stop: number; tp1: number; tp2: number } | null
  trade: NyFadeTrade | null
}

export interface NyFadeStats {
  n: number
  wins: number
  winRate: number
  totalPnl: number
  avgPnl: number
  avgR: number
  pf: number
  maxDD: number
}

export interface NyFadeResult {
  days: NyFadeDay[]
  trades: NyFadeTrade[]
  /** Per bar: 0 rollover / Sydney, 1 Asia, 2 London, 3 New York. */
  blocks: Uint8Array
  barMs: number
  /** False when bars are longer than the first hour (the rule needs bars of 1h or less). */
  usable: boolean
}

// ---------------------------------------------------------------------------
// Time zones (IANA, so daylight saving follows each city's own rules)
// ---------------------------------------------------------------------------
const fmtByZone = new Map<string, Intl.DateTimeFormat>()
const offByZone = new Map<string, Map<number, number>>()

/** Minutes `zone` is ahead of UTC at time t (cached per UTC hour; these zones change on the hour). */
export function zoneOffsetMin(zone: string, t: number): number {
  const hk = Math.floor(t / 3_600_000)
  let cache = offByZone.get(zone)
  if (!cache) offByZone.set(zone, (cache = new Map()))
  const hit = cache.get(hk)
  if (hit !== undefined) return hit
  let f = fmtByZone.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    fmtByZone.set(zone, f)
  }
  const p: Record<string, string> = {}
  for (const x of f.formatToParts(new Date(hk * 3_600_000))) p[x.type] = x.value
  const v = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - hk * 3_600_000) / 60_000
  cache.set(hk, v)
  return v
}

const NY = 'America/New_York'
const LONDON = 'Europe/London'
const TOKYO_OFFSET = 540 // Japan has no daylight saving

function minuteOfDay(t: number, offsetMin: number): number {
  const d = new Date(t + offsetMin * 60_000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

export const nyMinuteOfDay = (t: number): number => minuteOfDay(t, zoneOffsetMin(NY, t))

/** FX trading day (NY 17:00 -> 17:00), labelled by its NY date, with its weekday (0 Sun .. 6 Sat). */
export function fxDayOf(t: number): { key: string; dow: number } {
  const d = new Date(t + zoneOffsetMin(NY, t) * 60_000 + 7 * 3_600_000)
  return { key: d.toISOString().slice(0, 10), dow: d.getUTCDay() }
}

/** UTC epoch ms of a New York wall-clock minute on NY date `ymd`. */
export function nyWallToUtc(ymd: string, minute: number): number {
  const [y, m, d] = ymd.split('-').map(Number)
  const asUtc = Date.UTC(y, m - 1, d, 0, minute)
  let t = asUtc - zoneOffsetMin(NY, asUtc) * 60_000
  t = asUtc - zoneOffsetMin(NY, t) * 60_000 // settle across a DST change
  return t
}

/** Session block of a time: 0 rollover / Sydney, 1 Asia, 2 London, 3 New York (see research/xau-sessions.mjs). */
export function sessionBlock(t: number): number {
  const ny = nyMinuteOfDay(t)
  if (ny >= 480 && ny < 1020) return 3
  const ldn = minuteOfDay(t, zoneOffsetMin(LONDON, t))
  if (ldn >= 480 && ny < 480) return 2
  if (minuteOfDay(t, TOKYO_OFFSET) >= 540 && ldn < 480) return 1
  return 0
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : NaN
}

function barMsOf(candles: Candle[]): number {
  const gaps: number[] = []
  for (let i = Math.max(1, candles.length - 200); i < candles.length; i++) gaps.push(candles[i].time - candles[i - 1].time)
  return median(gaps.filter((g) => g > 0)) || 60_000
}

export function computeNyFade(candles: Candle[], o: NyFadeOptions = NY_FADE_DEFAULTS): NyFadeResult {
  const n = candles.length
  const blocks = new Uint8Array(n)
  const barMs = n > 1 ? barMsOf(candles) : 60_000
  const usable = barMs <= o.firstMinutes * 60_000
  const days: NyFadeDay[] = []
  const trades: NyFadeTrade[] = []
  if (n < 2) return { days, trades, blocks, barMs, usable }

  // per bar: NY minute, FX day, session block; per FX day: high / low / bar count
  const nyMod = new Int16Array(n)
  const dayKey: string[] = new Array(n)
  const dayInfo = new Map<string, { h: number; l: number; bars: number; dow: number; first: number }>()
  const order: string[] = []
  for (let i = 0; i < n; i++) {
    const c = candles[i]
    nyMod[i] = nyMinuteOfDay(c.time)
    blocks[i] = sessionBlock(c.time)
    const fx = fxDayOf(c.time)
    dayKey[i] = fx.key
    let d = dayInfo.get(fx.key)
    if (!d) {
      dayInfo.set(fx.key, (d = { h: c.high, l: c.low, bars: 0, dow: fx.dow, first: i }))
      order.push(fx.key)
    }
    d.h = Math.max(d.h, c.high)
    d.l = Math.min(d.l, c.low)
    d.bars++
  }
  if (!usable) return { days, trades, blocks, barMs, usable }

  // typical range: median range of the previous complete weekdays (complete = at least half the day's bars)
  const fullBars = (24 * 3_600_000) / barMs
  const weekdayRanges: number[] = []
  const scaleFor = new Map<string, { scale: number; days: number }>()
  for (const key of order) {
    const d = dayInfo.get(key)!
    if (d.dow === 0 || d.dow === 6) continue
    const prev = weekdayRanges.slice(-o.rangeDays)
    scaleFor.set(key, { scale: prev.length ? median(prev) : NaN, days: prev.length })
    if (d.bars >= 0.5 * fullBars) weekdayRanges.push(d.h - d.l)
  }

  const fhEnd = o.sessionStartNY + o.firstMinutes
  for (const key of order) {
    const info = dayInfo.get(key)!
    if (info.dow === 0 || info.dow === 6) continue
    // first-hour bars of this FX day
    let i0 = -1, i1 = -1
    for (let i = info.first; i < n && dayKey[i] === key; i++) {
      if (nyMod[i] >= o.sessionStartNY && nyMod[i] < fhEnd) {
        if (i0 < 0) i0 = i
        i1 = i
      }
    }
    if (i0 < 0) continue
    let high = -Infinity, low = Infinity
    for (let i = i0; i <= i1; i++) {
      high = Math.max(high, candles[i].high)
      low = Math.min(low, candles[i].low)
    }
    const open = candles[i0].open, close = candles[i1].close
    const sc = scaleFor.get(key) ?? { scale: NaN, days: 0 }
    const day: NyFadeDay = {
      day: key, i0, i1, open, close, high, low, move: close - open, scale: sc.scale, scaleDays: sc.days,
      dir: 0, status: 'first-hour', entryAt: nyWallToUtc(key, fhEnd), exitAt: nyWallToUtc(key, o.exitNY), plan: null, trade: null,
    }
    days.push(day)
    // the first hour is over once a later bar of the same FX day exists
    if (!(i1 + 1 < n && dayKey[i1 + 1] === key)) continue
    if (!Number.isFinite(day.scale) || day.scale <= 0) {
      day.status = 'skipped-no-range'
      continue
    }
    if (!day.move) {
      day.status = 'skipped-small'
      continue
    }
    const dir: 1 | -1 = day.move > 0 ? -1 : 1
    day.dir = dir
    if (Math.abs(day.move) < o.minMove * day.scale) {
      day.status = 'skipped-small'
      continue
    }
    if ((dir > 0 && !o.longs) || (dir < 0 && !o.shorts)) {
      day.status = 'skipped-side'
      continue
    }
    const levels = (entry: number): { stop: number; tp1: number; tp2: number } => {
      let stop = entry - dir * o.stopRange * day.scale
      if (o.stopMode === 'extreme') {
        const ex = dir > 0 ? low - o.extremeBuffer * day.scale : high + o.extremeBuffer * day.scale
        if (dir * (entry - ex) > 0) stop = ex
      }
      const risk = Math.abs(entry - stop)
      let tp1 = open
      if (dir * (tp1 - entry) <= 0) tp1 = entry + dir * risk
      let tp2 = entry + dir * o.targetR * risk
      if (dir * (tp2 - tp1) <= 0) tp2 = tp1 + dir * risk
      return { stop, tp1, tp2 }
    }
    day.plan = { entry: close, ...levels(close) }
    // entry bar: the first bar of the day at or after the first hour's end, before the session exit
    let j = -1
    for (let i = i1 + 1; i < n && dayKey[i] === key; i++) {
      if (nyMod[i] >= o.exitNY) break
      if (nyMod[i] >= fhEnd) {
        j = i
        break
      }
    }
    if (j < 0) {
      day.status = 'waiting-entry'
      continue
    }
    const entry = candles[j].open
    const lv = levels(entry)
    const risk = Math.abs(entry - lv.stop)
    const t: NyFadeTrade = {
      side: dir, entryIndex: j, entryTime: candles[j].time, entry, stop: lv.stop, tp1: lv.tp1, tp2: lv.tp2,
      tp1Index: null, tp1Time: null, exitIndex: null, exitTime: null, exitPrice: null, exitReason: null, avgExit: null, pnl: null, r: null,
    }
    let stop = lv.stop
    let banked = 0 // price result already banked per 1 unit
    let size = 1
    const closeOut = (k: number, price: number, reason: NyFadeExitReason): void => {
      t.exitIndex = k
      t.exitTime = candles[k].time
      t.exitPrice = price
      t.exitReason = reason
      const pnl = banked + size * dir * (price - entry)
      t.pnl = pnl
      t.r = pnl / risk
      t.avgExit = entry + dir * pnl
    }
    for (let k = j; k < n; k++) {
      if (dayKey[k] !== key || nyMod[k] >= o.exitNY) {
        closeOut(k - 1, candles[k - 1].close, 'Session end')
        break
      }
      const c = candles[k]
      if (dir > 0 ? c.low <= stop : c.high >= stop) {
        const fill = dir > 0 ? Math.min(c.open, stop) : Math.max(c.open, stop)
        closeOut(k, fill, t.tp1Index !== null && stop === entry ? 'BE' : 'SL')
        break
      }
      const hit = (lvl: number): boolean => (dir > 0 ? c.high >= lvl : c.low <= lvl)
      if (o.exitMode === 'tp1' && hit(t.tp1)) {
        closeOut(k, t.tp1, 'TP1')
        break
      }
      if (o.exitMode === 'tp2' && hit(t.tp2)) {
        closeOut(k, t.tp2, 'TP2')
        break
      }
      if (o.exitMode === 'half') {
        if (t.tp1Index === null && hit(t.tp1)) {
          banked += 0.5 * dir * (t.tp1 - entry)
          size = 0.5
          t.tp1Index = k
          t.tp1Time = c.time
          stop = entry // the rest rides with the stop at breakeven from the next bar
          if (hit(t.tp2)) {
            closeOut(k, t.tp2, 'TP2')
            break
          }
          continue
        }
        if (t.tp1Index !== null && hit(t.tp2)) {
          closeOut(k, t.tp2, 'TP2')
          break
        }
      }
      // the data ends here: if this bar reaches the session close, the session is over; otherwise the trade is open
      if (k === n - 1 && c.time + barMs >= day.exitAt) closeOut(k, c.close, 'Session end')
    }
    day.status = 'traded'
    day.trade = t
    trades.push(t)
  }
  return { days, trades, blocks, barMs, usable }
}

/** Win rate, $ and R results and drawdown of the closed trades. */
export function nyFadeStats(trades: NyFadeTrade[]): NyFadeStats {
  let n = 0, wins = 0, total = 0, rSum = 0, gain = 0, loss = 0, peak = 0, eq = 0, dd = 0
  for (const t of trades) {
    if (t.pnl === null || t.r === null) continue
    n++
    total += t.pnl
    rSum += t.r
    if (t.pnl > 0) {
      wins++
      gain += t.pnl
    } else loss -= t.pnl
    eq += t.pnl
    peak = Math.max(peak, eq)
    dd = Math.max(dd, peak - eq)
  }
  return { n, wins, winRate: n ? (100 * wins) / n : 0, totalPnl: total, avgPnl: n ? total / n : 0, avgR: n ? rSum / n : 0, pf: loss > 0 ? gain / loss : gain > 0 ? Infinity : 0, maxDD: dd }
}
