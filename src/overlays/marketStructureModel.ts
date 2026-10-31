/**
 * Market Structure — zigzag swings, HH / HL / LH / LL labels, BOS / CHoCH breaks,
 * liquidity sweeps, a break-quality score and a trend / chop state.
 *
 * Swings come from an ATR zigzag (a swing is confirmed once price retraces
 * `devAtr` × ATR from the running extreme) or from classic pivots (`depth` bars
 * each side, optionally with a minimum leg of `devAtr` × ATR). Breaks are judged on
 * the candle close, so a wick through a swing that closes back inside is a sweep
 * (liquidity grab), not a break.
 *
 * Break quality (researched on Delta XAUTUSD / PAXGUSD 1m–1h, Feb–Oct 2026, ~1.3M
 * simulated breaks): same-timeframe chop filters (efficiency ratio, choppiness,
 * swing agreement) did NOT separate good from bad breaks. Two things did, on every
 * zigzag size from 1m to 15m:
 *   - volatility state, ATR(atrLen) / ATR(volLen): >= volExpand +1, < volCompress −1
 *     (compressed breaks were stop-hunted ~2× as often);
 *   - session (intraday charts only): Asia (00–07 UTC) +1, New York (12–17 UTC) −1.
 * Score >= 2 averaged about +0.2R at a 2R target; <= −1 about −0.1 to −0.3R.
 *
 * Pure — no DOM / engine. No look-ahead: everything at bar i uses bars <= i only,
 * so bar replay sees exactly what a live chart saw.
 */

export interface MsBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export type MsSwingMode = 'atr' | 'pivot'

export interface MsOptions {
  swingMode: MsSwingMode
  /** atr mode: reversal size in ATR multiples. pivot mode: minimum leg size in ATR (0 = off). */
  devAtr: number
  /** pivot mode: bars each side. */
  depth: number
  atrLen: number
  /** Breaks need a close beyond the swing (true) or just a wick (false). */
  closeBreaks: boolean
  /** Slow ATR for the volatility ratio. */
  volLen: number
  volExpand: number
  volCompress: number
  /** Score the session (only on charts below 1h). */
  useSession: boolean
  asiaStartUTC: number
  asiaEndUTC: number
  nyStartUTC: number
  nyEndUTC: number
  /** Breaks scoring at least this are traded (Strategy Tester) and marked as signals. */
  minScore: number
  targetR: number
  /** No new trades on Saturday / Sunday (UTC). */
  skipWeekends: boolean
}

export const MS_DEFAULTS: MsOptions = {
  swingMode: 'atr',
  devAtr: 3,
  depth: 5,
  atrLen: 14,
  closeBreaks: true,
  volLen: 100,
  volExpand: 1.2,
  volCompress: 0.8,
  useSession: true,
  asiaStartUTC: 0,
  asiaEndUTC: 7,
  nyStartUTC: 12,
  nyEndUTC: 17,
  minScore: 2,
  targetR: 2,
  skipWeekends: true,
}

export type MsLabel = 'HH' | 'LH' | 'HL' | 'LL' | 'H' | 'L'

export interface MsSwing {
  /** Bar of the extreme. */
  idx: number
  /** Bar on whose close the swing became known. */
  confirmIdx: number
  price: number
  high: boolean
  label: MsLabel
}

export type MsEventKind = 'BOS' | 'CHoCH' | 'SWEEP'

export interface MsEvent {
  kind: MsEventKind
  /** Direction of the move the event implies: +1 bullish, -1 bearish (a sweep of highs is bearish). */
  dir: 1 | -1
  idx: number
  /** The swing level that was broken / swept. */
  level: number
  /** Bar of that swing. */
  fromIdx: number
  /** BOS / CHoCH: the protected extreme — lowest low (bullish) / highest high (bearish) since the broken swing. SWEEP: the sweep wick. */
  protectedLevel: number
  protectedIdx: number
  /** Break-quality score on this bar (see the header). */
  score: number
}

/** trend: breaks tend to follow through; chop: fakeout / stop-hunt risk; neutral: neither. */
export type MsRegime = 'trend' | 'chop' | 'neutral'

export interface MsTrade {
  dir: 1 | -1
  signalIdx: number
  entryIdx: number
  entryTime: number
  entry: number
  stop: number
  target: number
  exitIdx: number | null
  exitTime: number | null
  exitPrice: number | null
  exitReason: 'TP' | 'SL' | null
  /** Result in R (null while open). */
  r: number | null
  kind: 'BOS' | 'CHoCH'
  score: number
}

export interface MsResult {
  swings: MsSwing[]
  events: MsEvent[]
  /** Per bar: structure trend after that bar's close (+1 / -1 / 0 before the first break). */
  trend: Int8Array
  /** Per bar: break-quality score (volatility + session). */
  score: Int8Array
  /** Per bar: regime from the score. */
  regime: MsRegime[]
  atr: Float64Array
  volRatio: Float64Array
  trades: MsTrade[]
  /** Session scoring was active (intraday chart). */
  sessionActive: boolean
  /** The score a break needs to be traded: minScore, one lower when the session part is off (1h+ charts). */
  minScoreEff: number
}

/** Wilder ATR. */
export function atrSeries(bars: MsBar[], len: number): Float64Array {
  const out = new Float64Array(bars.length)
  let a = NaN
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))
    if (i < len) a = i === 0 ? tr : (a * i + tr) / (i + 1)
    else a = (a * (len - 1) + tr) / len
    out[i] = a
  }
  return out
}

const inHours = (h: number, a: number, b: number): boolean => (a <= b ? h >= a && h < b : h >= a || h < b)

/** Typical bar spacing in ms (median of the last gaps). */
function barInterval(bars: MsBar[]): number {
  const d: number[] = []
  for (let i = Math.max(1, bars.length - 50); i < bars.length; i++) d.push(bars[i].time - bars[i - 1].time)
  d.sort((a, b) => a - b)
  return d.length ? d[d.length >> 1] : 60_000
}

interface RawSwing {
  idx: number
  confirmIdx: number
  price: number
  high: boolean
}

function atrZigzag(bars: MsBar[], atr: Float64Array, dev: number): RawSwing[] {
  const out: RawSwing[] = []
  if (!bars.length) return out
  // Until the first leg is known, track both extremes.
  let dir = 0
  let hi = bars[0].high
  let hiIdx = 0
  let lo = bars[0].low
  let loIdx = 0
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]
    const th = dev * atr[i]
    if (dir >= 0 && b.high > hi) {
      hi = b.high
      hiIdx = i
    }
    if (dir <= 0 && b.low < lo) {
      lo = b.low
      loIdx = i
    }
    if (dir >= 0 && hiIdx < i && hi - b.low >= th && (dir === 1 || hiIdx > loIdx)) {
      out.push({ idx: hiIdx, confirmIdx: i, price: hi, high: true })
      dir = -1
      lo = b.low
      loIdx = i
    } else if (dir <= 0 && loIdx < i && b.high - lo >= th && (dir === -1 || loIdx > hiIdx)) {
      out.push({ idx: loIdx, confirmIdx: i, price: lo, high: false })
      dir = 1
      hi = b.high
      hiIdx = i
    }
  }
  return out
}

function pivotSwings(bars: MsBar[], atr: Float64Array, depth: number, minLegAtr: number): RawSwing[] {
  const out: RawSwing[] = []
  for (let c = 2 * depth; c < bars.length; c++) {
    const i = c - depth
    let isH = true
    let isL = true
    for (let k = i - depth; k <= i + depth && (isH || isL); k++) {
      if (k === i) continue
      // strict on the left, non-strict on the right: a flat top marks its first bar
      if (k < i ? bars[k].high >= bars[i].high : bars[k].high > bars[i].high) isH = false
      if (k < i ? bars[k].low <= bars[i].low : bars[k].low < bars[i].low) isL = false
    }
    for (const high of [true, false]) {
      if (high ? !isH : !isL) continue
      const price = high ? bars[i].high : bars[i].low
      const last = out[out.length - 1]
      if (last && last.high === high) {
        // two highs (lows) in a row: keep the more extreme one
        if (high ? price > last.price : price < last.price) out[out.length - 1] = { idx: i, confirmIdx: c, price, high }
        continue
      }
      if (last && minLegAtr > 0 && Math.abs(price - last.price) < minLegAtr * atr[c]) continue
      out.push({ idx: i, confirmIdx: c, price, high })
    }
  }
  return out
}

/** Swings for the chosen mode, labelled against the previous swing of the same side. */
export function findSwings(bars: MsBar[], o: MsOptions, atr = atrSeries(bars, o.atrLen)): MsSwing[] {
  const raw = o.swingMode === 'atr' ? atrZigzag(bars, atr, o.devAtr) : pivotSwings(bars, atr, Math.max(1, Math.round(o.depth)), o.devAtr)
  let prevH: number | null = null
  let prevL: number | null = null
  return raw.map((s) => {
    let label: MsLabel
    if (s.high) {
      label = prevH === null ? 'H' : s.price > prevH ? 'HH' : 'LH'
      prevH = s.price
    } else {
      label = prevL === null ? 'L' : s.price < prevL ? 'LL' : 'HL'
      prevL = s.price
    }
    return { ...s, label }
  })
}

/** Run the structure engine over `bars`. */
export function computeMarketStructure(bars: MsBar[], opts: Partial<MsOptions> = {}): MsResult {
  const o: MsOptions = { ...MS_DEFAULTS, ...opts }
  const n = bars.length
  const atr = atrSeries(bars, o.atrLen)
  const slow = atrSeries(bars, o.volLen)
  const volRatio = new Float64Array(n)
  const score = new Int8Array(n)
  const regime: MsRegime[] = new Array(n)
  const sessionActive = o.useSession && barInterval(bars) < 3_600_000
  for (let i = 0; i < n; i++) {
    const v = i >= o.volLen && slow[i] > 0 ? atr[i] / slow[i] : 1
    volRatio[i] = v
    let s = v >= o.volExpand ? 1 : v < o.volCompress ? -1 : 0
    if (sessionActive) {
      const h = new Date(bars[i].time).getUTCHours() + new Date(bars[i].time).getUTCMinutes() / 60
      if (inHours(h, o.asiaStartUTC, o.asiaEndUTC)) s++
      else if (inHours(h, o.nyStartUTC, o.nyEndUTC)) s--
    }
    score[i] = s
    regime[i] = s >= 1 ? 'trend' : s <= -1 ? 'chop' : 'neutral'
  }

  const swings = findSwings(bars, o, atr)
  const events: MsEvent[] = []
  const trendArr = new Int8Array(n)
  let trend = 0
  let hi: { price: number; idx: number; done: boolean; swept: boolean } | null = null
  let lo: { price: number; idx: number; done: boolean; swept: boolean } | null = null
  let si = 0
  // Running lowest low / highest high since the last swing high / low (the protected level on a break).
  let minSinceHi = Infinity
  let minSinceHiIdx = -1
  let maxSinceLo = -Infinity
  let maxSinceLoIdx = -1

  const extremeBetween = (from: number, to: number, high: boolean): { price: number; idx: number } => {
    let best = high ? -Infinity : Infinity
    let bi = from
    for (let k = from; k <= to; k++) {
      const v = high ? bars[k].high : bars[k].low
      if (high ? v > best : v < best) {
        best = v
        bi = k
      }
    }
    return { price: best, idx: bi }
  }

  for (let i = 0; i < n; i++) {
    const b = bars[i]
    if (b.low < minSinceHi) {
      minSinceHi = b.low
      minSinceHiIdx = i
    }
    if (b.high > maxSinceLo) {
      maxSinceLo = b.high
      maxSinceLoIdx = i
    }
    const upPx = o.closeBreaks ? b.close : b.high
    const dnPx = o.closeBreaks ? b.close : b.low

    if (hi && !hi.done) {
      if (upPx > hi.price) {
        events.push({ kind: trend === -1 ? 'CHoCH' : 'BOS', dir: 1, idx: i, level: hi.price, fromIdx: hi.idx, protectedLevel: minSinceHi, protectedIdx: minSinceHiIdx, score: score[i] })
        hi.done = true
        trend = 1
      } else if (o.closeBreaks && b.high > hi.price && !hi.swept) {
        events.push({ kind: 'SWEEP', dir: -1, idx: i, level: hi.price, fromIdx: hi.idx, protectedLevel: b.high, protectedIdx: i, score: score[i] })
        hi.swept = true
      }
    }
    if (lo && !lo.done) {
      if (dnPx < lo.price) {
        events.push({ kind: trend === 1 ? 'CHoCH' : 'BOS', dir: -1, idx: i, level: lo.price, fromIdx: lo.idx, protectedLevel: maxSinceLo, protectedIdx: maxSinceLoIdx, score: score[i] })
        lo.done = true
        trend = -1
      } else if (o.closeBreaks && b.low < lo.price && !lo.swept) {
        events.push({ kind: 'SWEEP', dir: 1, idx: i, level: lo.price, fromIdx: lo.idx, protectedLevel: b.low, protectedIdx: i, score: score[i] })
        lo.swept = true
      }
    }

    // swings confirmed on this bar's close become the levels to break from the next bar on
    while (si < swings.length && swings[si].confirmIdx === i) {
      const s = swings[si++]
      if (s.high) {
        hi = { price: s.price, idx: s.idx, done: false, swept: false }
        const m = extremeBetween(s.idx, i, false)
        minSinceHi = m.price
        minSinceHiIdx = m.idx
      } else {
        lo = { price: s.price, idx: s.idx, done: false, swept: false }
        const m = extremeBetween(s.idx, i, true)
        maxSinceLo = m.price
        maxSinceLoIdx = m.idx
      }
    }
    trendArr[i] = trend
  }
  const minScoreEff = sessionActive ? o.minScore : o.minScore - 1
  return { swings, events, trend: trendArr, score, regime, atr, volRatio, trades: structureTrades(bars, events, atr, { ...o, minScore: minScoreEff }), sessionActive, minScoreEff }
}

/**
 * Trade every BOS / CHoCH scoring >= minScore: enter at the next bar's open, stop at
 * the protected swing, target `targetR` × risk. One position at a time; stop wins a
 * bar that touches both. Stops wider than 15 ATR are skipped.
 */
export function structureTrades(bars: MsBar[], events: MsEvent[], atr: Float64Array, o: MsOptions): MsTrade[] {
  const out: MsTrade[] = []
  const n = bars.length
  let freeFrom = 0
  for (const e of events) {
    if (e.kind === 'SWEEP' || e.score < o.minScore || e.idx < freeFrom || e.idx + 1 >= n) continue
    if (o.skipWeekends) {
      const d = new Date(bars[e.idx].time).getUTCDay()
      if (d === 0 || d === 6) continue
    }
    const dir = e.dir
    const entry = bars[e.idx + 1].open
    const stop = e.protectedLevel
    const risk = dir * (entry - stop)
    if (!(risk > 0) || risk > 15 * atr[e.idx]) continue
    const target = entry + dir * o.targetR * risk
    const t: MsTrade = { dir, signalIdx: e.idx, entryIdx: e.idx + 1, entryTime: bars[e.idx + 1].time, entry, stop, target, exitIdx: null, exitTime: null, exitPrice: null, exitReason: null, r: null, kind: e.kind, score: e.score }
    for (let j = e.idx + 1; j < n; j++) {
      const b = bars[j]
      const hitS = dir === 1 ? b.low <= stop : b.high >= stop
      const hitT = dir === 1 ? b.high >= target : b.low <= target
      if (!hitS && !hitT) continue
      // a gap through the level fills at the open
      const px = hitS ? (dir === 1 ? Math.min(stop, b.open) : Math.max(stop, b.open)) : dir === 1 ? Math.max(target, b.open) : Math.min(target, b.open)
      t.exitIdx = j
      t.exitTime = b.time
      t.exitPrice = px
      t.exitReason = hitS ? 'SL' : 'TP'
      t.r = (dir * (px - entry)) / risk
      break
    }
    out.push(t)
    freeFrom = t.exitIdx ?? n
  }
  return out
}
