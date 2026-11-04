// Shared helpers for canvas indicators (VWAP Angle, DC CPR BB): visible-range
// lookup, polyline / fill-between drawing of per-bar series, and a tiny memo
// so an unchanged chart never recomputes. Everything draws only the bars on
// screen (binary search for the first / last), so cost tracks the zoom level,
// not the loaded history.

import type { Candle } from '../../src/index'
import type { Converters } from '../../src/drawings/types'

export type Rect = { x: number; y: number; width: number; height: number }

export const DASHES: number[][] = [[], [6, 4], [1.5, 3]]

export function rgba(hex: string, a: number): string {
  const v = parseInt(hex.slice(1), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`
}

export const fmtPrice = (v: number): string => (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toPrecision(5))

/** Index range [from, to] of candles inside the pane (plus one bar each side, so lines reach the edges). */
export function visibleRange(candles: Candle[], conv: Converters, rect: Rect): [number, number] {
  const n = candles.length
  if (n === 0) return [0, -1]
  const t0 = conv.xToTime(rect.x)
  const t1 = conv.xToTime(rect.x + rect.width)
  const lo = Math.min(t0, t1)
  const hi = Math.max(t0, t1)
  const lower = (t: number): number => {
    let a = 0
    let b = n
    while (a < b) {
      const m = (a + b) >> 1
      if (candles[m].time < t) a = m + 1
      else b = m
    }
    return a
  }
  return [Math.max(0, lower(lo) - 1), Math.min(n - 1, lower(hi) + 1)]
}

/**
 * Stroke a per-bar series over [from, to]; NaN gaps and bars where
 * `breakAt[i]` is set start a new segment (Pine's plot.style_linebr).
 * `colorAt` (optional) re-colours per bar, starting a new segment on change.
 * `offset` shifts the plot right by that many bars (Pine's plot offset).
 */
export function strokeSeries(
  g: CanvasRenderingContext2D,
  conv: Converters,
  candles: Candle[],
  values: ArrayLike<number>,
  from: number,
  to: number,
  color: string,
  width: number,
  dash: number[],
  breakAt?: ArrayLike<number> | null,
  colorAt?: ((i: number) => string) | null,
  offset = 0,
): void {
  g.lineWidth = width
  g.setLineDash(dash)
  g.lineJoin = 'round'
  let open = false
  let cur = color
  g.strokeStyle = cur
  g.beginPath()
  for (let i = from; i <= to; i++) {
    const bi = i - offset
    const v = bi >= 0 ? values[bi] : NaN
    if (!Number.isFinite(v)) {
      if (open) g.stroke()
      open = false
      g.beginPath()
      continue
    }
    const x = conv.timeToX(candles[i].time)
    const y = conv.priceToY(v)
    const col = colorAt ? colorAt(bi) : color
    if (!open || (breakAt && breakAt[bi])) {
      if (open) g.stroke()
      g.beginPath()
      if (col !== cur) g.strokeStyle = cur = col
      g.moveTo(x, y)
      open = true
      continue
    }
    if (col !== cur) {
      g.lineTo(x, y)
      g.stroke()
      g.beginPath()
      g.strokeStyle = cur = col
      g.moveTo(x, y)
      continue
    }
    g.lineTo(x, y)
  }
  if (open) g.stroke()
  g.setLineDash([])
}

/** Fill between two per-bar series over [from, to], split at NaN gaps and `breakAt`. */
export function fillBetween(
  g: CanvasRenderingContext2D,
  conv: Converters,
  candles: Candle[],
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  from: number,
  to: number,
  fill: string,
  breakAt?: ArrayLike<number> | null,
  offset = 0,
): void {
  g.fillStyle = fill
  let seg: number[] = []
  const flush = (): void => {
    if (seg.length >= 2) {
      g.beginPath()
      for (let k = 0; k < seg.length; k++) {
        const i = seg[k]
        const x = conv.timeToX(candles[i].time)
        const y = conv.priceToY(a[i - offset])
        if (k === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      for (let k = seg.length - 1; k >= 0; k--) {
        const i = seg[k]
        g.lineTo(conv.timeToX(candles[i].time), conv.priceToY(b[i - offset]))
      }
      g.closePath()
      g.fill()
    }
    seg = []
  }
  for (let i = from; i <= to; i++) {
    const bi = i - offset
    if (bi < 0 || !Number.isFinite(a[bi]) || !Number.isFinite(b[bi])) {
      flush()
      continue
    }
    if (breakAt && breakAt[bi]) flush()
    seg.push(i)
  }
  flush()
}

/**
 * Last-result memo per chart (symbol|interval): compute() runs on every
 * throttled tick, but the model only changes when the bars or the settings
 * do — a repeat call returns the cached model in O(1).
 */
export function makeMemo<T>(limit = 8): (key: string, sig: string, fn: () => T) => T {
  const cache = new Map<string, { sig: string; value: T }>()
  return (key, sig, fn) => {
    const hit = cache.get(key)
    if (hit && hit.sig === sig) return hit.value
    const value = fn()
    cache.delete(key)
    cache.set(key, { sig, value })
    if (cache.size > limit) cache.delete(cache.keys().next().value as string)
    return value
  }
}

/** A cheap signature of the candle array + params: changes on any new bar or tick. */
export function candleSig(candles: Candle[], params: Record<string, number>): string {
  const n = candles.length
  if (n === 0) return '0'
  const f = candles[0]
  const l = candles[n - 1]
  let p = ''
  for (const k in params) p += `${k}=${params[k]};`
  return `${n}|${f.time}|${l.time}|${l.open}|${l.high}|${l.low}|${l.close}|${l.volume}|${p}`
}

/** Corner placement for an on-chart table: 0 top-right, 1 top-left, 2 bottom-right, 3 bottom-left. */
export function cornerXY(rect: Rect, w: number, h: number, corner: number, pad = 8, topInset = 30): [number, number] {
  const right = rect.x + rect.width - w - pad
  const left = rect.x + pad
  const top = rect.y + topInset
  const bottom = rect.y + rect.height - h - pad
  return corner === 1 ? [left, top] : corner === 2 ? [right, bottom] : corner === 3 ? [left, bottom] : [right, top]
}
