// "MTF CISD + MSS" — Indicators-menu entry ported from mtf.pine.
// Math: src/overlays/mtfCisdModel.ts. Draws through the canvas-indicator hook
// (see CanvasSource in custom-indicators.ts): chart-timeframe MSS / BOS / CISD
// lines with labels, liquidity sweeps ($), the latest higher-timeframe MSS /
// CISD levels extended past the last bar, and the multi-timeframe dashboard.
//
// Not ported: alert() calls (no alert hook for canvas indicators) and
// timeframes below the chart's — HTF data is resampled from the chart's own
// candles, so lower timeframes show "n/a" in the dashboard.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { INTERVAL_MS, type Interval } from '../../src/core/types'
import {
  MTF_CISD_DEFAULTS,
  MTF_CISD_TFS,
  TF_MONTH,
  TF_WEEK,
  computeMtfCisd,
  tfIsChart,
  type MtfCisdOptions,
  type MtfCisdResult,
  type TfResult,
} from '../../src/overlays/mtfCisdModel'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = MTF_CISD_DEFAULTS
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })

const TF_OPTIONS = [60, 180, 300, 900, 1800, 3600, 7200, 14_400, 86_400, TF_WEEK, TF_MONTH].map((v) => ({ value: v, label: tfLabel(v) }))
const POSITIONS = ['Top Right', 'Top Left', 'Bottom Right', 'Bottom Left', 'Middle Right']
const SIZES = ['Tiny', 'Small', 'Normal']

const G_S = 'Structure'
const G_F = 'CISD filter'
const G_C = 'Chart-timeframe drawings'
const G_T = 'Timeframes (dashboard)'
const G_D = 'Dashboard'
const G_H = 'Higher-timeframe levels on chart'
const G_L = 'Liquidity sweeps ($)'

export const mtfCisd: IndicatorDef = {
  id: 'mtf_cisd_mss',
  label: 'MTF CISD + MSS',
  shortLabel: 'CISD/MSS',
  placement: 'overlay',
  params: [
    toggle('autoTune', 'Auto-tune lengths to each timeframe', D.autoTune, G_S),
    num('pivLen', 'Swing length (MSS) — manual', D.pivLen, G_S, 1, 20, 1),
    toggle('showBos', 'Also mark BOS (continuation breaks)', false, G_S),

    num('cisdLook', 'New-extreme lookback (bars) — manual', D.cisdLook, G_F, 3, 200, 1),
    num('cisdAtr', 'Min run size (× ATR 14) — manual', D.cisdAtr, G_F, 0, 10, 0.1),

    toggle('showMss', 'Show MSS', true, G_C),
    toggle('showCisd', 'Show CISD', true, G_C),

    ...MTF_CISD_TFS.flatMap((tf, i): IndicatorParam[] => [
      toggle(`on${i + 1}`, `Timeframe ${i + 1}`, true, G_T),
      { key: `tf${i + 1}`, label: `Timeframe ${i + 1} value`, default: tf, options: TF_OPTIONS, group: G_T },
    ]),

    toggle('showTbl', 'Show dashboard', true, G_D),
    { key: 'tblPos', label: 'Position', default: 0, options: POSITIONS.map((label, value) => ({ value, label })), group: G_D },
    { key: 'tblSize', label: 'Text size', default: 1, options: SIZES.map((label, value) => ({ value, label })), group: G_D },
    toggle('hideLower', "Hide timeframes below the chart's", false, G_D),
    num('freshN', 'Mark as fresh (●) within N bars of its TF', 3, G_D, 1, 100, 1),

    toggle('drawHtfM', 'Draw latest HTF MSS levels', true, G_H),
    toggle('drawHtfC', 'Draw latest HTF CISD levels', false, G_H),
    num('extBars', 'Extend right (bars)', 15, G_H, 1, 200, 1),

    toggle('showSweep', 'Show liquidity sweeps', true, G_L),
    num('sweepLen', 'Liquidity swing length — manual', D.sweepLen, G_L, 1, 30, 1),
    num('sweepMax', 'Max untaken pools tracked per side', D.sweepMax, G_L, 1, 50, 1),
  ],
  compute: () => [],
}

interface Display {
  showBos: boolean
  showMss: boolean
  showCisd: boolean
  showSweep: boolean
  showTbl: boolean
  tblPos: number
  tblSize: number
  hideLower: boolean
  freshN: number
  drawHtfM: boolean
  drawHtfC: boolean
  extBars: number
}

export interface MtfCisdModel {
  display: Display
  /** Enabled flag per dashboard slot, parallel to result.tfs. */
  enabled: boolean[]
  result: MtfCisdResult
}

export function computeMtfCisdModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): MtfCisdModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const opts: MtfCisdOptions = {
    autoTune: b('autoTune', D.autoTune),
    pivLen: Math.max(1, Math.round(n('pivLen', D.pivLen))),
    cisdLook: Math.max(3, Math.round(n('cisdLook', D.cisdLook))),
    cisdAtr: Math.max(0, n('cisdAtr', D.cisdAtr)),
    sweepLen: Math.max(1, Math.round(n('sweepLen', D.sweepLen))),
    sweepMax: Math.max(1, Math.round(n('sweepMax', D.sweepMax))),
  }
  const tfs = MTF_CISD_TFS.map((d, i) => n(`tf${i + 1}`, d))
  const enabled = MTF_CISD_TFS.map((_, i) => b(`on${i + 1}`, true))
  const intervalMs = ctx.interval ? INTERVAL_MS[ctx.interval as Interval] : undefined
  return {
    display: {
      showBos: b('showBos', false),
      showMss: b('showMss', true),
      showCisd: b('showCisd', true),
      showSweep: b('showSweep', true),
      showTbl: b('showTbl', true),
      tblPos: n('tblPos', 0),
      tblSize: n('tblSize', 1),
      hideLower: b('hideLower', false),
      freshN: Math.max(1, n('freshN', 3)),
      drawHtfM: b('drawHtfM', true),
      drawHtfC: b('drawHtfC', false),
      extBars: Math.max(1, Math.round(n('extBars', 15))),
    },
    enabled,
    result: computeMtfCisd(candles, tfs, opts, intervalMs ? intervalMs / 1000 : undefined),
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const C = {
  mssBull: '#089981',
  mssBear: '#F23645',
  cisdBull: '#2962FF',
  cisdBear: '#FF9800',
  bos: '#787B86',
  bsl: '#F23645',
  ssl: '#089981',
  tblBg: 'rgba(19, 23, 34, 0.92)',
  tblHdr: '#2A2E39',
  tblBorder: '#363A45',
  text: '#D1D4DC',
  dim: '#787B86',
}
/** Pine max_lines_count: oldest chart-timeframe drawings drop off past this. */
const MAX_DRAWINGS = 500
const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

function tfLabel(s: number): string {
  if (s === TF_MONTH) return '1M'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}H`
  if (s < 604800) return `${Math.floor(s / 86400)}D`
  return `${Math.floor(s / 604800)}W`
}

function fmtPrice(p: number): string {
  return p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p.toPrecision(5)
}

function fmtAge(t: number): string {
  if (!Number.isFinite(t)) return '–'
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000))
  return sec < 3600 ? `${Math.floor(sec / 60)}m` : sec < 86400 ? `${Math.floor(sec / 3600)}h` : `${Math.floor(sec / 86400)}d`
}

function hline(g: CanvasRenderingContext2D, x1: number, x2: number, y: number, color: string, width: number, dash: number[]): void {
  g.strokeStyle = color
  g.lineWidth = width
  g.setLineDash(dash)
  g.beginPath()
  g.moveTo(x1, Math.round(y) + 0.5)
  g.lineTo(x2, Math.round(y) + 0.5)
  g.stroke()
  g.setLineDash([])
}

export function drawMtfCisd(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: MtfCisdModel, ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  const { display: s, result: r } = model
  const t0 = conv.xToTime(rect.x)
  const t1 = conv.xToTime(rect.x + rect.width)
  const X = (t: number): number => conv.timeToX(t)
  const Y = (p: number): number => conv.priceToY(p)
  const lastTime = candles[candles.length - 1].time

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  g.textAlign = 'center'

  // ---- Chart-timeframe events + sweeps (newest MAX_DRAWINGS, like Pine's line pool) ----
  type Mark = { level: number; originTime: number; time: number; text: string; color: string; up: boolean | null; dash: number[] }
  const marks: Mark[] = []
  for (const e of r.events) {
    if (e.kind === 'MSS' && !s.showMss) continue
    if (e.kind === 'BOS' && !s.showBos) continue
    if (e.kind === 'CISD' && !s.showCisd) continue
    const color = e.kind === 'BOS' ? C.bos : e.kind === 'MSS' ? (e.dir > 0 ? C.mssBull : C.mssBear) : e.dir > 0 ? C.cisdBull : C.cisdBear
    const dash = e.kind === 'MSS' ? [] : e.kind === 'BOS' ? [1, 3] : [5, 4]
    marks.push({ level: e.level, originTime: e.originTime, time: e.time, text: e.kind, color, up: e.dir > 0, dash })
  }
  if (s.showSweep) {
    for (const w of r.sweeps) marks.push({ level: w.level, originTime: w.originTime, time: w.time, text: '$', color: w.buySide ? C.bsl : C.ssl, up: null, dash: [1, 3] })
  }
  marks.sort((a, b) => a.time - b.time)
  for (const m of marks.slice(-MAX_DRAWINGS)) {
    if (m.time < t0 || m.originTime > t1) continue
    const xa = X(m.originTime)
    const xb = X(m.time)
    const y = Y(m.level)
    hline(g, xa, xb, y, m.color, 1, m.dash)
    g.fillStyle = m.color
    if (m.up === null) {
      g.font = `600 12px ${FONT_FAMILY}`
      g.textBaseline = 'middle'
      g.fillText(m.text, (xa + xb) / 2, y)
    } else {
      g.font = `600 10px ${FONT_FAMILY}`
      g.textBaseline = m.up ? 'bottom' : 'top'
      g.fillText(m.text, (xa + xb) / 2, m.up ? y - 2 : y + 2)
    }
  }

  // ---- Latest higher-timeframe levels, extended past the last bar ----
  if (s.drawHtfM || s.drawHtfC) {
    const x2 = X(lastTime + s.extBars * r.chartSec * 1000)
    // Several timeframes often share one level — draw it once with a merged label ("15m/1H MSS").
    type Level = { kind: string; level: number; ot: number; col: string; dash: number[]; tfs: string[] }
    const levels = new Map<string, Level>()
    r.tfs.forEach((tf, i) => {
      if (!model.enabled[i] || !tf.state || tf.tfSec <= r.chartSec || tfIsChart(tf.tfSec, r.chartSec)) return
      const st = tf.state
      const lv: [boolean, number, number, number, string, string, string, number[]][] = [
        [s.drawHtfM, st.mDir, st.mLvl, st.mOt, 'MSS', C.mssBull, C.mssBear, []],
        [s.drawHtfC, st.cDir, st.cLvl, st.cOt, 'CISD', C.cisdBull, C.cisdBear, [6, 4]],
      ]
      for (const [on, dir, level, ot, kind, up, dn, dash] of lv) {
        if (!on || dir === 0 || !Number.isFinite(level) || !Number.isFinite(ot)) continue
        const key = `${kind}:${dir}:${level}`
        const cur = levels.get(key)
        if (cur) {
          cur.tfs.push(tfLabel(tf.tfSec))
          cur.ot = Math.min(cur.ot, ot)
        } else levels.set(key, { kind, level, ot, col: dir > 0 ? up : dn, dash, tfs: [tfLabel(tf.tfSec)] })
      }
    })
    let labelW = 0
    g.font = `600 10px ${FONT_FAMILY}`
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    for (const l of levels.values()) {
      const y = Y(l.level)
      g.globalAlpha = 0.7
      hline(g, X(l.ot), x2, y, l.col, 2, l.dash)
      g.globalAlpha = 1
      const text = `${l.tfs.join('/')} ${l.kind}`
      g.fillStyle = l.col
      g.fillText(text, x2 + 4, y)
      labelW = Math.max(labelW, g.measureText(text).width)
    }
    if (labelW > 0) ctx.ensureRightGutter?.(Math.ceil(x2 - X(lastTime) + labelW + 12))
  }

  if (s.showTbl) drawDashboard(g, rect, model, ctx.symbol)
  g.restore()
}

function drawDashboard(g: CanvasRenderingContext2D, rect: Rect, model: MtfCisdModel, symbol: string): void {
  const { display: s, result: r } = model
  const fontPx = [9, 10, 12][s.tblSize] ?? 10
  const font = `${fontPx}px ${FONT_FAMILY}`
  const rowH = fontPx + 8
  const padX = 6

  type Cell = { text: string; color: string; bg?: string }
  const rows: Cell[][] = [
    [
      { text: symbol, color: C.text, bg: C.tblHdr },
      { text: 'MSS  (level · age)', color: C.text, bg: C.tblHdr },
      { text: 'CISD (level · age)', color: C.text, bg: C.tblHdr },
      { text: 'Bias', color: C.text, bg: C.tblHdr },
    ],
  ]

  const evtCell = (dir: number, lvl: number, t: number, tf: TfResult, up: string, dn: string): Cell => {
    const fresh = Number.isFinite(t) && Date.now() - t <= s.freshN * tf.tfSec * 1000
    const text = dir === 0 ? '–' : `${dir > 0 ? '▲' : '▼'} ${fmtPrice(lvl)}  ${fmtAge(t)}${fresh ? ' ●' : ''}`
    const color = dir > 0 ? up : dir < 0 ? dn : C.dim
    return { text, color, bg: fresh ? `${color}33` : undefined }
  }

  r.tfs.forEach((tf, i) => {
    if (!model.enabled[i]) return
    const below = !tf.available
    if (below && s.hideLower) return
    const isChart = tfIsChart(tf.tfSec, r.chartSec)
    const head: Cell = { text: `${tfLabel(tf.tfSec)}${isChart ? ' ◆' : ''}`, color: C.text, bg: C.tblHdr }
    if (below || !tf.state) {
      rows.push([head, { text: 'n/a (< chart TF)', color: C.dim }, { text: '', color: C.dim }, { text: '–', color: C.dim }])
      return
    }
    const st = tf.state
    let bias = '–'
    let bc = C.dim
    if (st.mDir !== 0 && st.mDir === st.cDir) {
      bias = st.mDir > 0 ? 'BULL' : 'BEAR'
      bc = st.mDir > 0 ? C.mssBull : C.mssBear
    } else if (st.mDir !== 0 && st.cDir !== 0) {
      if (st.cT > st.mT) {
        bias = st.cDir > 0 ? 'Shift ▲?' : 'Shift ▼?'
        bc = st.cDir > 0 ? C.cisdBull : C.cisdBear
      } else bias = 'Mixed'
    }
    rows.push([head, evtCell(st.mDir, st.mLvl, st.mT, tf, C.mssBull, C.mssBear), evtCell(st.cDir, st.cLvl, st.cT, tf, C.cisdBull, C.cisdBear), { text: bias, color: bc }])
  })

  g.font = font
  const colW = [0, 1, 2, 3].map((c) => Math.max(...rows.map((row) => g.measureText(row[c].text).width)) + padX * 2)
  const w = colW.reduce((a, b) => a + b, 0)
  const h = rows.length * rowH
  const m = 8
  const pos = POSITIONS[s.tblPos] ?? 'Top Right'
  const x0 = pos.endsWith('Left') ? rect.x + m : rect.x + rect.width - w - m
  // Top-left leaves room for the pane legend.
  const y0 = pos.startsWith('Bottom') ? rect.y + rect.height - h - m - 18 : pos.startsWith('Middle') ? rect.y + (rect.height - h) / 2 : rect.y + m + (pos === 'Top Left' ? 40 : 0)

  g.fillStyle = C.tblBg
  g.fillRect(x0, y0, w, h)
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  rows.forEach((row, ri) => {
    let x = x0
    row.forEach((cell, ci) => {
      const y = y0 + ri * rowH
      if (cell.bg) {
        g.fillStyle = cell.bg
        g.fillRect(x, y, colW[ci], rowH)
      }
      g.fillStyle = cell.color
      g.fillText(cell.text, x + padX, y + rowH / 2 + 0.5)
      x += colW[ci]
    })
  })
  // grid
  g.strokeStyle = C.tblBorder
  g.lineWidth = 1
  g.beginPath()
  for (let ri = 0; ri <= rows.length; ri++) {
    const y = Math.round(y0 + ri * rowH) + 0.5
    g.moveTo(x0, y)
    g.lineTo(x0 + w, y)
  }
  let gx = x0
  for (let ci = 0; ci <= 4; ci++) {
    const x = Math.round(gx) + 0.5
    g.moveTo(x, y0)
    g.lineTo(x, y0 + h)
    gx += colW[ci] ?? 0
  }
  g.stroke()
}
