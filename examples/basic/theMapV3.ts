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

type Rect = { x: number; y: number; width: number; height: number }

const BASE = '/maplevels'
const U = 'GLD'
const INDEX_REFRESH_MS = 5 * 60_000
const RETRY_MS = 60_000
/** Chart candles this far from a reference time don't count as "the price then". */
const REF_GAP_MS = 2 * 3_600_000
const FIXED_RATIO = 10.91

// ---- recorder cache (one index per page, snapshots fetched once — they never change) ----
const idx = { entries: [] as MapV3IndexEntry[], fetchedAt: 0, triedAt: 0, inflight: false, error: null as string | null }
function loadIndex(): typeof idx {
  const wait = idx.error ? RETRY_MS : INDEX_REFRESH_MS
  if (!idx.inflight && Date.now() - idx.triedAt > wait) {
    idx.inflight = true
    fetch(`${BASE}/index?u=${U}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as { snapshots: MapV3IndexEntry[] }
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
  ],
  compute: () => [],
}

const gmt = (t: number): string => {
  const d = new Date(t)
  return `${d.getUTCDate()} ${d.toUTCString().slice(8, 11)} ${d.getUTCFullYear()} ${d.toISOString().slice(11, 16)} GMT`
}

/** A locked MAP V3 session for the chart: its snapshots, GLD -> chart ratio and GLD pricing spot. */
export type MapV3Session =
  | { ok: true; m: MapV3Snapshot; c: MapV3Snapshot | null; ratio: number; spot: number; windowDays: number; stamp: string }
  | { ok: false; waiting: string }

/** The session live at the last bar (bar replay: the replayed time). Shared with GEX Sabers. */
export function loadMapV3Session(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): MapV3Session {
  const sym = ctx.symbol.toUpperCase().replace(/^.*:/, '')
  if (!isGold(sym)) return { ok: false, waiting: `MAP V3 covers gold (XAUUSD / XAUT / PAXG) — no levels for ${ctx.symbol}` }
  const ix = loadIndex()
  if (!ix.fetchedAt) return { ok: false, waiting: ix.error ? `⚠ MAP V3 recorder not reachable (${ix.error}) — npm run demo starts it` : '⏳ Loading MAP V3 levels...' }
  const barMs = ctx.interval ? INTERVAL_MS[ctx.interval as Interval] : detectChartSec(candles) * 1000
  const last = candles[candles.length - 1]
  const at = last ? Math.min(Date.now(), last.time + barMs) : Date.now()
  const s = pickSession(ix.entries, at)
  if (!s) return { ok: false, waiting: 'No MAP V3 levels recorded for this time yet' }
  const m = loadSnapshot(s.morning.id)
  const c = s.close ? loadSnapshot(s.close.id) : null
  if (m === 'loading' || c === 'loading') return { ok: false, waiting: '⏳ Loading MAP V3 levels...' }
  if (!m) return { ok: false, waiting: `⚠ MAP V3 snapshot ${s.morning.id} unavailable` }

  // GLD -> chart ratio and the session's GLD pricing spot
  let ratio = 1
  if (sym !== 'GLD') {
    ratio = Number.isFinite(p.ratio) && p.ratio > 0 ? p.ratio : FIXED_RATIO
    if ((p.ratioMode ?? 0) === 0) {
      const chartRef = closeAt(candles, nyTime(prevNyWeekday(m.nyDate), 16, 0), REF_GAP_MS)
      const mark = m.delta[sym]
      if (Number.isFinite(chartRef) && m.underlying.prevClose > 0) ratio = chartRef / m.underlying.prevClose
      else if (mark > 0 && m.underlying.price > 0) ratio = mark / m.underlying.price
    }
  }
  const chartAt = closeAt(candles, m.time, REF_GAP_MS)
  const spot = Number.isFinite(chartAt) ? chartAt / ratio : m.delta[sym] > 0 ? m.delta[sym] / ratio : m.underlying.price

  const stale = Date.now() - at < 2 * barMs && s.morning.nyDate !== sessionDate(Date.now())
  const stamp = stale
    ? `⚠ STALE · no ${sessionDate(Date.now())} snapshot yet · showing ${gmt(m.time)}`
    : `GLD ×${ratio.toFixed(3)} · Updated ${gmt(m.time)}${m.late ? ' (late)' : ''}`
  const windowDays = Math.max(1, Math.round(Number.isFinite(p.windowDays) ? p.windowDays : MAP_V3_DEFAULTS.windowDays))
  return { ok: true, m, c: c ?? null, ratio, spot, windowDays, stamp }
}

export function computeTheMapV3Model(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): TheMapV2Model {
  const b = (k: string): boolean => p[k] === undefined || p[k] !== 0
  const show = { heat: b('showHeat'), zdte: b('show0dte'), gex: b('showGex'), oi: b('showOI'), eng: b('showEng') }
  const scheme = ENGULF_COLORS[Math.max(0, Math.min(Number.isFinite(p.engulfColorScheme) ? p.engulfColorScheme : 0, ENGULF_COLORS.length - 1))]
  const base: TheMapV2Model = { show, levels: null, symbol: ctx.symbol, engulf: [], stamp: 'MAP V3 · GLD options', waiting: '', meta: null, action: null, engulfUpColor: scheme.up, engulfDownColor: scheme.down }
  const ses = loadMapV3Session(candles, p, ctx)
  if (!ses.ok) return { ...base, waiting: ses.waiting }
  const { m, c, ratio, spot } = ses

  const opts = { windowDays: ses.windowDays, oiExpiry: OI_EXPIRY[p.oiExpiry ?? 0] ?? 'Every Expiry' }
  const r = computeMapV3Levels(m.rows, c ? c.rows : null, spot, m.time, opts, U)
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

export function drawTheMapV3(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: TheMapV2Model, ctx: CanvasIndicatorContext): void {
  drawTheMapV2(g, conv, rect, candles, m, ctx)
}
