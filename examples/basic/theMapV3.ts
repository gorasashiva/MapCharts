// "MAP V3" — THE MAP's gold levels from GLD options, computed once per session and locked
// (src/overlays/mapV3Model.ts), the way the original builds XAUUSD: GLD strikes scaled to the
// gold chart. The GLD chain comes from recorder/mapRecorder.mjs (/maplevels/*), which saves
// it on New York time — US daylight saving needs no change anywhere.
//
// Each session's levels are fixed from its 08:15 ET snapshot until the next one; bar replay
// shows the levels that were live at the replayed time. Drawing is MAP V2's (theMapV2.ts,
// unchanged): pinned off-screen labels, 0DTE bands under the GEX lines, regime + flip row.
//
// Scaling to the chart (Auto): ratio = the chart's close at the previous 16:00 ET ÷ GLD's
// close then, so XAUUSD, XAUT and PAXG (each with its own basis) all line up; the GLD
// pricing spot = the chart's price at the snapshot ÷ ratio. Fixed: a set ratio (10.91).

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { INTERVAL_MS, type Interval } from '../../src/core/types'
import { engulfingRetest, type MapOiExpiry } from '../../src/overlays/mapModel'
import { zeroDteActionV2, type MapV2Levels } from '../../src/overlays/mapV2Model'
import {
  MAP_V3_DEFAULTS,
  closeAt,
  computeMapV3Levels,
  pickSession,
  scaleMapLevels,
  type MapV3IndexEntry,
  type MapV3Snapshot,
} from '../../src/overlays/mapV3Model'
import { nyTime, prevNyWeekday, sessionDate } from '../../src/overlays/nyClock'
import { detectChartSec } from '../../src/overlays/mtfCisdModel'
import { drawTheMapV2, type TheMapV2Model } from './theMapV2'
import type { CanvasIndicatorContext } from './shankyCombo'
import { computeMapTrades, mapTradeLevels, MAP_TRADE_DEFAULTS, type MapSessionLevels, type MapTrade, type MapTradeOptions } from '../../src/overlays/mapV3TradesModel'
import { footprintBars } from '../../src/overlays/footprintBarStore'
import { chartInset } from '../../src/overlays/chartInset'
import { askNotificationPermissionOnce, fireSignalAlert } from './signalAlert'
import type { StrategyTrade } from '../../src/strategy/types'

type Rect = { x: number; y: number; width: number; height: number }

const BASE = '/maplevels'
const U = 'GLD'
const INDEX_REFRESH_MS = 5 * 60_000
const RETRY_MS = 60_000
/** Chart candles this far from a reference time don't count as "the price then". */
const REF_GAP_MS = 2 * 3_600_000
const FIXED_RATIO = 10.91

// ---- recorder cache (one index per page, snapshots fetched once — they never change) ----
const idx = {
  entries: [] as MapV3IndexEntry[],
  /** Recorded chart-side ratio reference per morning snapshot: symbol -> gold close at the previous 16:00 ET. */
  refs: {} as Record<string, Record<string, number>>,
  fetchedAt: 0,
  triedAt: 0,
  inflight: false,
  error: null as string | null,
}
function loadIndex(): typeof idx {
  const wait = idx.error ? RETRY_MS : INDEX_REFRESH_MS
  if (!idx.inflight && Date.now() - idx.triedAt > wait) {
    idx.inflight = true
    fetch(`${BASE}/index?u=${U}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as { snapshots: MapV3IndexEntry[] }
        // older recorders have no refs endpoint: the chart's candles are used then
        const rf = await fetch(`${BASE}/refs?u=${U}`).then((x) => (x.ok ? x.json() : null)).catch(() => null)
        idx.refs = (rf as { refs?: typeof idx.refs } | null)?.refs ?? {}
        idx.entries = j.snapshots ?? []
        idx.fetchedAt = Date.now()
        idx.error = null
      })
      .catch((err: unknown) => {
        idx.error = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        idx.triedAt = Date.now()
        idx.inflight = false
      })
  }
  return idx
}

const snaps = new Map<string, { snap: MapV3Snapshot | null; inflight: boolean; triedAt: number }>()
function loadSnapshot(id: string): MapV3Snapshot | null | 'loading' {
  let e = snaps.get(id)
  if (!e) {
    e = { snap: null, inflight: false, triedAt: 0 }
    snaps.set(id, e)
  }
  if (e.snap) return e.snap
  if (!e.inflight && Date.now() - e.triedAt > RETRY_MS) {
    const entry = e
    entry.inflight = true
    fetch(`${BASE}/snapshot?u=${U}&id=${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        entry.snap = (await r.json()) as MapV3Snapshot
      })
      .catch(() => {})
      .finally(() => {
        entry.triedAt = Date.now()
        entry.inflight = false
      })
  }
  return e.inflight || e.triedAt === 0 ? 'loading' : null
}

/** Chart symbols MAP V3 scales GLD onto (GLD itself: ratio 1). */
const isGold = (s: string): boolean => /XAU|PAXG|GOLD|^GC|GLD/.test(s.toUpperCase())

const OI_EXPIRY: MapOiExpiry[] = ['Every Expiry', '1st Expiry', '2nd Expiry', '3rd Expiry']
const toggle = (key: string, label: string, group?: string): IndicatorParam => ({ key, label, default: 1, toggle: true, group })
const G_TR = 'Trade suggestions (SYNDICATE)'
const ENGULF_COLORS = [
  { name: 'Default (Green/Red)', up: '#4caf50', down: '#f44336' },
  { name: 'Bright (Lime/Orange)', up: '#00ff00', down: '#ff9800' },
  { name: 'Subtle (Teal/Pink)', up: '#26a69a', down: '#ec407a' },
  { name: 'Bold (Lime/Red)', up: '#7fff00', down: '#ff5252' },
  { name: 'Dark (Dark Green/Dark Red)', up: '#1b5e20', down: '#b71c1c' },
]

export const theMapV3: IndicatorDef = {
  id: 'the_map_v3',
  label: 'MAP V3 — gold levels from GLD options (locked daily)',
  shortLabel: 'MAP V3',
  placement: 'overlay',
  params: [
    toggle('showHeat', 'Show GEX Heatmap'),
    toggle('show0dte', 'Show 0DTE Levels'),
    toggle('showGex', 'Show GEX Levels'),
    toggle('showOI', 'Show OI Levels'),
    { key: 'oiExpiry', label: 'OI Expiry', default: 0, options: OI_EXPIRY.map((v, i) => ({ value: i, label: v })) },
    toggle('showEng', 'Highlight Engulfing Retest at GEX Levels', 'Engulfing Retest'),
    { key: 'engulfColorScheme', label: 'Engulfing candle colors', default: 0, group: 'Engulfing Retest', options: ENGULF_COLORS.map((c, i) => ({ value: i, label: c.name })) },
    { key: 'windowDays', label: 'GEX expiry window (days)', default: MAP_V3_DEFAULTS.windowDays, min: 1, max: 60, step: 1, group: 'Data' },
    { key: 'ratioMode', label: 'GLD → chart scaling', default: 0, group: 'Data', options: [{ value: 0, label: 'Auto (chart price ÷ GLD at the NY close)' }, { value: 1, label: 'Fixed ratio' }] },
    { key: 'ratio', label: 'Fixed ratio (gold per GLD share)', default: FIXED_RATIO, min: 1, max: 100, step: 0.01, group: 'Data' },
    // SYNDICATE playbook as trade suggestions (src/overlays/mapV3TradesModel.ts)
    toggle('trades', 'Show trade suggestions', G_TR),
    toggle('tBounce', 'Touch & Bounce', G_TR),
    toggle('tRetest', 'Break & Retest', G_TR),
    { key: 'tBounceNeg', label: 'Touch & Bounce in negative regime too', default: 0, toggle: true, group: G_TR },
    { key: 'tEntryAll', label: 'Also enter at Gamma Flip / HVL / Max Pain (guide: targets, not entries)', default: 0, toggle: true, group: G_TR },
    { key: 'tFootprint', label: 'Footprint confirmation', default: 1, group: G_TR, options: [
      { value: 0, label: 'Off' },
      { value: 1, label: 'Tag (✓ / ✗ when the footprint chart has the bar)' },
      { value: 2, label: 'Required (only confirmed trades)' },
    ] },
    { key: 'tPartial', label: 'Partial at T1 %', default: MAP_TRADE_DEFAULTS.partial * 100, min: 0, max: 100, step: 10, group: G_TR },
    { key: 'tMinR', label: 'T1 at least (R)', default: MAP_TRADE_DEFAULTS.minR, min: 0.5, max: 5, step: 0.25, group: G_TR },
    { key: 'tHistory', label: 'Show past trades', default: 1, toggle: true, group: G_TR },
    { key: 'tAlerts', label: 'Alerts (entries, T1, exits)', default: 1, toggle: true, group: G_TR },
    { key: 'tSound', label: 'Alert sound', default: 1, toggle: true, group: G_TR },
  ],
  compute: () => [],
}

const gmt = (t: number): string => {
  const d = new Date(t)
  return `${d.getUTCDate()} ${d.toUTCString().slice(8, 11)} ${d.getUTCFullYear()} ${d.toISOString().slice(11, 16)} GMT`
}

/** A locked MAP V3 session for the chart: its snapshots, GLD -> chart ratio and GLD pricing spot. */
export type MapV3Session =
  | { ok: true; m: MapV3Snapshot; c: MapV3Snapshot | null; ratio: number; spot: number; windowDays: number; stamp: string; stableRatio: boolean }
  | { ok: false; waiting: string }

/** The session live at the last bar (bar replay: the replayed time). Shared with GEX Sabers. */
export function loadMapV3Session(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext, atTime?: number): MapV3Session {
  const sym = ctx.symbol.toUpperCase().replace(/^.*:/, '')
  if (!isGold(sym)) return { ok: false, waiting: `MAP V3 covers gold (XAUUSD / XAUT / PAXG) — no levels for ${ctx.symbol}` }
  const ix = loadIndex()
  if (!ix.fetchedAt) return { ok: false, waiting: ix.error ? `⚠ MAP V3 recorder not reachable (${ix.error}) — npm run demo starts it` : '⏳ Loading MAP V3 levels...' }
  const barMs = ctx.interval ? INTERVAL_MS[ctx.interval as Interval] : detectChartSec(candles) * 1000
  const last = candles[candles.length - 1]
  const at = atTime ?? (last ? Math.min(Date.now(), last.time + barMs) : Date.now())
  const s = pickSession(ix.entries, at)
  if (!s) return { ok: false, waiting: 'No MAP V3 levels recorded for this time yet' }
  const m = loadSnapshot(s.morning.id)
  const c = s.close ? loadSnapshot(s.close.id) : null
  if (m === 'loading' || c === 'loading') return { ok: false, waiting: '⏳ Loading MAP V3 levels...' }
  if (!m) return { ok: false, waiting: `⚠ MAP V3 snapshot ${s.morning.id} unavailable` }

  // GLD -> chart ratio and the session's GLD pricing spot. The recorded reference comes first:
  // it is fixed per session, so the levels (and trades off them) never move with how much
  // history the chart has loaded; the chart's own candles are the fallback for old recorders.
  let ratio = 1
  let stableRatio = sym === 'GLD'
  if (sym !== 'GLD') {
    ratio = Number.isFinite(p.ratio) && p.ratio > 0 ? p.ratio : FIXED_RATIO
    stableRatio = (p.ratioMode ?? 0) !== 0
    if ((p.ratioMode ?? 0) === 0) {
      const recorded = idx.refs[s.morning.id]?.[sym]
      const chartRef = closeAt(candles, nyTime(prevNyWeekday(m.nyDate), 16, 0), REF_GAP_MS)
      const mark = m.delta[sym]
      if (recorded > 0 && m.underlying.prevClose > 0) {
        ratio = recorded / m.underlying.prevClose
        stableRatio = true
      } else if (Number.isFinite(chartRef) && m.underlying.prevClose > 0) ratio = chartRef / m.underlying.prevClose
      else if (mark > 0 && m.underlying.price > 0) ratio = mark / m.underlying.price
    }
  }
  // the snapshot's own Delta mark is fixed too; the chart's candle at the snapshot is the fallback
  const chartAt = closeAt(candles, m.time, REF_GAP_MS)
  const spot = m.delta[sym] > 0 ? m.delta[sym] / ratio : Number.isFinite(chartAt) ? chartAt / ratio : m.underlying.price

  const stale = Date.now() - at < 2 * barMs && s.morning.nyDate !== sessionDate(Date.now())
  const stamp = stale
    ? `⚠ STALE · no ${sessionDate(Date.now())} snapshot yet · showing ${gmt(m.time)}`
    : `GLD ×${ratio.toFixed(3)} · Updated ${gmt(m.time)}${m.late ? ' (late)' : ''}`
  const windowDays = Math.max(1, Math.round(Number.isFinite(p.windowDays) ? p.windowDays : MAP_V3_DEFAULTS.windowDays))
  return { ok: true, m, c: c ?? null, ratio, spot, windowDays, stamp, stableRatio }
}

export interface TheMapV3Model extends TheMapV2Model {
  trades: MapTrade[]
  /** Bar open times the trades' indexes refer to (closed bars). */
  tradeTimes: number[]
  tradeView: { on: boolean; history: boolean; fpMode: number }
}

export function computeTheMapV3Model(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): TheMapV3Model {
  const m = computeTheMapV3Levels(candles, p, ctx)
  const on = p.trades === undefined || p.trades !== 0
  const fpMode = Math.round(Number.isFinite(p.tFootprint) ? p.tFootprint : 1)
  const view = { on, history: p.tHistory === undefined || p.tHistory !== 0, fpMode }
  if (!on || !m.levels) return { ...m, trades: [], tradeTimes: [], tradeView: view }
  const { trades, times } = mapV3Trades(candles, p, ctx, fpMode)
  if (p.tAlerts === undefined || p.tAlerts !== 0) runTradeAlerts(trades, times, ctx, p.tSound === undefined || p.tSound !== 0)
  return { ...m, trades, tradeTimes: times, tradeView: view }
}

const levelCache = new Map<string, ReturnType<typeof computeMapV3Levels>>()

function computeTheMapV3Levels(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): TheMapV2Model {
  const b = (k: string): boolean => p[k] === undefined || p[k] !== 0
  const show = { heat: b('showHeat'), zdte: b('show0dte'), gex: b('showGex'), oi: b('showOI'), eng: b('showEng') }
  const scheme = ENGULF_COLORS[Math.max(0, Math.min(Number.isFinite(p.engulfColorScheme) ? p.engulfColorScheme : 0, ENGULF_COLORS.length - 1))]
  const base: TheMapV2Model = { show, levels: null, symbol: ctx.symbol, engulf: [], stamp: 'MAP V3 · GLD options', waiting: '', meta: null, action: null, engulfUpColor: scheme.up, engulfDownColor: scheme.down }
  const ses = loadMapV3Session(candles, p, ctx)
  if (!ses.ok) return { ...base, waiting: ses.waiting }
  const { m, c, ratio, spot } = ses

  const opts = { windowDays: ses.windowDays, oiExpiry: OI_EXPIRY[p.oiExpiry ?? 0] ?? 'Every Expiry' }
  // a session's levels are fixed: price the gamma profile once, not on every tick
  const lkey = `${m.nyDate}|${c?.nyDate ?? ''}|${spot}|${opts.windowDays}|${opts.oiExpiry}`
  let r = levelCache.get(lkey)
  if (r === undefined) {
    r = computeMapV3Levels(m.rows, c ? c.rows : null, spot, m.time, opts, U)
    if (levelCache.size > 50) levelCache.clear()
    levelCache.set(lkey, r)
  }
  if (!r) return { ...base, waiting: `⚠ MAP V3: no usable contracts in ${m.nyDate}` }
  const levels: MapV2Levels = scaleMapLevels(r.levels, ratio)
  const stamp = ses.stamp.startsWith('⚠') ? ses.stamp : `MAP V3 · ${ses.stamp}`
  return {
    ...base,
    levels,
    engulf: show.eng ? engulfingRetest(candles, levels) : [],
    stamp,
    meta: { ...r.meta, spot: r.meta.spot * ratio },
    action: zeroDteActionV2(candles, levels),
  }
}

export function drawTheMapV3(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: TheMapV3Model, ctx: CanvasIndicatorContext): void {
  drawTheMapV2(g, conv, rect, candles, m, ctx)
  if (m.tradeView?.on) drawMapTrades(g, conv, rect, candles, m)
}

// ---------------------------------------------------------------------------
// Trade suggestions: every recorded session's locked levels, the SYNDICATE rules on top
// ---------------------------------------------------------------------------

const sessionLevelCache = new Map<string, MapSessionLevels | null>()

/** Each recorded session's locked levels (chart prices), with the span of bars it applies to. */
const TRADE_WARMUP_BARS = 15

function sessionsFor(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext, barMs: number): { start: number; end: number; levels: MapSessionLevels }[] {
  const mornings = loadIndex().entries.filter((e) => e.kind === 'morning').sort((a, b) => a.time - b.time)
  if (!candles.length) return []
  const out: { start: number; end: number; levels: MapSessionLevels }[] = []
  for (let k = 0; k < mornings.length; k++) {
    const start = mornings[k].time
    const end = k + 1 < mornings.length ? mornings[k + 1].time : Infinity
    // a session is traded only when its whole start is loaded (with ATR warm-up before it) and its
    // ratio is the recorded one: then nothing about it changes as the chart's window slides
    if (start - TRADE_WARMUP_BARS * barMs < candles[0].time || start > candles[candles.length - 1].time) continue
    const ses = loadMapV3Session(candles, p, ctx, start + 1)
    if (!ses.ok || !ses.stableRatio) continue
    const oiExpiry = OI_EXPIRY[p.oiExpiry ?? 0] ?? 'Every Expiry'
    const key = `${ses.m.nyDate}|${ses.ratio.toFixed(5)}|${ses.windowDays}|${oiExpiry}`
    let lv = sessionLevelCache.get(key)
    if (lv === undefined) {
      const r = computeMapV3Levels(ses.m.rows, ses.c ? ses.c.rows : null, ses.spot, ses.m.time, { windowDays: ses.windowDays, oiExpiry }, U)
      const sc = r ? scaleMapLevels(r.levels, ses.ratio) : null
      lv = sc ? { id: ses.m.nyDate, flip: sc.flip, levels: mapTradeLevels(sc) } : null
      sessionLevelCache.set(key, lv)
    }
    if (lv) out.push({ start, end, levels: lv })
  }
  return out
}

function mapV3Trades(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext, fpMode: number): { trades: MapTrade[]; times: number[] } {
  const barMs = ctx.interval ? INTERVAL_MS[ctx.interval as Interval] : detectChartSec(candles) * 1000
  const last = candles[candles.length - 1]
  // closed bars only: a trade is decided on a bar's close
  const bars = last && last.time + barMs > Date.now() ? candles.slice(0, -1) : candles
  const sessions = sessionsFor(candles, p, ctx, barMs)
  const levelsAt = (i: number): MapSessionLevels | null => {
    const t = bars[i].time
    for (const s of sessions) if (t >= s.start && t < s.end) return s.levels
    return null
  }
  const flow = fpMode > 0 ? footprintBars(`${ctx.symbol}|${ctx.interval}`) : undefined
  const confirm = flow
    ? (i: number, side: 1 | -1): boolean | null => {
        const f = flow.get(bars[i].time)
        if (!f) return null
        // the bar's order flow backs the rejection: net aggression its way, or the other side absorbed at the extreme
        return side > 0 ? f.delta > 0 || f.sellLowShare >= 0.35 : f.delta < 0 || f.buyHighShare >= 0.35
      }
    : undefined
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const opts: Partial<MapTradeOptions> = {
    touchBounce: p.tBounce === undefined || p.tBounce !== 0,
    breakRetest: p.tRetest === undefined || p.tRetest !== 0,
    bounceInNegative: (p.tBounceNeg ?? 0) !== 0,
    entryAll: (p.tEntryAll ?? 0) !== 0,
    partial: Math.min(1, Math.max(0, n('tPartial', 50) / 100)),
    minR: n('tMinR', MAP_TRADE_DEFAULTS.minR),
    requireConfirm: fpMode === 2,
  }
  return { trades: computeMapTrades(bars, levelsAt, opts, confirm), times: bars.map((b) => b.time) }
}

// alerts: new entries, T1 and exits as they happen (not the history on load)
const alertSeen = new Map<string, Set<string>>()
function runTradeAlerts(trades: MapTrade[], times: number[], ctx: CanvasIndicatorContext, sound: boolean): void {
  const key = `${ctx.symbol}|${ctx.interval}`
  let seen = alertSeen.get(key)
  const priming = !seen
  if (!seen) alertSeen.set(key, (seen = new Set()))
  const fresh = 3 * (INTERVAL_MS[(ctx.interval ?? '5m') as Interval] ?? 300_000)
  const now = Date.now()
  for (const t of trades) {
    const id = `${t.sessionId}|${times[t.index]}|${t.side}`
    const side = t.side > 0 ? 'LONG' : 'SHORT'
    const events: [string, number | undefined, string][] = [
      ['entry', times[t.index], `${side} ${t.setup === 'bounce' ? 'Touch & Bounce' : 'Break & Retest'} at ${t.level.name} ${fmtPx(t.level.price)} · entry ${fmtPx(t.entry)} · SL ${fmtPx(t.stop)} · T1 ${t.t1Name} ${fmtPx(t.t1)}${t.t2 !== null ? ` · T2 ${t.t2Name} ${fmtPx(t.t2)}` : ''} · ${t.regime} regime${t.fp === true ? ' · footprint ✓' : t.fp === false ? ' · footprint ✗' : ''}`],
      ['t1', t.t1Index !== null ? times[t.t1Index] : undefined, `${side} from ${fmtPx(t.entry)}: T1 ${t.t1Name} hit — partial off, stop to breakeven`],
      ['exit', t.exitIndex !== null ? times[t.exitIndex] : undefined, `${side} from ${fmtPx(t.entry)} closed: ${OUTCOME_TEXT[t.outcome]} · ${t.r !== null ? `${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R` : ''}`],
    ]
    for (const [kind, at, text] of events) {
      if (at === undefined || seen.has(`${id}|${kind}`)) continue
      seen.add(`${id}|${kind}`)
      if (priming || now - at > fresh) continue
      if (kind === 'entry') askNotificationPermissionOnce()
      fireSignalAlert(`MAP V3 trade · ${ctx.symbol} ${ctx.interval ?? ''}`, text, sound)
    }
  }
}

const OUTCOME_TEXT: Record<MapTrade['outcome'], string> = { open: 'open', t2: 'T2 hit', t1: 'T1 hit', breakeven: 'runner stopped at breakeven', stop: 'stopped', timeout: 'closed on time' }
const fmtPx = (v: number): string => v.toFixed(2)

/** Strategy Tester rows (whole position per trade; the T1 partial is in the R, not split). */
export function mapV3StrategyTrades(model: unknown): StrategyTrade[] {
  const m = model as TheMapV3Model
  return (m.trades ?? []).map((t) => ({
    side: t.side > 0 ? 'long' : 'short',
    entryTime: m.tradeTimes[t.index],
    entryPrice: t.entry,
    exitTime: t.exitIndex !== null ? m.tradeTimes[t.exitIndex] : null,
    // the blended exit that gives the trade's R (partial at T1 + the rest)
    exitPrice: t.r !== null ? t.entry + t.side * t.r * Math.abs(t.entry - t.stop) : null,
    exitReason: OUTCOME_TEXT[t.outcome],
    stop: t.stop,
  }))
}

function drawMapTrades(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: TheMapV3Model): void {
  if (candles.length < 2) return
  const right = rect.x + rect.width
  const spacing = Math.abs(conv.timeToX(candles[candles.length - 1].time) - conv.timeToX(candles[candles.length - 2].time)) || 6
  const lastX = conv.timeToX(candles[candles.length - 1].time)
  const T = (i: number): number => conv.timeToX(m.tradeTimes[Math.min(i, m.tradeTimes.length - 1)])
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  g.textBaseline = 'middle'
  const shown = m.tradeView.history ? m.trades : m.trades.filter((t) => t.r === null)
  for (const t of shown) {
    const open = t.r === null
    const x0 = T(t.index) + spacing / 2
    const x1 = open ? Math.max(lastX + spacing * 4, x0 + spacing * 6) : T(t.exitIndex as number) + spacing / 2
    if (x1 < rect.x || x0 > right) continue
    const yE = conv.priceToY(t.entry), yS = conv.priceToY(t.stop), y1 = conv.priceToY(t.t1)
    const y2 = t.t2 !== null ? conv.priceToY(t.t2) : null
    g.globalAlpha = open ? 1 : 0.55
    g.fillStyle = 'rgba(239,83,80,0.13)'
    g.fillRect(x0, Math.min(yE, yS), x1 - x0, Math.abs(yS - yE))
    g.fillStyle = 'rgba(38,166,154,0.13)'
    g.fillRect(x0, Math.min(yE, y2 ?? y1), x1 - x0, Math.abs((y2 ?? y1) - yE))
    const line = (y: number, color: string, dash: number[]): void => {
      g.strokeStyle = color
      g.setLineDash(dash)
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(x0, Math.round(y) + 0.5)
      g.lineTo(x1, Math.round(y) + 0.5)
      g.stroke()
    }
    line(yE, '#d1d4dc', [])
    line(yS, '#ef5350', [4, 3])
    line(y1, '#26a69a', [4, 3])
    if (y2 !== null) line(y2, '#00e676', [2, 3])
    g.setLineDash([])
    const col = t.side > 0 ? '#26a69a' : '#ef5350'
    const xa = T(t.index)
    const ya = t.side > 0 ? Math.max(yE, yS) + 12 : Math.min(yE, yS) - 12
    g.fillStyle = col
    g.beginPath()
    if (t.side > 0) {
      g.moveTo(xa, ya - 7)
      g.lineTo(xa - 6, ya + 3)
      g.lineTo(xa + 6, ya + 3)
    } else {
      g.moveTo(xa, ya + 7)
      g.lineTo(xa - 6, ya - 3)
      g.lineTo(xa + 6, ya - 3)
    }
    g.fill()
    if (spacing >= 5 || open) {
      const fp = t.fp === true ? ' ✓FP' : t.fp === false && m.tradeView.fpMode > 0 ? ' ✗FP' : ''
      pill(g, `${t.side > 0 ? 'LONG' : 'SHORT'} · ${t.setup === 'bounce' ? 'BOUNCE' : 'RETEST'} ${t.level.name}${fp}`, xa + 9, t.side > 0 ? ya + 8 : ya - 8, col)
      const lx = open ? Math.min(x1 + 3, right - 150) : x1 + 3
      if (open) {
        pill(g, `T1 ${t.t1Name} ${fmtPx(t.t1)}${t.t1Index !== null ? ' ✓' : ''}`, lx, y1, '#26a69a')
        if (y2 !== null) pill(g, `T2 ${t.t2Name} ${fmtPx(t.t2 as number)}`, lx, y2, '#00a152')
        pill(g, `IN ${fmtPx(t.entry)}`, lx, yE, '#5d6b82')
        pill(g, `SL ${fmtPx(t.t1Index !== null ? t.entry : t.stop)}${t.t1Index !== null ? ' (BE)' : ''}`, lx, t.t1Index !== null ? yE + 14 : yS, '#ef5350')
      } else {
        const r = t.r as number
        const y = conv.priceToY(t.exitPrice as number)
        pill(g, `${r > 0 ? '✓' : r < 0 ? '✗' : '•'} ${r >= 0 ? '+' : ''}${r.toFixed(2)}R ${OUTCOME_TEXT[t.outcome]}`, x1 + 3, y, r > 0 ? '#26a69a' : r < 0 ? '#ef5350' : '#5d6b82')
      }
    }
    g.globalAlpha = 1
  }
  // scorecard
  const closed = m.trades.filter((t) => t.r !== null)
  const wins = closed.filter((t) => (t.r as number) > 0).length
  const tot = closed.reduce((s, t) => s + (t.r as number), 0)
  const openN = m.trades.length - closed.length
  const card = closed.length
    ? `MAP V3 trades · ${closed.length} closed · win ${Math.round((100 * wins) / closed.length)}% · ${tot >= 0 ? '+' : ''}${(tot / closed.length).toFixed(2)}R avg · ${tot >= 0 ? '+' : ''}${tot.toFixed(1)}R total${openN ? ` · ${openN} live` : ''}`
    : `MAP V3 trades · none closed on the recorded sessions yet${openN ? ` · ${openN} live` : ''}`
  g.font = "600 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  const w = g.measureText(card).width + 16
  const yc = rect.y + rect.height - 86
  g.fillStyle = 'rgba(19,23,34,0.85)'
  g.beginPath()
  const left = rect.x + chartInset(g.canvas) + 8
  g.roundRect(left, yc, w, 20, 4)
  g.fill()
  g.fillStyle = closed.length && tot < 0 ? '#ff8a80' : '#d1d4dc'
  g.textAlign = 'left'
  g.fillText(card, left + 8, yc + 10.5)
  g.restore()
}

function pill(g: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string): void {
  g.font = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  const w = g.measureText(text).width + 8
  g.fillStyle = bg
  g.beginPath()
  g.roundRect(x, y - 7, w, 14, 3)
  g.fill()
  g.fillStyle = '#fff'
  g.textAlign = 'left'
  g.fillText(text, x + 4, y + 0.5)
}
