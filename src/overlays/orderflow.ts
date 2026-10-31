/**
 * OrderFlow Analysis Overlay
 * Visualizes support/resistance levels, absorption events, and institutional footprints
 * on the chart canvas.
 */
import type { IChartEngine } from '../chart/types'
import type { Candle } from '../core/types'
import type { TradeEvent } from '../data/types'
import { LevelDetector } from '../lab/levels'
import { InstitutionalFootprinter } from '../lab/footprints'
import type { KeyLevel, Footprint } from '../lab/types'
import { lazyCanvas } from './lazyCanvas'

export interface OrderFlowOverlayOptions {
  showLevels?: boolean
  showAbsorption?: boolean
  showFootprints?: boolean
  levelPrecision?: number
  maxLevelsDisplay?: number
  opacityAlpha?: number
}

/**
 * Unified overlay for order flow analysis visualization.
 * Renders key levels, absorption heatmap, and institutional footprints.
 */
export class OrderFlowOverlay {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private container: HTMLElement
  private engine: IChartEngine
  private levelDetector: LevelDetector
  private footprinter: InstitutionalFootprinter
  private running = false
  private opts: Required<OrderFlowOverlayOptions>
  private lastRender = 0
  /** Trades queued by onTrade() and drained once per frame in raf() — keeps a
   *  burst of WS messages from driving the detectors synchronously per message. */
  private pendingTrades: TradeEvent[] = []
  private resizeObserver: ResizeObserver | null = null
  private onWindowResize: (() => void) | null = null

  constructor(
    container: HTMLElement,
    engine: IChartEngine,
    opts?: OrderFlowOverlayOptions
  ) {
    this.container = container
    this.engine = engine
    this.opts = {
      showLevels: true,
      showAbsorption: true,
      showFootprints: true,
      levelPrecision: 100,
      maxLevelsDisplay: 10,
      opacityAlpha: 0.15,
      ...opts,
    }

    // Initialize detectors
    this.levelDetector = new LevelDetector(this.opts.levelPrecision, this.opts.levelPrecision)
    this.footprinter = new InstitutionalFootprinter(2.5, 5, 100)

    // Create overlay canvas
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '20'
    container.style.position = container.style.position || 'relative'
    container.appendChild(this.canvas)

    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)

    this.resize()
    this.bindResize()
  }

  bindResize() {
    const resize = () => this.resize()
    this.onWindowResize = resize
    window.addEventListener('resize', resize)
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(resize)
      this.resizeObserver.observe(this.container)
    }
  }

  resize() {
    const rect = this.container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  start() {
    if (this.running) return
    this.running = true
    this.raf()
  }

  stop() {
    this.running = false
  }

  private raf() {
    if (!this.running) return
    this.draw()
    requestAnimationFrame(() => this.raf())
  }

  /**
   * Feed candle data to the detectors
   */
  onCandle(candle: Candle) {
    this.levelDetector.onCandle(candle)
  }

  /**
   * Queue trade data for the detectors — drained once per frame in draw()
   * instead of processed synchronously per WS message, so a burst of trades
   * can't drive LevelDetector/AbsorptionDetector/InstitutionalFootprinter
   * more than once per repaint.
   */
  onTrade(trade: TradeEvent) {
    this.pendingTrades.push(trade)
  }

  /** Drain any trades queued by onTrade() since the last frame. */
  private flushTrades() {
    if (this.pendingTrades.length === 0) return
    for (const trade of this.pendingTrades) {
      this.levelDetector.onTrade(trade)
      this.footprinter.onTrade(trade)
    }
    this.pendingTrades.length = 0
  }

  /**
   * Main render function
   */
  private draw() {
    this.flushTrades()
    const now = performance.now()
    // Throttle to ~30fps to avoid excessive redraws
    if (now - this.lastRender < 33) return
    this.lastRender = now

    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)

    this.ctx.clearRect(0, 0, cw, ch)
    this.ctx.save()

    const converters = this.engine.getMainConverters()
    const paneRect = this.engine.getMainPaneRect()

    if (!converters || !paneRect) {
      this.ctx.restore()
      return
    }

    if (this.opts.showLevels) {
      this.drawLevels(converters.priceToY.bind(converters), paneRect)
    }

    if (this.opts.showAbsorption) {
      this.drawAbsorption(converters.priceToY.bind(converters), paneRect)
    }

    if (this.opts.showFootprints) {
      this.drawFootprints(converters.priceToY.bind(converters), paneRect)
    }

    this.ctx.restore()
  }

  /**
   * Draw support/resistance levels as horizontal lines
   */
  private drawLevels(priceToY: (price: number) => number, paneRect: any) {
    const levels = this.levelDetector.getTopLevels(this.opts.maxLevelsDisplay)
    if (levels.length === 0) return

    const ctx = this.ctx
    ctx.font = '10px monospace'
    ctx.textBaseline = 'middle'

    for (const level of levels) {
      const y = Math.round(priceToY(level.price))

      // Clamp to pane
      if (y < paneRect.y || y > paneRect.y + paneRect.height) continue

      // Color based on type: blue for support, red for resistance
      const baseColor = level.type === 'support' ? '#4a9eff' : '#ff6b6b'
      const alpha = level.strength * 0.6 + 0.2 // 0.2 to 0.8

      // Horizontal line
      ctx.strokeStyle = `rgba(${level.type === 'support' ? '74,158,255' : '255,107,107'}, ${alpha})`
      ctx.lineWidth = level.strength * 2 + 0.5
      ctx.setLineDash([5, 5])
      ctx.beginPath()
      ctx.moveTo(paneRect.x, y)
      ctx.lineTo(paneRect.x + paneRect.width, y)
      ctx.stroke()
      ctx.setLineDash([])

      // Label with strength
      const labelText = `${level.type[0].toUpperCase()} ${level.price.toFixed(0)} (${(level.strength * 100).toFixed(0)}%)`
      const textW = ctx.measureText(labelText).width
      const labelX = paneRect.x + paneRect.width - textW - 6
      const labelY = y

      // Label background
      ctx.fillStyle = baseColor
      ctx.globalAlpha = 0.8
      ctx.fillRect(labelX - 3, labelY - 7, textW + 6, 14)

      // Label text
      ctx.globalAlpha = 1
      ctx.fillStyle = '#ffffff'
      ctx.fillText(labelText, labelX, labelY)
      ctx.globalAlpha = this.opts.opacityAlpha
    }
  }

  /**
   * Draw absorption heatmap (intensity at price levels)
   */
  private drawAbsorption(priceToY: (price: number) => number, paneRect: any) {
    const absorption = this.levelDetector.getAbsorptionDetector()
    const levels = absorption.getPriceLevels()

    if (levels.length === 0) return

    const ctx = this.ctx
    const barWidth = 6
    const barX = paneRect.x + 8

    for (const level of levels) {
      const y = Math.round(priceToY(level))
      if (y < paneRect.y || y > paneRect.y + paneRect.height) continue

      const balance = absorption.getAbsorptionBalance(level, 60_000)
      const absBalance = Math.abs(balance)

      // Color: green for buy absorption, red for sell
      if (absBalance > 0.1) {
        const color = balance > 0 ? '#089981' : '#f23645'
        const opacity = Math.min(0.6, absBalance * 0.8)

        ctx.fillStyle = color
        ctx.globalAlpha = opacity
        ctx.fillRect(barX, y - barWidth / 2, barWidth, barWidth)
        ctx.globalAlpha = 1
      }
    }
  }

  /**
   * Draw institutional footprints as markers
   */
  private drawFootprints(priceToY: (price: number) => number, paneRect: any) {
    const footprints = this.footprinter.getHighConfidenceFootprints(0.6, 300_000)
    if (footprints.length === 0) return

    const ctx = this.ctx
    const maxFootprints = Math.min(footprints.length, 50) // Limit for performance

    for (let i = 0; i < maxFootprints; i++) {
      const fp = footprints[i]
      const y = Math.round(priceToY(fp.price))

      if (y < paneRect.y || y > paneRect.y + paneRect.height) continue

      const x = paneRect.x + paneRect.width - 24
      const radius = 3 + fp.confidence * 3 // 3-6px

      // Color based on side
      ctx.fillStyle = fp.side === 'buy' ? '#089981' : '#f23645'
      ctx.globalAlpha = fp.confidence * 0.7

      // Draw circle with marker icon
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fill()

      // Add directional marker
      ctx.globalAlpha = 1
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      if (fp.side === 'buy') {
        // Triangle pointing up
        ctx.moveTo(x, y - radius - 1)
        ctx.lineTo(x - 2, y - 1)
        ctx.lineTo(x + 2, y - 1)
      } else {
        // Triangle pointing down
        ctx.moveTo(x, y + radius + 1)
        ctx.lineTo(x - 2, y + 1)
        ctx.lineTo(x + 2, y + 1)
      }
      ctx.closePath()
      ctx.stroke()

      ctx.globalAlpha = this.opts.opacityAlpha
    }

    ctx.globalAlpha = 1
  }

  /** Read-only access for other overlays (e.g. a confluence detector) that need levels/absorption. */
  getLevelDetector(): LevelDetector {
    return this.levelDetector
  }

  /**
   * Get current analysis stats
   */
  getStats() {
    return {
      levels: this.levelDetector.getStats(),
      footprints: this.footprinter.getFootprints().length,
      institutionalBalance: this.footprinter.getInstitutionalBalance(),
      confidence: this.footprinter.getConfidenceAverage(),
    }
  }

  /**
   * Toggle visibility of different components
   */
  setVisibility(opts: Partial<OrderFlowOverlayOptions>) {
    this.opts = { ...this.opts, ...opts }
  }

  /**
   * Clear all data
   */
  reset() {
    this.levelDetector.reset()
    this.footprinter.reset()
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  /**
   * Destroy overlay
   */
  destroy() {
    this.stop()
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    if (this.onWindowResize) {
      window.removeEventListener('resize', this.onWindowResize)
      this.onWindowResize = null
    }
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas)
    }
  }
}

export default OrderFlowOverlay
