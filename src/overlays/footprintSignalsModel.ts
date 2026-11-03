/**
 * Footprint signals — trade setups read off footprint bars (volume at price,
 * split by aggressor), each with an entry, stop and target:
 *
 *   stack     stacked imbalance: ≥ minStack consecutive diagonal imbalances one
 *             way (buys at a row ≥ imbalance × sells one row lower). The stack
 *             is a zone the aggressors defended; the trade is the first retest
 *             of it (limit at the zone's edge), stop beyond the zone.
 *   absorb    absorption at an extreme: a bar makes a swing low (high) and a
 *             large share of its selling (buying) printed in its bottom (top)
 *             rows, yet it closed in its upper (lower) part — passive orders
 *             soaked it up. Entry at the next bar's open, stop past the extreme.
 *   trap      trapped traders: at a swing extreme, a bar's delta is heavily one
 *             way (≥ trapDelta × the average |delta|) but it closes against
 *             that delta — the aggressors are now underwater.
 *   diverge   delta divergence at a swing extreme: a bar closes up on net
 *             selling at a swing low (or down on net buying at a swing high).
 *
 * Every signal is decided on a closed bar from that bar and earlier only; the
 * trade is then followed bar by bar (stop first when one bar touches both).
 *
 * Pure — no DOM / engine.
 */

export interface FpBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  /** row index (floor(price / rowSize)) -> [buy, sell] volume. */
  rows: Map<number, [number, number]>
}

export type FpSetup = 'stack' | 'absorb' | 'trap' | 'diverge'
export const FP_SETUPS: FpSetup[] = ['stack', 'absorb', 'trap', 'diverge']
export const FP_SETUP_LABEL: Record<FpSetup, string> = {
  stack: 'Stacked imbalance retest',
  absorb: 'Absorption at extreme',
  trap: 'Trapped traders',
  diverge: 'Delta divergence at extreme',
}

export interface FpSignalOptions {
  setups: Record<FpSetup, boolean>
  /** Diagonal imbalance ratio (3 = 300%). */
  imbalance: number
  /** Ignore imbalances whose bigger side is under this share of the bar's average row volume. */
  imbalanceMinVol: number
  minStack: number
  /** A stack is retested within this many bars, or dropped. */
  retestBars: number
  /** A swing low (high): the bar's low (high) beats the previous this-many bars. */
  swingBars: number
  /** absorb: share of the bar's selling (buying) printed in its extreme rows. */
  absorbShare: number
  absorbRows: number
  /** trap: |delta| ≥ this × the average |delta| of the previous 20 bars. */
  trapDelta: number
  /** Close location needed, 0–1 of the range measured from the extreme (0.6 = upper 40% at a low). */
  closeLoc: number
  /** Stop buffer beyond the extreme / zone, in rows. */
  stopRows: number
  /** Target as a multiple of risk. */
  rr: number
  /** Close at market after this many bars. */
  maxBars: number
  /** Skip trades whose risk is under / over these multiples of the average bar range. */
  minRiskAtr: number
  maxRiskAtr: number
  /** Cost per trade in price units (fees + slippage), taken off each result. */
  cost: number
  /** Trend filter: EMA length (0 = off). Stack trades only with the EMA's slope and side of price. */
  trendBars: number
  /** Reversal filter (0 = off): a long reversal needs the close ≥ this many average ranges under the EMA (stretched), shorts the mirror. */
  stretchAtr: number
}

export const FP_SIGNAL_DEFAULTS: FpSignalOptions = {
  // the recorded-tape study (5m, XAUT/BTC/ETH): absorption and traps from a stretch held up; stacks and
  // divergence did not after costs, so they start off
  setups: { stack: false, absorb: true, trap: true, diverge: false },
  imbalance: 3,
  imbalanceMinVol: 0.25,
  minStack: 3,
  retestBars: 12,
  swingBars: 10,
  absorbShare: 0.35,
  absorbRows: 2,
  trapDelta: 2,
  closeLoc: 0.6,
  stopRows: 1,
  rr: 2,
  maxBars: 24,
  minRiskAtr: 0.3,
  maxRiskAtr: 2,
  cost: 0,
  trendBars: 20,
  stretchAtr: 1,
}

export interface FpTrade {
  setup: FpSetup
  side: 1 | -1
  /** Bar the signal was read on. */
  signalIndex: number
  /** Bar the entry fills in (may be bars.length: the next bar, not opened yet). */
  entryIndex: number
  entry: number
  stop: number
  target: number
  /** Price zone behind the trade (the stack, or the signal bar's range). */
  zone: [number, number]
  exitIndex: number | null
  exitPrice: number | null
  /** pending: waits for its entry bar; open: in the trade. */
  outcome: 'pending' | 'open' | 'target' | 'stop' | 'timeout'
  /** Result in R after cost (null until closed). */
  r: number | null
  why: string
}

export interface FpBarStat {
  delta: number
  vol: number
  /** Stacked imbalance runs: [loRow, hiRow, side]. */
  stacks: [number, number, 1 | -1][]
}

const round = (x: number): number => Math.round(x * 1e6) / 1e6

/** Delta, volume and stacked diagonal imbalances of one bar. */
export function fpBarStat(rows: Map<number, [number, number]>, o: Pick<FpSignalOptions, 'imbalance' | 'imbalanceMinVol' | 'minStack'>): FpBarStat {
  let delta = 0, vol = 0, lo = Infinity, hi = -Infinity
  for (const [r, [b, s]] of rows) {
    delta += b - s
    vol += b + s
    lo = Math.min(lo, r)
    hi = Math.max(hi, r)
  }
  const stacks: [number, number, 1 | -1][] = []
  if (rows.size >= 2) {
    const minVol = (o.imbalanceMinVol * vol) / rows.size
    const get = (r: number): [number, number] => rows.get(r) ?? [0, 0]
    for (const side of [1, -1] as const) {
      let runLo = NaN, runHi = NaN
      const flush = (): void => {
        if (Number.isFinite(runLo) && runHi - runLo + 1 >= o.minStack) stacks.push([runLo, runHi, side])
        runLo = runHi = NaN
      }
      for (let r = lo; r <= hi; r++) {
        // buy imbalance: buys at r vs sells one row lower; sell imbalance: sells at r vs buys one row higher
        const big = side > 0 ? get(r)[0] : get(r)[1]
        const other = side > 0 ? get(r - 1)[1] : get(r + 1)[0]
        if (big >= minVol && big > 0 && big >= o.imbalance * other) {
          if (!Number.isFinite(runLo)) runLo = r
          runHi = r
        } else flush()
      }
      flush()
    }
  }
  return { delta, vol, stacks }
}

/** All signals over the bars (oldest first) and how each trade played out. One trade at a time. */
export function computeFootprintSignals(bars: FpBar[], rowSize: number, opts: Partial<FpSignalOptions> = {}): { trades: FpTrade[]; stats: FpBarStat[] } {
  const o: FpSignalOptions = { ...FP_SIGNAL_DEFAULTS, ...opts, setups: { ...FP_SIGNAL_DEFAULTS.setups, ...opts.setups } }
  const n = bars.length
  const stats = bars.map((b) => fpBarStat(b.rows, o))
  const trades: FpTrade[] = []
  const zones: { side: 1 | -1; lo: number; hi: number; from: number }[] = []
  let busyUntil = -1 // index of the bar the current trade closed on

  const atrAt = (i: number): number => {
    let s = 0, k = 0
    for (let j = Math.max(0, i - 19); j <= i; j++) (s += bars[j].high - bars[j].low), k++
    return s / k
  }
  const absDeltaAt = (i: number): number => {
    let s = 0, k = 0
    for (let j = Math.max(0, i - 20); j < i; j++) (s += Math.abs(stats[j].delta)), k++
    return k ? s / k : NaN
  }
  const ema: number[] = []
  if (o.trendBars > 0) {
    const k = 2 / (o.trendBars + 1)
    for (let i = 0; i < n; i++) ema.push(i ? ema[i - 1] + (bars[i].close - ema[i - 1]) * k : bars[i].close)
  }
  /** Stack trades go with the trend: price on the EMA's side and the EMA sloping that way. */
  const withTrend = (i: number, side: 1 | -1): boolean =>
    !(o.trendBars > 0) || (i >= o.trendBars && (bars[i].close - ema[i]) * side > 0 && (ema[i] - ema[i - 3]) * side > 0)
  /** Reversals only from a stretch away from the EMA. */
  const stretched = (i: number, side: 1 | -1): boolean => !(o.stretchAtr > 0 && o.trendBars > 0) || (i >= o.trendBars && (ema[i] - bars[i].close) * side >= o.stretchAtr * atrAt(i))
  const isSwing = (i: number, side: 1 | -1): boolean => {
    if (i < o.swingBars) return false
    for (let j = i - o.swingBars; j < i; j++) if (side > 0 ? bars[j].low <= bars[i].low : bars[j].high >= bars[i].high) return false
    return true
  }
  const close = (t: FpTrade, j: number, px: number, outcome: FpTrade['outcome']): void => {
    t.exitIndex = j
    t.exitPrice = px
    t.outcome = outcome
    t.r = round(((px - t.entry) * t.side - o.cost) / Math.abs(t.entry - t.stop))
  }
  const follow = (t: FpTrade): void => {
    for (let j = t.entryIndex; j < n; j++) {
      const b = bars[j]
      if (t.side > 0 ? b.low <= t.stop : b.high >= t.stop) return close(t, j, t.stop, 'stop')
      if (t.side > 0 ? b.high >= t.target : b.low <= t.target) return close(t, j, t.target, 'target')
      if (j - t.entryIndex + 1 >= o.maxBars) return close(t, j, b.close, 'timeout')
    }
    t.outcome = t.entryIndex < n ? 'open' : 'pending'
  }
  const push = (t: Omit<FpTrade, 'exitIndex' | 'exitPrice' | 'outcome' | 'r'>, atr: number): void => {
    const risk = Math.abs(t.entry - t.stop)
    if (!(risk > 0 && risk >= o.minRiskAtr * atr && risk <= o.maxRiskAtr * atr)) return
    const tr: FpTrade = { ...t, exitIndex: null, exitPrice: null, outcome: 'pending', r: null }
    trades.push(tr)
    follow(tr)
    busyUntil = tr.exitIndex ?? Infinity
  }

  for (let i = 0; i < n; i++) {
    const b = bars[i], st = stats[i]
    const atr = atrAt(i)
    const buf = o.stopRows * rowSize

    // 1. the first retest of an earlier stack, inside this bar: a limit at the zone's edge
    if (o.setups.stack) {
      for (let k = zones.length - 1; k >= 0; k--) {
        const z = zones[k]
        if (i - z.from > o.retestBars) {
          zones.splice(k, 1)
          continue
        }
        const edge = z.side > 0 ? z.hi : z.lo
        if (!(z.side > 0 ? b.low <= edge : b.high >= edge)) continue
        zones.splice(k, 1)
        // opened beyond the far side of the zone: a break, not a retest
        if ((z.side > 0 ? b.open < z.lo : b.open > z.hi) || i <= busyUntil) continue
        const entry = z.side > 0 ? Math.min(b.open, edge) : Math.max(b.open, edge)
        const stop = z.side > 0 ? z.lo - buf : z.hi + buf
        push(
          {
            setup: 'stack', side: z.side, signalIndex: z.from, entryIndex: i, entry, stop,
            target: entry + z.side * o.rr * Math.abs(entry - stop), zone: [z.lo, z.hi],
            why: `${z.side > 0 ? 'Buy' : 'Sell'} imbalances stacked ${z.hi - z.lo > 0 ? Math.round((z.hi - z.lo) / rowSize) : 0} rows deep, first retest`,
          },
          atr,
        )
      }
      // new stacks that agree with their bar (buyers stacked in a bar that closed up)
      for (const [lo, hi, side] of st.stacks) if ((b.close - b.open) * side > 0 && withTrend(i, side)) zones.push({ side, lo: lo * rowSize, hi: (hi + 1) * rowSize, from: i })
    }

    // 2. reversal signals on this closed bar; the trade enters at the next bar's open
    if (i <= busyUntil) continue
    const range = b.high - b.low
    if (!(range > 0)) continue
    const loc = (b.close - b.low) / range
    const entry = i + 1 < n ? bars[i + 1].open : b.close
    const mk = (setup: FpSetup, side: 1 | -1, why: string): void => {
      const stop = side > 0 ? b.low - buf : b.high + buf
      const risk = (entry - stop) * side
      if (!(risk > 0)) return
      push({ setup, side, signalIndex: i, entryIndex: i + 1, entry, stop, target: entry + side * o.rr * risk, zone: [b.low, b.high], why }, atr)
    }
    for (const side of [1, -1] as const) {
      if (i <= busyUntil || !isSwing(i, side) || !stretched(i, side)) continue
      if (!(side > 0 ? loc >= o.closeLoc : loc <= 1 - o.closeLoc)) continue
      if (o.setups.absorb) {
        // the side that pushed into the extreme: its volume in the extreme rows
        let ext = 0, all = 0
        const edgeRow = Math.floor((side > 0 ? b.low : b.high) / rowSize)
        for (const [r, [bu, se]] of b.rows) {
          const v = side > 0 ? se : bu
          all += v
          if (side > 0 ? r < edgeRow + o.absorbRows : r > edgeRow - o.absorbRows) ext += v
        }
        if (all > 0 && ext / all >= o.absorbShare) {
          mk('absorb', side, `${side > 0 ? 'Selling' : 'Buying'} absorbed at the ${side > 0 ? 'low' : 'high'}: ${Math.round((100 * ext) / all)}% of it in the last ${o.absorbRows} rows, closed ${side > 0 ? 'high' : 'low'}`)
          continue
        }
      }
      const avgD = absDeltaAt(i)
      if (o.setups.trap && avgD > 0 && -st.delta * side >= o.trapDelta * avgD) {
        mk('trap', side, `${side > 0 ? 'Sellers' : 'Buyers'} trapped: delta ${(Math.abs(st.delta) / avgD).toFixed(1)}× normal, closed against it`)
        continue
      }
      if (o.setups.diverge && (b.close - b.open) * side > 0 && st.delta * side < 0) mk('diverge', side, `Delta divergence at the ${side > 0 ? 'low' : 'high'}`)
    }
  }
  return { trades, stats }
}

export interface FpStats {
  trades: number
  wins: number
  winRate: number
  avgR: number
  totalR: number
  maxDdR: number
  profitFactor: number
}

/** Win rate, expectancy and drawdown (in R) of the closed trades. */
export function fpStats(trades: FpTrade[]): FpStats {
  let total = 0, peak = 0, dd = 0, gain = 0, loss = 0, wins = 0, k = 0
  for (const t of trades) {
    if (t.r === null) continue
    k++
    total += t.r
    if (t.r > 0) (wins++, (gain += t.r))
    else loss -= t.r
    peak = Math.max(peak, total)
    dd = Math.max(dd, peak - total)
  }
  return { trades: k, wins, winRate: k ? wins / k : 0, avgR: k ? total / k : 0, totalR: total, maxDdR: dd, profitFactor: loss > 0 ? gain / loss : gain > 0 ? Infinity : 0 }
}

// ---- GEX confluence ---------------------------------------------------------

/** A dealer-gamma level (GEX Sabers) a footprint signal can line up with. */
export interface FpGexLevel {
  price: number
  /** e.g. 'S1', 'R2 · L1', 'HVL', 'ZERO Γ'. */
  label: string
  strength: number
}

export interface FpGexMatch {
  /** The level the signal's extreme tested. */
  at: FpGexLevel
  /** The next level past the entry in the trade's direction, at least 1R away (a second target). */
  next: FpGexLevel | null
}

/**
 * Did the signal happen at a GEX level? A long's low (a short's high) must be
 * within `near` average bar ranges of a level — price tested the level and the
 * footprint shows it held. Any level kind counts: a gamma strike is where
 * dealer hedging concentrates, whichever side it is on.
 */
export function gexConfluence(t: Pick<FpTrade, 'side' | 'zone' | 'entry' | 'stop'>, levels: FpGexLevel[], avgRange: number, near = 0.5): FpGexMatch | null {
  const extreme = t.side > 0 ? t.zone[0] : t.zone[1]
  let at: FpGexLevel | null = null
  for (const l of levels) if (Math.abs(l.price - extreme) <= near * avgRange && (!at || Math.abs(l.price - extreme) < Math.abs(at.price - extreme))) at = l
  if (!at) return null
  const risk = Math.abs(t.entry - t.stop)
  let next: FpGexLevel | null = null
  for (const l of levels) {
    const d = (l.price - t.entry) * t.side
    if (d >= risk && (!next || d < (next.price - t.entry) * t.side)) next = l
  }
  return { at, next }
}
