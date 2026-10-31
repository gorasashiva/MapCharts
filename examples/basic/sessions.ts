// "Sessions" — Asia / London / New York session boxes (each in its own city's local
// time, so daylight saving moves them automatically) plus the previous 1H and 4H
// candle high / low. Math: src/overlays/sessionsModel.ts. Drawn through the
// canvas-indicator hook (see CanvasSource in custom-indicators.ts); computed from the
// candles on the chart only, so it follows ticks and bar replay.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { SESSIONS_DEFAULTS, computeSessions, type SessionsOptions, type SessionsResult } from '../../src/overlays/sessionsModel'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = SESSIONS_DEFAULTS
const CITY = ['Tokyo', 'London', 'New York']
const KEYS = ['asia', 'london', 'ny'] as const
const G_V = 'Display'
const G_P = 'Previous 1H / 4H high & low'

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const halfHours = (city: string): { value: number; label: string }[] =>
  Array.from({ length: 48 }, (_, i) => ({ value: i * 30, label: `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'} ${city}` }))

export const sessionsIndicator: IndicatorDef = {
  id: 'sessions',
  label: 'Sessions (Asia / London / New York) + prev 1H / 4H high-low',
  shortLabel: 'Sessions',
  placement: 'overlay',
  params: [
    ...D.sessions.flatMap((s, i): IndicatorParam[] => {
      const group = `${s.name} (${CITY[i]} time — follows daylight saving)`
      return [
        toggle(`${KEYS[i]}On`, `Show ${s.name}`, s.enabled, group),
        { key: `${KEYS[i]}Start`, label: 'Start', default: s.start, group, options: halfHours(CITY[i]) },
        { key: `${KEYS[i]}End`, label: 'End', default: s.end, group, options: halfHours(CITY[i]) },
      ]
    }),
    toggle('weekdaysOnly', 'Weekdays only (skip Sat / Sun)', D.weekdaysOnly, G_V),
    toggle('showFill', 'Shade session boxes', true, G_V),
    toggle('showLabels', 'Session name + range labels', true, G_V),
    toggle('show1h', 'Previous 1H high / low', true, G_P),
    toggle('show4h', 'Previous 4H high / low', true, G_P),
    toggle('showHistory', 'Show past levels (faint)', true, G_P),
    toggle('showTags', 'Price tags on the right edge', true, G_P),
  ],
  compute: () => [],
}

export interface SessionsModel {
  opts: SessionsOptions
  display: { fill: boolean; labels: boolean; show1h: boolean; show4h: boolean; history: boolean; tags: boolean }
  result: SessionsResult
}

export function computeSessionsModel(candles: Candle[], p: Record<string, number>, _ctx: CanvasIndicatorContext): SessionsModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const opts: SessionsOptions = {
    sessions: D.sessions.map((s, i) => ({ ...s, enabled: b(`${KEYS[i]}On`, s.enabled), start: n(`${KEYS[i]}Start`, s.start), end: n(`${KEYS[i]}End`, s.end) })),
    weekdaysOnly: b('weekdaysOnly', D.weekdaysOnly),
  }
  return {
    opts,
    display: { fill: b('showFill', true), labels: b('showLabels', true), show1h: b('show1h', true), show4h: b('show4h', true), history: b('showHistory', true), tags: b('showTags', true) },
    result: computeSessions(candles, opts),
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const SESSION_RGB = ['171, 71, 188', '41, 98, 255', '38, 166, 154'] // Asia purple, London blue, New York teal
const HI = '38, 166, 154'
const LO = '239, 83, 80'
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

function hline(g: CanvasRenderingContext2D, x0: number, x1: number, y: number, color: string, width: number, dash: number[]): void {
  g.strokeStyle = color
  g.lineWidth = width
  g.setLineDash(dash)
  g.beginPath()
  g.moveTo(x0, Math.round(y) + 0.5)
  g.lineTo(x1, Math.round(y) + 0.5)
  g.stroke()
  g.setLineDash([])
}

const fmtPrice = (p: number): string => (p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p.toPrecision(5))

export function drawSessions(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: SessionsModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  const { display: s, result: r } = model
  const barMs = candles[candles.length - 1].time - candles[candles.length - 2].time || 60_000
  const barW = Math.abs(conv.timeToX(candles[1].time) - conv.timeToX(candles[0].time)) || 6
  const t0 = conv.xToTime(rect.x) - barMs
  const t1 = conv.xToTime(rect.x + rect.width) + barMs
  const X = (t: number): number => conv.timeToX(t)
  const Y = (p: number): number => conv.priceToY(p)
  const right = rect.x + rect.width
  const lastT = candles[candles.length - 1].time

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  // ---- session boxes ----
  const labelRects: { x0: number; x1: number; y0: number; y1: number }[] = []
  for (const bx of r.boxes) {
    const end = bx.live ? Math.max(bx.scheduledEnd - barMs, bx.end) : bx.end
    if (end < t0 || bx.start > t1) continue
    const rgb = SESSION_RGB[bx.session] ?? '120, 123, 134'
    const xa = X(bx.start) - barW / 2
    const xb = X(end) + barW / 2
    const ya = Y(bx.high)
    const yb = Y(bx.low)
    if (s.fill) {
      g.fillStyle = `rgba(${rgb}, ${bx.live ? 0.12 : 0.08})`
      g.fillRect(xa, ya, xb - xa, yb - ya)
    }
    g.strokeStyle = `rgba(${rgb}, 0.7)`
    g.lineWidth = 1
    g.setLineDash(bx.live ? [4, 3] : [])
    g.strokeRect(Math.round(xa) + 0.5, Math.round(ya) + 0.5, Math.round(xb - xa), Math.round(yb - ya))
    g.setLineDash([])
    if (s.labels && xb - xa > 24) {
      g.font = FONT
      g.fillStyle = `rgba(${rgb}, 0.95)`
      g.textAlign = 'left'
      g.textBaseline = 'bottom'
      const range = bx.high - bx.low
      const text = `${bx.name}${xb - xa > 70 ? ` · $${range.toFixed(range >= 100 ? 0 : 1)}` : ''}`
      const w = g.measureText(text).width
      // above the box; below it instead when that would collide with an overlapping session's label
      let rect = { x0: xa + 3, x1: xa + 3 + w, y0: ya - 15, y1: ya - 3 }
      if (labelRects.some((o) => rect.x0 < o.x1 && o.x0 < rect.x1 && rect.y0 < o.y1 && o.y0 < rect.y1)) rect = { ...rect, y0: yb + 3, y1: yb + 15 }
      labelRects.push(rect)
      g.fillText(text, rect.x0, rect.y1)
    }
  }

  // ---- previous 1H / 4H high & low ----
  const tags: { y: number; text: string; color: string }[] = []
  const levels: [boolean, SessionsResult['prev1h'], string, number, number[]][] = [
    [s.show4h, r.prev4h, '4H', 1.5, []],
    [s.show1h, r.prev1h, '1H', 1, [5, 4]],
  ]
  for (const [on, segs, name, width, dash] of levels) {
    if (!on || !segs.length) continue
    const cur = segs[segs.length - 1]
    const isCurrent = cur.to === lastT
    if (s.history) {
      for (const sg of segs) {
        if ((sg === cur && isCurrent) || sg.to < t0 || sg.from > t1) continue
        const xa = X(sg.from) - barW / 2
        const xb = X(sg.to) + barW / 2
        hline(g, xa, xb, Y(sg.high), `rgba(${HI}, 0.35)`, 1, dash)
        hline(g, xa, xb, Y(sg.low), `rgba(${LO}, 0.35)`, 1, dash)
      }
    }
    if (isCurrent) {
      const xa = Math.max(rect.x, X(cur.from) - barW / 2)
      hline(g, xa, right, Y(cur.high), `rgba(${HI}, 0.95)`, width, dash)
      hline(g, xa, right, Y(cur.low), `rgba(${LO}, 0.95)`, width, dash)
      tags.push({ y: Y(cur.high), text: `${name} H ${fmtPrice(cur.high)}`, color: `rgb(${HI})` }, { y: Y(cur.low), text: `${name} L ${fmtPrice(cur.low)}`, color: `rgb(${LO})` })
    }
  }
  if (s.tags && tags.length) {
    // right-edge price tags, nudged apart so they never overlap
    tags.sort((a, b) => a.y - b.y)
    const h = 16
    for (let k = 1; k < tags.length; k++) if (tags[k].y - tags[k - 1].y < h + 1) tags[k].y = tags[k - 1].y + h + 1
    g.font = FONT
    for (const t of tags) {
      const w = g.measureText(t.text).width + 10
      g.fillStyle = t.color
      g.beginPath()
      g.roundRect(right - w - 2, t.y - h / 2, w, h, 3)
      g.fill()
      g.fillStyle = '#fff'
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      g.fillText(t.text, right - w + 3, t.y + 0.5)
    }
  }
  g.restore()
}
