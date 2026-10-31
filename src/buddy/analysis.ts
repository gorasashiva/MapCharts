/**
 * Trade Buddy — multi-timeframe market read + setup scanner. Pure functions,
 * no DOM, no network: the host fetches candles per timeframe and calls
 * `buildContext` / `scanIdeas` on every refresh.
 *
 * The scanner only emits the two setups that survived out-of-sample
 * backtesting on XAUUSDT (Binance USDT-M, Dec 2025 → Sep 2026, fees 0.10% RT):
 *
 *   1. IB breakout (UltraV2 components): 120-min Initial Balance of the UTC
 *      session (05:30–07:30 IST), traded only when the IB is wider than its
 *      20-session average; first 5m close beyond the IB between 07:30 and
 *      10:30 IST; stop at the opposite IB side; exit 21:30 IST.
 *   2. FVG + Supertrend hybrid: 5m FVG touch + 5m Supertrend(2,2) agreement,
 *      filtered by the last COMPLETED 1h Supertrend(2,2); held until that 1h
 *      Supertrend flips (≈24h average hold — a swing, not intraday).
 *
 * Everything else (trend per TF, VWAP, SVP demand/supply zones, timing
 * flags) is context used to grade ideas and to brief the LLM — not signals.
 *
 * 3. Experimental, NOT backtested: volume-profile zone setups (breakout
 *    beyond a zone with 2-bar acceptance, or a bounce off an aligned zone),
 *    with stops at the zone and targets at the next zones. Graded at most B
 *    and labelled as unvalidated; fades lost money in every tested variant,
 *    so bounces carry a standing caution.
 */
import type { Candle } from '../core/types'
import { computeSupertrend, computeSvp } from '../overlays/ultraV2'
import { buildProfileZones, dominanceText, zoneHeadline, type ProfileZone } from '../overlays/profileZones'

export const BUDDY_TFS = ['1m', '3m', '5m', '15m', '1h', '4h', '1d'] as const
export type BuddyTf = (typeof BUDDY_TFS)[number]
export const TF_MS: Record<BuddyTf, number> = { '1m': 6e4, '3m': 18e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 }
/** Bars to request per timeframe: enough history for each calculation below. */
export const TF_LIMIT: Record<BuddyTf, number> = { '1m': 300, '3m': 300, '5m': 800, '15m': 300, '1h': 600, '4h': 300, '1d': 200 }

const DAY = 86_400_000
const HOUR = 3_600_000
const IST = 19_800_000
const IB_MS = 2 * HOUR
const ENTRY_WINDOW_MS = 3 * HOUR // breakouts only within 3h of the IB closing
const EXIT_UTC_MS = 16 * HOUR // 21:30 IST
/** IST hours where every tested strategy lost money on weekdays (see analysis). */
export const BAD_IST_HOURS = [2, 3, 4, 15, 17, 20, 21]

export type Trend = 'up' | 'down' | 'flat'

export interface TfContext {
  tf: BuddyTf
  close: number
  /** Direction of Supertrend(2,2) on the last COMPLETED bar. */
  trend: Trend
  stValue: number
  /** UTC-session VWAP — intraday timeframes only. */
  vwap: number | null
  changePct: number
  /** Where the close sits in the last 20 bars' range, 0 (low) → 1 (high). */
  rangePos: number
  /** Last few completed bars, compact, for the LLM briefing. */
  recent: [number, number, number, number][]
}

export interface SessionContext {
  start: number
  ibHigh: number
  ibLow: number
  ibWidth: number
  ibAvg20: number | null
  ibWide: boolean | null
  ibDone: boolean
}

export interface Timing {
  istHour: number
  istMinute: number
  weekend: boolean
  badHour: boolean
  mainWindow: boolean
}

export interface MarketContext {
  symbol: string
  price: number
  now: number
  tfs: TfContext[]
  session: SessionContext | null
  /** Today's session-profile zones (5m), scored for support/resistance strength. */
  zones: ProfileZone[]
  /** Today's session range so far (5m), used as a fallback target. */
  sessionHigh: number | null
  sessionLow: number | null
  timing: Timing
}

export type IdeaGrade = 'A' | 'B' | 'C'
export type IdeaStatus = 'fresh' | 'active'

export interface TradeIdea {
  /** Stable per trigger, used to de-duplicate alerts. */
  id: string
  setup: 'ib-breakout' | 'fvg-st-hybrid' | 'zone-breakout' | 'zone-bounce'
  /** False for experimental setups that have no backtest behind them. */
  validated: boolean
  title: string
  tf: BuddyTf
  side: 'long' | 'short'
  status: IdeaStatus
  triggeredAt: number
  entry: number
  stop: number
  targets: number[]
  exitRule: string
  grade: IdeaGrade
  reasons: string[]
  cautions: string[]
  evidence: string
}

export type CandlesByTf = Partial<Record<BuddyTf, Candle[]>>

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export function timingAt(now: number): Timing {
  const ist = new Date(now + IST)
  const utcDow = new Date(now).getUTCDay()
  const h = ist.getUTCHours()
  return {
    istHour: h,
    istMinute: ist.getUTCMinutes(),
    weekend: utcDow === 0 || utcDow === 6,
    badHour: BAD_IST_HOURS.includes(h),
    mainWindow: h >= 5 && h < 9,
  }
}

/** Drop a still-forming last bar so every read uses completed bars only. */
export function completed(candles: Candle[], tfMs: number, now: number): Candle[] {
  if (candles.length && candles[candles.length - 1].time + tfMs > now) return candles.slice(0, -1)
  return candles
}

function sessionVwap(c: Candle[]): number | null {
  if (!c.length) return null
  const day = Math.floor(c[c.length - 1].time / DAY)
  let pv = 0
  let v = 0
  for (let i = c.length - 1; i >= 0 && Math.floor(c[i].time / DAY) === day; i--) {
    pv += ((c[i].high + c[i].low + c[i].close) / 3) * c[i].volume
    v += c[i].volume
  }
  return v > 0 ? pv / v : null
}

function tfContext(tf: BuddyTf, raw: Candle[], now: number): TfContext | null {
  const c = completed(raw, TF_MS[tf], now)
  if (c.length < 25) return null
  const st = computeSupertrend(c, 2, 2)
  const last = st[st.length - 1]
  const k = c[c.length - 1]
  const win = c.slice(-20)
  const hi = Math.max(...win.map((x) => x.high))
  const lo = Math.min(...win.map((x) => x.low))
  const ref = c[Math.max(0, c.length - 21)].close
  return {
    tf,
    close: k.close,
    trend: isFinite(last.value) ? (last.up ? 'up' : 'down') : 'flat',
    stValue: last.value,
    vwap: TF_MS[tf] <= HOUR ? sessionVwap(c) : null,
    changePct: ref ? ((k.close - ref) / ref) * 100 : 0,
    rangePos: hi > lo ? (k.close - lo) / (hi - lo) : 0.5,
    recent: c.slice(-8).map((x) => [x.open, x.high, x.low, x.close]),
  }
}

/**
 * Today's Initial Balance (first 120 min of the UTC session) from 5m candles,
 * plus the 20-session average IB width from 1h candles (bars at 00:00 and
 * 01:00 UTC), matching the backtest's "IB wider than its 20-day average".
 */
export function sessionContext(c5: Candle[], c1h: Candle[], now: number): SessionContext | null {
  const start = Math.floor(now / DAY) * DAY
  const ib = c5.filter((k) => k.time >= start && k.time < start + IB_MS && k.time + TF_MS['5m'] <= now)
  if (!ib.length) return null
  const ibHigh = Math.max(...ib.map((k) => k.high))
  const ibLow = Math.min(...ib.map((k) => k.low))
  const widths: number[] = []
  const byDay = new Map<number, Candle[]>()
  for (const k of c1h) {
    const d = Math.floor(k.time / DAY)
    if (d * DAY >= start) continue
    if (k.time - d * DAY < IB_MS) byDay.set(d, [...(byDay.get(d) ?? []), k])
  }
  for (const [, ks] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    if (ks.length === 2) widths.push(Math.max(ks[0].high, ks[1].high) - Math.min(ks[0].low, ks[1].low))
  }
  const hist = widths.slice(-20)
  const ibAvg20 = hist.length >= 5 ? hist.reduce((a, b) => a + b, 0) / hist.length : null
  const ibWidth = ibHigh - ibLow
  return {
    start,
    ibHigh,
    ibLow,
    ibWidth,
    ibAvg20,
    ibWide: ibAvg20 === null ? null : ibWidth > ibAvg20,
    ibDone: now >= start + IB_MS,
  }
}

export function buildContext(symbol: string, data: CandlesByTf, now: number, svpRows = 24, zoneThresholdPct = 70): MarketContext | null {
  const tfs: TfContext[] = []
  for (const tf of BUDDY_TFS) {
    const c = data[tf]
    const ctx = c ? tfContext(tf, c, now) : null
    if (ctx) tfs.push(ctx)
  }
  const fastest = data['1m'] ?? data['3m'] ?? data['5m']
  if (!fastest?.length || !tfs.length) return null
  const price = fastest[fastest.length - 1].close
  const c5 = data['5m'] ?? []
  const svp = c5.length ? computeSvp(c5, svpRows, 0.7) : null
  const today = c5.filter((k) => Math.floor(k.time / DAY) === Math.floor(now / DAY))
  const zones = svp && today.length ? buildProfileZones({ lo: svp.loPrice, hi: svp.hiPrice, binVolume: svp.bins, pocBin: svp.pocBin }, today, today, price, zoneThresholdPct) : []
  return {
    symbol,
    price,
    now,
    tfs,
    session: c5.length && data['1h'] ? sessionContext(c5, data['1h'], now) : null,
    zones,
    sessionHigh: today.length ? Math.max(...today.map((k) => k.high)) : null,
    sessionLow: today.length ? Math.min(...today.map((k) => k.low)) : null,
    timing: timingAt(now),
  }
}

// ---------------------------------------------------------------------------
// Setup 1 — IB breakout
// ---------------------------------------------------------------------------

export function scanIbBreakout(ctx: MarketContext, c5raw: Candle[]): TradeIdea | null {
  const s = ctx.session
  if (!s || !s.ibDone || s.ibWide !== true) return null
  const c5 = completed(c5raw, TF_MS['5m'], ctx.now)
  const ibEnd = s.start + IB_MS
  const bars = c5.filter((k) => k.time >= s.start)
  let entryIdx = -1
  let side: 1 | -1 = 1
  for (let i = 1; i < bars.length; i++) {
    const k = bars[i]
    if (k.time < ibEnd) continue
    if (k.time > ibEnd + ENTRY_WINDOW_MS) break
    const p = bars[i - 1]
    if (k.close > s.ibHigh && p.close <= s.ibHigh) { entryIdx = i; side = 1; break }
    if (k.close < s.ibLow && p.close >= s.ibLow) { entryIdx = i; side = -1; break }
  }
  if (entryIdx < 0) return null
  const k = bars[entryIdx]
  const w = s.ibWidth
  const stop = side > 0 ? s.ibLow : s.ibHigh
  const edge = side > 0 ? s.ibHigh : s.ibLow
  const targets = [edge + side * w, edge + side * 2 * w]
  // Still live? Not stopped, not past the final target, not past 21:30 IST.
  if (ctx.now >= s.start + EXIT_UTC_MS) return null
  for (let i = entryIdx + 1; i < bars.length; i++) {
    const b = bars[i]
    if (side > 0 ? b.low <= stop : b.high >= stop) return null
    if (side > 0 ? b.high >= targets[1] : b.low <= targets[1]) return null
  }
  const reasons = [
    `IB ${fmt(s.ibLow)}–${fmt(s.ibHigh)} (${fmt(w)} pts) is wider than its 20-day average (${fmt(s.ibAvg20 ?? NaN)})`,
    `5m closed ${side > 0 ? 'above IB high' : 'below IB low'} at ${istClock(k.time)}`,
  ]
  const cautions: string[] = []
  const h1 = ctx.tfs.find((t) => t.tf === '1h')
  if (h1 && h1.trend !== 'flat') (h1.trend === (side > 0 ? 'up' : 'down') ? reasons : cautions).push(`1h Supertrend is ${h1.trend}`)
  const blocking = ctx.zones.find((z) => (side > 0 ? z.kind === 'supply' && z.lo > k.close && z.lo - k.close < 0.5 * w : z.kind === 'demand' && z.hi < k.close && k.close - z.hi < 0.5 * w))
  if (blocking) cautions.push(`${blocking.kind} zone ${fmt(blocking.lo)}–${fmt(blocking.hi)} sits within 0.5×IB of entry`)
  else reasons.push('No opposing SVP zone within 0.5×IB — room to run')
  // Judge timing when the setup fired, not now: an 08:00 trigger isn't a 20:00 trade.
  addTimingCautions(timingAt(k.time), cautions)
  return {
    id: `ib:${ctx.symbol}:${s.start}`,
    setup: 'ib-breakout',
    validated: true,
    title: 'IB breakout',
    tf: '5m',
    side: side > 0 ? 'long' : 'short',
    status: entryIdx === bars.length - 1 ? 'fresh' : 'active',
    triggeredAt: k.time,
    entry: k.close,
    stop,
    targets,
    exitRule: 'Take 50% at T1 and move the stop to entry; exit the rest by 21:30 IST',
    grade: grade(reasons.length, cautions),
    reasons,
    cautions,
    evidence: 'Backtest XAUUSDT 5m (Dec 2025–Sep 2026, 0.10% fees): ~58% win, profit factor ~1.9; with a 50% partial at 1×IB ~65% win. Validated on XAUUSDT only.',
  }
}

// ---------------------------------------------------------------------------
// Setup 2 — FVG + Supertrend, 5m entry / 1h management
// ---------------------------------------------------------------------------

interface Gap { top: number; bottom: number }

/** Direction of the last completed 1h Supertrend(2,2) at each 5m bar's close. */
function htfDirAt(c5: Candle[], c1h: Candle[]): Int8Array {
  const out = new Int8Array(c5.length)
  const st = computeSupertrend(c1h, 2, 2)
  let j = -1
  for (let i = 0; i < c5.length; i++) {
    const closeT = c5[i].time + TF_MS['5m']
    while (j + 1 < c1h.length && c1h[j + 1].time + HOUR <= closeT) j++
    out[i] = j >= 0 && isFinite(st[j].value) ? (st[j].up ? 1 : -1) : 0
  }
  return out
}

/**
 * Replays the hybrid over recent 5m bars exactly as backtested (source gap
 * naming, touch valid for 10 bars, flags reset on entry, no same-bar
 * re-entry, weekday entries only) and returns the position open on the latest
 * completed bar, if any.
 */
export function scanFvgHybrid(ctx: MarketContext, c5raw: Candle[], c1hraw: Candle[]): TradeIdea | null {
  const c5 = completed(c5raw, TF_MS['5m'], ctx.now)
  const c1h = completed(c1hraw, HOUR, ctx.now)
  if (c5.length < 50 || c1h.length < 20) return null
  const st = computeSupertrend(c5, 2, 2)
  const htf = htfDirAt(c5, c1h)
  const down: Gap[] = []
  const up: Gap[] = []
  let downTouch = -1e9
  let upTouch = -1e9
  let pos = 0
  let entryI = -1
  for (let i = 0; i < c5.length; i++) {
    const k = c5[i]
    const s = st[i]
    const flat = pos === 0
    if (pos !== 0 && htf[i] === -pos) pos = 0
    for (let g = down.length - 1; g >= 0; g--) { const z = down[g]; if (k.low <= z.top && k.high >= z.bottom) downTouch = i; if (k.high >= z.top) down.splice(g, 1) }
    for (let g = up.length - 1; g >= 0; g--) { const z = up[g]; if (k.high >= z.bottom && k.low <= z.top) upTouch = i; if (k.low <= z.bottom) up.splice(g, 1) }
    const dow = new Date(k.time).getUTCDay()
    if (flat && isFinite(s.value) && dow !== 0 && dow !== 6) {
      if (i - downTouch <= 10 && s.up && k.close > s.value && htf[i] === 1) { pos = 1; entryI = i; downTouch = upTouch = -1e9 }
      else if (i - upTouch <= 10 && !s.up && k.close < s.value && htf[i] === -1) { pos = -1; entryI = i; downTouch = upTouch = -1e9 }
    }
    if (i >= 2) {
      const p1 = c5[i - 1], p2 = c5[i - 2]
      if (p1.open > p1.close) { if (k.high < p2.low) down.push({ top: p2.low, bottom: k.high }) }
      else if (k.low > p2.high) up.push({ top: k.low, bottom: p2.high })
    }
  }
  if (pos === 0 || entryI < 0) return null
  const k = c5[entryI]
  const h1st = computeSupertrend(c1h, 2, 2)
  const inval = h1st[h1st.length - 1].value
  const reasons = [
    `5m price reacted from a fair value gap and closed ${pos > 0 ? 'above' : 'below'} the 5m Supertrend at ${istClock(k.time)}`,
    `1h Supertrend is ${pos > 0 ? 'up' : 'down'} (trend filter)`,
  ]
  const cautions: string[] = ['Swing hold: average ≈24h, exits on the 1h Supertrend flip, not same-day']
  const ist = new Date(k.time + IST).getUTCHours()
  if (ist >= 9 && ist < 18) reasons.push('Entry inside the 09:00–18:00 IST window that held up out-of-sample')
  addTimingCautions(timingAt(k.time), cautions)
  return {
    id: `hyb:${ctx.symbol}:${k.time}`,
    setup: 'fvg-st-hybrid',
    validated: true,
    title: 'FVG + Supertrend (1h trend)',
    tf: '5m',
    side: pos > 0 ? 'long' : 'short',
    status: entryI === c5.length - 1 ? 'fresh' : 'active',
    triggeredAt: k.time,
    entry: k.close,
    stop: inval,
    targets: [],
    exitRule: 'Hold until the 1h Supertrend flips; the stop shown is the current 1h Supertrend line and trails with it',
    grade: grade(reasons.length, cautions.slice(1)),
    reasons,
    cautions,
    evidence: 'Backtest XAUUSDT 5m entry / 1h exit, weekdays (Dec 2025–Sep 2026, 0.10% fees): +1,089 pts net, ~34% win overall; 09–18 IST entries ~50% win, profit factor ~1.6 out-of-sample. Validated on XAUUSDT only.',
  }
}

// ---------------------------------------------------------------------------
// Setup 3 (experimental) — volume-profile zone breakout / bounce
// ---------------------------------------------------------------------------

export interface ZoneSetup {
  type: 'breakout' | 'bounce'
  side: 1 | -1
  zone: ProfileZone
  /** Index into `bars` of the trigger bar. */
  idx: number
  entry: number
  stop: number
  targets: number[]
  rr: number
}

/** Minimum zone strength for a setup, and minimum reward:risk to the first target. */
export const ZONE_MIN_SCORE = 45
export const ZONE_MIN_RR = 1.2

/**
 * Most recent zone trigger among the last `lookback` completed bars that is
 * still live (neither the stop nor T1 hit since). Targets are the nearest
 * zone edges beyond entry (any strength — price tends to stall at any
 * acceptance), falling back to the session extreme.
 *
 *   breakout: bar i-2 closed on one side of a zone, bars i-1 and i closed
 *             beyond its far edge (2-bar acceptance). Stop: zone midpoint.
 *   bounce:   the previous close was outside a support (resistance) zone,
 *             bar i reached into it and closed back out on the same side,
 *             and the defending side dominates the zone. Stop: 10% of the
 *             zone's height beyond its far edge.
 */
export function findZoneSetup(bars: Candle[], zones: ProfileZone[], sessionHigh: number, sessionLow: number, lookback = 6): ZoneSetup | null {
  const candidates = zones.filter((z) => z.score >= ZONE_MIN_SCORE)
  for (let i = bars.length - 1; i >= Math.max(2, bars.length - lookback); i--) {
    const k = bars[i]
    const p1 = bars[i - 1]
    const p2 = bars[i - 2]
    for (const z of candidates) {
      const h = z.hi - z.lo
      let setup: Omit<ZoneSetup, 'targets' | 'rr'> | null = null
      if (p2.close <= z.hi && p1.close > z.hi && k.close > z.hi) setup = { type: 'breakout', side: 1, zone: z, idx: i, entry: k.close, stop: (z.lo + z.hi) / 2 }
      else if (p2.close >= z.lo && p1.close < z.lo && k.close < z.lo) setup = { type: 'breakout', side: -1, zone: z, idx: i, entry: k.close, stop: (z.lo + z.hi) / 2 }
      else if (p1.close > z.hi && k.low <= z.hi && k.close > z.hi && z.buyPct > 50) setup = { type: 'bounce', side: 1, zone: z, idx: i, entry: k.close, stop: z.lo - 0.1 * h }
      else if (p1.close < z.lo && k.high >= z.lo && k.close < z.lo && z.buyPct < 50) setup = { type: 'bounce', side: -1, zone: z, idx: i, entry: k.close, stop: z.hi + 0.1 * h }
      if (!setup) continue
      const s = setup
      const ahead = zones
        .filter((o) => o !== z && (s.side > 0 ? o.lo > s.entry : o.hi < s.entry))
        .map((o) => (s.side > 0 ? o.lo : o.hi))
        .sort((a, b) => (s.side > 0 ? a - b : b - a))
      const extreme = s.side > 0 ? sessionHigh : sessionLow
      if ((s.side > 0 ? extreme > s.entry : extreme < s.entry) && !ahead.includes(extreme)) ahead.push(extreme)
      const targets = ahead.slice(0, 2)
      if (!targets.length) continue
      const risk = (s.entry - s.stop) * s.side
      const rr = risk > 0 ? ((targets[0] - s.entry) * s.side) / risk : 0
      if (!(risk > 0) || rr < ZONE_MIN_RR) continue
      // Still live? Nothing after the trigger has hit the stop or T1.
      const done = bars.slice(i + 1).some((b) => (s.side > 0 ? b.low <= s.stop || b.high >= targets[0] : b.high >= s.stop || b.low <= targets[0]))
      if (done) continue
      return { ...s, targets, rr }
    }
  }
  return null
}

export function scanZoneSetups(ctx: MarketContext, c5raw: Candle[]): TradeIdea | null {
  // A young profile's zones are still moving; wait for the IB (2h) to form.
  if (!ctx.session?.ibDone || ctx.sessionHigh === null || ctx.sessionLow === null) return null
  const c5 = completed(c5raw, TF_MS['5m'], ctx.now).filter((k) => k.time >= ctx.session!.start)
  const s = findZoneSetup(c5, ctx.zones, ctx.sessionHigh, ctx.sessionLow)
  if (!s) return null
  const k = c5[s.idx]
  const z = s.zone
  const long = s.side > 0
  const headline = zoneHeadline(z.kind, z.lo, z.hi, ctx.price, z.buyPct)
  const zoneTxt = `${fmt(z.lo)}–${fmt(z.hi)} (${z.strength} ${z.score}, held ${z.rejections}/${z.touches}, ${dominanceText(z.buyPct)})`
  const reasons =
    s.type === 'breakout'
      ? [`Two 5m closes ${long ? 'above' : 'below'} zone ${zoneTxt} by ${istClock(k.time)}: price accepted beyond it`]
      : [`5m rejected zone ${zoneTxt} at ${istClock(k.time)}, closing back ${long ? 'above' : 'below'} it`, `Zone now reads: ${headline}`]
  reasons.push(`Reward:risk to T1 is ${s.rr.toFixed(1)}:1`)
  const cautions = ['Experimental: this zone setup has not been backtested']
  if (s.type === 'bounce') cautions.push('Mean reversion: every fade variant we tested on XAUUSDT lost money; wait for follow-through')
  const h1 = ctx.tfs.find((t) => t.tf === '1h')
  if (h1 && h1.trend !== 'flat') (h1.trend === (long ? 'up' : 'down') ? reasons : cautions).push(`1h Supertrend is ${h1.trend}`)
  addTimingCautions(timingAt(k.time), cautions)
  const good = z.strength === 'Strong' && s.rr >= 2 && !cautions.some((c) => /Weekend|worst hours|Supertrend is/.test(c))
  return {
    id: `zone:${ctx.symbol}:${k.time}:${s.type}:${s.side}`,
    setup: s.type === 'breakout' ? 'zone-breakout' : 'zone-bounce',
    validated: false,
    title: s.type === 'breakout' ? `Zone breakout (${long ? 'above resistance' : 'below support'})` : `Zone bounce (${long ? 'support' : 'resistance'})`,
    tf: '5m',
    side: long ? 'long' : 'short',
    status: s.idx === c5.length - 1 ? 'fresh' : 'active',
    triggeredAt: k.time,
    entry: s.entry,
    stop: s.stop,
    targets: s.targets,
    exitRule: s.type === 'breakout' ? 'Stop back inside the zone (its midpoint). Take 50% at T1 (next zone) and trail the rest to T2' : 'Stop just beyond the zone. Take 50% at T1 (next zone) and move the stop to entry',
    grade: good ? 'B' : 'C',
    reasons,
    cautions,
    evidence: 'Heuristic from volume-profile / auction-market principles, not backtested. Breakout-style setups fit what our XAUUSDT research favoured; fades did not. Size small until validated.',
  }
}

export interface ScanOptions {
  /** Include the experimental volume-profile zone setups. */
  zoneSetups?: boolean
}

export function scanIdeas(ctx: MarketContext, data: CandlesByTf, opts: ScanOptions = {}): TradeIdea[] {
  const out: TradeIdea[] = []
  const c5 = data['5m']
  const c1h = data['1h']
  if (c5) {
    const ib = scanIbBreakout(ctx, c5)
    if (ib) out.push(ib)
  }
  if (c5 && c1h) {
    const hy = scanFvgHybrid(ctx, c5, c1h)
    if (hy) out.push(hy)
  }
  if (c5 && opts.zoneSetups !== false) {
    const zs = scanZoneSetups(ctx, c5)
    if (zs) out.push(zs)
  }
  return out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addTimingCautions(t: Timing, cautions: string[]): void {
  if (t.weekend) cautions.push('Weekend: spot gold is closed and win rates collapse (t = −6.6 on Saturdays)')
  if (t.badHour) cautions.push(`${String(t.istHour).padStart(2, '0')}:00 IST is one of the historically worst hours`)
}

/** A = confluence and nothing against it, C = something material against it. */
function grade(reasonCount: number, cautions: string[]): IdeaGrade {
  if (cautions.some((c) => /Weekend|worst hours|Supertrend is/.test(c))) return 'C'
  if (cautions.length === 0 && reasonCount >= 3) return 'A'
  return 'B'
}

function fmt(v: number): string {
  if (!isFinite(v)) return '—'
  return Math.abs(v) >= 1000 ? v.toFixed(1) : v.toFixed(Math.abs(v) >= 1 ? 2 : 5)
}

export function istClock(t: number): string {
  const d = new Date(t + IST)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} IST`
}

/** Compact, LLM-friendly briefing of everything the scanner sees. */
export function briefing(ctx: MarketContext, ideas: TradeIdea[]): string {
  const r = (v: number | null): number | null => (v === null || !isFinite(v) ? null : Math.round(v * 100) / 100)
  return JSON.stringify({
    symbol: ctx.symbol,
    price: r(ctx.price),
    time: istClock(ctx.now),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(ctx.now).getUTCDay()],
    timing: ctx.timing,
    timeframes: ctx.tfs.map((t) => ({
      tf: t.tf,
      close: r(t.close),
      supertrend: t.trend,
      supertrend_line: r(t.stValue),
      vs_vwap: t.vwap === null ? null : t.close >= t.vwap ? 'above' : 'below',
      vwap: r(t.vwap),
      change_20_bars_pct: r(t.changePct),
      range_position_20_bars: r(t.rangePos),
      last_bars_ohlc: t.recent.map((b) => b.map((x) => r(x))),
    })),
    initial_balance: ctx.session && {
      high: r(ctx.session.ibHigh),
      low: r(ctx.session.ibLow),
      width: r(ctx.session.ibWidth),
      avg_width_20d: r(ctx.session.ibAvg20),
      wider_than_average: ctx.session.ibWide,
      complete: ctx.session.ibDone,
    },
    session_range: { high: r(ctx.sessionHigh), low: r(ctx.sessionLow) },
    svp_zones: ctx.zones.map((z) => ({
      role: zoneHeadline(z.kind, z.lo, z.hi, ctx.price, z.buyPct),
      low: r(z.lo),
      high: r(z.hi),
      strength: `${z.strength} ${z.score}/100`,
      held: `${z.rejections}/${z.touches}`,
      volume_share_pct: Math.round(z.volShare * 100),
      poc: z.hasPoc,
    })),
    scanner_ideas: ideas.map((i) => ({ setup: i.title, validated_by_backtest: i.validated, side: i.side, status: i.status, grade: i.grade, entry: r(i.entry), stop: r(i.stop), targets: i.targets.map(r), exit: i.exitRule, reasons: i.reasons, cautions: i.cautions, evidence: i.evidence })),
  })
}
