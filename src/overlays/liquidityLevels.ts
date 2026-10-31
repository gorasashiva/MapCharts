import type { IChartEngine } from '../chart/types'
import type { DepthSnapshot } from '../data/types'
import { lazyCanvas } from './lazyCanvas'
import { LiquidityLevelsModel } from './liquidityLevelsModel'

export interface LiquidityLevelsProvider {
  subscribeDepth(symbol: string, onDepth: (depth: DepthSnapshot) => void): () => void
}

const BID_COLOR = '#0ecb81'
const ASK_COLOR = '#f6465d'
const LABEL_GAP_PX = 17

/** Live order-book liquidity levels, smoothed and ranked independently per side. */
export default class LiquidityLevelsOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly provider: LiquidityLevelsProvider
  private readonly model = new LiquidityLevelsModel()
  private symbol = ''
  private enabled = false
  private unsub: (() => void) | null = null
  private generation = 0
  private raf = 0
  private lastRender = 0
  private resizeObserver: ResizeObserver | null = null

  constructor(container: HTMLElement, engine: IChartEngine, provider: LiquidityLevelsProvider) {
    this.container = container
    this.engine = engine
    this.provider = provider
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '17'
    container.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)
    this.resize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
  }

  setSymbol(symbol: string): void {
    if (this.symbol === symbol) return
    this.symbol = symbol
    this.model.reset()
    this.resubscribe()
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (enabled) {
      this.resubscribe()
      this.raf = requestAnimationFrame(() => this.draw())
    } else {
      this.generation++
      this.unsub?.()
      this.unsub = null
      cancelAnimationFrame(this.raf)
      this.model.reset()
      this.clear()
    }
  }

  destroy(): void {
    this.enabled = false
    this.generation++
    this.unsub?.()
    this.unsub = null
    cancelAnimationFrame(this.raf)
    this.resizeObserver?.disconnect()
    this.canvas.remove()
  }

  private resubscribe(): void {
    this.generation++
    const generation = this.generation
    this.unsub?.()
    this.unsub = this.enabled && this.symbol
      ? this.provider.subscribeDepth(this.symbol, (depth) => {
          if (generation !== this.generation) return
          this.model.update(depth, performance.now())
        })
      : null
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private draw(): void {
    if (!this.enabled) return
    this.raf = requestAnimationFrame(() => this.draw())
    const now = performance.now()
    if (now - this.lastRender < 33) return
    this.lastRender = now

    const width = this.canvas.width / (window.devicePixelRatio || 1)
    const height = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, width, height)
    const converters = this.engine.getMainConverters()
    const pane = this.engine.getMainPaneRect()
    if (!converters || !pane) return

    const levels = this.model.getLevels(now)
      .map((level) => ({ ...level, y: converters.priceToY(level.price) }))
      .filter((level) => Number.isFinite(level.y) && level.y >= pane.y && level.y <= pane.y + pane.height)
      .sort((a, b) => b.notional - a.notional)

    const labelYs: number[] = []
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(pane.x, pane.y, pane.width, pane.height)
    ctx.clip()

    for (const level of levels) {
      const color = level.side === 'bid' ? BID_COLOR : ASK_COLOR
      const alpha = (0.12 + level.strength * 0.2) * (0.55 + level.persistence * 0.45) * level.fade
      ctx.strokeStyle = color
      ctx.globalAlpha = alpha
      ctx.lineWidth = 1 + level.strength
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.moveTo(pane.x, Math.round(level.y) + 0.5)
      ctx.lineTo(pane.x + pane.width, Math.round(level.y) + 0.5)
      ctx.stroke()
      ctx.setLineDash([])

      if (labelYs.some((y) => Math.abs(y - level.y) < LABEL_GAP_PX)) continue
      labelYs.push(level.y)
      const label = `${level.side === 'bid' ? 'BID' : 'ASK'} · ${formatQty(level.qty)}`
      ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif'
      const x = pane.x + 6
      const y = level.y - 7
      const labelWidth = ctx.measureText(label).width + 10
      ctx.globalAlpha = 0.82
      ctx.fillStyle = color
      ctx.fillRect(x, y, labelWidth, 14)
      ctx.globalAlpha = 1
      ctx.fillStyle = '#101318'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, x + 5, level.y)
    }

    ctx.restore()
  }

  private clear(): void {
    const width = this.canvas.width / (window.devicePixelRatio || 1)
    const height = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, width, height)
  }
}

function formatQty(qty: number): string {
  if (qty >= 1_000_000) return `${(qty / 1_000_000).toFixed(1)}M`
  if (qty >= 1_000) return `${(qty / 1_000).toFixed(1)}K`
  return qty.toLocaleString('en-US', { maximumSignificantDigits: 3 })
}
