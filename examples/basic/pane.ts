// One chart in the grid: wraps a chart engine plus its own symbol/interval/
// chart-type/indicator/drawing state and live data subscription. The grid owns
// many of these; the toolbar drives whichever is active.
import {
  createChartEngine,
  DEFAULT_SETTINGS,
  type IChartEngine,
  type Candle,
  type Interval,
  type ChartType,
  type Theme,
  type SymbolInfo,
  type IndicatorRenderData,
  type IndicatorOutput,
  type IndicatorDef,
  type DrawingToolId,
  type Drawing,
  INTERVAL_MS,
} from '../../src/index'

/** The subset of a data provider a chart pane needs (spot or options). */
export interface PaneProvider {
  getSymbolInfo(symbol: string): Promise<SymbolInfo>
  fetchCandles(symbol: string, interval: Interval, limit?: number, endTime?: number): Promise<Candle[]>
  subscribeCandles(symbol: string, interval: Interval, onUpdate: (candle: Candle) => void): () => void
  subscribeTrades(symbol: string, onTrade: (trade: ExchangeTradeEvent) => void): () => void
  subscribeTickers(symbols: string[], onTick: (update: TickerUpdate) => void): () => void
  subscribeDepth(symbol: string, onDepth: (depth: import('../../src/data/types').DepthSnapshot) => void): () => void
}
import { resolveIndicator, getSignalSource, getCanvasSource, FULL_HISTORY_INDICATOR_IDS, type CanvasSource, type Signal } from './custom-indicators'
import { sampleCandles } from './sample-candles'
import TradeRainOverlay from '../../src/overlays/tradeRain'
import OrderFlowOverlay from '../../src/overlays/orderflow'
import BuySellPollOverlay from '../../src/overlays/buySellPoll'
import ICTOverlay from '../../src/overlays/ict'
import DepthImbalanceOverlay from '../../src/overlays/depthImbalance'
import LiquidityLevelsOverlay from '../../src/overlays/liquidityLevels'
import BigTradesOverlay, { type BigTradesOptions } from '../../src/overlays/bigTrades'
import DeepTradesOverlay, { type DeepTradesOptions } from '../../src/overlays/deepTrades'
import HeavyAbsorptionOverlay, { type HeavyAbsorptionOverlayOptions } from '../../src/overlays/heavyAbsorption'
import BlockBreakOverlay, { type BlockBreakOverlayOptions } from '../../src/overlays/blockBreak'
import DeepProfileOverlay, { type DeepProfileOptions, type DpHit, type DpProfileAction } from '../../src/overlays/deepProfile'
import DeepStatsOverlay, { type DeepStatsOptions } from '../../src/overlays/deepStats'
import { askNotificationPermissionOnce, fireSignalAlert } from './signalAlert'
import { computeGexSabersModel } from './gexSabers'
import VolumeProfileOverlay, { type VolumeProfileOptions } from '../../src/overlays/volumeProfile'
import FootprintOverlay, { type FootprintOptions, type RecordedTape } from '../../src/overlays/footprint'
import GexOverlay, { type GexOptions, isGexUnderlying } from './gex'
import { fetchOptionChain } from './options'
import IVWallsOverlay, { type IVWallsOptions } from '../../src/overlays/ivWalls'
import IvZonesOverlay from '../../src/overlays/ivZones'
import type { IvZonesOptions } from '../../src/overlays/ivZonesModel'
import { sessionOpenHourUTC, sessionOpenNyHour } from '../../src/core/session'
import CprOverlay, { PREV_HL_LABEL, type CprOptions } from '../../src/overlays/cpr'
import { isRebinnedChartType } from '../../src/chart/types'
import GexV2Overlay, { type GexV2Options } from './gexV2'
import FlagPatternsOverlay, { type FlagPatternsOptions } from './flagPatterns'
import SetupChecklistOverlay, { type SetupChecklistOptions } from './setupChecklist'
import ConfluenceOverlay from './confluence'
import DominanceTableOverlay from './dominanceTable'
import UltraV2Overlay, { type UltraV2Options } from '../../src/overlays/ultraV2'
import FvgStrategyOverlay, { type FvgStrategyOptions } from '../../src/overlays/fvgStrategy'
import CprStrategyOverlay, { type CprStrategyOverlayOptions } from '../../src/overlays/cprStrategy'
import FvVwapEmaOverlay, { type FvVwapEmaOverlayOptions } from '../../src/overlays/fvVwapEma'
import HalfTrendOverlay, { type HalfTrendOverlayOptions } from '../../src/overlays/halfTrend'
import IvFvStrategyOverlay, { type IvFvStrategyOverlayOptions } from '../../src/overlays/ivFvStrategy'
import ZoneRetestOverlay, { type ZoneRetestOverlayOptions } from '../../src/overlays/zoneRetest'
import IvFadeOverlay, { type IvFadeOptions } from '../../src/overlays/ivFade'
import DcBigTradesOverlay, { DC_PATTERN_LABEL, type DcBigTradesOptions } from '../../src/overlays/dcBigTrades'
import type { StrategyOverlay, StrategySource } from '../../src/strategy/types'
import BuddyLevelsOverlay, { type BuddyLevels } from '../../src/overlays/buddyLevels'
import type { TradeEvent as ExchangeTradeEvent, TickerUpdate } from '../../src/data/types'
import { INTENSITY_PER_DAY } from '../../src/overlays/takerOrders'
import { fetchTapeHistory } from './tapeHistory'
import { symbolLogo } from './symbolMeta'
import { computeIndicatorIncremental, type IndicatorCacheEntry } from '../../src/indicators/incremental'
import { DrawingStyleBar, createZoomPill, CompareManager, type CompareEntry } from './paneExtras'

/** One bar plus every visible legend row's values, for the Data window. */
export interface DataWindowSnapshot {
  candle: Candle | null
  /** True while the crosshair is on a bar (false = showing the last bar). */
  hovering: boolean
  rows: { label: string; values: ToolLegendValue[]; hidden: boolean }[]
}

/**
 * First index i such that timeToX(candles[i].time) >= x. Candles are
 * time-sorted and timeToX is monotonic in time, so this bisects instead of
 * scanning every loaded candle to find the visible window's left edge.
 */
function lowerBoundByX(candles: Candle[], x: number, conv: { timeToX(t: number): number }): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (conv.timeToX(candles[mid].time) < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First index i such that timeToX(candles[i].time) > x — the visible window's right edge (exclusive). */
function upperBoundByX(candles: Candle[], x: number, conv: { timeToX(t: number): number }): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (conv.timeToX(candles[mid].time) <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Rounded-rect path helper for the signal pills. */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Draw one BUY/SELL/flag label (pill + pointer), or a plain dot, anchored at (x, y) in CSS px. */
function drawSignal(ctx: CanvasRenderingContext2D, x: number, y: number, s: Signal): void {
  if (s.shape === 'dot') {
    // Pine plotshape(style=shape.circle) equivalent — a plain filled dot at
    // the exact anchor, no pointer/text/direction offset.
    ctx.beginPath()
    ctx.fillStyle = s.color ?? '#2962ff'
    ctx.arc(x, y, 3.5, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  const buy = s.kind === 'buy'
  // 'sell' and neutral 'flag' markers (e.g. Blast Candle) both sit above the
  // anchor with a downward pointer; only 'buy' sits below with an upward one.
  const color = s.color ?? (buy ? '#089981' : s.kind === 'sell' ? '#f23645' : '#2962ff')
  ctx.font = "700 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  const padX = 5
  const bh = 16
  const bw = ctx.measureText(s.text).width + padX * 2
  const gap = 9
  const cy = buy ? y + gap + bh / 2 : y - gap - bh / 2 // below the anchor (buy) / above it (sell, flag)

  ctx.fillStyle = color
  ctx.beginPath() // pointer triangle toward the bar
  if (buy) {
    const ty = cy - bh / 2
    ctx.moveTo(x, ty - 5)
    ctx.lineTo(x - 4, ty)
    ctx.lineTo(x + 4, ty)
  } else {
    const ty = cy + bh / 2
    ctx.moveTo(x, ty + 5)
    ctx.lineTo(x - 4, ty)
    ctx.lineTo(x + 4, ty)
  }
  ctx.closePath()
  ctx.fill()

  roundRect(ctx, x - bw / 2, cy - bh / 2, bw, bh, 3)
  ctx.fillStyle = color
  ctx.fill()

  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(s.text, x - bw / 2 + padX, cy + 0.5)
}

/** One active indicator on a pane: its definition id + customized params/colors. */
export interface IndicatorInstance {
  defId: string
  params: Record<string, number>
  colors: Record<string, string> // output name -> hex override
  hidden?: string[] // output names whose line is hidden
  visible?: boolean // whole-indicator visibility (default true)
}

/** Everything needed to recreate a pane (this is what a saved layout stores). */
export interface PaneState {
  symbol: string
  interval: Interval
  chartType: ChartType
  indicators: IndicatorInstance[]
  drawings: Drawing[] // the CURRENT symbol's drawings — kept in sync with drawingsBySymbol[symbol]
  drawingsBySymbol?: Record<string, Drawing[]> // every OTHER loaded symbol's drawings, restored on switching back
  tradeRain?: boolean
  orderFlow?: boolean
  liquidityLevels?: boolean
  buySellPoll?: boolean
  dominanceV2?: boolean
  ict?: boolean
  depthImbalance?: boolean
  confluence?: boolean
  bigTrades?: boolean
  bigTradesOptions?: Partial<BigTradesOptions>
  deepTrades?: boolean
  deepTradesOptions?: Partial<DeepTradesOptions>
  heavyAbsorption?: boolean
  heavyAbsorptionOptions?: Partial<HeavyAbsorptionOverlayOptions>
  blockBreak?: boolean
  blockBreakOptions?: Partial<BlockBreakOverlayOptions>
  deepProfile?: boolean
  deepProfileOptions?: Partial<DeepProfileOptions>
  deepStats?: boolean
  /** Separate-pane heights (CSS px) by indicator id, set by dragging the line above a pane. */
  paneHeights?: Record<string, number>
  deepStatsOptions?: Partial<DeepStatsOptions>
  footprintOptions?: Partial<FootprintOptions>
  volumeProfileOptions?: Partial<VolumeProfileOptions>
  gexOptions?: Partial<GexOptions>
  gexV2Options?: Partial<GexV2Options>
  ivWallsOptions?: Partial<IVWallsOptions>
  ivZonesOptions?: Partial<IvZonesOptions>
  cprOptions?: Partial<CprOptions>
  /** Power tools switched off with the legend's eye icon — kept in the legend so they can be switched back on. */
  hiddenTools?: string[]
  /** Legend shows every row instead of the first LEGEND_VISIBLE_ROWS + "N more". */
  legendExpanded?: boolean
  flagPatternsOptions?: Partial<FlagPatternsOptions>
  setupChecklistOptions?: Partial<SetupChecklistOptions>
  ultraV2?: boolean
  ultraV2Options?: Partial<UltraV2Options>
  fvgStrategy?: boolean
  fvgStrategyOptions?: Partial<FvgStrategyOptions>
  cprStrategy?: boolean
  cprStrategyOptions?: Partial<CprStrategyOverlayOptions>
  fvVwapEma?: boolean
  fvVwapEmaOptions?: Partial<FvVwapEmaOverlayOptions>
  halfTrend?: boolean
  halfTrendOptions?: Partial<HalfTrendOverlayOptions>
  ivFvStrategy?: boolean
  ivFvStrategyOptions?: Partial<IvFvStrategyOverlayOptions>
  zoneRetest?: boolean
  zoneRetestOptions?: Partial<ZoneRetestOverlayOptions>
  ivFade?: boolean
  ivFadeOptions?: Partial<IvFadeOptions>
  dcBigTrades?: boolean
  dcBigTradesOptions?: Partial<DcBigTradesOptions>
  /** Other symbols drawn on this chart (Compare). */
  compares?: CompareEntry[]
}

export type PaneStatus = 'loading' | 'live' | 'synthetic'

export function defaultIndicatorInstance(defId: string): IndicatorInstance {
  const def = resolveIndicator(defId)
  const params = def ? Object.fromEntries(def.params.map((p) => [p.key, p.default])) : {}
  return { defId, params, colors: {}, hidden: [] }
}

export interface ToolLegendValue {
  text: string
  color: string
}

export interface ToolLegendRow {
  id: string
  label: string
  /** Swatch colour shown before the name (the series' line colour). */
  color?: string
  values: ToolLegendValue[]
  hidden: boolean
  onToggle(): void
  onSettings?: () => void
  /** Compact dropdown beside the name — e.g. CPR's Day / Week / Month. */
  select?: { title: string; value: string; options: [string, string][]; onChange(v: string): void }
  onRemove(): void
  onMoveUp?: () => void
  onMoveDown?: () => void
}

/** Rewrite a legend row's values in place (same count as when it was built). */
function patchLegendValues(row: HTMLElement, r: ToolLegendRow): void {
  const vals = row.querySelectorAll<HTMLElement>(':scope > .tl-val')
  r.values.forEach((v, i) => {
    const el = vals[i]
    if (!el) return
    if (el.textContent !== v.text) el.textContent = v.text
    if (el.style.color !== v.color) el.style.color = v.color
  })
}

/** Legend rows shown before the rest fold behind "⌄ N more" (Vela-style: just the first, so candles stay clear). */
const LEGEND_VISIBLE_ROWS = 1

/** Venue shown in each chart's title row. */
const PANE_VENUE = 'DELTA INDIA'

/** Power Tools fed only by live streams (trade tape, order book, live option chain) — paused in bar replay. */
const LIVE_ONLY_TOOLS = new Set(['tradeRain', 'buySellPoll', 'dominanceV2', 'depthImbalance', 'liquidityLevels', 'gexV2'])

/** Deep Trades has no days-to-load setting of its own; it loads this much recorded tape. */
const DEEP_TRADES_HISTORY_DAYS = 3
/** Option changes that alter which recorded clusters qualify — they refetch the history. */
const BIG_TRADES_HISTORY_KEYS: (keyof BigTradesOptions)[] = ['autoFilter', 'intensity', 'minVolume', 'calculationMode', 'daysToLoad']
const DEEP_TRADES_HISTORY_KEYS: (keyof DeepTradesOptions)[] = ['autoFilter', 'intensity', 'minVolume', 'hollowMinCount']

const svgIcon = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const LEGEND_ICONS = {
  eye: svgIcon('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svgIcon('<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1.1"/>'),
  gear: svgIcon('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>'),
  close: svgIcon('<path d="M6 6l12 12M18 6L6 18"/>'),
  more: svgIcon('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
}

/** Short legend label, e.g. "SMA 20" or "MACD 12 26 9". */
function labelFor(defId: string, params: Record<string, number>): string {
  const def = resolveIndicator(defId)
  if (!def) return defId
  // Checkbox / dropdown values aren't meaningful numbers; sectioned (grouped) settings are too many to list.
  const shown = def.params.filter((p) => !p.toggle && !p.options)
  if (shown.length === 0 || def.params.some((p) => p.group)) return def.shortLabel
  return `${def.shortLabel} ${shown.map((p) => params[p.key]).join(' ')}`
}

/**
 * Live-tick indicator recompute: a verified trailing-slice splice (see
 * src/indicators/incremental.ts). Running totals such as VWAP / OBV / CVD fail
 * the verification and are recomputed in full, so they never bend at the edge.
 */
function computeIndicatorOutputs(
  cache: Map<string, IndicatorCacheEntry>,
  candles: Candle[],
  def: IndicatorDef,
  inst: IndicatorInstance,
): IndicatorOutput[] {
  return computeIndicatorIncremental(cache, inst.defId, candles, def, inst.params, FULL_HISTORY_INDICATOR_IDS.has(inst.defId))
}

/** Symbols Delta serves 5-second candles for. */
const FIVE_SECOND_SYMBOLS = new Set(['BTCUSD', 'ETHUSD'])
/** Fastest that indicators re-run on the forming bar's ticks (ms); a new bar re-runs them at once. */
const TICK_RECOMPUTE_MS = 250

export class ChartPane {
  readonly root: HTMLElement
  readonly engine: IChartEngine
  state: PaneState
  candles: Candle[] = []
  status: PaneStatus = 'loading'
  statusDetail = ''
  /** Local receipt time of the most recent live/synthetic candle. Kept
   * separate from candle.time so the UI can expose a stalled feed. */
  lastUpdateAt = 0

  onActivate?: () => void
  onStatusChange?: () => void
  onToolDone?: () => void
  /**
   * Every live update: the latest price plus the high / low reached since this pane's
   * previous update (so a spike through an alert level between updates is not missed)
   * and when that previous update arrived.
   */
  onTick?: (symbol: string, price: number, high?: number, low?: number, since?: number) => void
  private alertTick: { symbol: string; time: number; high: number; low: number; at: number } | null = null
  onData?: () => void
  onAlertRemove?: (id: string) => void
  onAlertMove?: (id: string, price: number) => void
  onContextMenu?: (info: { x: number; y: number; price: number; time: number }) => void
  onAddAlert?: (symbol: string, price: number) => void

  /** Drawings were added / moved / removed / undone. */
  onDrawingsUpdate?: () => void
  /** Undo / redo availability may have changed. */
  onHistoryChange?: () => void
  /** The crosshair moved to another bar (or left the chart). */
  onLegendIndexChange?: () => void
  /** Crosshair bar time (null = left the chart) — layout crosshair sync. */
  onCrosshairTime?: (time: number | null) => void
  /** The user panned / zoomed — layout time sync. */
  onViewChange?: () => void
  /** Price-axis "%" button clicked (host owns the scale mode). */
  onPercentToggle?: (next: 'price' | 'percent' | 'indexed') => void
  /** Axis corner time-zone label clicked (client px). */
  onTimeZoneCorner?: (clientX: number, clientY: number) => void

  private styleBar: DrawingStyleBar | null = null
  private compare: CompareManager | null = null

  private readonly canvasHost: HTMLElement
  private readonly headEl: HTMLElement
  private readonly headRo: ResizeObserver
  private readonly logoEl: HTMLElement
  private readonly symEl: HTMLElement
  private readonly priceEl: HTMLElement
  private readonly changeEl: HTMLElement
  private tickerUnsub: (() => void) | null = null
  private readonly dotEl: HTMLElement
  private readonly provider: PaneProvider
  private readonly ro: ResizeObserver
  private readonly overlay: HTMLCanvasElement
  private readonly octx: CanvasRenderingContext2D
  private readonly rain: TradeRainOverlay
  private readonly orderflow: OrderFlowOverlay
  private readonly poll: BuySellPollOverlay
  private readonly dominanceV2: DominanceTableOverlay
  private readonly ict: ICTOverlay
  private readonly depthImbalance: DepthImbalanceOverlay
  private readonly liquidityLevels: LiquidityLevelsOverlay
  private readonly confluence: ConfluenceOverlay
  private readonly bigTrades: BigTradesOverlay
  private readonly deepTrades: DeepTradesOverlay
  private readonly heavyAbsorption: HeavyAbsorptionOverlay
  private readonly blockBreak: BlockBreakOverlay
  private readonly deepProfile: DeepProfileOverlay
  private readonly deepStats: DeepStatsOverlay
  /** Separate panes in engine order (pane indicators + tools with their own pane). */
  private separatePaneIds: string[] = []
  private readonly volumeProfileTool: VolumeProfileOverlay
  private readonly footprint: FootprintOverlay
  private readonly gex: GexOverlay
  private readonly gexV2: GexV2Overlay
  private readonly ivWalls: IVWallsOverlay
  private readonly ivZones: IvZonesOverlay
  private readonly cpr: CprOverlay
  private readonly toolLegendEl: HTMLElement
  private toolLegendSig = ''
  private toolRows: ToolLegendRow[] = []
  /** Per-indicator legend data from the last renderIndicators (hidden ones included). */
  private legendIndicators: { inst: IndicatorInstance; label: string; placement: string; outputs: IndicatorOutput[] }[] = []
  /** Bar the legend reads (crosshair), null = last bar. */
  private legendIdx: number | null = null
  private paneLegendEls: HTMLElement[] = []
  private paneLegendSig = ''
  /** Open the indicator's settings dialog (host-owned). */
  onIndicatorSettings?: (defId: string) => void
  /** The indicator list changed from the legend (hide / remove / reorder). */
  onIndicatorsChanged?: () => void
  private readonly flagPatterns: FlagPatternsOverlay
  private readonly setupChecklist: SetupChecklistOverlay
  private readonly ultraV2: UltraV2Overlay
  private readonly fvgStrategy: FvgStrategyOverlay
  private readonly cprStrategy: CprStrategyOverlay
  private readonly fvVwapEma: FvVwapEmaOverlay
  private readonly halfTrend: HalfTrendOverlay
  private readonly ivFvStrategy: IvFvStrategyOverlay
  private readonly zoneRetest: ZoneRetestOverlay
  private readonly ivFade: IvFadeOverlay
  private readonly dcBigTrades: DcBigTradesOverlay
  private readonly buddyLevels: BuddyLevelsOverlay
  private tradeUnsub: (() => void) | null = null
  /** Bumped per request so a slow recorded-tape fetch can't overwrite a newer one. */
  private tapeGen = { big: 0, deep: 0 }
  private signals: Signal[] = []
  private signalsVersion = 0
  /** Canvas-drawn indicators (see CanvasSource) and their models for the current candles. */
  private canvasInds: { src: CanvasSource; model: unknown; defId: string }[] = []
  private canvasVersion = 0
  private lastOverlaySig = ''
  private raf = 0
  private overlayActive = false
  private recomputeScheduled = false
  private needSignalRecompute = false
  private destroyed = false
  private historyLoading = false
  private noMoreHistory = false
  private readonly addAlertBtn: HTMLButtonElement
  private alertHoverPrice: number | null = null
  volumeProfile = false
  private unsub: (() => void) | null = null
  private synthTimer: number | null = null
  private loadGen = 0
  /** Per-indicator (keyed by defId) incremental-recompute cache — see computeIndicatorOutputs(). */
  private readonly indicatorCache = new Map<string, IndicatorCacheEntry>()

  constructor(provider: PaneProvider, theme: Theme, initial: PaneState) {
    this.provider = provider
    this.state = initial

    this.root = document.createElement('div')
    this.root.className = 'pane'

    // Title row (logo · SYMBOL · VENUE · interval · status) floats over the
    // chart's top-left; the engine starts its OHLC row right after it, so the
    // two read as one line (Vela / TradingView style).
    const head = document.createElement('div')
    head.className = 'pane-head'
    this.logoEl = document.createElement('span')
    this.logoEl.className = 'pane-logo'
    this.dotEl = document.createElement('span')
    this.dotEl.className = 'pane-dot'
    this.symEl = document.createElement('span')
    this.symEl.className = 'pane-sym'
    this.priceEl = document.createElement('span')
    this.priceEl.className = 'pane-price'
    this.changeEl = document.createElement('span')
    this.changeEl.className = 'pane-change'
    head.append(this.logoEl, this.symEl, this.dotEl)
    this.headEl = head

    this.canvasHost = document.createElement('div')
    this.canvasHost.className = 'pane-canvas'
    this.root.append(this.canvasHost, head)
    this.toolLegendEl = document.createElement('div')
    this.toolLegendEl.className = 'tool-legend'

    this.engine = createChartEngine(this.canvasHost, {
      theme,
      pricePrecision: 2,
      chartType: initial.chartType,
      onDrawingsChange: (d) => {
        this.state.drawings = d
        this.state.drawingsBySymbol = { ...(this.state.drawingsBySymbol ?? {}), [this.state.symbol]: d }
        this.onDrawingsUpdate?.()
      },
      onHistoryChange: () => this.onHistoryChange?.(),
      onSelectionChange: (d) => this.styleBar?.setDrawing(d),
      onCrosshairTime: (t) => this.onCrosshairTime?.(t),
      onViewChange: () => this.onViewChange?.(),
      onPercentToggle: (next) => this.onPercentToggle?.(next),
      onTimeZoneCornerClick: (x, y) => this.onTimeZoneCorner?.(x, y),
      onActiveToolChange: (tool) => {
        if (tool === null) this.onToolDone?.()
      },
      onAlertRemove: (id) => this.onAlertRemove?.(id),
      onLegendIndex: (i) => {
        this.legendIdx = i
        this.renderLegend()
        this.onLegendIndexChange?.()
      },
      onAlertMove: (id, price) => this.onAlertMove?.(id, price),
      onContextMenu: (info) => this.onContextMenu?.(info),
      onRequestHistory: () => void this.loadMoreHistory(),
      onPaneHeightsChange: (h) => {
        this.state.paneHeights = h
      },
    })
    this.engine.setPaneHeights(this.state.paneHeights ?? {})
    this.engine.setSettings({ ...DEFAULT_SETTINGS, gridVisible: true })
    if (initial.drawings.length) this.engine.setDrawings(initial.drawings)
    this.styleBar = new DrawingStyleBar(this.canvasHost, {
      engine: this.engine,
      onAlert: (price) => this.onAddAlert?.(this.state.symbol, price),
    })
    createZoomPill(this.canvasHost, this.engine)
    this.compare = new CompareManager(provider, this.engine)
    this.compare.onChange = () => this.renderLegend()
    // Keep the OHLC row just right of the floating title, whatever its width.
    this.headRo = new ResizeObserver(() => this.syncLegendInset())
    this.headRo.observe(head)
    // ...and wherever it sits: the title glides (CSS `left` transition) when --chart-inset
    // changes, and a ResizeObserver never sees a move — follow it every frame until it lands,
    // or the OHLC row stays at the old spot and overprints "SYMBOL · VENUE · interval".
    let following = false
    const follow = (): void => {
      this.syncLegendInset()
      if (following) requestAnimationFrame(follow)
    }
    head.addEventListener('transitionrun', (e) => {
      if (e.propertyName !== 'left' || following) return
      following = true
      requestAnimationFrame(follow)
    })
    const land = (e: TransitionEvent): void => {
      if (e.propertyName !== 'left') return
      following = false
      this.syncLegendInset()
    }
    head.addEventListener('transitionend', land)
    head.addEventListener('transitioncancel', land)

    // Transparent overlay above the engine canvas for custom marks (BUY/SELL
    // signal labels). pointer-events:none so the chart stays interactive.
    this.overlay = document.createElement('canvas')
    this.overlay.className = 'pane-overlay'
    this.canvasHost.appendChild(this.overlay)
    this.octx = this.overlay.getContext('2d')!

    // TradingView-style "+" that follows the cursor on the right price scale and
    // adds an alert at that price (so right-click need not place alerts).
    this.addAlertBtn = document.createElement('button')
    this.addAlertBtn.className = 'add-alert-btn'
    this.addAlertBtn.textContent = '+'
    this.addAlertBtn.title = 'Add price alert here'
    this.addAlertBtn.style.display = 'none'
    this.canvasHost.appendChild(this.addAlertBtn)
    this.canvasHost.appendChild(this.toolLegendEl)
    // Indicator rows live in the DOM legend (hide / settings / remove / reorder), not on the canvas.
    this.engine.setIndicatorLegend(false)
    this.addAlertBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.alertHoverPrice != null) this.onAddAlert?.(this.state.symbol, this.alertHoverPrice)
    })
    this.canvasHost.addEventListener('mousemove', (e) => this.positionAddAlert(e))
    this.canvasHost.addEventListener('mouseleave', () => {
      this.addAlertBtn.style.display = 'none'
    })

    // Clicking anywhere in the pane makes it active (capture phase so the chart
    // still receives the pointer for panning).
    this.root.addEventListener('pointerdown', () => this.onActivate?.(), true)

    // Trade Rain / Order Flow / Buy-Sell Poll / Dominance V2 / ICT / Order
    // Book Imbalance / Confluence / Big Trades / Volume Profile & TPO are all
    // toggled from the header's "Power Tools" dropdown (main.ts), not from
    // per-pane buttons here — see setTradeRainEnabled() etc. below, all
    // public so main.ts can dispatch to whichever pane is active. Keeping
    // one shared header control instead of ~9 buttons crammed into every
    // pane's 24px head.

    // TradeRain overlay: attach a particle overlay to the pane and feed it live
    // trades from the provider's trade stream when available.
    this.rain = new TradeRainOverlay(this.canvasHost, this.engine)
    this.rain.start()

    // Buy/Sell poll: a floating live-sentiment gauge, decoupled from the
    // rain's canvas so it can be toggled separately. Both this and trade rain
    // are real-data-only — see TradeRainOverlay's "No trades" idle indicator.
    this.poll = new BuySellPollOverlay(this.canvasHost)

    // Dominance V2: a per-timeframe live table, independent of the poll and
    // of whatever interval this pane's own chart is showing (see
    // dominanceTable.ts). Off by default — unlike the poll/rain, each
    // selected timeframe opens its own extra candle subscription.
    this.dominanceV2 = new DominanceTableOverlay(this.canvasHost, this.provider)
    this.dominanceV2.setSymbol(this.state.symbol)

    this.setTradeRainEnabled(this.state.tradeRain ?? true)
    this.setBuySellPollEnabled(this.state.buySellPoll ?? true)
    this.setDominanceV2Enabled(this.state.dominanceV2 ?? false)

    // OrderFlow Analysis overlay: detect levels, absorption, and institutional footprints
    this.orderflow = new OrderFlowOverlay(this.canvasHost, this.engine, {
      showLevels: true,
      showAbsorption: true,
      showFootprints: true,
      levelPrecision: 100,
      maxLevelsDisplay: 10,
    })
    this.orderflow.start()
    this.setOrderFlowEnabled(this.state.orderFlow ?? false)

    // ICT / Smart Money Concepts overlay: pure OHLC pattern detection (order
    // blocks, fair value gaps, market structure, equal highs/lows,
    // premium/discount) — no trade feed needed, just candles (see ict.ts).
    this.ict = new ICTOverlay(this.canvasHost, this.engine)
    this.ict.start()
    this.setICTEnabled(this.state.ict ?? false)

    // Auto Flag Pattern Detection: pole + tight consolidation + confirmed
    // breakout (see flagPatterns.ts) — pure OHLCV pattern detection, plots
    // both the live forming flag and confirmed historical ones.
    this.flagPatterns = new FlagPatternsOverlay(this.canvasHost, this.engine, this.state.flagPatternsOptions)
    this.flagPatterns.start()
    this.flagPatterns.setCandles(this.candles)
    this.setFlagPatternsEnabled(this.state.flagPatternsOptions?.enabled ?? false)

    // Order book imbalance: a LEADING signal (resting liquidity, not executed
    // trades) — see depthImbalance.ts.
    this.depthImbalance = new DepthImbalanceOverlay(this.canvasHost, this.provider)
    this.depthImbalance.setSymbol(this.state.symbol)
    this.setDepthImbalanceEnabled(this.state.depthImbalance ?? false)

    this.liquidityLevels = new LiquidityLevelsOverlay(this.canvasHost, this.engine, this.provider)
    this.liquidityLevels.setSymbol(this.state.symbol)
    this.setLiquidityLevelsEnabled(this.state.liquidityLevels ?? false)

    // Confluence: fires a setup marker only when level proximity + dominance
    // + imbalance + absorption agree — reads live state from orderflow/depth.
    this.confluence = new ConfluenceOverlay(this.canvasHost, this.engine, this.orderflow, this.depthImbalance)
    this.confluence.start()
    this.setConfluenceEnabled(this.state.confluence ?? false)

    // Big Trades: individual large trades plotted on the price chart, sized
    // by volume — see bigTrades.ts. Historical bars are an estimate; only
    // live trades (fed below) are exact.
    this.bigTrades = new BigTradesOverlay(this.canvasHost, this.engine, this.state.bigTradesOptions)
    this.bigTrades.start()
    this.setBigTradesEnabled(this.state.bigTrades ?? false)

    // Heavy Absorption: statistically big taker orders at their exact price, and
    // whether the passive side held them — exact history from the tape recorder,
    // live trades fed below. See heavyAbsorption.ts.
    this.heavyAbsorption = new HeavyAbsorptionOverlay(this.canvasHost, this.engine, () => this.candles, (from, to) => this.fetchRecordedTape(from, to), this.state.heavyAbsorptionOptions)
    this.heavyAbsorption.onAlert = (text, sound) => fireSignalAlert(`Heavy Absorption · ${this.state.symbol}`, text, sound)
    this.heavyAbsorption.setSymbol(this.state.symbol)
    this.setHeavyAbsorptionEnabled(this.state.heavyAbsorption ?? false)

    // Block Break: fresh 1H/4H block broken with a stacked footprint imbalance, from the
    // recorded tape + live trades (1-minute footprint built in the overlay). See blockBreak.ts.
    this.blockBreak = new BlockBreakOverlay(this.canvasHost, this.engine, () => this.candles, (from, to) => this.fetchRecordedTape(from, to), this.state.blockBreakOptions)
    this.blockBreak.onAlert = (text, sound) => fireSignalAlert(`Block Break · ${this.state.symbol}`, text, sound)
    this.blockBreak.setSymbol(this.state.symbol)
    this.setBlockBreakEnabled(this.state.blockBreak ?? false)

    // Deep Profile: DeepCharts-style volume / delta profiles per period, from
    // the exact tape where recorded (live prints fed below), candle estimates
    // elsewhere. See deepProfile.ts.
    this.deepProfile = new DeepProfileOverlay(this.canvasHost, this.engine, () => this.candles, (from, to) => this.fetchRecordedTape(from, to), this.state.deepProfileOptions)
    this.deepProfile.setSymbol(this.state.symbol, sessionOpenNyHour(this.state.symbol), sessionOpenHourUTC(this.state.symbol))
    this.deepProfile.setEnabled(this.state.deepProfile ?? false)

    // Deep Stats: DeepCharts-style per-bar order-flow values table, from the recorded tape
    // (loaded for the bars on screen) + live trades. See deepStats.ts.
    this.deepStats = new DeepStatsOverlay(this.canvasHost, this.engine, () => this.candles, (from, to) => this.fetchRecordedTape(from, to), this.state.deepStatsOptions)
    this.deepStats.paneRect = () => this.separatePaneRect('deepStats')
    this.deepStats.setSymbol(this.state.symbol)
    this.deepStats.setEnabled(this.state.deepStats ?? false)

    // Deep Trades: DeepCharts-style large-trade + resting-liquidity marker
    // approximation (no true MBO feed available) — see deepTrades.ts.
    this.deepTrades = new DeepTradesOverlay(this.canvasHost, this.engine, this.provider, this.state.deepTradesOptions)
    this.deepTrades.start()
    this.deepTrades.setSymbol(this.state.symbol)
    this.setDeepTradesEnabled(this.state.deepTrades ?? false)

    // Volume Profile & TPO: a fixed-period profile study, separate from the
    // lightweight visible-range one already drawn by drawVolumeProfile()
    // below — see volumeProfile.ts.
    this.volumeProfileTool = new VolumeProfileOverlay(this.canvasHost, this.engine, this.state.volumeProfileOptions)
    this.volumeProfileTool.setSessionOpenHour(sessionOpenHourUTC(this.state.symbol))
    this.volumeProfileTool.start()
    // Volume footprint: active while the chart type is 'footprint'.
    this.footprint = new FootprintOverlay(
      this.canvasHost,
      this.engine,
      () => this.candles,
      // Delta serves 5s candles for BTCUSD / ETHUSD only: don't ask (a 400 in the console) for the rest
      (iv, limit, end) => (iv === '5s' && !FIVE_SECOND_SYMBOLS.has(this.state.symbol)
        ? Promise.reject(new Error('5s candles: BTCUSD / ETHUSD only'))
        : this.provider.fetchCandles(this.state.symbol, iv as Interval, limit, end)),
      this.state.footprintOptions,
      // exact history from the local tape recorder, where it was running
      (from, to) => this.fetchRecordedTape(from, to),
    )
    // footprint trade signals: alerts, and a position drawing per new signal when asked
    this.footprint.onSignal = (e, o) => {
      if (o.sigAlerts) {
        if (e.kind === 'signal') askNotificationPermissionOnce()
        fireSignalAlert(`Footprint ${e.kind === 'signal' ? 'signal' : 'exit'} · ${this.state.symbol} ${this.state.interval}`, e.text, o.sigSound)
      }
      if (e.kind === 'signal' && o.sigAutoDraw) {
        const t = e.trade
        this.engine.addDrawing({
          id: `fpsig-${t.setup}-${t.signalTime}`,
          tool: t.side > 0 ? 'longpos' : 'shortpos',
          points: [
            { time: t.entryTime, price: t.entry },
            { time: t.entryTime, price: t.stop },
            { time: t.entryTime, price: t.target },
          ],
          color: t.side > 0 ? '#26a69a' : '#ef5350',
          width: 1,
          props: { riskR: Math.abs(t.target - t.entry) / Math.abs(t.entry - t.stop), rightBars: 12 },
        })
      }
    }
    // GEX Sabers levels for the footprint signals' confluence (recomputed at most every 5s)
    let gexAt = 0
    let gexLevels: { price: number; label: string; strength: number }[] = []
    this.footprint.onBreakLabel = (_side, text, o) => {
      askNotificationPermissionOnce()
      fireSignalAlert(`Footprint ${this.state.symbol} ${this.state.interval}`, text, o.sigSound)
    }
    this.footprint.storeKey = () => `${this.state.symbol}|${this.state.interval}`
    this.footprint.getGexLevels = () => {
      if (Date.now() - gexAt > 5000) {
        gexAt = Date.now()
        const m = computeGexSabersModel(this.candles, {}, { symbol: this.state.symbol, chartType: this.state.chartType })
        gexLevels = m.sabers.map((sb) => ({ price: sb.price, label: sb.names.join(' · '), strength: sb.strength }))
      }
      return gexLevels
    }
    this.footprint.setEnabled(this.state.chartType === 'footprint')
    this.setVolumeProfileToolEnabled(this.state.volumeProfileOptions?.enabled ?? false)

    // GEX (Gamma Exposure): Call Wall / Put Wall / Net GEX Crossover derived from
    // Delta India's public BTC/ETH/Gold options chain — see gex.ts. No-ops on any
    // other symbol.
    this.gex = new GexOverlay(this.canvasHost, this.engine, this.state.gexOptions)
    this.gex.start()
    this.gex.setSymbol(this.state.symbol)

    // GEX V2: live gamma-environment dashboard (Positive/Negative/Mixed/Full)
    // built on the same computeGex() data — see gexV2.ts. A separate power
    // tool from GexOverlay above (which plots levels on the chart itself),
    // but when BOTH are enabled it reuses GEX's fetch (via onResult) instead
    // of polling Delta's options chain independently — otherwise two
    // uncoordinated pollers can show different Call Wall/Put Wall numbers
    // just because they fetched a few seconds apart. Must be constructed
    // before setGexEnabled()/setGexV2Enabled() below, which both touch it.
    this.gexV2 = new GexV2Overlay(this.canvasHost, this.state.gexV2Options)
    this.gexV2.setSymbol(this.state.symbol)

    this.setGexEnabled(this.state.gexOptions?.enabled ?? false)
    this.setGexV2Enabled(this.state.gexV2Options?.enabled ?? false)
    this.gex.onResult((r) => {
      if (this.state.gexV2Options?.enabled) this.gexV2.applyResult(r)
    })

    // IV Walls: the session's projected HOD/LOD zones from option-implied σ
    // (BTC/ETH/Gold chains) plus realized-range history — see ivWalls.ts. Any
    // other symbol still gets the HV-only version.
    this.ivWalls = new IVWallsOverlay(
      this.canvasHost,
      this.engine,
      {
        fetchHourly: (limit) => this.provider.fetchCandles(this.state.symbol, '1h', limit),
        fetchChain: async () => (isGexUnderlying(this.state.symbol) ? fetchOptionChain(this.state.symbol) : null),
      },
      this.state.ivWallsOptions,
    )
    this.ivWalls.setSymbol(this.state.symbol)
    this.setIVWallsEnabled(this.state.ivWallsOptions?.enabled ?? false)

    // IV expected-move zones (±0.5/1/1.5× EM around the prior close, or typed
    // walls) — port of "IV walls modified V2.pine". See ivZones.ts.
    this.ivZones = new IvZonesOverlay(
      this.canvasHost,
      this.engine,
      {
        fetchHourly: (limit) => this.provider.fetchCandles(this.state.symbol, '1h', limit),
        fetchChain: async () => (isGexUnderlying(this.state.symbol) ? fetchOptionChain(this.state.symbol) : null),
      },
      this.state.ivZonesOptions,
    )
    this.ivZones.setSymbol(this.state.symbol)
    this.ivZones.setCandles(this.candles)
    this.setIvZonesEnabled(this.state.ivZonesOptions?.enabled ?? false)

    // CPR & Pivots: Day/Week/Month central pivot range, R1–R4/S1–S4 and the
    // previous period's high/low, from 1h history — see cpr.ts.
    this.cpr = new CprOverlay(
      this.canvasHost,
      this.engine,
      { fetchHourly: (limit, endTime) => this.provider.fetchCandles(this.state.symbol, '1h', limit, endTime) },
      this.state.cprOptions,
    )
    this.cpr.setSymbol(this.state.symbol)
    this.setCprEnabled(this.state.cprOptions?.enabled ?? false)

    // Setup Checklist: the Ninja GEX System's 4-part checklist (trend + GEX
    // level + flag pattern + volume) in one glance — reads GexV2Overlay's and
    // FlagPatternsOverlay's already-computed state, no data of its own beyond
    // the candles it's already given. See setupChecklist.ts.
    this.setupChecklist = new SetupChecklistOverlay(this.canvasHost, this.state.setupChecklistOptions)
    this.setupChecklist.setSources(this.gexV2, this.flagPatterns)
    this.setupChecklist.setCandles(this.candles)
    this.setSetupChecklistEnabled(this.state.setupChecklistOptions?.enabled ?? false)

    // Ultra V2: VWAP+bands, Initial Balance, Session Volume Profile, TJR BOS
    // 2.0 and Supertrend bundled together — a port of UltraV2.pine. See ultraV2.ts.
    this.ultraV2 = new UltraV2Overlay(this.canvasHost, this.engine, this.state.ultraV2Options)
    this.ultraV2.setSessionOpenHour(sessionOpenHourUTC(this.state.symbol))
    this.ultraV2.start()
    this.setUltraV2Enabled(this.state.ultraV2 ?? false)

    // FVG + Supertrend strategy with a backtest card — a port of "FVG strategy.pine". See fvgStrategy.ts.
    this.fvgStrategy = new FvgStrategyOverlay(this.canvasHost, this.engine, this.state.fvgStrategyOptions)
    this.fvgStrategy.start()
    this.setFvgStrategyEnabled(this.state.fvgStrategy ?? false)

    // CPR two-mode playbook (narrow-CPR breakout / CPR reclaim) with BUY/SELL labels. See cprStrategy.ts.
    this.cprStrategy = new CprStrategyOverlay(
      this.canvasHost,
      this.engine,
      { fetchHourly: (limit, endTime) => this.provider.fetchCandles(this.state.symbol, '1h', limit, endTime) },
      this.state.cprStrategyOptions,
    )
    this.cprStrategy.setSymbol(this.state.symbol)
    this.setCprStrategyEnabled(this.state.cprStrategy ?? false)

    // Fractal Vector + VWAP bands + EMA 9/21/50 with aligned-flip / EMA21-pullback signals — port of "test strategy.pine". See fvVwapEma.ts.
    this.fvVwapEma = new FvVwapEmaOverlay(this.canvasHost, this.engine, this.state.fvVwapEmaOptions)
    this.fvVwapEma.setSymbol(this.state.symbol)
    this.setFvVwapEmaEnabled(this.state.fvVwapEma ?? false)

    // HalfTrend line, ATR channel and Buy / Sell flips — port of "halftrend.pine". See halfTrend.ts.
    this.halfTrend = new HalfTrendOverlay(this.canvasHost, this.engine, this.state.halfTrendOptions)
    this.setHalfTrendEnabled(this.state.halfTrend ?? false)

    // IV × FV Strategy: FV signals with TP2 capped at the next IV zone (+ optional
    // ±1× zone fade), drawn as trades only. See ivFvStrategy.ts.
    this.ivFvStrategy = new IvFvStrategyOverlay(
      this.canvasHost,
      this.engine,
      {
        fetchHourly: (limit) => this.provider.fetchCandles(this.state.symbol, '1h', limit),
        fetchChain: async () => (isGexUnderlying(this.state.symbol) ? fetchOptionChain(this.state.symbol) : null),
      },
      this.state.ivFvStrategyOptions,
    )
    this.ivFvStrategy.setSymbol(this.state.symbol)
    this.setIvFvStrategyEnabled(this.state.ivFvStrategy ?? false)

    // IV Zone Retest Strategy: retest of a broken expected-move zone, graded A / B
    // by DeepCharts big trades. See zoneRetest.ts.
    this.zoneRetest = new ZoneRetestOverlay(
      this.canvasHost,
      this.engine,
      { fetchHourly: (limit) => this.provider.fetchCandles(this.state.symbol, '1h', limit) },
      this.state.zoneRetestOptions,
    )
    this.zoneRetest.setSymbol(this.state.symbol)
    this.setZoneRetestEnabled(this.state.zoneRetest ?? false)

    // IV Walls × Big Trades fade strategy — a port of "ivfade-strategy.pine". See ivFade.ts.
    this.ivFade = new IvFadeOverlay(
      this.canvasHost,
      this.engine,
      {
        fetchDaily: (limit) => this.provider.fetchCandles(this.state.symbol, '1d', limit),
        fetchMinute: (limit) => this.provider.fetchCandles(this.state.symbol, '1m', limit),
      },
      this.state.ivFadeOptions,
    )
    this.ivFade.setSymbol(this.state.symbol)
    this.ivFade.start()
    this.setIvFadeEnabled(this.state.ivFade ?? false)

    // DeepCharts Big Trades: big-trade candles classified by where the trade sat — a port of "bigtrades-Deepcharts.pine". See dcBigTrades.ts.
    this.dcBigTrades = new DcBigTradesOverlay(
      this.canvasHost,
      this.engine,
      { fetchMinute: (limit) => this.provider.fetchCandles(this.state.symbol, '1m', limit) },
      this.state.dcBigTradesOptions,
    )
    this.dcBigTrades.setSymbol(this.state.symbol)
    this.setDcBigTradesEnabled(this.state.dcBigTrades ?? false)

    // Trade Buddy: levels of the idea selected in the Buddy panel (see buddy.ts).
    this.buddyLevels = new BuddyLevelsOverlay(this.canvasHost, this.engine)

    this.subscribeTradeFeed()

    this.ro = new ResizeObserver(() => {
      this.engine.resize()
      this.resizeOverlay()
      this.rain.resize()
      this.poll.resize()
      this.dominanceV2.resize()
      this.gexV2.resize()
      this.setupChecklist.resize()
      this.ultraV2.resize()
      this.fvgStrategy.resize()
      this.cprStrategy.resize()
      this.fvVwapEma.resize()
      this.halfTrend.resize()
      this.ivZones.resize()
      this.ivFvStrategy.resize()
      this.zoneRetest.resize()
      this.ivFade.resize()
      this.dcBigTrades.resize()
    })
    this.ro.observe(this.canvasHost)
    this.resizeOverlay()
    this.rain.resize()
    requestAnimationFrame(() => {
      this.engine.resize()
      this.resizeOverlay()
      this.rain.resize()
    })

    // The overlay re-syncs every frame ONLY while there's something to draw
    // (signals or the volume profile). A plain chart runs no extra loop.
    this.ensureOverlayLoop()

    this.updateHead()
    this.subscribeTicker()
  }

  /** OHLC row starts right after the title row (which itself may be inset past a floating toolbar). */
  syncLegendInset(): void {
    this.engine.setLegendInset(this.headEl.offsetLeft + this.headEl.offsetWidth + 4)
  }

  public refresh(): void {
    this.syncLegendInset()
    this.engine.resize()
    this.resizeOverlay()
    this.rain.resize()
    this.poll.resize()
    this.dominanceV2.resize()
    this.gexV2.resize()
    this.setupChecklist.resize()
    this.ultraV2.resize()
    this.fvgStrategy.resize()
    this.cprStrategy.resize()
    this.fvVwapEma.resize()
    this.halfTrend.resize()
    this.ivZones.resize()
    this.ivFvStrategy.resize()
    this.zoneRetest.resize()
    this.ivFade.resize()
    this.dcBigTrades.resize()
    // orderflow handles resize via ResizeObserver automatically
  }

  /** Page-space rect of the chart canvas — used to position the right-click menu (onContextMenu gives container-relative x/y). */
  getCanvasRect(): DOMRect {
    return this.canvasHost.getBoundingClientRect()
  }

  /** Run the overlay rAF loop only when signals or the volume profile are active. */
  private ensureOverlayLoop(): void {
    const need = this.signals.length > 0 || this.canvasInds.length > 0 || this.volumeProfile
    if (need && !this.overlayActive) {
      this.overlayActive = true
      const loop = (): void => {
        if (this.destroyed || !this.overlayActive) return
        this.drawOverlay()
        this.raf = requestAnimationFrame(loop)
      }
      this.raf = requestAnimationFrame(loop)
    } else if (!need && this.overlayActive) {
      this.overlayActive = false
      cancelAnimationFrame(this.raf)
      this.octx.clearRect(0, 0, this.overlay.clientWidth, this.overlay.clientHeight)
      this.lastOverlaySig = ''
    }
  }

  private resizeOverlay(): void {
    const dpr = window.devicePixelRatio || 1
    const w = this.canvasHost.clientWidth
    const h = this.canvasHost.clientHeight
    // Same size: leave the bitmap alone (re-assigning width clears it → flicker).
    if (this.overlay.width === Math.round(w * dpr) && this.overlay.height === Math.round(h * dpr)) return
    this.overlay.width = Math.round(w * dpr)
    this.overlay.height = Math.round(h * dpr)
    this.overlay.style.width = `${w}px`
    this.overlay.style.height = `${h}px`
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.lastOverlaySig = '' // force a redraw at the new size
  }

  // ---- Power tools: toggled from the header dropdown (main.ts), dispatched
  // to whichever pane is active(). Each setter only flips the relevant
  // overlay's own on/off + persists to PaneState — none of them touch the
  // chart engine (setData/indicators/zoom), so selecting a tool never
  // affects the chart itself, only which overlay canvases are visible.

  setTradeRainEnabled(on: boolean): void {
    this.state.tradeRain = on
    this.rain.setEnabled(on)
  }

  setBuySellPollEnabled(on: boolean): void {
    this.state.buySellPoll = on
    this.poll.setEnabled(on)
  }

  setDominanceV2Enabled(on: boolean): void {
    this.state.dominanceV2 = on
    this.dominanceV2.setEnabled(on)
  }

  setOrderFlowEnabled(on: boolean): void {
    this.state.orderFlow = on
    if (on) {
      this.orderflow.reset() // backfill from what's already loaded instead of starting blank
      for (const c of this.candles) this.orderflow.onCandle(c)
    } else {
      this.orderflow.reset()
    }
  }

  setICTEnabled(on: boolean): void {
    this.state.ict = on
    if (on) this.ict.setCandles(this.candles)
    else this.ict.reset()
  }

  setUltraV2Enabled(on: boolean): void {
    this.state.ultraV2 = on
    this.ultraV2.setEnabled(on)
    if (on) this.ultraV2.setCandles(this.candles)
    else this.ultraV2.reset()
  }

  getUltraV2Options(): UltraV2Options {
    return this.ultraV2.getOptions()
  }

  applyUltraV2Option(patch: Partial<UltraV2Options>): void {
    this.state.ultraV2Options = { ...this.state.ultraV2Options, ...patch }
    this.ultraV2.setOptions(patch)
  }

  /** Show one Trade Buddy idea's entry/stop/targets on this pane, or null to clear. */
  setBuddyLevels(levels: BuddyLevels | null): void {
    this.buddyLevels.set(levels)
  }

  setFvgStrategyEnabled(on: boolean): void {
    this.state.fvgStrategy = on
    this.fvgStrategy.setEnabled(on)
    if (on) this.fvgStrategy.setCandles(this.candles)
    else this.fvgStrategy.reset()
  }

  setCprStrategyEnabled(on: boolean): void {
    this.state.cprStrategy = on
    this.cprStrategy.setCandles(this.candles)
    this.cprStrategy.setEnabled(on)
    if (!on) this.cprStrategy.reset()
  }

  setFvVwapEmaEnabled(on: boolean): void {
    this.state.fvVwapEma = on
    this.fvVwapEma.setEnabled(on)
    if (on) this.fvVwapEma.setCandles(this.candles)
    else this.fvVwapEma.reset()
  }

  setHalfTrendEnabled(on: boolean): void {
    this.state.halfTrend = on
    this.halfTrend.setEnabled(on)
    if (on) this.halfTrend.setCandles(this.candles)
    else this.halfTrend.reset()
  }

  setIvFvStrategyEnabled(on: boolean): void {
    this.state.ivFvStrategy = on
    this.ivFvStrategy.setCandles(this.candles)
    this.ivFvStrategy.setEnabled(on)
    if (!on) this.ivFvStrategy.reset()
  }

  setZoneRetestEnabled(on: boolean): void {
    this.state.zoneRetest = on
    this.zoneRetest.setCandles(this.candles)
    this.zoneRetest.setEnabled(on)
    if (!on) this.zoneRetest.reset()
  }

  getZoneRetestOptions(): ZoneRetestOverlayOptions {
    return this.zoneRetest.getOptions()
  }

  applyZoneRetestOption(patch: Partial<ZoneRetestOverlayOptions>): void {
    this.state.zoneRetestOptions = { ...this.state.zoneRetestOptions, ...patch }
    this.zoneRetest.setOptions(patch)
  }

  getIvFvStrategyOptions(): IvFvStrategyOverlayOptions {
    return this.ivFvStrategy.getOptions()
  }

  applyIvFvStrategyOption(patch: Partial<IvFvStrategyOverlayOptions>): void {
    this.state.ivFvStrategyOptions = { ...this.state.ivFvStrategyOptions, ...patch }
    this.ivFvStrategy.setOptions(patch)
  }

  getFvVwapEmaOptions(): FvVwapEmaOverlayOptions {
    return this.fvVwapEma.getOptions()
  }

  applyFvVwapEmaOption(patch: Partial<FvVwapEmaOverlayOptions>): void {
    this.state.fvVwapEmaOptions = { ...this.state.fvVwapEmaOptions, ...patch }
    this.fvVwapEma.setOptions(patch)
  }

  getHalfTrendOptions(): HalfTrendOverlayOptions {
    return this.halfTrend.getOptions()
  }

  applyHalfTrendOption(patch: Partial<HalfTrendOverlayOptions>): void {
    this.state.halfTrendOptions = { ...this.state.halfTrendOptions, ...patch }
    this.halfTrend.setOptions(patch)
  }

  getCprStrategyOptions(): CprStrategyOverlayOptions {
    return this.cprStrategy.getOptions()
  }

  applyCprStrategyOption(patch: Partial<CprStrategyOverlayOptions>): void {
    this.state.cprStrategyOptions = { ...this.state.cprStrategyOptions, ...patch }
    this.cprStrategy.setOptions(patch)
  }

  getFvgStrategyOptions(): FvgStrategyOptions {
    return this.fvgStrategy.getOptions()
  }

  applyFvgStrategyOption(patch: Partial<FvgStrategyOptions>): void {
    this.state.fvgStrategyOptions = { ...this.state.fvgStrategyOptions, ...patch }
    this.fvgStrategy.setOptions(patch)
  }

  /**
   * Strategies the Strategy Tester can report on. Registering a new strategy
   * overlay (anything implementing StrategyOverlay) is one entry here.
   */
  private strategyRegistry(): { id: string; name: string; on: boolean; overlay: StrategyOverlay }[] {
    return [
      { id: 'fvgStrategy', name: 'FVG + Supertrend Strategy', on: !!this.state.fvgStrategy, overlay: this.fvgStrategy },
      { id: 'cprStrategy', name: 'CPR Strategy', on: !!this.state.cprStrategy, overlay: this.cprStrategy },
      { id: 'fvVwapEma', name: 'FV + VWAP + EMA', on: !!this.state.fvVwapEma, overlay: this.fvVwapEma },
      { id: 'ivFvStrategy', name: 'IV × FV Strategy', on: !!this.state.ivFvStrategy, overlay: this.ivFvStrategy },
      { id: 'zoneRetest', name: 'IV Zone Retest Strategy', on: !!this.state.zoneRetest, overlay: this.zoneRetest },
      { id: 'ivFade', name: 'IV Walls × Big Trades Fade', on: !!this.state.ivFade, overlay: this.ivFade },
    ]
  }

  /** Manual trades from replay paper trading, listed in the Strategy Tester while set. */
  paperSource: StrategySource | null = null

  /** The strategies currently switched on in this pane (plus paper trades, when there are any). */
  getStrategySources(): StrategySource[] {
    const out: StrategySource[] = this.strategyRegistry()
      .filter((s) => s.on)
      .map((s) => ({
        id: s.id,
        name: s.name,
        getStrategyTrades: () => s.overlay.getStrategyTrades(),
        getRevision: () => s.overlay.getRevision(),
      }))
    // Strategy-style canvas indicators (e.g. the 05:30 range breakout): trades from the
    // latest model, which already follows ticks and bar replay; revision = model version.
    for (const ci of this.canvasInds) {
      const strat = ci.src.strategy
      if (!strat) continue
      const defId = ci.defId
      out.push({
        id: `indicator:${defId}`,
        name: strat.name,
        getStrategyTrades: () => {
          const cur = this.canvasInds.find((c) => c.defId === defId)
          return cur ? strat.trades(cur.model) : []
        },
        getRevision: () => this.canvasVersion,
      })
    }
    if (this.paperSource) out.push(this.paperSource)
    return out
  }

  /** Page older candles in (same path as panning left); resolves when done or when there is no more. */
  requestOlderHistory(): Promise<void> {
    return this.loadMoreHistory()
  }

  /** False once the feed has returned no older candles, or while replay pins the data. */
  canLoadOlderHistory(): boolean {
    return !this.noMoreHistory && !this.replayFull
  }

  /** Mount a host-owned element over the chart canvas (e.g. the Strategy Tester's range band). */
  attachChartOverlay(node: HTMLElement): void {
    this.canvasHost.appendChild(node)
  }

  setDcBigTradesEnabled(on: boolean): void {
    this.state.dcBigTrades = on
    this.dcBigTrades.setEnabled(on)
    if (on) this.dcBigTrades.setCandles(this.candles)
    else this.dcBigTrades.reset()
  }

  getDcBigTradesOptions(): DcBigTradesOptions {
    return this.dcBigTrades.getOptions()
  }

  applyDcBigTradesOption(patch: Partial<DcBigTradesOptions>): void {
    this.state.dcBigTradesOptions = { ...this.state.dcBigTradesOptions, ...patch }
    this.dcBigTrades.setOptions(patch)
  }

  setIvFadeEnabled(on: boolean): void {
    this.state.ivFade = on
    this.ivFade.setEnabled(on)
    if (on) this.ivFade.setCandles(this.candles)
    else this.ivFade.reset()
  }

  getIvFadeOptions(): IvFadeOptions {
    return this.ivFade.getOptions()
  }

  applyIvFadeOption(patch: Partial<IvFadeOptions>): void {
    this.state.ivFadeOptions = { ...this.state.ivFadeOptions, ...patch }
    this.ivFade.setOptions(patch)
  }

  setFlagPatternsEnabled(on: boolean): void {
    this.applyFlagPatternsOption({ enabled: on })
    this.flagPatterns.setEnabled(on)
    if (on) this.flagPatterns.setCandles(this.candles)
    else this.flagPatterns.reset()
  }

  getFlagPatternsOptions(): FlagPatternsOptions {
    return this.flagPatterns.getOptions()
  }

  applyFlagPatternsOption(patch: Partial<FlagPatternsOptions>): void {
    this.flagPatterns.setOptions(patch)
    this.state.flagPatternsOptions = { ...(this.state.flagPatternsOptions ?? {}), ...patch }
  }

  setSetupChecklistEnabled(on: boolean): void {
    this.applySetupChecklistOption({ enabled: on })
    this.setupChecklist.setEnabled(on)
  }

  getSetupChecklistOptions(): SetupChecklistOptions {
    return this.setupChecklist.getOptions()
  }

  applySetupChecklistOption(patch: Partial<SetupChecklistOptions>): void {
    this.setupChecklist.setOptions(patch)
    this.state.setupChecklistOptions = { ...(this.state.setupChecklistOptions ?? {}), ...patch }
  }

  setDepthImbalanceEnabled(on: boolean): void {
    this.state.depthImbalance = on
    this.depthImbalance.setEnabled(on)
  }

  setLiquidityLevelsEnabled(on: boolean): void {
    this.state.liquidityLevels = on
    this.liquidityLevels.setEnabled(on)
  }

  setConfluenceEnabled(on: boolean): void {
    this.state.confluence = on
    if (on) this.confluence.setCandles(this.candles)
    else this.confluence.reset()
  }

  setBigTradesEnabled(on: boolean): void {
    this.state.bigTrades = on
    if (on) {
      this.bigTrades.setCandles(this.candles)
      void this.loadTapeHistory('big')
    } else this.bigTrades.reset()
  }

  getBigTradesOptions(): BigTradesOptions {
    return this.bigTrades.getOptions()
  }

  applyBigTradesOption(patch: Partial<BigTradesOptions>): void {
    this.bigTrades.setOptions(patch)
    this.state.bigTradesOptions = { ...(this.state.bigTradesOptions ?? {}), ...patch }
    if (BIG_TRADES_HISTORY_KEYS.some((k) => k in patch)) void this.loadTapeHistory('big')
  }

  /** Raw prints the local tape recorder saved for this symbol in [from, to] (null = no recorder / nothing recorded). */
  private async fetchRecordedTape(from: number, to: number): Promise<RecordedTape | null> {
    const res = await fetch(`/tape/trades?symbol=${encodeURIComponent(this.state.symbol)}&from=${Math.floor(from)}&to=${Math.ceil(to)}`)
    return res.ok ? ((await res.json()) as RecordedTape) : null
  }

  setHeavyAbsorptionEnabled(on: boolean): void {
    this.state.heavyAbsorption = on
    if (on) askNotificationPermissionOnce()
    this.heavyAbsorption.setEnabled(on)
  }

  getHeavyAbsorptionOptions(): HeavyAbsorptionOverlayOptions {
    return this.heavyAbsorption.getOptions()
  }

  applyHeavyAbsorptionOption(patch: Partial<HeavyAbsorptionOverlayOptions>): void {
    this.heavyAbsorption.setOptions(patch)
    this.state.heavyAbsorptionOptions = { ...(this.state.heavyAbsorptionOptions ?? {}), ...patch }
  }

  setBlockBreakEnabled(on: boolean): void {
    this.state.blockBreak = on
    if (on) askNotificationPermissionOnce()
    this.blockBreak.setEnabled(on)
  }

  getBlockBreakOptions(): BlockBreakOverlayOptions {
    return this.blockBreak.getOptions()
  }

  applyBlockBreakOption(patch: Partial<BlockBreakOverlayOptions>): void {
    this.blockBreak.setOptions(patch)
    this.state.blockBreakOptions = { ...(this.state.blockBreakOptions ?? {}), ...patch }
  }

  setDeepStatsEnabled(on: boolean): void {
    this.state.deepStats = on
    this.deepStats.setEnabled(on)
    this.renderIndicators(false) // its separate pane comes and goes with it
  }

  /** Plot rectangle of a separate pane (by indicator id), or null when it has none. */
  private separatePaneRect(id: string): { x: number; y: number; width: number; height: number } | null {
    const k = this.separatePaneIds.indexOf(id)
    const main = this.engine.getMainPaneRect()
    const r = this.engine.getPaneRects()[k + 1]
    return k < 0 || !main || !r ? null : { x: main.x, y: r.top, width: main.width, height: r.height }
  }

  getDeepStatsOptions(): DeepStatsOptions {
    return this.deepStats.getOptions()
  }

  applyDeepStatsOption(patch: Partial<DeepStatsOptions>): void {
    this.deepStats.setOptions(patch)
    if (patch.position !== undefined) this.renderIndicators(false)
    const cur = this.state.deepStatsOptions ?? {}
    this.state.deepStatsOptions = { ...cur, ...patch, ...(patch.show ? { show: { ...(cur.show ?? {}), ...patch.show } } : {}), ...(patch.thresholds ? { thresholds: { ...(cur.thresholds ?? {}), ...patch.thresholds } } : {}) } as Partial<DeepStatsOptions>
  }

  setDeepProfileEnabled(on: boolean): void {
    this.state.deepProfile = on
    this.deepProfile.setEnabled(on)
  }

  getDeepProfileOptions(): DeepProfileOptions {
    return this.deepProfile.getOptions()
  }

  applyDeepProfileOption(patch: Partial<DeepProfileOptions>): void {
    this.deepProfile.setOptions(patch)
    this.state.deepProfileOptions = { ...(this.state.deepProfileOptions ?? {}), ...patch }
  }

  /** Deep Profile under a chart time (right-click menu), or null. */
  deepProfileHit(time: number): DpHit | null {
    return this.state.deepProfile ? this.deepProfile.hitTest(time) : null
  }

  deepProfileAction(time: number, action: DpProfileAction | 'reset' | 'removeCustom' | 'clearCustom'): void {
    if (action === 'reset') return this.applyDeepProfileOption({ joined: [] })
    if (action === 'clearCustom') return this.applyDeepProfileOption({ customRanges: [] })
    if (action === 'removeCustom') {
      const ranges = this.deepProfile.getOptions().customRanges.filter((r) => !(time >= r[0] && time < r[1]))
      return this.applyDeepProfileOption({ customRanges: ranges })
    }
    const patch = this.deepProfile.profileAction(time, action)
    if (patch) this.applyDeepProfileOption(patch)
  }

  /** Drag out a Custom Deep Profile range on this chart (turns the tool on). */
  drawDeepProfileCustom(): void {
    if (!this.state.deepProfile) this.setDeepProfileEnabled(true)
    this.deepProfile.startCustomDraw((patch) => this.applyDeepProfileOption(patch))
  }

  setDeepTradesEnabled(on: boolean): void {
    this.state.deepTrades = on
    this.deepTrades.setEnabled(on)
    if (on) void this.loadTapeHistory('deep')
    else this.deepTrades.reset()
  }

  getDeepTradesOptions(): DeepTradesOptions {
    return this.deepTrades.getOptions()
  }

  applyDeepTradesOption(patch: Partial<DeepTradesOptions>): void {
    this.deepTrades.setOptions(patch)
    this.state.deepTradesOptions = { ...(this.state.deepTradesOptions ?? {}), ...patch }
    if (DEEP_TRADES_HISTORY_KEYS.some((k) => k in patch)) void this.loadTapeHistory('deep')
  }

  /**
   * Recorded big-trade history from the tape recorder (see tapeHistory.ts).
   * Resolves to "no history" when no recorder is reachable — the tools then
   * show live trades only, as before.
   */
  private async loadTapeHistory(which: 'big' | 'deep' | 'both' = 'both'): Promise<void> {
    const symbol = this.state.symbol
    const now = Date.now()
    const jobs: Promise<void>[] = []
    if (which !== 'deep' && this.state.bigTrades) {
      const gen = ++this.tapeGen.big
      const o = this.bigTrades.getOptions()
      const filter = o.autoFilter ? { perDay: INTENSITY_PER_DAY[o.intensity] } : { min: o.minVolume }
      jobs.push(
        fetchTapeHistory(symbol, { from: now - o.daysToLoad * 86_400_000, to: now, mode: o.calculationMode, ...filter }).then((h) => {
          if (gen === this.tapeGen.big && symbol === this.state.symbol && this.state.bigTrades) this.bigTrades.setHistory(h)
        }),
      )
    }
    if (which !== 'big' && this.state.deepTrades) {
      const gen = ++this.tapeGen.deep
      const o = this.deepTrades.getOptions()
      const filter = o.autoFilter ? { perDay: INTENSITY_PER_DAY[o.intensity] } : { min: o.minVolume }
      jobs.push(
        fetchTapeHistory(symbol, { from: now - DEEP_TRADES_HISTORY_DAYS * 86_400_000, to: now, mode: 'cumulative', ...filter }).then((h) => {
          if (gen === this.tapeGen.deep && symbol === this.state.symbol && this.state.deepTrades) this.deepTrades.setHistory(h)
        }),
      )
    }
    await Promise.all(jobs)
  }

  setVolumeProfileToolEnabled(on: boolean): void {
    this.applyVolumeProfileOption({ enabled: on })
    if (on) this.volumeProfileTool.setCandles(this.candles)
    else this.volumeProfileTool.reset()
  }

  getFootprintOptions(): FootprintOptions {
    return this.footprint.getOptions()
  }
  applyFootprintOption(patch: Partial<FootprintOptions>): void {
    this.footprint.setOptions(patch)
    this.state.footprintOptions = { ...(this.state.footprintOptions ?? {}), ...patch }
  }
  getVolumeProfileOptions(): VolumeProfileOptions {
    return this.volumeProfileTool.getOptions()
  }

  applyVolumeProfileOption(patch: Partial<VolumeProfileOptions>): void {
    this.volumeProfileTool.setOptions(patch)
    this.state.volumeProfileOptions = { ...(this.state.volumeProfileOptions ?? {}), ...patch }
  }

  setGexEnabled(on: boolean): void {
    this.applyGexOption({ enabled: on })
    this.gex.setEnabled(on)
    this.gexV2.setDrivenExternally(on)
    if (on && this.state.gexV2Options?.enabled) this.gexV2.applyResult(this.gex.getResult())
  }

  getGexOptions(): GexOptions {
    return this.gex.getOptions()
  }

  applyGexOption(patch: Partial<GexOptions>): void {
    this.gex.setOptions(patch)
    this.state.gexOptions = { ...(this.state.gexOptions ?? {}), ...patch }
  }

  setGexV2Enabled(on: boolean): void {
    this.applyGexV2Option({ enabled: on })
    this.gexV2.setEnabled(on)
    if (on && this.state.gexOptions?.enabled) this.gexV2.applyResult(this.gex.getResult())
  }

  getGexV2Options(): GexV2Options {
    return this.gexV2.getOptions()
  }

  applyGexV2Option(patch: Partial<GexV2Options>): void {
    this.gexV2.setOptions(patch)
    this.state.gexV2Options = { ...(this.state.gexV2Options ?? {}), ...patch }
  }

  setIVWallsEnabled(on: boolean): void {
    this.applyIVWallsOption({ enabled: on })
    this.ivWalls.setEnabled(on)
  }

  setIvZonesEnabled(on: boolean): void {
    this.applyIvZonesOption({ enabled: on })
    this.ivZones.setCandles(this.candles)
    this.ivZones.setEnabled(on)
  }

  getIvZonesOptions(): IvZonesOptions {
    return this.ivZones.getOptions()
  }

  applyIvZonesOption(patch: Partial<IvZonesOptions>): void {
    this.ivZones.setOptions(patch)
    this.state.ivZonesOptions = { ...(this.state.ivZonesOptions ?? {}), ...patch }
  }

  getIVWallsOptions(): IVWallsOptions {
    return this.ivWalls.getOptions()
  }

  applyIVWallsOption(patch: Partial<IVWallsOptions>): void {
    this.ivWalls.setOptions(patch)
    this.state.ivWallsOptions = { ...(this.state.ivWallsOptions ?? {}), ...patch }
  }

  setCprEnabled(on: boolean): void {
    this.applyCprOption({ enabled: on })
    this.cpr.setEnabled(on)
    if (on && this.candles.length) this.cpr.setAnchor(this.candles[this.candles.length - 1].time)
  }

  getCprOptions(): CprOptions {
    return this.cpr.getOptions()
  }

  applyCprOption(patch: Partial<CprOptions>): void {
    this.cpr.setOptions(patch)
    this.state.cprOptions = { ...(this.state.cprOptions ?? {}), ...patch }
  }

  /** Show level names as chips beside the price-scale tags (TradingView's "indicator name labels"). */
  setPriceTagLabels(on: boolean): void {
    this.engine.setPriceTagLabels(on)
  }

  /** Key live values a power tool shows in its legend row (empty when it has none). */
  getToolValues(id: string): ToolLegendValue[] {
    const fmt = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 0 : v >= 1 ? 2 : 4 })
    if (this.replayFull && LIVE_ONLY_TOOLS.has(id)) return [{ text: '⏸ live only — paused in replay', color: '#8b8f9a' }]
    if (id === 'blockBreak') {
      const r = this.blockBreak.getResult()
      if (!r) return [{ text: 'loading…', color: '#8b8f9a' }]
      const o = this.blockBreak.getOptions()
      const out: ToolLegendValue[] = r.signals
        .filter((s) => s.outcome === 'open')
        .map((s) => ({
          text: `${s.dir > 0 ? 'BUY' : 'SELL'} ${fmt(s.entry)} · SL ${fmt(s.stop)} · T2 ${fmt(s.t2)} · ${s.r >= 0 ? '+' : ''}${s.r.toFixed(2)}R`,
          color: s.dir > 0 ? o.buyColor : o.sellColor,
        }))
      if (r.watching.length) out.push({ text: `watching ${r.watching.length} touched block${r.watching.length > 1 ? 's' : ''}`, color: '#ffd54f' })
      if (!out.length) out.push({ text: `${r.fresh.length} fresh blocks · ${r.signals.length} signals`, color: '#8b8f9a' })
      return out
    }
    if (id === 'ivWalls') {
      const s = this.ivWalls.getSummary()
      if (!s) return []
      const o = this.ivWalls.getOptions()
      const src = s.implied ? 'IV' : 'HV'
      const out: ToolLegendValue[] = [
        { text: `${src} +1σ ${fmt(s.up1)}`, color: o.lineColor },
        { text: `${src} −1σ ${fmt(s.down1)}`, color: o.lineColor },
      ]
      if (s.ivHv !== null) out.push({ text: `IV/HV ${s.ivHv.toFixed(2)}×`, color: '#64b5f6' })
      return out
    }
    if (id === 'ivZones') {
      const s = this.ivZones.getSummary()
      if (!s) return [{ text: this.ivZones.getStatus() === 'history unavailable' ? 'history unavailable' : 'loading…', color: '#8b8f9a' }]
      const z = s.session
      if (z.em === null) return z.zones.length ? [{ text: `${z.zones.length} manual walls`, color: '#9aa0a6' }] : []
      const src = z.ivSource === 'implied' ? 'Option IV' : z.ivSource === 'override' ? 'IV (typed)' : 'HV'
      return [
        { text: `${src} ${((z.iv ?? 0) * 100).toFixed(1)}%`, color: '#64b5f6' },
        { text: `EM ±${fmt(z.em)}`, color: '#d1d4dc' },
      ]
    }
    if (id === 'zoneRetest') {
      const t = this.zoneRetest.getOpenTrade()
      if (!t) return [{ text: this.zoneRetest.getStatus() === 'live' ? 'flat' : this.zoneRetest.getStatus(), color: '#8b8f9a' }]
      const sl = t.tp1Time !== null ? t.entryPrice : t.stop
      return [{ text: `${t.label} ${fmt(t.entryPrice)} · SL ${fmt(sl)} · TP ${fmt(t.tp1)} / ${fmt(t.target)}`, color: t.side === 'long' ? '#26a69a' : '#ef5350' }]
    }
    if (id === 'ivFvStrategy') {
      const t = this.ivFvStrategy.getOpenTrade()
      if (!t) return [{ text: this.ivFvStrategy.getStatus() === 'live' ? 'flat' : this.ivFvStrategy.getStatus(), color: '#8b8f9a' }]
      const sl = t.tp1Time !== null ? t.entryPrice : t.stop
      const tps = [t.tp1, t.target].filter((v): v is number => v !== null).map(fmt).join(' / ')
      return [{ text: `${t.side === 'long' ? 'LONG' : 'SHORT'} ${fmt(t.entryPrice)} · SL ${fmt(sl)} · TP ${tps}`, color: t.side === 'long' ? '#26a69a' : '#ef5350' }]
    }
    if (id === 'cprStrategy') {
      const { day, last } = this.cprStrategy.getToday()
      const out: ToolLegendValue[] = []
      if (day) out.push(day.mode === 'breakout' ? { text: 'Narrow CPR → breakout', color: '#ffb74d' } : { text: 'Reclaim day', color: '#9aa0a6' })
      else out.push({ text: this.cprStrategy.getStatus() === 'live' ? 'no levels' : this.cprStrategy.getStatus(), color: '#8b8f9a' })
      if (last && last.exitTime === null) out.push({ text: `${last.side === 'long' ? 'LONG' : 'SHORT'} ${fmt(last.entryPrice)} · SL ${fmt(last.stop)} · TP ${fmt(last.target)}`, color: last.side === 'long' ? '#26a69a' : '#ef5350' })
      return out
    }
    if (id === 'cpr') {
      const s = this.cpr.getSummary()
      if (!s) return [{ text: this.cpr.getStatus() === 'history unavailable' ? 'history unavailable' : 'loading…', color: '#8b8f9a' }]
      const o = this.cpr.getOptions()
      const [ph, pl] = PREV_HL_LABEL[o.timeframe]
      const width = `CPR ${(s.width * 100).toFixed(s.width < 0.001 ? 3 : 2)}%${s.widthClass && s.widthClass !== 'normal' ? ` ${s.widthClass}` : ''}`
      return [
        { text: `P ${fmt(s.pivot)}`, color: o.cprColor },
        { text: width, color: s.widthClass === 'narrow' ? '#ffb74d' : o.cprColor },
        { text: `${ph} ${fmt(s.prevHigh)}`, color: o.prevHLColor },
        { text: `${pl} ${fmt(s.prevLow)}`, color: o.prevHLColor },
      ]
    }
    if (id === 'dcBigTrades') {
      const m = this.dcBigTrades.getLast()
      if (!m) return []
      const o = this.dcBigTrades.getOptions()
      return [{ text: `${DC_PATTERN_LABEL[m.pattern]} ${m.bull ? '▲' : '▼'} ${fmt(m.price)}`, color: m.color === 'teal' ? o.tealColor : o.magentaColor }]
    }
    if (id === 'ivFade') {
      const d = this.ivFade.getToday()
      if (!d) return []
      return [
        { text: `HOD ${fmt(d.hodBot)}–${fmt(d.hodTop)}`, color: '#f6465d' },
        { text: `LOD ${fmt(d.lodBot)}–${fmt(d.lodTop)}`, color: '#0ecb81' },
      ]
    }
    if (id === 'gex') {
      const rs = this.gex.getReplayState()
      if (rs === 'none') return [{ text: '⏸ no GEX recorded for this time', color: '#8b8f9a' }]
      const r = this.gex.getDisplayedResult()
      if (!r) return []
      const o = this.gex.getOptions()
      const out: ToolLegendValue[] = []
      if (r.callWall !== null) out.push({ text: `Call wall ${fmt(r.callWall)}`, color: o.callWallColor })
      if (r.putWall !== null) out.push({ text: `Put wall ${fmt(r.putWall)}`, color: o.putWallColor })
      if (rs) out.push({ text: `recorded ${new Date(rs.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}`, color: '#8b8f9a' })
      return out
    }
    if (id === 'volumeProfileTool') {
      const s = this.volumeProfileTool.getSummary()
      if (!s) return []
      const o = this.volumeProfileTool.getOptions()
      const out: ToolLegendValue[] = [
        { text: `VAH ${fmt(s.vah)}`, color: o.vahColor },
        { text: `POC ${fmt(s.poc)}`, color: o.vpocColor },
        { text: `VAL ${fmt(s.val)}`, color: o.valColor },
      ]
      if (s.totalDelta !== null) {
        const d = s.totalDelta
        out.push({ text: `Σ Δ ${d >= 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US', { maximumFractionDigits: 1 })}`, color: d >= 0 ? o.buyColor : o.sellColor })
      }
      return out
    }
    return []
  }

  /** Rows for active power tools (host-supplied, refreshed about once a second). */
  setToolLegend(rows: ToolLegendRow[]): void {
    this.toolRows = rows
    this.renderLegend()
  }

  /** Hide / show one indicator from its legend row. */
  setIndicatorVisible(defId: string, visible: boolean): void {
    const inst = this.getIndicator(defId)
    if (!inst) return
    inst.visible = visible
    this.renderIndicators(true)
    this.onIndicatorsChanged?.()
  }

  /** Move an indicator one place up/down in the list (legend order = list order). */
  moveIndicator(defId: string, dir: -1 | 1): void {
    const list = this.state.indicators
    const i = list.findIndex((x) => x.defId === defId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    this.renderIndicators(false)
    this.onIndicatorsChanged?.()
  }

  /** Legend values at the crosshair bar (or the last bar). */
  private legendValues(outputs: IndicatorOutput[]): ToolLegendValue[] {
    const n = this.candles.length
    if (n === 0) return []
    // Renko/Kagi/Line-break hover indices count synthetic bars, not candles — read the last bar there.
    const hover = isRebinnedChartType(this.state.chartType) ? null : this.legendIdx
    const i = Math.min(n - 1, hover ?? n - 1)
    return outputs.map((o) => {
      const v = i < o.values.length ? o.values[i] : null
      const text = v == null || !isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      return { text, color: o.color }
    })
  }

  private indicatorRow(e: (typeof this.legendIndicators)[number]): ToolLegendRow {
    const defId = e.inst.defId
    const hidden = e.inst.visible === false
    return {
      id: `ind:${defId}`,
      label: e.label,
      color: e.outputs.find((o) => o.color)?.color,
      values: hidden ? [] : this.legendValues(e.outputs),
      hidden,
      onToggle: () => this.setIndicatorVisible(defId, hidden),
      onSettings: () => this.onIndicatorSettings?.(defId),
      onRemove: () => {
        this.removeIndicator(defId)
        this.onIndicatorsChanged?.()
      },
      onMoveUp: () => this.moveIndicator(defId, -1),
      onMoveDown: () => this.moveIndicator(defId, 1),
    }
  }

  /**
   * TradingView-style legend. Main pane: overlay indicators then power tools, the
   * first LEGEND_VISIBLE_ROWS shown and the rest folded behind "⌄ N more". Each
   * pane indicator gets its row in its own pane. Hover a row for eye / settings /
   * remove / more; hidden rows stay, greyed, so they can be shown again.
   */
  private renderLegend(): void {
    this.toolLegendEl.style.top = `${Math.max(24, this.engine.getLegendBottom() + 4)}px`
    const mainRows = [
      ...this.compareRows(),
      ...this.legendIndicators.filter((e) => e.placement === 'overlay').map((e) => this.indicatorRow(e)),
      ...this.toolRows,
    ]
    const expanded = !!this.state.legendExpanded
    const sig = JSON.stringify([expanded, mainRows.map((r) => [r.id, r.label, r.color, r.hidden, r.values.length, r.select?.value])])
    // Don't rebuild under an open legend dropdown — that would close it mid-pick.
    const picking = document.activeElement instanceof HTMLSelectElement && this.toolLegendEl.contains(document.activeElement)
    if (sig === this.toolLegendSig) {
      // only the numbers moved: update them in place, so a row under the mouse keeps its buttons
      const els = this.toolLegendEl.querySelectorAll<HTMLElement>(':scope > .tool-legend-row')
      els.forEach((el, k) => mainRows[k] && patchLegendValues(el, mainRows[k]))
    } else if (!picking) {
      this.toolLegendSig = sig
      const extra = mainRows.length - LEGEND_VISIBLE_ROWS
      const shown = expanded || extra <= 0 ? mainRows : mainRows.slice(0, LEGEND_VISIBLE_ROWS)
      const rowEls = shown.map((r) => this.buildLegendRow(r))
      this.toolLegendEl.replaceChildren(...rowEls)
      if (extra > 0) {
        // A small chip at the end of the first row, so the folded legend is one line.
        const more = document.createElement('button')
        more.type = 'button'
        more.className = 'legend-more'
        more.textContent = expanded ? '⌃' : `+${extra}`
        more.title = expanded ? 'Collapse legend' : `Show ${extra} more`
        more.setAttribute('aria-label', more.title)
        more.setAttribute('aria-expanded', String(expanded))
        more.addEventListener('click', (ev) => {
          ev.stopPropagation()
          this.state.legendExpanded = !expanded
          this.renderLegend()
        })
        rowEls[0]?.appendChild(more)
      }
      // Floating widgets docked top-left start just below the legend.
      requestAnimationFrame(() => {
        const bottom = this.toolLegendEl.offsetTop + this.toolLegendEl.offsetHeight + 8
        this.canvasHost.style.setProperty('--tl-reserve', `${Math.max(54, bottom)}px`)
      })
    }

    // Pane indicators: one row at the top of each sub-pane.
    const paneEntries = this.legendIndicators.filter((e) => e.placement !== 'overlay')
    const rects = this.engine.getPaneRects()
    while (this.paneLegendEls.length < paneEntries.length) {
      const el = document.createElement('div')
      el.className = 'tool-legend pane-legend'
      this.canvasHost.appendChild(el)
      this.paneLegendEls.push(el)
    }
    while (this.paneLegendEls.length > paneEntries.length) this.paneLegendEls.pop()!.remove()
    const paneRows = paneEntries.map((e) => this.indicatorRow(e))
    const paneSig = JSON.stringify([rects.map((r) => r.top), paneRows.map((r) => [r.id, r.label, r.hidden, r.values.length])])
    if (paneSig === this.paneLegendSig) {
      // only the numbers moved (crosshair, live bar): update in place — rebuilding the row
      // under the mouse swallowed clicks on its buttons
      paneRows.forEach((r, k) => {
        const row = this.paneLegendEls[k]?.querySelector<HTMLElement>('.tool-legend-row')
        if (row) patchLegendValues(row, r)
      })
      return
    }
    this.paneLegendSig = paneSig
    paneRows.forEach((r, k) => {
      const el = this.paneLegendEls[k]
      const rect = rects[k + 1]
      el.style.display = rect ? 'flex' : 'none'
      if (rect) el.style.top = `${rect.top + 2}px`
      el.replaceChildren(this.buildLegendRow(r))
    })
  }

  private buildLegendRow(r: ToolLegendRow): HTMLElement {
    const row = document.createElement('div')
    row.className = `tool-legend-row${r.hidden ? ' hidden' : ''}`
    if (r.color) {
      const sw = document.createElement('span')
      sw.className = 'tl-swatch'
      sw.style.background = r.color
      row.appendChild(sw)
    }
    const name = document.createElement('span')
    name.className = 'tl-name'
    name.textContent = r.label
    row.appendChild(name)
    if (r.select && !r.hidden) {
      const sel = r.select
      const pick = document.createElement('select')
      pick.className = 'tl-select'
      pick.title = sel.title
      pick.setAttribute('aria-label', sel.title)
      for (const [value, text] of sel.options) pick.add(new Option(text, value, false, value === sel.value))
      pick.addEventListener('mousedown', (e) => e.stopPropagation())
      pick.addEventListener('change', () => {
        sel.onChange(pick.value)
        pick.blur()
      })
      row.appendChild(pick)
    }
    const actions = document.createElement('span')
    actions.className = 'tl-actions'
    const btn = (label: string, svg: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'tl-btn'
      b.title = label
      b.setAttribute('aria-label', label)
      b.innerHTML = svg
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        onClick(b)
      })
      actions.appendChild(b)
      return b
    }
    btn(r.hidden ? `Show ${r.label}` : `Hide ${r.label}`, r.hidden ? LEGEND_ICONS.eyeOff : LEGEND_ICONS.eye, () => r.onToggle())
    if (r.onSettings) btn(`${r.label} settings`, LEGEND_ICONS.gear, () => r.onSettings!())
    btn(`Remove ${r.label}`, LEGEND_ICONS.close, () => r.onRemove())
    if (r.onMoveUp || r.onMoveDown) {
      btn(`More for ${r.label}`, LEGEND_ICONS.more, (b) => {
        const open = row.querySelector('.tl-menu')
        if (open) return open.remove()
        const menu = document.createElement('div')
        menu.className = 'tl-menu'
        for (const [text, fn] of [['Move up', r.onMoveUp], ['Move down', r.onMoveDown]] as const) {
          if (!fn) continue
          const item = document.createElement('button')
          item.type = 'button'
          item.textContent = text
          item.addEventListener('click', (e) => {
            e.stopPropagation()
            fn()
          })
          menu.appendChild(item)
        }
        menu.style.left = `${b.offsetLeft}px`
        row.appendChild(menu)
      })
    }
    // buttons sit right after the name, so a value changing width never moves them
    row.appendChild(actions)
    for (const v of r.values) {
      const val = document.createElement('span')
      val.className = 'tl-val'
      val.textContent = v.text
      val.style.color = v.color
      row.appendChild(val)
    }
    return row
  }

  private subscribeTradeFeed(): void {
    this.unsubscribeTradeFeed()
    try {
      this.tradeUnsub = this.provider.subscribeTrades(this.state.symbol, (trade: ExchangeTradeEvent) => {
        if (this.replayFull) return // live trades don't belong on replayed bars
        this.rain.addTrade({ timestamp: trade.time, price: trade.price, volume: trade.qty, side: trade.side })
        this.poll.addTrade({ volume: trade.qty, side: trade.side })
        if (this.state.bigTrades) this.bigTrades.addTrade({ time: trade.time, timeUs: trade.timeUs, price: trade.price, volume: trade.qty, side: trade.side })
        this.footprint.addTrade(trade)
        if (this.state.deepTrades) this.deepTrades.addTrade({ time: trade.time, timeUs: trade.timeUs, price: trade.price, volume: trade.qty, side: trade.side })
        if (this.state.heavyAbsorption) this.heavyAbsorption.addTrade({ time: trade.time, timeUs: trade.timeUs, price: trade.price, volume: trade.qty, side: trade.side })
        if (this.state.blockBreak) this.blockBreak.addTrade(trade)
        if (this.state.deepProfile) this.deepProfile.addTrade(trade)
        if (this.state.deepStats) this.deepStats.addTrade(trade)
        if (this.state.orderFlow) {
          this.orderflow.onTrade({
            time: trade.time,
            price: trade.price,
            qty: trade.qty,
            side: trade.side,
          })
        }
      })
    } catch {
      this.tradeUnsub = null
    }
  }

  private unsubscribeTradeFeed(): void {
    if (this.tradeUnsub) {
      this.tradeUnsub()
      this.tradeUnsub = null
    }
  }

  /** Show the "+" add-alert button at the cursor's price on the right edge. */
  private positionAddAlert(e: MouseEvent): void {
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect) {
      this.addAlertBtn.style.display = 'none'
      return
    }
    const host = this.canvasHost.getBoundingClientRect()
    const x = e.clientX - host.left
    const y = e.clientY - host.top
    if (y < rect.y || y > rect.y + rect.height || x < rect.x || x > rect.x + rect.width) {
      this.addAlertBtn.style.display = 'none'
      return
    }
    this.alertHoverPrice = conv.yToPrice(y)
    this.addAlertBtn.style.display = ''
    this.addAlertBtn.style.left = `${rect.x + rect.width - 24}px`
    this.addAlertBtn.style.top = `${y - 9}px`
  }

  /** Redraw signal labels in sync with the chart (clipped to the price pane). */
  private drawOverlay(): void {
    const conv = this.engine.getMainConverters()
    const rect = this.engine.getMainPaneRect()
    if (!conv || !rect) return
    // Skip work unless the viewport, size, signal set, or VP toggle changed.
    const refT = this.candles.length ? this.candles[0].time : 0
    const sig = `${rect.x},${rect.y},${rect.width},${rect.height},${conv.timeToX(refT).toFixed(1)},${conv.priceToY(1).toFixed(1)},${this.signalsVersion},${this.volumeProfile ? 1 : 0},${this.canvasVersion},${this.state.chartType}`
    if (sig === this.lastOverlaySig) return
    this.lastOverlaySig = sig

    const ctx = this.octx
    ctx.clearRect(0, 0, this.overlay.clientWidth, this.overlay.clientHeight)

    ctx.save()
    ctx.beginPath()
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
    ctx.clip()
    if (this.volumeProfile) this.drawVolumeProfile(ctx, conv, rect)
    const cctx = {
      symbol: this.state.symbol,
      chartType: this.state.chartType,
      interval: this.state.interval,
      renkoBox: this.engine.getRenkoBoxSize(),
      ensureRightGutter: (px: number) => this.engine.ensureRightGutter(px),
      barX: (index: number) => this.engine.barCenterX(index),
    }
    for (const ci of this.canvasInds) {
      // A canvas indicator declared as a pane (e.g. GEX Summary) paints into its own sub-pane below the chart.
      const pane = resolveIndicator(ci.defId)?.placement === 'pane' ? this.separatePaneRect(ci.defId) : rect
      if (pane) ci.src.draw(ctx, conv, pane, this.candles, ci.model, cctx)
    }
    for (const s of this.signals) {
      const x = conv.timeToX(s.time)
      if (x < rect.x - 30 || x > rect.x + rect.width + 30) continue
      drawSignal(ctx, x, conv.priceToY(s.price), s)
    }
    ctx.restore()
  }

  /** Visible-range Volume Profile: horizontal volume-by-price histogram on the right. */
  private drawVolumeProfile(
    ctx: CanvasRenderingContext2D,
    conv: { timeToX(t: number): number; priceToY(p: number): number },
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    // Binary-search the visible index range instead of scanning every loaded
    // candle's screen position — candles is time-sorted, so this is O(log n)
    // + O(visible) instead of O(total loaded history) on every pan/zoom frame.
    const i0 = lowerBoundByX(this.candles, rect.x - 2, conv)
    const i1 = upperBoundByX(this.candles, rect.x + rect.width + 2, conv)
    let lo = Infinity
    let hi = -Infinity
    const vis: Candle[] = []
    for (let i = i0; i < i1; i++) {
      const c = this.candles[i]
      vis.push(c)
      if (c.low < lo) lo = c.low
      if (c.high > hi) hi = c.high
    }
    if (vis.length < 2 || !isFinite(lo) || hi <= lo) return

    const BINS = 28
    const range = hi - lo
    const binVol = new Array<number>(BINS).fill(0)
    for (const c of vis) {
      const b0 = Math.max(0, Math.min(BINS - 1, Math.floor(((c.low - lo) / range) * (BINS - 1))))
      const b1 = Math.max(0, Math.min(BINS - 1, Math.floor(((c.high - lo) / range) * (BINS - 1))))
      const per = c.volume / (b1 - b0 + 1)
      for (let b = b0; b <= b1; b++) binVol[b] += per
    }
    let maxVol = 0
    let pocBin = 0
    for (let b = 0; b < BINS; b++) {
      if (binVol[b] > maxVol) {
        maxVol = binVol[b]
        pocBin = b
      }
    }
    if (maxVol <= 0) return

    const maxW = rect.width * 0.26
    for (let b = 0; b < BINS; b++) {
      const yBot = conv.priceToY(lo + (b / BINS) * range)
      const yTop = conv.priceToY(lo + ((b + 1) / BINS) * range)
      const bw = (binVol[b] / maxVol) * maxW
      ctx.fillStyle = b === pocBin ? 'rgba(41, 98, 255, 0.5)' : 'rgba(120, 123, 134, 0.32)'
      ctx.fillRect(rect.x + rect.width - bw, yTop, bw, Math.max(1, yBot - yTop - 1))
    }
    // POC line across the pane.
    const pocY = conv.priceToY(lo + ((pocBin + 0.5) / BINS) * range)
    ctx.strokeStyle = 'rgba(41, 98, 255, 0.7)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(rect.x, pocY)
    ctx.lineTo(rect.x + rect.width, pocY)
    ctx.stroke()
  }

  setVolumeProfile(on: boolean): void {
    this.volumeProfile = on
    this.lastOverlaySig = '' // force a redraw
    this.ensureOverlayLoop()
  }

  // ---- presentation ----
  /** Chart-settings switches for the title row / watermark / decimals (host-applied). */
  showWatermark = true
  showVenue = true
  private precisionOverride: number | null = null
  private symbolPrecision = 2

  setDisplayOptions(o: { watermark: boolean; venue: boolean; precision: number | null }): void {
    this.showWatermark = o.watermark
    this.showVenue = o.venue
    this.precisionOverride = o.precision
    this.engine.setPricePrecision(o.precision ?? this.symbolPrecision)
    this.updateHead()
  }

  private updateHead(): void {
    const { symbol, interval } = this.state
    this.logoEl.innerHTML = symbolLogo(symbol)
    const venue = this.showVenue ? `<span class="pane-venue">· ${PANE_VENUE} ·</span>` : ''
    this.symEl.innerHTML = `<b>${symbol}</b>${venue}<span class="pane-int">${interval}</span>`
    this.engine.setWatermark(this.showWatermark ? `${symbol} · ${interval}` : null)
  }
  private setStatus(s: PaneStatus, detail: string): void {
    this.status = s
    this.statusDetail = detail
    this.dotEl.className = `pane-dot ${s}`
    this.onStatusChange?.()
  }

  /** Live last-price + 24h %change in the pane head, one shared ticker stream per symbol. */
  private subscribeTicker(): void {
    this.unsubscribeTicker()
    this.priceEl.textContent = ''
    this.priceEl.className = 'pane-price'
    this.changeEl.textContent = ''
    this.changeEl.className = 'pane-change'
    try {
      this.tickerUnsub = this.provider.subscribeTickers([this.state.symbol], (u) => {
        const digits = u.price >= 100 ? 2 : u.price >= 1 ? 4 : 6
        this.priceEl.textContent = u.price.toLocaleString('en-US', {
          minimumFractionDigits: 0,
          maximumFractionDigits: digits,
        })
        this.priceEl.className = `pane-price ${u.changePct > 0 ? 'up' : u.changePct < 0 ? 'down' : ''}`
        this.changeEl.textContent = `${u.changePct >= 0 ? '+' : ''}${u.changePct.toFixed(2)}%`
        this.changeEl.className = `pane-change ${u.changePct > 0 ? 'up' : u.changePct < 0 ? 'down' : ''}`
      })
    } catch {
      this.tickerUnsub = null
    }
  }
  private unsubscribeTicker(): void {
    if (this.tickerUnsub) {
      this.tickerUnsub()
      this.tickerUnsub = null
    }
  }

  // ---- mutations (called by the toolbar on the active pane) ----
  async setSymbol(symbol: string): Promise<void> {
    // Drawings are anchored to a symbol's own price/time, so they must swap
    // with it: stash the OLD symbol's current drawings before switching,
    // then restore whatever the NEW symbol had saved (or none, if never drawn on).
    this.state.drawingsBySymbol = { ...(this.state.drawingsBySymbol ?? {}), [this.state.symbol]: this.state.drawings }
    this.state.symbol = symbol.toUpperCase()
    const restored = this.state.drawingsBySymbol[this.state.symbol] ?? []
    this.state.drawings = restored
    this.engine.setDrawings(restored)
    this.poll.reset() // don't let the new symbol's reading start biased by the old one's leftover volume
    this.dominanceV2.setSymbol(this.state.symbol) // re-subscribes every selected timeframe to the new symbol
    this.depthImbalance.setSymbol(this.state.symbol)
    this.liquidityLevels.setSymbol(this.state.symbol)
    this.bigTrades.reset() // live markers are priced for the OLD symbol — drop them, setCandles() below reseeds the estimate
    this.deepTrades.setSymbol(this.state.symbol)
    this.deepTrades.reset()
    this.heavyAbsorption.setSymbol(this.state.symbol)
    this.blockBreak.setSymbol(this.state.symbol)
    this.deepProfile.setSymbol(this.state.symbol, sessionOpenNyHour(this.state.symbol), sessionOpenHourUTC(this.state.symbol))
    this.deepStats.setSymbol(this.state.symbol)
    this.volumeProfileTool.reset() // session/bars period must not mix candles from the old symbol
    // Session-anchored tools follow the new symbol's trading-day open (gold 03:30 IST) — see core/session.ts.
    this.volumeProfileTool.setSessionOpenHour(sessionOpenHourUTC(this.state.symbol))
    this.ultraV2.setSessionOpenHour(sessionOpenHourUTC(this.state.symbol))
    this.gex.setSymbol(this.state.symbol) // no-op unless this is now BTCUSD/ETHUSD/XAUTUSD — see gex.ts
    this.gexV2.setSymbol(this.state.symbol)
    this.ivWalls.setSymbol(this.state.symbol)
    this.ivZones.setSymbol(this.state.symbol)
    this.cpr.setSymbol(this.state.symbol)
    this.cprStrategy.setSymbol(this.state.symbol)
    this.cprStrategy.reset()
    this.fvVwapEma.setSymbol(this.state.symbol)
    this.ivFvStrategy.setSymbol(this.state.symbol)
    this.ivFvStrategy.reset()
    this.zoneRetest.setSymbol(this.state.symbol)
    this.zoneRetest.reset()
    this.ivFade.setSymbol(this.state.symbol)
    this.dcBigTrades.setSymbol(this.state.symbol)
    this.updateHead()
    this.subscribeTicker()
    await this.reload()
  }
  async setInterval(interval: Interval): Promise<void> {
    this.state.interval = interval
    this.updateHead()
    await this.reload()
  }
  private zoomForFootprint(): void {
    const w = this.engine.getMainPaneRect()?.width ?? 1000
    this.engine.zoomToBars(Math.max(6, Math.round(w / 90)))
  }
  setChartType(type: ChartType): void {
    const wasFootprint = this.state.chartType === 'footprint'
    this.state.chartType = type
    this.engine.setChartType(type)
    this.footprint.setEnabled(type === 'footprint')
    // Footprint cells need wide bars (~90px each), like TradingView's default.
    if (type === 'footprint' && !wasFootprint) this.zoomForFootprint()
  }
  setTheme(theme: Theme): void {
    this.engine.setTheme(theme)
  }
  setMagnet(on: boolean): void {
    this.engine.setMagnet(on)
  }
  setActiveTool(tool: DrawingToolId | null): void {
    this.engine.setActiveTool(tool)
  }
  clearDrawings(): void {
    this.engine.clearDrawings()
    this.state.drawings = []
  }

  // ---- indicators ----
  hasIndicator(defId: string): boolean {
    return this.state.indicators.some((i) => i.defId === defId)
  }
  getIndicator(defId: string): IndicatorInstance | undefined {
    return this.state.indicators.find((i) => i.defId === defId)
  }
  addIndicator(defId: string): void {
    if (this.hasIndicator(defId)) return
    this.state.indicators.push(defaultIndicatorInstance(defId))
    this.renderIndicators()
  }
  removeIndicator(defId: string): void {
    this.state.indicators = this.state.indicators.filter((i) => i.defId !== defId)
    this.renderIndicators()
  }
  /** Output names + default colors for one indicator (for the settings dialog). */
  indicatorOutputs(defId: string): IndicatorOutput[] {
    const def = resolveIndicator(defId)
    const inst = this.getIndicator(defId)
    if (!def || !inst) return []
    return def.compute(this.candles, inst.params)
  }
  renderIndicators(recomputeSignals = true): void {
    const data: IndicatorRenderData[] = []
    const legend: typeof this.legendIndicators = []
    for (const inst of this.state.indicators) {
      const def = resolveIndicator(inst.defId)
      if (!def) continue
      const label = labelFor(inst.defId, inst.params)
      if (inst.visible === false) {
        // Hidden: stays in the legend (greyed) so it can be shown again from the chart.
        // A pane indicator keeps an empty pane so the layout doesn't jump.
        legend.push({ inst, label, placement: def.placement, outputs: [] })
        if (def.placement !== 'overlay') data.push({ instanceId: inst.defId, label, placement: def.placement, outputs: [], range: def.range })
        continue
      }
      const hidden = new Set(inst.hidden ?? [])
      const outputs: IndicatorOutput[] = []
      for (const o of computeIndicatorOutputs(this.indicatorCache, this.candles, def, inst)) {
        const override = inst.colors[o.name]
        if (override) o.color = override
        if (!hidden.has(o.name)) outputs.push(o) // omit hidden lines from the engine
      }
      data.push({ instanceId: inst.defId, label, placement: def.placement, outputs, range: def.range })
      legend.push({ inst, label, placement: def.placement, outputs })
    }
    // tools drawn in their own pane below the chart (Deep Stats): an empty pane the tool paints
    if (this.state.deepStats && this.deepStats?.getOptions().position === 'pane') data.push({ instanceId: 'deepStats', label: 'Deep Stats', placement: 'pane', outputs: [] })
    this.separatePaneIds = data.filter((d) => d.placement === 'pane').map((d) => d.instanceId)
    this.engine.setIndicators(data)
    this.legendIndicators = legend
    this.renderLegend()

    // Canvas indicators follow every tick, like line plots.
    const cctx = { symbol: this.state.symbol, chartType: this.state.chartType, interval: this.state.interval, renkoBox: this.engine.getRenkoBoxSize() }
    const hadCanvas = this.canvasInds.length > 0
    this.canvasInds = []
    let renkoBox: number | null = null
    for (const inst of this.state.indicators) {
      if (inst.visible === false) continue
      const src = getCanvasSource(inst.defId)
      if (!src) continue
      const model = src.compute(this.candles, inst.params, cctx)
      this.canvasInds.push({ src, model, defId: inst.defId })
      // A Renko strategy (Renko Exhaustion Fade) fixes the chart's brick size to the one it trades.
      const want = (model as { renkoBox?: unknown } | null)?.renkoBox
      if (renkoBox === null && typeof want === 'number' && want > 0) renkoBox = want
    }
    this.engine.setRenkoBoxSize(renkoBox) // no-op unless it changed; rebuilds bricks only on a Renko chart
    this.canvasVersion++
    if (hadCanvas !== this.canvasInds.length > 0) this.ensureOverlayLoop()

    // BUY/SELL signals only change on bar close, so this (often heavy) pass is
    // skipped on interim ticks.
    if (recomputeSignals) {
      this.signals = []
      for (const inst of this.state.indicators) {
        if (inst.visible === false) continue
        const src = getSignalSource(inst.defId)
        if (src) this.signals.push(...src(this.candles, inst.params))
      }
      this.signalsVersion++
      this.ensureOverlayLoop() // start/stop the overlay rAF based on signal presence
    }
  }

  // ---- bar replay (data-level, TradingView-style) ----
  // While replaying, `candles` holds only bars [0..cursor] and `replayFull`
  // the whole series, so indicators, signals and every overlay are computed
  // from the replayed bars alone (no look-ahead), exactly like TV's replay.
  private replayFull: Candle[] | null = null
  private pickCleanup: (() => void) | null = null

  /** Bar count of the full series (ignores the replay clip). */
  get totalBars(): number {
    return (this.replayFull ?? this.candles).length
  }

  /** Enter replay, or move its cursor, showing bars [0..index]. */
  setReplayIndex(index: number): void {
    if (!this.replayFull) {
      this.replayFull = this.candles
      this.candles = []
      this.setLiveOnlyPaused(true)
    }
    const full = this.replayFull
    const n = Math.max(1, Math.min(full.length, index + 1))
    // Mutate in place so stepping forward stays incremental in the indicator cache.
    if (n < this.candles.length) this.candles.length = n
    else for (let i = this.candles.length; i < n; i++) this.candles.push(full[i])
    this.pushCandles()
    this.engine.setReplayCursor(Number.MAX_SAFE_INTEGER) // last bar; pins it into view
  }

  /** Leave replay and restore the full (live-updated) series. */
  endReplay(): void {
    this.cancelBarPick()
    if (!this.replayFull) return
    this.candles = this.replayFull
    this.replayFull = null
    this.engine.setReplayCursor(null)
    this.setLiveOnlyPaused(false)
    this.pushCandles()
  }

  /** True while bar replay is showing a clipped series. */
  get isReplaying(): boolean {
    return this.replayFull !== null
  }

  /**
   * Tools fed only by live streams (trade tape, order book, live option
   * chain) have no history to replay, so replay hides them; leaving restores
   * whatever the user had switched on. Saved on/off state is untouched.
   */
  private setLiveOnlyPaused(paused: boolean): void {
    this.rain.setEnabled(!paused && !!this.state.tradeRain)
    this.poll.setEnabled(!paused && !!this.state.buySellPoll)
    this.dominanceV2.setEnabled(!paused && !!this.state.dominanceV2)
    this.depthImbalance.setEnabled(!paused && !!this.state.depthImbalance)
    this.liquidityLevels.setEnabled(!paused && !!this.state.liquidityLevels)
    this.gexV2.setEnabled(!paused && !!this.state.gexV2Options?.enabled)
    if (!paused && this.state.gexV2Options?.enabled && this.state.gexOptions?.enabled) this.gexV2.applyResult(this.gex.getResult())
  }

  /** Feed the current `candles` to the engine, indicators and candle overlays. */
  private pushCandles(): void {
    const c = this.candles
    this.engine.setData(c)
    this.renderIndicators()
    if (this.state.orderFlow) {
      this.orderflow.reset()
      for (const k of c) this.orderflow.onCandle(k)
    }
    if (this.state.ict) this.ict.setCandles(c)
    if (this.state.ultraV2) this.ultraV2.setCandles(c)
    if (this.state.fvgStrategy) this.fvgStrategy.setCandles(c)
    if (this.state.cprStrategy) this.cprStrategy.setCandles(c)
    if (this.state.fvVwapEma) this.fvVwapEma.setCandles(c)
    if (this.state.halfTrend) this.halfTrend.setCandles(c)
    if (this.state.ivFvStrategy) this.ivFvStrategy.setCandles(c)
    if (this.state.zoneRetest) this.zoneRetest.setCandles(c)
    if (this.state.ivZonesOptions?.enabled) this.ivZones.setCandles(c)
    if (this.state.ivFade) this.ivFade.setCandles(c)
    if (this.state.dcBigTrades) this.dcBigTrades.setCandles(c)
    if (this.state.flagPatternsOptions?.enabled) this.flagPatterns.setCandles(c)
    if (this.state.setupChecklistOptions?.enabled) this.setupChecklist.setCandles(c)
    if (this.state.confluence) this.confluence.setCandles(c)
    if (this.state.bigTrades) this.bigTrades.setCandles(c)
    if (this.state.volumeProfileOptions?.enabled) this.volumeProfileTool.setCandles(c)
    if (c.length) {
      const last = c[c.length - 1]
      this.gex.setSpot(last.close)
      this.gexV2.setSpot(last.close)
      this.cpr.setAnchor(last.time) // replay cursor → that bar's period levels
      // Replay: the moment the cursor bar closes; GEX shows the snapshot recorded then, IV Walls compute as of then.
      const replayAt = this.replayFull ? last.time + INTERVAL_MS[this.state.interval] : null
      this.gex.setReplayTime(replayAt)
      this.ivWalls.setReplay(replayAt, c)
      // Recorded big trades: only those printed before the cursor bar closed.
      this.bigTrades.setCutoff(replayAt)
      this.deepTrades.setCutoff(replayAt)
      this.heavyAbsorption.setCutoff(replayAt)
      this.blockBreak.setCutoff(replayAt)
      this.deepProfile.setCutoff(replayAt)
      this.deepStats.setCutoff(replayAt)
    }
  }

  /**
   * TV "Select bar": a vertical line follows the mouse and the future side is
   * shaded; clicking picks the replay start bar. Dragging still pans the chart.
   * Esc cancels. `onPick` gets the bar index in the full series.
   */
  pickReplayBar(onPick: (index: number) => void, onCancel?: () => void): void {
    this.cancelBarPick()
    const host = this.canvasHost
    const shade = document.createElement('div')
    shade.className = 'replay-pick'
    shade.style.display = 'none'
    host.appendChild(shade)
    host.style.cursor = 'crosshair'
    let hovered = -1
    let downX = 0
    let downY = 0
    const barAt = (clientX: number): number => {
      const conv = this.engine.getMainConverters()
      const c = this.candles
      if (!conv || c.length === 0) return -1
      const t = conv.xToTime(clientX - host.getBoundingClientRect().left)
      let lo = 0
      let hi = c.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (c[mid].time < t) lo = mid + 1
        else hi = mid
      }
      if (lo > 0 && Math.abs(c[lo - 1].time - t) < Math.abs(c[lo].time - t)) lo--
      return lo
    }
    const move = (e: PointerEvent): void => {
      hovered = barAt(e.clientX)
      const conv = this.engine.getMainConverters()
      if (hovered < 0 || !conv) {
        shade.style.display = 'none'
        return
      }
      shade.style.display = 'block'
      shade.style.left = `${conv.timeToX(this.candles[hovered].time)}px`
    }
    const down = (e: PointerEvent): void => {
      downX = e.clientX
      downY = e.clientY
    }
    const click = (e: MouseEvent): void => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return // was a pan
      const i = barAt(e.clientX)
      if (i < 0) return
      e.stopPropagation()
      this.cancelBarPick()
      onPick(i)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      this.cancelBarPick()
      onCancel?.()
    }
    host.addEventListener('pointermove', move)
    host.addEventListener('pointerdown', down, true)
    host.addEventListener('click', click, true)
    window.addEventListener('keydown', key)
    this.pickCleanup = () => {
      host.removeEventListener('pointermove', move)
      host.removeEventListener('pointerdown', down, true)
      host.removeEventListener('click', click, true)
      window.removeEventListener('keydown', key)
      shade.remove()
      host.style.cursor = ''
    }
  }

  cancelBarPick(): void {
    this.pickCleanup?.()
    this.pickCleanup = null
  }

  // ---- data ----
  private onLive(c: Candle): void {
    if (this.replayFull) {
      // Replaying: keep the hidden live series current, leave the chart alone.
      const f = this.replayFull
      if (f.length && f[f.length - 1].time === c.time) f[f.length - 1] = c
      else f.push(c)
      return
    }
    this.lastUpdateAt = Date.now()
    if (this.state.cprOptions?.enabled) this.cpr.onCandle(c, INTERVAL_MS[this.state.interval])
    const n = this.candles.length
    const newBar = !(n > 0 && this.candles[n - 1].time === c.time)
    // A live bar more than one interval past the last one means bars were missed
    // (socket dropped / laptop slept). Keep streaming and repair the hole from REST.
    if (newBar && n > 0 && c.time - this.candles[n - 1].time > INTERVAL_MS[this.state.interval] * 1.5) this.backfillGap(this.candles[n - 1].time)
    if (newBar) this.candles.push(c)
    else this.candles[n - 1] = c
    this.engine.updateLast(c)
    // Drives price-alert evaluation (kept immediate). The range since the last update:
    // a new bar contributes its whole high / low, the same bar only what it extended.
    const prevTick = this.alertTick && this.alertTick.symbol === this.state.symbol ? this.alertTick : null
    let hi = c.close
    let lo = c.close
    if (prevTick && prevTick.time === c.time) {
      if (c.high > prevTick.high) hi = Math.max(hi, c.high)
      if (c.low < prevTick.low) lo = Math.min(lo, c.low)
    } else if (prevTick) {
      hi = Math.max(hi, c.high)
      lo = Math.min(lo, c.low)
    }
    this.alertTick = { symbol: this.state.symbol, time: c.time, high: c.high, low: c.low, at: Date.now() }
    this.onTick?.(this.state.symbol, c.close, hi, lo, prevTick ? prevTick.at : undefined)

    // Coalesce indicator recompute to one per animation frame, and only redo the
    // (expensive) signal pass when a new bar forms — interim ticks don't change
    // closed-bar signals. This keeps fast streams from janking the candle repaint.
    // Within a bar, indicators re-run at most every TICK_RECOMPUTE_MS (a new bar at once):
    // the candle itself repaints on every tick, and full-history studies need not.
    if (this.state.indicators.length === 0) return
    if (newBar) this.needSignalRecompute = true
    if (this.recomputeScheduled) return
    this.recomputeScheduled = true
    const wait = this.needSignalRecompute ? 0 : Math.max(0, TICK_RECOMPUTE_MS - (performance.now() - this.tickRecomputedAt))
    const run = (): void => {
      requestAnimationFrame(() => {
        if (this.destroyed) return
        this.recomputeScheduled = false
        const sig = this.needSignalRecompute
        this.needSignalRecompute = false
        this.tickRecomputedAt = performance.now()
        this.renderIndicators(sig)
      })
    }
    if (wait > 0) setTimeout(run, wait)
    else run()
  }
  private tickRecomputedAt = 0

  private backfilling = false
  private backfillAt = 0

  /** Refetch everything after `since` and splice it in. At most one per minute,
   *  so a thinly traded contract whose feed legitimately skips empty bars can't
   *  turn this into a REST loop. */
  private backfillGap(since: number): void {
    const now = Date.now()
    if (this.backfilling || now - this.backfillAt < 60_000) return
    this.backfilling = true
    this.backfillAt = now
    const gen = this.loadGen
    const iv = this.state.interval
    const limit = Math.min(1000, Math.ceil((now - since) / INTERVAL_MS[iv]) + 5)
    this.provider
      .fetchCandles(this.state.symbol, iv, limit)
      .then((fresh) => {
        if (gen !== this.loadGen || this.destroyed || this.replayFull || fresh.length === 0) return
        const merged = this.candles.filter((x) => x.time < fresh[0].time).concat(fresh)
        // Keep any live bar that is newer than what REST returned.
        for (const x of this.candles) if (x.time > merged[merged.length - 1].time) merged.push(x)
        this.candles = merged
        this.engine.setData(merged)
        this.renderIndicators()
      })
      .catch(() => {
        /* next gap (after the throttle) retries */
      })
      .finally(() => {
        this.backfilling = false
      })
  }

  private runSynthetic(): void {
    this.candles = sampleCandles()
    this.engine.setData(this.candles)
    this.lastUpdateAt = Date.now()
    this.renderIndicators()
    this.onData?.()
    let last = this.candles[this.candles.length - 1]
    this.synthTimer = window.setInterval(() => {
      const close = Math.max(1, last.close + (Math.random() - 0.5) * 2)
      last = {
        time: last.time + 60_000,
        open: last.close,
        high: Math.max(last.close, close) + Math.random(),
        low: Math.min(last.close, close) - Math.random(),
        close,
        volume: Math.round(100 + Math.random() * 900),
      }
      this.onLive(last)
    }, 1000)
  }

  /** Fired by the engine (onRequestHistory) when the user pans near the oldest
   *  loaded candle — pages in older history and prepends it, per the engine's
   *  documented setData contract (viewport stays visually stable). */
  private async loadMoreHistory(): Promise<void> {
    if (this.replayFull || this.historyLoading || this.noMoreHistory || this.candles.length === 0) return
    this.historyLoading = true
    const gen = this.loadGen
    try {
      const oldest = this.candles[0].time
      const older = await this.provider.fetchCandles(this.state.symbol, this.state.interval, 500, oldest)
      if (gen !== this.loadGen) return // symbol/interval changed while this was in flight
      if (older.length === 0) {
        this.noMoreHistory = true
        return
      }
      this.candles = [...older, ...this.candles]
      this.engine.setData(this.candles)
      this.renderIndicators()
      if (this.state.ict) this.ict.setCandles(this.candles)
      if (this.state.ultraV2) this.ultraV2.setCandles(this.candles)
      if (this.state.fvgStrategy) this.fvgStrategy.setCandles(this.candles)
      if (this.state.cprStrategy) this.cprStrategy.setCandles(this.candles)
      if (this.state.fvVwapEma) this.fvVwapEma.setCandles(this.candles)
      if (this.state.halfTrend) this.halfTrend.setCandles(this.candles)
      if (this.state.ivFvStrategy) this.ivFvStrategy.setCandles(this.candles)
      if (this.state.zoneRetest) this.zoneRetest.setCandles(this.candles)
      if (this.state.ivZonesOptions?.enabled) this.ivZones.setCandles(this.candles)
      if (this.state.ivFade) this.ivFade.setCandles(this.candles)
      if (this.state.dcBigTrades) this.dcBigTrades.setCandles(this.candles)
      if (this.state.flagPatternsOptions?.enabled) this.flagPatterns.setCandles(this.candles)
      if (this.state.setupChecklistOptions?.enabled) this.setupChecklist.setCandles(this.candles)
      if (this.state.confluence) this.confluence.setCandles(this.candles)
      if (this.state.bigTrades) this.bigTrades.setCandles(this.candles)
      if (this.state.volumeProfileOptions?.enabled) this.volumeProfileTool.setCandles(this.candles)
    } catch {
      /* transient fetch error — panning further will just retry */
    } finally {
      this.historyLoading = false
    }
  }

  async reload(): Promise<void> {
    const gen = ++this.loadGen
    if (this.replayFull) this.setLiveOnlyPaused(false)
    this.replayFull = null // a new symbol/interval ends any replay
    this.gex.setReplayTime(null)
    this.bigTrades.setCutoff(null)
    this.deepTrades.setCutoff(null)
    this.heavyAbsorption.setCutoff(null)
    this.blockBreak.setCutoff(null)
    this.deepProfile.setCutoff(null)
    this.deepStats.setCutoff(null)
    this.ivWalls.setReplay(null)
    this.cancelBarPick()
    this.engine.setReplayCursor(null)
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
    this.unsubscribeTradeFeed()
    if (this.synthTimer !== null) {
      clearInterval(this.synthTimer)
      this.synthTimer = null
    }
    this.setStatus('loading', 'loading…')
    try {
      const info = await this.provider.getSymbolInfo(this.state.symbol)
      if (gen !== this.loadGen) return
      this.symbolPrecision = info.pricePrecision
      this.deepProfile.setSymbolTick(Math.pow(10, -info.pricePrecision))
      this.deepStats.setSymbolTick(Math.pow(10, -info.pricePrecision))
      this.engine.setPricePrecision(this.precisionOverride ?? info.pricePrecision)

      const hist = await this.provider.fetchCandles(this.state.symbol, this.state.interval, 1000)
      if (gen !== this.loadGen) return
      if (hist.length === 0) throw new Error('no candles returned')

      this.candles = hist
      this.footprint.reset() // new symbol/interval: rebuild from its own sub-candles
      this.noMoreHistory = false
      this.engine.setData(hist)
      this.compare?.set(this.state.compares ?? [], this.state.interval)
      if (this.state.chartType === 'footprint') this.zoomForFootprint()
      this.lastUpdateAt = Date.now()
      this.renderIndicators()
      this.onData?.()
      if (this.state.orderFlow) {
        this.orderflow.reset() // symbol/interval just changed — don't mix in the previous one's levels
        for (const c of hist) this.orderflow.onCandle(c)
      }
      if (this.state.ict) this.ict.setCandles(this.candles) // re-derive from the new symbol/interval's candles
      if (this.state.ultraV2) this.ultraV2.setCandles(this.candles)
      if (this.state.fvgStrategy) this.fvgStrategy.setCandles(this.candles)
      if (this.state.cprStrategy) this.cprStrategy.setCandles(this.candles)
      if (this.state.fvVwapEma) this.fvVwapEma.setCandles(this.candles)
      if (this.state.halfTrend) this.halfTrend.setCandles(this.candles)
      if (this.state.ivFvStrategy) this.ivFvStrategy.setCandles(this.candles)
      if (this.state.zoneRetest) this.zoneRetest.setCandles(this.candles)
      if (this.state.ivZonesOptions?.enabled) this.ivZones.setCandles(this.candles)
      if (this.state.ivFade) this.ivFade.setCandles(this.candles)
      if (this.state.dcBigTrades) this.dcBigTrades.setCandles(this.candles)
      if (this.state.flagPatternsOptions?.enabled) this.flagPatterns.setCandles(this.candles)
      if (this.state.setupChecklistOptions?.enabled) this.setupChecklist.setCandles(this.candles)
      if (this.state.confluence) this.confluence.setCandles(this.candles)
      if (this.state.bigTrades) this.bigTrades.setCandles(this.candles)
      if (this.state.volumeProfileOptions?.enabled) this.volumeProfileTool.setCandles(this.candles)
      this.gex.setSpot(hist[hist.length - 1].close)
      this.gexV2.setSpot(hist[hist.length - 1].close)
      this.cpr.setAnchor(hist[hist.length - 1].time)
      this.unsub = this.provider.subscribeCandles(this.state.symbol, this.state.interval, (c) => {
        this.onLive(c)
        // Replaying: onLive() kept the hidden live series current; overlays stay on the replayed bars.
        if (this.replayFull) return
        if (this.state.orderFlow) {
          this.orderflow.onCandle(c)
        }
        if (this.state.ict) this.ict.setCandles(this.candles)
        if (this.state.ultraV2) this.ultraV2.setCandles(this.candles)
        if (this.state.fvgStrategy) this.fvgStrategy.setCandles(this.candles)
        if (this.state.cprStrategy) this.cprStrategy.setCandles(this.candles)
        if (this.state.fvVwapEma) this.fvVwapEma.setCandles(this.candles)
        if (this.state.halfTrend) this.halfTrend.setCandles(this.candles)
        if (this.state.ivFvStrategy) this.ivFvStrategy.setCandles(this.candles)
        if (this.state.zoneRetest) this.zoneRetest.setCandles(this.candles)
        if (this.state.ivZonesOptions?.enabled) this.ivZones.setCandles(this.candles)
        if (this.state.ivFade) this.ivFade.setCandles(this.candles)
        if (this.state.dcBigTrades) this.dcBigTrades.setCandles(this.candles)
        if (this.state.flagPatternsOptions?.enabled) this.flagPatterns.setCandles(this.candles)
      if (this.state.setupChecklistOptions?.enabled) this.setupChecklist.setCandles(this.candles)
        if (this.state.confluence) this.confluence.setCandles(this.candles)
        if (this.state.bigTrades) this.bigTrades.setCandles(this.candles)
        if (this.state.volumeProfileOptions?.enabled) this.volumeProfileTool.setCandles(this.candles)
        this.gex.setSpot(c.close)
        this.gexV2.setSpot(c.close)
        this.ivWalls.onCandle(c)
      })
      this.subscribeTradeFeed()
      void this.loadTapeHistory()
      this.setStatus('live', 'Delta India')
    } catch (err) {
      if (gen !== this.loadGen) return
      console.warn('[demo] Delta India unavailable — synthetic feed:', err)
      this.runSynthetic()
      // Say why when Delta refuses the timeframe for this symbol (5s, hence
      // 15s / 30s, exist only for BTCUSD and ETHUSD) — not just "offline".
      const msg = err instanceof Error ? err.message : String(err)
      const secondsOnly = /supported only for ([A-Z, ]+)/.exec(msg)
      this.setStatus('synthetic', secondsOnly ? `demo data — Delta has seconds bars only for ${secondsOnly[1].trim()}` : 'offline')
    }
  }

  /** Compare symbols on this chart. */
  getCompares(): CompareEntry[] {
    return this.state.compares ?? []
  }

  setCompares(list: CompareEntry[]): void {
    this.state.compares = list.map((e) => ({ ...e }))
    this.compare?.set(this.state.compares, this.state.interval)
    this.renderLegend()
  }

  /** Legend rows for compare symbols: name + % move since the first visible bar. */
  private compareRows(): ToolLegendRow[] {
    return (this.state.compares ?? []).map((e) => {
      const pct = e.hidden ? null : (this.compare?.changeSinceFirstVisible(e.symbol, this.candles) ?? null)
      return {
        id: `cmp:${e.symbol}`,
        label: e.symbol,
        color: e.color,
        values: e.hidden ? [] : [{ text: pct === null ? '…' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, color: e.color }],
        hidden: !!e.hidden,
        onToggle: () => this.setCompares(this.getCompares().map((x) => (x.symbol === e.symbol ? { ...x, hidden: !x.hidden } : x))),
        onRemove: () => {
          this.setCompares(this.getCompares().filter((x) => x.symbol !== e.symbol))
          this.onComparesChanged?.()
        },
      }
    })
  }

  /** A compare symbol was removed from the legend. */
  onComparesChanged?: () => void

  /** The bar under the crosshair (or the last bar) with every indicator / tool value, for the Data window. */
  getDataWindow(): DataWindowSnapshot {
    const n = this.candles.length
    const hoverOk = this.legendIdx !== null && !isRebinnedChartType(this.state.chartType)
    const i = hoverOk ? Math.min(n - 1, this.legendIdx!) : n - 1
    const rows = [
      ...this.legendIndicators.map((e) => this.indicatorRow(e)),
      ...this.toolRows,
    ].map((r) => ({ label: r.label, values: r.values, hidden: r.hidden }))
    return { candle: n > 0 && i >= 0 ? this.candles[i] : null, hovering: hoverOk, rows }
  }

  /** Composite every canvas layer of this chart (engine + overlays) into one image. */
  screenshot(): HTMLCanvasElement {
    const host = this.canvasHost.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const out = document.createElement('canvas')
    out.width = Math.round(host.width * dpr)
    out.height = Math.round(host.height * dpr)
    const ctx = out.getContext('2d')!
    for (const c of Array.from(this.canvasHost.querySelectorAll('canvas'))) {
      if (c.width === 0 || c.height === 0 || getComputedStyle(c).display === 'none') continue
      const r = c.getBoundingClientRect()
      ctx.drawImage(c, (r.left - host.left) * dpr, (r.top - host.top) * dpr, r.width * dpr, r.height * dpr)
    }
    // The title row is DOM, not canvas — paint its text where it sits.
    const head = this.headEl.getBoundingClientRect()
    const sym = this.symEl.getBoundingClientRect()
    ctx.scale(dpr, dpr)
    ctx.font = `600 12px ${getComputedStyle(this.headEl).fontFamily}`
    ctx.fillStyle = getComputedStyle(this.headEl).color
    ctx.textBaseline = 'middle'
    ctx.fillText(`${this.state.symbol} · ${PANE_VENUE} · ${this.state.interval}`, sym.left - host.left, head.top - host.top + head.height / 2)
    return out
  }

  destroy(): void {
    this.destroyed = true
    this.headRo.disconnect()
    this.styleBar?.destroy()
    this.compare?.destroy()
    this.cancelBarPick()
    cancelAnimationFrame(this.raf)
    if (this.unsub) this.unsub()
    this.unsubscribeTradeFeed()
    this.unsubscribeTicker()
    if (this.synthTimer !== null) clearInterval(this.synthTimer)
    this.rain.stop()
    this.poll.destroy()
    this.dominanceV2.destroy()
    this.orderflow.destroy()
    this.ict.destroy()
    this.ultraV2.destroy()
    this.fvgStrategy.destroy()
    this.cprStrategy.destroy()
    this.fvVwapEma.destroy()
    this.halfTrend.destroy()
    this.ivFvStrategy.destroy()
    this.zoneRetest.destroy()
    this.ivZones.destroy()
    this.ivFade.destroy()
    this.dcBigTrades.destroy()
    this.buddyLevels.destroy()
    this.flagPatterns.destroy()
    this.setupChecklist.destroy()
    this.depthImbalance.destroy()
    this.liquidityLevels.destroy()
    this.confluence.destroy()
    this.bigTrades.destroy()
    this.deepTrades.destroy()
    this.heavyAbsorption.destroy()
    this.blockBreak.destroy()
    this.deepProfile.destroy()
    this.deepStats.destroy()
    this.volumeProfileTool.destroy()
    this.footprint.destroy()
    this.gex.destroy()
    this.gexV2.destroy()
    this.ivWalls.destroy()
    this.cpr.destroy()
    this.ro.disconnect()
    this.engine.destroy()
    this.root.remove()
  }
}
