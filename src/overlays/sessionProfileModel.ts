/**
 * Sessions V2 model: one volume profile per trading session, with POC, VAH and VAL.
 *
 * Session boundaries come from sessionsModel.ts (computeSessions), so Asia / London /
 * New York sessions follow their own city's clock and daylight saving, the same as the
 * Sessions indicator. Each session occurrence (one box per day) gets its own profile
 * built from the candles inside that box.
 *
 * Profile: the session's low..high range is cut into `rows` equal price rows. Each bar's
 * volume is spread evenly over the rows its high..low range touches. The POC is the row
 * with the most volume. The value area grows out from the POC, one row at a time toward
 * the neighbour with more volume, until it holds `valueAreaPct` of the session volume.
 * VAH / VAL are the value area's top and bottom edges.
 *
 * Pure maths, no drawing: examples/basic/sessionsV2.ts draws it.
 */
import type { Candle } from '../core/types'
import { computeSessions, SESSIONS_DEFAULTS, type SessionDef } from './sessionsModel'

export interface SessionProfileOptions {
  sessions: SessionDef[]
  weekdaysOnly: boolean
  /** Price rows per profile. */
  rows: number
  /** Share of the session's volume the value area must hold (0..100). */
  valueAreaPct: number
}

export const SESSION_PROFILE_DEFAULTS: SessionProfileOptions = {
  sessions: SESSIONS_DEFAULTS.sessions,
  weekdaysOnly: true,
  rows: 24,
  valueAreaPct: 70,
}

export interface VolumeProfileStats {
  /** Lowest and highest price covered by the profile. */
  lo: number
  hi: number
  /** Height of one row in price units. */
  step: number
  /** Volume per row, row 0 = lowest. */
  bins: number[]
  totalVolume: number
  pocRow: number
  vahRow: number
  valRow: number
  /** Price at the middle of the POC row. */
  poc: number
  /** Top edge of the value area's highest row. */
  vah: number
  /** Bottom edge of the value area's lowest row. */
  val: number
}

export interface SessionProfile extends VolumeProfileStats {
  /** Index into the options' sessions. */
  session: number
  name: string
  /** First and last candle time inside this session occurrence. */
  start: number
  end: number
  /** Scheduled session end (epoch ms). */
  scheduledEnd: number
  /** The session is still running at the last loaded candle. */
  live: boolean
  barCount: number
}

/**
 * Volume profile of a set of candles. Returns null when the range is flat or no volume traded.
 * Each candle's volume is split evenly over the rows its high..low range touches.
 */
export function volumeProfileOf(candles: Candle[], rows: number, valueAreaPct: number): VolumeProfileStats | null {
  const nRows = Math.max(2, Math.round(rows))
  if (candles.length === 0) return null
  let lo = Infinity
  let hi = -Infinity
  for (const c of candles) {
    if (c.low < lo) lo = c.low
    if (c.high > hi) hi = c.high
  }
  if (!(hi > lo)) return null
  const step = (hi - lo) / nRows
  const bins = new Array<number>(nRows).fill(0)
  for (const c of candles) {
    const v = c.volume > 0 ? c.volume : 0
    if (!v) continue
    const first = Math.min(Math.floor((c.low - lo) / step), nRows - 1)
    let last = Math.min(Math.floor((c.high - lo) / step), nRows - 1)
    if (last < first) last = first
    const per = v / (last - first + 1)
    for (let r = first; r <= last; r++) bins[r] += per
  }
  const total = bins.reduce((a, b) => a + b, 0)
  if (!(total > 0)) return null

  let pocRow = 0
  for (let r = 1; r < nRows; r++) if (bins[r] > bins[pocRow]) pocRow = r

  // grow the value area from the POC toward the busier neighbour until it holds the target share
  const target = (total * Math.min(100, Math.max(0, valueAreaPct))) / 100
  let vahRow = pocRow
  let valRow = pocRow
  let covered = bins[pocRow]
  while (covered < target) {
    const canUp = vahRow < nRows - 1
    const canDown = valRow > 0
    if (!canUp && !canDown) break
    const up = canUp ? bins[vahRow + 1] : -1
    const down = canDown ? bins[valRow - 1] : -1
    if (canUp && up >= down) {
      vahRow++
      covered += bins[vahRow]
    } else {
      valRow--
      covered += bins[valRow]
    }
  }

  return {
    lo,
    hi,
    step,
    bins,
    totalVolume: total,
    pocRow,
    vahRow,
    valRow,
    poc: lo + (pocRow + 0.5) * step,
    vah: lo + (vahRow + 1) * step,
    val: lo + valRow * step,
  }
}

/** Index of the first candle at or after time t (candles are sorted by time). */
function lowerBound(candles: Candle[], t: number): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].time < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** One profile per session occurrence (one per enabled session per day), oldest first. */
export function computeSessionProfiles(candles: Candle[], opts: Partial<SessionProfileOptions> = {}): SessionProfile[] {
  const o: SessionProfileOptions = { ...SESSION_PROFILE_DEFAULTS, ...opts }
  if (candles.length === 0) return []
  const bars = candles.map((c) => ({ time: c.time, high: c.high, low: c.low }))
  const res = computeSessions(bars, { sessions: o.sessions, weekdaysOnly: o.weekdaysOnly })
  const out: SessionProfile[] = []
  for (const bx of res.boxes) {
    const i0 = lowerBound(candles, bx.start)
    const i1 = lowerBound(candles, bx.end + 1) // candles with time <= bx.end
    if (i1 <= i0) continue
    const inside = candles.slice(i0, i1)
    const stats = volumeProfileOf(inside, o.rows, o.valueAreaPct)
    if (!stats) continue
    out.push({ ...stats, session: bx.session, name: bx.name, start: bx.start, end: bx.end, scheduledEnd: bx.scheduledEnd, live: bx.live, barCount: inside.length })
  }
  return out
}
