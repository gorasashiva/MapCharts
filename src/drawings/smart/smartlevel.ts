// smartlevel — self-scoring support/resistance zone.
//
// One click drops a horizontal zone (props.heightPct of price tall, total)
// centered on the clicked price. The tool scores itself by counting how many
// distinct times price has interacted with the zone: a candle "touches" when
// its [low, high] range intersects the zone, and runs of touching candles
// separated by fewer than 3 non-touching bars merge into a single touch.
// More touches → more opaque band.

import type { Candle } from '../../core/types'
import type { ToolImpl } from '../types'
import {
  HIT_TOL,
  crisp,
  drawChip,
  drawHandle,
  fmtPrice,
  logicalSize,
  propNum,
  strokeLine,
  withAlpha,
} from './helpers'

/** Default zone height as a % of price (total, i.e. ±0.2%). */
const DEFAULT_HEIGHT_PCT = 0.4

const MIN_ALPHA = 0.1
const ALPHA_SPAN = 0.25
const TOUCH_CAP = 12

/** Touch count at which the label earns a star. */
const STAR_AT = 5

/** Non-touching bars needed between clusters for a new touch to count. */
const CLUSTER_GAP = 3

/** Zone [lo, hi] for a center price and total height in % of price. */
function zoneBounds(price: number, heightPct: number): [number, number] {
  const half = (Math.abs(price) * heightPct) / 200
  return [price - half, price + half]
}

/**
 * Distinct touch clusters: candle touches when [low, high] intersects
 * [lo, hi]; gaps of >= CLUSTER_GAP non-touching bars split clusters.
 */
function countTouches(candles: Candle[], lo: number, hi: number): number {
  let touches = 0
  let lastTouch = -1 - CLUSTER_GAP // sentinel: first touch always starts a cluster
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    if (c.low <= hi && c.high >= lo) {
      if (i - lastTouch - 1 >= CLUSTER_GAP) touches++
      lastTouch = i
    }
  }
  return touches
}

export const smartlevelImpl: ToolImpl = {
  id: 'smartlevel',
  label: 'Smart Level',
  group: 'smart',
  pointsNeeded: 1,
  defaultProps: { heightPct: DEFAULT_HEIGHT_PCT },

  render(ctx, d, conv, selected, env) {
    const p0 = d.points[0]
    if (!p0) return
    ctx.save()

    const { w } = logicalSize(ctx)
    const heightPct = Math.max(propNum(d, 'heightPct', DEFAULT_HEIGHT_PCT), 0.0001)
    const [lo, hi] = zoneBounds(p0.price, heightPct)
    const yA = conv.priceToY(hi)
    const yB = conv.priceToY(lo)
    const top = Math.min(yA, yB)
    const h = Math.max(Math.abs(yB - yA), 1)

    // Self-score: stronger levels render more opaque.
    const touches = countTouches(env.candles, lo, hi)
    const alpha = MIN_ALPHA + (Math.min(touches, TOUCH_CAP) / TOUCH_CAP) * ALPHA_SPAN

    ctx.fillStyle = withAlpha(ctx, d.color, alpha)
    ctx.fillRect(0, top, w, h)
    ctx.lineWidth = 1
    ctx.strokeStyle = withAlpha(ctx, d.color, 0.85)
    strokeLine(ctx, 0, crisp(top, 1), w, crisp(top, 1))
    strokeLine(ctx, 0, crisp(top + h, 1), w, crisp(top + h, 1))

    const cy = top + h / 2
    const label = `${touches >= STAR_AT ? '★ ' : ''}${touches} ${touches === 1 ? 'touch' : 'touches'}`
    drawChip(ctx, 6, cy, label, d.color, 'left')
    drawChip(ctx, w - 4, cy, fmtPrice(p0.price, env.pricePrecision), d.color, 'right')

    if (selected) drawHandle(ctx, conv.timeToX(p0.time), conv.priceToY(p0.price), d.color)
    ctx.restore()
  },

  hitTest(d, _x, y, conv) {
    const p0 = d.points[0]
    if (!p0) return false
    const heightPct = Math.max(propNum(d, 'heightPct', DEFAULT_HEIGHT_PCT), 0.0001)
    const [lo, hi] = zoneBounds(p0.price, heightPct)
    const yA = conv.priceToY(hi)
    const yB = conv.priceToY(lo)
    return y >= Math.min(yA, yB) - HIT_TOL && y <= Math.max(yA, yB) + HIT_TOL
  },
}
