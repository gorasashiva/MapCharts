// volxray — fixed-range volume profile.
//
// Two clicks define a box; the candles inside its time span are bucketed into
// 24 price rows spanning the box's price range. Each candle's volume is
// distributed uniformly across the rows its [low, high] range overlaps
// (clipped to the box). Bars grow from the box's left edge; the POC row (max
// volume) is emphasized and marked with a dashed price line.

import type { Candle } from '../../core/types'
import type { Converters, Drawing, ToolImpl } from '../types'
import {
  CHIP_NEUTRAL_BG,
  HIT_TOL,
  crisp,
  drawChip,
  drawHandle,
  fmtCompact,
  fmtPrice,
  lowerBound,
  strokeLine,
  withAlpha,
} from './helpers'

const ROWS = 24
const BAR_ALPHA = 0.35
const POC_ALPHA = 0.8

interface Box {
  left: number
  right: number
  top: number
  bottom: number
  tLo: number
  tHi: number
  pLo: number
  pHi: number
}

function boxOf(d: Drawing, conv: Converters): Box | null {
  const p0 = d.points[0]
  if (!p0) return null
  const p1 = d.points[1] ?? p0
  const xA = conv.timeToX(p0.time)
  const xB = conv.timeToX(p1.time)
  const yA = conv.priceToY(p0.price)
  const yB = conv.priceToY(p1.price)
  return {
    left: Math.min(xA, xB),
    right: Math.max(xA, xB),
    top: Math.min(yA, yB),
    bottom: Math.max(yA, yB),
    tLo: Math.min(p0.time, p1.time),
    tHi: Math.max(p0.time, p1.time),
    pLo: Math.min(p0.price, p1.price),
    pHi: Math.max(p0.price, p1.price),
  }
}

interface Profile {
  rows: Float64Array // volume per row, row 0 at pLo
  max: number
  pocIndex: number // -1 when no volume landed in the box
  total: number
}

function clampRow(r: number): number {
  return r < 0 ? 0 : r >= ROWS ? ROWS - 1 : r
}

function computeProfile(
  candles: Candle[],
  tLo: number,
  tHi: number,
  pLo: number,
  pHi: number,
): Profile {
  const rows = new Float64Array(ROWS)
  let total = 0
  if (candles.length > 0 && pHi > pLo) {
    const rowH = (pHi - pLo) / ROWS
    const i0 = lowerBound(candles, tLo)
    const i1 = lowerBound(candles, tHi + 1) - 1
    for (let i = i0; i <= i1; i++) {
      const c = candles[i]
      if (!(c.volume > 0)) continue
      const lo = Math.max(c.low, pLo)
      const hi = Math.min(c.high, pHi)
      if (hi < lo) continue
      const range = c.high - c.low
      if (range <= 0) {
        // Flat candle: all volume to the single row containing its price.
        const r = clampRow(Math.floor((c.close - pLo) / rowH))
        rows[r] += c.volume
        total += c.volume
        continue
      }
      const r0 = clampRow(Math.floor((lo - pLo) / rowH))
      const r1 = clampRow(Math.ceil((hi - pLo) / rowH) - 1)
      for (let r = r0; r <= r1; r++) {
        const rLo = pLo + r * rowH
        const overlap = Math.min(hi, rLo + rowH) - Math.max(lo, rLo)
        if (overlap > 0) {
          const v = c.volume * (overlap / range)
          rows[r] += v
          total += v
        }
      }
    }
  }
  let max = 0
  let pocIndex = -1
  for (let r = 0; r < ROWS; r++) {
    if (rows[r] > max) {
      max = rows[r]
      pocIndex = r
    }
  }
  return { rows, max, pocIndex, total }
}

interface ProfileCacheEntry {
  candlesRef: Candle[]
  candlesLen: number
  lastHigh: number
  lastLow: number
  lastClose: number
  lastVolume: number
  tLo: number
  tHi: number
  pLo: number
  pHi: number
  profile: Profile
}

const profileCache = new WeakMap<Drawing, ProfileCacheEntry>()

/**
 * Cached wrapper around computeProfile(), keyed per drawing instance — both
 * render() and hitTest() need it, and hitTest() runs on every mousemove
 * (panning/zooming changes `conv` but not the box's time/price bounds, so
 * this also survives a pure pan/zoom, not just repeated calls in one frame).
 */
function getProfile(d: Drawing, candles: Candle[], tLo: number, tHi: number, pLo: number, pHi: number): Profile {
  const last = candles.length > 0 ? candles[candles.length - 1] : null
  const cached = profileCache.get(d)
  if (
    cached &&
    cached.candlesRef === candles &&
    cached.candlesLen === candles.length &&
    cached.tLo === tLo &&
    cached.tHi === tHi &&
    cached.pLo === pLo &&
    cached.pHi === pHi &&
    (last === null ||
      (cached.lastHigh === last.high && cached.lastLow === last.low && cached.lastClose === last.close && cached.lastVolume === last.volume))
  ) {
    return cached.profile
  }
  const profile = computeProfile(candles, tLo, tHi, pLo, pHi)
  profileCache.set(d, {
    candlesRef: candles,
    candlesLen: candles.length,
    lastHigh: last ? last.high : NaN,
    lastLow: last ? last.low : NaN,
    lastClose: last ? last.close : NaN,
    lastVolume: last ? last.volume : NaN,
    tLo,
    tHi,
    pLo,
    pHi,
    profile,
  })
  return profile
}

export const volxrayImpl: ToolImpl = {
  id: 'volxray',
  label: 'Volume X-Ray',
  group: 'smart',
  pointsNeeded: 2,

  render(ctx, d, conv, selected, env) {
    const b = boxOf(d, conv)
    if (!b) return
    ctx.save()

    const w = b.right - b.left
    const h = b.bottom - b.top
    const lw = Math.max(1, d.width)
    ctx.lineWidth = lw
    ctx.strokeStyle = d.color
    ctx.strokeRect(b.left, b.top, w, h)

    // Partial placement: plain rect preview only.
    if (!d.points[1]) {
      ctx.restore()
      return
    }

    const prof = getProfile(d, env.candles, b.tLo, b.tHi, b.pLo, b.pHi)
    if (prof.max > 0 && b.pHi > b.pLo) {
      const rowH = (b.pHi - b.pLo) / ROWS
      for (let r = 0; r < ROWS; r++) {
        const v = prof.rows[r]
        if (v <= 0) continue
        const yT = conv.priceToY(b.pLo + (r + 1) * rowH)
        const yB = conv.priceToY(b.pLo + r * rowH)
        const ry = Math.min(yT, yB)
        const rh = Math.max(Math.abs(yB - yT) - 1, 1) // 1px gap between rows
        const bw = (v / prof.max) * w
        ctx.fillStyle = withAlpha(ctx, d.color, r === prof.pocIndex ? POC_ALPHA : BAR_ALPHA)
        ctx.fillRect(b.left, ry + 0.5, bw, rh)
      }

      // Dashed POC line across the box + price label at the right edge.
      const pocPrice = b.pLo + (prof.pocIndex + 0.5) * rowH
      const yPoc = crisp(conv.priceToY(pocPrice), 1)
      ctx.lineWidth = 1
      ctx.strokeStyle = d.color
      ctx.setLineDash([4, 3])
      strokeLine(ctx, b.left, yPoc, b.right, yPoc)
      ctx.setLineDash([])
      drawChip(ctx, b.right + 6, yPoc, `POC ${fmtPrice(pocPrice, env.pricePrecision)}`, d.color, 'left')
    }

    if (prof.total > 0) {
      drawChip(ctx, b.left + 4, b.bottom - 11, `Σ ${fmtCompact(prof.total)}`, CHIP_NEUTRAL_BG, 'left')
    }

    if (selected) {
      for (const p of d.points) {
        drawHandle(ctx, conv.timeToX(p.time), conv.priceToY(p.price), d.color)
      }
    }
    ctx.restore()
  },

  hitTest(d, x, y, conv, env) {
    if (!d.points[0] || !d.points[1]) return false
    const b = boxOf(d, conv)
    if (!b) return false
    const tol = Math.max(HIT_TOL, d.width / 2 + 3)

    const inOuter =
      x >= b.left - tol && x <= b.right + tol && y >= b.top - tol && y <= b.bottom + tol
    if (!inOuter) return false
    const inInner =
      x > b.left + tol && x < b.right - tol && y > b.top + tol && y < b.bottom - tol
    if (!inInner) return true // on/near the border

    // Inside the box: hit only when over a volume bar.
    if (b.pHi <= b.pLo) return false
    const prof = getProfile(d, env.candles, b.tLo, b.tHi, b.pLo, b.pHi)
    if (prof.max <= 0) return false
    const rowH = (b.pHi - b.pLo) / ROWS
    const r = Math.floor((conv.yToPrice(y) - b.pLo) / rowH)
    if (r < 0 || r >= ROWS) return false
    const bw = (prof.rows[r] / prof.max) * (b.right - b.left)
    return x <= b.left + bw + tol
  },
}
