/**
 * Stateless canvas painting helpers. All coordinates are CSS pixels
 * (the engine applies the devicePixelRatio transform once per resize).
 */
import type { Candle } from '../core/types'
import type { IndicatorOutput } from '../indicators/types'
import type { ProjectionBand, ProjectionLine } from './types'
import type { KagiPoint } from './chartTransforms'
import type { ChartColors } from './themes'
import { FONT, SMALL_FONT } from './themes'
import type { PriceScale, TimeScale, TimeTick } from './scales'

/** Width of a candle body / volume bar for the given bar spacing, >= 1px. */
export function barBodyWidth(spacing: number): number {
  const byGap = Math.floor(spacing) - 1
  return Math.max(1, Math.min(Math.floor(spacing * 0.8), byGap > 0 ? byGap : 1))
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const v = parseInt(m[1], 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`
}

// ---------------------------------------------------------------------------
// Grid / chrome
// ---------------------------------------------------------------------------

export function drawVerticalGrid(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  ticks: TimeTick[],
  bottomY: number,
): void {
  ctx.fillStyle = colors.grid
  for (const t of ticks) {
    ctx.fillRect(Math.round(t.x), 0, 1, bottomY)
  }
}

export function drawHorizontalGrid(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  plotWidth: number,
  scale: PriceScale,
  tickValues: number[],
): void {
  ctx.fillStyle = colors.grid
  for (const v of tickValues) {
    ctx.fillRect(0, Math.round(scale.priceToY(v)), plotWidth, 1)
  }
}

export function drawSeparator(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  y: number,
  width: number,
): void {
  ctx.fillStyle = colors.separator
  ctx.fillRect(0, y, width, 1)
}

export function drawAxisLines(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  plotWidth: number,
  timeAxisTop: number,
  width: number,
  height: number,
): void {
  ctx.fillStyle = colors.axisLine
  ctx.fillRect(plotWidth, 0, 1, height)
  ctx.fillRect(0, timeAxisTop, width, 1)
}

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

/** Which parts of a candle to draw (Chart settings → Symbol). Omitted = all filled, the default look. */
export interface CandleParts {
  body: boolean
  border: boolean
  wick: boolean
}

export function drawCandles(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
  parts?: CandleParts,
): void {
  const spacing = ts.barSpacing()
  const bodyW = barBodyWidth(spacing)
  const wick = parts ? parts.wick : true
  const body = parts ? parts.body : true
  const border = parts ? parts.border : false
  if (border) ctx.lineWidth = 1
  for (let i = from; i <= to; i++) {
    const c = candles[i]
    const color = c.close >= c.open ? colors.up : colors.down
    const xc = ts.centerX(i)
    const xi = Math.round(xc)
    const yH = Math.round(scale.priceToY(c.high))
    const yL = Math.round(scale.priceToY(c.low))
    ctx.fillStyle = color
    // Wick (1px), then body on top.
    if (wick) ctx.fillRect(xi, yH, 1, Math.max(1, yL - yH))
    const yO = Math.round(scale.priceToY(c.open))
    const yC = Math.round(scale.priceToY(c.close))
    const x0 = Math.round(xc - bodyW / 2)
    const y0 = Math.min(yO, yC)
    const h = Math.max(1, Math.abs(yC - yO))
    if (body) ctx.fillRect(x0, y0, bodyW, h)
    if (border && bodyW >= 3) {
      ctx.strokeStyle = color
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, bodyW - 1, Math.max(0, h - 1))
    } else if (border && !body) {
      ctx.fillRect(x0, y0, bodyW, h) // too narrow for an outline: keep the bar visible
    }
  }
}

/**
 * Footprint chart type: a slim candle hugging the LEFT of each bar slot, so
 * the footprint overlay can print its per-price cells in the rest of the slot
 * (TradingView's volume-footprint layout).
 */
export function drawFootprintCandles(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  const spacing = ts.barSpacing()
  const bodyW = Math.max(1, Math.min(8, Math.round(spacing * 0.08)))
  for (let i = from; i <= to; i++) {
    const c = candles[i]
    ctx.fillStyle = c.close >= c.open ? colors.up : colors.down
    const xc = ts.centerX(i) - spacing * 0.38
    const yH = Math.round(scale.priceToY(c.high))
    const yL = Math.round(scale.priceToY(c.low))
    ctx.fillRect(Math.round(xc), yH, 1, Math.max(1, yL - yH))
    const yO = Math.round(scale.priceToY(c.open))
    const yC = Math.round(scale.priceToY(c.close))
    ctx.fillRect(Math.round(xc - bodyW / 2), Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yC - yO)))
  }
}

/**
 * Volume Candles: like drawCandles, but each candle's BODY WIDTH scales with
 * that bar's volume relative to the max volume in the visible [from, to] range
 * (thin on low volume, full body on the peak). The wick stays 1px and centered;
 * color follows up/down as usual. Falls back to full width when no bar in range
 * has positive volume.
 */
export function drawVolumeCandles(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  const spacing = ts.barSpacing()
  const fullW = barBodyWidth(spacing)
  let maxV = 0
  for (let i = from; i <= to; i++) {
    if (candles[i].volume > maxV) maxV = candles[i].volume
  }
  for (let i = from; i <= to; i++) {
    const c = candles[i]
    const color = c.close >= c.open ? colors.up : colors.down
    const xc = ts.centerX(i)
    const xi = Math.round(xc)
    const yH = Math.round(scale.priceToY(c.high))
    const yL = Math.round(scale.priceToY(c.low))
    ctx.fillStyle = color
    ctx.fillRect(xi, yH, 1, Math.max(1, yL - yH))
    // Body width scaled to volume share; clamp to >=1px so every bar stays visible.
    const ratio = maxV > 0 ? c.volume / maxV : 1
    const bodyW = Math.max(1, Math.round(fullW * ratio))
    const yO = Math.round(scale.priceToY(c.open))
    const yC = Math.round(scale.priceToY(c.close))
    ctx.fillRect(Math.round(xc - bodyW / 2), Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yC - yO)))
  }
}

export function drawBars(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  const spacing = ts.barSpacing()
  const tick = Math.max(1, Math.floor(barBodyWidth(spacing) / 2))
  for (let i = from; i <= to; i++) {
    const c = candles[i]
    const color = c.close >= c.open ? colors.up : colors.down
    const xi = Math.round(ts.centerX(i))
    const yH = Math.round(scale.priceToY(c.high))
    const yL = Math.round(scale.priceToY(c.low))
    ctx.fillStyle = color
    ctx.fillRect(xi, yH, 1, Math.max(1, yL - yH))
    // Open tick to the left, close tick to the right.
    ctx.fillRect(xi - tick, Math.round(scale.priceToY(c.open)), tick, 1)
    ctx.fillRect(xi + 1, Math.round(scale.priceToY(c.close)), tick, 1)
  }
}

function traceCloseLine(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
): void {
  // Extend one bar beyond the viewport on each side so lines reach the edges.
  const f = Math.max(0, from - 1)
  const t = Math.min(candles.length - 1, to + 1)
  ctx.beginPath()
  for (let i = f; i <= t; i++) {
    const x = ts.centerX(i)
    const y = scale.priceToY(candles[i].close)
    if (i === f) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
}

export function drawLineSeries(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  if (from > to) return
  traceCloseLine(ctx, candles, from, to, ts, scale)
  ctx.strokeStyle = colors.accent
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
}

export function drawAreaSeries(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  if (from > to) return
  const f = Math.max(0, from - 1)
  const t = Math.min(candles.length - 1, to + 1)
  // Gradient fill under the line.
  const grad = ctx.createLinearGradient(0, scale.top, 0, scale.bottom)
  grad.addColorStop(0, hexToRgba(colors.accent, 0.28))
  grad.addColorStop(1, hexToRgba(colors.accent, 0.02))
  traceCloseLine(ctx, candles, from, to, ts, scale)
  ctx.lineTo(ts.centerX(t), scale.bottom)
  ctx.lineTo(ts.centerX(f), scale.bottom)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()
  // Line on top.
  traceCloseLine(ctx, candles, from, to, ts, scale)
  ctx.strokeStyle = colors.accent
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
}

/**
 * HLC Area: a translucent BAND filled between the high and low series across the
 * viewport, plus a solid CLOSE line on top. The band/line tint by the LAST
 * visible bar's close vs the bar before it (up = accent/green, down = red),
 * matching the close-vs-prev-close convention used by the columns/last-price.
 */
export function drawHlcAreaSeries(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  if (from > to) return
  const f = Math.max(0, from - 1)
  const t = Math.min(candles.length - 1, to + 1)
  // Up/down tint from the last visible bar vs its predecessor.
  const lastIdx = Math.min(to, candles.length - 1)
  const prevClose = lastIdx > 0 ? candles[lastIdx - 1].close : candles[lastIdx].open
  const up = candles[lastIdx].close >= prevClose
  const tint = up ? colors.up : colors.down
  // Translucent band between the high path (forward) and the low path (back).
  ctx.beginPath()
  for (let i = f; i <= t; i++) {
    const x = ts.centerX(i)
    const y = scale.priceToY(candles[i].high)
    if (i === f) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  for (let i = t; i >= f; i--) {
    ctx.lineTo(ts.centerX(i), scale.priceToY(candles[i].low))
  }
  ctx.closePath()
  ctx.fillStyle = hexToRgba(tint, 0.16)
  ctx.fill()
  // Solid close line on top.
  ctx.beginPath()
  for (let i = f; i <= t; i++) {
    const x = ts.centerX(i)
    const y = scale.priceToY(candles[i].close)
    if (i === f) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = tint
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
}

/**
 * Hollow candles: wicks always drawn; the body is an OUTLINE (hollow) when the
 * candle closed up (close >= open) and a filled rectangle when it closed down.
 * Color still follows up/down. Same geometry as drawCandles otherwise.
 */
export function drawHollowCandles(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  const spacing = ts.barSpacing()
  const bodyW = barBodyWidth(spacing)
  for (let i = from; i <= to; i++) {
    const c = candles[i]
    const up = c.close >= c.open
    const color = up ? colors.up : colors.down
    const xc = ts.centerX(i)
    const xi = Math.round(xc)
    const yH = Math.round(scale.priceToY(c.high))
    const yL = Math.round(scale.priceToY(c.low))
    ctx.fillStyle = color
    ctx.fillRect(xi, yH, 1, Math.max(1, yL - yH))
    const yO = Math.round(scale.priceToY(c.open))
    const yC = Math.round(scale.priceToY(c.close))
    const bx = Math.round(xc - bodyW / 2)
    const top = Math.min(yO, yC)
    const h = Math.max(1, Math.abs(yC - yO))
    if (up) {
      // Hollow: stroke a 1px outline aligned to the pixel grid.
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.strokeRect(bx + 0.5, top + 0.5, Math.max(1, bodyW - 1), Math.max(1, h - 1))
    } else {
      ctx.fillRect(bx, top, bodyW, h)
    }
  }
}

/**
 * HLC bars: OHLC bars without the left (open) tick — only the high-low spine
 * and a right-side close tick. Color follows close vs open.
 */
export function drawHlcBars(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  const spacing = ts.barSpacing()
  const tick = Math.max(1, Math.floor(barBodyWidth(spacing) / 2))
  for (let i = from; i <= to; i++) {
    const c = candles[i]
    const color = c.close >= c.open ? colors.up : colors.down
    const xi = Math.round(ts.centerX(i))
    const yH = Math.round(scale.priceToY(c.high))
    const yL = Math.round(scale.priceToY(c.low))
    ctx.fillStyle = color
    ctx.fillRect(xi, yH, 1, Math.max(1, yL - yH))
    ctx.fillRect(xi + 1, Math.round(scale.priceToY(c.close)), tick, 1)
  }
}

/**
 * Close line with a small filled dot at each candle's close. Same path as
 * drawLineSeries, with markers on the visible bars.
 */
export function drawLineMarkers(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  if (from > to) return
  traceCloseLine(ctx, candles, from, to, ts, scale)
  ctx.strokeStyle = colors.accent
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
  ctx.fillStyle = colors.accent
  for (let i = from; i <= to; i++) {
    const x = ts.centerX(i)
    const y = scale.priceToY(candles[i].close)
    ctx.beginPath()
    ctx.arc(x, y, 2.5, 0, Math.PI * 2)
    ctx.fill()
  }
}

/**
 * Step line of closes: a horizontal segment across each bar at its close, with
 * vertical risers between bars. Stepped at bar centers.
 */
export function drawStepSeries(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  if (from > to) return
  const f = Math.max(0, from - 1)
  const t = Math.min(candles.length - 1, to + 1)
  ctx.beginPath()
  let prevY = scale.priceToY(candles[f].close)
  ctx.moveTo(ts.centerX(f), prevY)
  for (let i = f + 1; i <= t; i++) {
    const x = ts.centerX(i)
    const y = scale.priceToY(candles[i].close)
    ctx.lineTo(x, prevY) // horizontal to the new bar
    ctx.lineTo(x, y) // vertical riser to the new close
    prevY = y
  }
  ctx.strokeStyle = colors.accent
  ctx.lineWidth = 2
  ctx.lineJoin = 'miter'
  ctx.lineCap = 'butt'
  ctx.stroke()
}

/**
 * Baseline area: a two-color area split at `baseline` (the first visible
 * candle's close). Closes above the baseline fill+stroke green (up); below,
 * red (down). The line follows closes; fills run to the baseline y.
 */
export function drawBaselineSeries(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
  baseline: number,
): void {
  if (from > to) return
  const f = Math.max(0, from - 1)
  const t = Math.min(candles.length - 1, to + 1)
  const baseY = scale.priceToY(baseline)
  const traceCloses = (): void => {
    ctx.beginPath()
    for (let i = f; i <= t; i++) {
      const x = ts.centerX(i)
      const y = scale.priceToY(candles[i].close)
      if (i === f) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
  }
  const xf = ts.centerX(f)
  const xt = ts.centerX(t)
  // Upper fill (clipped to above the baseline).
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, scale.top, ts.plotWidth, Math.max(0, baseY - scale.top))
  ctx.clip()
  traceCloses()
  ctx.lineTo(xt, baseY)
  ctx.lineTo(xf, baseY)
  ctx.closePath()
  ctx.fillStyle = hexToRgba(colors.up, 0.2)
  ctx.fill()
  ctx.restore()
  // Lower fill (clipped to below the baseline).
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, baseY, ts.plotWidth, Math.max(0, scale.bottom - baseY))
  ctx.clip()
  traceCloses()
  ctx.lineTo(xt, baseY)
  ctx.lineTo(xf, baseY)
  ctx.closePath()
  ctx.fillStyle = hexToRgba(colors.down, 0.2)
  ctx.fill()
  ctx.restore()
  // Two-color line: green above the baseline, red below.
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, scale.top, ts.plotWidth, Math.max(0, baseY - scale.top))
  ctx.clip()
  traceCloses()
  ctx.strokeStyle = colors.up
  ctx.stroke()
  ctx.restore()
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, baseY, ts.plotWidth, Math.max(0, scale.bottom - baseY))
  ctx.clip()
  traceCloses()
  ctx.strokeStyle = colors.down
  ctx.stroke()
  ctx.restore()
}

/**
 * Columns: a vertical bar from a baseline up (or down) to each close, colored
 * up/down vs the PREVIOUS close. The baseline is the visible-range minimum
 * close clamped to the pane bottom, so columns read like a price histogram.
 */
export function drawColumnsSeries(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  const spacing = ts.barSpacing()
  const w = barBodyWidth(spacing)
  const baseY = scale.bottom // columns grow up from the pane bottom
  for (let i = from; i <= to; i++) {
    const c = candles[i]
    const prevClose = i > 0 ? candles[i - 1].close : c.open
    ctx.fillStyle = c.close >= prevClose ? colors.up : colors.down
    const y = Math.round(scale.priceToY(c.close))
    const top = Math.min(y, baseY)
    ctx.fillRect(Math.round(ts.centerX(i) - w / 2), top, w, Math.max(1, Math.round(baseY - top)))
  }
}

/**
 * High-Low: a single vertical high-low line per candle (no body, no ticks),
 * colored up/down vs open.
 */
export function drawHighLowSeries(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  for (let i = from; i <= to; i++) {
    const c = candles[i]
    ctx.fillStyle = c.close >= c.open ? colors.up : colors.down
    const xi = Math.round(ts.centerX(i))
    const yH = Math.round(scale.priceToY(c.high))
    const yL = Math.round(scale.priceToY(c.low))
    ctx.fillRect(xi, yH, 1, Math.max(1, yL - yH))
  }
}

// ---------------------------------------------------------------------------
// Re-binned synthetic series (Renko / Line Break / Kagi)
//
// These draw on the bar-INDEX axis: index `i` maps to the i-th synthetic
// element via ts.centerX(i). The caller passes the visible [from, to] integer
// range (already clamped to the synthetic array length).
// ---------------------------------------------------------------------------

/**
 * Renko / Line Break blocks: a filled rectangle per synthetic candle spanning
 * its open->close, colored up (close >= open) or down. Uses the bar slot width
 * so adjacent bricks butt together like classic Renko.
 */
export function drawBlockSeries(
  ctx: CanvasRenderingContext2D,
  blocks: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  const spacing = ts.barSpacing()
  const w = barBodyWidth(spacing)
  for (let i = from; i <= to; i++) {
    const b = blocks[i]
    const up = b.close >= b.open
    ctx.fillStyle = up ? colors.up : colors.down
    const yTop = Math.round(scale.priceToY(Math.max(b.open, b.close)))
    const yBot = Math.round(scale.priceToY(Math.min(b.open, b.close)))
    ctx.fillRect(Math.round(ts.centerX(i) - w / 2), yTop, w, Math.max(1, yBot - yTop))
  }
}

/**
 * Point & Figure columns. Each synthetic candle is one column spanning its
 * open..close price; this stacks X glyphs (rising columns, close >= open) or O
 * glyphs (falling columns) inside `boxSize`-tall boxes between low and high.
 * Drawn on the bar-INDEX axis like the block series; `boxSize` is the price
 * height of one box (so the number of glyphs per column is span / boxSize).
 */
export function drawPointAndFigure(
  ctx: CanvasRenderingContext2D,
  cols: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
  boxSize: number,
): void {
  if (!(boxSize > 0) || !isFinite(boxSize)) return
  const spacing = ts.barSpacing()
  const w = barBodyWidth(spacing)
  // Inset the glyph a touch inside its cell so adjacent columns don't touch.
  const r = Math.max(1.5, w / 2 - 1)
  ctx.save()
  ctx.lineWidth = Math.max(1.5, Math.min(2.5, w / 6))
  ctx.lineCap = 'round'
  for (let i = from; i <= to; i++) {
    const col = cols[i]
    const up = col.close >= col.open
    ctx.strokeStyle = up ? colors.up : colors.down
    const cx = ts.centerX(i)
    // Walk box by box from low to high; one glyph centered in each box.
    const boxes = Math.max(1, Math.round((col.high - col.low) / boxSize))
    for (let b = 0; b < boxes; b++) {
      const yTop = scale.priceToY(col.low + (b + 1) * boxSize)
      const yBot = scale.priceToY(col.low + b * boxSize)
      const cy = (yTop + yBot) / 2
      const half = Math.min(r, Math.abs(yBot - yTop) / 2 - 0.5)
      if (half <= 0.5) continue
      ctx.beginPath()
      if (up) {
        // X: two diagonals.
        ctx.moveTo(cx - half, cy - half)
        ctx.lineTo(cx + half, cy + half)
        ctx.moveTo(cx + half, cy - half)
        ctx.lineTo(cx - half, cy + half)
        ctx.stroke()
      } else {
        // O: a ring.
        ctx.arc(cx, cy, half, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
  }
  ctx.restore()
}

/**
 * Kagi line: a single continuous polyline through the vertices, with line
 * width switching between thick (yang) and thin (yin) per segment. Vertex `k`
 * sits at bar index `k` (center-x). Each segment's thickness is the thickness
 * stored on its END vertex. Drawn as discrete strokes so the width can change.
 */
export function drawKagiSeries(
  ctx: CanvasRenderingContext2D,
  pts: KagiPoint[],
  ts: TimeScale,
  scale: PriceScale,
  colors: ChartColors,
): void {
  if (pts.length < 2) return
  ctx.save()
  ctx.strokeStyle = colors.accent
  ctx.lineJoin = 'round'
  ctx.lineCap = 'butt'
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    ctx.lineWidth = b.thick ? 3 : 1
    ctx.beginPath()
    ctx.moveTo(ts.centerX(i - 1), scale.priceToY(a.price))
    // Kagi is orthogonal: vertical move to the new price at the same x, then a
    // horizontal hop to the next index. Render as an L so the line stays crisp.
    ctx.lineTo(ts.centerX(i - 1), scale.priceToY(b.price))
    ctx.lineTo(ts.centerX(i), scale.priceToY(b.price))
    ctx.stroke()
  }
  ctx.restore()
}

export function drawVolume(
  ctx: CanvasRenderingContext2D,
  candles: Candle[],
  from: number,
  to: number,
  ts: TimeScale,
  paneTop: number,
  paneHeight: number,
  heightRatio: number,
  colors: ChartColors,
  alpha = 0.45,
): void {
  let maxV = 0
  for (let i = from; i <= to; i++) {
    if (candles[i].volume > maxV) maxV = candles[i].volume
  }
  if (!(maxV > 0)) return
  const spacing = ts.barSpacing()
  const w = barBodyWidth(spacing)
  const volH = paneHeight * heightRatio
  const bottom = paneTop + paneHeight
  ctx.globalAlpha = alpha
  for (let i = from; i <= to; i++) {
    const c = candles[i]
    const h = Math.max(1, Math.round((c.volume / maxV) * volH))
    ctx.fillStyle = c.close >= c.open ? colors.up : colors.down
    ctx.fillRect(Math.round(ts.centerX(i) - w / 2), Math.round(bottom - h), w, h)
  }
  ctx.globalAlpha = 1
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

export function drawIndicatorOutput(
  ctx: CanvasRenderingContext2D,
  output: IndicatorOutput,
  from: number,
  to: number,
  ts: TimeScale,
  scale: PriceScale,
): void {
  const style = output.style ?? 'line'
  const last = Math.min(to, output.values.length - 1)
  const spacing = ts.barSpacing()
  if (style === 'histogram') {
    const w = Math.max(1, Math.floor(spacing * 0.6) || 1)
    // Baseline at value 0, clamped into the pane.
    const zero = Math.min(Math.max(scale.priceToY(0), scale.top), scale.bottom)
    ctx.fillStyle = output.color
    // At wide zoom-outs several bars land in one device pixel. Aggregate the
    // bucket into one envelope bar instead of issuing one fillRect per value.
    if (spacing > 0 && spacing < 1) {
      let bucket = Math.floor(ts.centerX(Math.max(0, from)))
      let min = Infinity
      let max = -Infinity
      const flush = (): void => {
        if (!isFinite(min) || !isFinite(max)) return
        const yMin = scale.priceToY(Math.min(0, min))
        const yMax = scale.priceToY(Math.max(0, max))
        ctx.fillRect(bucket, Math.round(Math.min(yMin, yMax)), 1, Math.max(1, Math.round(Math.abs(yMax - yMin))))
        min = Infinity
        max = -Infinity
      }
      for (let i = Math.max(0, from); i <= last; i++) {
        const b = Math.floor(ts.centerX(i))
        if (b !== bucket) {
          flush()
          bucket = b
        }
        const v = output.values[i]
        if (v == null || !isFinite(v)) continue
        if (v < min) min = v
        if (v > max) max = v
      }
      flush()
      return
    }
    for (let i = Math.max(0, from); i <= last; i++) {
      const v = output.values[i]
      if (v == null || !isFinite(v)) continue
      const y = scale.priceToY(v)
      ctx.fillRect(
        Math.round(ts.centerX(i) - w / 2),
        Math.round(Math.min(y, zero)),
        w,
        Math.max(1, Math.round(Math.abs(zero - y))),
      )
    }
    return
  }
  // Line plot, with breaks at null gaps (and at output.breaks, e.g. anchored VWAP resets).
  const f = Math.max(0, from - 1)
  const t = Math.min(output.values.length - 1, to + 1)
  const breaks = output.breaks && output.breaks.length ? new Set(output.breaks) : null
  ctx.beginPath()
  let started = false
  if (spacing > 0 && spacing < 1) {
    let bucket = -1
    let min = Infinity
    let max = -Infinity
    const flush = (): void => {
      if (!isFinite(min) || !isFinite(max)) return
      const x = bucket + 0.5
      const yMin = scale.priceToY(min)
      const yMax = scale.priceToY(max)
      if (!started) {
        ctx.moveTo(x, yMin)
        ctx.lineTo(x, yMax)
        started = true
      } else {
        ctx.lineTo(x, yMin)
        if (yMax !== yMin) ctx.lineTo(x, yMax)
      }
      min = Infinity
      max = -Infinity
    }
    for (let i = f; i <= t; i++) {
      const v = output.values[i]
      if (breaks?.has(i)) {
        flush()
        started = false
        bucket = -1
      }
      if (v == null || !isFinite(v)) {
        flush()
        started = false
        bucket = -1
        continue
      }
      const b = Math.floor(ts.centerX(i))
      if (bucket < 0) bucket = b
      else if (b !== bucket) {
        flush()
        bucket = b
      }
      if (v < min) min = v
      if (v > max) max = v
    }
    flush()
  } else {
    for (let i = f; i <= t; i++) {
      const v = output.values[i]
      if (breaks?.has(i)) started = false
      if (v == null || !isFinite(v)) {
        started = false
        continue
      }
      const x = ts.centerX(i)
      const y = scale.priceToY(v)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else {
        ctx.lineTo(x, y)
      }
    }
  }
  // Optional horizontal projection of the last value past the data edge.
  const lastV = output.values[output.values.length - 1]
  if (output.extendRight && started && t === output.values.length - 1 && lastV != null) {
    ctx.lineTo(ts.centerX(t + output.extendRight), scale.priceToY(lastV))
  }
  ctx.strokeStyle = output.color
  ctx.lineWidth = 1.5
  ctx.lineJoin = 'round'
  if (style === 'dashed') ctx.setLineDash([4, 3])
  ctx.stroke()
  if (style === 'dashed') ctx.setLineDash([])
}

// ---------------------------------------------------------------------------
// Projections (ghost paths sprouting rightward from the last candle)
// ---------------------------------------------------------------------------

/**
 * Draw the projection band + ghost polylines on the main pane. Each point is
 * anchored at bar index `lastIndex + barOffset` (center-x convention, same
 * extrapolation the time scale uses past the data edge). The caller is
 * responsible for clipping to the main pane. Band first, lines on top.
 */
export function drawProjections(
  ctx: CanvasRenderingContext2D,
  lines: ProjectionLine[],
  band: ProjectionBand | null,
  lastIndex: number,
  ts: TimeScale,
  scale: PriceScale,
): void {
  const xAt = (barOffset: number): number => ts.centerX(lastIndex + barOffset)
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  if (band && band.upper.length >= 2 && band.lower.length >= 2) {
    ctx.beginPath()
    for (let i = 0; i < band.upper.length; i++) {
      const p = band.upper[i]
      const x = xAt(p.barOffset)
      const y = scale.priceToY(p.price)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    // Walk the lower path backwards to close the band polygon.
    for (let i = band.lower.length - 1; i >= 0; i--) {
      const p = band.lower[i]
      ctx.lineTo(xAt(p.barOffset), scale.priceToY(p.price))
    }
    ctx.closePath()
    ctx.globalAlpha = Math.min(1, Math.max(0, band.opacity))
    ctx.fillStyle = band.color
    ctx.fill()
    ctx.globalAlpha = 1
  }

  for (const line of lines) {
    if (line.points.length < 2) continue
    ctx.beginPath()
    for (let i = 0; i < line.points.length; i++) {
      const p = line.points[i]
      const x = xAt(p.barOffset)
      const y = scale.priceToY(p.price)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.globalAlpha = Math.min(1, Math.max(0, line.opacity))
    ctx.strokeStyle = line.color
    ctx.lineWidth = line.width
    ctx.setLineDash(line.dashed ? [4, 3] : [])
    ctx.stroke()
  }

  ctx.restore()
}

// ---------------------------------------------------------------------------
// Price alerts
// ---------------------------------------------------------------------------

/** Geometry of an alert's right-axis affordance (bell + price tag), for hit-testing. */
export interface AlertTagRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Draw one price-alert line on the main pane: a dashed horizontal line across
 * the plot colored by direction, plus a bell glyph + price tag near the right
 * axis. Triggered alerts render muted. Returns the tag's rectangle (CSS px,
 * relative to the container) so the engine can hit-test clicks on it.
 */
export function drawAlertLine(
  ctx: CanvasRenderingContext2D,
  color: string,
  triggered: boolean,
  priceLabel: string,
  lineY: number,
  tagY: number,
  drawLine: boolean,
  plotWidth: number,
  axisWidth: number,
): AlertTagRect {
  const alpha = triggered ? 0.4 : 1
  ctx.save()
  ctx.globalAlpha = alpha
  if (drawLine) {
    // Dashed horizontal line across the plot.
    const yy = Math.round(lineY) + 0.5
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.moveTo(0, yy)
    ctx.lineTo(plotWidth, yy)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Bell glyph + price tag near the right axis.
  const h = 18
  const yc = Math.round(tagY)
  const bellW = 14
  const tagLeft = plotWidth + 1
  const tagWidth = axisWidth - 1
  // Filled tag background.
  ctx.fillStyle = color
  ctx.fillRect(tagLeft, yc - h / 2, tagWidth, h)
  // Bell glyph at the left of the tag.
  drawBellGlyph(ctx, tagLeft + bellW / 2 + 2, yc, '#ffffff')
  // Price label to the right of the bell.
  ctx.font = FONT
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(priceLabel, tagLeft + bellW + 4, yc + 0.5)
  ctx.restore()

  return { x: tagLeft, y: yc - h / 2, width: tagWidth, height: h }
}

/** A small bell icon centered at (cx, cy), ~10px tall, in the given color. */
function drawBellGlyph(ctx: CanvasRenderingContext2D, cx: number, cy: number, color: string): void {
  ctx.save()
  ctx.fillStyle = color
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.lineJoin = 'round'
  // Bell body: rounded dome over a flared base.
  ctx.beginPath()
  ctx.moveTo(cx, cy - 5) // top knob
  ctx.lineTo(cx, cy - 4)
  ctx.moveTo(cx - 3.5, cy + 2)
  ctx.quadraticCurveTo(cx - 3.5, cy - 4, cx, cy - 4)
  ctx.quadraticCurveTo(cx + 3.5, cy - 4, cx + 3.5, cy + 2)
  ctx.lineTo(cx - 3.5, cy + 2)
  ctx.closePath()
  ctx.fill()
  // Clapper.
  ctx.beginPath()
  ctx.arc(cx, cy + 3.2, 1, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** Dashed horizontal guide lines (e.g. RSI 30/70). */
export function drawGuideLines(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  plotWidth: number,
  scale: PriceScale,
  levels: number[],
): void {
  ctx.save()
  ctx.strokeStyle = colors.guide
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  for (const level of levels) {
    const y = Math.round(scale.priceToY(level)) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(plotWidth, y)
    ctx.stroke()
  }
  ctx.restore()
}

// ---------------------------------------------------------------------------
// Axes, tags, crosshair, legend
// ---------------------------------------------------------------------------

/**
 * The square "A" (auto/manual) toggle button at the top of the right price
 * axis. Filled with `accent` when the main scale is AUTO; an outlined square
 * with accent-colored glyph when MANUAL. `x`/`y`/`size` are the button's
 * top-left and side length (CSS px). The engine hit-tests clicks against the
 * same rect it passes here.
 */
export function drawAxisToggleButton(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  x: number,
  y: number,
  size: number,
  auto: boolean,
  label = 'A',
): void {
  ctx.save()
  const r = 3
  // Rounded-rect path for the button background / outline.
  const path = (): void => {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + size, y, x + size, y + size, r)
    ctx.arcTo(x + size, y + size, x, y + size, r)
    ctx.arcTo(x, y + size, x, y, r)
    ctx.arcTo(x, y, x + size, y, r)
    ctx.closePath()
  }
  if (auto) {
    path()
    ctx.fillStyle = colors.accent
    ctx.fill()
    ctx.fillStyle = '#ffffff'
  } else {
    path()
    ctx.fillStyle = colors.bg
    ctx.fill()
    ctx.strokeStyle = colors.accent
    ctx.lineWidth = 1
    // Inset the stroke onto the pixel grid for a crisp 1px outline.
    ctx.save()
    ctx.beginPath()
    ctx.rect(x + 0.5, y + 0.5, size - 1, size - 1)
    ctx.strokeStyle = colors.accent
    ctx.stroke()
    ctx.restore()
    ctx.fillStyle = colors.accent
  }
  ctx.font = FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + size / 2, y + size / 2 + 0.5)
  ctx.restore()
}

export function drawPriceAxisLabels(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  plotWidth: number,
  labels: { y: number; label: string }[],
): void {
  ctx.font = FONT
  ctx.fillStyle = colors.mutedText
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (const l of labels) {
    ctx.fillText(l.label, plotWidth + 7, l.y)
  }
}

export function drawTimeAxisLabels(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  labels: { x: number; label: string }[],
  centerY: number,
): void {
  ctx.font = FONT
  ctx.fillStyle = colors.mutedText
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const l of labels) {
    ctx.fillText(l.label, l.x, centerY)
  }
}

/** Filled rectangle with rounded corners (falls back to square where roundRect is missing). */
function fillRounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, r)
    ctx.fill()
  } else {
    ctx.fillRect(x, y, w, h)
  }
}

/** Filled tag on the price axis, vertically centered on `y`. */
export function drawPriceTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  y: number,
  plotWidth: number,
  axisWidth: number,
  bg: string,
  fg: string,
): void {
  const h = 18
  const yy = Math.round(y)
  ctx.fillStyle = bg
  fillRounded(ctx, plotWidth + 3, yy - h / 2, axisWidth - 6, h, 4)
  ctx.font = FONT
  ctx.fillStyle = fg
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, plotWidth + 7, yy + 0.5)
}

/** Small name chip just inside the plot's right edge, vertically centred on `y` (pairs with a price-axis tag). */
export function drawPlotEdgeChip(
  ctx: CanvasRenderingContext2D,
  text: string,
  y: number,
  plotWidth: number,
  bg: string,
  fg: string,
): void {
  ctx.font = SMALL_FONT
  const w = ctx.measureText(text).width + 10
  const h = 16
  const yy = Math.round(y)
  ctx.save()
  ctx.globalAlpha = 0.9
  ctx.fillStyle = bg
  ctx.fillRect(plotWidth - w - 2, yy - h / 2, w, h)
  ctx.globalAlpha = 1
  ctx.fillStyle = fg
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, plotWidth - 2 - w / 2, yy + 0.5)
  ctx.restore()
}

/**
 * Small neutral tag on the price axis showing the time left until the live
 * candle closes. Sits just under the last-price tag, centered in the axis
 * column, styled like the crosshair tags.
 */
export function drawCloseCountdown(
  ctx: CanvasRenderingContext2D,
  text: string,
  y: number,
  plotWidth: number,
  axisWidth: number,
  colors: ChartColors,
): void {
  const h = 15
  const yy = Math.round(y)
  ctx.fillStyle = colors.crosshairTagBg
  fillRounded(ctx, plotWidth + 3, yy - h / 2, axisWidth - 6, h, 4)
  ctx.font = SMALL_FONT
  ctx.fillStyle = colors.crosshairTagText
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, plotWidth + 1 + (axisWidth - 1) / 2, yy + 0.5)
}

/**
 * Last-price pill with the bar-close countdown on a second line (one tag, as
 * TradingView draws it), vertically centred on `y`. Returns its top / bottom.
 */
export function drawPriceCountdownTag(
  ctx: CanvasRenderingContext2D,
  price: string,
  countdown: string,
  y: number,
  plotWidth: number,
  axisWidth: number,
  bg: string,
  fg: string,
): { top: number; bottom: number } {
  const h = 30
  const top = Math.round(y) - 9 // the price line stays centred on the price
  ctx.fillStyle = bg
  fillRounded(ctx, plotWidth + 3, top, axisWidth - 6, h, 4)
  ctx.fillStyle = fg
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = FONT
  ctx.fillText(price, plotWidth + 7, top + 9.5)
  ctx.font = SMALL_FONT
  ctx.globalAlpha = 0.85
  ctx.fillText(countdown, plotWidth + 7, top + 21.5)
  ctx.globalAlpha = 1
  return { top, bottom: top + h }
}

/** Filled tag on the time axis, horizontally centered on `x` (clamped to the plot). */
export function drawTimeTag(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  text: string,
  x: number,
  plotWidth: number,
  timeAxisTop: number,
  timeAxisHeight: number,
): void {
  ctx.font = FONT
  const w = ctx.measureText(text).width + 14
  const left = Math.min(Math.max(x - w / 2, 0), Math.max(0, plotWidth - w))
  const h = 18
  const top = timeAxisTop + (timeAxisHeight - h) / 2 + 1
  ctx.fillStyle = colors.crosshairTagBg
  fillRounded(ctx, left, top, w, h, 4)
  ctx.fillStyle = colors.crosshairTagText
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, left + w / 2, top + h / 2 + 0.5)
}

/** Dotted last-price line across the plot. */
export function drawLastPriceLine(
  ctx: CanvasRenderingContext2D,
  color: string,
  y: number,
  plotWidth: number,
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.setLineDash([1.5, 3])
  ctx.beginPath()
  ctx.moveTo(0, y)
  ctx.lineTo(plotWidth, y)
  ctx.stroke()
  ctx.restore()
}

export function drawCrosshairVertical(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  x: number,
  bottomY: number,
  dash: number[] = [3, 3],
  color?: string,
): void {
  ctx.save()
  ctx.strokeStyle = color ?? colors.crosshair
  ctx.lineWidth = 1
  ctx.setLineDash(dash)
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, bottomY)
  ctx.stroke()
  ctx.restore()
}

export function drawCrosshairHorizontal(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  y: number,
  plotWidth: number,
  dash: number[] = [3, 3],
): void {
  ctx.save()
  ctx.strokeStyle = colors.crosshair
  ctx.lineWidth = 1
  ctx.setLineDash(dash)
  ctx.beginPath()
  ctx.moveTo(0, y)
  ctx.lineTo(plotWidth, y)
  ctx.stroke()
  ctx.restore()
}

/**
 * Small ring marking a magnet-snapped candidate point (drawn while placing a
 * drawing or dragging a handle with magnet mode on). Caller clips to the pane.
 */
export function drawMagnetRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(x, y, 5, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

export interface LegendSegment {
  text: string
  color: string
}

/** One legend row of colored segments. Returns the x after the last segment. */
export function drawLegendLine(
  ctx: CanvasRenderingContext2D,
  segments: LegendSegment[],
  x: number,
  y: number,
): number {
  ctx.font = FONT
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  let cx = x
  for (const seg of segments) {
    ctx.fillStyle = seg.color
    ctx.fillText(seg.text, cx, y)
    cx += ctx.measureText(seg.text).width + 8
  }
  return cx
}
