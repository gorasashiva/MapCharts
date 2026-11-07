/**
 * Deep Profile — DeepCharts-style volume / delta profiles drawn on the chart
 * (https://www.deepcharts.com/helpcenter/article/deep-profile). The maths
 * lives in deepProfileModel.ts; this file loads the data, keeps it current
 * and draws it.
 *
 *   VBP type     Volume · Ask/Bid (bid then ask, end to end) · Delta ·
 *                Delta + Volume (a delta strip at the session edge, an axis,
 *                then total volume on into the session). Every type starts at
 *                the chosen side of its session (Profile side) or pane edge
 *                (Composite / Visible placement).
 *   VBP period   Latest · Multiple (one per period) · Composite (all loaded
 *                data) · Visible (follows the viewport) · Custom (ranges
 *                drawn with the mouse)
 *   Length       N minutes / hours / days / weeks / months per profile
 *   Input data   Volume (every print) · Order (prints merged into taker
 *                orders) · Aggregate (orders merged into clusters) · Number
 *                of Trades (counts instead of volume), with Min / Max size
 *                filters
 *   Rows         Auto (tidy tick multiple from the price scale — changes as
 *                you zoom) or Manual ticks, × group factor
 *   Split        Splitted (2 profiles a day) / Triple (3), at NY / IST / UTC
 *                wall-clock times
 *   POC          highlighted row, current or developing POC line, optional
 *                extension to the window edge, price-scale tag
 *   Nodes        peaks (HVN) and valleys (LVN) with a sensitivity
 *   Merge/Split  right-click a profile: Merge− / Merge+ / Split− / Split+ /
 *                Reset (persisted with the chart)
 *
 * Data: the exact trade tape where we have it (recorder history via
 * /tape/trades + live prints since the chart opened), candle estimates
 * elsewhere — see deepProfileModel.ts. Each profile's header shows how much
 * of it was estimated.
 */
import type { Candle } from '../core/types'
import type { IChartEngine } from '../chart/types'
import type { Converters } from '../drawings/types'
import type { RecordedTape, TapeFetcher } from './footprint'
import { ClusterBuilder, buildClusters, type ClusterMode, type TapePrint, type TradeCluster } from './takerOrders'
import { lazyCanvas } from './lazyCanvas'
import {
  PeriodClock,
  buildBuckets,
  buildProfile,
  bucketsIn,
  editJoins,
  filterActive,
  groupPeriods,
  mergeSpans,
  parseHhMm,
  rowSizeFor,
  zoneOffset,
  type DpBucket,
  type DpInput,
  type DpLengthType,
  type DpPeriod,
  type DpProfile,
  type DpSplitMode,
  type DpUnit,
  type DpVbpType,
  type DpZone,
} from './deepProfileModel'

const TAG_SOURCE = 'deepProfile'
const DAY_MS = 86_400_000
const RECOMPUTE_MS = 250
/** Delta + Volume: share of the bar length given to the delta strip at the session edge. */
const DV_DELTA_SHARE = 0.35

type Rect = { x: number; y: number; width: number; height: number }

export type DpPocLine = 'none' | 'current' | 'developing'
export type DpPlacement = 'left' | 'right'
export type DpProfileAction = 'merge-' | 'merge+' | 'split-' | 'split+'

export interface DeepProfileOptions {
  // ---- general ----
  vbpType: DpVbpType
  period: DpPeriod
  lengthType: DpLengthType
  lengthValue: number
  // ---- data ----
  input: DpInput
  /** "Number of Trades": count units instead of summing their volume. */
  countTrades: boolean
  /** Ignore units smaller / larger than this (base-asset qty, 0 = off). */
  minFilter: number
  maxFilter: number
  /** Days of recorded tape preloaded when turned on (exact history; more loads as you scroll, see loadVisible). */
  daysToLoad: number
  /** Fetch the recorded tape for the sessions on screen as you scroll / zoom. */
  loadVisible: boolean
  /** Most days of tape held at once (memory); the days farthest from the screen are dropped first. */
  maxTapeDays: number
  // ---- rows ----
  autoGrouping: boolean
  /** Auto: target pixels per row before snapping to a tick multiple. */
  autoRowPx: number
  manualTicks: number
  groupFactor: number
  /** Price per tick; 0 = from the symbol's price precision. */
  tickSize: number
  // ---- split ----
  splitMode: DpSplitMode
  splitZone: DpZone
  /** "HH:MM" in splitZone. Splitted uses split1; Triple uses both. */
  split1: string
  split2: string
  // ---- POC / value area ----
  pocEnable: boolean
  pocHighlight: boolean
  pocColor: string
  pocLine: DpPocLine
  pocLineColor: string
  pocLineWidth: number
  pocExtend: boolean
  pocTag: boolean
  showValueArea: boolean
  valueAreaPct: number
  // ---- peaks / valleys ----
  showPeaks: boolean
  showValleys: boolean
  peakColor: string
  valleyColor: string
  /** 1 (every bump) … 10 (only the main nodes). */
  sensitivity: number
  extendNodes: boolean
  // ---- HVN / LVN zones (Latest / Multiple) ----
  /** Bands from a session's profile, drawn over it and extended through the next session. */
  zonesEnable: boolean
  /** 'previous' = only the last completed session's zones (into today); 'every' = each session's into the one after. */
  zonesScope: 'previous' | 'every'
  showHvnZones: boolean
  showLvnZones: boolean
  hvnZoneColor: string
  lvnZoneColor: string
  /** A node must stand out by at least this % of the POC's volume (higher = fewer, bigger zones). */
  zoneProminencePct: number
  /** Band width as % of the node's height (HVN) or dip (LVN). */
  zoneWidthPct: number
  /** Strongest N of each kind per session. */
  zonesMax: number
  zoneLabels: boolean
  // ---- appearance ----
  volumeColor: string
  askColor: string
  bidColor: string
  alpha: number
  /** Share of each period's width a full-length bar uses. */
  fillPct: number
  /** Composite / Visible: profile width as a share of the pane, and which edge. */
  sideWidthPct: number
  placement: DpPlacement
  /** Latest / Multiple / Custom: bars grow from the session's start (left) or end (right). */
  periodAlign: DpPlacement
  /**
   * Delta + Volume: where the axis sits. 'sessionStart' = on the session's open line, delta
   * outward (before the open), volume into the session, so each level is marked at the open;
   * 'inside' = a delta strip inside the session, the axis just after it.
   */
  dvAxis: 'sessionStart' | 'inside'
  showValues: boolean
  showTotals: boolean
  // ---- persisted edits ----
  /** Base-period starts merged onto the period before them. */
  joined: number[]
  /** Custom profiles, [from, to) epoch ms. */
  customRanges: [number, number][]
}

export const DEEP_PROFILE_DEFAULTS: DeepProfileOptions = {
  vbpType: 'volume',
  period: 'multiple',
  lengthType: 'days',
  lengthValue: 1,
  input: 'volume',
  countTrades: false,
  minFilter: 0,
  maxFilter: 0,
  daysToLoad: 2,
  loadVisible: true,
  maxTapeDays: 6,
  autoGrouping: true,
  autoRowPx: 6,
  manualTicks: 1,
  groupFactor: 1,
  tickSize: 0,
  splitMode: 'none',
  splitZone: 'NY',
  split1: '08:20',
  split2: '03:00',
  pocEnable: true,
  pocHighlight: true,
  pocColor: '#2f7cf6',
  pocLine: 'current',
  pocLineColor: '#2f7cf6',
  pocLineWidth: 1,
  pocExtend: false,
  pocTag: true,
  showValueArea: false,
  valueAreaPct: 0.7,
  showPeaks: false,
  showValleys: false,
  peakColor: '#f6465d',
  valleyColor: '#0ecb81',
  sensitivity: 3,
  extendNodes: false,
  zonesEnable: false,
  zonesScope: 'previous',
  showHvnZones: true,
  showLvnZones: true,
  hvnZoneColor: '#f0a020',
  lvnZoneColor: '#8f7cff',
  zoneProminencePct: 8,
  zoneWidthPct: 50,
  zonesMax: 3,
  zoneLabels: true,
  volumeColor: '#8a94a6',
  askColor: '#0ecb81',
  bidColor: '#f6465d',
  alpha: 0.6,
  fillPct: 0.9,
  sideWidthPct: 0.2,
  placement: 'right',
  periodAlign: 'left',
  dvAxis: 'sessionStart',
  showValues: false,
  showTotals: true,
  joined: [],
  customRanges: [],
}

/** Options that change the buckets (data), as opposed to only the profiles or the drawing. */
const BUCKET_KEYS: (keyof DeepProfileOptions)[] = ['input', 'countTrades', 'minFilter', 'maxFilter']

/** What a right-click landed on. */
export interface DpHit {
  kind: 'period' | 'custom'
  /** True when the profile holds more than one base period. */
  merged: boolean
  hasNext: boolean
  hasPrev: boolean
  customIndex?: number
}

function fmtNum(v: number): string {
  const a = Math.abs(v)
  const t = a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'K' : a >= 100 ? Math.round(a).toString() : a >= 1 ? a.toFixed(1) : a.toFixed(3)
  return (v < 0 ? '−' : '') + t
}

const signed = (v: number): string => (v > 0 ? '+' : '') + fmtNum(v)

function clusterUnit(c: TradeCluster): DpUnit {
  return { time: c.time, side: c.side, qty: c.qty, levels: c.levels }
}

export default class DeepProfileOverlay {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly container: HTMLElement
  private readonly engine: IChartEngine
  private readonly getCandles: () => Candle[]
  private readonly fetchTape: TapeFetcher
  private opts: DeepProfileOptions
  private enabled = false
  private symbol = ''
  private anchorNyHour: number | null = null
  private anchorUtcHour = 0
  private symbolTick = 0.01
  private cutoff: number | null = null

  // ---- tape ----
  private prints: TapePrint[] = []
  private recordedSpans: [number, number][] = []
  private liveFrom: number | null = null
  private units: DpUnit[] = []
  private builder: ClusterBuilder | null = null
  private loadGen = 0
  private loading = false
  /** Recorded tape by UTC day start: loading or loaded. */
  private tapeDays = new Map<number, 'loading' | 'done'>()
  /** Days waiting to be fetched, most wanted first. */
  private tapeQueue: number[] = []
  private pumping = false
  private lastEnsure = 0
  private ensureKey = ''
  /** Centre of the visible range (eviction keeps the days nearest to it). */
  private focusTime = Date.now()

  // ---- derived ----
  private buckets: DpBucket[] = []
  private candlesSig = ''
  /** Earliest time whose bucket must be rebuilt (Infinity = none, -Infinity = all). */
  private dirtyFrom = -Infinity
  private bucketsVersion = 0
  private profiles: DpProfile[] = []
  /** Latest mode with zones: the session before the drawn one (zones only, not drawn). */
  private prevProfile: DpProfile | null = null
  /** Base periods of every profile in order (Multiple / Latest) — for merge/split neighbours. */
  private groupsBases: number[][] = []
  private profilesKey = ''
  private lastRecompute = 0

  // ---- loop / capture ----
  private running = false
  private raf = 0
  private ro: ResizeObserver | null = null
  private capture: HTMLDivElement | null = null
  private captureCleanup: (() => void) | null = null

  constructor(container: HTMLElement, engine: IChartEngine, getCandles: () => Candle[], fetchTape: TapeFetcher, opts?: Partial<DeepProfileOptions>) {
    this.container = container
    this.engine = engine
    this.getCandles = getCandles
    this.fetchTape = fetchTape
    this.opts = { ...DEEP_PROFILE_DEFAULTS, ...opts }
    this.canvas = document.createElement('canvas')
    this.canvas.style.position = 'absolute'
    this.canvas.style.left = '0'
    this.canvas.style.top = '0'
    this.canvas.style.pointerEvents = 'none'
    this.canvas.style.zIndex = '16'
    container.appendChild(this.canvas)
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this.ctx = ctx
    lazyCanvas(this.canvas, ctx)
    this.resize()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(container)
  }

  // ------------------------------------------------------------ public ----

  resize(): void {
    const rect = this.container.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(rect.width * dpr)
    this.canvas.height = Math.round(rect.height * dpr)
    this.canvas.style.width = `${rect.width}px`
    this.canvas.style.height = `${rect.height}px`
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  getOptions(): DeepProfileOptions {
    return { ...this.opts, joined: [...this.opts.joined], customRanges: this.opts.customRanges.map((r) => [r[0], r[1]] as [number, number]) }
  }

  setOptions(patch: Partial<DeepProfileOptions>): void {
    const prev = this.opts
    this.opts = { ...this.opts, ...patch }
    if ('input' in patch && patch.input !== prev.input) this.rebuildUnits()
    if (BUCKET_KEYS.some((k) => k in patch)) this.dirtyFrom = -Infinity
    if ('daysToLoad' in patch && patch.daysToLoad !== prev.daysToLoad && this.enabled) void this.loadHistory()
    if ('maxTapeDays' in patch && patch.maxTapeDays !== prev.maxTapeDays) {
      this.evictDays()
      this.rebuildUnits()
      this.ensureKey = ''
    }
    if ('loadVisible' in patch) this.ensureKey = ''
    this.profilesKey = ''
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      this.start()
      void this.loadHistory()
    } else {
      this.stop()
      this.cancelCustomDraw()
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
      this.engine.setPriceTags(TAG_SOURCE, [])
    }
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** New symbol: drop all data. `nyHour` = trading-day open in New York (gold), else `utcHour`. */
  setSymbol(symbol: string, nyHour: number | null, utcHour: number): void {
    const changed = symbol !== this.symbol
    this.symbol = symbol
    this.anchorNyHour = nyHour
    this.anchorUtcHour = utcHour
    if (!changed) return
    this.loadGen++
    this.prints = []
    this.recordedSpans = []
    this.tapeDays.clear()
    this.tapeQueue = []
    this.pumping = false
    this.ensureKey = ''
    this.liveFrom = null
    this.units = []
    this.builder = null
    this.buckets = []
    this.candlesSig = ''
    this.dirtyFrom = -Infinity
    this.profiles = []
    this.profilesKey = ''
    if (this.enabled) void this.loadHistory()
  }

  /** Price per tick from the symbol's precision (used when tickSize option is 0). */
  setSymbolTick(tick: number): void {
    if (tick > 0 && tick !== this.symbolTick) {
      this.symbolTick = tick
      this.profilesKey = ''
    }
  }

  /** Replay: only data up to `t` (null = live). */
  setCutoff(t: number | null): void {
    if (t === this.cutoff) return
    this.cutoff = t
    this.dirtyFrom = -Infinity
    this.profilesKey = ''
  }

  addTrade(t: { time: number; timeUs?: number; price: number; qty: number; side: 'buy' | 'sell' }): void {
    if (!this.enabled) return
    if (this.liveFrom === null) this.liveFrom = t.time
    const p: TapePrint = { tUs: t.timeUs ?? t.time * 1000, price: t.price, qty: t.qty, side: t.side }
    this.prints.push(p)
    if (this.opts.input === 'volume') this.pushUnit({ time: t.time, side: t.side, qty: t.qty, levels: [[t.price, t.qty]] })
    else {
      this.builder ??= new ClusterBuilder(this.clusterMode())
      for (const c of this.builder.push(p, Date.now())) this.pushUnit(clusterUnit(c))
    }
  }

  /** Profile under `time` (Multiple / Latest / Custom), for the right-click menu. */
  hitTest(time: number): DpHit | null {
    if (!this.enabled) return null
    const period = this.opts.period
    if (period === 'custom') {
      const i = this.opts.customRanges.findIndex((r) => time >= r[0] && time < r[1])
      return i >= 0 ? { kind: 'custom', merged: false, hasNext: false, hasPrev: false, customIndex: i } : null
    }
    if (period !== 'multiple' && period !== 'latest') return null
    const p = this.profiles.find((x) => time >= x.start && time < x.end)
    if (!p) return null
    const gi = this.groupsBases.findIndex((b) => b[0] === p.bases[0])
    return { kind: 'period', merged: p.bases.length > 1, hasPrev: gi > 0, hasNext: gi >= 0 && gi < this.groupsBases.length - 1 }
  }

  /** Merge− / Merge+ / Split− / Split+ on the profile under `time`. Returns the options patch for the pane to persist. */
  profileAction(time: number, action: DpProfileAction): Partial<DeepProfileOptions> | null {
    const p = this.profiles.find((x) => time >= x.start && time < x.end)
    if (!p) return null
    const gi = this.groupsBases.findIndex((b) => b[0] === p.bases[0])
    const next = gi >= 0 && gi + 1 < this.groupsBases.length ? this.groupsBases[gi + 1] : null
    if (action === 'merge-' && gi <= 0) return null
    const joined = editJoins(this.opts.joined, action, p.bases, next)
    return { joined }
  }

  /** Let the user drag out a custom profile range; `onDone` gets the options patch to persist. */
  startCustomDraw(onDone: (patch: Partial<DeepProfileOptions>) => void): void {
    this.cancelCustomDraw()
    const div = document.createElement('div')
    div.style.cssText = 'position:absolute;inset:0;z-index:40;cursor:col-resize;background:rgba(47,124,246,0.04)'
    div.title = 'Drag across the bars for a custom Deep Profile · Esc to cancel'
    const band = document.createElement('div')
    band.style.cssText = 'position:absolute;top:0;bottom:0;background:rgba(47,124,246,0.15);border-left:1px solid #2f7cf6;border-right:1px solid #2f7cf6;display:none;pointer-events:none'
    div.appendChild(band)
    this.container.appendChild(div)
    this.capture = div
    let x0: number | null = null
    const xOf = (e: PointerEvent): number => e.clientX - div.getBoundingClientRect().left
    const down = (e: PointerEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      x0 = xOf(e)
      div.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent): void => {
      if (x0 === null) return
      const x = xOf(e)
      band.style.display = 'block'
      band.style.left = `${Math.min(x0, x)}px`
      band.style.width = `${Math.abs(x - x0)}px`
    }
    const up = (e: PointerEvent): void => {
      if (x0 === null) return
      const conv = this.engine.getMainConverters()
      const x1 = xOf(e)
      const a = Math.min(x0, x1)
      const b = Math.max(x0, x1)
      this.cancelCustomDraw()
      if (!conv || b - a < 4) return
      const ranges = [...this.opts.customRanges, [Math.round(conv.xToTime(a)), Math.round(conv.xToTime(b))] as [number, number]]
      onDone({ customRanges: ranges, period: 'custom' })
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.cancelCustomDraw()
    }
    div.addEventListener('pointerdown', down)
    div.addEventListener('pointermove', move)
    div.addEventListener('pointerup', up)
    window.addEventListener('keydown', key)
    this.captureCleanup = () => window.removeEventListener('keydown', key)
  }

  cancelCustomDraw(): void {
    this.captureCleanup?.()
    this.captureCleanup = null
    this.capture?.remove()
    this.capture = null
  }

  /** POC of the newest profile and its tape coverage, for the pane legend. */
  getSummary(): { poc: number; delta: number; volume: number; estShare: number; loading: boolean } | null {
    const p = this.profiles[this.profiles.length - 1]
    if (!p) return null
    return { poc: p.rowLo + (p.pocRow + 0.5) * p.rowSize, delta: p.totalBuy - p.totalSell, volume: p.totalBuy + p.totalSell, estShare: p.estShare, loading: this.loading }
  }

  destroy(): void {
    this.stop()
    this.cancelCustomDraw()
    this.ro?.disconnect()
    this.canvas.remove()
    this.engine.setPriceTags(TAG_SOURCE, [])
  }

  // -------------------------------------------------------------- data ----

  private clusterMode(): ClusterMode {
    return this.opts.input === 'aggregate' ? 'cumulative' : this.opts.input === 'order' ? 'order' : 'separate'
  }

  private pushUnit(u: DpUnit): void {
    const us = this.units
    us.push(u)
    // clusters close out of order across sides — keep the list time-sorted
    for (let i = us.length - 1; i > 0 && us[i - 1].time > us[i].time; i--) [us[i - 1], us[i]] = [us[i], us[i - 1]]
    if (u.time < this.dirtyFrom) this.dirtyFrom = u.time
  }

  private rebuildUnits(): void {
    const prints = [...this.prints].sort((a, b) => a.tUs - b.tUs)
    if (this.opts.input === 'volume') this.units = prints.map((p) => ({ time: Math.floor(p.tUs / 1000), side: p.side, qty: p.qty, levels: [[p.price, p.qty]] }))
    else this.units = buildClusters(prints, this.clusterMode()).map(clusterUnit)
    this.builder = this.opts.input === 'volume' ? null : new ClusterBuilder(this.clusterMode())
    this.dirtyFrom = -Infinity
  }

  /** Preload the last `daysToLoad` days (newest first); older sessions load as they come on screen. */
  private async loadHistory(): Promise<void> {
    const now = Date.now()
    const days: number[] = []
    for (let k = 0; k < Math.max(1, this.opts.daysToLoad); k++) days.push(Math.floor((now - k * DAY_MS) / DAY_MS) * DAY_MS)
    // a changed preload count re-fetches today (live may have missed nothing, but the cheap way to be sure)
    this.requestDays(days)
  }

  /** Queue UTC days for fetching (in the given priority), then work the queue. */
  private requestDays(days: number[]): void {
    const want = days.filter((d) => !this.tapeDays.has(d))
    if (!want.length) return
    this.tapeQueue = [...want, ...this.tapeQueue.filter((d) => !want.includes(d))]
    void this.pump()
  }

  /** Fetch queued days one at a time (the recorder caps each request), folding each into the tape. */
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
        const now = Date.now()
        const chunk: RecordedTape | null = await this.fetchTape(day, Math.min(now, day + DAY_MS)).catch(() => null)
        if (gen !== this.loadGen) return
        this.tapeDays.set(day, 'done')
        if (chunk) this.mergeDay(day, chunk)
        this.evictDays()
        this.rebuildUnits()
        this.profilesKey = ''
      }
    } finally {
      if (gen === this.loadGen) {
        this.pumping = false
        this.loading = this.tapeQueue.length > 0
      }
    }
  }

  /** Put one recorded UTC day into the tape, replacing anything already held for the time it covers (e.g. live prints). */
  private mergeDay(day: number, chunk: RecordedTape): void {
    const add: TapePrint[] = chunk.prints.map(([time, price, qty, side]) => ({ tUs: time * 1000, price, qty, side: side > 0 ? 'buy' : 'sell' }))
    add.sort((a, b) => a.tUs - b.tUs)
    let to = day
    for (const ss of chunk.sessions) to = Math.max(to, Math.min(ss[1], day + DAY_MS))
    if (add.length) to = Math.max(to, Math.floor(add[add.length - 1].tUs / 1000))
    const fromUs = day * 1000
    const toUs = to * 1000
    const before = this.prints.filter((pp) => pp.tUs < fromUs)
    const after = this.prints.filter((pp) => pp.tUs > toUs)
    this.prints = [...before, ...add, ...after]
    this.recordedSpans = mergeSpans([...this.recordedSpans, ...chunk.sessions.map((ss) => [ss[0], ss[1]] as [number, number])])
  }

  /** Keep at most `maxTapeDays` loaded days: drop the ones farthest from the screen (never today, which carries the live tape). */
  private evictDays(): void {
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS
    const done = [...this.tapeDays.entries()].filter(([d, st]) => st === 'done' && d !== today).map(([d]) => d)
    const keep = Math.max(1, this.opts.maxTapeDays) - (this.tapeDays.has(today) ? 1 : 0)
    if (done.length <= keep) return
    const focus = this.focusTime
    done.sort((a, b) => Math.abs(b + DAY_MS / 2 - focus) - Math.abs(a + DAY_MS / 2 - focus))
    for (const d of done.slice(0, done.length - keep)) {
      this.tapeDays.delete(d)
      const a = d * 1000
      const b = (d + DAY_MS) * 1000
      this.prints = this.prints.filter((pp) => pp.tUs < a || pp.tUs >= b)
      // the day is no longer recorded here: its candles go back to estimates until it loads again
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

  /** Ask for the tape behind the sessions on screen (and the one before them, for zones), newest first. */
  private ensureVisibleTape(conv: Converters, rect: Rect): void {
    if (!this.opts.loadVisible || !this.enabled) return
    const now = performance.now()
    if (now - this.lastEnsure < 400) return
    this.lastEnsure = now
    const candles = this.getCandles()
    if (!candles.length) return
    const first = candles[0].time
    const nowMs = Date.now()
    let t0 = Math.max(first, conv.xToTime(rect.x))
    const t1 = Math.min(nowMs, conv.xToTime(rect.x + rect.width))
    if (!(t1 > t0)) return
    this.focusTime = (t0 + t1) / 2
    // whole sessions: from the start of the first visible one (and one more for previous-session zones)
    t0 = this.clock().periodStart(t0) - (this.opts.zonesEnable ? DAY_MS : 0)
    t0 = Math.max(first, t0)
    const key = `${Math.floor(t0 / DAY_MS)}|${Math.floor(t1 / DAY_MS)}`
    if (key === this.ensureKey) return
    this.ensureKey = key
    const days: number[] = []
    for (let d = Math.floor(t1 / DAY_MS) * DAY_MS; d >= Math.floor(t0 / DAY_MS) * DAY_MS; d -= DAY_MS) days.push(d)
    this.requestDays(days.slice(0, Math.max(1, this.opts.maxTapeDays)))
  }

  private spans(): [number, number][] {
    const s = [...this.recordedSpans]
    if (this.liveFrom !== null) s.push([this.liveFrom, Infinity])
    return mergeSpans(s)
  }

  private barMs(candles: Candle[]): number {
    const n = candles.length
    if (n < 2) return 60_000
    const gaps: number[] = []
    for (let i = Math.max(1, n - 50); i < n; i++) gaps.push(candles[i].time - candles[i - 1].time)
    gaps.sort((a, b) => a - b)
    return gaps[gaps.length >> 1] || 60_000
  }

  /** Bring the buckets up to date with the candles and tape (incrementally when only the tail changed). */
  private refreshBuckets(): void {
    let candles = this.getCandles()
    if (this.cutoff !== null) {
      const c = this.cutoff
      candles = candles.filter((x) => x.time <= c)
    }
    if (candles.length === 0) {
      if (this.buckets.length) {
        this.buckets = []
        this.bucketsVersion++
      }
      return
    }
    const first = candles[0]
    const last = candles[candles.length - 1]
    const sig = `${candles.length}|${first.time}|${last.time}`
    const tailSig = `${last.close}|${last.volume}|${last.high}|${last.low}`
    const [prevSig, prevTail] = this.candlesSig.split('#')
    if (sig !== prevSig) {
      // a new bar only needs the previous tail rebuilt; anything else is a reload
      const prevLen = Number(prevSig?.split('|')[0])
      const prevFirst = Number(prevSig?.split('|')[1])
      if (prevFirst === first.time && candles.length === prevLen + 1 && this.buckets.length === prevLen) this.dirtyFrom = Math.min(this.dirtyFrom, candles[candles.length - 2].time)
      else this.dirtyFrom = -Infinity
    } else if (tailSig !== prevTail) this.dirtyFrom = Math.min(this.dirtyFrom, last.time)
    this.candlesSig = `${sig}#${tailSig}`
    if (this.dirtyFrom === Infinity) return

    const cutoff = this.cutoff
    const units = cutoff === null ? this.units : this.units.filter((u) => u.time < cutoff)
    const f = { countTrades: this.opts.countTrades, minFilter: this.opts.minFilter, maxFilter: this.opts.maxFilter }
    const bm = this.barMs(candles)
    if (this.dirtyFrom === -Infinity || this.buckets.length === 0) {
      this.buckets = buildBuckets(candles, units, this.spans(), bm, f)
    } else {
      // first candle whose bucket can hold `dirtyFrom` (its own, or the one it fell inside)
      let i = candles.length - 1
      while (i > 0 && candles[i].time > this.dirtyFrom) i--
      i = Math.min(i, this.buckets.length)
      this.buckets = this.buckets.slice(0, i).concat(buildBuckets(candles, units, this.spans(), bm, f, i))
    }
    this.dirtyFrom = Infinity
    this.bucketsVersion++
  }

  private rowSize(conv: Converters, rect: Rect): number {
    const o = this.opts
    const tick = o.tickSize > 0 ? o.tickSize : this.symbolTick
    const pricePerPx = Math.abs(conv.yToPrice(rect.y) - conv.yToPrice(rect.y + rect.height)) / Math.max(1, rect.height)
    return rowSizeFor(tick, o.autoGrouping, pricePerPx, o.autoRowPx, o.manualTicks, o.groupFactor)
  }

  private clock(): PeriodClock {
    const o = this.opts
    const ny = this.anchorNyHour
    const splits = [parseHhMm(o.split1), parseHhMm(o.split2)].filter((m): m is number => m !== null)
    return new PeriodClock({
      lengthType: o.lengthType,
      lengthValue: o.lengthValue,
      anchorMinute: (ny ?? this.anchorUtcHour) * 60,
      anchorOffset: zoneOffset(ny !== null ? 'NY' : 'UTC'),
      // ETH / RTH splits are a gold (New York session) idea: crypto keeps one profile a day
      splitMode: ny !== null ? o.splitMode : 'none',
      splitMinutes: splits,
      splitOffset: zoneOffset(o.splitZone),
    })
  }

  private recomputeProfiles(conv: Converters, rect: Rect): void {
    const o = this.opts
    let rs = this.rowSize(conv, rect)
    const visKey = o.period === 'visible' ? `${Math.round(conv.xToTime(rect.x))}|${Math.round(conv.xToTime(rect.x + rect.width))}` : ''
    const key = [
      this.bucketsVersion, rs, o.period, o.lengthType, o.lengthValue, o.splitMode, o.splitZone, o.split1, o.split2,
      o.valueAreaPct, o.sensitivity, o.showPeaks || o.showValleys, o.joined.join(','),
      o.zonesEnable, o.zoneProminencePct, o.zoneWidthPct, o.zonesMax, o.customRanges.map((r) => r.join('-')).join(','), visKey,
      this.anchorNyHour, this.anchorUtcHour,
    ].join('|')
    if (key === this.profilesKey) return
    this.profilesKey = key
    const b = this.buckets
    const dayZones = o.zonesEnable && (o.period === 'multiple' || o.period === 'latest')
    const zoneOpts = dayZones ? { prominence: o.zoneProminencePct / 100, width: o.zoneWidthPct / 100, maxEach: o.zonesMax } : null
    const opt = (size: number) => ({ rowSize: size, valueAreaPct: o.valueAreaPct, sensitivity: o.sensitivity, detectNodes: o.showPeaks || o.showValleys, zones: zoneOpts })
    this.prevProfile = null
    // a profile with too many rows for its row size comes back null: retry coarser
    const build = (bs: DpBucket[], start: number, end: number, bases: number[]): DpProfile | null => {
      for (let k = 0; k < 6; k++) {
        const p = buildProfile(bs, start, end, bases, opt(rs))
        if (p || bs.length === 0) return p
        rs *= 10
      }
      return null
    }
    const out: DpProfile[] = []
    this.groupsBases = []
    if (b.length === 0) {
      this.profiles = out
      return
    }
    const dataEnd = b[b.length - 1].end
    if (o.period === 'composite') {
      const p = build(b, b[0].time, dataEnd, [b[0].time])
      if (p) out.push(p)
    } else if (o.period === 'visible') {
      const from = conv.xToTime(rect.x)
      const to = conv.xToTime(rect.x + rect.width)
      const p = build(bucketsIn(b, from, to), from, to, [from])
      if (p) out.push(p)
    } else if (o.period === 'custom') {
      o.customRanges.forEach((r, i) => {
        const p = build(bucketsIn(b, r[0], r[1]), r[0], r[1], [r[0]])
        if (p) out.push({ ...p, customIndex: i })
      })
    } else {
      const groups = groupPeriods(b, this.clock(), new Set(o.joined))
      this.groupsBases = groups.map((g) => g.bases)
      // Latest still builds the session before it when zones are on (its zones extend into today)
      const first = o.period === 'latest' ? groups.length - (dayZones ? 2 : 1) : 0
      for (let gi = Math.max(0, first); gi < groups.length; gi++) {
        const g = groups[gi]
        const end = gi + 1 < groups.length ? groups[gi + 1].bases[0] : dataEnd
        const p = build(b.slice(g.i0, g.i1), g.bases[0], end, g.bases)
        if (!p) continue
        if (o.period === 'latest' && gi < groups.length - 1) this.prevProfile = p
        else out.push(p)
      }
    }
    this.profiles = out
  }

  // ---------------------------------------------------------------- draw ----

  private start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      if (this.builder) for (const c of this.builder.flush(Date.now())) this.pushUnit(clusterUnit(c))
      this.draw()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  private stop(): void {
    this.running = false
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private draw(): void {
    const dpr = window.devicePixelRatio || 1
    this.ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr)
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect) return
    this.ensureVisibleTape(conv, rect)
    const now = performance.now()
    if (now - this.lastRecompute >= RECOMPUTE_MS || this.profilesKey === '') {
      this.lastRecompute = now
      this.refreshBuckets()
    }
    this.recomputeProfiles(conv, rect)

    const ctx = this.ctx
    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    const side = this.opts.period === 'composite' || this.opts.period === 'visible'
    const slot = this.slotWidth(conv)
    if (this.opts.zonesEnable) this.drawZones(conv, rect, slot)
    for (const p of this.profiles) {
      let box: { x0: number; x1: number; dir: 1 | -1; edge?: number }
      if (side) {
        const w = rect.width * this.opts.sideWidthPct
        box = this.opts.placement === 'right' ? { x0: rect.x + rect.width - w, x1: rect.x + rect.width, dir: -1 } : { x0: rect.x, x1: rect.x + w, dir: 1 }
      } else {
        const x0 = conv.timeToX(p.start) - slot / 2
        const x1 = conv.timeToX(p.end) - slot / 2
        if (x1 < rect.x || x0 > rect.x + rect.width) continue
        // Sticky: a period that began off-screen draws from the pane's left
        // edge, so a long profile (a day on a 1m chart) stays readable.
        const dir = this.opts.periodAlign === 'right' ? -1 : 1
        box = { x0: Math.max(x0, rect.x), x1: Math.min(x1, rect.x + rect.width), dir, edge: dir === 1 ? x0 : x1 }
      }
      this.drawProfile(conv, rect, p, box, slot)
    }
    ctx.restore()
    this.updateTag()
  }

  /**
   * HVN / LVN bands of a session's profile, drawn across that session and on
   * through the next one (the live session's run to the chart's right edge).
   * 'previous' scope: only the last completed session's, i.e. yesterday's
   * zones carried through today.
   */
  private drawZones(conv: Converters, rect: Rect, slot: number): void {
    const o = this.opts
    if (o.period !== 'multiple' && o.period !== 'latest') return
    const seq = o.period === 'latest' ? [this.prevProfile, ...this.profiles].filter((p): p is DpProfile => p !== null) : this.profiles
    if (seq.length === 0) return
    const right = rect.x + rect.width
    const sources = o.zonesScope === 'previous' ? (seq.length >= 2 ? [seq.length - 2] : []) : seq.map((_, i) => i)
    const ctx = this.ctx
    const tick = o.tickSize > 0 ? o.tickSize : this.symbolTick
    const dp = Math.max(0, Math.min(6, -Math.floor(Math.log10(tick) + 1e-9)))
    const fmtP = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
    const xOf = (t: number): number => conv.timeToX(t) - slot / 2
    ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    for (const k of sources) {
      const p = seq[k]
      const next = seq[k + 1]
      const x0 = Math.max(rect.x, xOf(p.start))
      // through the next session; the live (last) one runs on to the chart's right edge
      const x1 = !next || k + 1 === seq.length - 1 ? right : Math.min(right, xOf(next.end))
      if (x1 <= x0 || x1 < rect.x) continue
      // label where the zone enters the next session, else at its own start when that's too close to the edge
      const enter = next ? Math.max(rect.x, xOf(next.start)) : x0
      const labelX = (right - enter >= 230 ? enter : x0) + 4
      const prefix = k === seq.length - 2 ? 'PD ' : ''
      for (const z of p.zones) {
        const hvn = z.kind === 'hvn'
        if (hvn ? !o.showHvnZones : !o.showLvnZones) continue
        const { lo, hi } = z
        const yTop = conv.priceToY(hi)
        const yBot = conv.priceToY(lo)
        const y = Math.min(yTop, yBot)
        const h = Math.max(1, Math.abs(yBot - yTop))
        if (y > rect.y + rect.height || y + h < rect.y) continue
        const color = hvn ? o.hvnZoneColor : o.lvnZoneColor
        ctx.globalAlpha = hvn ? 0.14 : 0.11
        ctx.fillStyle = color
        ctx.fillRect(x0, y, x1 - x0, h)
        ctx.globalAlpha = 0.85
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.setLineDash(hvn ? [] : [4, 3])
        ctx.beginPath()
        ctx.moveTo(x0, Math.round(y) + 0.5)
        ctx.lineTo(x1, Math.round(y) + 0.5)
        ctx.moveTo(x0, Math.round(y + h) - 0.5)
        ctx.lineTo(x1, Math.round(y + h) - 0.5)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
        if (o.zoneLabels) {
          const text = `${prefix}${hvn ? 'HVN' : 'LVN'} ${fmtP(lo)}–${fmtP(hi)} · Δ ${signed(z.delta)}`
          const ty = h >= 14 ? y + h / 2 : y - 7
          const tw = ctx.measureText(text).width
          const lx = Math.max(rect.x + 4, Math.min(labelX, right - tw - 6)) // keep it on the chart
          ctx.fillStyle = 'rgba(14,16,22,0.82)' // readable over the profile bars
          ctx.fillRect(lx - 3, ty - 7, tw + 6, 14)
          ctx.fillStyle = color
          ctx.fillText(text, lx, ty)
        }
      }
    }
  }

  private slotWidth(conv: Converters): number {
    const b = this.buckets
    if (b.length === 0) return 0
    const last = b[b.length - 1]
    return Math.abs(conv.timeToX(last.end) - conv.timeToX(last.time))
  }

  private drawProfile(conv: Converters, rect: Rect, p: DpProfile, box: { x0: number; x1: number; dir: 1 | -1; edge?: number }, slot: number): void {
    const ctx = this.ctx
    const o = this.opts
    const n = p.buy.length
    const boxW = Math.max(0, box.x1 - box.x0)
    if (boxW < 2) return
    const L = boxW * o.fillPct
    const yOf = (price: number): number => conv.priceToY(price)
    // only rows on screen
    const pTop = conv.yToPrice(rect.y)
    const pBot = conv.yToPrice(rect.y + rect.height)
    const lo = Math.min(pTop, pBot)
    const hi = Math.max(pTop, pBot)
    const r0 = Math.max(0, Math.floor((lo - p.rowLo) / p.rowSize) - 1)
    const r1 = Math.min(n - 1, Math.ceil((hi - p.rowLo) / p.rowSize) + 1)
    if (r0 > r1) return

    let maxTot = 0
    let maxAbsD = 0
    for (let r = 0; r < n; r++) {
      const t = p.buy[r] + p.sell[r]
      if (t > maxTot) maxTot = t
      maxAbsD = Math.max(maxAbsD, Math.abs(p.buy[r] - p.sell[r]))
    }
    if (maxTot <= 0) return

    const deltaVolume = o.vbpType === 'deltaVolume'
    // Delta + Volume: by default the axis is the session's open line (end line when
    // aligned right): delta grows outward, before the open, and volume on into the
    // session, so every level is marked at the open. A session that began off-screen
    // (sticky box) and the 'inside' option keep the delta strip inside the session.
    const deltaLen = L * DV_DELTA_SHARE
    const volLen = L - deltaLen
    const edgeOnScreen = box.edge !== undefined && box.edge >= rect.x && box.edge <= rect.x + rect.width
    const axis = o.dvAxis === 'sessionStart' && edgeOnScreen ? (box.edge as number) : box.dir === 1 ? box.x0 + deltaLen : box.x1 - deltaLen
    const anchor = box.dir === 1 ? box.x0 : box.x1
    const rowPx = Math.abs(yOf(p.rowLo + p.rowSize) - yOf(p.rowLo))
    const labelRows = o.showValues && rowPx >= 9
    ctx.font = `600 ${Math.max(8, Math.min(11, rowPx * 0.8))}px ui-monospace, monospace`
    ctx.textBaseline = 'middle'

    for (let r = r0; r <= r1; r++) {
      const buy = p.buy[r]
      const sell = p.sell[r]
      const tot = buy + sell
      if (tot <= 0) continue
      const yTop = yOf(p.rowLo + (r + 1) * p.rowSize)
      const yBot = yOf(p.rowLo + r * p.rowSize)
      const y = Math.min(yTop, yBot)
      const h = Math.max(1, Math.abs(yBot - yTop) - (rowPx >= 4 ? 1 : 0))
      const isPoc = o.pocEnable && o.pocHighlight && r === p.pocRow
      const inVa = r >= p.valRow && r <= p.vahRow
      ctx.globalAlpha = o.alpha * (o.showValueArea && !inVa ? 0.5 : 1)
      const bar = (x: number, w: number, color: string): void => {
        ctx.fillStyle = isPoc ? o.pocColor : color
        ctx.fillRect(w >= 0 ? x : x + w, y, Math.max(1, Math.abs(w)), h)
      }
      const delta = buy - sell
      let labelX = anchor
      let label = ''
      if (o.vbpType === 'volume') {
        const w = (tot / maxTot) * L * box.dir
        bar(anchor, w, o.volumeColor)
        labelX = anchor + w
        label = fmtNum(tot)
      } else if (o.vbpType === 'delta') {
        const w = maxAbsD > 0 ? (Math.abs(delta) / maxAbsD) * L * box.dir : 0
        bar(anchor, w, delta >= 0 ? o.askColor : o.bidColor)
        labelX = anchor + w
        label = signed(delta)
      } else if (o.vbpType === 'bidask') {
        // bid then ask, end to end from the anchor: the row's length is its volume
        const bw = (sell / maxTot) * L * box.dir
        const aw = (buy / maxTot) * L * box.dir
        bar(anchor, bw, o.bidColor)
        bar(anchor + bw, aw, o.askColor)
        labelX = anchor + bw + aw
        label = `${fmtNum(sell)}×${fmtNum(buy)}`
      } else {
        // Delta + Volume: delta toward the session edge, total volume on into the session
        bar(axis, maxAbsD > 0 ? -(Math.abs(delta) / maxAbsD) * deltaLen * box.dir : 0, delta >= 0 ? o.askColor : o.bidColor)
        bar(axis, (tot / maxTot) * volLen * box.dir, o.volumeColor)
      }
      ctx.globalAlpha = 1
      if (labelRows) {
        ctx.fillStyle = '#d1d4dc'
        if (deltaVolume) {
          ctx.textAlign = box.dir === 1 ? 'right' : 'left'
          ctx.fillText(signed(delta), axis - 3 * box.dir, y + h / 2)
          ctx.textAlign = box.dir === 1 ? 'left' : 'right'
          ctx.fillText(fmtNum(tot), axis + 3 * box.dir, y + h / 2)
        } else {
          ctx.textAlign = box.dir === 1 ? 'left' : 'right'
          ctx.fillText(label, labelX + 3 * box.dir, y + h / 2)
        }
      }
    }
    if (deltaVolume) {
      ctx.strokeStyle = 'rgba(160,165,180,0.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(Math.round(axis) + 0.5, yOf(p.rowLo + n * p.rowSize))
      ctx.lineTo(Math.round(axis) + 0.5, yOf(p.rowLo))
      ctx.stroke()
    }

    const priceOfRow = (r: number): number => p.rowLo + (r + 0.5) * p.rowSize
    const windowRight = rect.x + rect.width
    const hline = (r: number, color: string, width: number, dash: number[], extend: boolean): void => {
      const y = Math.round(yOf(priceOfRow(r))) + 0.5
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.setLineDash(dash)
      ctx.beginPath()
      ctx.moveTo(box.x0, y)
      ctx.lineTo(extend ? windowRight : box.x1, y)
      ctx.stroke()
      ctx.setLineDash([])
    }

    if (o.showValueArea) {
      hline(p.vahRow, 'rgba(160,165,180,0.6)', 1, [3, 3], false)
      hline(p.valRow, 'rgba(160,165,180,0.6)', 1, [3, 3], false)
    }
    if (o.showPeaks) for (const r of p.peaks) hline(r, o.peakColor, 1, [], o.extendNodes)
    if (o.showValleys) for (const r of p.valleys) hline(r, o.valleyColor, 1, [4, 3], o.extendNodes)

    if (o.pocEnable && o.pocLine !== 'none') {
      const side = o.period === 'composite' || o.period === 'visible'
      if (o.pocLine === 'developing' && !side && p.developing.length) {
        ctx.strokeStyle = o.pocLineColor
        ctx.lineWidth = o.pocLineWidth
        ctx.beginPath()
        for (let i = 0; i < p.developing.length; i++) {
          const [t, r] = p.developing[i]
          const x = Math.max(box.x0, conv.timeToX(t) - slot / 2)
          const y = Math.round(yOf(priceOfRow(r))) + 0.5
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y) // vertical step to the new POC
          const nx = i + 1 < p.developing.length ? conv.timeToX(p.developing[i + 1][0]) - slot / 2 : o.pocExtend ? windowRight : box.x1
          ctx.lineTo(nx, y)
        }
        ctx.stroke()
      } else {
        hline(p.pocRow, o.pocLineColor, o.pocLineWidth, [], o.pocExtend)
      }
    }

    if (o.showTotals && boxW >= 40) {
      const vol = p.totalBuy + p.totalSell
      const d = p.totalBuy - p.totalSell
      const parts = [`${o.countTrades ? 'T' : 'V'} ${fmtNum(vol)}`, `Δ ${signed(d)}`]
      if (p.estShare > 0.02) parts.push(`~${Math.round(p.estShare * 100)}% est`)
      if (filterActive(o)) parts.push(`size ${o.minFilter > 0 ? `≥${o.minFilter}` : ''}${o.minFilter > 0 && o.maxFilter > 0 ? ' ' : ''}${o.maxFilter > 0 ? `≤${o.maxFilter}` : ''}`)
      const yTopProfile = yOf(p.rowLo + n * p.rowSize)
      ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      ctx.textBaseline = 'bottom'
      ctx.textAlign = box.dir === 1 ? 'left' : 'right'
      ctx.fillStyle = d >= 0 ? o.askColor : o.bidColor
      const tx = box.dir === 1 ? box.x0 + 2 : box.x1 - 2
      // keep the header inside its own profile: drop trailing parts until it fits
      while (parts.length && ctx.measureText(parts.join('  ')).width > boxW - 4) parts.pop()
      if (parts.length) ctx.fillText(parts.join('  '), tx, Math.max(rect.y + 11, yTopProfile - 3))
    }
  }

  private updateTag(): void {
    const o = this.opts
    const p = this.profiles[this.profiles.length - 1]
    if (!p || !o.pocEnable || !o.pocTag) {
      this.engine.setPriceTags(TAG_SOURCE, [])
      return
    }
    this.engine.setPriceTags(TAG_SOURCE, [{ price: p.rowLo + (p.pocRow + 0.5) * p.rowSize, color: o.pocLineColor, label: 'DP POC' }])
  }
}
