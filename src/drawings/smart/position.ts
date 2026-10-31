// longpos / shortpos — ATR-smart position tool.
//
// One click places the entry; expandOnCommit computes a volatility-aware stop
// (1.5 × Wilder ATR(14) of the candles up to the entry, falling back to 2% of
// price on short history) and a target at props.riskR multiples of the risk.
// Committed points are [entry, stop, target], all sharing the entry time.
//
// The box spans `leftBars`/`rightBars` either side of the entry (props) and is
// resizable: drag the left/right edge handles to extend it over time, drag the
// stop/target lines (anywhere) to reprice them, or drag the entry line to move
// the whole structure.

import type { Converters, DrawEnv, Drawing, DrawingPoint, ToolImpl } from '../types'
import {
  CHIP_NEUTRAL_BG,
  HANDLE_TOL,
  HIT_TOL,
  crisp,
  drawChip,
  drawHandle,
  fmtMoney,
  fmtPrice,
  fmtSignedPct,
  lowerBound,
  propNum,
  strokeLine,
  wilderATR,
  withAlpha,
} from './helpers'

const RED = '#ef5350'
const GREEN = '#26a69a'

/** Width of the position box, in bars to the right of the entry. */
const BOX_BARS = 12

const ATR_PERIOD = 14
const STOP_ATR_MULT = 1.5

/** Fallback "ATR" when fewer than ATR_PERIOD+1 candles precede the entry: 2% of price. */
const ATR_FALLBACK_PCT = 0.02

const BOX_ALPHA = 0.12

type Side = 'long' | 'short'

interface Geom {
  entry: DrawingPoint
  stop: DrawingPoint
  target: DrawingPoint
  x0: number
  x1: number
  yEntry: number
  yStop: number
  yTarget: number
}

/** Smallest meaningful price gap between entry and stop/target (avoids zero risk). */
function minGap(price: number): number {
  const g = Math.abs(price) * 1e-5
  return g > 0 ? g : 1e-8
}

function layout(d: Drawing, conv: Converters, env: DrawEnv): Geom | null {
  const entry = d.points[0]
  const stop = d.points[1]
  const target = d.points[2]
  if (!entry || !stop || !target) return null
  // Box spans leftBars to the left and rightBars to the right of the entry.
  const leftBars = Math.max(0, propNum(d, 'leftBars', 0))
  const rightBars = Math.max(1, propNum(d, 'rightBars', BOX_BARS))
  let x0 = conv.timeToX(entry.time - leftBars * env.barMs)
  let x1 = conv.timeToX(entry.time + rightBars * env.barMs)
  // Guard degenerate barMs / non-finite extrapolation: keep a usable box.
  if (!Number.isFinite(x0)) x0 = conv.timeToX(entry.time)
  if (!Number.isFinite(x1) || x1 - x0 < 8) x1 = x0 + 120
  return {
    entry,
    stop,
    target,
    x0,
    x1,
    yEntry: conv.priceToY(entry.price),
    yStop: conv.priceToY(stop.price),
    yTarget: conv.priceToY(target.price),
  }
}

function makePositionImpl(side: Side): ToolImpl {
  const dir = side === 'long' ? 1 : -1
  return {
    id: side === 'long' ? 'longpos' : 'shortpos',
    label: side === 'long' ? 'Long Position' : 'Short Position',
    group: 'smart',
    pointsNeeded: 1,
    // leftBars / rightBars: how far the box extends either side of the entry (in
    // bars). Draggable via the left/right edge handles.
    defaultProps: { stake: 1000, riskR: 2, leftBars: 0, rightBars: BOX_BARS },

    expandOnCommit(d, env) {
      const entry = d.points[0]
      if (!entry) return d
      const riskR = Math.max(propNum(d, 'riskR', 2), 0.1)
      // ATR(14) of the candles up to (and including) the entry time.
      const last = lowerBound(env.candles, entry.time + 1) - 1
      let atr = last >= 0 ? wilderATR(env.candles, last, ATR_PERIOD) : undefined
      if (atr === undefined || !(atr > 0)) {
        atr = Math.max(Math.abs(entry.price) * ATR_FALLBACK_PCT, minGap(entry.price))
      }
      const stopPrice = entry.price - dir * STOP_ATR_MULT * atr
      const targetPrice = entry.price + dir * riskR * Math.abs(entry.price - stopPrice)
      return {
        ...d,
        points: [
          { time: entry.time, price: entry.price },
          { time: entry.time, price: stopPrice },
          { time: entry.time, price: targetPrice },
        ],
      }
    },

    render(ctx, d, conv, selected, env) {
      const entry = d.points[0]
      if (!entry) return
      ctx.save()
      const prec = env.pricePrecision

      const g = layout(d, conv, env)
      if (!g) {
        // Pre-commit preview (only the clicked entry exists for a moment).
        const x0 = conv.timeToX(entry.time)
        const y = crisp(conv.priceToY(entry.price), 1)
        ctx.lineWidth = 1
        ctx.strokeStyle = d.color
        ctx.setLineDash([4, 3])
        strokeLine(ctx, x0, y, x0 + 120, y)
        ctx.setLineDash([])
        drawChip(ctx, x0 + 126, y, `Entry ${fmtPrice(entry.price, prec)}`, d.color, 'left')
        ctx.restore()
        return
      }

      const { x0, x1, yEntry, yStop, yTarget } = g
      const w = x1 - x0

      // Risk / reward boxes.
      ctx.fillStyle = withAlpha(ctx, RED, BOX_ALPHA)
      ctx.fillRect(x0, Math.min(yEntry, yStop), w, Math.abs(yStop - yEntry))
      ctx.fillStyle = withAlpha(ctx, GREEN, BOX_ALPHA)
      ctx.fillRect(x0, Math.min(yEntry, yTarget), w, Math.abs(yTarget - yEntry))

      // Edge lines: stop (red), target (green), entry (solid, tool color).
      const lw = Math.max(1, d.width)
      ctx.lineWidth = lw
      ctx.strokeStyle = RED
      strokeLine(ctx, x0, crisp(yStop, lw), x1, crisp(yStop, lw))
      ctx.strokeStyle = GREEN
      strokeLine(ctx, x0, crisp(yTarget, lw), x1, crisp(yTarget, lw))
      ctx.strokeStyle = d.color
      strokeLine(ctx, x0, crisp(yEntry, lw), x1, crisp(yEntry, lw))

      // Labels at the right of each edge.
      const base = entry.price !== 0 ? entry.price : 1
      const stopPct = ((g.stop.price - entry.price) / base) * 100
      const targetPct = ((g.target.price - entry.price) / base) * 100
      drawChip(ctx, x1 + 6, yEntry, `Entry ${fmtPrice(entry.price, prec)}`, d.color, 'left')
      drawChip(
        ctx,
        x1 + 6,
        yStop,
        `Stop ${fmtPrice(g.stop.price, prec)} · ${fmtSignedPct(stopPct)}`,
        RED,
        'left',
      )
      drawChip(
        ctx,
        x1 + 6,
        yTarget,
        `Target ${fmtPrice(g.target.price, prec)} · ${fmtSignedPct(targetPct)}`,
        GREEN,
        'left',
      )

      // Center chip: R-multiple plus $ risk/reward scaled from props.stake.
      const stake = propNum(d, 'stake', 1000)
      const riskPct = Math.abs(stopPct)
      const rewardPct = Math.abs(targetPct)
      const rr = riskPct > 0 ? rewardPct / riskPct : 0
      const riskUsd = (stake * riskPct) / 100
      const rewardUsd = (stake * rewardPct) / 100
      drawChip(
        ctx,
        (x0 + x1) / 2,
        yEntry,
        `R:R 1:${rr.toFixed(1)} · risk $${fmtMoney(riskUsd)} · reward $${fmtMoney(rewardUsd)}`,
        CHIP_NEUTRAL_BG,
        'center',
      )

      if (selected) {
        drawHandle(ctx, x1, yStop, RED)
        drawHandle(ctx, x1, yTarget, GREEN)
        // Left + right edge handles extend the box over time.
        drawHandle(ctx, x1, yEntry, d.color)
        drawHandle(ctx, x0, yEntry, d.color)
      }
      ctx.restore()
    },

    hitTest(d, x, y, conv, env) {
      const g = layout(d, conv, env)
      if (!g) return false
      if (x < g.x0 - HIT_TOL || x > g.x1 + HIT_TOL) return false
      const inStopBox =
        y >= Math.min(g.yEntry, g.yStop) - HIT_TOL && y <= Math.max(g.yEntry, g.yStop) + HIT_TOL
      const inTargetBox =
        y >= Math.min(g.yEntry, g.yTarget) - HIT_TOL &&
        y <= Math.max(g.yEntry, g.yTarget) + HIT_TOL
      return inStopBox || inTargetBox
    },

    handleAt(d, x, y, conv, env) {
      const g = layout(d, conv, env)
      if (!g) return -1
      const near = (hx: number, hy: number): boolean =>
        Math.abs(x - hx) <= HANDLE_TOL && Math.abs(y - hy) <= HANDLE_TOL
      const onEdge = (lineY: number): boolean =>
        x >= g.x0 - HANDLE_TOL && x <= g.x1 + HANDLE_TOL && Math.abs(y - lineY) <= HANDLE_TOL
      // Corner squares first: stop / target prices, then right (3) / left (4) extend.
      if (near(g.x1, g.yStop)) return 1
      if (near(g.x1, g.yTarget)) return 2
      if (near(g.x1, g.yEntry)) return 3 // right edge → extend right
      if (near(g.x0, g.yEntry)) return 4 // left edge → extend left
      // Then anywhere along a line: stop / target drag in price; entry moves all.
      if (onEdge(g.yStop)) return 1
      if (onEdge(g.yTarget)) return 2
      if (onEdge(g.yEntry)) return 0
      return -1
    },

    moveHandle(d, index, p, env) {
      const entry = d.points[0]
      const stop = d.points[1]
      const target = d.points[2]
      if (!entry || !stop || !target) {
        return {
          ...d,
          points: d.points.map((pt, i) => (i === index ? { time: p.time, price: p.price } : pt)),
        }
      }
      if (index === 0) {
        // Entry drags the whole structure by the time/price delta.
        const dt = p.time - entry.time
        const dp = p.price - entry.price
        return { ...d, points: d.points.map((pt) => ({ time: pt.time + dt, price: pt.price + dp })) }
      }
      const gap = minGap(entry.price)
      if (index === 1) {
        // Stop: price only, clamped to the loss side of the entry.
        const price =
          dir === 1 ? Math.min(p.price, entry.price - gap) : Math.max(p.price, entry.price + gap)
        return { ...d, points: [entry, { time: entry.time, price }, target] }
      }
      if (index === 2) {
        // Target: price only, clamped to the profit side of the entry.
        const price =
          dir === 1 ? Math.max(p.price, entry.price + gap) : Math.min(p.price, entry.price - gap)
        return { ...d, points: [entry, stop, { time: entry.time, price }] }
      }
      // Edge handles change the box's time extent (bars left/right of entry).
      const barMs = env.barMs > 0 ? env.barMs : 60_000
      if (index === 3) {
        const rightBars = Math.max(1, Math.round((p.time - entry.time) / barMs))
        return { ...d, props: { ...(d.props ?? {}), rightBars } }
      }
      if (index === 4) {
        const leftBars = Math.max(0, Math.round((entry.time - p.time) / barMs))
        return { ...d, props: { ...(d.props ?? {}), leftBars } }
      }
      return d
    },
  }
}

export const POSITION_IMPLS: ToolImpl[] = [makePositionImpl('long'), makePositionImpl('short')]
