/**
 * ICT / Smart Money Concepts overlay.
 *
 * Pure OHLC pattern detection — no trade tape needed, recomputed whenever
 * setCandles() gets a new array (same "derive from what's loaded" model as an
 * indicator). Pragmatic canvas implementations of each concept, not a
 * certified reproduction of ICT's own teaching materials:
 *   - Market structure: fractal swing highs/lows, then BOS (break in the
 *     prevailing direction) / CHoCH (break against it) when a close takes
 *     out the last relevant swing.
 *   - Order blocks: the last opposite-colored candle before an impulsive
 *     move (range > 1.5x the recent average, closing in the outer quarter
 *     of its range). Dims once price trades back through it ("mitigated").
 *   - Fair value gaps: the classic 3-candle imbalance (candle 1's wick
 *     doesn't overlap candle 3's).
 *   - Equal highs/lows: clustered swing points within ~0.15% of each other —
 *     read as resting liquidity.
 *   - Premium/discount + OTE: the most recent swing-high/low leg, split at
 *     its midpoint, with the 61.8–79% retracement band highlighted.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import { lazyCanvas } from './lazyCanvas'

export interface ICTOverlayOptions {
  showStructure?: boolean
  showOrderBlocks?: boolean
  showFVG?: boolean
  showEqualHL?: boolean
  showPremiumDiscount?: boolean
  swingLookback?: number
}

interface Swing {
  time: number
  price: number
  type: 'high' | 'low'
}
interface StructureBreak {
  time: number
  price: number
  kind: 'BOS' | 'CHoCH'
  bullish: boolean
}
interface Zone {
  time: number // visual left edge of the box
  endTime: number
  top: number
  bottom: number
  bullish: boolean
  mitigated: boolean
  /** When the pattern actually completed — mitigation scanning starts strictly
   *  after THIS, not after `time`. For a 3-candle FVG, `time` is candle 1 but
   *  the pattern isn't complete until candle 3; scanning from `time` caught
   *  the gap's own defining candles trading into their own zone and marked
   *  it "mitigated" one bar after it formed, collapsing every zone to a
   *  sliver. Same issue for order blocks (scanning from the OB candle caught
   *  the impulse candle that immediately follows it). */
  formedTime: number
}
interface EqualLevel {
  price: number
  type: 'high' | 'low'
  startTime: number // first touch — the line is drawn FROM here, not across the whole pane
  endTime: number // last touch, or the sweep point if price has since taken it out
  swept: boolean
}
interface PremiumDiscount {
  top: number
  bottom: number
  mid: number
  oteTop: number
  oteBottom: number
  startTime: number // the leg's own start — the band is drawn FROM here, not across the whole pane
  endTime: number
}
type Rect = { x: number; y: number; width: number; height: number }

const DEFAULTS: Required<ICTOverlayOptions> = {
  showStructure: true,
  showOrderBlocks: true,
  showFVG: true,
  showEqualHL: true,
  showPremiumDiscount: true,
  swingLookback: 5,
}

function detectSwings(candles: Candle[], lookback: number): Swing[] {
  const out: Swing[] = []
  const n = candles.length
  for (let i = lookback; i < n - lookback; i++) {
    const c = candles[i]
    let isHigh = true
    let isLow = true
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue
      if (candles[j].high >= c.high) isHigh = false
      if (candles[j].low <= c.low) isLow = false
    }
    if (isHigh) out.push({ time: c.time, price: c.high, type: 'high' })
    if (isLow) out.push({ time: c.time, price: c.low, type: 'low' })
  }
  return out
}

/**
 * Walk candles and swings together in time order, always comparing against
 * the MOST RECENT still-unbroken swing of each type (not a fixed sequence
 * replayed one at a time — that previous approach fired a break for every
 * minor fractal in turn, which in a steady trend meant dozens of spurious
 * back-to-back BOS labels for swings that were never really "structure").
 * After a break, that anchor is cleared so a genuinely NEW swing has to form
 * before the next break can register — this is what keeps output to real,
 * spaced-out structural events instead of noise.
 */
function detectStructure(candles: Candle[], swings: Swing[]): StructureBreak[] {
  const out: StructureBreak[] = []
  let activeHigh: Swing | null = null
  let activeLow: Swing | null = null
  let trend: 'up' | 'down' | null = null
  let si = 0 // swings is already time-ascending (built from a single forward pass in detectSwings)
  for (const c of candles) {
    while (si < swings.length && swings[si].time <= c.time) {
      const s = swings[si++]
      if (s.type === 'high') activeHigh = s
      else activeLow = s
    }
    if (activeHigh && c.close > activeHigh.price) {
      out.push({ time: c.time, price: activeHigh.price, kind: trend === 'up' ? 'BOS' : 'CHoCH', bullish: true })
      trend = 'up'
      activeHigh = null
    }
    if (activeLow && c.close < activeLow.price) {
      out.push({ time: c.time, price: activeLow.price, kind: trend === 'down' ? 'BOS' : 'CHoCH', bullish: false })
      trend = 'down'
      activeLow = null
    }
  }
  return out
}

function detectOrderBlocks(candles: Candle[]): Zone[] {
  const out: Zone[] = []
  const n = candles.length
  const win = 20
  if (n <= win) return out
  let sumRange = 0
  for (let j = 0; j < win; j++) sumRange += candles[j].high - candles[j].low
  for (let i = win; i < n; i++) {
    const avgRange = sumRange / win
    const c = candles[i]
    const range = c.high - c.low
    sumRange += range - (candles[i - win].high - candles[i - win].low)
    if (range <= 0 || range < avgRange * 1.5) continue
    const bullishImpulse = c.close > c.open && (c.close - c.low) / range > 0.75
    const bearishImpulse = c.close < c.open && (c.high - c.close) / range > 0.75
    if (!bullishImpulse && !bearishImpulse) continue
    for (let k = i - 1; k >= Math.max(0, i - 5); k--) {
      const ob = candles[k]
      if (bullishImpulse && ob.close < ob.open) {
        out.push({ time: ob.time, endTime: c.time, top: ob.high, bottom: ob.low, bullish: true, mitigated: false, formedTime: c.time })
        break
      }
      if (bearishImpulse && ob.close > ob.open) {
        out.push({ time: ob.time, endTime: c.time, top: ob.high, bottom: ob.low, bullish: false, mitigated: false, formedTime: c.time })
        break
      }
    }
  }
  markMitigation(out, candles)
  return out.slice(-40)
}

function detectFVGs(candles: Candle[]): Zone[] {
  const out: Zone[] = []
  const n = candles.length
  for (let i = 1; i < n - 1; i++) {
    const a = candles[i - 1]
    const b = candles[i + 1]
    if (a.high < b.low) {
      out.push({ time: a.time, endTime: candles[n - 1].time, top: b.low, bottom: a.high, bullish: true, mitigated: false, formedTime: b.time })
    } else if (a.low > b.high) {
      out.push({ time: a.time, endTime: candles[n - 1].time, top: a.low, bottom: b.high, bullish: false, mitigated: false, formedTime: b.time })
    }
  }
  markMitigation(out, candles)
  return out.slice(-60)
}

/** A later candle trading back through a zone marks it filled/mitigated — stop extending it from there. */
function markMitigation(zones: Zone[], candles: Candle[]): void {
  const byTime = new Map(candles.map((c, i) => [c.time, i]))
  for (const z of zones) {
    const startIdx = (byTime.get(z.formedTime) ?? -1) + 1
    for (let i = Math.max(startIdx, 0); i < candles.length; i++) {
      if (candles[i].low <= z.top && candles[i].high >= z.bottom) {
        z.mitigated = true
        z.endTime = candles[i].time
        break
      }
    }
  }
}

/** Recent-window bound for clustering — two swings that happen to match in
 *  price but are from very different, unrelated stretches of history aren't
 *  meaningful "equal highs/lows" liquidity, so they must also be within this
 *  many bars of each other to join the same cluster. */
const EQUAL_LEVEL_MAX_GAP_BARS = 200

function detectEqualLevels(candles: Candle[], swings: Swing[]): EqualLevel[] {
  const out: EqualLevel[] = []
  const indexByTime = new Map(candles.map((c, i) => [c.time, i]))
  for (const type of ['high', 'low'] as const) {
    const pts = swings.filter((s) => s.type === type).sort((a, b) => a.price - b.price)
    let cluster: Swing[] = []
    const flush = (): void => {
      if (cluster.length < 2) return
      const price = cluster.reduce((s, c) => s + c.price, 0) / cluster.length
      const times = cluster.map((c) => c.time).sort((a, b) => a - b)
      const startTime = times[0]
      let endTime = candles[candles.length - 1].time
      let swept = false
      const startIdx = (indexByTime.get(startTime) ?? 0) + 1
      for (let i = startIdx; i < candles.length; i++) {
        const c = candles[i]
        if ((type === 'high' && c.high > price) || (type === 'low' && c.low < price)) {
          endTime = c.time
          swept = true
          break
        }
      }
      if (!swept) endTime = Math.max(endTime, times[times.length - 1])
      out.push({ price, type, startTime, endTime, swept })
    }
    for (const p of pts) {
      const last = cluster[cluster.length - 1]
      const closeInPrice = last && Math.abs(p.price - last.price) / p.price < 0.0015
      const closeInTime =
        last && Math.abs((indexByTime.get(p.time) ?? 0) - (indexByTime.get(last.time) ?? 0)) <= EQUAL_LEVEL_MAX_GAP_BARS
      if (cluster.length === 0 || (closeInPrice && closeInTime)) {
        cluster.push(p)
      } else {
        flush()
        cluster = [p]
      }
    }
    flush()
  }
  return out
}

function detectPremiumDiscount(candles: Candle[], swings: Swing[]): PremiumDiscount | null {
  const highs = swings.filter((s) => s.type === 'high')
  const lows = swings.filter((s) => s.type === 'low')
  if (!highs.length || !lows.length) return null
  const lastHigh = highs[highs.length - 1]
  const lastLow = lows[lows.length - 1]
  const top = Math.max(lastHigh.price, lastLow.price)
  const bottom = Math.min(lastHigh.price, lastLow.price)
  const mid = (top + bottom) / 2
  return {
    top,
    bottom,
    mid,
    oteTop: top - (top - bottom) * 0.618,
    oteBottom: top - (top - bottom) * 0.79,
    startTime: Math.min(lastHigh.time, lastLow.time),
    endTime: candles[candles.length - 1].time,
  }
}

export default class ICTOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private opts: Required<ICTOverlayOptions>
  private candles: Candle[] = []
  /** Signature of what recompute() last saw — length + last bar's time/close.
   *  NOT a reference check: the pane mutates its candle array in place on
   *  live ticks (same object, new content), so `===` would never re-fire. */
  private lastSig = ''
  private running = false
  private raf = 0
  private ro: ResizeObserver | null = null

  private swings: Swing[] = []
  private structure: StructureBreak[] = []
  private orderBlocks: Zone[] = []
  private fvgs: Zone[] = []
  private equalLevels: EqualLevel[] = []
  private premiumDiscount: PremiumDiscount | null = null

  constructor(container: HTMLElement, engine: IChartEngine, opts?: ICTOverlayOptions) {
    this.container = container
    this.engine = engine
    this.opts = { ...DEFAULTS, ...opts }
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '19'
    container.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)
    this.resize()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
  }

  resize(): void {
    const rect = this.container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** Call whenever the pane's candle array changes (load, symbol/interval switch, live tick). */
  setCandles(candles: Candle[]): void {
    this.candles = candles
  }

  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      this.draw()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  setVisibility(opts: Partial<ICTOverlayOptions>): void {
    this.opts = { ...this.opts, ...opts }
  }

  reset(): void {
    this.candles = []
    this.lastSig = ''
    this.swings = []
    this.structure = []
    this.orderBlocks = []
    this.fvgs = []
    this.equalLevels = []
    this.premiumDiscount = null
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  destroy(): void {
    this.stop()
    this.ro?.disconnect()
    this.canvas.remove()
  }

  private recompute(): void {
    const c = this.candles
    if (c.length < this.opts.swingLookback * 2 + 2) return
    const last = c[c.length - 1]
    const sig = `${c.length}:${last.time}:${last.close}`
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.swings = detectSwings(c, this.opts.swingLookback)
    this.structure = detectStructure(c, this.swings)
    this.orderBlocks = detectOrderBlocks(c)
    this.fvgs = detectFVGs(c)
    this.equalLevels = detectEqualLevels(c, this.swings)
    this.premiumDiscount = detectPremiumDiscount(c, this.swings)
  }

  private draw(): void {
    this.recompute()
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)

    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect) return

    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.clip()

    if (this.opts.showPremiumDiscount) this.drawPremiumDiscount(conv, rect)
    if (this.opts.showFVG) this.drawZones(conv, rect, this.fvgs, 'rgba(41,98,255,%a)', 'rgba(255,152,0,%a)')
    if (this.opts.showOrderBlocks) this.drawZones(conv, rect, this.orderBlocks, 'rgba(14,203,129,%a)', 'rgba(246,70,93,%a)')
    if (this.opts.showEqualHL) this.drawEqualLevels(conv, rect)
    if (this.opts.showStructure) this.drawStructure(conv, rect)

    this.ctx.restore()
  }

  private drawZones(conv: Converters, rect: Rect, zones: Zone[], bullColor: string, bearColor: string): void {
    const ctx = this.ctx
    for (const z of zones) {
      const x1 = Math.max(conv.timeToX(z.time), rect.x)
      const x2 = Math.min(conv.timeToX(z.endTime), rect.x + rect.width)
      if (x2 < rect.x || x1 > rect.x + rect.width || x2 <= x1) continue
      const y1 = conv.priceToY(z.top)
      const y2 = conv.priceToY(z.bottom)
      const alpha = z.mitigated ? 0.06 : 0.16
      ctx.fillStyle = (z.bullish ? bullColor : bearColor).replace('%a', String(alpha))
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1)
      if (!z.mitigated) {
        ctx.strokeStyle = (z.bullish ? bullColor : bearColor).replace('%a', '0.5')
        ctx.lineWidth = 1
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
      }
    }
  }

  private drawStructure(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    ctx.font = '9px monospace'
    for (const b of this.structure.slice(-20)) {
      const x = conv.timeToX(b.time)
      if (x < rect.x - 20 || x > rect.x + rect.width + 20) continue
      const y = conv.priceToY(b.price)
      const color = b.bullish ? '#0ecb81' : '#f6465d'
      ctx.strokeStyle = color
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(Math.max(x - 20, rect.x), y)
      ctx.lineTo(Math.min(x + 20, rect.x + rect.width), y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = color
      ctx.fillText(b.kind, Math.min(x + 3, rect.x + rect.width - 28), y - 4)
    }
  }

  private drawEqualLevels(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    ctx.font = '9px monospace'
    for (const lvl of this.equalLevels) {
      const y = conv.priceToY(lvl.price)
      if (y < rect.y || y > rect.y + rect.height) continue
      // Bounded to the actual touches (+ the sweep point if taken out) — NOT
      // the full pane width, so the line only spans where this level is real.
      const x1 = Math.max(conv.timeToX(lvl.startTime), rect.x)
      const x2 = Math.min(conv.timeToX(lvl.endTime), rect.x + rect.width)
      if (x2 <= x1) continue
      const color = lvl.type === 'high' ? 'rgba(246,70,93,0.6)' : 'rgba(14,203,129,0.6)'
      ctx.globalAlpha = lvl.swept ? 0.4 : 1
      ctx.strokeStyle = color
      ctx.setLineDash([2, 3])
      ctx.beginPath()
      ctx.moveTo(x1, y)
      ctx.lineTo(x2, y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = color
      ctx.fillText(lvl.type === 'high' ? 'EQH' : 'EQL', x1 + 4, y - 5)
      ctx.globalAlpha = 1
    }
  }

  private drawPremiumDiscount(conv: Converters, rect: Rect): void {
    if (!this.premiumDiscount) return
    const { top, bottom, mid, oteTop, oteBottom, startTime, endTime } = this.premiumDiscount
    const ctx = this.ctx
    // Bounded to the leg that actually produced this range (+ forward to the
    // last candle) — NOT the full pane, so it only covers where it's real.
    const x1 = Math.max(conv.timeToX(startTime), rect.x)
    const x2 = Math.min(conv.timeToX(endTime), rect.x + rect.width)
    if (x2 <= x1) return
    const yTop = conv.priceToY(top)
    const yBot = conv.priceToY(bottom)
    const yMid = conv.priceToY(mid)
    if (yBot <= yTop) return
    const w = x2 - x1
    ctx.fillStyle = 'rgba(246,70,93,0.05)'
    ctx.fillRect(x1, yTop, w, yMid - yTop)
    ctx.fillStyle = 'rgba(14,203,129,0.05)'
    ctx.fillRect(x1, yMid, w, yBot - yMid)
    const yOteTop = conv.priceToY(oteTop)
    const yOteBot = conv.priceToY(oteBottom)
    ctx.fillStyle = 'rgba(255,193,7,0.16)'
    ctx.fillRect(x1, Math.min(yOteTop, yOteBot), w, Math.abs(yOteBot - yOteTop))
    ctx.font = '9px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.fillText('Premium', x1 + 4, yTop + 10)
    ctx.fillText('Discount', x1 + 4, yBot - 4)
    ctx.fillStyle = '#ffc107'
    ctx.fillText('OTE', x1 + 4, (yOteTop + yOteBot) / 2)
  }
}
