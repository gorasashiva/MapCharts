/**
 * Heavy Absorption — statistically big taker orders at their exact price,
 * plus whether the passive side absorbed them (see heavyAbsorptionModel.ts
 * for the statistic and the absorption check).
 *
 * Data: individual trades. History (the last `daysToLoad` days) comes from the local tape recorder
 * (recorder/tapeRecorder.mjs, /tape/trades) — Delta's public API keeps only
 * the last 50 trades, so without a recording only live trades count. Live
 * trades arrive through addTrade(). Both are rebuilt into taker orders
 * (takerOrders.ts, 'order' mode) before the statistic sees them.
 *
 * Drawing: a circle per marker on its candle at the absorption price — buy (bull) / sell
 * (bear) colour, diameter ∝ √volume relative to the visible markers, the
 * volume printed inside. Absorbed markers get a ring and (optionally) a level
 * line until price trades through it; failed ones are dimmed; pending ones
 * have a dashed outline.
 *
 * Alerts (via onAlert): at bar close, for each new marker on the bar that
 * just closed, and when a marker's absorption is confirmed.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import type { RecordedTape, TapeFetcher } from './footprint'
import { ClusterBuilder, buildClusters, type TapePrint, type TradeCluster } from './takerOrders'
import { HEAVY_ABSORPTION_DEFAULTS, absorptionPrice, computeHeavyAbsorption, type AbsMarker, type AbsOrder, type HeavyAbsorptionOptions, type HeavyAbsorptionResult } from './heavyAbsorptionModel'
import { lazyCanvas } from './lazyCanvas'

type Rect = { x: number; y: number; width: number; height: number }

export interface HeavyAbsorptionOverlayOptions extends HeavyAbsorptionOptions {
  /** Days of recorded tape to load. */
  daysToLoad: number
  bullColor: string
  bearColor: string
  textColor: string
  alpha: number
  minSize: number
  maxSize: number
  showValue: boolean
  /** Draw a level line from each absorbed marker until it is traded through. */
  showLevels: boolean
  /** Every marker, only absorbed ones, or all but failed ones. */
  show: 'all' | 'absorbed' | 'notFailed'
  alertOnBarClose: boolean
  alertOnConfirm: boolean
  alertSound: boolean
}

export const HEAVY_ABSORPTION_OVERLAY_DEFAULTS: HeavyAbsorptionOverlayOptions = {
  ...HEAVY_ABSORPTION_DEFAULTS,
  daysToLoad: 2,
  bullColor: '#0ecb81',
  bearColor: '#f6465d',
  textColor: '#ffffff',
  alpha: 0.8,
  minSize: 16,
  maxSize: 46,
  showValue: true,
  showLevels: true,
  show: 'all',
  alertOnBarClose: true,
  alertOnConfirm: true,
  alertSound: true,
}

const DAY_MS = 86_400_000
const RECOMPUTE_MS = 300
const ABSORBED_RING = '#ffd54f'

const MODEL_KEYS: (keyof HeavyAbsorptionOptions)[] = ['lookback', 'method', 'percentile', 'stdMult', 'minVolume', 'minSamples', 'group', 'confirmBars', 'tolAtr', 'maxLevelBars']

const rgba = (hex: string, a: number): string => {
  const v = parseInt(hex.replace('#', '').slice(0, 6), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`
}
const fmtVol = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2))

export default class HeavyAbsorptionOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly getCandles: () => Candle[]
  private readonly fetchTape: TapeFetcher
  private opts: HeavyAbsorptionOverlayOptions
  private enabled = false
  private symbol = ''
  /** Taker orders, time-ordered: recorded history, then live. */
  private orders: AbsOrder[] = []
  private historyTo = 0
  private recordedFrom: number | null = null
  private loading = false
  private loadGen = 0
  private builder = new ClusterBuilder('order')
  private result: HeavyAbsorptionResult | null = null
  private dirty = true
  private lastCompute = 0
  private seenBars = { len: 0, lastTime: 0, lastClose: 0 }
  /** Alert keys already raised (bar time | side | kind). */
  private alerted = new Set<string>()
  private primed = false
  private cutoff: number | null = null
  private running = false
  private raf = 0
  private ro: ResizeObserver | null = null
  onAlert: ((text: string, sound: boolean) => void) | null = null

  constructor(container: HTMLElement, engine: IChartEngine, getCandles: () => Candle[], fetchTape: TapeFetcher, opts?: Partial<HeavyAbsorptionOverlayOptions>) {
    this.container = container
    this.engine = engine
    this.getCandles = getCandles
    this.fetchTape = fetchTape
    this.opts = { ...HEAVY_ABSORPTION_OVERLAY_DEFAULTS, ...opts }
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

  getOptions(): HeavyAbsorptionOverlayOptions {
    return { ...this.opts }
  }

  setOptions(patch: Partial<HeavyAbsorptionOverlayOptions>): void {
    const reload = patch.daysToLoad !== undefined && patch.daysToLoad !== this.opts.daysToLoad
    this.opts = { ...this.opts, ...patch }
    if (MODEL_KEYS.some((k) => k in patch)) this.dirty = true
    if (reload && this.enabled) void this.loadHistory()
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      this.start()
      void this.loadHistory()
    } else {
      this.stop()
      this.clearData()
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    }
  }

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return
    this.symbol = symbol
    this.clearData()
    if (this.enabled) void this.loadHistory()
  }

  /** Bar replay: hide everything at or after `time` (null = live). */
  setCutoff(time: number | null): void {
    this.cutoff = time
    this.dirty = true
  }

  /** Live trade from the WS tape (base-asset quantity, taker side). */
  addTrade(t: { time: number; timeUs?: number; price: number; volume: number; side: 'buy' | 'sell' }): void {
    if (!this.enabled) return
    for (const c of this.builder.push({ tUs: t.timeUs ?? t.time * 1000, price: t.price, qty: t.volume, side: t.side }, Date.now())) this.commit(c)
  }

  getResult(): HeavyAbsorptionResult | null {
    return this.result
  }

  /** Short status line: the threshold now, and where the tape came from. */
  status(): string {
    const r = this.result
    const th = r && r.threshold.length ? r.threshold[r.threshold.length - 1] : Number.NaN
    const how = this.opts.method === 'percentile' ? `top ${+(100 - this.opts.percentile).toFixed(4)}%` : `${this.opts.stdMult}σ${this.opts.method === 'logSigma' ? ' (log)' : ''}`
    const src = this.loading ? 'loading tape…' : this.recordedFrom === null ? 'no recorded tape — live trades only' : `tape since ${new Date(this.recordedFrom).toISOString().slice(5, 16).replace('T', ' ')} UTC`
    return `Heavy Absorption · big ≥ ${Number.isFinite(th) ? fmtVol(th) : '—'} (${how} of the last ${this.opts.lookback} bars) · ${src}`
  }

  private clearData(): void {
    this.loadGen++
    this.orders = []
    this.historyTo = 0
    this.recordedFrom = null
    this.builder = new ClusterBuilder('order')
    this.result = null
    this.alerted.clear()
    this.primed = false
    this.dirty = true
  }

  private commit(c: TradeCluster): void {
    if (c.time <= this.historyTo) return // already in the recorded history
    this.orders.push({ time: c.time, price: absorptionPrice(c.levels), qty: c.qty, side: c.side })
    this.dirty = true
  }

  /** Recorded tape for the loaded range (capped at daysToLoad), fetched a day at a time. */
  private async loadHistory(): Promise<void> {
    const gen = ++this.loadGen
    const now = Date.now()
    // orders before the first loaded bar are ignored by the model, so no need to wait for candles
    const from = now - this.opts.daysToLoad * DAY_MS
    this.loading = true
    const prints: TapePrint[] = []
    let recordedFrom: number | null = null
    try {
      for (let t = from; t < now; t += DAY_MS) {
        const chunk: RecordedTape | null = await this.fetchTape(t, Math.min(now, t + DAY_MS)).catch(() => null)
        if (gen !== this.loadGen) return
        if (!chunk) continue
        for (const [time, price, qty, side] of chunk.prints) prints.push({ tUs: time * 1000, price, qty, side: side > 0 ? 'buy' : 'sell' })
        if (recordedFrom === null && chunk.sessions.length) recordedFrom = Math.max(t, chunk.sessions[0][0])
      }
    } finally {
      if (gen === this.loadGen) this.loading = false
    }
    prints.sort((a, b) => a.tUs - b.tUs)
    const hist: AbsOrder[] = buildClusters(prints, 'order').map((c) => ({ time: c.time, price: absorptionPrice(c.levels), qty: c.qty, side: c.side }))
    const to = prints.length ? Math.floor(prints[prints.length - 1].tUs / 1000) : 0
    // live orders after the recorded range stay
    this.orders = [...hist, ...this.orders.filter((o) => o.time > to)]
    this.historyTo = to
    this.recordedFrom = recordedFrom
    this.primed = false // history just arrived: record it, don't alert on it
    this.dirty = true
  }

  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      // a taker order that's gone quiet is done
      for (const c of this.builder.flush(Date.now())) this.commit(c)
      this.maybeRecompute()
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

  destroy(): void {
    this.stop()
    this.ro?.disconnect()
    this.canvas.remove()
  }

  private maybeRecompute(): void {
    const candles = this.getCandles()
    const n = candles.length
    const last = n ? candles[n - 1] : null
    const s = this.seenBars
    const newBar = !!last && s.len > 0 && last.time !== s.lastTime
    if (last && (n !== s.len || last.time !== s.lastTime || last.close !== s.lastClose)) this.dirty = true
    const now = performance.now()
    if (!this.dirty || (!newBar && now - this.lastCompute < RECOMPUTE_MS)) return
    this.seenBars = { len: n, lastTime: last?.time ?? 0, lastClose: last?.close ?? 0 }
    this.lastCompute = now
    this.dirty = false
    const cut = this.cutoff
    const orders = cut === null ? this.orders : this.orders.filter((o) => o.time < cut)
    this.result = n ? computeHeavyAbsorption(candles, orders, this.opts) : null
    this.runAlerts(newBar ? n - 2 : -1)
  }

  /** Alerts for the bar that just closed; the first pass after a (re)load only records what's there. */
  private runAlerts(closedIndex: number): void {
    const r = this.result
    if (!r || this.cutoff !== null) return
    const priming = !this.primed
    this.primed = true
    for (const m of r.markers) {
      const keyNew = `${m.barTime}|${m.side}|new`
      const keyAbs = `${m.barTime}|${m.side}|abs`
      if (priming) {
        this.alerted.add(keyNew)
        if (m.verdict === 'absorbed') this.alerted.add(keyAbs)
        continue
      }
      if (closedIndex < 0) continue
      const text = `${m.side === 'buy' ? 'BUY' : 'SELL'} ${fmtVol(m.volume)} @ ${m.price} (${this.symbol})`
      if (m.barIndex === closedIndex && !this.alerted.has(keyNew)) {
        this.alerted.add(keyNew)
        if (this.opts.alertOnBarClose) this.onAlert?.(`Heavy ${m.side === 'buy' ? 'buying' : 'selling'}: ${text}`, this.opts.alertSound)
      }
      if (m.verdict === 'absorbed' && !this.alerted.has(keyAbs)) {
        this.alerted.add(keyAbs)
        if (this.opts.alertOnConfirm) this.onAlert?.(`Absorbed — ${m.side === 'buy' ? 'sellers held' : 'buyers held'}: ${text}`, this.opts.alertSound)
      }
    }
  }

  private draw(): void {
    const cw = this.canvas.width / (window.devicePixelRatio || 1)
    const ch = this.canvas.height / (window.devicePixelRatio || 1)
    this.ctx.clearRect(0, 0, cw, ch)
    if (!this.enabled) return
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    const candles = this.getCandles()
    if (!conv || !rect || candles.length < 2) return
    const g = this.ctx
    g.save()
    g.beginPath()
    g.rect(rect.x, rect.y, rect.width, rect.height)
    g.clip()

    const r = this.result
    if (r) {
      const o = this.opts
      const t0 = conv.xToTime(rect.x - 40)
      const t1 = conv.xToTime(rect.x + rect.width + 40)
      const shown = r.markers.filter((m) => o.show === 'all' || (o.show === 'absorbed' ? m.verdict === 'absorbed' : m.verdict !== 'failed'))
      const visible = shown.filter((m) => m.barTime >= t0 && m.barTime <= t1)
      if (o.showLevels) for (const m of shown) if (m.verdict === 'absorbed') this.drawLevel(conv, rect, candles, m, t0)
      const maxVol = Math.max(1e-9, ...visible.map((m) => m.volume))
      for (const m of visible) this.drawMarker(conv, rect, m, maxVol)
    }
    // status pill, bottom-centre of the price pane (clear of the left drawing toolbar; on a backing so volume bars don't swallow it)
    const text = this.status()
    g.font = "500 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    const w = g.measureText(text).width + 12
    const px = rect.x + (rect.width - w) / 2
    const py = rect.y + rect.height - 24
    g.fillStyle = 'rgba(19, 23, 34, 0.82)'
    g.beginPath()
    g.roundRect(px, py, w, 17, 4)
    g.fill()
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.fillStyle = 'rgba(209, 212, 220, 0.95)'
    g.fillText(text, px + 6, py + 9)
    g.restore()
  }

  /** An absorbed level, from the print to where it was traded through (or the right edge while it holds). */
  private drawLevel(conv: Converters, rect: Rect, candles: Candle[], m: AbsMarker, t0: number): void {
    const endT = candles[Math.min(m.brokenAt ?? candles.length - 1, candles.length - 1)].time
    if (endT < t0) return
    const x1 = conv.timeToX(m.barTime)
    const x2 = m.brokenAt === null ? rect.x + rect.width : conv.timeToX(endT)
    const y = Math.round(conv.priceToY(m.price)) + 0.5
    if (y < rect.y || y > rect.y + rect.height) return
    // a held buy print is resting supply (bear colour); a held sell print is resting demand
    const g = this.ctx
    g.strokeStyle = rgba(m.side === 'buy' ? this.opts.bearColor : this.opts.bullColor, this.opts.alpha * (m.brokenAt === null ? 0.8 : 0.4))
    g.lineWidth = m.brokenAt === null ? 1.5 : 1
    g.setLineDash(m.brokenAt === null ? [] : [4, 3])
    g.beginPath()
    g.moveTo(x1, y)
    g.lineTo(x2, y)
    g.stroke()
    g.setLineDash([])
  }

  private drawMarker(conv: Converters, rect: Rect, m: AbsMarker, maxVol: number): void {
    // centred on the candle the order printed in (its exact time would sit between candles)
    const x = conv.timeToX(m.barTime)
    const y = conv.priceToY(m.price)
    if (y < rect.y - 40 || y > rect.y + rect.height + 40) return
    const o = this.opts
    // diameter ∝ √volume, relative to the biggest visible marker
    const d = o.minSize + (o.maxSize - o.minSize) * Math.sqrt(m.volume / maxVol)
    const rad = d / 2
    const col = m.side === 'buy' ? o.bullColor : o.bearColor
    const dim = m.verdict === 'failed' ? 0.45 : 1
    const g = this.ctx
    g.beginPath()
    g.arc(x, y, rad, 0, Math.PI * 2)
    g.fillStyle = rgba(col, o.alpha * 0.6 * dim)
    g.fill()
    g.lineWidth = 1.4
    g.strokeStyle = rgba(col, o.alpha * dim)
    if (m.verdict === 'pending') g.setLineDash([3, 2])
    g.stroke()
    g.setLineDash([])
    if (m.verdict === 'absorbed') {
      g.beginPath()
      g.arc(x, y, rad + 3, 0, Math.PI * 2)
      g.lineWidth = 2
      g.strokeStyle = rgba(ABSORBED_RING, o.alpha)
      g.stroke()
    }
    if (o.showValue && d >= 14) {
      const fs = Math.max(9, Math.min(13, rad * 0.62))
      const label = fmtVol(m.volume)
      g.font = `800 ${fs}px -apple-system, sans-serif`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.lineJoin = 'round'
      g.lineWidth = Math.max(2.5, fs * 0.3)
      g.strokeStyle = 'rgba(0,0,0,0.85)'
      g.strokeText(label, x, y)
      g.fillStyle = o.textColor
      g.fillText(label, x, y)
    }
  }
}
