/**
 * Volume Footprint — TradingView-style footprint candles. Each bar is split
 * into price rows ("row size"); every row shows the volume sold × bought at
 * that price (or its delta / total), with:
 *   - cell shading by the row's delta (green = buyers, red = sellers)
 *   - diagonal imbalances (TV's rule): buys at a row vs sells one row lower,
 *     sells at a row vs buys one row higher, at ≥ `imbalancePct`; three or
 *     more in a row form a "stacked imbalance" marker at the cell edge
 *   - the bar's POC (highest-volume row) outlined, its value area shaded
 *   - bar delta and total volume printed under the bar
 *   - divergence candles in yellow: a bearish candle whose delta is positive
 *     (buyers were the aggressors, yet it closed down) or a bullish candle with
 *     negative delta — aggression that failed to move price. Only bars built
 *     from exact trades qualify (an estimate cannot show a divergence), and a
 *     bar is settled when it closes: hollow yellow while forming, solid after —
 *     so a reload never changes a finished bar
 *
 * Data: bars that form while the chart is open use the real trade tape
 * (taker side = buy/sell, exact price). Older bars use the trades our own tape
 * recorder saved (recorder/tapeRecorder.mjs, /tape/trades) wherever it was
 * running — exact, so their delta and divergence candles are real. Where it
 * was not, there is no tick history on Delta, so bars are rebuilt from fine
 * sub-candles (the coarsest of 5s / 1m /
 * … giving ≥ 12 per bar): each sub-candle's volume is spread over the rows it
 * spans and split buy/sell by close location. That is an estimate, labelled as
 * such on chart. Delta serves 5s candles only for BTCUSD / ETHUSD, so when the
 * preferred resolution is refused (gold on 5m, say) the next coarser one that
 * still splits a bar is used instead.
 * Pairs with the 'footprint' chart type, which draws a slim candle at the
 * left of each slot so the cells can use the rest.
 */
import type { Candle } from '../core/types'
import type { IChartEngine } from '../chart/types'
import { buyShare } from './profileZones'
import { lazyCanvas } from './lazyCanvas'

/** 'profile' draws each bar as its own volume-at-price histogram instead of number cells. */
export type FootprintMode = 'bidask' | 'delta' | 'volume' | 'profile'

export interface FootprintOptions {
  mode: FootprintMode
  /** Price per row; 0 = auto (about `autoRows` rows across a typical bar). */
  rowSize: number
  autoRows: number
  imbalancePct: number // 300 = 3x
  valueAreaPct: number
  showPoc: boolean
  showValueArea: boolean
  showTotals: boolean
  /** How many recent bars get a history footprint (sub-candle fetch depth). */
  historyBars: number
  /** Paint bearish candles with positive delta, and bullish ones with negative delta, yellow. */
  divergenceCandles: boolean
}

export const FOOTPRINT_DEFAULTS: FootprintOptions = {
  mode: 'bidask',
  rowSize: 0,
  autoRows: 14,
  imbalancePct: 300,
  valueAreaPct: 0.7,
  showPoc: true,
  showValueArea: true,
  showTotals: true,
  historyBars: 300,
  divergenceCandles: true,
}

const DIVERGENCE_YELLOW = '#ffd600'
/** Recorded spans closer than this are treated as continuous (flush lag, reconnect). */
const SPAN_JOIN_MS = 2000

/** Sort and join time spans that touch or nearly touch. */
export function mergeSpans(spans: [number, number][], joinMs = SPAN_JOIN_MS): [number, number][] {
  const out: [number, number][] = []
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + joinMs) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** Is [t0, t1] inside one of the (merged) spans? */
export function coveredBy(spans: [number, number][], t0: number, t1: number): boolean {
  return spans.some(([a, b]) => a <= t0 && b >= t1)
}

/** A candle whose delta disagrees with its direction: down close on net buying, or up close on net selling. */
export function isDeltaDivergence(open: number, close: number, delta: number): boolean {
  return (close < open && delta > 0) || (close > open && delta < 0)
}

/** Fetches candles of `interval` ending before `endTime` (ms), newest last. */
export type SubCandleFetcher = (interval: string, limit: number, endTime: number) => Promise<Candle[]>

/** Recorded trades in [from, to] (ms): prints as [timeMs, price, qty, side ±1], and the spans actually recorded. */
export interface RecordedTape {
  prints: [number, number, number, number][]
  sessions: [number, number][]
}
export type TapeFetcher = (from: number, to: number) => Promise<RecordedTape | null>

interface Trade {
  time: number
  price: number
  qty: number
  buy: boolean
}

/** row index -> [buy, sell] */
type Rows = Map<number, [number, number]>

export interface BarStats {
  rLo: number
  rHi: number
  tot: number
  delta: number
  pocRow: number
  vaLo: number
  vaHi: number
  maxVol: number
  maxAbsD: number
}

/** Range, totals, POC and value area (grown from the POC toward the heavier neighbour) of one bar. */
export function barStats(rows: Rows, valueAreaPct: number): BarStats {
  let rLo = Infinity
  let rHi = -Infinity
  let tot = 0
  let delta = 0
  let pocRow = 0
  let pocVol = -1
  let maxAbsD = 0
  for (const [r, [b, s]] of rows) {
    rLo = Math.min(rLo, r)
    rHi = Math.max(rHi, r)
    tot += b + s
    delta += b - s
    if (b + s > pocVol) {
      pocVol = b + s
      pocRow = r
    }
    maxAbsD = Math.max(maxAbsD, Math.abs(b - s))
  }
  let vaLo = pocRow
  let vaHi = pocRow
  let cov = pocVol
  const vol = (r: number): number => {
    const e = rows.get(r)
    return e ? e[0] + e[1] : 0
  }
  while (cov < tot * valueAreaPct && (vaLo > rLo || vaHi < rHi)) {
    const up = vaHi < rHi ? vol(vaHi + 1) : -1
    const dn = vaLo > rLo ? vol(vaLo - 1) : -1
    if (up >= dn) cov += vol(++vaHi)
    else cov += vol(--vaLo)
  }
  return { rLo, rHi, tot, delta, pocRow, vaLo, vaHi, maxVol: Math.max(0, pocVol), maxAbsD }
}

const SUBS: [string, number][] = [
  ['5s', 5_000],
  ['1m', 60_000],
  ['5m', 300_000],
  ['15m', 900_000],
  ['1h', 3_600_000],
]
const MAX_TRADES = 300_000

function niceStep(x: number): number {
  if (!(x > 0)) return 1
  const p = Math.pow(10, Math.floor(Math.log10(x)))
  const m = x / p
  return (m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * p
}

function fmt(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K'
  if (a >= 100) return Math.round(v).toString()
  if (a >= 10) return v.toFixed(1)
  if (a === 0) return '0'
  return v.toFixed(2)
}

export default class FootprintOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly ro: ResizeObserver
  private opts: FootprintOptions
  private enabled = false
  private raf = 0
  private subs: Candle[] = []
  private subLabel = ''
  private liveFrom = Infinity // trades at/after this time are counted (no overlap with subs)
  private trades: Trade[] = []
  private recorded: Trade[] = [] // from the tape recorder, before liveFrom
  private recordedShare = 0 // of the history window covered by the recording
  private exact: [number, number][] = [] // where bars are built from exact trades: the recording, then live
  private early: Trade[] = [] // live trades that arrived while history was loading
  private rowSize = 0
  private bars = new Map<number, Rows>() // bar open time -> rows
  private builtFor = '' // cache key of the aggregation
  private loadGen = 0
  private barMsCache = 60_000

  constructor(
    private readonly container: HTMLElement,
    private readonly engine: IChartEngine,
    private readonly getCandles: () => Candle[],
    private readonly fetchSubs: SubCandleFetcher,
    opts?: Partial<FootprintOptions>,
    private readonly fetchTape?: TapeFetcher,
  ) {
    this.opts = { ...FOOTPRINT_DEFAULTS, ...opts }
    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '16' })
    container.appendChild(this.canvas)
    this.ctx = this.canvas.getContext('2d')!
    lazyCanvas(this.canvas, this.ctx)
    this.resize()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(r.width * dpr)
    this.canvas.height = Math.round(r.height * dpr)
    this.canvas.style.width = `${r.width}px`
    this.canvas.style.height = `${r.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  getOptions(): FootprintOptions {
    return { ...this.opts }
  }

  setOptions(patch: Partial<FootprintOptions>): void {
    const reload = patch.historyBars !== undefined && patch.historyBars !== this.opts.historyBars
    this.opts = { ...this.opts, ...patch }
    this.builtFor = ''
    if (reload && this.enabled) void this.loadHistory()
  }

  /** Turn on (loads sub-candle history) or off. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      void this.loadHistory()
      const loop = (): void => {
        if (!this.enabled) return
        this.draw()
        this.raf = requestAnimationFrame(loop)
      }
      this.raf = requestAnimationFrame(loop)
    } else {
      cancelAnimationFrame(this.raf)
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** Symbol/interval changed: drop everything; reload if on. */
  reset(): void {
    this.subs = []
    this.trades = []
    this.recorded = []
    this.recordedShare = 0
    this.exact = []
    this.early = []
    this.bars.clear()
    this.builtFor = ''
    this.liveFrom = Infinity
    if (this.enabled) void this.loadHistory()
  }

  addTrade(t: { time: number; price: number; qty: number; side: 'buy' | 'sell' }): void {
    if (!this.enabled) return
    // history still loading: keep them, so the seam between recording and live loses nothing
    if (this.liveFrom === Infinity) {
      if (this.early.length < 20_000) this.early.push({ time: t.time, price: t.price, qty: t.qty, buy: t.side === 'buy' })
      return
    }
    if (t.time < this.liveFrom) return
    this.trades.push({ time: t.time, price: t.price, qty: t.qty, buy: t.side === 'buy' })
    if (this.trades.length > MAX_TRADES) this.trades.splice(0, this.trades.length - MAX_TRADES)
    // Incremental: add straight into its bar when the aggregation is current.
    const c = this.getCandles()
    if (this.rowSize > 0 && c.length && this.builtFor) {
      const bt = this.barTimeOf(c, t.time)
      if (bt !== null) this.addTo(bt, Math.floor(t.price / this.rowSize), t.side === 'buy' ? t.qty : 0, t.side === 'buy' ? 0 : t.qty)
    }
  }

  destroy(): void {
    this.setEnabled(false)
    this.ro.disconnect()
    this.canvas.remove()
  }

  // ---- data ----------------------------------------------------------------

  private barMs(c: Candle[]): number {
    let ms = Infinity
    for (let i = Math.max(1, c.length - 20); i < c.length; i++) ms = Math.min(ms, c[i].time - c[i - 1].time)
    return isFinite(ms) && ms > 0 ? ms : 60_000
  }

  private async loadHistory(): Promise<void> {
    const gen = ++this.loadGen
    const c = this.getCandles()
    if (c.length < 2) {
      // Data not loaded yet — retry shortly.
      setTimeout(() => gen === this.loadGen && this.enabled && void this.loadHistory(), 500)
      return
    }
    const barMs = this.barMs(c)
    // Preferred: the coarsest sub resolution that still gives >= 12 sub-bars per bar.
    // Fallbacks, if the venue refuses it: coarser ones that still split a bar in two or more.
    let best = 0
    SUBS.forEach((s, i) => {
      if (barMs / s[1] >= 12) best = i
    })
    const tries = [SUBS[best], ...SUBS.slice(best + 1).filter((s) => barMs / s[1] >= 2)]
    const first = c[Math.max(0, c.length - this.opts.historyBars)].time
    const now = Date.now()
    this.liveFrom = Infinity
    this.subs = []
    this.recorded = []
    this.recordedShare = 0
    this.exact = []
    const tapeP = this.fetchTape ? this.fetchTape(first, now).catch(() => null) : Promise.resolve(null)
    for (const sub of tries) {
      try {
        const subs = await this.fetchSubs(sub[0], Math.min(60_000, Math.ceil((now - first) / sub[1]) + 10), now)
        if (gen !== this.loadGen) return
        const got = subs.filter((s) => s.time >= first && s.time < now)
        if (!got.length) continue
        this.subs = got
        this.subLabel = sub[0]
        break
      } catch {
        if (gen !== this.loadGen) return
      }
    }
    // exact recorded trades replace the estimate wherever the recorder was running
    const tape = await tapeP
    if (gen !== this.loadGen) return
    const subMs = SUBS.find((x) => x[0] === this.subLabel)?.[1] ?? 60_000
    let liveFrom = now
    if (tape && tape.prints.length) {
      const spans = mergeSpans(tape.sessions)
      const recEnd = spans.length ? spans[spans.length - 1][1] : 0
      // a recording that runs up to now hands over straight to the live feed, with no seam
      if (now - recEnd < 60_000) liveFrom = Math.min(now, recEnd)
      this.subs = this.subs.filter((s) => !coveredBy(spans, s.time, s.time + subMs) && s.time + subMs <= liveFrom)
      this.recorded = tape.prints.filter((p) => p[0] < liveFrom).map(([time, price, qty, side]) => ({ time, price, qty, buy: side > 0 }))
      this.recordedShare = spans.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, now) - Math.max(a, first)), 0) / Math.max(1, now - first)
      this.exact = mergeSpans([...spans, [liveFrom, Infinity]])
    } else this.exact = [[liveFrom, Infinity]]
    this.liveFrom = liveFrom
    this.trades = this.early.filter((t) => t.time >= liveFrom)
    this.early = []
    this.builtFor = ''
  }

  private barTimeOf(c: Candle[], t: number): number | null {
    let lo = 0
    let hi = c.length - 1
    if (t < c[0].time) return null
    // A trade can arrive before its bar's candle does: map it onto the
    // upcoming bar's open time instead of lumping it into the last bar.
    const last = c[c.length - 1].time
    if (t >= last + this.barMsCache) return last + Math.floor((t - last) / this.barMsCache) * this.barMsCache
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (c[mid].time <= t) lo = mid
      else hi = mid - 1
    }
    return c[lo].time
  }

  private addTo(barTime: number, row: number, buy: number, sell: number): void {
    let rows = this.bars.get(barTime)
    if (!rows) this.bars.set(barTime, (rows = new Map()))
    const e = rows.get(row)
    if (e) {
      e[0] += buy
      e[1] += sell
    } else rows.set(row, [buy, sell])
  }

  /** Rebuild all rows when the candles, row size, or sources changed. */
  private ensureBuilt(c: Candle[], pricePerPx: number): void {
    this.barMsCache = this.barMs(c)
    let rs = this.opts.rowSize
    if (!(rs > 0)) {
      const ranges = c.slice(-100).map((k) => k.high - k.low).sort((a, b) => a - b)
      // Fine enough for ~autoRows rows per typical bar, but never under
      // ~16px tall on screen so the sell x buy numbers stay readable.
      rs = niceStep(Math.max((ranges[ranges.length >> 1] || 1) / this.opts.autoRows, pricePerPx * 16))
    }
    const key = `${rs}|${c[0].time}|${this.subs.length}|${this.recorded.length}`
    if (key === this.builtFor) return
    this.builtFor = key
    this.rowSize = rs
    this.bars.clear()
    for (const s of this.subs) {
      const bt = this.barTimeOf(c, s.time)
      if (bt === null || !(s.volume > 0)) continue
      const r0 = Math.floor(s.low / rs)
      const r1 = Math.floor(s.high / rs)
      const per = s.volume / (r1 - r0 + 1)
      const b = buyShare(s)
      for (let r = r0; r <= r1; r++) this.addTo(bt, r, per * b, per * (1 - b))
    }
    for (const t of this.recorded) {
      const bt = this.barTimeOf(c, t.time)
      if (bt !== null) this.addTo(bt, Math.floor(t.price / rs), t.buy ? t.qty : 0, t.buy ? 0 : t.qty)
    }
    for (const t of this.trades) {
      const bt = this.barTimeOf(c, t.time)
      if (bt !== null) this.addTo(bt, Math.floor(t.price / rs), t.buy ? t.qty : 0, t.buy ? 0 : t.qty)
    }
  }

  // ---- drawing -------------------------------------------------------------

  private draw(): void {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    const c = this.getCandles()
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect || c.length < 2) return
    this.ensureBuilt(c, Math.abs(conv.yToPrice(0) - conv.yToPrice(1)))
    const rs = this.rowSize
    const spacing = Math.abs(conv.timeToX(c[c.length - 1].time) - conv.timeToX(c[c.length - 2].time))
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    ctx.font = '10px ui-monospace, monospace'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(160,170,190,0.85)'
    ctx.textAlign = 'left'
    const pct = Math.round(this.recordedShare * 100)
    const src = this.liveFrom === Infinity
      ? 'loading history…'
      : this.recorded.length && pct >= 99
        ? 'history = recorded trades (exact), live = trades'
        : this.recorded.length
          ? `history: recorded trades (exact) for ${pct}%, rest ≈ ${this.subLabel} bars (estimated)`
          : this.subs.length
            ? `history ≈ ${this.subLabel} bars (estimated), live = trades`
            : 'no history from the exchange — live trades only'
    ctx.fillText(`Footprint · row ${fmt(rs)} · ${src}`, rect.x + 8, rect.y + rect.height - 10)
    if (this.opts.divergenceCandles) this.drawDivergenceCandles(c, conv, rect, spacing)
    // a profile reads fine much narrower than number cells
    if (spacing < (this.opts.mode === 'profile' ? 6 : 14)) {
      ctx.fillText('Zoom in to see footprint cells', rect.x + 8, rect.y + rect.height - 24)
      ctx.restore()
      return
    }
    const imb = this.opts.imbalancePct / 100
    for (let i = c.length - 1; i >= 0; i--) {
      const k = c[i]
      const xc = conv.timeToX(k.time)
      if (xc < rect.x - spacing) break
      if (xc > rect.x + rect.width + spacing) continue
      const rows = this.bars.get(k.time)
      if (!rows || rows.size === 0) continue
      this.drawBar(k, rows, xc, spacing, conv, imb, this.isExact(k.time, Math.min(k.time + this.barMsCache, Date.now())))
    }
    ctx.restore()
  }

  /**
   * Repaint the chart type's slim candle in yellow where the bar's delta
   * disagrees with its direction — same geometry as drawFootprintCandles, so
   * it sits exactly over it. Drawn at every zoom level.
   */
  private drawDivergenceCandles(c: Candle[], conv: { timeToX(t: number): number; priceToY(p: number): number }, rect: { x: number; width: number }, spacing: number): void {
    const ctx = this.ctx
    const bodyW = Math.max(1, Math.min(8, Math.round(spacing * 0.08)))
    const now = Date.now()
    ctx.fillStyle = DIVERGENCE_YELLOW
    ctx.strokeStyle = DIVERGENCE_YELLOW
    ctx.lineWidth = 1.5
    for (let i = c.length - 1; i >= 0; i--) {
      const k = c[i]
      const xc = conv.timeToX(k.time)
      if (xc < rect.x - spacing) break
      if (xc > rect.x + rect.width + spacing) continue
      const rows = this.bars.get(k.time)
      if (!rows) continue
      let delta = 0
      for (const [b, s] of rows.values()) delta += b - s
      const end = k.time + this.barMsCache
      if (!this.isExact(k.time, Math.min(end, now)) || !isDeltaDivergence(k.open, k.close, delta)) continue
      const x = Math.round(xc - spacing * 0.38)
      const yH = Math.round(conv.priceToY(k.high))
      const yL = Math.round(conv.priceToY(k.low))
      ctx.fillRect(x, yH, 1, Math.max(1, yL - yH))
      const yO = Math.round(conv.priceToY(k.open))
      const yC = Math.round(conv.priceToY(k.close))
      const bx = Math.round(x - bodyW / 2), by = Math.min(yO, yC), bh = Math.max(1, Math.abs(yC - yO))
      // still forming: provisional (hollow); closed: settled (solid)
      if (end > now) ctx.strokeRect(bx - 1.5, by - 1.5, bodyW + 3, bh + 3)
      else ctx.fillRect(bx, by, bodyW, bh)
    }
  }

  /** Was this stretch built from exact trades (the recording, or the live feed)? */
  private isExact(t0: number, t1: number): boolean {
    return coveredBy(this.exact, t0, t1)
  }

  private drawBar(
    k: Candle,
    rows: Rows,
    xc: number,
    spacing: number,
    conv: { priceToY(p: number): number },
    imb: number,
    exact: boolean,
  ): void {
    const ctx = this.ctx
    const rs = this.rowSize
    const o = this.opts
    const x0 = xc - spacing * 0.3
    const w = spacing * 0.76
    const { rLo, rHi, tot, delta, pocRow, vaLo, vaHi, maxVol, maxAbsD } = barStats(rows, o.valueAreaPct)
    const yOf = (p: number): number => conv.priceToY(p)
    const rowH = Math.abs(yOf(rs) - yOf(0))
    if (o.mode === 'profile') {
      this.drawProfile(rows, x0, w, rowH, yOf, { rLo, rHi, pocRow, vaLo, vaHi, maxVol })
      this.drawTotals(k, x0, w, rLo, yOf, delta, tot, exact)
      return
    }
    const text = rowH >= 9 && w >= 44
    const fontPx = Math.max(8, Math.min(12, rowH * 0.7))
    ctx.textBaseline = 'middle'
    let stackB = 0
    let stackS = 0
    for (let r = rLo; r <= rHi; r++) {
      const [b, s] = rows.get(r) ?? [0, 0]
      const yT = yOf((r + 1) * rs)
      const yB = yOf(r * rs)
      const h = Math.max(1, yB - yT - (rowH > 4 ? 1 : 0))
      const d = b - s
      // Cell background.
      if (o.mode === 'volume') {
        ctx.fillStyle = `rgba(74,158,255,${0.08 + 0.5 * ((b + s) / (maxVol || 1))})`
      } else {
        const a = 0.08 + 0.55 * (Math.abs(d) / (maxAbsD || 1))
        ctx.fillStyle = d >= 0 ? `rgba(14,203,129,${a})` : `rgba(246,70,93,${a})`
      }
      ctx.fillRect(x0, yT, w, h)
      if (o.showValueArea && r >= vaLo && r <= vaHi) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)'
        ctx.fillRect(x0, yT, w, h)
      }
      // Diagonal imbalances (row below's sells vs this row's buys, etc).
      const belowSell = rows.get(r - 1)?.[1] ?? 0
      const aboveBuy = rows.get(r + 1)?.[0] ?? 0
      const buyImb = b > 0 && belowSell > 0 && b >= imb * belowSell
      const sellImb = s > 0 && aboveBuy > 0 && s >= imb * aboveBuy
      stackB = buyImb ? stackB + 1 : 0
      stackS = sellImb ? stackS + 1 : 0
      if (stackB >= 3) {
        ctx.fillStyle = '#0ecb81'
        ctx.fillRect(x0 + w + 1, yT, 3, (yB - yT) * 3)
      }
      if (stackS >= 3) {
        ctx.fillStyle = '#f6465d'
        ctx.fillRect(x0 - 4, yT, 3, (yB - yT) * 3)
      }
      if (text) {
        const cy = (yT + yB) / 2
        if (o.mode === 'bidask') {
          ctx.textAlign = 'right'
          ctx.font = `${sellImb ? 'bold ' : ''}${fontPx}px ui-monospace, monospace`
          ctx.fillStyle = sellImb ? '#ff5c70' : '#d8dce6'
          ctx.fillText(fmt(s), x0 + w / 2 - 4, cy)
          ctx.textAlign = 'left'
          ctx.font = `${buyImb ? 'bold ' : ''}${fontPx}px ui-monospace, monospace`
          ctx.fillStyle = buyImb ? '#2ee59d' : '#d8dce6'
          ctx.fillText(fmt(b), x0 + w / 2 + 4, cy)
          ctx.fillStyle = 'rgba(160,170,190,0.6)'
          ctx.textAlign = 'center'
          ctx.font = `${fontPx}px ui-monospace, monospace`
          ctx.fillText('x', x0 + w / 2, cy)
        } else {
          ctx.textAlign = 'center'
          ctx.font = `${fontPx}px ui-monospace, monospace`
          ctx.fillStyle = '#e6e9f0'
          ctx.fillText(o.mode === 'delta' ? (d > 0 ? '+' : '') + fmt(d) : fmt(b + s), x0 + w / 2, cy)
        }
      }
    }
    if (o.showPoc) {
      ctx.strokeStyle = '#ffc107'
      ctx.lineWidth = 1.5
      const yT = yOf((pocRow + 1) * rs)
      const yB = yOf(pocRow * rs)
      ctx.strokeRect(x0 + 0.5, yT + 0.5, w - 1, Math.max(1, yB - yT - 1))
    }
    this.drawTotals(k, x0, w, rLo, yOf, delta, tot, exact)
  }

  private drawTotals(k: Candle, x0: number, w: number, rLo: number, yOf: (p: number) => number, delta: number, tot: number, exact: boolean): void {
    if (!this.opts.showTotals || w < 30) return
    const ctx = this.ctx
    const y = yOf(Math.min(k.low, rLo * this.rowSize)) + 10
    ctx.font = '10px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = delta >= 0 ? '#0ecb81' : '#f6465d'
    // ≈ marks an estimated bar: its delta is a guess from candle shape, not trades
    ctx.fillText(`${exact ? 'Δ' : '≈Δ'} ${delta > 0 ? '+' : ''}${fmt(delta)}`, x0 + w / 2, y)
    ctx.fillStyle = 'rgba(200,205,215,0.8)'
    ctx.fillText(`V ${fmt(tot)}`, x0 + w / 2, y + 12)
  }

  /**
   * The bar's own volume profile: one horizontal bar per row, growing right
   * from the slot's left edge, length = row volume / bar's POC volume. Each is
   * split sell (red) then buy (green); rows inside the value area are brighter,
   * the POC row is amber.
   */
  private drawProfile(
    rows: Rows,
    x0: number,
    w: number,
    rowH: number,
    yOf: (p: number) => number,
    s: Pick<BarStats, 'rLo' | 'rHi' | 'pocRow' | 'vaLo' | 'vaHi' | 'maxVol'>,
  ): void {
    const ctx = this.ctx
    const o = this.opts
    const rs = this.rowSize
    const text = rowH >= 9 && w >= 44
    ctx.font = `${Math.max(8, Math.min(11, rowH * 0.7))}px ui-monospace, monospace`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    for (let r = s.rLo; r <= s.rHi; r++) {
      const [b, sl] = rows.get(r) ?? [0, 0]
      if (b + sl <= 0) continue
      const yT = yOf((r + 1) * rs)
      const yB = yOf(r * rs)
      const h = Math.max(1, yB - yT - (rowH > 4 ? 1 : 0))
      const len = (w * (b + sl)) / (s.maxVol || 1)
      const sellLen = len * (sl / (b + sl))
      const inVa = !o.showValueArea || (r >= s.vaLo && r <= s.vaHi)
      const isPoc = o.showPoc && r === s.pocRow
      if (isPoc) {
        ctx.fillStyle = 'rgba(255,193,7,0.85)'
        ctx.fillRect(x0, yT, len, h)
      } else {
        const a = inVa ? 0.7 : 0.3
        ctx.fillStyle = `rgba(246,70,93,${a})`
        ctx.fillRect(x0, yT, sellLen, h)
        ctx.fillStyle = `rgba(14,203,129,${a})`
        ctx.fillRect(x0 + sellLen, yT, len - sellLen, h)
      }
      if (text) {
        // long bars carry their number inside, short ones just past the end
        const inside = len > w - 30
        ctx.textAlign = inside ? 'right' : 'left'
        ctx.fillStyle = inside ? (isPoc ? '#1a1300' : '#ffffff') : 'rgba(216,220,230,0.75)'
        ctx.fillText(fmt(b + sl), inside ? x0 + len - 3 : x0 + len + 3, (yT + yB) / 2)
      }
    }
    if (o.showValueArea && s.vaHi > s.vaLo) {
      // value area edges, so VAH/VAL read even when shading is subtle
      ctx.fillStyle = 'rgba(200,205,215,0.5)'
      ctx.fillRect(x0, Math.round(yOf((s.vaHi + 1) * rs)), w, 1)
      ctx.fillRect(x0, Math.round(yOf(s.vaLo * rs)), w, 1)
    }
  }
}
