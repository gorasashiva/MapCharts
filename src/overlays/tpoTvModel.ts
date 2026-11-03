/**
 * TPO (Time Price Opportunity) — TradingView's periodic TPO, as its help page
 * describes it (support/solutions/43000713306):
 *
 *   - One profile per period (day / week / month). Each period is cut into
 *     time blocks of `blockMs` from its start; block k gets letter k in
 *     A–Z, then a–z, repeating. A block "is at" every row its range covers.
 *   - Row size: Auto = on the latest 300 bars, (High − Low) / tick / 80 rows,
 *     rounded to an increment of 5 · 10^k ticks (5 for 1–100, 50 for 100–1 000,
 *     …), at least one tick. Manual = ticks per row.
 *   - POC = the row with the most blocks (TradingView does not say how ties
 *     break; here the one nearest the profile's middle, then the higher).
 *   - Value area, as TradingView: start at the POC; compare the row above the
 *     VA with the row below; add the one with more blocks (tie: the one closer
 *     to the POC; still tied: the higher); repeat until the VA holds
 *     total × VA% / 100 blocks. VAH / VAL = its top / bottom rows.
 *   - Initial Balance = the range of the first `ibBlocks` blocks.
 *   - Midpoint = (highest TPO price + lowest TPO price) / 2; open / close of the period.
 *   - Single prints = rows with exactly one block that are not the profile's
 *     extremes; poor high / low = an extreme row with more than one block.
 *   - Volume profile: each bar's volume spread evenly over the rows it covers,
 *     with its own POC and value area (same algorithm, on volume).
 *
 * Pure — no DOM. Bars must be oldest first.
 */
import { nyOffsetMinutes, nyTime } from './nyClock'

export interface TpoBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type TpoPeriod = 'day' | 'week' | 'month'

export interface TpoOptions {
  period: TpoPeriod
  /** Time block (TradingView: 5/10/15/30 min, 1/2/4 h). */
  blockMs: number
  /** Price per row. */
  rowSize: number
  valueAreaPct: number
  ibBlocks: number
  /** Hour (UTC) a day starts — the market's session open. */
  dayStartHourUTC: number
  /** When set, a day starts at this New York hour instead (follows US daylight saving; gold: 18). */
  dayStartNyHour?: number | null
}

export const TPO_DEFAULTS: Omit<TpoOptions, 'rowSize'> = {
  period: 'day',
  blockMs: 30 * 60_000,
  valueAreaPct: 70,
  ibBlocks: 2,
  dayStartHourUTC: 0,
}

export interface TpoBlock {
  /** Letter index 0, 1, … (A, B, …, Z, a, …, z, A, …). */
  index: number
  start: number
  high: number
  low: number
}

export interface TpoProfile {
  start: number
  /** Period end (exclusive). */
  end: number
  blocks: TpoBlock[]
  rowSize: number
  /** Lowest / highest row index (row r spans r·rowSize … (r+1)·rowSize). */
  lo: number
  hi: number
  /** Row index -> letter indexes there, in time order. */
  rows: Map<number, number[]>
  total: number
  poc: number
  vaLo: number
  vaHi: number
  /** Initial Balance price range. */
  ib: [number, number]
  open: number
  close: number
  /** Middle of the profile, between its highest and lowest TPO prices. */
  mid: number
  /** Rows that are single prints (not the extremes). */
  singles: number[]
  poorHigh: boolean
  poorLow: boolean
  volume: Map<number, number>
  totalVolume: number
  vPoc: number
  vVaLo: number
  vVaHi: number
  /** The period's end time has passed. */
  complete: boolean
}

const DAY = 86_400_000
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const tpoLetter = (index: number): string => LETTERS[index % 52]

/**
 * Start of the period containing t. A day opens at `dayStartHourUTC`; one that
 * opens in the evening (gold: 22:00 UTC) is the next calendar date's session.
 * Weeks start on that Monday's session, months on the 1st's.
 */
export function periodStart(t: number, period: TpoPeriod, dayStartHourUTC: number, dayStartNyHour: number | null = null): number {
  if (dayStartNyHour !== null) return nyPeriodStart(t, period, dayStartNyHour)
  const off = dayStartHourUTC * 3_600_000
  const dayStart = Math.floor((t - off) / DAY) * DAY + off
  if (period === 'day') return dayStart
  // the calendar date the session belongs to
  const date = new Date(dayStart + (dayStartHourUTC >= 12 ? DAY : 0))
  const sessionOf = (utcMidnight: number): number => utcMidnight + off - (dayStartHourUTC >= 12 ? DAY : 0)
  if (period === 'week') {
    const dow = (date.getUTCDay() + 6) % 7 // Monday = 0
    return sessionOf(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - dow * DAY)
  }
  return sessionOf(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

/**
 * Period start when the day opens at a New York hour: the session that opens at
 * that hour on date D is the next date's (gold's 18:00 opens tomorrow's session),
 * so the clock change only moves the UTC time, never which session a bar is in.
 */
function nyPeriodStart(t: number, period: TpoPeriod, nyHour: number): number {
  const ny = new Date(t + nyOffsetMinutes(t) * 60_000) // New York wall clock, read as UTC
  let session = Date.UTC(ny.getUTCFullYear(), ny.getUTCMonth(), ny.getUTCDate())
  if (ny.getUTCHours() >= nyHour) session += DAY
  if (period === 'week') session -= ((new Date(session).getUTCDay() + 6) % 7) * DAY // its Monday
  else if (period === 'month') session = Date.UTC(new Date(session).getUTCFullYear(), new Date(session).getUTCMonth(), 1)
  return nyTime(new Date(session - DAY).toISOString().slice(0, 10), nyHour) // opens the evening before
}

function periodEnd(start: number, period: TpoPeriod, dayStartHourUTC: number, dayStartNyHour: number | null = null): number {
  if (dayStartNyHour !== null) {
    // the next period's open: a step well inside it, then back to its start (days are 23–25 h around a clock change)
    const step = period === 'day' ? DAY + 6 * 3_600_000 : period === 'week' ? 7 * DAY + 6 * 3_600_000 : 32 * DAY
    return nyPeriodStart(start + step, period, dayStartNyHour)
  }
  if (period === 'day') return start + DAY
  if (period === 'week') return start + 7 * DAY
  return periodStart(start + 32 * DAY, 'month', dayStartHourUTC)
}

const round = (x: number): number => Math.round(x * 1e10) / 1e10

/** TradingView's Auto row size, in price: latest 300 bars, ~80 rows, ticks rounded to 5·10^k. */
export function autoRowSize(bars: TpoBar[], tick: number): number {
  if (!(tick > 0)) return 1
  const recent = bars.slice(-300)
  if (!recent.length) return tick
  let hi = -Infinity, lo = Infinity
  for (const b of recent) (hi = Math.max(hi, b.high)), (lo = Math.min(lo, b.low))
  const rowTicks = (hi - lo) / tick / 80
  // increment: 5 for 1–100 ticks, 50 for 100–1 000, 500 for 1 000–10 000, …
  const inc = 5 * Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(rowTicks, 1))) - 1))
  return round(Math.max(1, Math.round(rowTicks / inc) * inc) * tick)
}

/** The value area by TradingView's rule, over rows lo..hi weighted by `count(row)`. */
export function valueArea(count: (r: number) => number, lo: number, hi: number, poc: number, pct: number): [number, number] {
  let total = 0
  for (let r = lo; r <= hi; r++) total += count(r)
  const target = (total * pct) / 100
  let vLo = poc, vHi = poc, inVa = count(poc)
  while (inVa < target && (vLo > lo || vHi < hi)) {
    const up = vHi < hi ? count(vHi + 1) : -1
    const dn = vLo > lo ? count(vLo - 1) : -1
    // more wins; a tie goes to the row closer to the POC, then to the higher one
    const takeUp = up !== dn ? up > dn : vHi + 1 - poc <= poc - (vLo - 1)
    if (takeUp) inVa += count(++vHi)
    else inVa += count(--vLo)
  }
  return [vLo, vHi]
}

/** The row with the most of `count`; ties: nearest the middle of lo..hi, then the higher. */
function pocOf(count: (r: number) => number, lo: number, hi: number): number {
  const midRow = (lo + hi) / 2
  let best = lo
  for (let r = lo + 1; r <= hi; r++) {
    const c = count(r), b = count(best)
    const d = Math.abs(r - midRow), db = Math.abs(best - midRow)
    if (c > b || (c === b && (d < db || (d === db && r > best)))) best = r
  }
  return best
}

export function computeTpo(bars: TpoBar[], o: TpoOptions, now = Date.now()): TpoProfile[] {
  if (!bars.length || !(o.rowSize > 0) || !(o.blockMs > 0)) return []
  const out: TpoProfile[] = []
  let cur: { start: number; end: number; bars: TpoBar[] } | null = null
  for (const b of bars) {
    const ps = periodStart(b.time, o.period, o.dayStartHourUTC, o.dayStartNyHour ?? null)
    if (!cur || ps !== cur.start) {
      if (cur && cur.bars.length) out.push(build(cur.start, cur.end, cur.bars, o, true))
      cur = { start: ps, end: periodEnd(ps, o.period, o.dayStartHourUTC, o.dayStartNyHour ?? null), bars: [] }
    }
    cur.bars.push(b)
  }
  if (cur && cur.bars.length) out.push(build(cur.start, cur.end, cur.bars, o, now >= cur.end))
  return out
}

function build(start: number, end: number, bars: TpoBar[], o: TpoOptions, complete: boolean): TpoProfile {
  const rs = o.rowSize
  const blocks: TpoBlock[] = []
  for (const b of bars) {
    const k = Math.floor((b.time - start) / o.blockMs)
    const last = blocks[blocks.length - 1]
    if (last && last.index === k) {
      last.high = Math.max(last.high, b.high)
      last.low = Math.min(last.low, b.low)
    } else blocks.push({ index: k, start: start + k * o.blockMs, high: b.high, low: b.low })
  }
  const rowOf = (p: number): number => Math.floor(round(p / rs))
  const rows = new Map<number, number[]>()
  let lo = Infinity, hi = -Infinity
  for (const bl of blocks) {
    const r0 = rowOf(bl.low), r1 = rowOf(bl.high)
    lo = Math.min(lo, r0)
    hi = Math.max(hi, r1)
    for (let r = r0; r <= r1; r++) {
      const a = rows.get(r)
      if (a) a.push(bl.index)
      else rows.set(r, [bl.index])
    }
  }
  const count = (r: number): number => rows.get(r)?.length ?? 0
  let total = 0
  for (const a of rows.values()) total += a.length
  const poc = pocOf(count, lo, hi)
  const [vaLo, vaHi] = valueArea(count, lo, hi, poc, o.valueAreaPct)

  const ibBl = blocks.filter((b) => b.index < Math.max(1, o.ibBlocks))
  const ib: [number, number] = [Math.min(...ibBl.map((b) => b.low)), Math.max(...ibBl.map((b) => b.high))]
  const singles: number[] = []
  for (let r = lo + 1; r <= hi - 1; r++) if (count(r) === 1) singles.push(r)

  const volume = new Map<number, number>()
  let totalVolume = 0
  for (const b of bars) {
    const v = b.volume > 0 ? b.volume : 0
    if (!v) continue
    const r0 = rowOf(b.low), r1 = rowOf(b.high)
    const per = v / (r1 - r0 + 1)
    for (let r = r0; r <= r1; r++) volume.set(r, (volume.get(r) ?? 0) + per)
    totalVolume += v
  }
  const vCount = (r: number): number => volume.get(r) ?? 0
  const vPoc = totalVolume > 0 ? pocOf(vCount, lo, hi) : poc
  const [vVaLo, vVaHi] = totalVolume > 0 ? valueArea(vCount, lo, hi, vPoc, o.valueAreaPct) : [vaLo, vaHi]

  return {
    start, end, blocks, rowSize: rs, lo, hi, rows, total, poc, vaLo, vaHi, ib,
    open: bars[0].open,
    close: bars[bars.length - 1].close,
    mid: round(((lo + hi + 1) * rs) / 2),
    singles,
    poorHigh: count(hi) > 1,
    poorLow: count(lo) > 1,
    volume, totalVolume, vPoc, vVaLo, vVaHi,
    complete,
  }
}

/**
 * TradingView's day types from the Initial Balance (shown as a label): normal
 * (≥ 85% of the range inside the IB), normal variation (range up to 2× the IB),
 * trend (beyond 2× the IB and closing near the extreme it extended to),
 * neutral (extended beyond both sides of the IB).
 */
export function dayType(p: TpoProfile): 'Normal' | 'Normal variation' | 'Trend' | 'Neutral' {
  const hi = (p.hi + 1) * p.rowSize, lo = p.lo * p.rowSize
  const range = hi - lo, ibR = p.ib[1] - p.ib[0]
  if (!(range > 0) || !(ibR > 0)) return 'Normal'
  const above = p.blocks.some((b) => b.high > p.ib[1]), below = p.blocks.some((b) => b.low < p.ib[0])
  if (above && below) return 'Neutral'
  if (ibR / range >= 0.85) return 'Normal'
  const loc = (p.close - lo) / range
  if (range > 2 * ibR && (above ? loc >= 0.75 : loc <= 0.25)) return 'Trend'
  return 'Normal variation'
}

/** Price tick of the bars: the finest decimal step their prices use (capped at 8 places). */
export function inferTick(bars: TpoBar[]): number {
  let dec = 0
  for (const b of bars.slice(-200)) {
    for (const v of [b.open, b.high, b.low, b.close]) {
      const s = String(v)
      const d = s.includes('e-') ? Number(s.split('e-')[1]) : (s.split('.')[1] ?? '').length
      dec = Math.max(dec, Math.min(8, d))
    }
  }
  return round(Math.pow(10, -dec))
}

/** Bar index from which price first trades through `price` after the profile ended (−1: not yet). */
export function firstTouchAfter(bars: TpoBar[], from: number, price: number): number {
  for (let i = 0; i < bars.length; i++) if (bars[i].time >= from && bars[i].low <= price && bars[i].high >= price) return i
  return -1
}
