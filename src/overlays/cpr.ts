/**
 * CPR & Pivots — Central Pivot Range (P / TC / BC), floor pivots R1–R4 /
 * S1–S4 and the previous period's high/low, for Day, Week or Month periods.
 * Each period's levels are drawn across that period only, for the last N
 * periods, so earlier sessions can be checked against what actually printed.
 *
 * Levels are anchored to the latest chart bar rather than the wall clock, so
 * bar replay shows the levels of the day being replayed with no look-ahead.
 * The math lives in cprModel.ts; this file fetches, follows live candles and
 * draws. The canvas only repaints when the viewport or the levels change.
 */
import type { IChartEngine, PriceTag } from '../chart/types'
import { sessionClosedWeekends, sessionOpenHourUTC } from '../core/session'
import { HOUR_MS, PERIOD_HOURS, computeLevels, periodBounds, type CprTimeframe, type OHLCBar, type PeriodLevels, type PivotType } from './cprModel'
import { lazyCanvas } from './lazyCanvas'

export type { CprTimeframe, PivotType } from './cprModel'

export interface CprOptions {
  enabled: boolean
  timeframe: CprTimeframe
  pivotType: PivotType
  periods: number // periods drawn, the current one included
  sessionStartHourUTC: number | null // null = the symbol's own session open (core/session.ts)
  showCpr: boolean
  levels: number // R/S pairs drawn: 0 (none) … 4 (R4/S4)
  showPrevHL: boolean
  showLabels: boolean // level names inside the chart, at each line's left end
  showTags: boolean // current period's levels on the price scale
  cprColor: string
  resColor: string
  supColor: string
  prevHLColor: string
  refreshMs: number
}

export interface CprSources {
  /** Ascending 1h bars for the chart's current symbol, ending before `endTime` (now when omitted). */
  fetchHourly(limit: number, endTime?: number): Promise<OHLCBar[]>
}

export interface CprSummary {
  pivot: number
  tc: number
  bc: number
  prevHigh: number
  prevLow: number
  width: number
  /** Width against recent periods' median: a narrow CPR often precedes a trending session. */
  widthClass: 'narrow' | 'wide' | 'normal' | null
}

const DEFAULTS: CprOptions = {
  enabled: false,
  timeframe: 'day',
  pivotType: 'traditional',
  periods: 5,
  sessionStartHourUTC: null,
  showCpr: true,
  levels: 4,
  showPrevHL: true,
  showLabels: false,
  showTags: true,
  cprColor: '#2962ff',
  resColor: '#f23645',
  supColor: '#089981',
  prevHLColor: '#ff9800',
  refreshMs: 300_000,
}

export const MAX_PERIODS = 10
const WIDTH_HISTORY = 20 // periods behind the narrow/wide verdict (Day only — longer timeframes would need years of 1h bars)
const TAG_SOURCE = 'cpr'
const FONT = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

export const CPR_TIMEFRAME_LABEL: Record<CprTimeframe, string> = { day: 'Day', week: 'Week', month: 'Month' }
export const PREV_HL_LABEL: Record<CprTimeframe, [string, string]> = { day: ['PDH', 'PDL'], week: ['PWH', 'PWL'], month: ['PMH', 'PML'] }
const TF_PREFIX: Record<CprTimeframe, string> = { day: '', week: 'W ', month: 'M ' }

interface Seg {
  color: string
  width: number
  dash: number[]
  alpha: number
  pts: number[] // x0, x1, y triples
}

const plain = (b: OHLCBar): OHLCBar => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })

export default class CprOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly sources: CprSources
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly ro: ResizeObserver
  private opts: CprOptions
  private symbol = ''
  private bars: OHLCBar[] = []
  private anchor = 0 // time of the latest chart bar; 0 until the chart has data (→ now)
  private levels: PeriodLevels[] = []
  private widthClass: CprSummary['widthClass'] = null
  private status = 'idle'
  private gen = 0
  private lastFetchKey = ''
  private raf = 0
  private pollTimer: number | null = null
  private drawKey = ''

  constructor(container: HTMLElement, engine: IChartEngine, sources: CprSources, opts?: Partial<CprOptions>) {
    this.container = container
    this.engine = engine
    this.sources = sources
    this.opts = { ...DEFAULTS, ...opts }
    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '14', display: 'none' })
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
    this.drawKey = ''
  }

  getOptions(): CprOptions {
    return { ...this.opts }
  }

  setOptions(patch: Partial<CprOptions>): void {
    const prev = this.opts
    this.opts = { ...this.opts, ...patch }
    this.opts.periods = Math.max(1, Math.min(MAX_PERIODS, Math.round(this.opts.periods)))
    this.drawKey = ''
    if (!this.opts.enabled) return this.publishTags()
    this.recompute() // instant from cached bars; ensureHistory tops up if the new setting needs more
    void this.ensureHistory()
    if (patch.refreshMs !== undefined && patch.refreshMs !== prev.refreshMs) this.startPolling()
  }

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return
    this.symbol = symbol
    this.bars = []
    this.anchor = 0
    this.lastFetchKey = ''
    this.gen++ // drop any in-flight load for the old symbol
    this.recompute()
    if (this.opts.enabled) void this.ensureHistory()
  }

  setEnabled(on: boolean): void {
    this.opts.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    this.drawKey = ''
    if (on) {
      this.recompute()
      void this.ensureHistory()
      this.startPolling()
      if (!this.raf) {
        const loop = (): void => {
          this.draw()
          this.raf = this.opts.enabled ? requestAnimationFrame(loop) : 0
        }
        this.raf = requestAnimationFrame(loop)
      }
    } else {
      this.stopPolling()
      this.publishTags()
    }
  }

  /**
   * The chart's latest bar time — call after loading or moving the replay
   * cursor. Levels only change when this crosses into another period.
   */
  setAnchor(time: number): void {
    const before = this.anchor
    this.anchor = time
    if (!this.opts.enabled) return
    const tf = this.opts.timeframe
    const h = this.hour()
    if (before && periodBounds(before, tf, h)[0] === periodBounds(time, tf, h)[0]) return
    this.recompute()
    void this.ensureHistory()
  }

  /**
   * Live candle from the chart's own stream: folded into the 1h history so the
   * period about to close is complete the moment the next one opens.
   */
  onCandle(c: OHLCBar, intervalMs: number): void {
    if (!this.opts.enabled || this.bars.length === 0) return
    // Bars longer than an hour (4h/1d charts) may span a period boundary — only their last price is safe to use.
    const fine = intervalMs <= HOUR_MS
    const t = Math.floor((fine ? c.time : Math.max(c.time, Date.now())) / HOUR_MS) * HOUR_MS
    const hi = fine ? c.high : c.close
    const lo = fine ? c.low : c.close
    const last = this.bars[this.bars.length - 1]
    if (t === last.time) {
      last.high = Math.max(last.high, hi)
      last.low = Math.min(last.low, lo)
      last.close = c.close
    } else if (t > last.time) {
      this.bars.push({ time: t, open: fine ? c.open : c.close, high: hi, low: lo, close: c.close })
    }
    this.setAnchor(Math.max(this.anchor, c.time))
  }

  destroy(): void {
    this.opts.enabled = false
    this.gen++
    this.stopPolling()
    if (this.raf) cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.canvas.remove()
    this.engine.setPriceTags(TAG_SOURCE, [])
  }

  /** UTC hour the trading day opens: the explicit setting, else the symbol's session (03:30 IST for gold). */
  hour(): number {
    return this.opts.sessionStartHourUTC ?? sessionOpenHourUTC(this.symbol)
  }

  getStatus(): string {
    return this.status
  }

  /** The current period's key levels for the legend; null until they exist. */
  getSummary(): CprSummary | null {
    const cur = this.levels[this.levels.length - 1]
    if (!cur) return null
    return { pivot: cur.pivot, tc: cur.tc, bc: cur.bc, prevHigh: cur.prevHigh, prevLow: cur.prevLow, width: cur.width, widthClass: this.widthClass }
  }

  // ---- data ----

  private now(): number {
    return this.anchor || Date.now()
  }

  /** Start of the earliest period needed (the oldest drawn period's own previous period). */
  private requiredStart(): number {
    const o = this.opts
    let want = o.timeframe === 'day' ? Math.max(o.periods, WIDTH_HISTORY) : o.periods
    if (o.timeframe === 'day' && sessionClosedWeekends(this.symbol)) want = Math.ceil((want * 7) / 5) + 2 // weekends don't count
    let start = periodBounds(this.now(), o.timeframe, this.hour())[0]
    for (let i = 0; i < want; i++) start = periodBounds(start - 1, o.timeframe, this.hour())[0]
    return start
  }

  /** Fetch 1h history when the cache doesn't span what the current settings and anchor need. */
  private async ensureHistory(): Promise<void> {
    if (!this.opts.enabled || !this.symbol) return
    const o = this.opts
    const need = this.requiredStart()
    const [curStart, curEnd] = periodBounds(this.now(), o.timeframe, this.hour())
    const first = this.bars[0]?.time ?? Infinity
    const last = this.bars[this.bars.length - 1]?.time ?? -Infinity
    // Covered when the cache reaches back to `need` and forward to the end of the period before the anchor's.
    if (first <= need + HOUR_MS && last >= curStart - HOUR_MS) return
    const live = Date.now() - this.now() < PERIOD_HOURS[o.timeframe] * HOUR_MS
    const end = live ? Date.now() : Math.min(Date.now(), curEnd)
    const limit = Math.ceil((end - need) / HOUR_MS) + 2
    const key = `${this.symbol}:${need}:${live ? 'live' : end}`
    if (key === this.lastFetchKey) return // asked already — a young listing simply has no older bars
    this.lastFetchKey = key
    const gen = ++this.gen
    this.status = 'loading…'
    try {
      const bars = await this.sources.fetchHourly(limit, live ? undefined : end)
      if (gen !== this.gen) return
      this.bars = bars.map(plain)
      this.status = 'live'
      this.recompute()
    } catch (err) {
      if (gen !== this.gen) return
      this.lastFetchKey = '' // let the next trigger retry
      this.status = 'history unavailable'
      console.warn('[cpr]', err)
    }
  }

  /** Periodic top-up of the last two days, in case the live stream missed a bar. */
  private async refresh(): Promise<void> {
    if (!this.opts.enabled || this.bars.length === 0) return
    if (Date.now() - this.now() > 2 * HOUR_MS) return // replaying the past — nothing new to fetch
    const gen = this.gen
    try {
      const recent = await this.sources.fetchHourly(48)
      if (gen !== this.gen || recent.length === 0) return
      const from = recent[0].time
      this.bars = [...this.bars.filter((b) => b.time < from), ...recent.map(plain)]
      this.recompute()
    } catch (err) {
      console.warn('[cpr] refresh', err)
    }
  }

  private startPolling(): void {
    this.stopPolling()
    if (this.opts.enabled) this.pollTimer = window.setInterval(() => void this.refresh(), this.opts.refreshMs)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private recompute(): void {
    const o = this.opts
    const anchor = this.now()
    const history = o.timeframe === 'day' ? Math.max(o.periods, WIDTH_HISTORY + 1) : o.periods
    const all = this.bars.length ? computeLevels(this.bars, o.timeframe, this.hour(), history, anchor, o.pivotType, sessionClosedWeekends(this.symbol)) : []
    const curStart = periodBounds(anchor, o.timeframe, this.hour())[0]
    this.levels = all.slice(-o.periods)
    this.widthClass = null
    const cur = this.levels[this.levels.length - 1]
    if (cur && cur.start === curStart && o.timeframe === 'day') {
      // Today's width against the median of the completed sessions before it.
      const widths = all
        .filter((l) => l.start < curStart)
        .map((l) => l.width)
        .sort((a, b) => a - b)
      if (widths.length >= 8) {
        const med = widths[Math.floor(widths.length / 2)]
        this.widthClass = cur.width < med * 0.6 ? 'narrow' : cur.width > med * 1.6 ? 'wide' : 'normal'
      }
    }
    this.drawKey = ''
    this.publishTags()
  }

  // ---- drawing ----

  private draw(): void {
    if (!this.opts.enabled) return
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    const first = this.levels[0]
    const cur = this.levels[this.levels.length - 1]
    // Repaint only when the viewport moved/zoomed (two reference points per axis catch both) or the levels changed.
    const key =
      conv && rect && first && cur
        ? `${rect.x},${rect.y},${rect.width},${rect.height},${conv.timeToX(first.start).toFixed(1)},${conv.timeToX(cur.end).toFixed(1)},${conv.priceToY(cur.pivot).toFixed(1)},${conv.priceToY(cur.r[0]).toFixed(1)}`
        : 'empty'
    if (key === this.drawKey) return
    this.drawKey = key

    const ctx = this.ctx
    const dpr = window.devicePixelRatio || 1
    ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr)
    if (!conv || !rect || !cur) return

    const o = this.opts
    const right = rect.x + rect.width
    const segs = new Map<string, Seg>()
    const labels: { x: number; y: number; text: string; color: string; alpha: number }[] = []
    const line = (x0: number, x1: number, price: number, color: string, width: number, dash: number[], alpha: number, label: string): void => {
      const y = Math.round(conv.priceToY(price)) + 0.5
      if (y < rect.y - 1 || y > rect.y + rect.height + 1) return
      const k = `${color}|${width}|${dash.join(',')}|${alpha}`
      let s = segs.get(k)
      if (!s) segs.set(k, (s = { color, width, dash, alpha, pts: [] }))
      s.pts.push(x0, x1, y)
      if (o.showLabels) labels.push({ x: x0 + 4, y: y - 2, text: label, color, alpha })
    }

    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    const [phLabel, plLabel] = PREV_HL_LABEL[o.timeframe]
    const pre = TF_PREFIX[o.timeframe]
    for (const lv of this.levels) {
      const isCur = lv === cur
      const x0 = Math.max(rect.x, conv.timeToX(lv.start))
      const xEnd = conv.timeToX(lv.end)
      const x1 = Number.isFinite(xEnd) ? Math.min(right, xEnd) : right
      if (x1 <= rect.x || x0 >= right || x1 - x0 < 2) continue
      const a = isCur ? 1 : 0.5

      if (o.showCpr) {
        const yT = conv.priceToY(lv.tc)
        const yB = conv.priceToY(lv.bc)
        ctx.globalAlpha = isCur ? 0.14 : 0.07
        ctx.fillStyle = o.cprColor
        ctx.fillRect(x0, Math.min(yT, yB), x1 - x0, Math.max(1, Math.abs(yB - yT)))
        line(x0, x1, lv.pivot, o.cprColor, 1.5, [], a, `${pre}P`)
        line(x0, x1, lv.tc, o.cprColor, 1, [], a * 0.8, `${pre}TC`)
        line(x0, x1, lv.bc, o.cprColor, 1, [], a * 0.8, `${pre}BC`)
      }
      for (let i = 0; i < o.levels; i++) {
        const ai = a * (1 - i * 0.12) // R1/S1 strongest, fading outward
        line(x0, x1, lv.r[i], o.resColor, 1, [], ai, `${pre}R${i + 1}`)
        line(x0, x1, lv.s[i], o.supColor, 1, [], ai, `${pre}S${i + 1}`)
      }
      if (o.showPrevHL) {
        line(x0, x1, lv.prevHigh, o.prevHLColor, 1.2, [6, 4], a, phLabel)
        line(x0, x1, lv.prevLow, o.prevHLColor, 1.2, [6, 4], a, plLabel)
      }
    }

    // One stroke per style instead of one per line.
    for (const s of segs.values()) {
      ctx.globalAlpha = s.alpha
      ctx.strokeStyle = s.color
      ctx.lineWidth = s.width
      ctx.setLineDash(s.dash)
      ctx.beginPath()
      for (let i = 0; i < s.pts.length; i += 3) {
        ctx.moveTo(s.pts[i], s.pts[i + 2])
        ctx.lineTo(s.pts[i + 1], s.pts[i + 2])
      }
      ctx.stroke()
    }
    ctx.setLineDash([])
    if (labels.length) {
      ctx.font = FONT
      ctx.textBaseline = 'bottom'
      for (const l of labels) {
        ctx.globalAlpha = l.alpha
        ctx.fillStyle = l.color
        ctx.fillText(l.text, l.x, l.y)
      }
    }
    ctx.restore()
  }

  /** The current period's levels as price-scale tags. */
  private publishTags(): void {
    const o = this.opts
    const cur = this.levels[this.levels.length - 1]
    if (!o.enabled || !o.showTags || !cur) {
      this.engine.setPriceTags(TAG_SOURCE, [])
      return
    }
    const pre = TF_PREFIX[o.timeframe]
    const [phLabel, plLabel] = PREV_HL_LABEL[o.timeframe]
    const tags: PriceTag[] = []
    for (let i = o.levels - 1; i >= 0; i--) tags.push({ price: cur.r[i], color: o.resColor, label: `${pre}R${i + 1}` })
    if (o.showCpr) {
      tags.push({ price: cur.tc, color: o.cprColor, label: `${pre}TC` })
      tags.push({ price: cur.pivot, color: o.cprColor, label: `${pre}P` })
      tags.push({ price: cur.bc, color: o.cprColor, label: `${pre}BC` })
    }
    for (let i = 0; i < o.levels; i++) tags.push({ price: cur.s[i], color: o.supColor, label: `${pre}S${i + 1}` })
    if (o.showPrevHL) {
      tags.push({ price: cur.prevHigh, color: o.prevHLColor, label: phLabel })
      tags.push({ price: cur.prevLow, color: o.prevHLColor, label: plLabel })
    }
    this.engine.setPriceTags(TAG_SOURCE, tags)
  }
}
