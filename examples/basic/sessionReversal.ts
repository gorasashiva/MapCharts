// "Session Reversal → Expansion Tester" — port of "session reversal.pine" as an
// Indicators-menu entry. Math: src/overlays/sessionReversalModel.ts. Session
// shading, reversal labels, the open trade's stop / target, strategy-style
// entry / exit markers and the results table draw through the canvas-indicator
// hook (see CanvasSource in custom-indicators.ts). The model is bar-by-bar
// with no look-ahead, so bar replay (which hands it the clipped series) shows
// exactly what the script would at the replay cursor.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { SR_DEFAULTS, SR_NAMES, computeSessionReversal, type SrOptions, type SrResult } from '../../src/overlays/sessionReversalModel'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const G_S = 'Sessions (New York time)'
const G_R = 'Reversal definition'
const G_T = 'Measurement / trade'
const G_V = 'Visuals'
const SESS_KEYS = ['asia', 'london', 'nyam', 'nypm'] as const

const D = SR_DEFAULTS
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min: number, max: number, step: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
// Session pickers: every 15 minutes, New York time, valued in minutes of day.
const quarterHours = Array.from({ length: 96 }, (_, i) => ({ value: i * 15, label: `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}` }))
const sessTime = (key: string, label: string, def: number): IndicatorParam => ({ key, label, default: def, group: G_S, options: quarterHours })
/** YYYYMMDD <-> epoch ms (UTC midnight), for the "count from / until" inputs. */
const ymd = (t: number): number => {
  const d = new Date(t)
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
}
const fromYmd = (v: number): number => Date.UTC(Math.floor(v / 10000), (Math.floor(v / 100) % 100) - 1, v % 100)

export const sessionReversal: IndicatorDef = {
  id: 'session_reversal',
  label: 'Session Reversal → Expansion Tester',
  shortLabel: 'SessRevExp',
  placement: 'overlay',
  params: [
    ...SESS_KEYS.flatMap((k, i) => [sessTime(`${k}Start`, `${SR_NAMES[i]} start`, D.sessions[i][0]), sessTime(`${k}End`, `${SR_NAMES[i]} end`, D.sessions[i][1])]),
    toggle('needBody', 'Session must also close against its own open', D.needBody, G_R),
    num('rr', 'Target (R multiple)', D.rr, G_T, 0.5, 20, 0.5),
    num('avgLen', 'Average range lookback (same session type)', D.avgLen, G_T, 5, 500, 1),
    num('expThresh', "'Expanded' = range ≥ this × its average", D.expThresh, G_T, 0.1, 10, 0.1),
    num('fromYmd', 'Count from (YYYYMMDD)', ymd(D.from), G_T, 19700101, 20991231, 1),
    num('untilYmd', 'Count until (YYYYMMDD)', ymd(D.until), G_T, 19700101, 20991231, 1),
    toggle('showLabels', 'Label reversal swings', true, G_V),
    toggle('showBg', 'Shade sessions', true, G_V),
    toggle('showTrades', 'Trade entry / exit markers', true, G_V),
    toggle('showTable', 'Results table', true, G_V),
  ],
  compute: () => [],
}

interface Display {
  showLabels: boolean
  showBg: boolean
  showTrades: boolean
  showTable: boolean
}

export interface SessionReversalModel {
  opts: SrOptions
  display: Display
  result: SrResult
}

export function computeSessionReversalModel(candles: Candle[], p: Record<string, number>, _ctx: CanvasIndicatorContext): SessionReversalModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const opts: SrOptions = {
    sessions: SESS_KEYS.map((k, i) => [n(`${k}Start`, D.sessions[i][0]), n(`${k}End`, D.sessions[i][1])] as [number, number]),
    needBody: b('needBody', D.needBody),
    rr: n('rr', D.rr),
    avgLen: Math.max(1, Math.round(n('avgLen', D.avgLen))),
    expThresh: n('expThresh', D.expThresh),
    from: fromYmd(n('fromYmd', ymd(D.from))),
    until: fromYmd(n('untilYmd', ymd(D.until))),
  }
  return {
    opts,
    display: { showLabels: b('showLabels', true), showBg: b('showBg', true), showTrades: b('showTrades', true), showTable: b('showTable', true) },
    result: computeSessionReversal(candles, opts),
  }
}

// ---------------------------------------------------------------------------
// Drawing — Pine colours (color.new(c, 92) shading, teal / red labels, red stop, green target)
// ---------------------------------------------------------------------------
const SESS_BG = ['rgba(156, 39, 176, 0.08)', 'rgba(33, 150, 243, 0.08)', 'rgba(76, 175, 80, 0.08)', 'rgba(255, 152, 0, 0.08)']
const C = {
  bearLbl: 'rgba(242, 54, 69, 0.8)',
  bullLbl: 'rgba(8, 153, 129, 0.8)',
  stop: '#f23645',
  target: '#4caf50',
  long: '#2962ff',
  short: '#e040fb',
  white: '#ffffff',
  yellow: '#ffeb3b',
  lime: '#00e676',
  red: '#ff5252',
  aqua: '#00bcd4',
  silver: '#b2b5be',
  gray: '#787b86',
}
const TINY = "600 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const SMALL = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

export function drawSessionReversal(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: SessionReversalModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  const { opts: o, display: s, result: r } = model
  const barMs = candles[candles.length - 1].time - candles[candles.length - 2].time || 60_000
  const barW = Math.abs(conv.timeToX(candles[1].time) - conv.timeToX(candles[0].time)) || 6
  const t0 = conv.xToTime(rect.x) - barMs
  const t1 = conv.xToTime(rect.x + rect.width) + barMs
  const X = (t: number): number => conv.timeToX(t)
  const Y = (p: number): number => conv.priceToY(p)
  const vis = (a: number, b: number): boolean => b >= t0 && a <= t1

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  // bgcolor(): each session's bars shaded full height.
  if (s.showBg) {
    for (const sp of r.spans) {
      if (!vis(sp.t0, sp.t1)) continue
      g.fillStyle = SESS_BG[sp.sid]
      const xa = X(sp.t0) - barW / 2
      g.fillRect(xa, rect.y, X(sp.t1) + barW / 2 - xa, rect.height)
    }
  }

  // plot(inTrade ? stop / target : na, style_linebr): over the bars the trade was still open after.
  for (const t of r.trades) {
    if (t.plotEndTime === undefined || t.plotEndTime === t.entryTime || !vis(t.entryTime, t.plotEndTime)) continue
    for (const [p, col] of [
      [t.stop, C.stop],
      [t.target, C.target],
    ] as const) {
      g.strokeStyle = col
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(X(t.entryTime), Y(p))
      g.lineTo(X(t.plotEndTime), Y(p))
      g.stroke()
    }
  }

  // Strategy-style markers: entry arrow + side, exit tick + result in R.
  if (s.showTrades) {
    const byTime = new Map(candles.map((c) => [c.time, c]))
    g.font = TINY
    for (const t of r.trades) {
      if (!vis(t.entryTime, t.exitTime ?? t.entryTime)) continue
      const col = t.dir === 1 ? C.long : C.short
      const bar = byTime.get(t.entryTime)
      const xe = X(t.entryTime)
      const ye = t.dir === 1 ? Y(bar ? bar.low : t.entry) + 6 : Y(bar ? bar.high : t.entry) - 6
      g.fillStyle = col
      g.beginPath()
      g.moveTo(xe, ye)
      g.lineTo(xe - 5, ye + t.dir * 8)
      g.lineTo(xe + 5, ye + t.dir * 8)
      g.closePath()
      g.fill()
      g.textAlign = 'center'
      g.textBaseline = t.dir === 1 ? 'top' : 'bottom'
      g.fillText(t.dir === 1 ? 'Long' : 'Short', xe, ye + t.dir * 10)
      if (t.exitTime === undefined || t.exitPrice === undefined || t.r === undefined) continue
      const xx = X(t.exitTime)
      const yx = Y(t.exitPrice)
      g.strokeStyle = col
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(xx - 5, yx)
      g.lineTo(xx + 5, yx)
      g.stroke()
      g.fillStyle = t.r > 0 ? C.lime : C.red
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      g.fillText(`${t.r > 0 ? '+' : ''}${t.r.toFixed(2)}R${t.exitReason === 'Session end' ? ' · session end' : ''}`, xx + 8, yx)
    }
  }

  // label.new(... style_label_down / up, tiny): "▼ NY AM rev" over the swept high, "▲ … rev" under the low.
  if (s.showLabels) {
    g.font = TINY
    for (const rv of r.reversals) {
      if (!vis(rv.time, rv.time)) continue
      const text = `${rv.dir === -1 ? '▼' : '▲'} ${SR_NAMES[rv.sid]} rev`
      const x = X(rv.time)
      const y = Y(rv.price)
      const w = g.measureText(text).width + 8
      const h = 14
      const above = rv.dir === -1
      const top = above ? y - 6 - h : y + 6
      g.fillStyle = above ? C.bearLbl : C.bullLbl
      g.beginPath()
      g.roundRect(x - w / 2, top, w, h, 2)
      g.fill()
      g.beginPath()
      const py = above ? top + h : top
      g.moveTo(x - 4, py)
      g.lineTo(x + 4, py)
      g.lineTo(x, above ? py + 5 : py - 5)
      g.closePath()
      g.fill()
      g.fillStyle = C.white
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(text, x, top + h / 2 + 0.5)
    }
  }

  if (s.showTable) drawTable(g, rect, o, r)
  g.restore()
}

/** The script's results table (position.top_right). Reflects only the bars computed — i.e. up to the replay cursor. */
function drawTable(g: CanvasRenderingContext2D, rect: Rect, o: SrOptions, r: SrResult): void {
  const fmt = (x: number): string => (Number.isFinite(x) ? String(+x.toFixed(2)) : '–')
  const pct = (a: number, b: number): string => (b === 0 ? '–' : `${((100 * a) / b).toFixed(1)}%`)
  const rCol = (x: number): string => (x > 0 ? C.lime : C.red)
  type Cell = [string, string]
  const rows: Cell[][] = [['Reversal → next', 'Reversals', 'Expanded %', 'Avg range ×', 'Follow-thru %', 'Trades', 'Win %', 'Avg R', 'Total R'].map((h): Cell => [h, C.yellow])]
  const all = { n: 0, e: 0, d: 0, t: 0, w: 0, rat: 0, r: 0 }
  r.rows.forEach((row, i) => {
    all.n += row.reversals
    all.e += row.expHit
    all.d += row.dirHit
    all.t += row.trades
    all.w += row.wins
    all.rat += row.ratioSum
    all.r += row.totalR
    rows.push([
      [`${SR_NAMES[i]} → ${SR_NAMES[(i + 1) % 4]}`, C.white],
      [String(row.reversals), C.white],
      [pct(row.expHit, row.reversals), C.white],
      [row.reversals ? fmt(row.ratioSum / row.reversals) : '–', C.white],
      [pct(row.dirHit, row.reversals), C.white],
      [String(row.trades), C.white],
      [pct(row.wins, row.trades), C.white],
      [row.trades ? fmt(row.totalR / row.trades) : '–', rCol(row.totalR)],
      [fmt(row.totalR), rCol(row.totalR)],
    ])
  })
  rows.push([
    ['ALL reversals', C.aqua],
    [String(all.n), C.aqua],
    [pct(all.e, all.n), C.aqua],
    [all.n ? fmt(all.rat / all.n) : '–', C.aqua],
    [pct(all.d, all.n), C.aqua],
    [String(all.t), C.aqua],
    [pct(all.w, all.t), C.aqua],
    [all.t ? fmt(all.r / all.t) : '–', rCol(all.r)],
    [fmt(all.r), rCol(all.r)],
  ])
  const b = r.baseline
  rows.push([
    ['Baseline (no prior rev)', C.silver],
    [String(b.n), C.silver],
    [pct(b.expHit, b.n), C.silver],
    [b.n ? fmt(b.ratioSum / b.n) : '–', C.silver],
    ['50% = coin flip', C.silver],
    ['', C.silver],
    ['', C.silver],
    ['', C.silver],
    ['', C.silver],
  ])
  const footer = `Break-even win rate at ${fmt(o.rr)}R = ${fmt(100 / (1 + o.rr))}%  |  R figures exclude spread and fees`

  g.font = SMALL
  const pad = 6
  const rh = 18
  const colW = rows[0].map((_, c) => Math.max(...rows.map((row) => g.measureText(row[c][0]).width)) + pad * 2)
  const w = colW.reduce((a, x) => a + x, 0)
  const h = rh * (rows.length + 1)
  const x0 = rect.x + rect.width - w - 8
  const y0 = rect.y + 8
  g.fillStyle = 'rgba(0, 0, 0, 0.9)'
  g.fillRect(x0, y0, w, h)
  g.strokeStyle = 'rgba(120, 123, 134, 0.6)'
  g.lineWidth = 1
  g.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1)
  g.textBaseline = 'middle'
  rows.forEach((row, ri) => {
    let x = x0
    const y = y0 + ri * rh
    if (ri > 0) {
      g.beginPath()
      g.moveTo(x0, y + 0.5)
      g.lineTo(x0 + w, y + 0.5)
      g.stroke()
    }
    row.forEach(([text, col], ci) => {
      g.fillStyle = col
      g.textAlign = ci === 0 ? 'left' : 'center'
      g.fillText(text, ci === 0 ? x + pad : x + colW[ci] / 2, y + rh / 2)
      x += colW[ci]
    })
  })
  g.font = TINY
  g.fillStyle = C.gray
  g.textAlign = 'left'
  g.fillText(footer, x0 + pad, y0 + rows.length * rh + rh / 2)
}
