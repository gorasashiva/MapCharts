/**
 * Deep Stats overlay — a DeepCharts-style table of per-bar order-flow values
 * (deepStatsModel.ts) under (or over) the candles: one row per enabled value,
 * one cell per candle, heat-coloured by how unusual the value is, cells past a
 * threshold highlighted, and a header column with the value names.
 *
 * Data: the recorded tape (/tape/trades), fetched a UTC day at a time for the
 * bars on screen (at most `maxTapeDays` held), plus live trades. Candles not
 * fully covered by tape stay blank — no estimates.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import type { RecordedTape, TapeFetcher } from './footprint'
import { ClusterBuilder, buildClusters, type ClusterMode, type TapePrint, type TradeCluster } from './takerOrders'
import { mergeSpans, type DpUnit } from './deepProfileModel'
import { DEEP_STATS_KEYS, DEEP_STAT_LABELS, SIGNED_STATS, cellIntensity, computeDeepStats, fmtStat, type DeepStatKey, type DeepStatsRow } from './deepStatsModel'
import { lazyCanvas } from './lazyCanvas'
import { autoRowSize } from './blockBreakModel'

type Rect = { x: number; y: number; width: number; height: number }

export interface DeepStatsOptions {
  /** Volume = every print; Order = rebuilt taker orders; Aggregate = orders merged into sweeps. */
  input: 'volume' | 'order' | 'aggregate'
  minFilter: number
  maxFilter: number
  /** Std-devs for full colour: a cell this many σ out is fully coloured. */
  devStd: number
  textSize: number
  textColor: string
  autoFormat: boolean
  invertOrder: boolean
  /** 'pane' = its own pane below the chart (resizable, the price scale untouched); 'bottom' / 'top' = over the price pane. */
  position: 'pane' | 'bottom' | 'top'
  rowHeight: number
  showHeader: boolean
  headerBg: string
  headerText: string
  headerSize: number
  /** Values shown, and their thresholds (0 = off; compared on |value|). */
  show: Record<DeepStatKey, boolean>
  thresholds: Record<DeepStatKey, number>
  thresholdColor: string
  posColor: string
  negColor: string
  heatColor: string
  cellBg: string
  outline: number
  daysToLoad: number
  maxTapeDays: number
  /** Footprint row for High / Low Ratio (0 = automatic: gold / ETH 0.5, BTC 10, else ≈ price / 8000). */
  rowSize: number
}

const zeros = (): Record<DeepStatKey, number> => Object.fromEntries(DEEP_STATS_KEYS.map((k) => [k, 0])) as Record<DeepStatKey, number>
const DEFAULT_SHOWN = new Set<DeepStatKey>(['totVol', 'askVol', 'bidVol', 'delta', 'deltaPct', 'maxDelta', 'minDelta', 'totNT', 'cvd'])

export const DEEP_STATS_DEFAULTS: DeepStatsOptions = {
  input: 'volume',
  minFilter: 0,
  maxFilter: 0,
  devStd: 2,
  textSize: 10,
  textColor: '#d1d4dc',
  autoFormat: true,
  invertOrder: false,
  position: 'pane',
  rowHeight: 15,
  showHeader: true,
  headerBg: '#131722',
  headerText: '#8a93a3',
  headerSize: 10,
  show: Object.fromEntries(DEEP_STATS_KEYS.map((k) => [k, DEFAULT_SHOWN.has(k)])) as Record<DeepStatKey, boolean>,
  thresholds: zeros(),
  thresholdColor: '#ffd54f',
  posColor: '#0ecb81',
  negColor: '#f6465d',
  heatColor: '#4c7dff',
  cellBg: '#0f131a',
  outline: 1,
  daysToLoad: 1,
  maxTapeDays: 4,
  rowSize: 0,
}

const DAY_MS = 86_400_000
const RECOMPUTE_MS = 700
const HEADER_W = 74
const FONT = "ui-monospace, 'Geist Mono', monospace"

const rgba = (hex: string, a: number): string => {
  const v = parseInt(hex.replace('#', '').slice(0, 6), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`
}
const unitOf = (c: TradeCluster): DpUnit => ({ time: c.time, side: c.side, qty: c.qty, levels: c.levels })

export default class DeepStatsOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly getCandles: () => Candle[]
  private readonly fetchTape: TapeFetcher
  private opts: DeepStatsOptions
  private enabled = false
  private symbol = ''
  private tick = 0.01
  private cutoff: number | null = null
  // ---- tape ----
  private prints: TapePrint[] = []
  private units: DpUnit[] = []
  private builder: ClusterBuilder | null = null
  private recordedSpans: [number, number][] = []
  private liveFrom: number | null = null
  private tapeDays = new Map<number, 'loading' | 'done'>()
  private tapeQueue: number[] = []
  private pumping = false
  private loading = false
  private loadGen = 0
  private ensureKey = ''
  private lastEnsure = 0
  private focusTime = Date.now()
  // ---- derived ----
  private rows: (DeepStatsRow | null)[] = []
  private rowsFrom = 0
  private dirty = true
  private lastCompute = 0
  private running = false
  private raf = 0
  private ro: ResizeObserver | null = null
  /** The separate pane's rectangle (set by the host), when position is 'pane'. */
  paneRect: (() => Rect | null) | null = null

  constructor(container: HTMLElement, engine: IChartEngine, getCandles: () => Candle[], fetchTape: TapeFetcher, opts?: Partial<DeepStatsOptions>) {
    this.container = container
    this.engine = engine
    this.getCandles = getCandles
    this.fetchTape = fetchTape
    this.opts = this.merge(DEEP_STATS_DEFAULTS, opts ?? {})
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
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
  }

  private merge(base: DeepStatsOptions, patch: Partial<DeepStatsOptions>): DeepStatsOptions {
    return { ...base, ...patch, show: { ...base.show, ...(patch.show ?? {}) }, thresholds: { ...base.thresholds, ...(patch.thresholds ?? {}) } }
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

  getOptions(): DeepStatsOptions {
    return this.merge(this.opts, {})
  }

  setOptions(patch: Partial<DeepStatsOptions>): void {
    const prev = this.opts
    this.opts = this.merge(this.opts, patch)
    if (patch.input !== undefined && patch.input !== prev.input) this.rebuildUnits()
    if (patch.maxTapeDays !== undefined && patch.maxTapeDays !== prev.maxTapeDays) {
      this.evictDays()
      this.rebuildUnits()
    }
    if (patch.daysToLoad !== undefined && this.enabled) this.preload()
    this.ensureKey = ''
    this.dirty = true
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      this.start()
      this.preload()
    } else {
      this.stop()
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    }
  }

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return
    this.symbol = symbol
    this.loadGen++
    this.prints = []
    this.units = []
    this.builder = null
    this.recordedSpans = []
    this.liveFrom = null
    this.tapeDays.clear()
    this.tapeQueue = []
    this.pumping = false
    this.loading = false
    this.ensureKey = ''
    this.rows = []
    this.dirty = true
    if (this.enabled) this.preload()
  }

  setSymbolTick(tick: number): void {
    if (tick > 0 && tick !== this.tick) {
      this.tick = tick
      this.dirty = true
    }
  }

  setCutoff(t: number | null): void {
    this.cutoff = t
    this.dirty = true
  }

  addTrade(t: { time: number; timeUs?: number; price: number; qty: number; side: 'buy' | 'sell' }): void {
    if (!this.enabled) return
    if (this.liveFrom === null) this.liveFrom = t.time
    const p: TapePrint = { tUs: t.timeUs ?? t.time * 1000, price: t.price, qty: t.qty, side: t.side }
    this.prints.push(p)
    if (this.opts.input === 'volume') this.pushUnit({ time: t.time, side: t.side, qty: t.qty, levels: [[t.price, t.qty]] })
    else {
      this.builder ??= new ClusterBuilder(this.mode())
      for (const c of this.builder.push(p, Date.now())) this.pushUnit(unitOf(c))
    }
    this.dirty = true
  }

  private mode(): ClusterMode {
    return this.opts.input === 'aggregate' ? 'cumulative' : this.opts.input === 'order' ? 'order' : 'separate'
  }

  private pushUnit(u: DpUnit): void {
    const us = this.units
    us.push(u)
    for (let i = us.length - 1; i > 0 && us[i - 1].time > us[i].time; i--) [us[i - 1], us[i]] = [us[i], us[i - 1]]
  }

  private rebuildUnits(): void {
    const prints = [...this.prints].sort((a, b) => a.tUs - b.tUs)
    this.units = this.opts.input === 'volume'
      ? prints.map((p) => ({ time: Math.floor(p.tUs / 1000), side: p.side, qty: p.qty, levels: [[p.price, p.qty]] as [number, number][] }))
      : buildClusters(prints, this.mode()).map(unitOf)
    this.builder = this.opts.input === 'volume' ? null : new ClusterBuilder(this.mode())
    this.dirty = true
  }

  // ---------------------------------------------------------------- tape ----
  private preload(): void {
    const now = Date.now()
    const days: number[] = []
    for (let k = 0; k < Math.max(1, this.opts.daysToLoad); k++) days.push(Math.floor((now - k * DAY_MS) / DAY_MS) * DAY_MS)
    this.requestDays(days)
  }

  private requestDays(days: number[]): void {
    const want = days.filter((d) => !this.tapeDays.has(d))
    if (!want.length) return
    this.tapeQueue = [...want, ...this.tapeQueue.filter((d) => !want.includes(d))]
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    const gen = this.loadGen
    try {
      while (this.tapeQueue.length && gen === this.loadGen && this.enabled) {
        const day = this.tapeQueue.shift() as number
        if (this.tapeDays.has(day)) continue
        this.tapeDays.set(day, 'loading')
        this.loading = true
        const chunk: RecordedTape | null = await this.fetchTape(day, Math.min(Date.now(), day + DAY_MS)).catch(() => null)
        if (gen !== this.loadGen) return
        this.tapeDays.set(day, 'done')
        if (chunk) this.mergeDay(day, chunk)
        this.evictDays()
        this.rebuildUnits()
      }
    } finally {
      if (gen === this.loadGen) {
        this.pumping = false
        this.loading = this.tapeQueue.length > 0
      }
    }
  }

  /** One recorded UTC day into the tape, replacing anything already held for the time it covers (e.g. live prints). */
  private mergeDay(day: number, chunk: RecordedTape): void {
    const add: TapePrint[] = chunk.prints.map(([time, price, qty, side]) => ({ tUs: time * 1000, price, qty, side: side > 0 ? 'buy' : 'sell' }))
    add.sort((a, b) => a.tUs - b.tUs)
    let to = day
    for (const s of chunk.sessions) to = Math.max(to, Math.min(s[1], day + DAY_MS))
    if (add.length) to = Math.max(to, Math.floor(add[add.length - 1].tUs / 1000))
    const a = day * 1000
    const b = to * 1000
    this.prints = [...this.prints.filter((p) => p.tUs < a), ...add, ...this.prints.filter((p) => p.tUs > b)]
    this.recordedSpans = mergeSpans([...this.recordedSpans, ...chunk.sessions.map((s) => [s[0], s[1]] as [number, number])])
  }

  /** Keep at most `maxTapeDays` days: drop those farthest from the screen (never today, which has the live tape). */
  private evictDays(): void {
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS
    const done = [...this.tapeDays.entries()].filter(([d, st]) => st === 'done' && d !== today).map(([d]) => d)
    const keep = Math.max(1, this.opts.maxTapeDays) - (this.tapeDays.has(today) ? 1 : 0)
    if (done.length <= keep) return
    const focus = this.focusTime
    done.sort((x, y) => Math.abs(y + DAY_MS / 2 - focus) - Math.abs(x + DAY_MS / 2 - focus))
    for (const d of done.slice(0, done.length - keep)) {
      this.tapeDays.delete(d)
      const a = d * 1000
      const b = (d + DAY_MS) * 1000
      this.prints = this.prints.filter((p) => p.tUs < a || p.tUs >= b)
      const cut: [number, number][] = []
      for (const [x, y] of this.recordedSpans) {
        if (y <= d || x >= d + DAY_MS) cut.push([x, y])
        else {
          if (x < d) cut.push([x, d])
          if (y > d + DAY_MS) cut.push([d + DAY_MS, y])
        }
      }
      this.recordedSpans = cut
    }
  }

  private ensureVisibleTape(conv: Converters, rect: Rect): void {
    const now = performance.now()
    if (now - this.lastEnsure < 400) return
    this.lastEnsure = now
    const candles = this.getCandles()
    if (!candles.length) return
    const t0 = Math.max(candles[0].time, conv.xToTime(rect.x))
    const t1 = Math.min(Date.now(), conv.xToTime(rect.x + rect.width))
    if (!(t1 > t0)) return
    this.focusTime = (t0 + t1) / 2
    // from a day before the first bar: Delta Dly needs the session's earlier bars
    const from = Math.max(candles[0].time, t0 - DAY_MS)
    const key = `${Math.floor(from / DAY_MS)}|${Math.floor(t1 / DAY_MS)}`
    if (key === this.ensureKey) return
    this.ensureKey = key
    const days: number[] = []
    for (let d = Math.floor(t1 / DAY_MS) * DAY_MS; d >= Math.floor(from / DAY_MS) * DAY_MS; d -= DAY_MS) days.push(d)
    this.requestDays(days.slice(0, Math.max(1, this.opts.maxTapeDays)))
  }

  // ------------------------------------------------------------- compute ----
  private barMs(candles: Candle[]): number {
    const n = candles.length
    if (n < 2) return 60_000
    const gaps: number[] = []
    for (let i = Math.max(1, n - 50); i < n; i++) gaps.push(candles[i].time - candles[i - 1].time)
    gaps.sort((a, b) => a - b)
    return gaps[gaps.length >> 1] || 60_000
  }

  private recompute(conv: Converters, rect: Rect): void {
    const now = performance.now()
    if (now - this.lastCompute < (this.dirty ? 150 : RECOMPUTE_MS)) return
    this.lastCompute = now
    this.dirty = false
    let candles = this.getCandles()
    if (this.cutoff !== null) {
      const c = this.cutoff
      candles = candles.filter((x) => x.time < c)
    }
    if (!candles.length) {
      this.rows = []
      return
    }
    // from a day before the first visible bar (Delta Dly restarts at each session open)
    const t0 = conv.xToTime(rect.x) - DAY_MS
    let i0 = 0
    while (i0 < candles.length - 1 && candles[i0].time < t0) i0++
    const spans = [...this.recordedSpans]
    if (this.liveFrom !== null) spans.push([this.liveFrom, Infinity])
    const cut = this.cutoff
    const units = cut === null ? this.units : this.units.filter((u) => u.time < cut)
    this.rowsFrom = i0
    const row = this.opts.rowSize > 0 ? this.opts.rowSize : autoRowSize(candles[candles.length - 1].close, this.symbol)
    this.rows = computeDeepStats(candles.slice(i0), units, mergeSpans(spans), this.barMs(candles), this.symbol, this.tick, this.opts, Date.now(), row)
  }

  // ---------------------------------------------------------------- draw ----
  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      if (this.builder) for (const c of this.builder.flush(Date.now())) this.pushUnit(unitOf(c))
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

  private draw(): void {
    const dpr = window.devicePixelRatio || 1
    this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr)
    if (!this.enabled) return
    const conv = this.engine.getMainConverters()
    const main = this.engine.getMainPaneRect()
    const all = this.getCandles()
    if (!conv || !main || all.length < 2) return
    const o = this.opts
    const inPane = o.position === 'pane'
    const rect = inPane ? this.paneRect?.() ?? null : main
    if (!rect || rect.height < 8) return
    this.ensureVisibleTape(conv, main)
    this.recompute(conv, main)
    let keys = DEEP_STATS_KEYS.filter((k) => o.show[k])
    if (o.invertOrder) keys = [...keys].reverse()
    if (!keys.length) return
    // in its own pane the rows share the pane's height (resize the pane to resize them)
    const rh = inPane ? Math.max(8, Math.min(60, rect.height / keys.length)) : Math.max(10, o.rowHeight)
    const tableH = keys.length * rh
    const y0 = inPane ? rect.y : o.position === 'bottom' ? rect.y + rect.height - tableH - 2 : rect.y + 2
    const g = this.ctx
    g.save()
    g.beginPath()
    g.rect(rect.x, rect.y, rect.width, rect.height)
    g.clip()

    // visible candles and their slot width
    const xs: [number, number][] = []
    for (let i = Math.max(0, this.rowsFrom); i < all.length; i++) {
      const x = conv.timeToX(all[i].time)
      if (x < rect.x - 60 || x > rect.x + rect.width + 60) continue
      xs.push([i, x])
    }
    let slot = 8
    if (xs.length > 1) slot = Math.max(2, (xs[xs.length - 1][1] - xs[0][1]) / (xs.length - 1))
    const left = rect.x + (o.showHeader ? HEADER_W : 0)
    const ts = Math.max(7, Math.min(o.textSize, rh - 3))
    g.font = `500 ${ts}px ${FONT}`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    keys.forEach((k, r) => {
      const y = y0 + r * rh
      const vals: number[] = []
      for (const [i] of xs) {
        const row = this.rows[i - this.rowsFrom]
        if (row) vals.push(row[k])
      }
      const heat = cellIntensity(vals, k, o.devStd)
      const thr = o.thresholds[k] ?? 0
      for (const [i, x] of xs) {
        const cx = x - slot / 2
        if (cx + slot < left) continue
        const row = this.rows[i - this.rowsFrom]
        g.fillStyle = rgba(o.cellBg, 0.9)
        g.fillRect(cx, y, slot, rh)
        if (!row) continue
        const v = row[k]
        const over = thr > 0 && Math.abs(v) >= thr
        if (over) g.fillStyle = rgba(o.thresholdColor, 0.85)
        else {
          const t = heat(v)
          const col = SIGNED_STATS.has(k) ? (v >= 0 ? o.posColor : o.negColor) : o.heatColor
          g.fillStyle = rgba(col, 0.08 + 0.62 * t)
        }
        g.fillRect(cx, y, slot, rh)
        if (o.outline > 0) {
          g.strokeStyle = 'rgba(255,255,255,0.06)'
          g.lineWidth = o.outline
          g.strokeRect(cx + 0.5, y + 0.5, slot - 1, rh - 1)
        }
        const txt = fmtStat(v, k, o.autoFormat)
        if (g.measureText(txt).width + 3 <= slot) {
          g.fillStyle = over ? '#131722' : o.textColor
          g.fillText(txt, x, y + rh / 2 + 0.5)
        }
      }
    })
    if (o.showHeader) {
      g.fillStyle = o.headerBg
      g.fillRect(rect.x, y0, HEADER_W, tableH)
      g.font = `600 ${Math.max(7, Math.min(o.headerSize, rh - 3))}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
      g.textAlign = 'left'
      keys.forEach((k, r) => {
        g.fillStyle = o.headerText
        g.fillText(DEEP_STAT_LABELS[k], rect.x + 6, y0 + r * rh + rh / 2 + 0.5)
      })
      g.strokeStyle = 'rgba(255,255,255,0.08)'
      g.strokeRect(rect.x + 0.5, y0 + 0.5, HEADER_W - 1, tableH - 1)
    }
    if (this.loading) {
      g.font = `500 10px ${FONT}`
      g.textAlign = 'left'
      g.fillStyle = 'rgba(209,212,220,0.8)'
      g.fillText('Deep Stats · loading tape…', left + 6, o.position === 'bottom' ? y0 - 8 : y0 + tableH + 8)
    }
    g.restore()
  }
}
