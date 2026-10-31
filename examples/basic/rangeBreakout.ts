// "IST 05:30–05:45 Range Breakout v2" — port of "5.30-5.45 breakout v2.pine" as an
// Indicators-menu entry. Math: src/overlays/rangeBreakoutModel.ts (TradingView fill
// model, no look-ahead, so bar replay shows the state at the cursor). Draws the range
// window and its high / low, the breakout signals, each trade's entry / stop / target
// with risk / reward boxes and one result tag at the exit, and Entry / SL / TP price
// tags while a trade is open or pending. Its trades feed the Strategy Tester through
// CanvasSource.strategy (see custom-indicators.ts and pane.getStrategySources).

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import type { StrategyTrade } from '../../src/strategy/types'
import { RB_DEFAULTS, computeRangeBreakout, type RbOptions, type RbResult } from '../../src/overlays/rangeBreakoutModel'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = RB_DEFAULTS
const G_R = 'Range'
const G_X = 'Take profit / stop loss'
const G_F = 'Filters'
const G_L = 'Profit lock (optional)'
const G_P = 'Properties'
const G_V = 'Display'

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min: number, max: number, step: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
// Time pickers: every 15 minutes, IST, valued in minutes of day.
const quarterHours = Array.from({ length: 96 }, (_, i) => ({ value: i * 15, label: `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')} IST` }))
const timeOpt = (key: string, label: string, def: number, group: string): IndicatorParam => ({ key, label, default: def, group, options: quarterHours })

export const rangeBreakout: IndicatorDef = {
  id: 'range_breakout_0530',
  label: 'IST 05:30–05:45 Range Breakout v2',
  shortLabel: 'Range BO v2',
  placement: 'overlay',
  params: [
    timeOpt('rangeStart', 'Range window start', D.rangeStart, G_R),
    timeOpt('rangeEnd', 'Range window end', D.rangeEnd, G_R),

    { key: 'exitMode', label: 'Mode', default: 0, group: G_X, options: [{ value: 0, label: 'Range stop + R multiple' }, { value: 1, label: 'Average run-up / drawdown (%)' }] },
    num('rr', 'Risk : Reward (R multiple mode)', D.rr, G_X, 0.1, 20, 0.1),
    num('avgRunupPct', 'Take profit % (average mode)', D.avgRunupPct, G_X, 0.01, 10, 0.01),
    num('avgDrawPct', 'Stop loss % (average mode)', D.avgDrawPct, G_X, 0.01, 10, 0.01),
    toggle('onlyAfterLoss', 'Opposite-direction trade only if first trade lost', D.onlyAfterLoss, G_X),

    toggle('weekdaysOnly', 'Trade Monday–Friday only', D.weekdaysOnly, G_F),
    toggle('skipFriday', 'Skip Fridays', D.skipFriday, G_F),
    num('minRangeBps', 'Min range size (bps of price, 0 = off)', D.minRangeBps, G_F, 0, 500, 5),
    { key: 'direction', label: 'Direction', default: 0, group: G_F, options: [{ value: 0, label: 'Both' }, { value: 1, label: 'Long only' }, { value: 2, label: 'Short only' }] },
    toggle('useEntryWin', 'Only enter inside an entry window', D.useEntryWin, G_F),
    timeOpt('entryStart', 'Entry window start', D.entryStart, G_F),
    timeOpt('entryEnd', 'Entry window end', D.entryEnd, G_F),

    toggle('useLock', 'Move stop into profit', D.useLock, G_L),
    num('lockAtR', '…once price reaches (R)', D.lockAtR, G_L, 0.1, 10, 0.05),
    num('lockToR', '…move stop to (R from entry, 0 = break-even)', D.lockToR, G_L, -1, 10, 0.05),

    num('initialCapital', 'Initial capital', D.initialCapital, G_P, 1, 1e9, 100),
    num('pctEquity', 'Order size (% of equity)', D.pctEquity, G_P, 0.1, 100, 0.1),

    toggle('showBg', 'Shade range window', true, G_V),
    toggle('showTrades', 'Past trades', true, G_V),
    toggle('showStats', 'Stats box', true, G_V),
  ],
  compute: () => [],
}

export interface RangeBreakoutModel {
  opts: RbOptions
  display: { showBg: boolean; showTrades: boolean; showStats: boolean }
  result: RbResult
}

export function computeRangeBreakoutModel(candles: Candle[], p: Record<string, number>, _ctx: CanvasIndicatorContext): RangeBreakoutModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const opts: RbOptions = {
    rangeStart: n('rangeStart', D.rangeStart),
    rangeEnd: n('rangeEnd', D.rangeEnd),
    exitMode: n('exitMode', 0) === 1 ? 'avg' : 'range',
    rr: n('rr', D.rr),
    avgRunupPct: n('avgRunupPct', D.avgRunupPct),
    avgDrawPct: n('avgDrawPct', D.avgDrawPct),
    onlyAfterLoss: b('onlyAfterLoss', D.onlyAfterLoss),
    weekdaysOnly: b('weekdaysOnly', D.weekdaysOnly),
    skipFriday: b('skipFriday', D.skipFriday),
    minRangeBps: n('minRangeBps', D.minRangeBps),
    direction: (['both', 'long', 'short'] as const)[n('direction', 0)] ?? 'both',
    useEntryWin: b('useEntryWin', D.useEntryWin),
    entryStart: n('entryStart', D.entryStart),
    entryEnd: n('entryEnd', D.entryEnd),
    useLock: b('useLock', D.useLock),
    lockAtR: n('lockAtR', D.lockAtR),
    lockToR: n('lockToR', D.lockToR),
    initialCapital: n('initialCapital', D.initialCapital),
    pctEquity: n('pctEquity', D.pctEquity),
  }
  return {
    opts,
    display: { showBg: b('showBg', true), showTrades: b('showTrades', true), showStats: b('showStats', true) },
    result: computeRangeBreakout(candles, opts),
  }
}

/** Trades in the Strategy Tester's shape (open trade: exitTime null). Quantity = the strategy's own sizing. */
export function rangeBreakoutTrades(model: unknown): StrategyTrade[] {
  return (model as RangeBreakoutModel).result.trades.map((t) => ({
    side: t.dir === 1 ? 'long' : 'short',
    entryTime: t.entryTime,
    entryPrice: t.entry,
    exitTime: t.exitTime,
    exitPrice: t.exitPrice,
    exitReason: t.exitReason,
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
  text: '#d1d4dc',
  rangeHi: '#4caf50',
  rangeLo: '#f23645',
  window: 'rgba(33, 150, 243, 0.15)',
  windowSkip: 'rgba(120, 123, 134, 0.15)',
  reward: 'rgba(8, 153, 129, 0.13)',
  risk: 'rgba(242, 54, 69, 0.13)',
  entry: 'rgba(209, 212, 220, 0.75)',
  statsBg: 'rgba(19, 23, 34, 0.88)',
}
const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const SMALL = "9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

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

const fmtPrice = (p: number): string => (p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p.toPrecision(5))

export function drawRangeBreakout(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: RangeBreakoutModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  const { opts: o, display: s, result: r } = model
  const barMs = candles[candles.length - 1].time - candles[candles.length - 2].time || 60_000
  const barW = Math.abs(conv.timeToX(candles[1].time) - conv.timeToX(candles[0].time)) || 6
  const t0 = conv.xToTime(rect.x) - barMs
  const t1 = conv.xToTime(rect.x + rect.width) + barMs
  const X = (t: number): number => conv.timeToX(t)
  const Y = (p: number): number => conv.priceToY(p)
  const vis = (a: number, b: number): boolean => b >= t0 && a <= t1
  const lastT = candles[candles.length - 1].time
  const byTime = new Map(candles.map((c) => [c.time, c]))

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  // Range window (bgcolor: blue on tradable days, grey on skipped days) and range high / low.
  for (const d of r.days) {
    if (!vis(d.start, d.end)) continue
    if (s.showBg) {
      g.fillStyle = d.tradable ? C.window : C.windowSkip
      const xa = X(d.start) - barW / 2
      g.fillRect(xa, rect.y, X(d.windowEnd) + barW / 2 - xa, rect.height)
    }
    if (d.readyTime !== undefined) {
      const xa = X(d.readyTime)
      const xb = X(d.end)
      g.globalAlpha = d.tradable ? 1 : 0.4
      hline(g, xa, xb, Y(d.high), C.rangeHi, 2)
      hline(g, xa, xb, Y(d.low), C.rangeLo, 2)
      g.globalAlpha = 1
    }
  }

  // Trades: risk / reward boxes, entry line, stop (steps on profit-lock moves), target, result tag.
  const open = r.trades.find((t) => t.exitTime === null)
  for (const t of r.trades) {
    const end = t.exitTime ?? lastT
    if (!vis(t.entryTime, end)) continue
    if (!s.showTrades && t !== open) continue
    const xa = X(t.entryTime)
    const xb = Math.max(X(end), xa + 2)
    const yE = Y(t.entry)
    const yT = Y(t.target)
    g.fillStyle = C.reward
    g.fillRect(xa, Math.min(yE, yT), xb - xa, Math.abs(yT - yE))
    const segs: { from: number; price: number }[] = [{ from: t.entryTime, price: t.stop }, ...t.stopMoves.map((m) => ({ from: m.time, price: m.price }))]
    segs.forEach((sg, k) => {
      const sx0 = Math.max(xa, X(sg.from))
      const sx1 = k + 1 < segs.length ? Math.min(xb, X(segs[k + 1].from)) : xb
      if (sx1 <= sx0) return
      const yS = Y(sg.price)
      g.fillStyle = C.risk
      g.fillRect(sx0, Math.min(yE, yS), sx1 - sx0, Math.abs(yS - yE))
      hline(g, sx0, sx1, yS, C.down, 1, [4, 3])
    })
    hline(g, xa, xb, yT, C.up, 1, [4, 3])
    hline(g, xa, xb, yE, C.entry, 1)
    if (barW >= 4) {
      g.font = SMALL
      g.fillStyle = C.muted
      g.textAlign = 'right'
      g.textBaseline = 'middle'
      g.fillText('TP', xa - 4, yT)
      g.fillText('SL', xa - 4, Y(t.stop))
    }
    if (t.exitTime !== null && t.r !== undefined && t.exitPrice !== null) {
      const tag = `${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R${t.exitReason === 'New day' ? ' · day end' : t.exitReason === 'Lock stop' ? ' · lock' : ''}`
      pill(g, xb + 3, Y(t.exitPrice), tag, (t.pnl ?? 0) > 0 ? C.up : C.down, 'left')
    }
  }

  // Breakout signals (plotshape): ▲ under the bar for longs, ▼ over it for shorts.
  for (const sg of r.signals) {
    if (!vis(sg.time, sg.time)) continue
    const c = byTime.get(sg.time)
    if (!c) continue
    const x = X(sg.time)
    const y = sg.dir === 1 ? Y(c.low) + 6 : Y(c.high) - 6
    g.fillStyle = sg.dir === 1 ? C.up : C.down
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x - 5, y + sg.dir * 8)
    g.lineTo(x + 5, y + sg.dir * 8)
    g.closePath()
    g.fill()
  }

  // Live levels on the right edge: the open trade, or an order placed on the last close.
  const right = rect.x + rect.width - 2
  const live = open
    ? { entry: open.entry, stop: open.stopMoves.length ? open.stopMoves[open.stopMoves.length - 1].price : open.stop, target: open.target, label: 'Entry' }
    : r.pending
      ? { entry: candles[candles.length - 1].close, stop: r.pending.stop, target: r.pending.target, label: 'Pending' }
      : null
  if (live) {
    pill(g, right, Y(live.target), `TP ${fmtPrice(live.target)}`, C.up, 'right')
    pill(g, right, Y(live.entry), `${live.label} ${fmtPrice(live.entry)}`, C.accent, 'right')
    pill(g, right, Y(live.stop), `SL ${fmtPrice(live.stop)}`, C.down, 'right')
  }

  // Stats box (bottom-left; the pane legend owns the top-left).
  if (s.showStats) {
    const closed = r.trades.filter((t) => t.exitTime !== null)
    const wins = closed.filter((t) => (t.pnl ?? 0) > 0)
    const gp = wins.reduce((a, t) => a + (t.pnl ?? 0), 0)
    const gl = -closed.filter((t) => (t.pnl ?? 0) < 0).reduce((a, t) => a + (t.pnl ?? 0), 0)
    const net = closed.reduce((a, t) => a + (t.pnl ?? 0), 0)
    const head = o.exitMode === 'avg' ? `Range BO v2 · TP ${o.avgRunupPct}% / SL ${o.avgDrawPct}%` : `Range BO v2 · range stop · ${o.rr}R`
    const body = r.tfTooLarge
      ? 'Use a chart timeframe of 15 minutes or lower (3m / 5m recommended)'
      : closed.length
        ? `${closed.length} trades · ${Math.round((wins.length / closed.length) * 100)}% win · net ${net >= 0 ? '+' : '-'}$${Math.abs(net).toFixed(2)} · PF ${gl ? (gp / gl).toFixed(2) : '∞'} · full report: Strategy Tester`
        : 'No closed trades on loaded history'
    g.font = FONT
    const w = Math.max(g.measureText(head).width, g.measureText(body).width) + 16
    const h = 36
    const x = rect.x + 8
    const y = rect.y + rect.height - h - 22
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
