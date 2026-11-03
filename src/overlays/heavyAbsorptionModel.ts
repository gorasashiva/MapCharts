/**
 * Heavy Absorption — statistically big aggressive orders, and whether the
 * passive side actually absorbed them.
 *
 * Detection: every taker order (prints rebuilt into orders, see
 * takerOrders.ts) is a sample. For bar i the threshold comes from all order
 * sizes in the previous `lookback` bars (the bar itself is excluded, so a
 * live bar's threshold doesn't move under it); an order at or above
 * max(threshold, minVolume) is big. Methods:
 *   'percentile' (default) — the `percentile`-th size: "top 0.05% of orders".
 *       Order sizes on Delta span five orders of magnitude and bunch on round
 *       lots (0.001 / 0.1 / 1), so this is the only one whose marker rate is
 *       steady across symbols and days (recorded XAUTUSD tape, Oct 2026).
 *   'logSigma' — exp(mean + k·σ) of log(size).
 *   'sigma'    — mean + k·σ of the raw sizes (the textbook big-print rule;
 *       on skewed crypto tapes it flags most bars).
 *
 * Its price is the level that took the most of its size — where the resting
 * liquidity it hit sat — not the order's VWAP.
 *
 * Absorption check (goes beyond marking big prints): a big BUY at P was
 * absorbed when its bar closes at or below P and no high in the next
 * `confirmBars` bars trades above P + tolerance — the sellers resting at P
 * held. Mirror image for big sells. Until those bars exist it's 'pending';
 * a break inside the window makes it 'failed'. A held level extends right
 * until price trades through it by the tolerance.
 *
 * Pure — no DOM / engine. Bar i's threshold uses bars < i only; the verdict
 * stays 'pending' until its confirmation bars exist.
 */

export type AbsSide = 'buy' | 'sell'

/** One taker order, as built from the tape. */
export interface AbsOrder {
  time: number
  /** Level that filled the most of it. */
  price: number
  qty: number
  side: AbsSide
}

export interface AbsBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface HeavyAbsorptionOptions {
  lookback: number
  method: 'percentile' | 'logSigma' | 'sigma'
  /** Percentile method: 99.95 = an order bigger than 99.95% of the window's orders. */
  percentile: number
  /** σ methods: the k in mean + k·σ. */
  stdMult: number
  minVolume: number
  /** Fewest orders in the lookback window before a threshold is trusted. */
  minSamples: number
  /** 'bar' = one marker per bar and side (largest order's price, total big volume); 'order' = one per big order. */
  group: 'bar' | 'order'
  confirmBars: number
  /** Break / hold tolerance as a multiple of ATR(14) of the chart bars. */
  tolAtr: number
  /** Longest a held level is extended (bars). */
  maxLevelBars: number
}

export const HEAVY_ABSORPTION_DEFAULTS: HeavyAbsorptionOptions = {
  lookback: 100,
  method: 'percentile',
  percentile: 99.95,
  stdMult: 2,
  minVolume: 0,
  minSamples: 30,
  group: 'bar',
  confirmBars: 3,
  tolAtr: 0.25,
  maxLevelBars: 200,
}

export type AbsVerdict = 'absorbed' | 'failed' | 'pending'

export interface AbsMarker {
  barIndex: number
  barTime: number
  side: AbsSide
  price: number
  /** Total big volume (grouped) or the order's size. */
  volume: number
  /** Big orders merged into this marker. */
  orders: number
  threshold: number
  /** Order time (the largest one when grouped). */
  time: number
  verdict: AbsVerdict
  /** Bar index where an absorbed level was traded through (null = still holding / not absorbed). */
  brokenAt: number | null
}

export interface HeavyAbsorptionResult {
  markers: AbsMarker[]
  /** Threshold per bar (NaN where there weren't enough samples). */
  threshold: Float64Array
  /** Bars that had any orders (tape coverage). */
  covered: Uint8Array
}

/** Last bar whose open time is <= t (-1 when t is before the first bar). */
export function barIndexAt(bars: AbsBar[], t: number): number {
  let lo = 0
  let hi = bars.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].time <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

function atr14(bars: AbsBar[]): Float64Array {
  const out = new Float64Array(bars.length).fill(Number.NaN)
  let p = 0
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const tr = i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low
    p = i < 14 ? (p * i + tr) / (i + 1) : (p * 13 + tr) / 14
    out[i] = p
  }
  return out
}

/** `orders` must be sorted by time. */
export function computeHeavyAbsorption(bars: AbsBar[], orders: AbsOrder[], opts: Partial<HeavyAbsorptionOptions> = {}): HeavyAbsorptionResult {
  const o: HeavyAbsorptionOptions = { ...HEAVY_ABSORPTION_DEFAULTS, ...opts }
  const n = bars.length
  const threshold = new Float64Array(n).fill(Number.NaN)
  const covered = new Uint8Array(n)
  const markers: AbsMarker[] = []
  if (!n || !orders.length) return { markers, threshold, covered }

  // bar of each order
  const barOf = new Int32Array(orders.length)
  const cnt = new Float64Array(n)
  let bi = 0
  for (let k = 0; k < orders.length; k++) {
    const t = orders[k].time
    if (t < bars[0].time || !(orders[k].qty > 0)) {
      barOf[k] = -1
      continue
    }
    while (bi + 1 < n && bars[bi + 1].time <= t) bi++
    barOf[k] = bi
    cnt[bi]++
  }
  for (let i = 0; i < n; i++) covered[i] = cnt[i] > 0 ? 1 : 0
  // orders of bar i are orders[first[i] .. first[i+1]) among the in-range ones
  const first = new Int32Array(n + 1).fill(-1)
  for (let k = orders.length - 1; k >= 0; k--) if (barOf[k] >= 0) first[barOf[k]] = k
  first[n] = orders.length
  for (let i = n - 1; i >= 0; i--) if (first[i] < 0) first[i] = first[i + 1]
  const ordersOf = (i: number, f: (q: number) => void): void => {
    for (let k = first[i]; k < first[i + 1]; k++) if (barOf[k] === i) f(orders[k].qty)
  }

  const L = Math.max(1, Math.round(o.lookback))
  if (o.method === 'percentile') {
    // rolling histogram of log10(size): 400 bins per decade-ish resolution is plenty for a threshold
    const LO = -6
    const STEP = 0.005
    const NB = Math.ceil(12 / STEP)
    const hist = new Float64Array(NB)
    const binOf = (q: number): number => Math.max(0, Math.min(NB - 1, Math.floor((Math.log10(q) - LO) / STEP)))
    const p = Math.min(0.999999, Math.max(0.5, o.percentile / 100))
    let wc = 0
    for (let i = 0; i < n; i++) {
      if (wc >= o.minSamples) {
        // smallest bin whose cumulative share reaches p; its upper edge is the threshold
        const target = p * wc
        let acc = 0
        let b = 0
        for (; b < NB; b++) {
          acc += hist[b]
          if (acc >= target) break
        }
        threshold[i] = 10 ** (LO + (b + 1) * STEP)
      }
      ordersOf(i, (q) => {
        hist[binOf(q)]++
        wc++
      })
      if (i - L + 1 >= 0)
        ordersOf(i - L + 1, (q) => {
          hist[binOf(q)]--
          wc--
        })
    }
  } else {
    const log = o.method === 'logSigma'
    let wc = 0
    let ws = 0
    let wq = 0
    const add = (q: number, s: number): void => {
      const x = log ? Math.log(q) : q
      wc += s
      ws += s * x
      wq += s * x * x
    }
    for (let i = 0; i < n; i++) {
      if (wc >= o.minSamples) {
        const mean = ws / wc
        const sd = Math.sqrt(Math.max(0, wq / wc - mean * mean))
        // stored as a size either way
        threshold[i] = log ? Math.exp(mean + o.stdMult * sd) : mean + o.stdMult * sd
      }
      ordersOf(i, (q) => add(q, 1))
      if (i - L + 1 >= 0) ordersOf(i - L + 1, (q) => add(q, -1))
    }
  }

  // big orders → markers
  const groups = new Map<string, { m: AbsMarker; maxQty: number }>()
  for (let k = 0; k < orders.length; k++) {
    const i = barOf[k]
    if (i < 0) continue
    const th = threshold[i]
    const od = orders[k]
    if (!Number.isFinite(th) || od.qty < th || od.qty < o.minVolume) continue
    const fresh: AbsMarker = { barIndex: i, barTime: bars[i].time, side: od.side, price: od.price, volume: od.qty, orders: 1, threshold: th, time: od.time, verdict: 'pending', brokenAt: null }
    if (o.group === 'order') {
      markers.push(fresh)
      continue
    }
    const key = `${i}|${od.side}`
    const g = groups.get(key)
    if (!g) {
      groups.set(key, { m: fresh, maxQty: od.qty })
      markers.push(fresh)
    } else {
      g.m.volume += od.qty
      g.m.orders++
      if (od.qty > g.maxQty) {
        g.maxQty = od.qty
        g.m.price = od.price
        g.m.time = od.time
      }
    }
  }

  // absorption verdict + level life
  const atr = atr14(bars)
  for (const m of markers) {
    const i = m.barIndex
    const tol = o.tolAtr * (Number.isFinite(atr[i]) ? atr[i] : 0)
    const up = m.side === 'buy'
    // the aggressor pushed into P: absorbed if price couldn't get past it
    const broke = (b: AbsBar): boolean => (up ? b.high > m.price + tol : b.low < m.price - tol)
    const closedBack = up ? bars[i].close <= m.price : bars[i].close >= m.price
    if (i === n - 1) m.verdict = 'pending'
    else if (!closedBack) m.verdict = 'failed'
    else {
      m.verdict = 'absorbed'
      for (let j = i + 1; j <= i + o.confirmBars; j++) {
        if (j >= n) {
          m.verdict = 'pending'
          break
        }
        if (broke(bars[j])) {
          m.verdict = 'failed'
          break
        }
      }
    }
    if (m.verdict === 'absorbed') {
      for (let j = i + o.confirmBars + 1; j < n && j <= i + o.maxLevelBars; j++) {
        if (broke(bars[j])) {
          m.brokenAt = j
          break
        }
      }
    }
  }
  return { markers, threshold, covered }
}

/** The level inside an order's fills that took the most size (ties → the first). */
export function absorptionPrice(levels: [number, number][]): number {
  let best = levels[0]
  for (const l of levels) if (l[1] > best[1]) best = l
  return best[0]
}
