// "Renko Exhaustion Fade" — strategy from the XAUTUSD / PAXGUSD Renko research,
// as an Indicators-menu entry. Math: src/overlays/renkoFadeModel.ts (no look-ahead).
// While it's on, a Renko chart uses the strategy's box size, so the bricks on
// screen are exactly the bricks it trades. Draws each trade's signal arrow, an
// entry label, target / stop lines with their prices, risk / reward boxes and an
// exit tag with the result; Entry / TP / SL tags on the right edge while a trade
// is open or pending. Trades feed the Strategy Tester (CanvasSource.strategy).

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import type { StrategyTrade } from '../../src/strategy/types'
import { autoRenkoBoxSize } from '../../src/chart/chartTransforms'
import { RENKO_FADE_DEFAULTS, computeRenkoFade, type RenkoFadeOptions, type RenkoFadeResult, type RenkoFadeTrade } from '../../src/overlays/renkoFadeModel'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = RENKO_FADE_DEFAULTS
const G_R = 'Renko'
const G_X = 'Entry / exit'
const G_P = 'Properties'
const G_V = 'Display'

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min: number, max: number, step: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })

export const renkoFade: IndicatorDef = {
  id: 'renko_exhaustion_fade',
  label: 'Renko Exhaustion Fade',
  shortLabel: 'Renko Fade',
  placement: 'overlay',
  params: [
    num('box', 'Box size (price, 0 = auto ATR)', D.box, G_R, 0, 100_000, 0.5),
    num('minRun', 'Fade after a run of N bricks', D.minRun, G_R, 2, 50, 1),

    num('targetBoxes', 'Take profit (boxes)', D.targetBoxes, G_X, 1, 20, 1),
    num('stopBoxes', 'Stop loss (boxes)', D.stopBoxes, G_X, 1, 20, 1),
    { key: 'direction', label: 'Direction', default: 0, group: G_X, options: [{ value: 0, label: 'Both' }, { value: 1, label: 'Long only' }, { value: 2, label: 'Short only' }] },
    toggle('skipWeekends', 'No weekend trades (flat at Friday close)', D.skipWeekends, G_X),

    num('qty', 'Order size (units)', D.qty, G_P, 0.001, 1e6, 0.1),

    toggle('showTrades', 'Past trades', true, G_V),
    toggle('showLabels', 'Entry / TP / SL / exit labels', true, G_V),
    toggle('showStats', 'Stats box', true, G_V),
  ],
  compute: () => [],
}

export interface RenkoFadeModel {
  opts: RenkoFadeOptions
  /** Box size the chart's Renko bricks should use while this strategy is on (null = chart auto). */
  renkoBox: number | null
  display: { showTrades: boolean; showLabels: boolean; showStats: boolean }
  interval: string
  result: RenkoFadeResult
}

export function computeRenkoFadeModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): RenkoFadeModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const fixed = n('box', D.box)
  // Auto box: the chart's own bricks when it's a Renko chart, else the same ATR rule it would use.
  const box = fixed > 0 ? fixed : ctx.renkoBox && ctx.renkoBox > 0 ? ctx.renkoBox : autoRenkoBoxSize(candles)
  const opts: RenkoFadeOptions = {
    box,
    minRun: Math.max(1, Math.round(n('minRun', D.minRun))),
    targetBoxes: Math.max(1, n('targetBoxes', D.targetBoxes)),
    stopBoxes: Math.max(1, n('stopBoxes', D.stopBoxes)),
    direction: (['both', 'long', 'short'] as const)[n('direction', 0)] ?? 'both',
    skipWeekends: b('skipWeekends', D.skipWeekends),
    qty: n('qty', D.qty),
  }
  return {
    opts,
    renkoBox: fixed > 0 ? fixed : null,
    display: { showTrades: b('showTrades', true), showLabels: b('showLabels', true), showStats: b('showStats', true) },
    interval: ctx.interval ?? '',
    result: computeRenkoFade(candles, opts),
  }
}

/** Trades in the Strategy Tester's shape (open trade: exitTime null). */
export function renkoFadeTrades(model: unknown): StrategyTrade[] {
  return (model as RenkoFadeModel).result.trades.map((t) => ({
    side: t.dir === 1 ? 'long' : 'short',
    entryTime: t.entryTime,
    entryPrice: t.entryPrice,
    exitTime: t.exitTime,
    exitPrice: t.exitPrice,
    exitReason: t.exitReason === 'Weekend' ? 'Weekend close' : (t.exitReason ?? undefined),
    stop: t.stop,
    qty: t.qty,
  }))
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const C = {
  up: '#089981',
  down: '#f23645',
  accent: '#4361ee',
  muted: '#787b86',
  weekend: '#5d606b',
  text: '#d1d4dc',
  reward: 'rgba(8, 153, 129, 0.13)',
  risk: 'rgba(242, 54, 69, 0.13)',
  entry: 'rgba(209, 212, 220, 0.75)',
  statsBg: 'rgba(19, 23, 34, 0.88)',
}
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

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

/** Price tag in the label column left of a trade: coloured text on a dark chip. */
function tag(g: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
  g.font = FONT
  const w = g.measureText(text).width + 8
  g.fillStyle = C.statsBg
  g.beginPath()
  g.roundRect(x - w, y - 7, w, 14, 3)
  g.fill()
  g.fillStyle = color
  g.textAlign = 'right'
  g.textBaseline = 'middle'
  g.fillText(text, x - 4, y + 0.5)
}

function hline(g: CanvasRenderingContext2D, x0: number, x1: number, y: number, color: string, width = 1, dash: number[] = []): void {
  g.strokeStyle = color
  g.lineWidth = width
  g.setLineDash(dash)
  g.beginPath()
  g.moveTo(x0, y)
  g.lineTo(x1, y)
  g.stroke()
  g.setLineDash([])
}

/** dir 1: ▲ below a bar pointing up; dir -1: ▼ above a bar pointing down. */
function arrow(g: CanvasRenderingContext2D, x: number, y: number, dir: 1 | -1, color: string): void {
  g.fillStyle = color
  g.beginPath()
  g.moveTo(x, y)
  g.lineTo(x - 5, y + dir * 8)
  g.lineTo(x + 5, y + dir * 8)
  g.closePath()
  g.fill()
}

const fmtPrice = (p: number): string => (p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p.toPrecision(5))
const fmtPnl = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v) >= 100 ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(2)}`

export function drawRenkoFade(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: RenkoFadeModel, ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  const { opts: o, display: s, result: r } = model
  // On a Renko chart the x axis is bricks (several can share one candle time), so
  // trades are placed by brick index — but only when the chart draws the same bricks.
  const bx = ctx.chartType === 'renko' && Math.abs((ctx.renkoBox ?? 0) - o.box) < 1e-9 ? ctx.barX : undefined
  const byTime = new Map(candles.map((c) => [c.time, c]))
  const lastBrick = r.bricks.length - 1
  const lastT = candles[candles.length - 1].time
  const xEntry = (t: RenkoFadeTrade): number => (bx ? bx(t.entryBrick) : conv.timeToX(t.entryTime))
  const xExit = (t: RenkoFadeTrade): number => (bx ? bx(t.exitBrick ?? lastBrick) : conv.timeToX(t.exitTime ?? lastT))
  const xSignal = (t: RenkoFadeTrade): number => (bx ? bx(t.signalBrick) : conv.timeToX(t.signalTime))
  const Y = (p: number): number => conv.priceToY(p)
  // Bar spacing decides how much text fits.
  const step = bx ? Math.abs(bx(1) - bx(0)) : Math.abs(conv.timeToX(candles[1].time) - conv.timeToX(candles[0].time))
  const roomy = s.showLabels && step >= 4
  const x0 = rect.x - 160
  const x1 = rect.x + rect.width + 160

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  const open = r.trades.find((t) => t.exitTime === null) ?? null
  for (const t of r.trades) {
    if (!s.showTrades && t !== open) continue
    const xa = xEntry(t)
    const xb = Math.max(xExit(t), xa + 2)
    if (xb < x0 || xa > x1) continue
    const yE = Y(t.entryPrice)
    const yT = Y(t.target)
    const yS = Y(t.stop)
    const long = t.dir === 1

    // Risk / reward boxes and the three levels.
    g.fillStyle = C.reward
    g.fillRect(xa, Math.min(yE, yT), xb - xa, Math.abs(yT - yE))
    g.fillStyle = C.risk
    g.fillRect(xa, Math.min(yE, yS), xb - xa, Math.abs(yS - yE))
    hline(g, xa, xb, yT, C.up, 1, [4, 3])
    hline(g, xa, xb, yS, C.down, 1, [4, 3])
    hline(g, xa, xb, yE, C.entry, 1)

    // Signal arrow under (long) / over (short) the reversal brick or candle.
    const sb = bx ? r.bricks[t.signalBrick] : byTime.get(t.signalTime)
    if (sb) arrow(g, xSignal(t), long ? Y(sb.low) + 6 : Y(sb.high) - 6, long ? 1 : -1, long ? C.up : C.down)

    // Label column left of the trade: entry, TP and SL with prices.
    if (roomy) {
      const lx = xa - 6
      tag(g, lx, yT, `TP ${fmtPrice(t.target)}`, C.up)
      tag(g, lx, yS, `SL ${fmtPrice(t.stop)}`, C.down)
      pill(g, lx, yE, `${long ? 'Long' : 'Short'} ${fmtPrice(t.entryPrice)} · fade ${t.run}`, long ? C.up : C.down, 'right')
    }

    // Exit tag: why and how much.
    if (t.exitTime !== null && t.exitPrice !== null && t.pnl !== null && s.showLabels) {
      const why = t.exitReason === 'Weekend' ? 'Fri close' : t.exitReason === 'TP' ? 'TP hit' : 'SL hit'
      const bg = t.exitReason === 'Weekend' ? C.weekend : t.pnl > 0 ? C.up : C.down
      const ye = Y(t.exitPrice)
      g.fillStyle = bg
      g.beginPath()
      g.arc(xb, ye, 3, 0, Math.PI * 2)
      g.fill()
      pill(g, xb + 6, ye, roomy ? `${why} ${fmtPrice(t.exitPrice)} · ${fmtPnl(t.pnl)}` : fmtPnl(t.pnl), bg, 'left')
    }
  }

  // Live levels on the right edge: the open trade, or a signal filling at the next bar's open.
  const right = rect.x + rect.width - 2
  const live = open
    ? { entry: open.entryPrice, stop: open.stop, target: open.target, label: open.dir === 1 ? 'Long' : 'Short' }
    : r.pending
      ? { entry: r.pending.ref, stop: r.pending.stop, target: r.pending.target, label: r.pending.dir === 1 ? 'Pending long' : 'Pending short' }
      : null
  if (live) {
    pill(g, right, Y(live.target), `TP ${fmtPrice(live.target)}`, C.up, 'right')
    pill(g, right, Y(live.entry), `${live.label} ${fmtPrice(live.entry)}`, C.accent, 'right')
    pill(g, right, Y(live.stop), `SL ${fmtPrice(live.stop)}`, C.down, 'right')
  }

  // Stats box (bottom-left; the pane legend owns the top-left).
  if (s.showStats) {
    const closed = r.trades.filter((t) => t.pnl !== null)
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0)
    const gp = wins.reduce((a, t) => a + (t.pnl ?? 0), 0)
    const gl = -closed.filter((t) => (t.pnl ?? 0) < 0).reduce((a, t) => a + (t.pnl ?? 0), 0)
    const net = closed.reduce((a, t) => a + (t.pnl ?? 0), 0)
    const lines = [
      `Renko Fade · box ${Number(o.box.toFixed(6))} · run ${o.minRun} · TP ${o.targetBoxes} / SL ${o.stopBoxes} boxes`,
      closed.length
        ? `${closed.length} trades · ${Math.round((wins.length / closed.length) * 100)}% win · net ${net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(2)} · PF ${gl ? (gp / gl).toFixed(2) : '∞'} · full report: Strategy Tester`
        : 'No closed trades on loaded history',
    ]
    if (ctx.chartType !== 'renko') lines.push('Tip: switch the chart type to Renko to see the bricks it trades')
    else if (model.interval && model.interval !== '1m') lines.push(`Researched on 1m bricks — this chart builds them from ${model.interval} closes`)
    g.font = FONT
    const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 16
    const h = 8 + lines.length * 14
    const x = rect.x + 8
    const y = rect.y + rect.height - h - 22
    g.fillStyle = C.statsBg
    g.beginPath()
    g.roundRect(x, y, w, h, 5)
    g.fill()
    g.textAlign = 'left'
    g.textBaseline = 'alphabetic'
    lines.forEach((l, i) => {
      g.fillStyle = i === 0 ? C.text : C.muted
      g.fillText(l, x + 8, y + 15 + i * 14)
    })
  }
  g.restore()
}
