/**
 * DeepCharts Big Trades — ported from "bigtrades-Deepcharts.pine" (v5 indicator).
 *
 * A candle holds a "big trade" when its approximated delta,
 * volume × (close − open) / (high − low), exceeds `mult` × its `len`-bar SMA
 * (by absolute value). The big trade's price is the hl2 of the highest-volume
 * 1-minute bar inside the candle (Pine: request.security_lower_tf), and where
 * that price sits in the candle names the pattern:
 *
 *   bullish candle                          bearish candle
 *   in body, lower `bodyZone` → Abs (cont)  in body, upper `bodyZone` → Abs (cont)
 *   in body, above it         → Accept      in body, below it         → Accept
 *   upper wick, far part      → Abs (contra) lower wick, far part     → Abs (contra)
 *   upper wick, near body     → Reject      lower wick, near body     → Reject
 *
 * A circle marks the big trade price (teal / magenta per the source's colour
 * table) and a zone extends from it — until the next big trade, or a fixed
 * number of bars. "Biggest only" keeps one zone per session (UTC day).
 *
 * Without 1m bars (the fetch failed, or history older than the 1m window) the
 * source falls back to the candle's close as the big-trade price; so does
 * this port. On a ≤1m chart each candle is its own lower-TF bar.
 * Thin-zone thickness is in ticks; the tick is inferred from the prices'
 * decimals since Delta symbols carry no syminfo.mintick here.
 */
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { Candle } from '../core/types'
import { sessionIndex, sessionOpenHourUTC } from '../core/session'
import { lazyCanvas } from './lazyCanvas'

type Rect = { x: number; y: number; width: number; height: number }

const MIN_MS = 60_000
const EPS = 1e-9

export type DcPattern = 'absCont' | 'accept' | 'absContra' | 'reject'
export type DcZoneSource = 'thin' | 'ltfBar' | 'body' | 'range'
export type DcExtMode = 'untilNext' | 'fixed'

export interface DcBigTradesOptions {
  len: number
  mult: number
  /** 0.05–0.9: share of the body, from the side the candle opened, that counts as absorption. */
  bodyZone: number
  /** 0.1–0.9: wick split; the far part is contrarian absorption. */
  wickSplit: number
  /** Circle transparency 0–100 (Pine convention). */
  transp: number
  showAbsCont: boolean
  showAccept: boolean
  showAbsContra: boolean
  showReject: boolean
  tealColor: string
  magentaColor: string
  showZones: boolean
  maxZones: number
  biggestOnly: boolean
  zoneSource: DcZoneSource
  thickTicks: number
  extMode: DcExtMode
  extBars: number
  resetSession: boolean
  zoneTransp: number
  zoneBorder: boolean
  zoneBorderTransp: number
  zoneLabel: boolean
  /** Panel with the latest signal and bias on 3m / 5m / 15m / 30m / 1h and a weighted suggestion. */
  showBiasPanel: boolean
  /** Fixed corner of the price pane the panel sits in (left of the price axis). */
  biasPanelPos: DcBiasPanelPos
}

export type DcBiasPanelPos = 'topRight' | 'bottomRight'

export const DC_BIG_TRADES_DEFAULTS: DcBigTradesOptions = {
  len: 14,
  mult: 1.8,
  bodyZone: 0.33,
  wickSplit: 0.5,
  transp: 40,
  showAbsCont: true,
  showAccept: true,
  showAbsContra: true,
  showReject: true,
  tealColor: '#00bcd4', // color.aqua
  magentaColor: '#e040fb', // color.fuchsia
  showZones: true,
  maxZones: 20,
  biggestOnly: false,
  zoneSource: 'thin',
  thickTicks: 2,
  extMode: 'untilNext',
  extBars: 10,
  resetSession: false,
  zoneTransp: 40,
  zoneBorder: false,
  zoneBorderTransp: 40,
  zoneLabel: false,
  showBiasPanel: true,
  biasPanelPos: 'topRight',
}

export interface DcMark {
  time: number
  price: number
  pattern: DcPattern
  /** Candle direction. */
  bull: boolean
  color: 'teal' | 'magenta'
  /** The source's alert bias: what the pattern expects next. */
  bias: 'bull' | 'bear'
}

export interface DcZone {
  startTime: number
  /** Right edge as a time (may lie one bar past the last candle while live). */
  endTime: number
  top: number
  bottom: number
  color: 'teal' | 'magenta'
  label: string
}

export interface DcResult {
  marks: DcMark[]
  zones: DcZone[]
}

export const DC_PATTERN_LABEL: Record<DcPattern, string> = { absCont: 'Abs (cont)', accept: 'Accept', absContra: 'Abs (contra)', reject: 'Reject' }

/** Smallest price step implied by the candles' decimals (capped at 8). */
export function inferTick(candles: Candle[]): number {
  let dec = 0
  for (let i = Math.max(0, candles.length - 200); i < candles.length; i++) {
    for (const v of [candles[i].open, candles[i].high, candles[i].low, candles[i].close]) {
      while (dec < 8) {
        const scaled = v * 10 ** dec
        if (Math.abs(scaled - Math.round(scaled)) < 1e-6 * Math.max(1, Math.abs(scaled))) break
        dec++
      }
    }
  }
  return 10 ** -dec
}

interface LtfPick {
  price: number
  top: number
  bot: number
}

/** Per chart bar: the first max-volume 1m bar inside it, or null. */
function ltfPicks(candles: Candle[], ltf: Candle[] | null, barMs: number): (LtfPick | null)[] {
  if (barMs <= MIN_MS) return candles.map((c) => ({ price: (c.high + c.low) / 2, top: c.high, bot: c.low }))
  const out: (LtfPick | null)[] = new Array(candles.length).fill(null)
  if (!ltf || ltf.length === 0) return out
  let j = 0
  for (let i = 0; i < candles.length; i++) {
    const t0 = candles[i].time
    const t1 = i + 1 < candles.length ? Math.min(candles[i + 1].time, t0 + barMs) : t0 + barMs
    while (j < ltf.length && ltf[j].time < t0) j++
    let best = -1
    for (let k = j; k < ltf.length && ltf[k].time < t1; k++) if (best < 0 || ltf[k].volume > ltf[best].volume) best = k
    if (best >= 0) out[i] = { price: (ltf[best].high + ltf[best].low) / 2, top: ltf[best].high, bot: ltf[best].low }
  }
  return out
}

/** Pure port of the indicator over a whole candle array. */
export function computeDcBigTrades(candles: Candle[], ltf: Candle[] | null, o: DcBigTradesOptions, barMs = MIN_MS, openHourUTC = 0): DcResult {
  const n = candles.length
  const marks: DcMark[] = []
  if (n === 0) return { marks, zones: [] }
  const tick = inferTick(candles)
  const picks = ltfPicks(candles, ltf, barMs)
  const timeAt = (idx: number): number => (idx < n ? candles[idx].time : candles[n - 1].time + (idx - n + 1) * barMs)
  const shown: Record<DcPattern, boolean> = { absCont: o.showAbsCont, accept: o.showAccept, absContra: o.showAbsContra, reject: o.showReject }

  interface Box {
    left: number
    right: number
    top: number
    bottom: number
    color: 'teal' | 'magenta'
    label: string
  }
  const zones: Box[] = []
  let active: Box | null = null
  let sessZone: Box | null = null
  let sessBigAbs = 0
  let curDay = NaN

  const absDelta: number[] = new Array(n)
  let sum = 0

  for (let i = 0; i < n; i++) {
    const c = candles[i]
    absDelta[i] = Math.abs((c.volume * (c.close - c.open)) / (c.high - c.low + EPS))
    sum += absDelta[i]
    if (i >= o.len) sum -= absDelta[i - o.len]
    const bigTrade = i >= o.len - 1 && absDelta[i] > (sum / o.len) * o.mult

    const day = sessionIndex(c.time, openHourUTC)
    if (day !== curDay) {
      curDay = day
      sessBigAbs = 0
      sessZone = null
      if (o.resetSession && active) {
        active.right = i
        active = null
      }
    }

    const isBull = c.close > c.open
    const isBear = c.close < c.open
    let pattern: DcPattern | null = null
    let bigPrice = c.close
    let ltfTop = c.high
    let ltfBot = c.low
    if (bigTrade && (isBull || isBear)) {
      const p = picks[i]
      if (p) {
        bigPrice = p.price
        ltfTop = p.top
        ltfBot = p.bot
      }
      const clamp = (v: number): number => Math.max(c.low, Math.min(c.high, v))
      bigPrice = clamp(bigPrice)
      ltfTop = clamp(ltfTop)
      ltfBot = clamp(ltfBot)
      const bodyTop = Math.max(c.open, c.close)
      const bodyBot = Math.min(c.open, c.close)
      const inBody = bigPrice >= bodyBot && bigPrice <= bodyTop
      const posBody = (bigPrice - bodyBot) / (bodyTop - bodyBot + EPS)
      if (isBull) {
        const upperPos = (bigPrice - bodyTop) / (c.high - bodyTop + EPS)
        if (inBody) pattern = posBody <= o.bodyZone ? 'absCont' : 'accept'
        else if (bigPrice > bodyTop) pattern = upperPos >= o.wickSplit ? 'absContra' : 'reject'
      } else {
        const lowerPos = (bodyBot - bigPrice) / (bodyBot - c.low + EPS)
        if (inBody) pattern = posBody >= 1 - o.bodyZone ? 'absCont' : 'accept'
        else if (bigPrice < bodyBot) pattern = lowerPos >= o.wickSplit ? 'absContra' : 'reject'
      }
      if (pattern && !shown[pattern]) pattern = null
    }

    if (pattern) {
      // Bullish candle: AbsCont=magenta, Accept=teal, AbsContra=teal, Reject=magenta; bearish is the mirror.
      const tealOnBull = pattern === 'accept' || pattern === 'absContra'
      const color: 'teal' | 'magenta' = isBull === tealOnBull ? 'teal' : 'magenta'
      // Continuation patterns follow the candle; contrarian ones fade it.
      const bias: 'bull' | 'bear' = (pattern === 'absCont' || pattern === 'accept') === isBull ? 'bull' : 'bear'
      marks.push({ time: c.time, price: bigPrice, pattern, bull: isBull, color, bias })

      if (o.showZones) {
        let top: number
        let bottom: number
        if (o.zoneSource === 'thin') {
          const half = (tick * o.thickTicks) / 2
          top = bigPrice + half
          bottom = bigPrice - half
        } else if (o.zoneSource === 'ltfBar') {
          top = ltfTop
          bottom = ltfBot
        } else if (o.zoneSource === 'body') {
          top = Math.max(c.open, c.close)
          bottom = Math.min(c.open, c.close)
        } else {
          top = c.high
          bottom = c.low
        }
        if (top - bottom < tick) {
          top = bigPrice + tick
          bottom = bigPrice - tick
        }

        let allow = true
        if (o.biggestOnly) {
          allow = absDelta[i] >= sessBigAbs
          if (allow) {
            sessBigAbs = absDelta[i]
            if (sessZone) {
              const ix = zones.indexOf(sessZone)
              if (ix >= 0) zones.splice(ix, 1)
              if (active === sessZone) active = null
              sessZone = null
            }
          }
        }
        if (allow) {
          if (o.extMode === 'untilNext' && active) active.right = i
          const z: Box = { left: i, right: i + 1, top, bottom, color, label: `${DC_PATTERN_LABEL[pattern]} ${isBull ? '▲' : '▼'}` }
          zones.push(z)
          active = z
          if (o.biggestOnly) sessZone = z
          while (zones.length > o.maxZones) {
            const old = zones.shift()!
            if (old === active) active = null
            if (old === sessZone) sessZone = null
          }
        }
      }
    }

    // Extension, as the source does at the end of every bar.
    if (o.showZones) {
      if (o.extMode === 'untilNext') {
        if (active) active.right = i + 1
      } else for (const z of zones) z.right = Math.min(i + 1, z.left + o.extBars)
    }
  }

  return {
    marks,
    zones: zones.map((z) => ({ startTime: timeAt(z.left), endTime: timeAt(z.right), top: z.top, bottom: z.bottom, color: z.color, label: z.label })),
  }
}

/** Index of the first bar at or after `time` (bars ascending). */
function lowerBound(bars: Candle[], time: number): number {
  let lo = 0
  let hi = bars.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (bars[m].time < time) lo = m + 1
    else hi = m
  }
  return lo
}

function medianBarMs(candles: Candle[]): number {
  const diffs: number[] = []
  for (let i = Math.max(1, candles.length - 50); i < candles.length; i++) diffs.push(candles[i].time - candles[i - 1].time)
  if (diffs.length === 0) return MIN_MS
  diffs.sort((a, b) => a - b)
  return diffs[Math.floor(diffs.length / 2)]
}

/** #rrggbb + Pine transparency (0 opaque … 100 invisible) → rgba(). */
function withTransp(hex: string, transp: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const a = Math.max(0, Math.min(1, 1 - transp / 100))
  const v = parseInt(m[1], 16)
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`
}

// ---------------------------------------------------------------------------
// Overlay class
// ---------------------------------------------------------------------------

/** Timeframes on the bias dashboard (minutes) and their vote weights (higher timeframes count more). */
export const DC_BIAS_TFS: { min: number; label: string; weight: number }[] = [
  { min: 3, label: '3m', weight: 1 },
  { min: 5, label: '5m', weight: 2 },
  { min: 15, label: '15m', weight: 3 },
  { min: 30, label: '30m', weight: 4 },
  { min: 60, label: '1h', weight: 5 },
]
/** A signal stops voting after this many bars of its own timeframe. */
export const DC_BIAS_MAX_AGE = 20

export type DcBiasStatus = 'active' | 'invalidated' | 'stale' | 'none'

export interface DcBiasRow {
  label: string
  weight: number
  mark: DcMark | null
  /** Bars of this timeframe since the signal candle (0 = the current bar). */
  age: number
  status: DcBiasStatus
}

export interface DcBias {
  rows: DcBiasRow[]
  bullScore: number
  bearScore: number
  suggestion: 'bullish' | 'bearish' | 'neutral'
  /** Active timeframes voting against the suggestion. */
  against: string[]
}

/** Candles of `minutes` from 1m candles, bucketed on UTC boundaries. */
function aggregateMinutes(m1: Candle[], minutes: number): Candle[] {
  const ms = minutes * MIN_MS
  const out: Candle[] = []
  for (const c of m1) {
    const t = Math.floor(c.time / ms) * ms
    const last = out[out.length - 1]
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high)
      last.low = Math.min(last.low, c.low)
      last.close = c.close
      last.volume += c.volume
    } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })
  }
  return out
}

/**
 * Latest big-trade signal per timeframe and a weighted suggestion. A signal
 * votes its bias (weight 1–5 from 3m up to 1h) while it is ACTIVE: no more
 * than DC_BIAS_MAX_AGE bars old and price has not closed back through the
 * big-trade price (a bullish signal is invalidated by a close below it,
 * bearish by a close above).
 */
export function computeBigTradeBias(m1: Candle[], o: DcBigTradesOptions, openHourUTC = 0): DcBias {
  const rows: DcBiasRow[] = []
  let bull = 0
  let bear = 0
  const last = m1[m1.length - 1]
  for (const tf of DC_BIAS_TFS) {
    const bars = aggregateMinutes(m1, tf.min)
    const marks = bars.length ? computeDcBigTrades(bars, m1, { ...o, showZones: false }, tf.min * MIN_MS, openHourUTC).marks : []
    const mark = marks[marks.length - 1] ?? null
    let age = 0
    let status: DcBiasStatus = 'none'
    if (mark && last) {
      age = bars.length - 1 - bars.findIndex((b) => b.time === mark.time)
      const broken = mark.bias === 'bull' ? last.close < mark.price : last.close > mark.price
      status = age > DC_BIAS_MAX_AGE ? 'stale' : broken ? 'invalidated' : 'active'
      if (status === 'active') {
        if (mark.bias === 'bull') bull += tf.weight
        else bear += tf.weight
      }
    }
    rows.push({ label: tf.label, weight: tf.weight, mark, age, status })
  }
  const suggestion = bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral'
  const against = rows
    .filter((r) => r.status === 'active' && suggestion !== 'neutral' && (r.mark!.bias === 'bull') !== (suggestion === 'bullish'))
    .map((r) => r.label)
  return { rows, bullScore: bull, bearScore: bear, suggestion, against }
}

export interface DcBigTradesSources {
  /** The latest `limit` 1m bars for the chart's symbol, ascending. */
  fetchMinute(limit: number): Promise<Candle[]>
}

const MAX_LTF_BARS = 20_000
const LTF_TAIL_MS = 30_000
const LTF_RETRY_MS = 60_000

export default class DcBigTradesOverlay {
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly sources: DcBigTradesSources
  private opts: DcBigTradesOptions
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly ro: ResizeObserver
  private running = false
  private raf = 0
  private enabled = false

  private symbol = ''
  private candles: Candle[] = []
  private ltf: Candle[] = []
  private ltfSymbol = ''
  private ltfTailAt = 0
  private ltfFullAt = 0
  private gen = 0
  private loading = false

  private lastSig = ''
  private result: DcResult = { marks: [], zones: [] }
  private barMs = MIN_MS
  private bias: DcBias | null = null
  private readonly panelRoot: HTMLElement
  private readonly panelBody: HTMLElement
  private panelPlace = ''

  constructor(container: HTMLElement, engine: IChartEngine, sources: DcBigTradesSources, opts?: Partial<DcBigTradesOptions>) {
    this.container = container
    this.engine = engine
    this.sources = sources
    this.opts = { ...DC_BIG_TRADES_DEFAULTS, ...opts }
    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', zIndex: '16', display: 'none' })
    container.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)
    // Bias dashboard: same card styling (.uv2-*) as the strategy cards, fixed in a corner of the price pane (placePanel).
    this.panelRoot = document.createElement('div')
    this.panelRoot.className = 'uv2-widget'
    this.panelRoot.style.display = 'none'
    const head = document.createElement('div')
    head.className = 'uv2-head'
    head.textContent = 'BIG TRADES · BIAS'
    this.panelBody = document.createElement('div')
    this.panelBody.className = 'uv2-body'
    this.panelRoot.append(head, this.panelBody)
    container.appendChild(this.panelRoot)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
    this.resize()
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

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return
    this.symbol = symbol
    this.gen++
    this.loading = false
    this.ltf = []
    this.ltfSymbol = ''
    this.ltfFullAt = 0
    this.lastSig = ''
    this.result = { marks: [], zones: [] }
  }

  setCandles(candles: Candle[]): void {
    this.candles = candles
    if (this.enabled) this.ensureLtf()
  }

  setOptions(opts: Partial<DcBigTradesOptions>): void {
    this.opts = { ...this.opts, ...opts }
    this.lastSig = ''
    this.syncPanel()
  }

  /** The dashboard's latest reading (null until 1m data is in). */
  getBias(): DcBias | null {
    return this.bias
  }

  private syncPanel(): void {
    const show = this.enabled && this.opts.showBiasPanel
    this.panelRoot.style.display = show ? 'flex' : 'none'
    this.panelPlace = ''
  }

  /** Pins the panel to the chosen corner of the price pane, 8px inside it (so it never covers the price axis). */
  private placePanel(rect: Rect): void {
    if (!this.opts.showBiasPanel) return
    const right = Math.max(0, this.container.clientWidth - (rect.x + rect.width)) + 8
    const top = this.opts.biasPanelPos === 'topRight'
    const v = top ? rect.y + 8 : Math.max(0, this.container.clientHeight - (rect.y + rect.height)) + 8
    const key = `${top}|${right}|${v}`
    if (key === this.panelPlace) return
    this.panelPlace = key
    const st = this.panelRoot.style
    st.right = `${right}px`
    st.top = top ? `${v}px` : 'auto'
    st.bottom = top ? 'auto' : `${v}px`
  }

  getOptions(): DcBigTradesOptions {
    return { ...this.opts }
  }

  /** The most recent big trade, for the legend row. */
  getLast(): DcMark | null {
    return this.result.marks[this.result.marks.length - 1] ?? null
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.canvas.style.display = on ? 'block' : 'none'
    this.syncPanel()
    if (on) {
      this.start()
      this.ensureLtf()
    } else this.stop()
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

  reset(): void {
    this.candles = []
    this.lastSig = ''
    this.result = { marks: [], zones: [] }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  destroy(): void {
    this.stop()
    this.gen++
    this.ro.disconnect()
    this.panelRoot.remove()
    this.canvas.remove()
  }

  /**
   * Fetch the 1m bars the loaded candles span, then refresh the newest ones
   * every 30s while live. A full fetch is retried at most once a minute — it
   * may simply be unable to reach further back (MAX_LTF_BARS, or the API's own
   * 1m history limit), and must not re-run on every tick.
   */
  private ensureLtf(): void {
    if (this.loading || !this.symbol || this.candles.length === 0) return
    const barMs = medianBarMs(this.candles)
    if (barMs <= MIN_MS) return
    const first = this.candles[0].time
    const now = Date.now()
    const covered = this.ltfSymbol === this.symbol && this.ltf.length > 0 && this.ltf[0].time <= first + barMs
    const needFull = !covered && now - this.ltfFullAt > LTF_RETRY_MS
    const needTail = this.ltfSymbol === this.symbol && this.ltf.length > 0 && !needFull && now - this.ltfTailAt > LTF_TAIL_MS
    if (!needFull && !needTail) return
    const gen = this.gen
    const symbol = this.symbol
    this.loading = true
    void (async () => {
      try {
        if (needFull) {
          this.ltfFullAt = now
          const n = Math.min(MAX_LTF_BARS, Math.ceil((now - first + barMs) / MIN_MS) + 5)
          const ltf = await this.sources.fetchMinute(n)
          if (gen !== this.gen) return
          this.ltf = ltf
          this.ltfSymbol = symbol
          this.ltfTailAt = Date.now()
        } else {
          this.ltfTailAt = now
          const tail = await this.sources.fetchMinute(60)
          if (gen !== this.gen || tail.length === 0) return
          const cut = tail[0].time
          this.ltf = [...this.ltf.filter((b) => b.time < cut), ...tail]
        }
        this.lastSig = ''
      } catch {
        /* transient — retried by the timers above */
      } finally {
        if (gen === this.gen) this.loading = false
      }
    })()
  }

  private recompute(): void {
    const c = this.candles
    if (c.length < 2) return
    const last = c[c.length - 1]
    const lastLtf = this.ltf[this.ltf.length - 1]
    const sig = `${c.length}:${c[0].time}:${last.time}:${last.high}:${last.low}:${last.close}:${last.volume}:${this.ltf.length}:${lastLtf?.time ?? 0}:${lastLtf?.volume ?? 0}`
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.barMs = medianBarMs(c)
    this.result = computeDcBigTrades(c, this.ltf, this.opts, this.barMs, sessionOpenHourUTC(this.symbol))
    if (this.opts.showBiasPanel) {
      // On a 1m chart the candles are the 1m data; otherwise use the fetched 1m bars,
      // cut at the end of the chart's last candle — in replay that is the cursor, so
      // the dashboard follows replay instead of showing the live (future) market.
      const m1 = this.barMs <= MIN_MS ? c : this.ltf.slice(0, lowerBound(this.ltf, last.time + this.barMs))
      this.bias = m1.length ? computeBigTradeBias(m1, this.opts, sessionOpenHourUTC(this.symbol)) : null
      this.renderPanel()
    }
  }

  private renderPanel(): void {
    const b = this.bias
    const cell = (text: string, color: string, extra = ''): HTMLSpanElement => {
      const sp = document.createElement('span')
      sp.textContent = text
      sp.style.cssText = `color:${color};${extra}`
      return sp
    }
    const rows: HTMLElement[] = []
    this.panelRoot.style.minWidth = '230px'
    if (!b) {
      const r = document.createElement('div')
      r.className = 'uv2-row'
      r.append(cell('loading 1m data…', '#787b86'))
      this.panelBody.replaceChildren(r)
      return
    }
    const bullC = this.colorOf('teal')
    const bearC = this.colorOf('magenta')
    for (const row of b.rows) {
      const r = document.createElement('div')
      r.className = 'uv2-row'
      r.style.gap = '8px'
      const m = row.mark
      const dim = row.status !== 'active'
      const sig = m ? `${DC_PATTERN_LABEL[m.pattern]} ${m.bull ? '▲' : '▼'}` : '—'
      const biasTxt = !m ? '—' : m.bias === 'bull' ? 'BULL' : 'BEAR'
      const biasCol = !m || dim ? '#787b86' : m.bias === 'bull' ? bullC : bearC
      const ageTxt = !m ? '' : row.status === 'invalidated' ? 'broken' : row.status === 'stale' ? 'old' : `${row.age}b`
      r.append(
        cell(row.label, '#b2b5be', 'min-width:28px;font-weight:600'),
        cell(sig, dim ? '#787b86' : '#d1d4dc', 'flex:1;white-space:nowrap'),
        cell(biasTxt, biasCol, 'min-width:36px;font-weight:700;text-align:right;white-space:nowrap'),
        cell(ageTxt, '#787b86', 'min-width:44px;text-align:right;white-space:nowrap'),
      )
      rows.push(r)
    }
    const s = document.createElement('div')
    s.className = 'uv2-row'
    s.style.cssText = 'border-top:1px solid #2a2e39;padding-top:4px;margin-top:2px;flex-direction:column;align-items:flex-start;gap:1px'
    const word = b.suggestion === 'bullish' ? 'BULLISH' : b.suggestion === 'bearish' ? 'BEARISH' : 'NEUTRAL'
    const col = b.suggestion === 'bullish' ? bullC : b.suggestion === 'bearish' ? bearC : '#b2b5be'
    s.append(cell(`Suggestion: ${word} (${b.bullScore} vs ${b.bearScore})`, col, 'font-weight:700'))
    const note =
      b.suggestion === 'neutral'
        ? b.bullScore + b.bearScore === 0
          ? 'no active signals — wait'
          : 'timeframes cancel out — wait'
        : `look for ${b.suggestion === 'bullish' ? 'longs' : 'shorts'}${b.against.length ? `; ${b.against.join(', ')} ${b.against.length > 1 ? 'disagree' : 'disagrees'}` : ''}`
    s.append(cell(note, '#9aa0a6', 'font-size:11px'))
    rows.push(s)
    this.panelBody.replaceChildren(...rows)
  }

  private draw(): void {
    this.recompute()
    const dpr = window.devicePixelRatio || 1
    this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr)
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (rect) this.placePanel(rect)
    if (!conv || !rect || this.candles.length === 0) return
    this.ctx.save()
    this.ctx.beginPath()
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height)
    this.ctx.clip()
    if (this.opts.showZones) this.drawZones(conv, rect)
    this.drawMarks(conv, rect)
    this.ctx.restore()
  }

  private colorOf(c: 'teal' | 'magenta'): string {
    return c === 'teal' ? this.opts.tealColor : this.opts.magentaColor
  }

  private drawZones(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    const right = rect.x + rect.width
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    for (const z of this.result.zones) {
      const x1 = conv.timeToX(z.startTime)
      const x2 = conv.timeToX(z.endTime)
      if (x2 < rect.x || x1 > right) continue
      const yTop = conv.priceToY(z.top)
      const yBot = conv.priceToY(z.bottom)
      const y = Math.min(yTop, yBot)
      const h = Math.max(1, Math.abs(yBot - yTop))
      const base = this.colorOf(z.color)
      ctx.fillStyle = withTransp(base, this.opts.zoneTransp)
      ctx.fillRect(x1, y, Math.max(1, x2 - x1), h)
      if (this.opts.zoneBorder) {
        ctx.strokeStyle = withTransp(base, this.opts.zoneBorderTransp)
        ctx.lineWidth = 1
        ctx.strokeRect(Math.round(x1) + 0.5, Math.round(y) + 0.5, Math.round(x2 - x1), Math.round(h))
      }
      if (this.opts.zoneLabel) {
        ctx.fillStyle = base
        ctx.fillText(z.label, x1 + 2, y + 1)
      }
    }
  }

  private drawMarks(conv: Converters, rect: Rect): void {
    const ctx = this.ctx
    const t = this.candles[this.candles.length - 1].time
    const barPx = Math.abs(conv.timeToX(t) - conv.timeToX(t - this.barMs))
    const r = Math.max(3, Math.min(7, barPx * 0.45))
    for (const m of this.result.marks) {
      const x = conv.timeToX(m.time)
      if (x < rect.x - r || x > rect.x + rect.width + r) continue
      ctx.fillStyle = withTransp(this.colorOf(m.color), this.opts.transp)
      ctx.beginPath()
      ctx.arc(x, conv.priceToY(m.price), r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
