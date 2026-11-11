// "Sessions V2" — one volume profile per trading session (Asia / London / New York), each
// with its POC, VAH and VAL. Math: src/overlays/sessionProfileModel.ts. Drawn through the
// canvas-indicator hook (CanvasSource in custom-indicators.ts), built from the candles
// on the chart, so it follows ticks and bar replay.
//
// Session times and daylight saving follow the Sessions indicator (sessions.ts). Every
// option (sessions, colours, rows, value-area %, histogram, POC / VAH / VAL lines and
// labels, shading, line extension) is a parameter.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { SESSIONS_DEFAULTS } from '../../src/overlays/sessionsModel'
import { computeSessionProfiles, type SessionProfile, type SessionProfileOptions } from '../../src/overlays/sessionProfileModel'
import type { CanvasIndicatorContext } from './shankyCombo'
import { PALETTE, COL, colorOpts } from './flyingCpr'
import { DASHES, fmtPrice, rgba, type Rect } from './canvasPlot'

const D = SESSIONS_DEFAULTS
const CITY = ['Tokyo', 'London', 'New York']
const KEYS = ['asia', 'london', 'ny'] as const
const G_S = 'Sessions'
const G_P = 'Profile'
const G_POC = 'POC'
const G_VA = 'VAH / VAL'
const G_X = 'Display'

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min: number, max: number, step: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
const pick = (key: string, label: string, def: number, group: string, options: { value: number; label: string }[]): IndicatorParam => ({ key, label, default: def, group, options })
const halfHours = (city: string): { value: number; label: string }[] =>
  Array.from({ length: 48 }, (_, i) => ({ value: i * 30, label: `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'} ${city}` }))

const widthOpts = [1, 2, 3, 4, 5].map((w) => ({ value: w, label: `${w}px` }))
const styleOpts = [
  { value: 0, label: 'Solid' },
  { value: 1, label: 'Dashed' },
  { value: 2, label: 'Dotted' },
]
const extendOpts = [
  { value: 0, label: 'Session only' },
  { value: 1, label: 'Until the next session' },
  { value: 2, label: 'To the right edge' },
]
const sideOpts = [
  { value: 0, label: 'Left' },
  { value: 1, label: 'Right' },
]

const palette = (name: string, fallback: number): number => (COL as Record<string, number>)[name] ?? fallback
const SESSION_COLOR_DEFAULT = [palette('Purple', 0), palette('Blue', 0), palette('Teal', 0)]
const POC_COLOR_DEFAULT = palette('Orange', 0)

export const sessionsV2Indicator: IndicatorDef = {
  id: 'sessions_v2',
  label: 'Sessions V2: volume profile per session (POC / VAH / VAL)',
  shortLabel: 'Sessions V2',
  placement: 'overlay',
  params: [
    ...D.sessions.flatMap((s, i): IndicatorParam[] => {
      const group = `${s.name} (${CITY[i]} time, follows daylight saving)`
      return [
        toggle(`${KEYS[i]}On`, `Show ${s.name}`, s.enabled, group),
        { key: `${KEYS[i]}Start`, label: 'Start', default: s.start, group, options: halfHours(CITY[i]) },
        { key: `${KEYS[i]}End`, label: 'End', default: s.end, group, options: halfHours(CITY[i]) },
        pick(`${KEYS[i]}Color`, 'Colour', SESSION_COLOR_DEFAULT[i], group, colorOpts),
      ]
    }),
    toggle('weekdaysOnly', 'Weekdays only (skip Sat / Sun)', D.weekdaysOnly, G_S),
    num('rows', 'Price rows per profile', 24, G_P, 8, 100, 1),
    num('vaPct', 'Value area (% of session volume)', 70, G_P, 50, 95, 1),
    toggle('showHist', 'Volume histogram', true, G_P),
    pick('histSide', 'Histogram side', 1, G_P, sideOpts),
    num('histWidth', 'Histogram width (% of session width)', 40, G_P, 10, 100, 5),
    toggle('showPoc', 'Show POC', true, G_POC),
    pick('pocColor', 'POC colour', POC_COLOR_DEFAULT, G_POC, colorOpts),
    pick('pocWidth', 'POC width', 2, G_POC, widthOpts),
    pick('pocDash', 'POC style', 0, G_POC, styleOpts),
    toggle('showVa', 'Show VAH / VAL', true, G_VA),
    pick('vaWidth', 'VAH / VAL width', 1, G_VA, widthOpts),
    pick('vaDash', 'VAH / VAL style', 1, G_VA, styleOpts),
    toggle('showFill', 'Shade the value area', true, G_VA),
    num('fillPct', 'Value area shade (%)', 10, G_VA, 0, 50, 1),
    pick('extend', 'Extend lines', 0, G_X, extendOpts),
    toggle('showLabels', 'Price labels (POC / VAH / VAL)', true, G_X),
  ],
  compute: () => [],
}

export interface SessionsV2Model {
  profiles: SessionProfile[]
  /** Hex colour per session index (enabled or not). */
  sessionColor: string[]
  pocColor: string
  display: {
    hist: boolean
    histRight: boolean
    histWidth: number
    poc: boolean
    va: boolean
    fill: number
    pocWidth: number
    pocDash: number
    vaWidth: number
    vaDash: number
    extend: number
    labels: boolean
  }
}

const hexOf = (idx: number, fallback: string): string => (PALETTE[idx] ? PALETTE[idx][1] : fallback)

export function computeSessionsV2Model(candles: Candle[], p: Record<string, number>, _ctx: CanvasIndicatorContext): SessionsV2Model {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const sessions = D.sessions.map((s, i) => ({
    ...s,
    enabled: b(`${KEYS[i]}On`, s.enabled),
    start: n(`${KEYS[i]}Start`, s.start),
    end: n(`${KEYS[i]}End`, s.end),
  }))
  const opts: Partial<SessionProfileOptions> = {
    sessions,
    weekdaysOnly: b('weekdaysOnly', D.weekdaysOnly),
    rows: Math.round(n('rows', 24)),
    valueAreaPct: n('vaPct', 70),
  }
  return {
    profiles: computeSessionProfiles(candles, opts),
    sessionColor: KEYS.map((_, i) => hexOf(n(`${KEYS[i]}Color`, SESSION_COLOR_DEFAULT[i]), '#888888')),
    pocColor: hexOf(n('pocColor', POC_COLOR_DEFAULT), '#FF9800'),
    display: {
      hist: b('showHist', true),
      histRight: n('histSide', 1) >= 0.5,
      histWidth: n('histWidth', 40) / 100,
      poc: b('showPoc', true),
      va: b('showVa', true),
      fill: b('showFill', true) ? n('fillPct', 10) / 100 : 0,
      pocWidth: n('pocWidth', 2),
      pocDash: n('pocDash', 0),
      vaWidth: n('vaWidth', 1),
      vaDash: n('vaDash', 1),
      extend: n('extend', 0),
      labels: b('showLabels', true),
    },
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
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

export function drawSessionsV2(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: SessionsV2Model, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2 || model.profiles.length === 0) return
  const d = model.display
  const barW = Math.abs(conv.timeToX(candles[1].time) - conv.timeToX(candles[0].time)) || 6
  const X = (t: number): number => conv.timeToX(t)
  const Y = (v: number): number => conv.priceToY(v)
  const right = rect.x + rect.width
  const t0 = conv.xToTime(rect.x) - 1
  const t1 = conv.xToTime(right) + 1

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  const profiles = model.profiles
  for (let k = 0; k < profiles.length; k++) {
    const p = profiles[k]
    if (p.end < t0 || p.start > t1) continue
    const color = model.sessionColor[p.session] ?? '#888888'
    const xa = X(p.start) - barW / 2
    const xb = X(p.end) + barW / 2
    const next = profiles.slice(k + 1).find((q) => q.session === p.session)
    const xEnd = d.extend === 2 ? right : d.extend === 1 && next ? X(next.start) - barW / 2 : xb

    // value area shade
    if (d.fill > 0) {
      g.fillStyle = rgba(color, d.fill)
      g.fillRect(xa, Y(p.vah), xb - xa, Y(p.val) - Y(p.vah))
    }

    // histogram: one bar per row, width proportional to volume, inside the session's box
    if (d.hist) {
      const maxBin = Math.max(...p.bins, 1e-9)
      const maxW = (xb - xa) * d.histWidth
      for (let r = 0; r < p.bins.length; r++) {
        const v = p.bins[r]
        if (v <= 0) continue
        const top = Y(p.lo + (r + 1) * p.step)
        const bot = Y(p.lo + r * p.step)
        const w = (v / maxBin) * maxW
        const x = d.histRight ? xb - w : xa
        const inVa = r >= p.valRow && r <= p.vahRow
        g.fillStyle = rgba(color, inVa ? 0.55 : 0.22)
        g.fillRect(x, top, w, Math.max(1, bot - top - 1))
      }
    }

    // lines and labels
    if (d.va) {
      hline(g, xa, xEnd, Y(p.vah), rgba(color, 0.95), d.vaWidth, DASHES[d.vaDash] ?? [5, 4])
      hline(g, xa, xEnd, Y(p.val), rgba(color, 0.95), d.vaWidth, DASHES[d.vaDash] ?? [5, 4])
    }
    if (d.poc) hline(g, xa, xEnd, Y(p.poc), rgba(model.pocColor, 1), d.pocWidth, DASHES[d.pocDash] ?? [])
    if (d.labels && xEnd - xa > 40) {
      g.font = FONT
      g.textAlign = 'right'
      g.textBaseline = 'bottom'
      if (d.poc) {
        g.fillStyle = rgba(model.pocColor, 1)
        g.fillText(`POC ${fmtPrice(p.poc)}`, xEnd - 2, Y(p.poc) - 2)
      }
      if (d.va) {
        g.fillStyle = rgba(color, 1)
        g.fillText(`VAH ${fmtPrice(p.vah)}`, xEnd - 2, Y(p.vah) - 2)
        g.textBaseline = 'top'
        g.fillText(`VAL ${fmtPrice(p.val)}`, xEnd - 2, Y(p.val) + 2)
      }
    }
  }
  g.restore()
}
