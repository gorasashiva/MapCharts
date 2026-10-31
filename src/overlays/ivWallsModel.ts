/**
 * IV Walls model — pure math behind the IV Walls overlay (see ivWalls.ts).
 *
 * Two independent views of "how far can today travel from its open":
 *
 *  1. OPTION-IMPLIED (forward-looking): the nearest-expiry chain's IV,
 *     read off the smile at the strikes a 1σ day would reach on each side
 *     (so put skew widens the downside wall), plus the ATM straddle's
 *     extrinsic value as a model-light cross-check. Turned into ±kσ walls
 *     anchored at the session open.
 *
 *  2. HISTORICAL (realized): every past session's HOD/LOD extension from its
 *     open, measured in units of the realized σ known BEFORE that session
 *     (Parkinson range vol over the preceding `lookback` sessions — no
 *     lookahead). The quantiles of those extensions give today's HOD/LOD
 *     zones, and a walk-forward test reports how often price that reached a
 *     zone reversed inside it.
 *
 * Delta has no historical-IV endpoint, so only (2) can be backtested; (1)
 * exists for today only. Where the two agree is the zone worth watching.
 */

export interface OHLCBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface SessionDay {
  start: number // session open, epoch ms
  end: number // start + 24h
  open: number
  high: number
  low: number
  close: number
  hodAt: number // bar time the session high printed
  lodAt: number
  bars: number
}

export const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** Session that contains `time`, for sessions opening at `startHourUTC`. */
export function sessionStartOf(time: number, startHourUTC: number): number {
  const offset = startHourUTC * HOUR_MS
  return Math.floor((time - offset) / DAY_MS) * DAY_MS + offset
}

/** Group ascending intraday bars (≤ 1h, so a bar never straddles a whole-hour session boundary) into sessions. */
export function buildSessions(bars: OHLCBar[], startHourUTC: number): SessionDay[] {
  const out: SessionDay[] = []
  let cur: SessionDay | null = null
  for (const b of bars) {
    const start = sessionStartOf(b.time, startHourUTC)
    if (!cur || cur.start !== start) {
      cur = { start, end: start + DAY_MS, open: b.open, high: b.high, low: b.low, close: b.close, hodAt: b.time, lodAt: b.time, bars: 0 }
      out.push(cur)
    }
    if (b.high > cur.high) {
      cur.high = b.high
      cur.hodAt = b.time
    }
    if (b.low < cur.low) {
      cur.low = b.low
      cur.lodAt = b.time
    }
    cur.close = b.close
    cur.bars++
  }
  return out
}

/** Parkinson daily σ (fraction) from session high/low ranges — range-based, so it tracks HOD/LOD behaviour directly. */
export function parkinsonSigma(days: SessionDay[]): number | null {
  const xs = days.filter((d) => d.high > 0 && d.low > 0).map((d) => Math.log(d.high / d.low) ** 2)
  if (xs.length < 2) return null
  return Math.sqrt(xs.reduce((a, b) => a + b, 0) / xs.length / (4 * Math.LN2))
}

/** Close-to-close daily σ (fraction), sample stdev of log returns. */
export function closeToCloseSigma(days: SessionDay[]): number | null {
  const r: number[] = []
  for (let i = 1; i < days.length; i++) if (days[i - 1].close > 0 && days[i].close > 0) r.push(Math.log(days[i].close / days[i - 1].close))
  if (r.length < 2) return null
  const m = r.reduce((a, b) => a + b, 0) / r.length
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1))
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = Math.min(1, Math.max(0, q)) * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export interface ExtensionSample {
  start: number
  sigma: number // realized σ known before this session
  up: number // (HOD - open) / open / σ
  down: number // (open - LOD) / open / σ
  hodHour: number // hours from session open to the HOD bar
  lodHour: number
}

/** One sample per session in `days` (caller passes COMPLETE sessions only) that has `lookback` sessions before it. */
export function extensionSamples(days: SessionDay[], lookback: number): ExtensionSample[] {
  const out: ExtensionSample[] = []
  for (let i = lookback; i < days.length; i++) {
    const sigma = parkinsonSigma(days.slice(i - lookback, i))
    const d = days[i]
    if (!sigma || d.open <= 0) continue
    out.push({
      start: d.start,
      sigma,
      up: (d.high - d.open) / d.open / sigma,
      down: (d.open - d.low) / d.open / sigma,
      hodHour: Math.floor((d.hodAt - d.start) / HOUR_MS),
      lodHour: Math.floor((d.lodAt - d.start) / HOUR_MS),
    })
  }
  return out
}

export interface ZoneStats {
  n: number
  /** HOD zone edges in σ above the open, LOD zone edges in σ below it. */
  up: { lo: number; hi: number }
  down: { lo: number; hi: number }
  /** Walk-forward: of sessions that reached the zone's near edge, how many reversed before its far edge. */
  holdUp: { reached: number; held: number }
  holdDown: { reached: number; held: number }
  /** Share of sessions whose extension reached each σ multiple. */
  touch: { mult: number; up: number; down: number }[]
  /** hodSetBy[h] = share of sessions whose HOD printed within the first h hours (h = 0..24). */
  hodSetBy: number[]
  lodSetBy: number[]
  ups: number[] // sorted, for continuation odds
  downs: number[]
}

export function calibrate(samples: ExtensionSample[], qLo: number, qHi: number, multiples: number[], minWindow = 30): ZoneStats | null {
  if (samples.length < 10) return null
  const ups = samples.map((s) => s.up).sort((a, b) => a - b)
  const downs = samples.map((s) => s.down).sort((a, b) => a - b)

  // Walk-forward: each session is judged against zones built only from sessions before it.
  const holdUp = { reached: 0, held: 0 }
  const holdDown = { reached: 0, held: 0 }
  for (let j = minWindow; j < samples.length; j++) {
    const pastUp = samples.slice(0, j).map((s) => s.up).sort((a, b) => a - b)
    const pastDn = samples.slice(0, j).map((s) => s.down).sort((a, b) => a - b)
    const s = samples[j]
    if (s.up >= quantile(pastUp, qLo)) {
      holdUp.reached++
      if (s.up <= quantile(pastUp, qHi)) holdUp.held++
    }
    if (s.down >= quantile(pastDn, qLo)) {
      holdDown.reached++
      if (s.down <= quantile(pastDn, qHi)) holdDown.held++
    }
  }

  const n = samples.length
  const setBy = (hours: number[]): number[] => Array.from({ length: 25 }, (_, h) => hours.filter((x) => x < h).length / n)
  return {
    n,
    up: { lo: quantile(ups, qLo), hi: quantile(ups, qHi) },
    down: { lo: quantile(downs, qLo), hi: quantile(downs, qHi) },
    holdUp,
    holdDown,
    touch: multiples.map((m) => ({ mult: m, up: ups.filter((x) => x >= m).length / n, down: downs.filter((x) => x >= m).length / n })),
    hodSetBy: setBy(samples.map((s) => s.hodHour)),
    lodSetBy: setBy(samples.map((s) => s.lodHour)),
    ups,
    downs,
  }
}

/** P(session extends meaningfully beyond `current` | it has already reached `current`), from the empirical extensions. */
export function continuationOdds(sorted: number[], current: number): number | null {
  const reached = sorted.filter((x) => x >= current).length
  if (reached < 5) return null
  return sorted.filter((x) => x > current + 0.05).length / reached
}

// ---- option-implied ----

export interface ChainPoint {
  side: 'CALL' | 'PUT'
  strike: number
  expiry: number
  markIV: number // decimal
  markPrice: number
  bid: number
  ask: number
}

export interface ImpliedVol {
  expiry: number
  tDays: number
  atmIV: number // annualised decimal
  upIV: number // smile IV at the +1σ strike (OTM calls)
  downIV: number // smile IV at the -1σ strike (OTM puts)
  /** 1-day σ (fraction) implied by the ATM straddle's extrinsic value; null if no usable straddle. */
  straddleSigmaDay: number | null
}

/** Crypto options annualise over 365 calendar days. */
export const ivToDaily = (iv: number): number => iv * Math.sqrt(1 / 365)

function interp(points: { x: number; y: number }[], x: number): number | null {
  if (points.length === 0) return null
  if (x <= points[0].x) return points[0].y
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (x <= b.x) return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1)
  }
  return points[points.length - 1].y
}

const priceOf = (q: ChainPoint): number => (q.bid > 0 && q.ask >= q.bid ? (q.bid + q.ask) / 2 : q.markPrice)

/**
 * Read the nearest expiry at least `minTDays` out (very short-dated IV is
 * dominated by gamma noise). Smile convention: OTM calls above spot, OTM puts
 * below, since those are the liquid, informative quotes on each side.
 */
export function impliedFromChain(chain: ChainPoint[], spot: number, now: number, minTDays = 0.25): ImpliedVol | null {
  if (spot <= 0) return null
  const expiries = [...new Set(chain.map((q) => q.expiry))].sort((a, b) => a - b)
  const expiry = expiries.find((e) => (e - now) / DAY_MS >= minTDays)
  if (expiry === undefined) return null
  const tDays = (expiry - now) / DAY_MS
  const rows = chain.filter((q) => q.expiry === expiry && q.markIV > 0)
  const curve = (side: 'CALL' | 'PUT'): { x: number; y: number }[] =>
    rows.filter((q) => q.side === side).map((q) => ({ x: q.strike, y: q.markIV })).sort((a, b) => a.x - b.x)
  const calls = curve('CALL')
  const puts = curve('PUT')
  const atmParts = [interp(calls, spot), interp(puts, spot)].filter((v): v is number => v !== null)
  if (atmParts.length === 0) return null
  const atmIV = atmParts.reduce((a, b) => a + b, 0) / atmParts.length
  const s1 = ivToDaily(atmIV)
  const otmCalls = calls.filter((p) => p.x >= spot)
  const otmPuts = puts.filter((p) => p.x <= spot)
  const upIV = interp(otmCalls.length ? otmCalls : calls, spot * (1 + s1)) ?? atmIV
  const downIV = interp(otmPuts.length ? otmPuts : puts, spot * (1 - s1)) ?? atmIV

  // ATM straddle: extrinsic ≈ σ_T·S·√(2/π) for a near-ATM straddle, so σ_T ≈ extrinsic·√(π/2)/S, then √T-scale to one day.
  let straddleSigmaDay: number | null = null
  const byStrike = new Map<number, { c?: ChainPoint; p?: ChainPoint }>()
  for (const q of chain) {
    if (q.expiry !== expiry) continue
    const e = byStrike.get(q.strike) ?? {}
    if (q.side === 'CALL') e.c = q
    else e.p = q
    byStrike.set(q.strike, e)
  }
  let best: { k: number; c: ChainPoint; p: ChainPoint } | null = null
  for (const [k, e] of byStrike) {
    if (!e.c || !e.p || priceOf(e.c) <= 0 || priceOf(e.p) <= 0) continue
    if (!best || Math.abs(k - spot) < Math.abs(best.k - spot)) best = { k, c: e.c, p: e.p }
  }
  if (best && tDays > 0) {
    const extrinsic = priceOf(best.c) + priceOf(best.p) - Math.abs(spot - best.k)
    if (extrinsic > 0) straddleSigmaDay = (extrinsic * Math.sqrt(Math.PI / 2)) / spot / Math.sqrt(tDays)
  }
  return { expiry, tDays, atmIV, upIV, downIV, straddleSigmaDay }
}

// ---- walls for one session ----

export interface DayWalls {
  start: number
  end: number
  open: number
  sigmaHV: number
  /** Daily σ used for the walls on each side — option-implied for today when available, else HV. */
  sigmaUp: number
  sigmaDown: number
  implied: boolean
  lines: { mult: number; up: number; down: number }[]
  hodZone: [number, number] | null // [lo, hi] price
  lodZone: [number, number] | null // [lo, hi] price
}

export function wallsFor(
  day: { start: number; end: number; open: number },
  sigmaHV: number,
  stats: ZoneStats | null,
  implied: ImpliedVol | null,
  multiples: number[],
): DayWalls {
  const sigmaUp = implied ? ivToDaily(implied.upIV) : sigmaHV
  const sigmaDown = implied ? ivToDaily(implied.downIV) : sigmaHV
  const o = day.open
  return {
    start: day.start,
    end: day.end,
    open: o,
    sigmaHV,
    sigmaUp,
    sigmaDown,
    implied: !!implied,
    lines: multiples.map((m) => ({ mult: m, up: o * (1 + m * sigmaUp), down: o * (1 - m * sigmaDown) })),
    hodZone: stats ? [o * (1 + stats.up.lo * sigmaHV), o * (1 + stats.up.hi * sigmaHV)] : null,
    lodZone: stats ? [o * (1 - stats.down.hi * sigmaHV), o * (1 - stats.down.lo * sigmaHV)] : null,
  }
}
