/**
 * Deep Trades — approximates DeepCharts' "Deep Trades" indicator
 * (https://www.deepcharts.com/helpcenter/article/deep-trades-deepchart):
 * classifies aggressive trades by BOTH their own size and the resting
 * liquidity they consumed, drawing four marker shapes:
 *   - Hollow Circle: a large trade built from many smaller taker orders
 *     (a position worked in pieces).
 *   - Filled Circle: a large trade that landed as one or a few big orders.
 *   - Square: hit a large resting order in the book (the trade itself need
 *     not be large).
 *   - Diamond ("battle"): a large trade AND a large resting order at once —
 *     the most significant interaction.
 *
 * IMPORTANT CAVEAT: the real Deep Trades requires a Level 2 feed with MBO
 * (Market By Order) — visibility into individual resting orders. No public
 * exchange API exposes that (not Delta, not Binance); it's an
 * institutional/paid data-feed feature. This is an approximation built
 * entirely from what a public feed actually gives us:
 *   - trade prints rebuilt into taker orders and clusters (takerOrders.ts) —
 *     the cluster's ORDER COUNT stands in for "many small orders combined"
 *     vs "one/few large ones".
 *   - the incremental book (levelBook.ts, when the provider has
 *     subscribeBook) for the size resting at each level the cluster hit
 *     just before it hit — a total per price, not one identifiable order.
 *     When a level absorbs more than it showed and is still there afterwards,
 *     it was refilled (iceberg-like) and the absorbed size counts as resting.
 *     Without subscribeBook it falls back to the latest depth snapshot.
 *   - recorded history (setHistory) has no book, so it only ever yields
 *     hollow / filled circles.
 * Treat this as a readable proxy for the same intuition, not the same
 * signal quality as a true MBO feed.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { BookEvent, DepthSnapshot } from '../data/types'
import { LevelBook, type BookSide } from './levelBook'
import { ClusterBuilder, type TradeCluster } from './takerOrders'
import { lazyCanvas } from './lazyCanvas'

export interface DeepTradesProvider {
  subscribeDepth(symbol: string, onDepth: (depth: DepthSnapshot) => void): () => void
  subscribeBook?(symbol: string, onEvent: (e: BookEvent) => void): () => void
}

export type DeepTradesIntensity = 'low' | 'medium' | 'strong'
export type DeepTradesMarkerKind = 'hollow' | 'filled' | 'square' | 'diamond'

export interface DeepTradesOptions {
  enabled: boolean
  autoFilter: boolean // auto-calibrate both thresholds, like Big Trades Analysis
  intensity: DeepTradesIntensity // auto filter strictness: per-day target with a recorded tape, else σ above the rolling mean
  minVolume: number // manual large-trade threshold (base-asset qty), used when autoFilter is off
  minRestingSize: number // manual large-resting-liquidity threshold, used when autoFilter is off
  hollowMinCount: number // >= this many taker orders in a cluster reads as "many small orders" (hollow) instead of "few large" (filled)
  minSize: number
  maxSize: number
  alpha: number
  askColor: string // aggressive buy (hits the ask side)
  bidColor: string // aggressive sell (hits the bid side)
  battleColor: string // diamond — large trade directly on large resting liquidity
}

const DEFAULTS: DeepTradesOptions = {
  enabled: false,
  autoFilter: true,
  intensity: 'medium',
  minVolume: 15,
  minRestingSize: 20,
  hollowMinCount: 4,
  minSize: 8,
  maxSize: 34,
  alpha: 0.85,
  askColor: '#0ecb81',
  bidColor: '#f6465d',
  battleColor: '#ffc107',
}

const INTENSITY_Z: Record<DeepTradesIntensity, number> = { low: 1, medium: 2, strong: 3 }
const MAX_MARKERS = 1500
const RESTING_PRICE_TOLERANCE = 0.0015 // 0.15% — snapshot fallback: how close a trade must be to a book level to count as "hitting" it

/** What setHistory() takes — the recorder's /tape/clusters response. */
export interface DeepTradesHistory {
  clusters: TradeCluster[]
  threshold: number
  recordedFrom: number | null
  to: number
}

interface Marker {
  time: number
  price: number
  volume: number
  side: 'buy' | 'sell'
  kind: DeepTradesMarkerKind
}

/** Rolling mean/stdev of recent samples — backs the auto-threshold calibration. */
class RollingStat {
  private values: number[] = []
  push(v: number): void {
    this.values.push(v)
    if (this.values.length > 300) this.values.shift()
  }
  meanStd(): { mean: number; std: number; ready: boolean } {
    const n = this.values.length
    if (n < 15) return { mean: 0, std: 0, ready: false }
    const mean = this.values.reduce((s, v) => s + v, 0) / n
    const variance = this.values.reduce((s, v) => s + (v - mean) ** 2, 0) / n
    return { mean, std: Math.sqrt(variance), ready: true }
  }
}

type Rect = { x: number; y: number; width: number; height: number }

export default class DeepTradesOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly provider: DeepTradesProvider
  private opts: DeepTradesOptions
  private symbol = ''
  private unsub: (() => void) | null = null
  private latestDepth: DepthSnapshot | null = null
  private book = new LevelBook()
  private markers: Marker[] = []
  private historyMarkers: Marker[] = []
  private historyTo = 0
  /** Per-day threshold from the recorded tape (auto filter), once loaded. */
  private historyThreshold: number | null = null
  private builder = new ClusterBuilder('cumulative')
  private volumeStat = new RollingStat()
  private restingStat = new RollingStat()
  private rollingMaxVolume = 0
  private cutoff: number | null = null
  private running = false
  private raf = 0
  private ro: ResizeObserver | null = null

  constructor(container: HTMLElement, engine: IChartEngine, provider: DeepTradesProvider, opts?: Partial<DeepTradesOptions>) {
    this.container = container
    this.engine = engine
    this.provider = provider
    this.opts = { ...DEFAULTS, ...opts }
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '18'
    this.canvas.style.display = this.opts.enabled ? 'block' : 'none'
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

  setOptions(opts: Partial<DeepTradesOptions>): void {
    this.opts = { ...this.opts, ...opts }
  }
  getOptions(): DeepTradesOptions {
    return { ...this.opts }
  }

  setSymbol(symbol: string): void {
    this.symbol = symbol
    this.resubscribe()
  }

  setEnabled(on: boolean): void {
    this.opts.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    this.resubscribe()
  }

  private resubscribe(): void {
    this.unsub?.()
    this.unsub = null
    this.book.clear()
    this.latestDepth = null
    if (!this.opts.enabled || !this.symbol) return
    this.unsub = this.provider.subscribeBook
      ? this.provider.subscribeBook(this.symbol, (e) => this.book.apply(e))
      : this.provider.subscribeDepth(this.symbol, (d) => (this.latestDepth = d))
  }

  /** Recorded tape (null = none): its large clusters become hollow / filled circles; with Auto Filter on, its per-day threshold is used live too. */
  setHistory(h: DeepTradesHistory | null): void {
    if (!h || h.recordedFrom === null) {
      this.historyMarkers = []
      this.historyTo = 0
      this.historyThreshold = null
      return
    }
    this.historyThreshold = this.opts.autoFilter && Number.isFinite(h.threshold) ? h.threshold : null
    this.historyMarkers = h.clusters.map((c) => ({ time: c.time, price: c.price, volume: c.qty, side: c.side, kind: this.circleKind(c) }))
    for (const m of this.historyMarkers) if (m.volume > this.rollingMaxVolume) this.rollingMaxVolume = m.volume
    this.historyTo = h.to
    this.markers = this.markers.filter((m) => m.time > h.to)
  }

  /** Bar replay: show only trades printed before `time` (null = live, show all). */
  setCutoff(time: number | null): void {
    this.cutoff = time
  }

  /** Real trade from the live WS tape (same call site as BigTradesOverlay.addTrade). */
  addTrade(t: { time: number; price: number; volume: number; side: 'buy' | 'sell'; timeUs?: number }): void {
    const done = this.builder.push({ tUs: t.timeUs ?? t.time * 1000, price: t.price, qty: t.volume, side: t.side }, Date.now())
    for (const c of done) this.commitCluster(c)
  }

  private volumeThreshold(): number {
    if (!this.opts.autoFilter) return this.opts.minVolume
    if (this.historyThreshold !== null) return this.historyThreshold
    const { mean, std, ready } = this.volumeStat.meanStd()
    return ready ? mean + INTENSITY_Z[this.opts.intensity] * std : this.opts.minVolume
  }

  private restingThreshold(): number {
    if (!this.opts.autoFilter) return this.opts.minRestingSize
    const { mean, std, ready } = this.restingStat.meanStd()
    return ready ? mean + INTENSITY_Z[this.opts.intensity] * std : this.opts.minRestingSize
  }

  private circleKind(c: TradeCluster): 'hollow' | 'filled' {
    return c.orders >= this.opts.hollowMinCount ? 'hollow' : 'filled'
  }

  /**
   * Largest resting size among the levels the cluster traded through, just
   * before it traded. A level that absorbed more than it showed and is still
   * there afterwards was refilled — the absorbed size is what really rested.
   */
  private restingHit(c: TradeCluster): number {
    const side: BookSide = c.side === 'buy' ? 'ask' : 'bid'
    if (this.book.time > 0) {
      let best = 0
      for (const [price, traded] of c.levels) {
        const before = this.book.restingBefore(side, price, c.time)
        const after = this.book.sizeAt(side, price)
        const resting = traded > before && after > 0 ? traded + after : before
        if (resting > best) best = resting
      }
      return best
    }
    return this.snapshotRestingAt(c.price, c.side)
  }

  /** Fallback without an incremental book: size at (near) `price` in the latest depth snapshot. */
  private snapshotRestingAt(price: number, side: 'buy' | 'sell'): number {
    const book = side === 'buy' ? this.latestDepth?.asks : this.latestDepth?.bids
    if (!book || book.length === 0) return 0
    let best = book[0]
    let bestDiff = Math.abs(book[0][0] - price)
    for (const lvl of book) {
      const diff = Math.abs(lvl[0] - price)
      if (diff < bestDiff) {
        bestDiff = diff
        best = lvl
      }
    }
    return bestDiff / price <= RESTING_PRICE_TOLERANCE ? best[1] : 0
  }

  private commitCluster(c: TradeCluster): void {
    if (c.time <= this.historyTo) return // already in the recorded history
    this.volumeStat.push(c.qty)
    if (c.qty > this.rollingMaxVolume) this.rollingMaxVolume = c.qty
    const isLargeTrade = c.qty >= this.volumeThreshold()

    const resting = this.restingHit(c)
    if (resting > 0) this.restingStat.push(resting)
    const isLargeResting = resting > 0 && resting >= this.restingThreshold()

    let kind: DeepTradesMarkerKind | null = null
    if (isLargeTrade && isLargeResting) kind = 'diamond'
    else if (isLargeResting) kind = 'square'
    else if (isLargeTrade) kind = this.circleKind(c)
    if (!kind) return

    this.markers.push({ time: c.time, price: c.price, volume: c.qty, side: c.side, kind })
    if (this.markers.length > MAX_MARKERS) this.markers.shift()
  }

  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      // A cluster gone quiet is done — finalize it even though nothing triggered addTrade().
      for (const c of this.builder.flush(Date.now())) this.commitCluster(c)
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

  reset(): void {
    this.markers = []
    this.historyMarkers = []
    this.historyTo = 0
    this.historyThreshold = null
    this.builder = new ClusterBuilder('cumulative')
    this.volumeStat = new RollingStat()
    this.restingStat = new RollingStat()
    this.rollingMaxVolume = 0
    this.latestDepth = null
    this.book.clear()
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  destroy(): void {
    this.stop()
    this.unsub?.()
    this.ro?.disconnect()
    this.canvas.remove()
  }

  private sizeFor(volume: number): number {
    const threshold = this.volumeThreshold() || 1e-9
    const ref = Math.max(threshold * 3, this.rollingMaxVolume)
    const t = ref > threshold ? Math.min(1, Math.max(0, (volume - threshold) / (ref - threshold))) : 0
    return this.opts.minSize + t * (this.opts.maxSize - this.opts.minSize)
  }

  private draw(): void {
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)
    if (!this.opts.enabled || (this.markers.length === 0 && this.historyMarkers.length === 0)) return

    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect) return

    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.clip()
    for (const m of this.historyMarkers) this.drawMarker(conv, rect, m)
    if (this.cutoff === null) for (const m of this.markers) this.drawMarker(conv, rect, m)
    this.ctx.restore()
  }

  private drawMarker(conv: Converters, rect: Rect, m: Marker): void {
    if (this.cutoff !== null && m.time >= this.cutoff) return
    const x = conv.timeToX(m.time)
    if (x < rect.x - 30 || x > rect.x + rect.width + 30) return
    const y = conv.priceToY(m.price)
    if (y < rect.y - 30 || y > rect.y + rect.height + 30) return

    const size = this.sizeFor(m.volume)
    const r = size / 2
    const color = m.kind === 'diamond' ? this.opts.battleColor : m.side === 'buy' ? this.opts.askColor : this.opts.bidColor
    const ctx = this.ctx
    ctx.lineWidth = 1.4
    ctx.strokeStyle = color

    switch (m.kind) {
      case 'hollow':
        ctx.globalAlpha = this.opts.alpha
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.stroke()
        break
      case 'filled':
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.globalAlpha = this.opts.alpha * 0.6
        ctx.fillStyle = color
        ctx.fill()
        ctx.globalAlpha = this.opts.alpha
        ctx.stroke()
        break
      case 'square':
        ctx.beginPath()
        ctx.rect(x - r, y - r, size, size)
        ctx.globalAlpha = this.opts.alpha * 0.6
        ctx.fillStyle = color
        ctx.fill()
        ctx.globalAlpha = this.opts.alpha
        ctx.stroke()
        break
      case 'diamond':
        ctx.beginPath()
        ctx.moveTo(x, y - r)
        ctx.lineTo(x + r, y)
        ctx.lineTo(x, y + r)
        ctx.lineTo(x - r, y)
        ctx.closePath()
        ctx.globalAlpha = this.opts.alpha * 0.7
        ctx.fillStyle = color
        ctx.fill()
        ctx.globalAlpha = this.opts.alpha
        ctx.stroke()
        break
    }
    ctx.globalAlpha = 1
  }
}
