/**
 * MAP V3 trade suggestions — the SYNDICATE "THE MAP" playbook as rules, on
 * MAP V3's locked daily levels (Call / Put Wall, 0DTE Call / Put, Gamma Flip,
 * HVL, Max Pain):
 *
 *   1. Regime: close above the Gamma Flip = positive (fade extremes at walls),
 *      below = negative (momentum; break & retest preferred, reduced size).
 *   2. Touch & Bounce: a bar trades into a level and rejects it — closes back
 *      on the near side with a wick through the level. Entry at that close,
 *      stop just beyond the level (or the wick, whichever is further).
 *      Positive regime only by default.
 *   3. Break & Retest: a bar closes through a level; within `retestBars` price
 *      comes back to it and the bar closes holding it. Entry at that close,
 *      stop beyond the retest bar. Both regimes.
 *   Entries are taken at the walls and 0DTE levels only (`entryAll` widens it):
 *   the guide treats the Gamma Flip as the regime line and HVL / Max Pain as
 *   magnets — price chops around them, so they serve as targets.
 *   4. Targets: the next MAP level past the entry (≥ minR × risk away) is T1,
 *      the one after is T2. `partial` of the position comes off at T1 and the
 *      stop moves to breakeven; the rest runs to T2.
 *
 * Footprint confirmation (optional, `confirm`): the bar's order flow has to
 * agree — e.g. net buying or absorbed selling on a long rejection. Weekend
 * bars open nothing (the options market is closed), as the guide says.
 *
 * Pure — the levels for each bar and the footprint check are handed in.
 * A trade is decided on a closed bar from that bar and earlier only.
 */

export interface MapTradeBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface MapTradeLevel {
  price: number
  /** 'Put Wall', 'Call Wall', '0DTE Put', '0DTE Call', 'Gamma Flip', 'HVL', 'Max Pain'. */
  name: string
}

/** One locked MAP session's levels. */
export interface MapSessionLevels {
  /** Identifies the session (its morning snapshot). */
  id: string
  flip: number
  levels: MapTradeLevel[]
}

export type MapSetup = 'bounce' | 'retest'

export interface MapTradeOptions {
  touchBounce: boolean
  breakRetest: boolean
  /** Touch & Bounce in the negative regime too (the guide prefers break & retest there). */
  bounceInNegative: boolean
  /** "At the level": within this many average bar ranges. */
  tolAtr: number
  /** Stop buffer beyond the level / retest bar, in average bar ranges. */
  stopAtr: number
  /** Rejection candle: the wick through the level is ≥ this share of the bar's range. */
  wickShare: number
  retestBars: number
  /** T1 must be at least this many R away. */
  minR: number
  /** Share of the position taken off at T1 (the stop then goes to breakeven). */
  partial: number
  /** Close what is left after this many bars. */
  maxBars: number
  /** A stop closer than this many average bar ranges to the entry is pushed out to it (noise floor). */
  minRiskAtr: number
  maxRiskAtr: number
  /** No new trades on Saturday / Sunday (UTC). */
  skipWeekends: boolean
  /** Only trades the footprint confirmed (needs `confirm`). */
  requireConfirm: boolean
  /** Enter at every level, not only the walls and 0DTE levels. */
  entryAll: boolean
}

export const MAP_TRADE_DEFAULTS: MapTradeOptions = {
  touchBounce: true,
  breakRetest: true,
  bounceInNegative: false,
  tolAtr: 0.25,
  stopAtr: 0.25,
  wickShare: 0.4,
  retestBars: 12,
  minR: 1,
  partial: 0.5,
  maxBars: 48,
  minRiskAtr: 0.75,
  maxRiskAtr: 2.5,
  skipWeekends: true,
  requireConfirm: false,
  entryAll: false,
}

/** A level traded off (walls, 0DTE) rather than only aimed at (flip, HVL, Max Pain). */
const isEntryLevel = (l: MapTradeLevel): boolean => /Wall|0DTE/.test(l.name)

export interface MapTrade {
  setup: MapSetup
  side: 1 | -1
  level: MapTradeLevel
  regime: 'positive' | 'negative'
  sessionId: string
  /** Bar the trade was decided and entered on (at its close). */
  index: number
  entry: number
  stop: number
  t1: number
  t1Name: string
  t2: number | null
  t2Name: string | null
  /** Footprint check: true = confirmed, false = against, null = no footprint data. */
  fp: boolean | null
  t1Index: number | null
  exitIndex: number | null
  exitPrice: number | null
  outcome: 'open' | 't2' | 't1' | 'breakeven' | 'stop' | 'timeout'
  /** Result in R for the whole position (partial at T1 included); null while open. */
  r: number | null
  why: string
}

/** Footprint check for bar i in a direction: true / false, or null when there is no footprint for it. */
export type MapConfirm = (i: number, side: 1 | -1) => boolean | null

export function computeMapTrades(
  bars: MapTradeBar[],
  levelsAt: (i: number) => MapSessionLevels | null,
  opts: Partial<MapTradeOptions> = {},
  confirm?: MapConfirm,
): MapTrade[] {
  const o: MapTradeOptions = { ...MAP_TRADE_DEFAULTS, ...opts }
  const n = bars.length
  const trades: MapTrade[] = []
  let busyUntil = -1
  let breaks: { side: 1 | -1; level: MapTradeLevel; at: number }[] = []
  let sessionId = ''

  const atrAt = (i: number): number => {
    let s = 0, k = 0
    for (let j = Math.max(0, i - 13); j <= i; j++) (s += bars[j].high - bars[j].low), k++
    return s / k
  }

  for (let i = 1; i < n; i++) {
    const b = bars[i], prev = bars[i - 1]
    const ses = levelsAt(i)
    if (!ses) continue
    if (ses.id !== sessionId) {
      sessionId = ses.id
      breaks = []
    }
    const atr = atrAt(i)
    const tol = o.tolAtr * atr, buf = o.stopAtr * atr
    const regime = !Number.isFinite(ses.flip) || b.close >= ses.flip ? 'positive' : 'negative'
    const range = b.high - b.low

    // breaks of a level on this bar's close, waiting for their retest
    for (const l of o.entryAll ? ses.levels : ses.levels.filter(isEntryLevel)) {
      if (prev.close <= l.price && b.close > l.price + tol) breaks.push({ side: 1, level: l, at: i })
      else if (prev.close >= l.price && b.close < l.price - tol) breaks.push({ side: -1, level: l, at: i })
    }
    // a break that price closes back through has failed
    breaks = breaks.filter((k) => i - k.at <= o.retestBars && (k.side > 0 ? b.close > k.level.price - tol : b.close < k.level.price + tol))

    if (i <= busyUntil || !(range > 0)) continue
    const day = new Date(b.time).getUTCDay()
    if (o.skipWeekends && (day === 0 || day === 6)) continue

    type Cand = { setup: MapSetup; side: 1 | -1; level: MapTradeLevel; stop: number; why: string }
    const cands: Cand[] = []
    const entryLevels = o.entryAll ? ses.levels : ses.levels.filter(isEntryLevel)
    if (o.touchBounce && (regime === 'positive' || o.bounceInNegative)) {
      const lowerWick = Math.min(b.open, b.close) - b.low
      const upperWick = b.high - Math.max(b.open, b.close)
      for (const l of entryLevels) {
        // long: came from above, wicked into / through the level, closed back above it
        if (prev.close > l.price && b.low <= l.price + tol && b.close > l.price && lowerWick >= o.wickShare * range) {
          cands.push({ setup: 'bounce', side: 1, level: l, stop: Math.min(l.price, b.low) - buf, why: `Touch & bounce off ${l.name}` })
        }
        if (prev.close < l.price && b.high >= l.price - tol && b.close < l.price && upperWick >= o.wickShare * range) {
          cands.push({ setup: 'bounce', side: -1, level: l, stop: Math.max(l.price, b.high) + buf, why: `Touch & rejection at ${l.name}` })
        }
      }
    }
    if (o.breakRetest) {
      for (const k of breaks) {
        if (k.at >= i) continue // the break bar is not its own retest
        const p = k.level.price
        if (k.side > 0 && b.low <= p + tol && b.close > p) cands.push({ setup: 'retest', side: 1, level: k.level, stop: b.low - buf, why: `${k.level.name} broken and retested from above` })
        if (k.side < 0 && b.high >= p - tol && b.close < p) cands.push({ setup: 'retest', side: -1, level: k.level, stop: b.high + buf, why: `${k.level.name} broken and retested from below` })
      }
    }
    // the level actually tested: nearest the bar's extreme on the trade's side
    const dist = (c: Cand): number => Math.abs(c.level.price - (c.side > 0 ? b.low : b.high))
    cands.sort((x, y) => dist(x) - dist(y))

    for (const c of cands) {
      const entry = b.close
      // a stop inside ordinary bar noise is pushed out to the floor
      if ((entry - c.stop) * c.side < o.minRiskAtr * atr) c.stop = entry - c.side * o.minRiskAtr * atr
      const risk = (entry - c.stop) * c.side
      if (!(risk > 0) || risk > o.maxRiskAtr * atr) continue
      // targets: the next MAP levels past the entry, in order
      const ahead = ses.levels
        .filter((l) => (l.price - entry) * c.side >= o.minR * risk)
        .sort((x, y) => (x.price - entry) * c.side - (y.price - entry) * c.side)
      if (!ahead.length) continue
      const t1 = ahead[0]
      const t2 = ahead.find((l) => (l.price - t1.price) * c.side > tol) ?? null
      const fp = confirm ? confirm(i, c.side) : null
      if (o.requireConfirm && fp !== true) continue
      if (c.setup === 'retest') breaks = breaks.filter((k) => k.level !== c.level)
      const t: MapTrade = {
        setup: c.setup, side: c.side, level: c.level, regime, sessionId: ses.id, index: i, entry, stop: c.stop,
        t1: t1.price, t1Name: t1.name, t2: t2?.price ?? null, t2Name: t2?.name ?? null, fp,
        t1Index: null, exitIndex: null, exitPrice: null, outcome: 'open', r: null,
        why: `${c.why} (${regime} regime)`,
      }
      follow(t, bars, o)
      trades.push(t)
      busyUntil = t.exitIndex ?? Infinity
      break
    }
  }
  return trades
}

/** Partial at T1 (stop to breakeven), the rest to T2; stop first when one bar touches both. */
function follow(t: MapTrade, bars: MapTradeBar[], o: MapTradeOptions): void {
  const risk = Math.abs(t.entry - t.stop)
  const rAt = (px: number): number => ((px - t.entry) * t.side) / risk
  const part = t.t2 === null ? 1 : o.partial
  let booked = 0
  let stop = t.stop
  const done = (j: number, px: number, outcome: MapTrade['outcome']): void => {
    t.exitIndex = j
    t.exitPrice = px
    t.outcome = outcome
    const left = t.t1Index === null ? 1 : 1 - part
    t.r = Math.round((booked + left * rAt(px)) * 1e4) / 1e4
  }
  for (let j = t.index + 1; j < bars.length; j++) {
    const b = bars[j]
    if (t.side > 0 ? b.low <= stop : b.high >= stop) return done(j, stop, t.t1Index === null ? 'stop' : 'breakeven')
    if (t.t1Index === null && (t.side > 0 ? b.high >= t.t1 : b.low <= t.t1)) {
      t.t1Index = j
      booked = part * rAt(t.t1)
      if (part >= 1) return done(j, t.t1, 't1')
      stop = t.entry
    }
    if (t.t1Index !== null && t.t2 !== null && (t.side > 0 ? b.high >= t.t2 : b.low <= t.t2)) return done(j, t.t2, 't2')
    if (j - t.index >= o.maxBars) return done(j, b.close, 'timeout')
  }
}

/** MAP V3 levels (chart prices) as trade levels; levels at the same price are merged, missing ones left out. */
export function mapTradeLevels(l: { callWall: number; putWall: number; flip: number; hvl: number; maxPain: number; z: { call: number; put: number } }): MapTradeLevel[] {
  const out: MapTradeLevel[] = []
  const add = (price: number, name: string): void => {
    if (!Number.isFinite(price) || price <= 0) return
    const same = out.find((x) => Math.abs(x.price - price) < 1e-9)
    if (same) same.name += ` · ${name}`
    else out.push({ price, name })
  }
  add(l.putWall, 'Put Wall')
  add(l.callWall, 'Call Wall')
  add(l.z.put, '0DTE Put')
  add(l.z.call, '0DTE Call')
  add(l.flip, 'Gamma Flip')
  add(l.hvl, 'HVL')
  add(l.maxPain, 'Max Pain')
  return out.sort((a, b) => a.price - b.price)
}
