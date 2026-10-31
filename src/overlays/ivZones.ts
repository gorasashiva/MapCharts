/**
 * IV Expected-Move Zones — port of "IV walls modified V2.pine". Draws each
 * session's ±0.5 / 1 / 1.5 × expected-move zones around the previous close
 * (auto) or typed wall levels (manual) as filled boxes. Math: ivZonesModel.ts.
 *
 * IV: a typed IV % if set, else the live ATM IV of the symbol's nearest Delta
 * options expiry (BTC / ETH / gold), else realized volatility. Zones are drawn
 * without text by default; labels can be switched on in settings.
 */
import type { IChartEngine } from '../chart/types'
import type { Candle } from '../core/types'
import { sessionClosedWeekends, sessionOpenHourUTC } from '../core/session'
import { impliedFromChain, type ChainPoint, type OHLCBar } from './ivWallsModel'
import { computeIvZones, IV_ZONES_DEFAULTS, type IvZoneSession, type IvZonesOptions } from './ivZonesModel'
import { lazyCanvas } from './lazyCanvas'

export interface IvZonesSources {
  /** Ascending 1h bars for the chart's symbol, ending now. */
  fetchHourly(limit: number): Promise<OHLCBar[]>
  /** The symbol's options chain, or null if it has none. */
  fetchChain(): Promise<ChainPoint[] | null>
}

const REFRESH_MS = 120_000
const HOUR_MS = 3_600_000
const FONT = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

/** `#rrggbb` + alpha → rgba(). */
function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

export interface IvZonesSummary {
  session: IvZoneSession
  status: string
}

export default class IvZonesOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly sources: IvZonesSources
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly ro: ResizeObserver
  private opts: IvZonesOptions
  private symbol = ''
  private candles: Candle[] = []
  private hourly: OHLCBar[] = []
  private cutKey = 'live'
  private liveIV: number | null = null
  private sessions: IvZoneSession[] = []
  private status = 'idle'
  private gen = 0
  private loading = false
  private raf = 0
  private pollTimer: number | null = null

  constructor(container: HTMLElement, engine: IChartEngine, sources: IvZonesSources, opts?: Partial<IvZonesOptions>) {
    this.container = container
    this.engine = engine
    this.sources = sources
    this.opts = { ...IV_ZONES_DEFAULTS, ...opts }
    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '15', display: 'none' })
    container.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()
  }

  resize(): void {
    const r = this.container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(r.width * dpr)
    this.canvas.height = Math.round(r.height * dpr)
    this.canvas.style.width = `${r.width}px`
    this.canvas.style.height = `${r.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  getOptions(): IvZonesOptions {
    return { ...this.opts, walls: [...this.opts.walls] }
  }

  setOptions(patch: Partial<IvZonesOptions>): void {
    const needsMore =
      (patch.hvLookback !== undefined && patch.hvLookback > this.opts.hvLookback) ||
      (patch.historyDays !== undefined && patch.historyDays > this.opts.historyDays)
    this.opts = { ...this.opts, ...patch }
    if (this.opts.enabled && needsMore) void this.reload()
    else this.recompute()
  }

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return
    this.symbol = symbol
    this.gen++
    this.hourly = []
    this.liveIV = null
    this.sessions = []
    this.loading = false
    if (this.opts.enabled) void this.reload()
  }

  /** The pane's candles — for the right edge of today's zones and the spot price. */
  setCandles(candles: Candle[]): void {
    this.candles = candles
    // Bar replay moves the cutoff: recompute when it enters another hour.
    const cut = this.cutoff()
    const key = cut === null ? 'live' : String(Math.floor(cut / HOUR_MS))
    if (key !== this.cutKey && this.hourly.length) this.recompute()
    if (cut !== null) return
    const today = this.sessions[this.sessions.length - 1]
    const last = candles[candles.length - 1]
    // A new session opened on the chart: fetch the bar that closes yesterday.
    if (this.opts.enabled && today && last && last.time >= today.end) void this.reload()
  }

  /**
   * End of the chart's last candle when it lies in the past (bar replay), else
   * null (live). Sessions are then built only from hours before it, and the
   * replayed session gets HV — Delta publishes no historical option IV.
   */
  private cutoff(): number | null {
    const c = this.candles
    const n = c.length
    if (n < 2) return null
    const end = c[n - 1].time + (c[n - 1].time - c[n - 2].time)
    return Date.now() - end > 2 * HOUR_MS ? end : null
  }

  setEnabled(on: boolean): void {
    this.opts.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    this.stopPolling()
    if (on) {
      void this.reload()
      this.pollTimer = window.setInterval(() => void this.reload(), REFRESH_MS)
      if (!this.raf) {
        const loop = (): void => {
          this.draw()
          this.raf = this.opts.enabled ? requestAnimationFrame(loop) : 0
        }
        this.raf = requestAnimationFrame(loop)
      }
    }
  }

  /** Today's session (IV, source, EM, zones) for the pane legend. */
  getSummary(): IvZonesSummary | null {
    const s = this.sessions[this.sessions.length - 1]
    return s ? { session: s, status: this.status } : null
  }

  getStatus(): string {
    return this.status
  }

  destroy(): void {
    this.opts.enabled = false
    this.gen++
    this.stopPolling()
    if (this.raf) cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.canvas.remove()
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private async reload(): Promise<void> {
    if (!this.symbol || this.loading) return
    this.loading = true
    const gen = this.gen
    if (this.hourly.length === 0) this.status = 'loading…'
    try {
      // HV needs hvLookback sessions before the oldest one drawn, plus slack for weekends.
      const days = Math.ceil((this.opts.hvLookback + this.opts.historyDays + 3) * 1.5)
      const [bars, chain] = await Promise.all([this.sources.fetchHourly(days * 24), this.sources.fetchChain().catch(() => null)])
      if (gen !== this.gen) return
      this.hourly = bars
      const spot = this.candles[this.candles.length - 1]?.close ?? bars[bars.length - 1]?.close ?? 0
      this.liveIV = chain && chain.length ? (impliedFromChain(chain, spot, Date.now())?.atmIV ?? null) : null
      this.status = 'live'
      this.recompute()
    } catch (err) {
      if (gen !== this.gen) return
      this.status = 'history unavailable'
      console.warn('[ivZones]', err)
    } finally {
      if (gen === this.gen) this.loading = false
    }
  }

  private recompute(): void {
    const cut = this.cutoff()
    this.cutKey = cut === null ? 'live' : String(Math.floor(cut / HOUR_MS))
    const hourly = cut === null ? this.hourly : this.hourly.filter((b) => b.time < cut)
    this.sessions = hourly.length
      ? computeIvZones(hourly, this.opts, sessionOpenHourUTC(this.symbol), sessionClosedWeekends(this.symbol), cut === null ? this.liveIV : null)
      : []
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr)
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect || this.sessions.length === 0) return
    const n = this.candles.length
    const lastT = n ? this.candles[n - 1].time : undefined
    const barMs = n > 1 ? this.candles[n - 1].time - this.candles[n - 2].time : 0
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    ctx.font = FONT
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    const today = this.sessions[this.sessions.length - 1]
    for (const s of this.sessions) {
      // Today's zones stretch to the latest bar, past sessions span the whole session.
      const endT = s === today && lastT !== undefined ? Math.min(s.end, Math.max(s.start, lastT + barMs)) : s.end
      const x0 = conv.timeToX(s.start)
      const x1 = conv.timeToX(endT)
      if (x1 < rect.x || x0 > rect.x + rect.width) continue
      for (const z of s.zones) {
        const color = z.kind === 'res' ? this.opts.resColor : this.opts.supColor
        const yTop = Math.round(conv.priceToY(z.top)) + 0.5
        const h = Math.max(1, Math.round(conv.priceToY(z.bottom)) + 0.5 - yTop)
        ctx.fillStyle = withAlpha(color, 0.15)
        ctx.fillRect(x0, yTop, x1 - x0, h)
        ctx.strokeStyle = withAlpha(color, 0.7)
        ctx.lineWidth = 1
        ctx.strokeRect(x0, yTop, x1 - x0, h)
        if (this.opts.showLabels && x1 - x0 > 40) {
          ctx.fillStyle = color
          ctx.fillText(z.tag, x1 - 4, yTop + h / 2)
        }
      }
    }
    ctx.restore()
  }
}
