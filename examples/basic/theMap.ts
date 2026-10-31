// "THE MAP (clone)" — port of map.pine as an Indicators-menu entry. Math / data:
// src/overlays/mapModel.ts. GEX / OI / 0DTE levels are computed LIVE from Delta India's
// option chain (XAUT for XAUTUSD / PAXGUSD charts, BTC, ETH), refreshed every minute;
// the map.pine snapshot remains selectable as a data source. Drawn through the canvas-indicator
// hook (see CanvasSource in custom-indicators.ts) with map.pine's palette and layout:
// level lines + labels at the last bar, OI labels 10 bars right, 0DTE lines to 25 bars
// right, heatmap bars just right of price, status table bottom-right, engulfing-retest
// bar colours.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import {
  MAP_TICKERS,
  MAP_UPDATED,
  computeMapLevelsFromChain,
  engulfingRetest,
  gexLevels,
  mapStatus,
  mapTickerFor,
  parseMapRow,
  zeroDteAction,
  type MapAction,
  type MapChainRow,
  type MapLevels,
  type MapLiveMeta,
  type MapOiExpiry,
} from '../../src/overlays/mapModel'
import { fetchOptionChain, type OptionUnderlying } from './options'
import type { CanvasIndicatorContext } from './shankyCombo'

// ---- live option chain cache (one fetch per underlying per minute, shared by all panes) ----
const REFRESH_MS = 60_000
interface LiveEntry {
  rows: MapChainRow[]
  spot: number
  /** Last SUCCESSFUL fetch — what the stamp shows. */
  fetchedAt: number
  /** Last attempt, success or not — throttles retries to one per REFRESH_MS. */
  triedAt: number
  inflight: boolean
  error: string | null
}
const live = new Map<OptionUnderlying, LiveEntry>()
function liveUnderlying(symbol: string): OptionUnderlying | null {
  const s = symbol.toUpperCase()
  if (s === 'XAUTUSD' || s === 'PAXGUSD') return 'XAUTUSD'
  if (s === 'BTCUSD' || s === 'ETHUSD') return s
  return null
}
function liveChain(u: OptionUnderlying): LiveEntry {
  let e = live.get(u)
  if (!e) {
    e = { rows: [], spot: 0, fetchedAt: 0, triedAt: 0, inflight: false, error: null }
    live.set(u, e)
  }
  if (!e.inflight && Date.now() - e.triedAt > REFRESH_MS) {
    const entry = e
    entry.inflight = true
    fetchOptionChain(u)
      .then((chain) => {
        const spots = chain.map((q) => q.spot).filter((v) => v > 0).sort((a, b) => a - b)
        entry.rows = chain.map((q) => ({ side: q.side, strike: q.strike, expiry: q.expiry, gamma: q.gamma, openInterest: q.openInterest }))
        entry.spot = spots.length ? spots[spots.length >> 1] : 0
        entry.error = null
        entry.fetchedAt = Date.now()
      })
      .catch((err: unknown) => {
        entry.error = err instanceof Error ? err.message : String(err)
      })
      .finally(() => {
        entry.triedAt = Date.now()
        entry.inflight = false
      })
  }
  return e
}

type Rect = { x: number; y: number; width: number; height: number }

const OI_EXPIRY: MapOiExpiry[] = ['Every Expiry', '1st Expiry', '2nd Expiry', '3rd Expiry']
const toggle = (key: string, label: string, group?: string): IndicatorParam => ({ key, label, default: 1, toggle: true, group })

// Engulfing retest candle color presets
const ENGULF_COLORS = [
  { name: 'Default (Green/Red)', up: '#4caf50', down: '#f44336' },
  { name: 'Bright (Lime/Orange)', up: '#00ff00', down: '#ff9800' },
  { name: 'Subtle (Teal/Pink)', up: '#26a69a', down: '#ec407a' },
  { name: 'Bold (Lime/Red)', up: '#7fff00', down: '#ff5252' },
  { name: 'Dark (Dark Green/Dark Red)', up: '#1b5e20', down: '#b71c1c' },
]

export const theMap: IndicatorDef = {
  id: 'the_map',
  label: 'THE MAP (clone) — GEX / OI / 0DTE levels',
  shortLabel: 'MAP clone',
  placement: 'overlay',
  params: [
    toggle('showHeat', 'Show GEX Heatmap'),
    toggle('show0dte', 'Show 0DTE Levels'),
    toggle('showGex', 'Show GEX Levels'),
    toggle('showOI', 'Show OI Levels'),
    { key: 'oiExpiry', label: 'OI Expiry', default: 0, options: OI_EXPIRY.map((v, i) => ({ value: i, label: v })) },
    toggle('showEng', 'Highlight Engulfing Retest at GEX Levels', 'Engulfing Retest'),
    {
      key: 'engulfColorScheme',
      label: 'Engulfing candle colors',
      default: 0,
      group: 'Engulfing Retest',
      options: ENGULF_COLORS.map((c, i) => ({ value: i, label: c.name })),
    },
    {
      key: 'source',
      label: 'Data source',
      default: 0,
      group: 'Data',
      options: [
        { value: 0, label: 'Live — Delta options chain' },
        { value: 1, label: 'Snapshot — map.pine (9 Oct 2026)' },
      ],
    },
    {
      key: 'dataTicker',
      label: 'Snapshot ticker (Auto = match the chart symbol)',
      default: 0,
      group: 'Data',
      options: [{ value: 0, label: 'Auto' }, ...MAP_TICKERS.map((t, i) => ({ value: i + 1, label: t }))],
    },
  ],
  compute: () => [],
}

export interface TheMapModel {
  show: { heat: boolean; zdte: boolean; gex: boolean; oi: boolean; eng: boolean }
  levels: MapLevels | null
  symbol: string
  engulf: (1 | -1 | 0)[]
  /** Bottom row of the status table: snapshot date, or the live source + update time. */
  stamp: string
  /** Placeholder text when there are no levels. */
  waiting: string
  meta: MapLiveMeta | null
  /** 0DTE entry-rule suggestion for the status table (null without levels). */
  action: MapAction | null
  /** Engulfing retest candle colors (user-customizable). */
  engulfUpColor: string
  engulfDownColor: string
}

const istTime = (t: number): string => new Date(t + 5.5 * 3_600_000).toISOString().slice(11, 19)
const istDay = (t: number): string => new Date(t + 5.5 * 3_600_000).toUTCString().slice(5, 11)

export function computeTheMapModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): TheMapModel {
  const b = (k: string): boolean => p[k] === undefined || p[k] !== 0
  const oiExpiry = OI_EXPIRY[p.oiExpiry ?? 0] ?? 'Every Expiry'
  const show = { heat: b('showHeat'), zdte: b('show0dte'), gex: b('showGex'), oi: b('showOI'), eng: b('showEng') }

  // Get engulfing retest colors from the selected scheme
  const colorSchemeIdx = Math.max(0, Math.min(Number.isFinite(p.engulfColorScheme) ? p.engulfColorScheme : 0, ENGULF_COLORS.length - 1))
  const scheme = ENGULF_COLORS[colorSchemeIdx]

  let levels: MapLevels | null = null
  let stamp = MAP_UPDATED
  let waiting = `⏳ GEX Loading... (${ctx.symbol})`
  let meta: MapLiveMeta | null = null

  if ((p.source ?? 0) === 0) {
    const u = liveUnderlying(ctx.symbol)
    if (!u) {
      waiting = `No Delta options for ${ctx.symbol} (live MAP: XAUTUSD / PAXGUSD, BTCUSD, ETHUSD)`
      stamp = 'Live — Delta options'
    } else {
      const e = liveChain(u)
      const r = e.rows.length ? computeMapLevelsFromChain(e.rows, e.spot, Date.now(), oiExpiry, u) : null
      if (r) {
        levels = r.levels
        meta = r.meta
        stamp = e.error
          ? `⚠ STALE · refresh failed · last good ${istTime(e.fetchedAt)} IST`
          : `LIVE · Delta ${u.replace(/USD$/, '')} options · ${r.meta.contracts} contracts · ${istTime(e.fetchedAt)} IST`
      } else {
        waiting = e.error ? `⚠ Option chain unavailable: ${e.error}` : `⏳ Loading Delta ${u.replace(/USD$/, '')} options...`
        stamp = 'Live — Delta options'
      }
    }
  } else {
    const pick = Number.isFinite(p.dataTicker) ? p.dataTicker : 0
    const ticker = pick > 0 ? (MAP_TICKERS[pick - 1] ?? '') : mapTickerFor(ctx.symbol)
    levels = ticker ? parseMapRow(ticker, oiExpiry) : null
  }
  return {
    show,
    levels,
    symbol: ctx.symbol,
    engulf: levels && show.eng ? engulfingRetest(candles, levels) : [],
    stamp,
    waiting,
    meta,
    action: levels ? zeroDteAction(candles, levels) : null,
    engulfUpColor: scheme.up,
    engulfDownColor: scheme.down,
  }
}


// ---------------------------------------------------------------------------
// Drawing — map.pine's palette
// ---------------------------------------------------------------------------
const C = {
  vu: '#A5D6A7',
  cw: '#81C784',
  gray: '#757575',
  pw: '#EF9A9A',
  dark: '#1A1A1A',
  ink: '#363A45',
  txt2: '#9E9E9E',
  cell: '#2A2A2A',
  oiCall: '#00e5ff',
  oiPut: '#ff80ab',
  z: ['#00fa4b', '#fa0000', '#fa6800'],
  heatPos: '#26A69A',
  heatNeg: '#EF5350',
}
const LEVEL_STYLE: { bg: string; txt: string; line: string; dash: number[]; width: number }[] = [
  { bg: C.vu, txt: C.ink, line: C.vu, dash: [2, 3], width: 2 }, // VU TRIGGER — dotted
  { bg: C.cw, txt: C.ink, line: C.cw, dash: [], width: 2 }, // CALL WALL — solid
  { bg: C.vu, txt: C.ink, line: C.vu, dash: [6, 4], width: 1 }, // GEX FLIP — dashed
  { bg: C.gray, txt: '#fff', line: C.gray, dash: [2, 3], width: 1 }, // HVL — dotted
  { bg: C.dark, txt: '#fff', line: C.gray, dash: [2, 3], width: 1 }, // MAX PAIN — dotted
  { bg: C.pw, txt: C.ink, line: C.pw, dash: [], width: 2 }, // PUT WALL — solid
  { bg: C.dark, txt: '#fff', line: C.dark, dash: [2, 3], width: 2 }, // VD TRIGGER — dotted
]
const TINY = "600 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const SMALL = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const fmt = (p: number): string => `$${Math.round(p * 100) / 100}` // the original prints at most 2 decimals
const CANDLE_TYPES = new Set(['candles', 'hollow', 'volcandles'])

function hline(g: CanvasRenderingContext2D, x0: number, x1: number, y: number, color: string, width: number, dash: number[] = []): void {
  g.strokeStyle = color
  g.lineWidth = width
  g.setLineDash(dash)
  g.beginPath()
  g.moveTo(x0, y)
  g.lineTo(x1, y)
  g.stroke()
  g.setLineDash([])
}

/** Full width of a labelLeft() label, pointer included. */
function labelWidth(g: CanvasRenderingContext2D, text: string, font: string): number {
  g.font = font
  return 6 + (text ? g.measureText(text).width + 10 : 8)
}

/** Pine label.style_label_left: pointer at (x, y), box to the right. Empty text = small blank marker. */
function labelLeft(g: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string, font: string): void {
  g.font = font
  const h = font === SMALL ? 16 : 14
  const w = text ? g.measureText(text).width + 10 : 8
  g.fillStyle = bg
  g.beginPath()
  g.moveTo(x, y)
  g.lineTo(x + 6, y - h / 2)
  g.lineTo(x + 6 + w, y - h / 2)
  g.lineTo(x + 6 + w, y + h / 2)
  g.lineTo(x + 6, y + h / 2)
  g.closePath()
  g.fill()
  if (!text) return
  g.fillStyle = fg
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  g.fillText(text, x + 11, y + 0.5)
}

export function drawTheMap(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: TheMapModel, ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  const last = candles[candles.length - 1]
  const barMs = last.time - candles[candles.length - 2].time || 60_000
  const barW = Math.abs(conv.timeToX(candles[1].time) - conv.timeToX(candles[0].time)) || 6
  const XB = (k: number): number => conv.timeToX(last.time + k * barMs) // Pine's bar_index + k
  const Y = (p: number): number => conv.priceToY(p)
  const left = rect.x
  const right = rect.x + rect.width
  const l = m.levels

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  // Engulfing-retest bar colour (barcolor): repaint the candle with user's selected colors.
  if (l && m.show.eng && CANDLE_TYPES.has(ctx.chartType)) {
    const t0 = conv.xToTime(rect.x) - barMs
    const t1 = conv.xToTime(rect.x + rect.width) + barMs
    const bw = Math.max(1, barW * 0.7)
    candles.forEach((c, i) => {
      const e = m.engulf[i]
      if (!e || c.time < t0 || c.time > t1) return
      const col = e === 1 ? m.engulfUpColor : m.engulfDownColor
      const x = conv.timeToX(c.time)
      g.strokeStyle = col
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(Math.round(x) + 0.5, Y(c.high))
      g.lineTo(Math.round(x) + 0.5, Y(c.low))
      g.stroke()
      const yo = Y(c.open)
      const yc = Y(c.close)
      g.fillStyle = col
      g.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)))
    })
  }

  if (!l) {
    const wx = Math.max(left + 2, Math.min(XB(0), right - 4 - labelWidth(g, m.waiting, TINY)))
    labelLeft(g, wx, Y(last.close), m.waiting, 'rgba(66, 66, 66, 0.8)', C.vu, TINY)
    drawTable(g, rect, '—', '—', C.cell, C.cell, C.txt2, m.stamp, null)
    g.restore()
    return
  }

  // Labels are collected first (their widths drive the layout below) and drawn after every
  // line / heatmap bar, as Pine stacks labels above lines. `k` = Pine's bar offset from the last bar.
  const labels: { k: number; y: number; text: string; bg: string; fg: string; font: string }[] = []
  const label = (k: number, y: number, text: string, bg: string, fg: string, font: string): void => {
    labels.push({ k, y, text, bg, fg, font })
  }

  // GEX levels: lines extend both ways; labels at the last bar (a later level at the same price takes the text).
  const levels = gexLevels(l)
  const oiCallMerged = m.show.oi && m.show.gex && l.oiCall === l.callWall
  const oiPutMerged = m.show.oi && m.show.gex && l.oiPut === l.putWall
  if (oiCallMerged) levels[1].name = 'CALL WALL+OI'
  if (oiPutMerged) levels[5].name = 'PUT WALL+OI'
  if (m.show.gex) {
    levels.forEach((lv, i) => {
      if (!Number.isFinite(lv.price)) return
      const blank = levels.some((o, j) => j > i && o.price === lv.price)
      let text = ''
      if (!blank) {
        text = `${lv.name}  ${fmt(lv.price)}`
        levels.forEach((o, j) => {
          if (j < i && o.price === lv.price) text += `  ${o.name}  ${fmt(o.price)}`
        })
      }
      label(0, Y(lv.price), text, LEVEL_STYLE[i].bg, LEVEL_STYLE[i].txt, TINY)
    })
  }

  // OI walls: labels 10 bars right.
  const ois: [number, string, string, boolean][] = [
    [l.oiCall, C.oiCall, 'CALL OI WALL', oiCallMerged],
    [l.oiPut, C.oiPut, 'PUT OI WALL', oiPutMerged],
  ]
  if (m.show.oi) {
    for (const [p, col, name, merged] of ois) {
      // merged into the GEX wall label: the original leaves a blank marker here; skip it so it cannot cover that label
      if (Number.isFinite(p) && !merged) label(10, Y(p), `${name}  ${fmt(p)}`, col, C.ink, TINY)
    }
  }

  // 0DTE: labels 25 bars right.
  const zs: [number, string, number][] = [
    [l.z.call, '0DTE CALL  ', 8],
    [l.z.put, '0DTE PUT  ', 8],
    [l.z.zero, '0DTE 0γ  ', 4],
  ]
  if (m.show.zdte) {
    const zTag = m.meta?.zeroDteExpiry ? ` (${istDay(m.meta.zeroDteExpiry).trim()})` : ''
    zs.forEach(([p, name], i) => {
      if (Number.isFinite(p)) label(25, Y(p), name + fmt(p) + zTag, C.z[i], '#fff', SMALL)
    })
  }

  // Layout: a MAP zone right of the last candle. Pine places everything right of the last bar
  // (labels +0 / +10 / +25, heatmap +2…+32); here those columns use a fixed pixel step so the
  // zone keeps one size at any zoom, and the chart is asked to leave that much blank space
  // after the last candle (while it follows the live edge), so labels, heatmap and the thick
  // 0DTE bars never sit on candles. Across the candles only thin, faded level lines remain.
  // If the space isn't there (panned into history / very narrow chart) the zone slides left
  // just enough to stay on screen. Prices are untouched — only x positions change.
  const HEAT_END = 32
  const ZONE_STEP = Math.min(Math.max(rect.width * 0.1, 96), 160) / HEAT_END
  const widths = labels.map((lb) => labelWidth(g, lb.text, lb.font))
  // Pixel offset of each label from x0: its column (k bars), pushed right past any label of an
  // earlier column on the same row (e.g. a long merged "PUT WALL … MAX PAIN …" vs "0DTE PUT").
  const offsets = (s: number): number[] => {
    const off = labels.map((lb) => lb.k * s)
    const order = labels.map((_, i) => i).sort((a, b) => labels[a].k - labels[b].k)
    order.forEach((i, n) => {
      for (const j of order.slice(0, n)) {
        if (labels[j].k < labels[i].k && Math.abs(labels[j].y - labels[i].y) < 16) off[i] = Math.max(off[i], off[j] + widths[j] + 3)
      }
    })
    return off
  }
  const reach = (s: number): number => Math.max(m.show.heat ? HEAT_END * s : 0, ...offsets(s).map((o, i) => o + widths[i]))
  const room = right - 4
  const step = ZONE_STEP
  const span = reach(step)
  const gap = barW / 2 + 6 // clear of the last candle's body
  ctx.ensureRightGutter?.(gap + span + 8)
  let x0 = XB(0) + gap
  x0 = Math.max(left + 2, Math.min(x0, room - span))
  const X = (k: number): number => x0 + k * step
  const labelX = offsets(step).map((o) => x0 + o)

  // Level lines: thin + faded across the candles, full style inside the MAP zone.
  const FAINT = 0.35
  const level = (p: number, color: string, width: number, dash: number[], zoneEnd = right): void => {
    const y = Y(p)
    g.globalAlpha = FAINT
    hline(g, left, x0, y, color, 1, dash)
    g.globalAlpha = 1
    hline(g, x0, zoneEnd, y, color, width, dash)
  }
  if (m.show.gex) {
    levels.forEach((lv, i) => {
      if (Number.isFinite(lv.price)) level(lv.price, LEVEL_STYLE[i].line, LEVEL_STYLE[i].width, LEVEL_STYLE[i].dash)
    })
  }
  // OI walls: dashed.
  if (m.show.oi) {
    for (const [p, col] of ois) if (Number.isFinite(p)) level(p, col, 1, [6, 4])
  }
  // 0DTE call / put / 0γ: full-strength bands from the left edge to their labels (across the
  // candles too — they read as zones), unlike the faded GEX / OI lines above.
  if (m.show.zdte) {
    zs.forEach(([p, , w], i) => {
      if (!Number.isFinite(p)) return
      const li = labels.findIndex((lb) => lb.k === 25 && lb.y === Y(p))
      hline(g, left, li >= 0 ? labelX[li] : X(25), Y(p), C.z[i], w)
    })
  }
  // GEX heatmap: 4px bars from 2 bars right of price; length in bars (of the compressed step when squeezed).
  if (m.show.heat) {
    for (const h of l.heat) {
      if (Number.isFinite(h.strike)) hline(g, X(2), X(2 + h.len), Y(h.strike), h.sign > 0 ? C.heatPos : C.heatNeg, 4)
    }
  }

  labels.forEach((lb, i) => labelLeft(g, labelX[i], lb.y, lb.text, lb.bg, lb.fg, lb.font))

  // Status table.
  const s = mapStatus(l, last.close)
  const biasBg = s.biasSide === 1 ? C.cw : s.biasSide === -1 ? C.pw : s.posGamma ? 'rgba(129, 199, 132, 0.5)' : 'rgba(239, 154, 154, 0.5)'
  drawTable(g, rect, s.regime, s.bias, s.posGamma ? C.cw : '#FFB74D', biasBg, C.ink, m.stamp, m.action)
  g.restore()
}

/** Status-table colours for the 0DTE action row. */
const ACTION_BG: Record<MapAction['kind'], string> = {
  BUY: '#00C853',
  SELL: '#FF1744',
  WAIT: '#FFB300',
  'HOLD OFF': '#FB8C00',
  NONE: '#3a3a3a',
}

function drawTable(g: CanvasRenderingContext2D, rect: Rect, regime: string, bias: string, regBg: string, biasBg: string, fg: string, stamp: string, action: MapAction | null): void {
  const rows: [string, string, string][] = [
    ['REGIME', regime, regBg],
    ['DAY BIAS', bias, biasBg],
  ]
  if (action) rows.push(['0DTE ACTION', action.text, ACTION_BG[action.kind]])
  g.font = SMALL
  const c0 = Math.max(...rows.map((r) => g.measureText(r[0]).width)) + 12
  const c1 = Math.max(...rows.map((r) => g.measureText(r[1]).width)) + 12
  g.font = TINY
  const w = Math.max(c0 + c1, g.measureText(stamp).width + 12)
  const rh = 18
  const x = rect.x + rect.width - w - 8
  const h = (rows.length + 1) * rh
  let y = rect.y + rect.height - h - 24
  g.fillStyle = 'rgba(18, 18, 18, 0.95)'
  g.fillRect(x - 1, y - 1, w + 2, h + 2)
  g.textBaseline = 'middle'
  g.textAlign = 'center'
  for (const [k, v, bg] of rows) {
    g.font = SMALL
    g.fillStyle = C.cell
    g.fillRect(x, y, c0, rh - 1)
    g.fillStyle = C.txt2
    g.fillText(k, x + c0 / 2, y + rh / 2)
    g.fillStyle = bg
    g.fillRect(x + c0 + 1, y, w - c0 - 1, rh - 1)
    g.fillStyle = v === '—' ? C.txt2 : fg
    g.fillText(v, x + c0 + 1 + (w - c0 - 1) / 2, y + rh / 2)
    y += rh
  }
  g.font = TINY
  g.fillStyle = C.cell
  g.fillRect(x, y, w, rh - 1)
  g.fillStyle = C.txt2
  g.fillText(stamp, x + w / 2, y + rh / 2)
}
