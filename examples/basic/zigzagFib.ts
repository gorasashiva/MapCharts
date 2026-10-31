// "Zigzag Fib Pullback" — Indicators-menu entry for the London 0.382 setup.
// Math: src/overlays/zigzagFibModel.ts. Draws through the canvas-indicator
// hook (see CanvasSource in custom-indicators.ts): session band, zigzag,
// risk / reward boxes per filled trade with one result pill at the exit, and
// Entry / SL / TP price tags only while the latest setup is pending or open.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { ZZFIB_DEFAULTS, computeZigzagFib, inZzFibSession, type ZzFibOptions, type ZzFibResult, type ZzFibSetup } from '../../src/overlays/zigzagFibModel'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = ZZFIB_DEFAULTS
const IST_OFFSET_H = 5.5
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
// Session pickers list every half hour, labelled in IST, valued in IST hours.
const halfHours = Array.from({ length: 48 }, (_, i) => {
  const h = i / 2
  return { value: h, label: `${String(Math.floor(h)).padStart(2, '0')}:${h % 1 ? '30' : '00'} IST` }
})
const toIST = (utc: number): number => (((utc + IST_OFFSET_H) % 24) + 24) % 24

const G_SETUP = 'Setup'
const G_SESSION = 'Session'
const G_SHOW = 'Display'

export const zigzagFib: IndicatorDef = {
  id: 'zigzag_fib',
  label: 'Zigzag Fib Pullback (London 0.382)',
  shortLabel: 'ZZ Fib',
  placement: 'overlay',
  params: [
    num('depth', 'Pivot depth (bars each side)', D.depth, G_SETUP, 1, 50, 1),
    num('minLegAtr', 'Min leg size (× ATR14)', D.minLegAtr, G_SETUP, 0, 20, 0.5),
    num('entryFib', 'Entry retracement', D.entryFib, G_SETUP, 0, 1, 0.001),
    num('stopFib', 'Stop (fib)', D.stopFib, G_SETUP, 0, 2, 0.01),
    num('targetFib', 'Target (fib, negative = extension)', D.targetFib, G_SETUP, -3, 1, 0.001),
    num('minStopBps', 'Min stop distance (bps)', D.minStopBps, G_SETUP, 0, 500, 1),
    num('maxHoldHours', 'Max hold (hours)', D.maxHoldHours, G_SETUP, 1, 240, 1),

    { key: 'sessionStart', label: 'Session start', default: toIST(D.sessionStartUTC), group: G_SESSION, options: halfHours },
    { key: 'sessionEnd', label: 'Session end (same as start = all day)', default: toIST(D.sessionEndUTC), group: G_SESSION, options: halfHours },
    toggle('weekdaysOnly', 'Weekdays only', D.weekdaysOnly, G_SESSION),

    toggle('showSession', 'Session band', true, G_SHOW),
    toggle('showZigzag', 'Zigzag', true, G_SHOW),
    toggle('showPending', 'Unfilled setups', true, G_SHOW),
    toggle('showTrades', 'Past trades', true, G_SHOW),
    toggle('showStats', 'Stats box', true, G_SHOW),
  ],
  compute: () => [],
}

interface Display {
  showSession: boolean
  showZigzag: boolean
  showPending: boolean
  showTrades: boolean
  showStats: boolean
}

export interface ZigzagFibModel {
  opts: ZzFibOptions
  display: Display
  result: ZzFibResult
}

export function computeZigzagFibModel(candles: Candle[], p: Record<string, number>, _ctx: CanvasIndicatorContext): ZigzagFibModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const toUTC = (ist: number): number => (((ist - IST_OFFSET_H) % 24) + 24) % 24
  const opts: ZzFibOptions = {
    ...D,
    depth: Math.max(1, Math.round(n('depth', D.depth))),
    minLegAtr: n('minLegAtr', D.minLegAtr),
    entryFib: n('entryFib', D.entryFib),
    stopFib: n('stopFib', D.stopFib),
    targetFib: n('targetFib', D.targetFib),
    minStopBps: n('minStopBps', D.minStopBps),
    maxHoldHours: n('maxHoldHours', D.maxHoldHours),
    sessionStartUTC: toUTC(n('sessionStart', toIST(D.sessionStartUTC))),
    sessionEndUTC: toUTC(n('sessionEnd', toIST(D.sessionEndUTC))),
    weekdaysOnly: b('weekdaysOnly', D.weekdaysOnly),
  }
  return {
    opts,
    display: {
      showSession: b('showSession', true),
      showZigzag: b('showZigzag', true),
      showPending: b('showPending', true),
      showTrades: b('showTrades', true),
      showStats: b('showStats', true),
    },
    result: computeZigzagFib(candles, opts),
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const C = {
  up: '#089981',
  down: '#f23645',
  accent: '#4361ee',
  muted: '#787b86',
  text: '#d1d4dc',
  zigzag: 'rgba(149, 152, 161, 0.45)',
  session: 'rgba(67, 97, 238, 0.07)',
  sessionText: 'rgba(120, 140, 255, 0.55)',
  reward: 'rgba(8, 153, 129, 0.14)',
  risk: 'rgba(242, 54, 69, 0.14)',
  pending: 'rgba(67, 97, 238, 0.7)',
  entryLine: 'rgba(209, 212, 220, 0.6)',
  statsBg: 'rgba(19, 23, 34, 0.88)',
}
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const SMALL = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

function seg(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width = 1, dash: number[] = []): void {
  g.strokeStyle = color
  g.lineWidth = width
  g.setLineDash(dash)
  g.beginPath()
  g.moveTo(x1, y1)
  g.lineTo(x2, y2)
  g.stroke()
  g.setLineDash([])
}

/** Rounded pill; `align` anchors x at its left / right edge. */
function pill(g: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, align: 'left' | 'right'): void {
  g.font = FONT
  const w = g.measureText(text).width + 10
  const h = 16
  const x0 = align === 'right' ? x - w : x
  g.fillStyle = bg
  g.beginPath()
  g.roundRect(x0, y - h / 2, w, h, 3)
  g.fill()
  g.fillStyle = '#fff'
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  g.fillText(text, x0 + 5, y + 0.5)
}

function fmtPrice(p: number): string {
  return p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p.toPrecision(5)
}

export function drawZigzagFib(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: ZigzagFibModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  const { opts: o, display: s, result: r } = model
  const t0 = conv.xToTime(rect.x)
  const t1 = conv.xToTime(rect.x + rect.width)
  const barW = Math.abs(conv.timeToX(candles[1].time) - conv.timeToX(candles[0].time)) || 6
  const X = (t: number): number => conv.timeToX(t)
  const Y = (p: number): number => conv.priceToY(p)
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  // ---- Session band ----
  if (s.showSession && o.sessionStartUTC !== o.sessionEndUTC) {
    const name = o.sessionStartUTC === 7 && o.sessionEndUTC === 12 ? 'London' : 'Session'
    let runStart = -1
    for (let i = 0; i <= candles.length; i++) {
      const c = candles[i]
      const on = !!c && c.time >= t0 - 86_400_000 && c.time <= t1 + 86_400_000 && inZzFibSession(c.time, o)
      if (on && runStart < 0) runStart = i
      if (!on && runStart >= 0) {
        const xa = X(candles[runStart].time) - barW / 2
        const xb = X(candles[i - 1].time) + barW / 2
        g.fillStyle = C.session
        g.fillRect(xa, rect.y, xb - xa, rect.height)
        g.fillStyle = C.sessionText
        g.font = FONT
        g.textAlign = 'left'
        g.textBaseline = 'alphabetic'
        g.fillText(name, xa + 4, bottom - 6)
        runStart = -1
      }
    }
  }

  // ---- Zigzag ----
  if (s.showZigzag && r.pivots.length > 1) {
    g.strokeStyle = C.zigzag
    g.lineWidth = 1
    g.beginPath()
    let pen = false
    for (let k = 0; k < r.pivots.length; k++) {
      const p = r.pivots[k]
      const nxt = r.pivots[k + 1]
      if (p.time > t1 && pen) {
        g.lineTo(X(p.time), Y(p.price))
        break
      }
      if (nxt && nxt.time < t0) continue
      if (pen) g.lineTo(X(p.time), Y(p.price))
      else g.moveTo(X(p.time), Y(p.price))
      pen = true
    }
    g.stroke()
  }

  // ---- Setups ----
  const latest = r.setups[r.setups.length - 1]
  const live = latest && (latest.status === 'pending' || latest.status === 'open') ? latest : undefined
  for (const st of r.setups) {
    const end = st.exitTime ?? (st.status === 'open' ? candles[candles.length - 1].time : st.pendingEndTime)
    if (end < t0 || st.legStart.time > t1) continue
    if (st.fillTime === undefined) {
      if (s.showPending || st === live) seg(g, X(st.armedTime), Y(st.entry), X(st.pendingEndTime), Y(st.entry), C.pending, 1, [4, 4])
      continue
    }
    if (!s.showTrades && st !== live) continue
    drawTrade(g, st, X, Y, X(candles[candles.length - 1].time), barW)
  }

  // ---- Live setup: price tags on the right edge ----
  if (live) {
    const tags: [string, number, string][] = [
      ['TP', live.target, C.up],
      ['Entry', live.entry, C.accent],
      ['SL', live.stop, C.down],
    ]
    for (const [label, price, col] of tags) pill(g, right - 2, Y(price), `${label} ${fmtPrice(price)}`, col, 'right')
  }

  // ---- Stats box (bottom-left; the pane legend owns the top-left) ----
  if (s.showStats) {
    const st = r.stats
    const fib = (f: number): string => String(+f.toFixed(3)).replace('-', '−')
    const head = `ZZ Fib · entry ${fib(o.entryFib)} · SL ${fib(o.stopFib)} · TP ${fib(o.targetFib)}`
    const body = st.trades
      ? `${st.trades} trades on loaded history · ${Math.round((st.wins / st.trades) * 100)}% win · ${st.avgR >= 0 ? '+' : ''}${st.avgR.toFixed(2)}R avg`
      : 'No closed trades on loaded history'
    g.font = FONT
    const w = Math.max(g.measureText(head).width, g.measureText(body).width) + 16
    const h = 36
    const x = rect.x + 8
    const y = bottom - h - 22
    g.fillStyle = C.statsBg
    g.beginPath()
    g.roundRect(x, y, w, h, 5)
    g.fill()
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
    g.fillStyle = C.text
    g.fillText(head, x + 8, y + 15)
    g.fillStyle = C.muted
    g.fillText(body, x + 8, y + 29)
  }

  g.restore()
}

function drawTrade(g: CanvasRenderingContext2D, st: ZzFibSetup, X: (t: number) => number, Y: (p: number) => number, lastX: number, barW: number): void {
  const d = st.dir
  const xf = X(st.fillTime!)
  const xe = Math.max(st.exitTime !== undefined ? X(st.exitTime) : lastX, xf + 2)
  const yE = Y(st.entry)
  const yS = Y(st.stop)
  const yT = Y(st.target)

  // The leg the fib is drawn on.
  seg(g, X(st.legStart.time), Y(st.legStart.price), X(st.legEnd.time), Y(st.legEnd.price), d === 1 ? 'rgba(8,153,129,.9)' : 'rgba(242,54,69,.9)', 1.5)
  // Working order from arming to fill.
  seg(g, X(st.armedTime), yE, xf, yE, C.pending, 1, [4, 4])
  // Reward / risk boxes.
  g.fillStyle = C.reward
  g.fillRect(xf, Math.min(yE, yT), xe - xf, Math.abs(yT - yE))
  g.fillStyle = C.risk
  g.fillRect(xf, Math.min(yE, yS), xe - xf, Math.abs(yS - yE))
  seg(g, xf, yE, xe, yE, C.entryLine)
  // Entry arrow just past the entry line.
  const ay = yE + (d === 1 ? 10 : -10)
  g.fillStyle = d === 1 ? C.up : C.down
  g.beginPath()
  g.moveTo(xf, ay + (d === 1 ? -5 : 5))
  g.lineTo(xf - 5, ay + (d === 1 ? 3 : -3))
  g.lineTo(xf + 5, ay + (d === 1 ? 3 : -3))
  g.closePath()
  g.fill()
  // Fib level ticks, small and muted, left of the box — only when zoomed in
  // enough that they don't land on top of the candles.
  if (barW >= 4) {
    const range = d * (st.legEnd.price - st.legStart.price)
    const fib = (price: number): string => String(+((st.legEnd.price - price) / range * d).toFixed(3)).replace('-', '−')
    g.font = SMALL
    g.fillStyle = C.muted
    g.textAlign = 'right'
    g.textBaseline = 'middle'
    for (const price of [st.entry, st.stop, st.target]) g.fillText(fib(price), xf - 4, Y(price))
  }
  // One result pill at the exit.
  if (st.r !== undefined) {
    const win = st.r > 0
    pill(g, xe + 3, win ? yT : yS, `${win ? '+' : ''}${st.r.toFixed(2)}R`, win ? C.up : C.down, 'left')
  }
}
