/**
 * Trade plot shared by the strategy overlays (fvVwapEma.ts, ivFvStrategy.ts):
 * BUY / SELL labels, a TradingView-style position per trade — entry line, red
 * stop (stepping to breakeven once TP1 fills), TP1 / TP2 lines with light
 * reward / risk shading — optional exit markers, and price tags on the most
 * recent trade.
 */
import type { Converters } from '../drawings/types'

type Rect = { x: number; y: number; width: number; height: number }

/** The fields the plot reads from a trade. */
export interface PlotTrade {
  side: 'long' | 'short'
  entryTime: number
  entryPrice: number
  stop: number
  tp1: number | null
  tp1Time: number | null
  target: number | null
  exitTime: number | null
  exitPrice: number | null
  exitReason: string | null
  barHigh: number
  barLow: number
  grossR: number
  /** Signal label text; defaults to BUY / SELL. */
  label?: string
}

export interface TradePlotOptions {
  /** Time of the chart's last candle and the bar spacing (open trades extend a few bars past it). */
  lastTime: number
  barMs: number
  showSignals: boolean
  showLevels: boolean
  showExits: boolean
}

export const TRADE_COLORS = {
  buy: '#26a69a',
  sell: '#ef5350',
  end: '#9aa0a6',
  text: '#ffffff',
  entry: '#9aa0a6',
  sl: '#ef5350',
  tp1: '#80cbc4',
  tp2: '#26a69a',
}

const C = TRADE_COLORS
/** Below this many px per bar, labels shrink to arrows. */
const DENSE_BAR_PX = 6

function visible(x: number, rect: Rect, pad = 30): boolean {
  return x >= rect.x - pad && x <= rect.x + rect.width + pad
}

/** Draws every trade on screen, clipped to the main pane; the latest trade's price tags sit just right of it. */
export function drawTradePlot(ctx: CanvasRenderingContext2D, conv: Converters, rect: Rect, trades: PlotTrade[], o: TradePlotOptions): void {
  if (trades.length === 0) return
  const endX = (tr: PlotTrade): number => conv.timeToX(tr.exitTime ?? o.lastTime + 3 * o.barMs)
  ctx.save()
  ctx.beginPath()
  ctx.rect(rect.x, rect.y, rect.width, rect.height)
  ctx.clip()
  if (o.showLevels) drawLevels(ctx, conv, rect, trades, endX)
  if (o.showExits) drawExits(ctx, conv, rect, trades)
  if (o.showSignals) {
    const dense = conv.timeToX(o.lastTime) - conv.timeToX(o.lastTime - o.barMs) < DENSE_BAR_PX
    drawSignals(ctx, conv, rect, trades, dense)
  }
  ctx.restore()
  if (o.showLevels) drawLevelTags(ctx, conv, rect, trades[trades.length - 1], endX)
}

function drawLevels(ctx: CanvasRenderingContext2D, conv: Converters, rect: Rect, trades: PlotTrade[], endX: (t: PlotTrade) => number): void {
  for (const tr of trades) {
    const x0 = conv.timeToX(tr.entryTime)
    const x1 = Math.max(endX(tr), x0 + 8)
    if (x1 < rect.x || x0 > rect.x + rect.width) continue
    const y = (p: number): number => Math.round(conv.priceToY(p)) + 0.5
    const xTp1 = tr.tp1Time !== null ? conv.timeToX(tr.tp1Time) : null
    // Reward / risk shading between entry and the final level.
    const far = tr.target ?? tr.tp1
    ctx.globalAlpha = 0.08
    if (far !== null) {
      ctx.fillStyle = C.tp2
      ctx.fillRect(x0, Math.min(y(tr.entryPrice), y(far)), x1 - x0, Math.abs(y(far) - y(tr.entryPrice)))
    }
    ctx.fillStyle = C.sl
    ctx.fillRect(x0, Math.min(y(tr.entryPrice), y(tr.stop)), (xTp1 ?? x1) - x0, Math.abs(y(tr.stop) - y(tr.entryPrice)))
    ctx.globalAlpha = 1
    ctx.lineWidth = 1
    const seg = (price: number, a: number, b: number, color: string, dash: number[]): void => {
      ctx.strokeStyle = color
      ctx.setLineDash(dash)
      ctx.beginPath()
      ctx.moveTo(a, y(price))
      ctx.lineTo(b, y(price))
      ctx.stroke()
    }
    seg(tr.entryPrice, x0, x1, C.entry, [])
    if (xTp1 !== null) {
      seg(tr.stop, x0, xTp1, C.sl, [4, 3])
      seg(tr.entryPrice, xTp1, x1, C.sl, [4, 3]) // stop moved to breakeven
    } else seg(tr.stop, x0, x1, C.sl, [4, 3])
    if (tr.tp1 !== null) seg(tr.tp1, x0, xTp1 ?? x1, C.tp1, [4, 3])
    if (tr.target !== null) seg(tr.target, x0, x1, C.tp2, [4, 3])
  }
  ctx.setLineDash([])
}

/** "Entry / SL / TP1 / TP2" price tags at the right end of a trade. */
function drawLevelTags(ctx: CanvasRenderingContext2D, conv: Converters, rect: Rect, tr: PlotTrade, endX: (t: PlotTrade) => number): void {
  const x = endX(tr) + 4
  if (x < rect.x || x > rect.x + rect.width - 40) return
  const dp = tr.entryPrice >= 1000 ? 2 : 4
  const tags: [string, number, string][] = [
    ['Entry', tr.entryPrice, C.entry],
    [tr.tp1Time !== null ? 'SL → BE' : 'SL', tr.tp1Time !== null ? tr.entryPrice : tr.stop, C.sl],
  ]
  if (tr.tp1 !== null) tags.push(['TP1', tr.tp1, C.tp1])
  if (tr.target !== null) tags.push([tr.tp1 !== null ? 'TP2' : 'TP', tr.target, C.tp2])
  ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  // Keep tags from overlapping when levels sit close together.
  const placed: number[] = []
  for (const [name, price, color] of tags.sort((a, b) => conv.priceToY(a[1]) - conv.priceToY(b[1]))) {
    let ty = conv.priceToY(price)
    for (const py of placed) if (Math.abs(ty - py) < 15) ty = py + 15
    placed.push(ty)
    const text = `${name} ${price.toFixed(dp)}`
    const w = ctx.measureText(text).width + 8
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.roundRect(x, ty - 7, w, 14, 2)
    ctx.fill()
    ctx.fillStyle = name === 'TP1' ? '#0b1f1d' : C.text
    ctx.fillText(text, x + 4, ty + 0.5)
  }
}

function drawExits(ctx: CanvasRenderingContext2D, conv: Converters, rect: Rect, trades: PlotTrade[]): void {
  ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const tr of trades) {
    if (tr.exitTime === null || tr.exitPrice === null) continue
    const x = conv.timeToX(tr.exitTime)
    if (!visible(x, rect)) continue
    const y = conv.priceToY(tr.exitPrice)
    ctx.fillStyle = tr.exitReason === 'Day end' || tr.exitReason === 'BE' ? C.end : tr.grossR > 0 ? C.buy : C.sell
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillText(tr.exitReason === 'Day end' ? 'END' : (tr.exitReason ?? '').toUpperCase(), x, y - 9)
  }
}

function drawSignals(ctx: CanvasRenderingContext2D, conv: Converters, rect: Rect, trades: PlotTrade[], dense: boolean): void {
  ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const tr of trades) {
    const x = conv.timeToX(tr.entryTime)
    if (!visible(x, rect)) continue
    const buy = tr.side === 'long'
    const color = buy ? C.buy : C.sell
    const tipY = buy ? conv.priceToY(tr.barLow) + 6 : conv.priceToY(tr.barHigh) - 6
    if (dense) drawArrow(ctx, x, tipY, buy, color)
    else drawLabel(ctx, x, tipY, buy, tr.label ?? (buy ? 'BUY' : 'SELL'), color)
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, x: number, tipY: number, pointUp: boolean, color: string): void {
  const dy = pointUp ? 7 : -7
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x, tipY)
  ctx.lineTo(x - 4, tipY + dy)
  ctx.lineTo(x + 4, tipY + dy)
  ctx.closePath()
  ctx.fill()
}

/** TradingView-style label: below the bar pointing up for BUY, above pointing down for SELL. */
function drawLabel(ctx: CanvasRenderingContext2D, x: number, tipY: number, pointUp: boolean, text: string, color: string): void {
  const w = ctx.measureText(text).width + 10
  const h = 16
  const arrow = 5
  const boxY = pointUp ? tipY + arrow : tipY - arrow - h
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x, tipY)
  ctx.lineTo(x - arrow, pointUp ? tipY + arrow : tipY - arrow)
  ctx.lineTo(x + arrow, pointUp ? tipY + arrow : tipY - arrow)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.roundRect(x - w / 2, boxY, w, h, 3)
  ctx.fill()
  ctx.fillStyle = C.text
  ctx.fillText(text, x, boxY + h / 2 + 0.5)
}
