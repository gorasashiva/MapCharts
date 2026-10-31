/**
 * Big Trades — an ATAS / DeepCharts-style "Big Trades" indicator (see
 * https://help.atas.net/en/support/solutions/articles/72000602332-big-trades
 * and https://www.deepcharts.com/helpcenter/article/big-trades):
 * plots large aggressive trades directly on the price chart at their real
 * price/time, bubble-sized by volume. Three data sources feed it:
 *
 *   - LIVE: real trades from the WS tape via addTrade() — exact volume/side.
 *   - RECORDED: setHistory() — clusters built from a tape the recorder
 *     (recorder/tapeRecorder.mjs) saved earlier. Exact like the live path;
 *     it's the only way to get real history on Delta, whose public API keeps
 *     just the last 50 trades.
 *   - ESTIMATED: bars older than any recorded tape have no individual trades.
 *     Approximated from Candle.tradeCount: average trade size =
 *     volume/tradeCount, flagged when that average is a statistical outlier
 *     (z-score) for this symbol's own recent history — NOT the same
 *     comparison as a live trade's minVolume (see setCandles' doc comment).
 *     A bar with tradeCount <= 1 is exact, not an estimate — its whole volume
 *     WAS that one trade, filtered by minVolume like a live trade.
 *
 *     Providers that don't report tradeCount at all (Delta Exchange, whose
 *     candles carry total volume only) simply get no estimated markers.
 *
 * Calculation mode (see takerOrders.ts):
 *   - 'cumulative' (default): fills of one taker order, then taker orders at
 *     the same price/side within a short window, merge into ONE marker —
 *     DeepCharts' "Aggregate Trades" input.
 *   - 'order': one marker per reconstructed taker order.
 *   - 'separate': every print is its own marker.
 *
 * Auto filter: with a recorded tape, the threshold is the size that yields
 * about INTENSITY_PER_DAY[intensity] big trades a day (DeepCharts targets
 * ~10/day), computed once from history. Without one, it falls back to a
 * z-score of the candles' average trade size.
 *
 * Zones (DeepCharts' Shadow / Body modes): a line from each exact big trade
 * at its price, extended `zoneExtendBars` bars right. Trades in a candle's
 * wick and in its body each pick which ones get a zone: 'trend' = the trade
 * went with the candle (a buy in a green candle), 'reverse' = against it (a
 * buy in a red candle — the aggressor got absorbed, the level was defended).
 * Classified against the candle the trade printed in, so a zone on the
 * still-forming bar can appear or vanish until that bar closes.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import { ClusterBuilder, type TapeIntensity, type TradeCluster } from './takerOrders'
import { lazyCanvas } from './lazyCanvas'

export type BigTradesCalculationMode = 'cumulative' | 'order' | 'separate'
export type BigTradesPriceLocation = 'any' | 'high' | 'low' | 'body' | 'upperWick' | 'lowerWick' | 'highOrLow'
/** Which big trades draw a zone: all, only against the candle (reverse), only with it (trend), or none. */
export type BigTradesZoneMode = 'all' | 'reverse' | 'trend' | 'none'

export interface BigTradesOptions {
  calculationMode: BigTradesCalculationMode
  priceLocation: BigTradesPriceLocation // where in the CURRENT (live) bar's range a trade must land — history ignores this
  autoFilter: boolean // calibrate minVolume once from history instead of using the manual value below (doesn't update in real time)
  /** Auto filter target: low ≈ 20, medium ≈ 10, strong ≈ 5 big trades a day. */
  intensity: TapeIntensity
  /** Days of recorded tape to load. */
  daysToLoad: number
  minVolume: number
  maxVolume: number // 0 = unbounded
  fixedSizes: boolean // true = every marker is minSize; false = scales minSize..maxSize by volume
  minSize: number
  maxSize: number
  alpha: number
  showValue: boolean
  historicalZThreshold: number
  /** Zones for trades printed in a candle's wick (DeepCharts' Shadow mode). */
  zoneWick: BigTradesZoneMode
  /** Zones for trades printed in a candle's body (DeepCharts' Body mode). */
  zoneBody: BigTradesZoneMode
  zoneExtendBars: number
}

const DEFAULTS: BigTradesOptions = {
  calculationMode: 'cumulative',
  priceLocation: 'any',
  autoFilter: false,
  intensity: 'medium',
  daysToLoad: 3,
  minVolume: 15,
  maxVolume: 0,
  fixedSizes: false,
  minSize: 20,
  maxSize: 50,
  alpha: 0.75,
  showValue: true,
  historicalZThreshold: 2,
  zoneWick: 'reverse',
  zoneBody: 'none',
  zoneExtendBars: 30,
}

/** Does a trade on `side` printed at `price` inside candle `c` get a zone under these modes? */
export function zoneQualifies(c: { open: number; high: number; low: number; close: number }, price: number, side: 'buy' | 'sell', wick: BigTradesZoneMode, body: BigTradesZoneMode): boolean {
  const inBody = price >= Math.min(c.open, c.close) && price <= Math.max(c.open, c.close)
  const mode = inBody ? body : wick
  if (mode === 'none') return false
  if (mode === 'all') return true
  if (c.close === c.open) return false // a doji has no direction to go with or against
  const withCandle = (side === 'buy') === c.close > c.open
  return mode === 'trend' ? withCandle : !withCandle
}

const MAX_LIVE_MARKERS = 2000

/** What setHistory() takes — the recorder's /tape/clusters response. */
export interface BigTradesHistory {
  clusters: TradeCluster[]
  /** Size threshold the recorder applied (the auto-filter result when perDay was asked for). */
  threshold: number
  /** First recorded moment in the requested range (null = nothing recorded). */
  recordedFrom: number | null
  /** End of the requested range — live trades at or before this are already in `clusters`. */
  to: number
}

interface Marker {
  time: number
  price: number
  volume: number
  side: 'buy' | 'sell'
  estimated: boolean
  /** Set only for estimated markers — see the class doc comment. */
  zscore?: number
}

export default class BigTradesOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private opts: BigTradesOptions
  private liveMarkers: Marker[] = []
  private historyMarkers: Marker[] = []
  private historyFrom: number | null = null
  private historyTo = 0
  private estimatedMarkers: Marker[] = []
  private currentCandle: Candle | null = null // last-loaded (possibly still-forming) bar — used only for live Price Location classification
  /** Loaded candles + their spacing, for zones (which candle a trade printed in, how far N bars reach). */
  private candles: Candle[] = []
  private barMs = 60_000
  private rollingMaxVolume = 0
  private builder: ClusterBuilder
  private autoMinVolume: number | null = null
  private autoComputedOnce = false
  /** Bar replay: hide everything printed at or after this time (null = live). */
  private cutoff: number | null = null
  private running = false
  private raf = 0
  private ro: ResizeObserver | null = null

  constructor(container: HTMLElement, engine: IChartEngine, opts?: Partial<BigTradesOptions>) {
    this.container = container
    this.engine = engine
    this.opts = { ...DEFAULTS, ...opts }
    this.builder = new ClusterBuilder(this.opts.calculationMode)
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '18'
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

  setOptions(opts: Partial<BigTradesOptions>): void {
    if ('autoFilter' in opts && opts.autoFilter && !this.opts.autoFilter) {
      // Re-arm — the user just turned Auto Filter back on, recalibrate on the next setCandles() / setHistory().
      this.autoComputedOnce = false
    }
    const modeChanged = opts.calculationMode !== undefined && opts.calculationMode !== this.opts.calculationMode
    this.opts = { ...this.opts, ...opts }
    if (modeChanged) this.builder = new ClusterBuilder(this.opts.calculationMode)
  }

  getOptions(): BigTradesOptions {
    return { ...this.opts }
  }

  /** The live minVolume in effect right now — auto-calibrated if Auto Filter is on and has run, else the manual setting. */
  effectiveMinVolume(): number {
    return this.opts.autoFilter && this.autoMinVolume !== null ? this.autoMinVolume : this.opts.minVolume
  }

  /**
   * Re-derive the historical estimate from whatever's currently loaded, and
   * (once, if Auto Filter is on and no recorded tape has calibrated it)
   * calibrate minVolume from this symbol's own trade-size distribution
   * instead of a fixed absolute number — a threshold tuned for one
   * instrument's typical trade size is meaningless on another.
   */
  setCandles(candles: Candle[]): void {
    this.currentCandle = candles.length ? candles[candles.length - 1] : null
    this.candles = candles
    if (candles.length > 1) {
      const gaps = candles.slice(-50).map((c, i, a) => (i ? c.time - a[i - 1].time : 0)).filter((d) => d > 0).sort((a, b) => a - b)
      if (gaps.length) this.barMs = gaps[Math.floor(gaps.length / 2)]
    }

    // The last candle is always excluded from the historical pass: it's
    // still forming, so its average is incomplete and keeps changing every
    // tick, AND it already gets exact markers from addTrade().
    const closed = candles.slice(0, -1)
    const sizes: number[] = []
    for (const c of closed) {
      if (c.tradeCount && c.tradeCount > 0 && c.volume > 0) sizes.push(c.volume / c.tradeCount)
    }
    if (sizes.length < 10) {
      this.estimatedMarkers = []
      return
    }
    const mean = sizes.reduce((s, v) => s + v, 0) / sizes.length
    const variance = sizes.reduce((s, v) => s + (v - mean) ** 2, 0) / sizes.length
    const stdDev = Math.sqrt(variance)

    if (this.opts.autoFilter && !this.autoComputedOnce) {
      this.autoMinVolume = mean + 3 * stdDev // "big" relative to THIS symbol's own typical trade size
      this.autoComputedOnce = true
    }
    const minVolume = this.effectiveMinVolume()

    const out: Marker[] = []
    for (const c of closed) {
      if (!c.tradeCount || c.tradeCount <= 0 || c.volume <= 0) continue
      const avgVolume = c.volume / c.tradeCount
      const estimated = c.tradeCount > 1
      const buyVol = c.buyVolume ?? c.volume / 2
      const side: 'buy' | 'sell' = buyVol >= c.volume / 2 ? 'buy' : 'sell'

      if (estimated) {
        // Averaged over >1 trades — minVolume doesn't apply (that dilution
        // is exactly what made the estimate invisible before); statistical
        // unusualness is the only meaningful gate here.
        const z = stdDev > 0 ? (avgVolume - mean) / stdDev : 0
        if (z < this.opts.historicalZThreshold) continue
        out.push({ time: c.time, price: c.close, volume: avgVolume, side, estimated, zscore: z })
      } else {
        // Exactly one trade in this bar — avgVolume IS that trade's real size.
        if (avgVolume < minVolume) continue
        if (this.opts.maxVolume > 0 && avgVolume > this.opts.maxVolume) continue
        out.push({ time: c.time, price: c.close, volume: avgVolume, side, estimated: false })
      }
    }
    this.estimatedMarkers = out
  }

  /**
   * Recorded tape for this symbol (null = none / recorder unreachable). With
   * Auto Filter on, the recorder's per-day threshold becomes the live one too.
   */
  setHistory(h: BigTradesHistory | null): void {
    if (!h || h.recordedFrom === null) {
      this.historyMarkers = []
      this.historyFrom = null
      this.historyTo = 0
      return
    }
    if (this.opts.autoFilter && Number.isFinite(h.threshold)) {
      this.autoMinVolume = h.threshold
      this.autoComputedOnce = true
    }
    const max = this.opts.maxVolume
    this.historyMarkers = h.clusters
      .filter((c) => !(max > 0 && c.qty > max))
      .map((c) => ({ time: c.time, price: c.price, volume: c.qty, side: c.side, estimated: false }))
    for (const m of this.historyMarkers) if (m.volume > this.rollingMaxVolume) this.rollingMaxVolume = m.volume
    this.historyFrom = h.recordedFrom
    this.historyTo = h.to
    // Live markers the history now covers would be drawn twice.
    this.liveMarkers = this.liveMarkers.filter((m) => m.time > h.to)
  }

  /** Bar replay: show only trades printed before `time` (null = live, show all). */
  setCutoff(time: number | null): void {
    this.cutoff = time
  }

  /** Real trade from the live WS tape. */
  addTrade(t: { time: number; price: number; volume: number; side: 'buy' | 'sell'; timeUs?: number }): void {
    if (!this.matchesPriceLocation(t.price)) return
    const done = this.builder.push({ tUs: t.timeUs ?? t.time * 1000, price: t.price, qty: t.volume, side: t.side }, Date.now())
    for (const c of done) this.commit(c)
  }

  private matchesPriceLocation(price: number): boolean {
    if (this.opts.priceLocation === 'any') return true
    const c = this.currentCandle
    if (!c) return true
    const bodyTop = Math.max(c.open, c.close)
    const bodyBottom = Math.min(c.open, c.close)
    const tol = (c.high - c.low) * 0.02
    switch (this.opts.priceLocation) {
      case 'high':
        return price >= c.high - tol
      case 'low':
        return price <= c.low + tol
      case 'highOrLow':
        return price >= c.high - tol || price <= c.low + tol
      case 'body':
        return price >= bodyBottom && price <= bodyTop
      case 'upperWick':
        return price > bodyTop && price < c.high - tol
      case 'lowerWick':
        return price < bodyBottom && price > c.low + tol
      default:
        return true
    }
  }

  private commit(c: TradeCluster): void {
    if (c.time <= this.historyTo) return // already in the recorded history
    const minVolume = this.effectiveMinVolume()
    if (c.qty < minVolume) return
    if (this.opts.maxVolume > 0 && c.qty > this.opts.maxVolume) return
    if (c.qty > this.rollingMaxVolume) this.rollingMaxVolume = c.qty
    this.liveMarkers.push({ time: c.time, price: c.price, volume: c.qty, side: c.side, estimated: false })
    if (this.liveMarkers.length > MAX_LIVE_MARKERS) this.liveMarkers.shift()
  }

  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      // A cluster that's gone quiet is done — finalize it even though nothing triggered addTrade().
      for (const c of this.builder.flush(Date.now())) this.commit(c)
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
    this.liveMarkers = []
    this.historyMarkers = []
    this.historyFrom = null
    this.historyTo = 0
    this.estimatedMarkers = []
    this.builder = new ClusterBuilder(this.opts.calculationMode)
    this.rollingMaxVolume = 0
    this.autoMinVolume = null
    this.autoComputedOnce = false
    this.currentCandle = null
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  destroy(): void {
    this.stop()
    this.ro?.disconnect()
    this.canvas.remove()
  }

  private sizeFor(volume: number): number {
    if (this.opts.fixedSizes) return this.opts.minSize
    const minVolume = this.effectiveMinVolume()
    const ref = this.opts.maxVolume > 0 ? this.opts.maxVolume : Math.max(minVolume + 1, this.rollingMaxVolume)
    const t = Math.min(1, Math.max(0, (volume - minVolume) / (ref - minVolume)))
    return this.opts.minSize + t * (this.opts.maxSize - this.opts.minSize)
  }

  /** Estimated markers scale by how statistically unusual they are (z-score), not raw volume — see setCandles' doc comment. */
  private sizeForZScore(z: number): number {
    if (this.opts.fixedSizes) return this.opts.minSize
    const span = 3
    const t = Math.min(1, Math.max(0, (z - this.opts.historicalZThreshold) / span))
    return this.opts.minSize + t * (this.opts.maxSize - this.opts.minSize)
  }

  private draw(): void {
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)
    if (this.liveMarkers.length === 0 && this.historyMarkers.length === 0 && this.estimatedMarkers.length === 0) return

    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect) return

    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.clip()

    // Zones first, so bubbles sit on top of them.
    if (this.opts.zoneWick !== 'none' || this.opts.zoneBody !== 'none') {
      for (const m of this.historyMarkers) this.drawZone(conv, rect, m)
      if (this.cutoff === null) for (const m of this.liveMarkers) this.drawZone(conv, rect, m)
    }

    // Estimates only where no recorded tape covers the bar.
    const from = this.historyFrom
    for (const m of this.estimatedMarkers) if (from === null || m.time < from) this.drawMarker(conv, rect, m)
    for (const m of this.historyMarkers) this.drawMarker(conv, rect, m)
    if (this.cutoff === null) for (const m of this.liveMarkers) this.drawMarker(conv, rect, m)

    this.ctx.restore()
  }

  /** Candle `time` printed in (null = outside the loaded / replayed bars). */
  private candleAt(time: number): Candle | null {
    const cs = this.candles
    let lo = 0
    let hi = cs.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (cs[mid].time <= time) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (found < 0 || time >= cs[found].time + this.barMs) return null
    return cs[found]
  }

  /** Horizontal line from an exact big trade, `zoneExtendBars` bars right — lines only, no text. */
  private drawZone(conv: Converters, rect: { x: number; y: number; width: number; height: number }, m: Marker): void {
    if (this.cutoff !== null && m.time >= this.cutoff) return
    const c = this.candleAt(m.time)
    if (!c || !zoneQualifies(c, m.price, m.side, this.opts.zoneWick, this.opts.zoneBody)) return
    let end = m.time + this.opts.zoneExtendBars * this.barMs
    if (this.cutoff !== null) end = Math.min(end, this.cutoff)
    const x1 = conv.timeToX(m.time)
    const x2 = conv.timeToX(end)
    if (x2 < rect.x || x1 > rect.x + rect.width) return
    const y = conv.priceToY(m.price)
    if (y < rect.y || y > rect.y + rect.height) return
    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(x1, y)
    ctx.lineTo(x2, y)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = `rgba(${m.side === 'buy' ? '14,203,129' : '246,70,93'},${this.opts.alpha * 0.7})`
    ctx.stroke()
  }

  private drawMarker(conv: Converters, rect: { x: number; y: number; width: number; height: number }, m: Marker): void {
    if (this.cutoff !== null && m.time >= this.cutoff) return
    const x = conv.timeToX(m.time)
    if (x < rect.x - 30 || x > rect.x + rect.width + 30) return
    const y = conv.priceToY(m.price)
    if (y < rect.y - 30 || y > rect.y + rect.height + 30) return

    const d = m.estimated && m.zscore !== undefined ? this.sizeForZScore(m.zscore) : this.sizeFor(m.volume)
    const r = d / 2
    const color = m.side === 'buy' ? '14,203,129' : '246,70,93'
    const ctx = this.ctx

    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${color},${m.estimated ? this.opts.alpha * 0.35 : this.opts.alpha * 0.55})`
    ctx.fill()
    ctx.lineWidth = 1.4
    ctx.strokeStyle = `rgba(${color},${m.estimated ? this.opts.alpha * 0.6 : this.opts.alpha})`
    if (m.estimated) ctx.setLineDash([3, 2])
    ctx.stroke()
    ctx.setLineDash([])

    if (this.opts.showValue && d > 12) {
      const fontSize = Math.max(10, Math.min(14, r * 0.62))
      const label =
        m.estimated && m.zscore !== undefined
          ? `${m.zscore.toFixed(1)}σ`
          : m.volume >= 100
            ? Math.round(m.volume).toString()
            : m.volume.toFixed(1)
      ctx.font = `800 ${fontSize}px -apple-system, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(2.5, fontSize * 0.3)
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'
      ctx.strokeText(label, x, y)
      ctx.fillStyle = '#ffffff'
      ctx.fillText(label, x, y)
    }
  }
}
