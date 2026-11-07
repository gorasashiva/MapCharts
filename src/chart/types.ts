import type { Candle, Theme } from '../core/types'
import type { IndicatorOutput, IndicatorPlacement } from '../indicators/types'
import type { Converters, Drawing, DrawingToolId } from '../drawings/types'
import type { Alert, ChartSettings } from '../alerts/types'

export type ChartType =
  | 'candles'
  | 'volcandles'
  | 'hollow'
  | 'heikin'
  | 'bars'
  | 'hlcbars'
  | 'hlcarea'
  | 'line'
  | 'linemarkers'
  | 'step'
  | 'area'
  | 'baseline'
  | 'columns'
  | 'highlow'
  | 'renko'
  | 'kagi'
  | 'linebreak'
  | 'pnf'
  | 'range'
  | 'footprint'

/**
 * Canonical list of every valid ChartType id. Single source of truth for
 * runtime validation (e.g. the cloud-sync defensive validator) so the allowed
 * set can never drift from the union above.
 */
export const CHART_TYPES: readonly ChartType[] = [
  'candles',
  'volcandles',
  'hollow',
  'heikin',
  'bars',
  'hlcbars',
  'hlcarea',
  'line',
  'linemarkers',
  'step',
  'area',
  'baseline',
  'columns',
  'highlow',
  'renko',
  'kagi',
  'linebreak',
  'pnf',
  'range',
  'footprint',
]

/**
 * Chart types whose series is RE-BINNED off the time axis (Renko, Kagi, Line
 * Break). For these the engine renders a synthetic series on the bar-index
 * axis and — because overlay/pane indicators are computed on the ORIGINAL
 * candles and no longer align bar-for-bar — SKIPS drawing indicators and
 * volume. Crosshair, last-price and drawings still work on the synthetic axis.
 */
export const REBINNED_CHART_TYPES: ReadonlySet<ChartType> = new Set<ChartType>([
  'renko',
  'kagi',
  'linebreak',
  'pnf',
  'range',
])

export function isRebinnedChartType(type: ChartType): boolean {
  return REBINNED_CHART_TYPES.has(type)
}

/** One active indicator instance, fully computed, ready to render. */
export interface IndicatorRenderData {
  instanceId: string
  label: string // e.g. "RSI 14"
  placement: IndicatorPlacement
  outputs: IndicatorOutput[] // values aligned 1:1 with the candles passed to setData
  range?: [number, number] // fixed y-range for pane indicators
}

/**
 * A ghost polyline anchored at the LAST candle: each point is placed at
 * x = (last bar index + barOffset), so projections sprout rightward from "now"
 * into empty future space. Rendered only on the main price pane.
 */
export interface ProjectionLine {
  id: string
  color: string
  opacity: number // 0..1
  width: number
  dashed?: boolean
  points: { barOffset: number; price: number }[] // barOffset >= 0; 0 = at the last bar
}

/** A translucent fill between two future price paths (e.g. echo quartile band). */
export interface ProjectionBand {
  color: string
  opacity: number // fill opacity, 0..1
  upper: { barOffset: number; price: number }[]
  lower: { barOffset: number; price: number }[]
}

export interface ChartEngineOptions {
  theme: Theme
  pricePrecision: number
  chartType: ChartType
  /**
   * Fired (at most once per setData) when the user pans near the oldest
   * loaded candle — host should fetch older history and call setData with
   * the prepended array.
   */
  onRequestHistory?: () => void
  /** Fired whenever drawings are added / moved / deleted inside the engine. */
  onDrawingsChange?: (drawings: Drawing[]) => void
  /** Fired when the engine finishes/cancels a drawing tool (so UI can un-highlight it). */
  onActiveToolChange?: (tool: DrawingToolId | null) => void
  /** Fired when the selected drawing changes (select, deselect, delete, commit). */
  onSelectionChange?: (drawing: Drawing | null) => void
  /**
   * Right-click on the chart: the host shows a context menu at (x, y) — client
   * px relative to the container — with `price`/`time` at the cursor (for an
   * "add alert here" action). The engine has already called preventDefault.
   */
  onContextMenu?: (info: { x: number; y: number; price: number; time: number }) => void
  /** User clicked an alert line's delete/bell affordance — host removes the alert. */
  onAlertRemove?: (id: string) => void
  /** User dragged an alert line to a new price — host updates the alert. */
  onAlertMove?: (id: string, price: number) => void
  /**
   * Fires when the bar the legend reads changes: the hovered bar, or null when
   * the crosshair leaves (legend falls back to the last bar). Lets a host-drawn
   * legend show the same values the engine's legend would.
   */
  onLegendIndex?: (index: number | null) => void
  /** Fires whenever undo/redo availability may have changed (any drawing edit, undo, redo or replace). */
  onHistoryChange?: () => void
  /** The crosshair moved to a bar (its open time) or left the chart (null) — for syncing other charts. */
  onCrosshairTime?: (time: number | null) => void
  /** The visible time range changed by the user (pan / zoom) — for syncing other charts. */
  onViewChange?: () => void
  /** The price-axis "%" button was clicked; the host owns the scale mode (else the engine flips it itself). */
  onPercentToggle?: (next: PriceDisplayMode) => void
  /** The bottom-right axis corner (time-zone label) was clicked; client px of the click. */
  onTimeZoneCornerClick?: (clientX: number, clientY: number) => void
  /** A separate pane was resized by dragging the line above it: heights in CSS px by indicator id. */
  onPaneHeightsChange?: (heights: Record<string, number>) => void
}

/** How the main price axis labels prices. 'percent' / 'indexed' are relative to the first visible bar's close. */
export type PriceDisplayMode = 'price' | 'percent' | 'indexed'

/** Canvas appearance options (Chart settings dialog). Omitted fields keep their current value. */
export interface ChartAppearance {
  /** Chart background; null = the theme's. */
  background?: string | null
  gridMode?: 'both' | 'horizontal' | 'vertical' | 'none'
  /** Dashed vertical line at each new day (display time zone), intraday only. */
  sessionBreaks?: boolean
  lastPriceLine?: boolean
  /** Time-to-close countdown under the last-price tag. */
  countdown?: boolean
  /** The OHLC / change / volume row at the top-left. */
  ohlcLegend?: boolean
  /** Volume histogram faded along the bottom of the main pane. */
  volumeOverlay?: boolean
  /** Momentum panning, eased zoom, eased autoscale and a gliding last-price tag. */
  smooth?: boolean
  /** Candle parts (candles / Heikin Ashi / range bars). Defaults: body + wick, no border. */
  candleBody?: boolean
  candleBorder?: boolean
  candleWick?: boolean
  crosshairStyle?: 'dashed' | 'dotted' | 'solid'
  /** Bottom colour of a vertical gradient (top = background); null = solid. */
  backgroundGradient?: string | null
  /** "%" toggle under the A / L buttons on the price axis. */
  percentButton?: boolean
  /** Time-zone label in the bottom-right axis corner (text supplied by the host, e.g. "IST"). */
  cornerLabel?: string | null
}

/** Another symbol drawn on the main pane, re-based to the main series at the first visible bar. */
export interface CompareSeries {
  id: string
  label: string
  color: string
  candles: Candle[]
}

/**
 * Public API of the canvas chart engine.
 * Created via `createChartEngine(container, options)` from src/chart/engine.ts.
 *
 * setData semantics: full replace. If the new array shares the previous
 * last-candle time but has extra candles prepended (history pagination),
 * the viewport must stay visually stable (shift indices by the prepend count).
 */
export interface IChartEngine {
  setData(candles: Candle[]): void
  /** Live update: replace last candle if same open time, else append. Auto-scrolls if viewport is at the right edge. */
  updateLast(candle: Candle): void
  setIndicators(indicators: IndicatorRenderData[]): void
  setChartType(type: ChartType): void
  /**
   * Fix the Renko box size (price units); null or 0 = auto (0.5 x ATR(14)).
   * Rebuilds the bricks when the chart type is 'renko'.
   */
  setRenkoBoxSize(size: number | null): void
  /** Box size of the Renko bricks on screen; 0 when the chart type isn't 'renko'. */
  getRenkoBoxSize(): number
  /** x (CSS px) of the center of drawn-series bar `index` — a brick index on re-binned chart types. */
  barCenterX(index: number): number
  setTheme(theme: Theme): void
  setPricePrecision(precision: number): void
  /** Arm a drawing tool (clicks then place its points), or null to disarm. */
  setActiveTool(tool: DrawingToolId | null): void
  /** Replace all drawings (e.g. restored from localStorage). Does NOT fire onDrawingsChange. */
  setDrawings(drawings: Drawing[]): void
  /**
   * Replace one drawing by id (inspector edits: color/width/text/props/points).
   * Keeps selection on it, repaints, fires onDrawingsChange (but not onSelectionChange).
   */
  updateDrawing(drawing: Drawing): void
  /** Magnet mode: placement clicks and handle drags snap to the nearest OHLC value when close. */
  setMagnet(on: boolean): void
  /**
   * Render price-alert lines on the main pane: a dashed horizontal line at each
   * alert price with a bell glyph + price tag near the right axis. Clicking the
   * bell fires onAlertRemove; dragging the line fires onAlertMove. Triggered
   * alerts render muted. Pass [] to clear. (Only alerts for the current symbol.)
   */
  setAlerts(alerts: Alert[]): void
  /** Apply appearance settings: candle up/down colors, grid + crosshair visibility. */
  setSettings(settings: ChartSettings): void
  clearDrawings(): void
  resetView(): void
  resize(): void
  destroy(): void
  /**
   * Render ghost paths sprouting rightward from the last candle (pass [] / null
   * to clear). If the viewport is following the right edge when called, the
   * right-edge offset expands once so the longest projection is visible.
   * Projections must survive setData/updateLast until explicitly cleared.
   */
  setProjections(lines: ProjectionLine[], band?: ProjectionBand | null): void
  /**
   * Reserve at least `px` pixels of blank space right of the last bar, for an
   * overlay that draws there (e.g. THE MAP's level labels). Applies only while
   * the viewport follows the right edge; never shrinks the current offset or
   * changes the zoom, so panning away is respected. Cheap to call every frame.
   */
  ensureRightGutter(px: number): void
  /** Center the viewport on the candle nearest the given time (epoch ms). */
  scrollToTime(time: number): void
  /** Zoom so about `bars` bars span the plot, keeping the right edge fixed. */
  zoomToBars(bars: number): void
  /**
   * Replay mode: when `index` is a number the engine treats the visible data as
   * `renderSeries.slice(0, index + 1)` — every series-derived layer (drawn
   * series + re-binned blocks, volume histogram, overlay + pane indicator plots
   * and their legend values, the last-price line/tag, the price auto-fit and
   * the crosshair/legend) is clipped to bars `[0..index]`; bars after `index`
   * are the hidden "future". The time axis and bar-index positions are
   * untouched, so the chart never resizes horizontally — only data drawing is
   * cut off at the cursor. `index` is clamped to `[0, renderSeries.length - 1]`.
   * Pass `null` to leave replay (render everything as normal). setData/updateLast
   * remain safe during replay and re-clamp the cursor if the series shrank.
   */
  setReplayCursor(index: number | null): void
  /**
   * Whether replay playback is running. While true, zoom gestures keep the
   * replay cursor on screen (so the per-tick auto-scroll never snaps the view
   * away mid-gesture); while false (paused / replay off) zoom is purely
   * pointer-anchored. Rendering is unaffected.
   */
  setReplayPlaying(playing: boolean): void
  /**
   * Current main-pane coordinate converters (CSS px, time extrapolates past
   * the data edge), for overlays that draw in sync with the chart — e.g. the
   * Oracle storm canvas. Returns null before the first layout. The object is
   * a live view: results reflect the viewport at call time, so overlays
   * should re-query every animation frame rather than caching results.
   */
  getMainConverters(): Converters | null
  /** Geometry of the main price pane in CSS px (for clipping overlays). Null before first layout. */
  getMainPaneRect(): { x: number; y: number; width: number; height: number } | null
  /**
   * Coloured level tags on the main price scale, grouped by `source` so each
   * overlay owns (and replaces) only its own set. Tags are stacked so they never
   * cover each other or the last-price tag. Pass [] to clear a source. Calling
   * with an identical list is a cheap no-op, so overlays may call it per frame.
   */
  setPriceTags(source: string, tags: PriceTag[]): void
  /** Show each tag's `label` as a small chip at the right edge of the plot (TradingView's "indicator name labels"). */
  setPriceTagLabels(on: boolean): void
  /** Main price scale state: auto-fit vs manual range, log vs linear, label mode and inversion. */
  getPriceScale(): { auto: boolean; log: boolean; mode: PriceDisplayMode; invert: boolean }
  /** Change the main price scale. `auto: true` re-fits to the visible data; `auto: false` freezes the current range. */
  setPriceScale(next: { auto?: boolean; log?: boolean; mode?: PriceDisplayMode; invert?: boolean }): void
  /** Y (CSS px, relative to the container) just below the last legend row drawn on the main pane. */
  getLegendBottom(): number
  /** Draw indicator name/value rows on the canvas (default true). Off when the host renders its own legend. */
  setIndicatorLegend(on: boolean): void
  /** Every price pane's vertical extent in CSS px: [0] is the main pane, then one per pane indicator in setIndicators order. */
  getPaneRects(): { top: number; height: number }[]
  /** Heights (CSS px) of separate panes by indicator id; ids not listed use the default height. */
  setPaneHeights(heights: Record<string, number>): void
  getPaneHeights(): Record<string, number>
  /** Add one drawing and select it (fires onDrawingsChange; undoable). */
  addDrawing(d: Drawing): void
  /** Delete one drawing by id (fires onDrawingsChange; undoable). */
  removeDrawing(id: string): void
  /** Step back / forward through drawing edits. Return false when there is nothing to undo / redo. */
  undo(): boolean
  redo(): boolean
  canUndo(): boolean
  canRedo(): boolean
  /** Eraser mode: clicking or dragging over drawings deletes them (no panning while on). */
  setEraser(on: boolean): void
  /** Keep a drawing tool armed after each placement instead of returning to the cursor. */
  setStayInDrawingMode(on: boolean): void
  /** Faint centred watermark text on the main pane (null hides it). */
  setWatermark(text: string | null): void
  /** X (CSS px) where the OHLC legend row starts, leaving room for a host-drawn title on its left. */
  setLegendInset(x: number): void
  /** Canvas appearance (background, grid, session breaks, volume overlay, smooth motion…). */
  setAppearance(next: ChartAppearance): void
  getAppearance(): Required<ChartAppearance>
  /** Lines for other symbols on the main pane (pass [] to clear). */
  setCompareSeries(list: CompareSeries[]): void
  /** Hide every drawing / lock every drawing against moves (per-drawing `props.hidden` / `props.locked` also apply). */
  setDrawingsHidden(hidden: boolean): void
  setDrawingsLocked(locked: boolean): void
  /** Select a drawing by id (null clears the selection). */
  selectDrawing(id: string | null): void
  /** Inclusive integer bar range on screen (clamped to the data). */
  getVisibleRange(): { from: number; to: number }
  /** Visible time span (epoch ms of the left / right plot edges), null before data. */
  getVisibleTimeRange(): { from: number; to: number } | null
  /** Show this time span (from another chart). Does not fire onViewChange. */
  setVisibleTimeRange(from: number, to: number): void
  /** Draw another chart's crosshair time as a vertical line (null hides it). */
  setExternalCrosshair(time: number | null): void
  /** A fixed vertical line at `time` ("Lock vertical cursor here"); null removes it. */
  setCursorLock(time: number | null): void
  getCursorLock(): number | null
  /** Zoom by `factor` (>1 = in) around the right edge, animated when smooth motion is on. */
  zoomBy(factor: number): void
  /** Scroll by `bars` (positive = toward newer bars), animated when smooth motion is on. */
  scrollBars(bars: number): void
}

/** One level tag on the main price scale (see IChartEngine.setPriceTags). */
export interface PriceTag {
  price: number
  /** Tag background. */
  color: string
  /** Tag text colour; defaults to black or white, whichever reads better on `color`. */
  textColor?: string
  /** Short name shown as a chip beside the scale when tag labels are on, e.g. "VAH". */
  label?: string
}
