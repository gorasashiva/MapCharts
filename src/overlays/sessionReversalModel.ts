/**
 * Session Reversal -> Next-Session Expansion tester — port of
 * "session reversal.pine" (Pine v6 strategy "SessRevExp").
 *
 * Tests the claim "if a session reverses, the NEXT session expands in the
 * reversal direction":
 *   Asia rev -> trade London | London rev -> NY AM | NY AM rev -> NY PM | NY PM rev -> Asia
 *
 * A session reverses when it trades beyond the previous session's high (low),
 * then closes back inside it (and, optionally, against its own open). The
 * swept extreme is the swing. The next session then:
 *   - is measured: range vs that session type's average range, and whether it
 *     closed in the reversal direction (vs a baseline of sessions that did not
 *     follow a reversal);
 *   - is traded: if its first bar closes on the right side of the swing, enter
 *     at the next bar's open, stop at the swing, target `rr` × risk; closed at
 *     the session end if neither is hit. Both on one bar counts as a loss.
 *
 * Pure and bar-by-bar with no look-ahead, so a clipped series (bar replay)
 * gives exactly the state the script would show at that bar. Sessions are New
 * York time with US daylight saving. The source's strategy.* orders only
 * mirror its own simulated trade (entry next open, same stop / target, close
 * at session end), so the simulation stands in for both.
 */

export interface SrBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export const SR_NAMES = ['Asia', 'London', 'NY AM', 'NY PM'] as const

export interface SrOptions {
  /** [start, end) in New York minutes of day for Asia, London, NY AM, NY PM (end 0 = midnight). */
  sessions: [number, number][]
  needBody: boolean
  rr: number
  avgLen: number
  expThresh: number
  /** Only count sessions / trades with bar time in [from, until] (epoch ms). */
  from: number
  until: number
}

export const SR_DEFAULTS: SrOptions = {
  sessions: [
    [20 * 60, 0],
    [2 * 60, 5 * 60],
    [8 * 60 + 30, 11 * 60],
    [13 * 60 + 30, 16 * 60],
  ],
  needBody: true,
  rr: 2,
  avgLen: 20,
  expThresh: 1.2,
  from: Date.UTC(2015, 0, 1),
  until: Date.UTC(2099, 0, 1),
}

export interface SrSessionSpan {
  sid: number
  t0: number // first bar
  t1: number // last bar
}
export interface SrReversal {
  time: number // bar of the swept extreme
  price: number
  dir: 1 | -1 // 1 bullish (swept the low), -1 bearish (swept the high)
  sid: number
}
export interface SrTrade {
  from: number // reversing session id
  sid: number // traded session id
  dir: 1 | -1
  entryTime: number
  entry: number
  stop: number
  target: number
  /** Last bar the stop / target lines are plotted on (Pine plots while still in the trade after the bar). */
  plotEndTime?: number
  exitTime?: number
  exitPrice?: number
  exitReason?: 'TP' | 'SL' | 'Session end'
  r?: number
}
export interface SrRow {
  reversals: number
  expHit: number
  ratioSum: number
  dirHit: number
  trades: number
  wins: number
  totalR: number
}
export interface SrResult {
  spans: SrSessionSpan[]
  reversals: SrReversal[]
  trades: SrTrade[]
  /** Indexed by the REVERSING session (0..3). */
  rows: SrRow[]
  baseline: { n: number; expHit: number; ratioSum: number }
}

const HOUR = 3_600_000
const dstCache = new Map<number, [number, number]>()
/** US DST window [start, end) in UTC ms: 2nd Sunday of March 07:00Z -> 1st Sunday of November 06:00Z. */
function usDst(year: number): [number, number] {
  let w = dstCache.get(year)
  if (!w) {
    const nthSunday = (month: number, nth: number): number => 1 + ((7 - new Date(Date.UTC(year, month, 1)).getUTCDay()) % 7) + (nth - 1) * 7
    w = [Date.UTC(year, 2, nthSunday(2, 2), 7), Date.UTC(year, 10, nthSunday(10, 1), 6)]
    dstCache.set(year, w)
  }
  return w
}
/** New York wall-clock time encoded as UTC ms (read it back with getUTC*). */
export function nyWallClock(t: number): number {
  const [s, e] = usDst(new Date(t).getUTCFullYear())
  return t + (t >= s && t < e ? -4 : -5) * HOUR
}

function inWindow(m: number, [s, e]: readonly [number, number]): boolean {
  const end = e === 0 ? 1440 : e
  return s < end ? m >= s && m < end : m >= s || m < end
}

export function computeSessionReversal(bars: SrBar[], opts: Partial<SrOptions> = {}): SrResult {
  const o: SrOptions = { ...SR_DEFAULTS, ...opts }
  const rows: SrRow[] = [0, 1, 2, 3].map(() => ({ reversals: 0, expHit: 0, ratioSum: 0, dirHit: 0, trades: 0, wins: 0, totalR: 0 }))
  const baseline = { n: 0, expHit: 0, ratioSum: 0 }
  const spans: SrSessionSpan[] = []
  const reversals: SrReversal[] = []
  const trades: SrTrade[] = []
  const avgRange: number[] = [Number.NaN, Number.NaN, Number.NaN, Number.NaN]

  let curId = -1
  let cO = Number.NaN
  let cH = Number.NaN
  let cL = Number.NaN
  let cC = Number.NaN
  let cHBar = 0
  let cLBar = 0
  let prevId = -1
  let prevH = Number.NaN
  let prevL = Number.NaN
  let pendDir: -1 | 0 | 1 = 0
  let pendFrom = -1
  let pendSwing = Number.NaN
  let armed = false
  let armBar = 0
  let tDir: 1 | -1 = 1
  let tSess = -1
  let tFrom = -1
  let tStop = Number.NaN
  let trade: SrTrade | null = null // the open simulated trade (Pine's inTrade)

  const closeTrade = (i: number, price: number, reason: SrTrade['exitReason'], r: number): void => {
    const row = rows[tFrom]
    row.trades++
    row.totalR += r
    if (r > 0) row.wins++
    Object.assign(trade!, { exitTime: bars[i].time, exitPrice: price, exitReason: reason, r })
    trade = null
  }

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const d = new Date(nyWallClock(b.time))
    const m = d.getUTCHours() * 60 + d.getUTCMinutes()
    let sid = -1
    for (let k = 0; k < 4 && sid < 0; k++) if (inWindow(m, o.sessions[k])) sid = k
    const inWin = b.time >= o.from && b.time <= o.until

    // session shading spans (contiguous bars of one session)
    const span = spans[spans.length - 1]
    if (sid >= 0) {
      if (span && span.sid === sid && i > 0 && span.t1 === bars[i - 1].time) span.t1 = b.time
      else spans.push({ sid, t0: b.time, t1: b.time })
    }

    // 1) A session just ended -> finalize it
    if (curId !== -1 && sid !== curId) {
      const endedId = curId
      const rng = cH - cL
      const avgPrev = avgRange[endedId]
      const ratio = Number.isNaN(avgPrev) || avgPrev === 0 ? Number.NaN : rng / avgPrev
      const isExp = pendDir !== 0 && endedId === (pendFrom + 1) % 4
      if (!Number.isNaN(ratio) && inWin) {
        if (isExp) {
          const row = rows[pendFrom]
          row.reversals++
          row.ratioSum += ratio
          if (ratio >= o.expThresh) row.expHit++
          if (Math.sign(cC - cO) === pendDir) row.dirHit++
        } else {
          baseline.n++
          baseline.ratioSum += ratio
          if (ratio >= o.expThresh) baseline.expHit++
        }
      }
      // close a still-open simulated trade at this bar's open
      if (trade && tSess === endedId) closeTrade(i, b.open, 'Session end', (tDir * (b.open - trade.entry)) / Math.abs(trade.entry - tStop))
      armed = false
      pendDir = 0
      // rolling average range for this session type (after measuring: no look-ahead)
      avgRange[endedId] = Number.isNaN(avgPrev) ? rng : avgPrev + ((rng - avgPrev) * 2) / (o.avgLen + 1)
      // did THIS session reverse relative to the one before it?
      let rev: -1 | 0 | 1 = 0
      if (prevId === (endedId + 3) % 4 && !Number.isNaN(prevH)) {
        const bearRev = cH > prevH && cC < prevH && (!o.needBody || cC < cO)
        const bullRev = cL < prevL && cC > prevL && (!o.needBody || cC > cO)
        rev = bearRev && !bullRev ? -1 : bullRev && !bearRev ? 1 : 0
      }
      if (rev !== 0) {
        pendDir = rev
        pendFrom = endedId
        pendSwing = rev === -1 ? cH : cL
        reversals.push({ time: bars[rev === -1 ? cHBar : cLBar].time, price: pendSwing, dir: rev, sid: endedId })
      }
      prevId = endedId
      prevH = cH
      prevL = cL
      curId = -1
    }

    // 2) Session start / update
    if (sid !== -1 && curId === -1) {
      curId = sid
      cO = b.open
      cH = b.high
      cL = b.low
      cC = b.close
      cHBar = i
      cLBar = i
      // the session after a reversal -> arm a trade in the reversal direction
      if (pendDir !== 0 && sid === (pendFrom + 1) % 4 && inWin && (pendDir === 1 ? b.close > pendSwing : b.close < pendSwing)) {
        armed = true
        armBar = i
        tDir = pendDir
        tSess = sid
        tFrom = pendFrom
        tStop = pendSwing
      }
    } else if (sid !== -1 && sid === curId) {
      if (b.high > cH) {
        cH = b.high
        cHBar = i
      }
      if (b.low < cL) {
        cL = b.low
        cLBar = i
      }
      cC = b.close
    }

    // 3) Simulated trade: enter at the next bar's open (same as the strategy fill)
    if (armed && sid === tSess && i > armBar) {
      const entry = b.open
      const rDist = Math.abs(entry - tStop)
      if (rDist > 0 && (tDir === 1 ? entry > tStop : entry < tStop)) {
        trade = { from: tFrom, sid: tSess, dir: tDir, entryTime: b.time, entry, stop: tStop, target: entry + tDir * o.rr * rDist }
        trades.push(trade)
      }
      armed = false
    }
    if (trade && sid === tSess) {
      const hitStop = tDir === 1 ? b.low <= tStop : b.high >= tStop
      const hitTgt = tDir === 1 ? b.high >= trade.target : b.low <= trade.target
      if (hitStop) closeTrade(i, tStop, 'SL', -1) // both on one bar -> loss (conservative)
      else if (hitTgt) closeTrade(i, trade.target, 'TP', o.rr)
    }
    if (trade) trade.plotEndTime = b.time
  }

  return { spans, reversals, trades, rows, baseline }
}
