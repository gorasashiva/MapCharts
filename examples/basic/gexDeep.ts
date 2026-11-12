// Three GEX views modelled on DeepCharts' "Option Summary GEX", "Option GEX Heatmap" and
// "Option GEX Profile" articles, drawn on Delta's public option chain (BTC, ETH, gold via XAUT).
// DeepCharts uses CBOE participant data for SPX, which this platform doesn't have, so these are
// analogues: same layout and vocabulary, not the same numbers. The "Hedging" profile is not here yet.
//
//   GEX Summary  — net GEX over time as a bar strip under the chart (green = positive gamma,
//                  purple = negative). Samples are this session's refreshes only; nothing is persisted.
//   GEX Heatmap  — one horizontal block per strike; width and opacity = share of the largest strike.
//   GEX Profile  — per-strike bars on the right edge: calls right of a centre line, puts left (or net).
//                  Peak call and peak put strikes get a dashed line.
//
// Math: src/overlays/gexDeepModel.ts (per-strike GEX from gexSabersModel.strikeGex).

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { fmtGex, selectExpiries, strikeGex, type ExpirySelection, type SizeBy, type StrikeGex } from '../../src/overlays/gexSabersModel'
import {
  buildProfile,
  heatmapBlocks,
  netGexOf,
  pushSummarySample,
  regimeOf,
  strikeStep,
  visibleStrikes,
  type HeatBlock,
  type ProfileModel,
  type Regime,
  type SummarySample,
} from '../../src/overlays/gexDeepModel'
import type { OptionUnderlying } from './options'
import { liveChain, underlyingFor } from './gexSabers'
import { PALETTE, COL, colorOpts } from './flyingCpr'
import { fmtPrice, rgba, type Rect } from './canvasPlot'
import type { CanvasIndicatorContext } from './shankyCombo'

const G_DATA = 'Data'
const G_RANGE = 'Strikes'
const G_COLOR = 'Colours'
const G_DISPLAY = 'Display'
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min: number, max: number, step: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
const pick = (key: string, label: string, def: number, group: string, options: { value: number; label: string }[]): IndicatorParam => ({ key, label, default: def, group, options })
const colour = (key: string, label: string, name: string): IndicatorParam => pick(key, label, (COL as Record<string, number>)[name] ?? 0, G_COLOR, colorOpts)

const EXPIRY_SEL: { value: ExpirySelection; label: string }[] = [
  { value: 'nearest', label: 'Nearest expiry only (0DTE / 1DTE)' },
  { value: 'nearest2', label: 'Nearest 2 expiries' },
  { value: 'nearest3', label: 'Nearest 3 expiries' },
  { value: 'nearest6', label: 'Nearest 6 expiries' },
  { value: 'week', label: 'Expiring within 7 days' },
  { value: 'month', label: 'Expiring within 30 days' },
]
const SIZE_SEL: { value: SizeBy; label: string }[] = [
  { value: 'oi', label: 'Open interest (standing walls)' },
  { value: 'volume', label: 'Last 24h volume (where flow is building)' },
]

const dataParams = (): IndicatorParam[] => [
  pick('expiries', 'Option expiries', 0, G_DATA, EXPIRY_SEL.map((e, i) => ({ value: i, label: e.label }))),
  pick('sizeBy', 'GEX sized by', 0, G_DATA, SIZE_SEL.map((e, i) => ({ value: i, label: e.label }))),
]
const rangeParams = (defRange: number): IndicatorParam[] => [
  num('range', 'Strikes considered (± % of price)', defRange, G_RANGE, 1, 30, 1),
  num('numStrikes', 'Max strikes shown (0 = all in range)', 0, G_RANGE, 0, 200, 1),
]

const hexOf = (idx: number, fallback: string): string => (PALETTE[idx] ? PALETTE[idx][1] : fallback)
const colIdx = (name: string): number => (COL as Record<string, number>)[name] ?? 0

// ---------------------------------------------------------------------------
// Shared data: the Delta chain for the chart's underlying, filtered by the settings
// ---------------------------------------------------------------------------
interface Loaded {
  underlying: OptionUnderlying | null
  fetchedAt: number
  strikes: StrikeGex[]
  spot: number
  stamp: string
  waiting: string
}

const istClock = (t: number): string => new Date(t + 5.5 * 3_600_000).toISOString().slice(11, 16)

function loadStrikes(candles: Candle[], ctx: CanvasIndicatorContext, p: Record<string, number>): Loaded {
  const u = underlyingFor(ctx.symbol)
  const empty: Loaded = { underlying: u, fetchedAt: 0, strikes: [], spot: 0, stamp: '', waiting: '' }
  if (!u) return { ...empty, waiting: `GEX: no Delta options for ${ctx.symbol} (BTC, ETH, gold)` }
  const e = liveChain(u)
  const asset = u.replace(/USD$/, '')
  if (!e.fetchedAt) return { ...empty, waiting: e.error ? `⚠ Delta options unavailable: ${e.error}` : `⏳ Loading Delta ${asset} options...` }
  const spot = candles.length ? candles[candles.length - 1].close : 0
  const sel = EXPIRY_SEL[Math.round(p.expiries ?? 0)] ?? EXPIRY_SEL[0]
  const size = SIZE_SEL[Math.round(p.sizeBy ?? 0)] ?? SIZE_SEL[0]
  const expiries = selectExpiries(e.rows, Date.now(), sel.value)
  const strikes = strikeGex(e.rows, spot, expiries, size.value)
  if (!strikes.length || !(spot > 0)) {
    return { ...empty, fetchedAt: e.fetchedAt, spot, waiting: `⚠ No ${asset} option ${size.value === 'oi' ? 'open interest' : 'volume today'} for the chosen expiries` }
  }
  return {
    underlying: u,
    fetchedAt: e.fetchedAt,
    strikes,
    spot,
    stamp: `${e.error ? '⚠ STALE · ' : ''}Delta ${asset} options · ${size.value === 'oi' ? 'OI' : 'volume'} · ${istClock(e.fetchedAt)} IST`,
    waiting: '',
  }
}

function drawWaiting(g: CanvasRenderingContext2D, text: string, x: number, y: number, align: CanvasTextAlign, baseline: CanvasTextBaseline): void {
  g.font = FONT
  g.fillStyle = '#9aa3b2'
  g.textAlign = align
  g.textBaseline = baseline
  g.fillText(text, x, y)
}

// ---------------------------------------------------------------------------
// 1. GEX Summary — net GEX over time
// ---------------------------------------------------------------------------
const summaryHistory = new Map<string, SummarySample[]>()

export const gexSummary: IndicatorDef = {
  id: 'gex_summary',
  label: 'GEX Summary — net gamma regime over time (Delta options)',
  shortLabel: 'GEX Summary',
  placement: 'pane',
  params: [
    ...dataParams(),
    colour('posColor', 'Positive gamma colour', 'Green'),
    colour('negColor', 'Negative gamma colour', 'Purple'),
  ],
  compute: () => [],
}

export interface GexSummaryModel {
  net: number
  regime: Regime
  samples: SummarySample[]
  posColor: string
  negColor: string
  waiting: string
  stamp: string
}

export function computeGexSummaryModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): GexSummaryModel {
  const l = loadStrikes(candles, ctx, p)
  const base: GexSummaryModel = {
    net: Number.NaN,
    regime: 'flat',
    samples: [],
    posColor: hexOf(Math.round(p.posColor ?? colIdx('Green')), '#4CAF50'),
    negColor: hexOf(Math.round(p.negColor ?? colIdx('Purple')), '#9C27B0'),
    waiting: l.waiting,
    stamp: l.stamp,
  }
  if (!l.underlying || !l.fetchedAt || !l.strikes.length) return base
  const key = `${l.underlying}|${p.expiries ?? 0}|${p.sizeBy ?? 0}`
  const net = netGexOf(l.strikes)
  const samples = pushSummarySample(summaryHistory.get(key) ?? [], { time: l.fetchedAt, net })
  summaryHistory.set(key, samples)
  return { ...base, net, regime: regimeOf(net), samples }
}

export function drawGexSummary(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: GexSummaryModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  // The indicator has its own pane below the chart, so it fills the whole pane rect.
  const h = rect.height
  const top = rect.y
  const mid = top + h / 2

  if (m.waiting) {
    drawWaiting(g, m.waiting, rect.x + rect.width - 8, mid, 'right', 'middle')
    g.restore()
    return
  }

  const t0 = conv.xToTime(rect.x)
  const t1 = conv.xToTime(rect.x + rect.width)
  const vis = m.samples.filter((s) => s.time >= t0 && s.time <= t1)
  const maxAbs = vis.reduce((mx, s) => Math.max(mx, Math.abs(s.net)), 0) || 1
  const half = h / 2 - 4
  for (const s of vis) {
    const x = conv.timeToX(s.time)
    const bh = Math.max(1, (Math.abs(s.net) / maxAbs) * half)
    g.fillStyle = s.net >= 0 ? m.posColor : m.negColor
    if (s.net >= 0) g.fillRect(x - 1.5, mid - bh, 3, bh)
    else g.fillRect(x - 1.5, mid, 3, bh)
  }
  g.strokeStyle = 'rgba(255, 255, 255, 0.35)'
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(rect.x, Math.round(mid) + 0.5)
  g.lineTo(rect.x + rect.width, Math.round(mid) + 0.5)
  g.stroke()

  g.font = FONT
  g.textAlign = 'right'
  g.textBaseline = 'top'
  const word = m.regime === 'positive' ? 'positive gamma' : m.regime === 'negative' ? 'negative gamma' : 'flat'
  g.fillStyle = m.regime === 'negative' ? m.negColor : m.posColor
  g.fillText(`Net GEX ${fmtGex(m.net)} · ${word}`, rect.x + rect.width - 8, top + 4)
  g.fillStyle = 'rgba(154, 163, 178, 0.9)'
  g.fillText(m.stamp, rect.x + rect.width - 8, top + 17)
  g.restore()
}

// ---------------------------------------------------------------------------
// 2. GEX Heatmap — one block per strike
// ---------------------------------------------------------------------------
export const gexHeatmap: IndicatorDef = {
  id: 'gex_heatmap',
  label: 'GEX Heatmap — gamma blocks per strike (Delta options)',
  shortLabel: 'GEX Heatmap',
  placement: 'overlay',
  params: [
    ...dataParams(),
    ...rangeParams(10),
    num('cutoff', 'Hide blocks below (% of largest strike)', 30, G_RANGE, 0, 100, 1),
    num('maxWidth', 'Widest block (% of chart width)', 35, G_DISPLAY, 5, 100, 1),
    num('maxOpacity', 'Strongest block opacity (%)', 90, G_DISPLAY, 10, 100, 1),
    colour('callColor', 'Call (positive GEX) colour', 'Teal'),
    colour('putColor', 'Put (negative GEX) colour', 'Orange'),
  ],
  compute: () => [],
}

export interface GexHeatmapModel {
  blocks: HeatBlock[]
  step: number
  maxWidth: number
  maxOpacity: number
  callColor: string
  putColor: string
  waiting: string
}

export function computeGexHeatmapModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): GexHeatmapModel {
  const l = loadStrikes(candles, ctx, p)
  const base: GexHeatmapModel = {
    blocks: [],
    step: 0,
    maxWidth: Math.max(5, p.maxWidth ?? 35) / 100,
    maxOpacity: Math.max(10, p.maxOpacity ?? 90) / 100,
    callColor: hexOf(Math.round(p.callColor ?? colIdx('Teal')), '#26C6DA'),
    putColor: hexOf(Math.round(p.putColor ?? colIdx('Orange')), '#FF9800'),
    waiting: l.waiting,
  }
  if (!l.strikes.length) return base
  const range = Math.max(1, p.range ?? 10)
  const numStrikes = Math.max(0, Math.round(p.numStrikes ?? 0))
  const visible = visibleStrikes(l.strikes, l.spot, range, numStrikes)
  return {
    ...base,
    blocks: heatmapBlocks(l.strikes, l.spot, range, numStrikes, p.cutoff ?? 30),
    step: strikeStep(visible, l.spot),
  }
}

export function drawGexHeatmap(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: GexHeatmapModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  const right = rect.x + rect.width
  for (const b of m.blocks) {
    const y1 = conv.priceToY(b.strike + m.step / 2)
    const y2 = conv.priceToY(b.strike - m.step / 2)
    const h = Math.max(1, Math.abs(y2 - y1) - 1)
    const w = rect.width * m.maxWidth * b.intensity
    g.fillStyle = rgba(b.side === 'call' ? m.callColor : m.putColor, Math.max(0.08, m.maxOpacity * b.intensity))
    g.fillRect(right - w, Math.min(y1, y2), w, h)
  }
  if (m.waiting) drawWaiting(g, m.waiting, right - 8, rect.y + rect.height - 8, 'right', 'bottom')
  g.restore()
}

// ---------------------------------------------------------------------------
// 3. GEX Profile — per-strike bars on the right edge (split calls/puts, or net)
// ---------------------------------------------------------------------------
export const gexProfileSplit: IndicatorDef = {
  id: 'gex_profile_split',
  label: 'GEX Profile (split) — calls right, puts left, per strike (Delta options)',
  shortLabel: 'GEX Profile',
  placement: 'overlay',
  params: [
    ...dataParams(),
    ...rangeParams(10),
    pick('mode', 'Mode', 0, G_DISPLAY, [
      { value: 0, label: 'Split: calls right, puts left' },
      { value: 1, label: 'Net per strike' },
    ]),
    num('profileWidth', 'Profile width (px)', 160, G_DISPLAY, 40, 400, 10),
    toggle('peaks', 'Dashed line at peak call and peak put', true, G_DISPLAY),
    colour('callColor', 'Call colour', 'Green'),
    colour('putColor', 'Put colour', 'Purple'),
  ],
  compute: () => [],
}

export interface GexProfileModel {
  profile: ProfileModel | null
  step: number
  split: boolean
  width: number
  peaks: boolean
  callColor: string
  putColor: string
  waiting: string
  stamp: string
}

export function computeGexProfileModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): GexProfileModel {
  const l = loadStrikes(candles, ctx, p)
  const base: GexProfileModel = {
    profile: null,
    step: 0,
    split: Math.round(p.mode ?? 0) === 0,
    width: Math.max(40, p.profileWidth ?? 160),
    peaks: (p.peaks ?? 1) !== 0,
    callColor: hexOf(Math.round(p.callColor ?? colIdx('Green')), '#4CAF50'),
    putColor: hexOf(Math.round(p.putColor ?? colIdx('Purple')), '#9C27B0'),
    waiting: l.waiting,
    stamp: l.stamp,
  }
  if (!l.strikes.length) return base
  const range = Math.max(1, p.range ?? 10)
  const numStrikes = Math.max(0, Math.round(p.numStrikes ?? 0))
  const profile = buildProfile(l.strikes, l.spot, range, numStrikes)
  const visible = visibleStrikes(l.strikes, l.spot, range, numStrikes)
  return { ...base, profile, step: strikeStep(visible, l.spot) }
}

export function drawGexProfileSplit(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: GexProfileModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  const right = rect.x + rect.width
  const pw = Math.min(m.width, rect.width * 0.5)
  const half = pw / 2
  const cx = right - 6 - half
  const p = m.profile

  if (p && p.rows.length) {
    const rowH = Math.max(2, Math.abs(conv.priceToY(p.rows[0].strike) - conv.priceToY(p.rows[0].strike + m.step)) * 0.7)
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(Math.round(cx) + 0.5, conv.priceToY(p.rows[0].strike))
    g.lineTo(Math.round(cx) + 0.5, conv.priceToY(p.rows[p.rows.length - 1].strike))
    g.stroke()
    for (const r of p.rows) {
      const y = conv.priceToY(r.strike) - rowH / 2
      if (m.split) {
        if (r.callGex > 0) {
          g.fillStyle = rgba(m.callColor, 0.85)
          g.fillRect(cx, y, (r.callGex / p.maxAbs) * half, rowH)
        }
        if (r.putGex < 0) {
          const w = (-r.putGex / p.maxAbs) * half
          g.fillStyle = rgba(m.putColor, 0.85)
          g.fillRect(cx - w, y, w, rowH)
        }
      } else if (r.net !== 0) {
        const w = (Math.abs(r.net) / p.maxAbs) * half
        g.fillStyle = rgba(r.net > 0 ? m.callColor : m.putColor, 0.85)
        g.fillRect(r.net > 0 ? cx : cx - w, y, w, rowH)
      }
    }

    if (m.peaks) {
      g.font = FONT
      g.textBaseline = 'bottom'
      g.textAlign = 'right'
      const peak = (strike: number, color: string, label: string): void => {
        const y = Math.round(conv.priceToY(strike)) + 0.5
        g.setLineDash([5, 4])
        g.strokeStyle = rgba(color, 0.95)
        g.beginPath()
        g.moveTo(rect.x, y)
        g.lineTo(right, y)
        g.stroke()
        g.setLineDash([])
        g.fillStyle = rgba(color, 1)
        g.fillText(`${label} ${fmtPrice(strike)}`, right - pw - 12, y - 2)
      }
      if (p.peakCall !== null) peak(p.peakCall, m.callColor, 'Peak call')
      if (p.peakPut !== null) peak(p.peakPut, m.putColor, 'Peak put')
    }
    g.font = FONT
    g.fillStyle = 'rgba(154, 163, 178, 0.95)'
    g.textAlign = 'right'
    g.textBaseline = 'bottom'
    g.fillText(`Net ${fmtGex(p.netTotal)} · ${m.stamp}`, right - 8, rect.y + rect.height - 8)
  }

  if (m.waiting) drawWaiting(g, m.waiting, right - 8, rect.y + rect.height - 24, 'right', 'bottom')
  g.restore()
}
