/**
 * Market sessions + previous 1H / 4H high & low.
 *
 * Sessions are defined in their own city's local time, so daylight saving is
 * handled automatically:
 *   Asia     — Tokyo time (Japan has no DST)
 *   London   — UK time (BST: last Sunday of March 01:00 UTC -> last Sunday of October 01:00 UTC)
 *   New York — US Eastern time (EDT: 2nd Sunday of March 07:00 UTC -> 1st Sunday of November 06:00 UTC)
 * Each session instance tracks its high / low over the bars inside it (growing
 * live while the session is open).
 *
 * Previous 1H / 4H high & low: the high / low of the last COMPLETED 1-hour and
 * 4-hour candle (UTC-aligned, as exchanges build them), as a step series — at
 * every bar the level is the previous period's extreme — so it never looks
 * ahead and follows bar replay.
 *
 * Pure — no DOM / engine.
 */

export interface SessBar {
  time: number
  high: number
  low: number
}

export type SessTz = 'Asia/Tokyo' | 'Europe/London' | 'America/New_York' | 'Asia/Kolkata' | 'UTC'

export interface SessionDef {
  name: string
  tz: SessTz
  /** Local minutes of day; end <= start means the session runs past local midnight. */
  start: number
  end: number
  enabled: boolean
}

export interface SessionsOptions {
  sessions: SessionDef[]
  weekdaysOnly: boolean
}

export const SESSIONS_DEFAULTS: SessionsOptions = {
  sessions: [
    { name: 'Asia', tz: 'Asia/Tokyo', start: 9 * 60, end: 18 * 60, enabled: true },
    { name: 'London', tz: 'Europe/London', start: 8 * 60, end: 17 * 60, enabled: true },
    { name: 'New York', tz: 'America/New_York', start: 8 * 60, end: 17 * 60, enabled: true },
  ],
  weekdaysOnly: true,
}

export interface SessionBox {
  /** Index into options.sessions. */
  session: number
  name: string
  /** First / last bar inside the session. */
  start: number
  end: number
  /** Scheduled session end (epoch ms) — the box can be drawn to here while the session is live. */
  scheduledEnd: number
  high: number
  low: number
  /** The last bar loaded is inside this session and it has not ended yet. */
  live: boolean
}

export interface PrevLevelSegment {
  /** First bar of the period this level applies to (the current 1H / 4H period). */
  from: number
  /** Last bar of that period loaded. */
  to: number
  high: number
  low: number
}

export interface SessionsResult {
  boxes: SessionBox[]
  /** Previous completed 1H / 4H candle high & low, one segment per period (empty when the chart timeframe is too coarse). */
  prev1h: PrevLevelSegment[]
  prev4h: PrevLevelSegment[]
}

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

const nthSunday = (year: number, month: number, nth: number): number => 1 + ((7 - new Date(Date.UTC(year, month, 1)).getUTCDay()) % 7) + (nth - 1) * 7
const lastSunday = (year: number, month: number): number => {
  const last = new Date(Date.UTC(year, month + 1, 0))
  return last.getUTCDate() - last.getUTCDay()
}
const dstCache = new Map<string, [number, number]>()
function dstWindow(kind: 'us' | 'eu', year: number): [number, number] {
  const k = `${kind}${year}`
  let w = dstCache.get(k)
  if (!w) {
    w =
      kind === 'us'
        ? [Date.UTC(year, 2, nthSunday(year, 2, 2), 7), Date.UTC(year, 10, nthSunday(year, 10, 1), 6)]
        : [Date.UTC(year, 2, lastSunday(year, 2), 1), Date.UTC(year, 9, lastSunday(year, 9), 1)]
    dstCache.set(k, w)
  }
  return w
}

/** UTC offset (minutes) of a zone at instant t. */
export function tzOffsetMin(tz: SessTz, t: number): number {
  switch (tz) {
    case 'Asia/Tokyo':
      return 540
    case 'Asia/Kolkata':
      return 330
    case 'UTC':
      return 0
    case 'Europe/London': {
      const [s, e] = dstWindow('eu', new Date(t).getUTCFullYear())
      return t >= s && t < e ? 60 : 0
    }
    case 'America/New_York': {
      const [s, e] = dstWindow('us', new Date(t).getUTCFullYear())
      return t >= s && t < e ? -240 : -300
    }
  }
}

/** Local wall-clock of t in tz, as fake-UTC ms (read with getUTC*). */
export function localClock(tz: SessTz, t: number): number {
  return t + tzOffsetMin(tz, t) * MIN
}

/** If t is inside the session, the local midnight (fake-UTC ms) of the day the session started on; else null. */
function sessionDay(def: SessionDef, t: number): number | null {
  const lc = localClock(def.tz, t)
  const m = Math.floor((lc % DAY) / MIN)
  const midnight = lc - (lc % DAY)
  if (def.start < def.end) return m >= def.start && m < def.end ? midnight : null
  if (m >= def.start) return midnight
  if (m < def.end) return midnight - DAY
  return null
}

/** Epoch ms of the scheduled end of a session that started on local day `dayMidnight`. */
function scheduledEnd(def: SessionDef, dayMidnight: number): number {
  const endLocal = dayMidnight + (def.end <= def.start ? DAY : 0) + def.end * MIN
  const guess = endLocal - tzOffsetMin(def.tz, endLocal) * MIN
  return endLocal - tzOffsetMin(def.tz, guess) * MIN
}

function prevLevels(bars: SessBar[], periodMs: number): PrevLevelSegment[] {
  const out: PrevLevelSegment[] = []
  let curKey = Number.NaN
  let curHi = -Infinity
  let curLo = Infinity
  let prev: { key: number; hi: number; lo: number } | null = null
  let seg: PrevLevelSegment | null = null
  for (const b of bars) {
    const key = b.time - (b.time % periodMs)
    if (key !== curKey) {
      if (Number.isFinite(curKey)) prev = { key: curKey, hi: curHi, lo: curLo }
      curKey = key
      curHi = -Infinity
      curLo = Infinity
      // only the immediately preceding period counts (a data gap leaves no "previous" level)
      seg = prev && prev.key === key - periodMs ? { from: b.time, to: b.time, high: prev.hi, low: prev.lo } : null
      if (seg) out.push(seg)
    }
    curHi = Math.max(curHi, b.high)
    curLo = Math.min(curLo, b.low)
    if (seg) seg.to = b.time
  }
  return out
}

export function computeSessions(bars: SessBar[], opts: Partial<SessionsOptions> = {}): SessionsResult {
  const o: SessionsOptions = { ...SESSIONS_DEFAULTS, ...opts }
  const boxes: SessionBox[] = []
  const n = bars.length
  if (!n) return { boxes, prev1h: [], prev4h: [] }
  const barMs = n > 1 ? bars[n - 1].time - bars[n - 2].time : MIN

  o.sessions.forEach((def, si) => {
    if (!def.enabled) return
    let cur: (SessionBox & { day: number }) | null = null
    for (let i = 0; i < n; i++) {
      const b = bars[i]
      const day = sessionDay(def, b.time)
      const wd = day === null ? -1 : new Date(day).getUTCDay()
      if (day === null || (o.weekdaysOnly && (wd === 0 || wd === 6))) {
        cur = null
        continue
      }
      if (!cur || cur.day !== day) {
        cur = { session: si, name: def.name, start: b.time, end: b.time, scheduledEnd: scheduledEnd(def, day), high: b.high, low: b.low, live: false, day }
        boxes.push(cur)
      } else {
        cur.end = b.time
        if (b.high > cur.high) cur.high = b.high
        if (b.low < cur.low) cur.low = b.low
      }
    }
  })
  const last = bars[n - 1].time
  for (const bx of boxes) bx.live = bx.end === last && last + barMs < bx.scheduledEnd
  boxes.sort((a, b) => a.start - b.start)

  return {
    boxes: boxes.map(({ session, name, start, end, scheduledEnd: se, high, low, live }) => ({ session, name, start, end, scheduledEnd: se, high, low, live })),
    prev1h: barMs <= HOUR ? prevLevels(bars, HOUR) : [],
    prev4h: barMs <= 4 * HOUR ? prevLevels(bars, 4 * HOUR) : [],
  }
}
