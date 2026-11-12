/**
 * Canvas chart engine: single high-DPI canvas, bar-index based time scale,
 * stacked panes (price + one sub-pane per 'pane' indicator), shared time axis,
 * drawings, crosshair and pan/zoom interactions.
 */
import type { Candle, Theme } from '../core/types'
import type { Converters, DrawEnv, Drawing, DrawingPoint, DrawingToolId } from '../drawings/types'
import {
  renderDrawing,
  hitTestDrawing,
  hitTestHandle,
  translateDrawing,
  movePoint,
  pointsNeeded,
  toolImpl,
  defaultDrawing,
} from '../drawings'
import type {
  ChartEngineOptions,
  ChartType,
  IChartEngine,
  IndicatorRenderData,
  ProjectionBand,
  ProjectionLine,
} from './types'
import { isRebinnedChartType } from './types'
import type { PriceTag, ChartAppearance, PriceDisplayMode, CompareSeries } from './types'
import {
  toHeikinAshi,
  haStep,
  renkoBuilder,
  lineBreakBuilder,
  pnfBuilder,
  rangeBarsBuilder,
  kagiBuilder,
  autoRenkoBoxSize,
  autoPnfBoxSize,
  autoRangeSize,
  createRebinSession,
  stepRebinSession,
  type RebinSession,
  type KagiPoint,
} from './chartTransforms'
import type { Alert, ChartSettings } from '../alerts/types'
import { THEMES, FONT, SMALL_FONT } from './themes'
import type { ChartColors } from './themes'
import type { ViewState } from './scales'
import {
  TimeScale,
  PriceScale,
  computeTimeTicks,
  formatTimeTickLabel,
  formatFullTime,
  formatPrice,
  formatCompact,
  decimalsForStep,
  niceStep,
  displayZoneOffset,
} from './scales'
import * as R from './renderers'
import { attachInteractions } from './interactions'
import { IndicatorRangeCache } from './indicatorRanges'

const PRICE_AXIS_W = 64
const TIME_AXIS_H = 26
const SUB_PANE_H = 110
const SEPARATOR_H = 1
/** A separate pane is never shorter than this, and leaves the main pane at least MAIN_MIN_H. */
const SUB_PANE_MIN_H = 40
const MAIN_MIN_H = 120
/** How close (px) to a pane's top line a press grabs it for resizing. */
const SEPARATOR_GRAB = 4
const MIN_VISIBLE_BARS = 3
const DEFAULT_VISIBLE_BARS = 160
const RIGHT_OFFSET_BARS = 5
const HISTORY_TRIGGER_BARS = 10
const MAGNET_SNAP_PX = 50
/** Side length of the square "A" (auto/manual) toggle button at the top of the price axis. */
const AXIS_TOGGLE_SIZE = 18
/** Inset of the toggle button from the right axis' top-left corner. */
const AXIS_TOGGLE_MARGIN = 4
/**
 * Pixels of vertical drag mapped to one e-fold of the manual price range when
 * scaling via the axis: range *= exp(dyPx / AXIS_SCALE_PX). Larger = gentler.
 */
const AXIS_SCALE_PX = 180
const FREEHAND_MIN_DIST_PX = 3
const FREEHAND_MAX_POINTS = 400
/** Vertical pixel tolerance for grabbing an alert line to drag it. */
const ALERT_HIT_PX = 5

interface PaneLayout {
  kind: 'main' | 'indicator'
  top: number
  height: number
  indicator?: IndicatorRenderData
}

interface Layout {
  width: number
  height: number
  plotWidth: number
  timeAxisTop: number
  panes: PaneLayout[]
}

type DragState =
  /**
   * Body drag. Horizontal time pan via `lastX` (always). In 'manual' price-scale
   * mode it is also a vertical price pan via `lastY`, making body-drag 2D.
   */
  | { mode: 'pan'; lastX: number; lastY: number }
  | { mode: 'move-drawing'; id: string; original: Drawing; startTime: number; startPrice: number; moved: boolean }
  | { mode: 'move-handle'; id: string; original: Drawing; handleIndex: number; moved: boolean }
  /** In-progress freehand (brush) capture; the drawing is committed on pointerup. */
  | { mode: 'freehand'; drawing: Drawing; lastPx: number; lastPy: number }
  /** Dragging a price-alert line vertically; onAlertMove fires on pointerup. */
  | { mode: 'move-alert'; id: string; price: number; moved: boolean }
  /**
   * Dragging the right price-axis strip to SCALE the main pane's price range
   * about the price under the drag-start Y. Switches the main scale to 'manual'.
   * `startMin`/`startMax` snapshot the range at gesture start; `anchorPrice` is
   * the price held fixed; `startY` is the pixel origin of the drag.
   */
  | { mode: 'scale-axis'; startMin: number; startMax: number; anchorPrice: number; startY: number }
  /** Eraser armed: every drawing the pointer crosses while pressed is deleted. */
  | { mode: 'erase' }
  /** Dragging the line above a separate pane: that pane grows / shrinks, the main pane takes the rest. */
  | { mode: 'resize-pane'; id: string; startY: number; startH: number }

/** Undo history depth for drawing edits. */
const MAX_UNDO = 100

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/** Black or white text, whichever contrasts better with a #rgb/#rrggbb background (white for anything else). */
function readableText(bg: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(bg.trim())
  if (!m) return '#ffffff'
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.4 ? '#131722' : '#ffffff'
}

/** Format milliseconds-remaining as a candle-close countdown (e.g. "04:31", "1:04:31", "6d 23:04"). */
function formatCountdown(ms: number): string {
  let s = Math.floor(ms / 1000)
  const days = Math.floor(s / 86400)
  s -= days * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (days > 0) return `${days}d ${pad(h)}:${pad(m)}`
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`
  return `${pad(m)}:${pad(sec)}`
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

export function createChartEngine(container: HTMLElement, options: ChartEngineOptions): IChartEngine {
  // ----- canvas setup ------------------------------------------------------
  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  // Touch gestures on the chart drive pan / pinch-zoom — never the browser's
  // page scroll/zoom. (The interaction layer also preventDefaults touch events.)
  canvas.style.touchAction = 'none'
  const maybeCtx = canvas.getContext('2d')
  if (!maybeCtx) throw new Error('CandL chart: 2d canvas context unavailable')
  const ctx = maybeCtx
  container.appendChild(canvas)

  // ----- state -------------------------------------------------------------
  let theme: Theme = options.theme
  let precision = options.pricePrecision
  let chartType: ChartType = options.chartType
  let candles: Candle[] = []
  /**
   * The series actually drawn on the bar-index axis + driving the price scale,
   * derived from `candles` + chartType:
   *  - 1:1 types (candles/hollow/bars/line/area/...): identical times to
   *    `candles` (heikin transforms OHLC but keeps the count), so index↔candle
   *    mapping is unchanged from the original 4-type behavior.
   *  - re-binned types (renko/linebreak/kagi): a SYNTHETIC array whose times
   *    approximate each element's source-candle time. `ts` is built from THESE
   *    times, so the index axis, crosshair and last-price track the synthetic
   *    series. Volume + indicators are skipped for re-binned types (they're
   *    computed on the original candles and no longer align).
   */
  let renderSeries: Candle[] = []
  /** Kagi vertices when chartType === 'kagi' (else null). Drawn as a polyline. */
  let kagiPoints: KagiPoint[] | null = null
  /**
   * Box height (in price) of the active Point & Figure series, so the renderer
   * can stack the right number of X/O glyphs per column. 0 when chartType isn't
   * 'pnf'. Set in rebuildSeries alongside renderSeries.
   */
  let pnfBoxSize = 0
  /** Fixed Renko box (price units) set via setRenkoBoxSize; null = auto (0.5 x ATR14). */
  let renkoBoxOverride: number | null = null
  /** Box size of the Renko series currently drawn (0 when chartType isn't 'renko'). */
  let activeRenkoBox = 0
  /**
   * Cached incremental re-binning session for the active re-binned chart type
   * (renko/linebreak/pnf/range/kagi), or null for 1:1 types / no data yet.
   * Set alongside renderSeries in rebuildSeries(); extendSeries() replays a
   * live tick against it in O(one candle) instead of rebuildSeries()'s
   * O(candles) full re-transform. See chartTransforms.ts's file doc.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- holds
  // whichever RebinBuilder<S> is active; S is erased here on purpose (the 5
  // re-binned chart types have unrelated state shapes) and every read site
  // either only touches the shared `output`/`lastTime` fields or is the one
  // type-specific branch in extendSeries() that created this session.
  let rebinSession: RebinSession<any> | null = null
  let indicators: IndicatorRenderData[] = []
  /** User-set separate-pane heights (CSS px) by indicator id. */
  let paneHeights: Record<string, number> = {}
  /**
   * Replay cursor in render-series index space, or null when replay is OFF.
   * When set, the engine clips every series-derived layer to bars [0..cursor]
   * (the bars after it are the hidden "future"); see effectiveLength(). Always
   * kept within [0, renderSeries.length-1] by clampReplayCursor(), re-applied
   * after setData/updateLast in case the series shrank.
   */
  let replayCursor: number | null = null
  /**
   * Whether replay playback is actively running (host-pushed via
   * setReplayPlaying). Zoom gestures consult this: while playing, the view
   * must keep the cursor on screen or the next tick's auto-scroll snaps the
   * view away mid-gesture; while paused there is no tick, so pointer-anchored
   * zoom is free to move the playhead off screen (inspecting history).
   */
  let replayPlaying = false
  let projLines: ProjectionLine[] = []
  let projBand: ProjectionBand | null = null
  let drawings: Drawing[] = []
  let alerts: Alert[] = []
  /**
   * Appearance settings. Null until the host calls setSettings; while null the
   * engine falls back to the active theme's up/down colors with grid + crosshair
   * shown (matching the contract's "default before first setSettings").
   */
  let settings: ChartSettings | null = null
  /**
   * Tag rectangles (CSS px) of the alert affordances drawn this frame, by id —
   * rebuilt every render so click hit-testing always matches what's on screen.
   */
  let alertTagRects: { id: string; x: number; y: number; width: number; height: number }[] = []
  let selectedId: string | null = null
  let activeTool: DrawingToolId | null = null
  let pendingPoints: DrawingPoint[] = []
  let magnet = false
  let eraser = false
  let stayInDrawing = false
  let watermark: string | null = null
  /** Backdrop: drawn over the grid, under the candles and indicators (see setBackdrop). */
  let backdrop: ((g: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, conv: Converters) => void) | null = null
  /** X where the main pane's OHLC legend row starts (a host title may sit left of it). */
  let legendInsetX = 10
  // ----- V4: appearance, scale modes, compare, sync, smooth motion -----
  const appearance: Required<ChartAppearance> = {
    background: null,
    gridMode: 'both',
    sessionBreaks: false,
    lastPriceLine: true,
    countdown: true,
    ohlcLegend: true,
    volumeOverlay: false,
    smooth: true,
    candleBody: true,
    candleBorder: false,
    candleWick: true,
    crosshairStyle: 'dashed',
    backgroundGradient: null,
    percentButton: true,
    cornerLabel: null,
  }
  let cursorLock: number | null = null
  let pctToggleRect: { x: number; y: number; width: number; height: number } | null = null
  /** Candle parts to draw, or undefined for the default look (keeps the default path byte-identical). */
  const candleParts = (): R.CandleParts | undefined =>
    appearance.candleBody && appearance.candleWick && !appearance.candleBorder
      ? undefined
      : { body: appearance.candleBody, border: appearance.candleBorder, wick: appearance.candleWick }
  const crosshairDash = (): number[] => (appearance.crosshairStyle === 'solid' ? [] : appearance.crosshairStyle === 'dotted' ? [1, 3] : [3, 3])
  let displayMode: PriceDisplayMode = 'price'
  let priceInvert = false
  let compares: { id: string; label: string; color: string; byTime: Map<number, number> }[] = []
  let drawingsHidden = false
  let drawingsLocked = false
  let externalCrosshair: number | null = null
  /** Target view of an eased zoom / scroll (null = not animating). */
  let viewAnim: ViewState | null = null
  /** Momentum after a fling-pan: bars per ms, decaying each frame. */
  let momentum: { v: number; t: number } | null = null
  /** Recent (time, view.start) samples during a pan, for the fling velocity. */
  let panSamples: { t: number; start: number }[] = []
  /** Eased auto-fit price range actually drawn (null = snap to target). */
  let shownRange: { min: number; max: number; log: boolean } | null = null
  let scaleAnimGen = 0
  /** Eased y-price of the last-price tag. */
  let shownLast: number | null = null
  let lastFrameAt = 0
  let lastViewEmit = ''
  let suppressViewEmit = false
  let lastCrosshairTime: number | null | undefined = undefined
  let lastPriceMoving = false
  /**
   * The user has panned / zoomed away from the live edge. While true, overlays
   * asking for a right gutter (ensureRightGutter, called every frame by e.g.
   * THE MAP) must not pull the view back — that froze panning. Cleared by a
   * reset or by scrolling back to the latest bar.
   */
  let userMovedView = false
  let barMs = 60_000 // median candle spacing; recomputed on setData
  /**
   * Main price-pane scale mode. In 'auto' (default) computeMainScale auto-fits
   * the visible data, the original behavior. In 'manual' it uses the stored
   * `manualScale` { min, max } verbatim (no auto-fit, no margin re-application),
   * so the user's drag-set range survives setData/updateLast until reset. Only
   * the MAIN pane has a manual mode; indicator sub-panes always auto-fit.
   */
  let priceScaleMode: 'auto' | 'manual' = 'auto'
  /** The fixed main-pane price range while `priceScaleMode === 'manual'`. */
  let manualScale: { min: number; max: number } | null = null
  /** Logarithmic main price axis (the "L" toggle); independent of auto/manual. */
  let priceScaleLog = false
  /** Host-supplied level tags on the price scale, by source (see setPriceTags). */
  const priceTags = new Map<string, PriceTag[]>()
  let priceTagLabels = true
  /** Y just below the last main-pane legend row, recorded each render. */
  let legendBottom = 0
  let indicatorLegend = true
  let lastLegendIdx: number | null | undefined = undefined
  /**
   * The "A" toggle button rect (CSS px) drawn this frame at the top of the price
   * axis, or null when there's no axis to draw on. Rebuilt every render so click
   * hit-testing always matches what's on screen.
   */
  let axisToggleRect: { x: number; y: number; width: number; height: number } | null = null
  /** The "L" log-scale toggle button rect (CSS px) drawn this frame, or null. */
  let logToggleRect: { x: number; y: number; width: number; height: number } | null = null
  let drag: DragState | null = null
  let hover: { x: number; y: number } | null = null
  let historyArmed = true
  let destroyed = false
  let rafId = 0
  let currentDpr = 1
  const size = { width: 0, height: 0 }

  const ts = new TimeScale()
  /** Reuses indicator extrema while a scale is queried repeatedly for a frame. */
  const indicatorRanges = new IndicatorRangeCache()

  // ----- sizing / render loop ----------------------------------------------
  function applySize(): void {
    const w = container.clientWidth
    const h = container.clientHeight
    currentDpr = Math.max(1, window.devicePixelRatio || 1)
    size.width = w
    size.height = h
    // Assigning canvas.width/height clears the bitmap even when the value is
    // unchanged — skip it then, or every no-op resize flashes a blank frame.
    const bw = Math.max(1, Math.round(w * currentDpr))
    const bh = Math.max(1, Math.round(h * currentDpr))
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }
    ctx.setTransform(currentDpr, 0, 0, currentDpr, 0, 0)
  }

  /** Schedule a render on the next animation frame (coalesces repeated calls). */
  function invalidate(): void {
    if (destroyed || rafId !== 0) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      render()
    })
  }

  // Re-render once a second so the live candle's close-countdown keeps ticking
  // even when no price update arrives. invalidate() coalesces to one frame.
  const countdownTimer = setInterval(invalidate, 1000)

  // ----- layout & scales ----------------------------------------------------
  function computeLayout(): Layout {
    const width = size.width
    const height = size.height
    const plotWidth = Math.max(0, width - PRICE_AXIS_W)
    const paneInds = indicators.filter((i) => i.placement === 'pane')
    const np = paneInds.length
    const timeAxisTop = Math.max(0, height - TIME_AXIS_H)
    const available = Math.max(0, timeAxisTop - np * SEPARATOR_H)
    // each separate pane: its user-set height (dragged), else the default
    let subs = paneInds.map((ind) => Math.max(SUB_PANE_MIN_H, Math.round(paneHeights[ind.instanceId] ?? SUB_PANE_H)))
    const want = subs.reduce((a, b) => a + b, 0)
    if (np > 0 && available - want < MAIN_MIN_H) {
      // Not enough room: shrink the separate panes in proportion, keep the main pane usable.
      const room = Math.max(np * SUB_PANE_MIN_H, available - MAIN_MIN_H)
      subs = subs.map((h) => Math.max(SUB_PANE_MIN_H, Math.floor((h / want) * room)))
    }
    const mainH = Math.max(0, available - subs.reduce((a, b) => a + b, 0))
    const panes: PaneLayout[] = [{ kind: 'main', top: 0, height: mainH }]
    let top = mainH
    paneInds.forEach((ind, k) => {
      top += SEPARATOR_H
      panes.push({ kind: 'indicator', top, height: subs[k], indicator: ind })
      top += subs[k]
    })
    ts.plotWidth = plotWidth
    return { width, height, plotWidth, timeAxisTop, panes }
  }

  function paneIndexAt(y: number, layout: Layout): number {
    for (let i = 0; i < layout.panes.length; i++) {
      const p = layout.panes[i]
      if (y >= p.top && y < p.top + p.height) return i
    }
    return -1
  }

  /**
   * Main-pane price scale. In 'manual' mode it uses the user's fixed
   * { min, max } verbatim (the drag-set range, no auto-fit / no margin), so the
   * scale stays put across setData/updateLast. In 'auto' mode (default) it
   * auto-fits the visible series + visible overlay values with 8% margins.
   */
  /** The main scale the data asks for right now (no easing). */
  function computeTargetMainScale(pane: PaneLayout): PriceScale {
    if (priceScaleMode === 'manual' && manualScale !== null) {
      return new PriceScale(
        pane.top,
        pane.height,
        manualScale.min,
        manualScale.max,
        priceScaleLog && manualScale.min > 0,
        priceInvert,
      )
    }
    const range = ts.visibleRange()
    const from = range.from
    // Replay clips data at the cursor; the auto-fit (series + overlay values +
    // projections) must ignore the hidden "future" so it never includes bars
    // past the cursor. effectiveLength()-1 is the last visible bar.
    const to = Math.min(range.to, effectiveLength() - 1)
    let min = Infinity
    let max = -Infinity
    if (renderSeries.length > 0 && from <= to) {
      // Close-only fitting for the pure-line / close-anchored types; the rest
      // (candles/bars/heikin/renko/etc.) fit to the full high-low range.
      const closeOnly =
        chartType === 'line' ||
        chartType === 'area' ||
        chartType === 'linemarkers' ||
        chartType === 'step' ||
        chartType === 'baseline' ||
        chartType === 'columns' ||
        chartType === 'kagi'
      for (let i = from; i <= to; i++) {
        const c = renderSeries[i]
        if (closeOnly) {
          if (c.close < min) min = c.close
          if (c.close > max) max = c.close
        } else {
          if (c.low < min) min = c.low
          if (c.high > max) max = c.high
        }
      }
      // Re-binned series' indicators are computed on the original candles and no
      // longer align bar-for-bar, so they're skipped (here and at draw time).
      if (!isRebinnedChartType(chartType)) {
        for (const ind of indicators) {
          if (ind.placement !== 'overlay') continue
          for (const out of ind.outputs) {
            const values = indicatorRanges.range(out, from, to)
            if (!values) continue
            if (values.min < min) min = values.min
            if (values.max > max) max = values.max
          }
        }
      }
    }
    // Compare lines (re-based to the main series) share the main price scale.
    if (compares.length > 0 && renderSeries.length > 0 && from <= to && !isRebinnedChartType(chartType)) {
      for (const cmp of compares) {
        const base = compareBase(cmp, from, to)
        if (!base) continue
        for (let i = from; i <= to; i++) {
          const v = cmp.byTime.get(renderSeries[i].time)
          if (v == null) continue
          const m = (base.main * v) / base.cmp
          if (m < min) min = m
          if (m > max) max = m
        }
      }
    }
    // Projections: include only points whose bar offsets are (about) on screen,
    // so visible ghosts never render off-scale but far-future points don't
    // distort the fit when the user is zoomed elsewhere. One bar of margin on
    // each side mirrors how line series extend past the viewport edges.
    if (renderSeries.length > 0 && (projLines.length > 0 || projBand !== null)) {
      const lastIdx = renderSeries.length - 1
      const includeProjectionPoints = (pts: { barOffset: number; price: number }[]): void => {
        for (const p of pts) {
          const center = lastIdx + p.barOffset + 0.5 // center-x bar index of the point
          if (center < ts.view.start - 1 || center > ts.view.end + 1) continue
          if (!isFinite(p.price)) continue
          if (p.price < min) min = p.price
          if (p.price > max) max = p.price
        }
      }
      for (const line of projLines) includeProjectionPoints(line.points)
      if (projBand) {
        includeProjectionPoints(projBand.upper)
        includeProjectionPoints(projBand.lower)
      }
    }
    if (!isFinite(min) || !isFinite(max)) {
      min = 0
      max = 1
    }
    if (min === max) {
      const p = Math.abs(min) * 0.01 || 1
      min -= p
      max += p
    }
    // Log axis (only with a strictly positive range): pad in log space so the
    // 8% margins look even, and never let the padded min cross zero.
    // Volume drawn along the bottom of the main pane gets its own headroom.
    const volPad = appearance.volumeOverlay && !isRebinnedChartType(chartType) ? 0.22 : 0
    if (priceScaleLog && min > 0) {
      const lmin = Math.log(min)
      const lmax = Math.log(max)
      const lpad = (lmax - lmin) * 0.08
      const lvol = (lmax - lmin) * volPad
      return new PriceScale(pane.top, pane.height, Math.exp(lmin - lpad - lvol), Math.exp(lmax + lpad), true, priceInvert)
    }
    const pad = (max - min) * 0.08
    return new PriceScale(pane.top, pane.height, min - pad - (max - min) * volPad, max + pad, false, priceInvert)
  }

  /**
   * Cache the auto-fit target by value and data identity. Smooth motion asks
   * for this target twice per frame, and overlay consumers can ask again after
   * the canvas render; without this guard every request rescans all indicators.
   */
  let targetScaleCache: {
    scale: PriceScale
    viewStart: number
    viewEnd: number
    width: number
    height: number
    paneTop: number
    paneHeight: number
    seriesRef: Candle[]
    seriesCount: number
    effectiveCount: number
    lastHigh: number
    lastLow: number
    lastClose: number
    indicatorsRef: IndicatorRenderData[]
    comparesRef: { id: string; label: string; color: string; byTime: Map<number, number> }[]
    projLinesRef: ProjectionLine[]
    projBandRef: ProjectionBand | null
    type: ChartType
    mode: 'auto' | 'manual'
    manualMin: number
    manualMax: number
    log: boolean
    invert: boolean
    volumeOverlay: boolean
  } | null = null

  function targetMainScale(pane: PaneLayout): PriceScale {
    const n = renderSeries.length
    const last = n > 0 ? renderSeries[n - 1] : null
    const c = targetScaleCache
    const manualMin = manualScale !== null ? manualScale.min : NaN
    const manualMax = manualScale !== null ? manualScale.max : NaN
    if (
      c !== null &&
      c.viewStart === ts.view.start &&
      c.viewEnd === ts.view.end &&
      c.width === size.width &&
      c.height === size.height &&
      c.paneTop === pane.top &&
      c.paneHeight === pane.height &&
      c.seriesRef === renderSeries &&
      c.seriesCount === n &&
      c.effectiveCount === effectiveLength() &&
      c.indicatorsRef === indicators &&
      c.comparesRef === compares &&
      c.projLinesRef === projLines &&
      c.projBandRef === projBand &&
      c.type === chartType &&
      c.mode === priceScaleMode &&
      c.manualMin === manualMin &&
      c.manualMax === manualMax &&
      c.log === priceScaleLog &&
      c.invert === priceInvert &&
      c.volumeOverlay === appearance.volumeOverlay &&
      (last === null || (c.lastHigh === last.high && c.lastLow === last.low && c.lastClose === last.close))
    ) {
      return c.scale
    }
    const scale = computeTargetMainScale(pane)
    targetScaleCache = {
      scale,
      viewStart: ts.view.start,
      viewEnd: ts.view.end,
      width: size.width,
      height: size.height,
      paneTop: pane.top,
      paneHeight: pane.height,
      seriesRef: renderSeries,
      seriesCount: n,
      effectiveCount: effectiveLength(),
      lastHigh: last !== null ? last.high : NaN,
      lastLow: last !== null ? last.low : NaN,
      lastClose: last !== null ? last.close : NaN,
      indicatorsRef: indicators,
      comparesRef: compares,
      projLinesRef: projLines,
      projBandRef: projBand,
      type: chartType,
      mode: priceScaleMode,
      manualMin,
      manualMax,
      log: priceScaleLog,
      invert: priceInvert,
      volumeOverlay: appearance.volumeOverlay,
    }
    return scale
  }

  /** First bar in [from, to] where both series have a close: the re-basing anchor for a compare line. */
  function compareBase(cmp: (typeof compares)[number], from: number, to: number): { main: number; cmp: number } | null {
    for (let i = from; i <= to; i++) {
      const v = cmp.byTime.get(renderSeries[i].time)
      if (v != null && v !== 0 && renderSeries[i].close) return { main: renderSeries[i].close, cmp: v }
    }
    return null
  }

  /**
   * The main scale as drawn: in auto mode with smooth motion on, the eased
   * `shownRange` (advanced once per frame in render) instead of the raw target,
   * so hit-tests and converters agree with what is on screen.
   */
  function computeMainScale(pane: PaneLayout): PriceScale {
    const target = targetMainScale(pane)
    if (!appearance.smooth || priceScaleMode === 'manual' || shownRange === null || shownRange.log !== target.log) return target
    return new PriceScale(pane.top, pane.height, shownRange.min, shownRange.max, target.log, priceInvert)
  }

  /** Ease shownRange toward the target fit; returns true while still moving. */
  function stepScaleAnimation(pane: PaneLayout, dt: number): boolean {
    if (!appearance.smooth || priceScaleMode === 'manual') {
      shownRange = null
      return false
    }
    const t = targetMainScale(pane)
    const span = t.max - t.min
    const cur = shownRange
    // First frame, a mode flip, or a jump to an unrelated range (new symbol): snap.
    if (cur === null || cur.log !== t.log || cur.max < t.min || cur.min > t.max || cur.max - cur.min > span * 4 || span > (cur.max - cur.min) * 4) {
      shownRange = { min: t.min, max: t.max, log: t.log }
      scaleAnimGen++
      return false
    }
    const k = 1 - Math.exp(-dt / 70)
    const nmin = cur.min + (t.min - cur.min) * k
    const nmax = cur.max + (t.max - cur.max) * k
    const eps = span * 0.0005
    if (Math.abs(nmin - t.min) < eps && Math.abs(nmax - t.max) < eps) {
      if (cur.min !== t.min || cur.max !== t.max) scaleAnimGen++
      shownRange = { min: t.min, max: t.max, log: t.log }
      return false
    }
    shownRange = { min: nmin, max: nmax, log: t.log }
    scaleAnimGen++
    return true
  }

  const paneScaleCache = new Map<IndicatorRenderData, {
    scale: PriceScale
    viewStart: number
    viewEnd: number
    effectiveCount: number
    top: number
    height: number
  }>()

  /** Scale for an indicator sub-pane: fixed range if declared, else auto-fit. */
  function computePaneScale(pane: PaneLayout): PriceScale {
    const ind = pane.indicator as IndicatorRenderData
    const range = ts.visibleRange()
    const from = range.from
    // Replay clips data at the cursor: the pane auto-fit must ignore indicator
    // values past it so the sub-pane scale matches the clipped plot.
    const to = Math.min(range.to, effectiveLength() - 1)
    const cached = paneScaleCache.get(ind)
    if (
      cached !== undefined &&
      cached.viewStart === ts.view.start &&
      cached.viewEnd === ts.view.end &&
      cached.effectiveCount === effectiveLength() &&
      cached.top === pane.top &&
      cached.height === pane.height
    ) {
      return cached.scale
    }
    if (ind.range) {
      const scale = new PriceScale(pane.top, pane.height, ind.range[0], ind.range[1])
      paneScaleCache.set(ind, { scale, viewStart: ts.view.start, viewEnd: ts.view.end, effectiveCount: effectiveLength(), top: pane.top, height: pane.height })
      return scale
    }
    let min = Infinity
    let max = -Infinity
    let hasHistogram = false
    for (const out of ind.outputs) {
      if ((out.style ?? 'line') === 'histogram') hasHistogram = true
      const values = indicatorRanges.range(out, from, to)
      if (!values) continue
      if (values.min < min) min = values.min
      if (values.max > max) max = values.max
    }
    if (hasHistogram) {
      // Histograms grow from zero; keep the baseline inside the pane.
      if (min > 0) min = 0
      if (max < 0) max = 0
    }
    if (!isFinite(min) || !isFinite(max)) {
      min = 0
      max = 1
    }
    if (min === max) {
      const p = Math.abs(min) * 0.01 || 1
      min -= p
      max += p
    }
    const pad = (max - min) * 0.08
    const scale = new PriceScale(pane.top, pane.height, min - pad, max + pad)
    paneScaleCache.set(ind, { scale, viewStart: ts.view.start, viewEnd: ts.view.end, effectiveCount: effectiveLength(), top: pane.top, height: pane.height })
    return scale
  }

  /** Converters for the main pane (the contract object handed to the drawings module). */
  function makeConverters(mainScale: PriceScale): Converters {
    return {
      timeToX: (time) => ts.timeToX(time),
      xToTime: (x) => ts.xToTime(x),
      priceToY: (price) => mainScale.priceToY(price),
      yToPrice: (y) => mainScale.yToPrice(y),
    }
  }

  /**
   * Memo for the main-pane scale behind getMainConverters. computeMainScale is
   * O(visible bars) and overlay consumers (e.g. the Oracle storm) call
   * priceToY/yToPrice thousands of times per frame, so we recompute only when
   * an input actually changed. The cache is keyed by VALUE on every input of
   * computeMainScale (viewport, size, render-series identity/length + last OHLC,
   * indicators/projections refs, chart type), so pan/zoom, resize, setData,
   * updateLast, setIndicators, setProjections and setChartType all miss it
   * naturally — no explicit invalidation hooks, hence no staleness pitfalls.
   * `renderSeries` gets a fresh array reference on every rebuildSeries(), so it
   * is a complete change signal for both 1:1 and re-binned chart types.
   */
  let liveScaleCache: {
    scale: PriceScale
    viewStart: number
    viewEnd: number
    width: number
    height: number
    seriesRef: Candle[]
    seriesCount: number
    effectiveCount: number
    lastHigh: number
    lastLow: number
    lastClose: number
    indicatorsRef: IndicatorRenderData[]
    comparesRef: { id: string; label: string; color: string; byTime: Map<number, number> }[]
    projLinesRef: ProjectionLine[]
    projBandRef: ProjectionBand | null
    type: ChartType
    mode: 'auto' | 'manual'
    animGen: number
    invert: boolean
    manualMin: number
    manualMax: number
    log: boolean
    volumeOverlay: boolean
  } | null = null

  function liveMainScale(): PriceScale {
    const n = renderSeries.length
    const last = n > 0 ? renderSeries[n - 1] : null
    const c = liveScaleCache
    if (
      c !== null &&
      c.mode === priceScaleMode &&
      c.log === priceScaleLog &&
      c.animGen === scaleAnimGen &&
      c.invert === priceInvert &&
      c.manualMin === (manualScale !== null ? manualScale.min : NaN) &&
      c.manualMax === (manualScale !== null ? manualScale.max : NaN) &&
      c.viewStart === ts.view.start &&
      c.viewEnd === ts.view.end &&
      c.width === size.width &&
      c.height === size.height &&
      c.seriesRef === renderSeries &&
      c.seriesCount === n &&
      c.effectiveCount === effectiveLength() &&
      c.indicatorsRef === indicators &&
      c.comparesRef === compares &&
      c.projLinesRef === projLines &&
      c.projBandRef === projBand &&
      c.type === chartType &&
      c.volumeOverlay === appearance.volumeOverlay &&
      (last === null || (c.lastHigh === last.high && c.lastLow === last.low && c.lastClose === last.close))
    ) {
      return c.scale
    }
    // computeLayout() also refreshes ts.plotWidth, keeping timeToX consistent
    // even if no render pass has happened since the last size change.
    const scale = computeMainScale(computeLayout().panes[0])
    liveScaleCache = {
      scale,
      viewStart: ts.view.start,
      viewEnd: ts.view.end,
      width: size.width,
      height: size.height,
      seriesRef: renderSeries,
      seriesCount: n,
      effectiveCount: effectiveLength(),
      lastHigh: last !== null ? last.high : NaN,
      lastLow: last !== null ? last.low : NaN,
      lastClose: last !== null ? last.close : NaN,
      indicatorsRef: indicators,
      comparesRef: compares,
      projLinesRef: projLines,
      projBandRef: projBand,
      type: chartType,
      mode: priceScaleMode,
      log: priceScaleLog,
      animGen: scaleAnimGen,
      invert: priceInvert,
      manualMin: manualScale !== null ? manualScale.min : NaN,
      manualMax: manualScale !== null ? manualScale.max : NaN,
      volumeOverlay: appearance.volumeOverlay,
    }
    return scale
  }

  /**
   * Stable wrapper handed out by getMainConverters: every method reads the
   * engine's CURRENT scales at call time (never a snapshot), so results track
   * pan/zoom/resize/data updates automatically. Same math as makeConverters.
   */
  const liveConverters: Converters = {
    timeToX: (time) => ts.timeToX(time),
    xToTime: (x) => ts.xToTime(x),
    priceToY: (price) => liveMainScale().priceToY(price),
    yToPrice: (y) => liveMainScale().yToPrice(y),
  }

  /** Median candle spacing in ms; cached (recomputed on setData). */
  function computeBarMs(): void {
    const n = candles.length
    if (n < 2) {
      barMs = ts.intervalMs || 60_000
      return
    }
    const deltas: number[] = []
    for (let i = 1; i < n; i++) {
      const d = candles[i].time - candles[i - 1].time
      if (d > 0) deltas.push(d)
    }
    if (deltas.length === 0) {
      barMs = ts.intervalMs || 60_000
      return
    }
    deltas.sort((a, b) => a - b)
    barMs = deltas[deltas.length >> 1]
  }

  /**
   * Recompute `renderSeries` / `kagiPoints` for the active chart type and point
   * `ts` at the series' times. O(n) — safe to call on every setData/updateLast/
   * setChartType. For 1:1 types the result mirrors `candles` (heikin remaps
   * OHLC but keeps the same times), preserving the original index↔candle axis.
   * For re-binned types it builds the synthetic array and rebuilds the time
   * axis from the synthetic elements' (approximate) source times.
   */
  function rebuildSeries(): void {
    // PnF box size only carries meaning for the 'pnf' type; reset it for the
    // rest so a switch away from PnF doesn't leave a stale value behind.
    pnfBoxSize = 0
    switch (chartType) {
      case 'heikin':
        renderSeries = toHeikinAshi(candles)
        kagiPoints = null
        rebinSession = null
        break
      case 'renko': {
        // Box size is fixed for the life of this session (frozen here, not
        // re-derived every tick) — see chartTransforms.ts's file doc: this is
        // what makes live ticks incremental, and matches how Renko/Range/PnF
        // brick sizing behaves on other charting platforms (stable per
        // session, not jittering with every intra-bar price update).
        activeRenkoBox = renkoBoxOverride ?? autoRenkoBoxSize(candles)
        const session = createRebinSession(renkoBuilder(activeRenkoBox), candles)
        rebinSession = session
        renderSeries = session.output
        kagiPoints = null
        break
      }
      case 'linebreak': {
        const session = createRebinSession(lineBreakBuilder(3), candles)
        rebinSession = session
        renderSeries = session.output
        kagiPoints = null
        break
      }
      case 'pnf': {
        const box = autoPnfBoxSize(candles)
        pnfBoxSize = box
        const session = createRebinSession(pnfBuilder(box, 3), candles)
        rebinSession = session
        renderSeries = session.output
        kagiPoints = null
        break
      }
      case 'range': {
        const session = createRebinSession(rangeBarsBuilder(autoRangeSize(candles)), candles)
        rebinSession = session
        renderSeries = session.output
        kagiPoints = null
        break
      }
      case 'kagi': {
        const session = createRebinSession(kagiBuilder(0.04), candles)
        rebinSession = session
        const pts = session.output as unknown as KagiPoint[]
        kagiPoints = pts
        // A 1-element synthetic candle array per Kagi vertex anchors the index
        // axis (close = vertex price) so the price scale auto-fits the line and
        // the crosshair/last-price work the same as the block series.
        renderSeries = pts.map((p) => ({
          time: p.time,
          open: p.price,
          high: p.price,
          low: p.price,
          close: p.price,
          volume: 0,
        }))
        break
      }
      default:
        // 1:1 with the loaded candles (candles/hollow/bars/hlcbars/line/
        // linemarkers/step/area/baseline/columns/highlow).
        renderSeries = candles
        kagiPoints = null
        rebinSession = null
        break
    }
    ts.setTimes(renderSeries.map((c) => c.time))
  }

  /**
   * Live-tick counterpart to rebuildSeries(): extends renderSeries by/at the
   * tail using the cached rebinSession (or, for Heikin-Ashi, the previous
   * bar's already-computed open/close) instead of re-transforming the whole
   * `candles` array. Returns false when there's nothing to extend (chart type
   * just switched, first load) — the caller must fall back to rebuildSeries().
   */
  function extendSeries(candle: Candle, isNewBar: boolean): boolean {
    switch (chartType) {
      case 'heikin': {
        const n = renderSeries.length
        if (n === 0) return false
        if (isNewBar) {
          const prev = renderSeries[n - 1]
          renderSeries.push(haStep(prev.open, prev.close, candle, false))
        } else {
          const prev = n >= 2 ? renderSeries[n - 2] : null
          renderSeries[n - 1] = prev ? haStep(prev.open, prev.close, candle, false) : haStep(0, 0, candle, true)
        }
        return true
      }
      case 'renko':
      case 'linebreak':
      case 'pnf':
      case 'range': {
        if (!rebinSession) return false
        stepRebinSession(rebinSession, candle, isNewBar)
        renderSeries = rebinSession.output
        return true
      }
      case 'kagi': {
        if (!rebinSession) return false
        const ptsBefore = (rebinSession.output as unknown as KagiPoint[]).length
        stepRebinSession(rebinSession, candle, isNewBar)
        const pts = rebinSession.output as unknown as KagiPoint[]
        kagiPoints = pts
        const n = renderSeries.length
        if (pts.length === ptsBefore && n > 0) {
          const p = pts[pts.length - 1]
          renderSeries[n - 1] = { time: p.time, open: p.price, high: p.price, low: p.price, close: p.price, volume: 0 }
        } else if (pts.length === ptsBefore + 1) {
          const p = pts[pts.length - 1]
          renderSeries.push({ time: p.time, open: p.price, high: p.price, low: p.price, close: p.price, volume: 0 })
        } else {
          // A single-candle step should only leave the vertex count unchanged
          // or +1 — anything else is unexpected; resync fully to stay correct.
          renderSeries = pts.map((pp) => ({ time: pp.time, open: pp.price, high: pp.price, low: pp.price, close: pp.price, volume: 0 }))
        }
        return true
      }
      default:
        // 1:1 pass-through types: renderSeries === candles already (the
        // caller already mutated `candles` in place before calling this), so
        // there's nothing left to extend.
        return true
    }
  }

  /**
   * Reconciles `ts`'s time array with renderSeries after extendSeries(),
   * without rescanning the whole thing: appends any newly-added trailing
   * times (O(delta), not O(n)), or just re-syncs the last time in place when
   * the length didn't change. Falls back to a full setTimes() only in the
   * defensive case where renderSeries somehow shrank.
   */
  function syncTimesAfterExtend(oldLen: number): void {
    const newLen = renderSeries.length
    if (newLen === oldLen) {
      if (newLen > 0) ts.replaceLastTime(renderSeries[newLen - 1].time)
    } else if (newLen > oldLen) {
      for (let i = oldLen; i < newLen; i++) ts.appendTime(renderSeries[i].time)
    } else {
      ts.setTimes(renderSeries.map((c) => c.time))
    }
  }

  /**
   * Effective number of render-series bars that are VISIBLE as data. Normally
   * the whole series; during replay it's clipped to cursor+1 so bars after the
   * cursor are hidden ("future"). Every series-derived layer (drawn series,
   * volume, indicator plots/legend, last-price, auto-fit, crosshair) clamps its
   * upper bound to effectiveLength()-1. With replayCursor === null this is
   * exactly renderSeries.length, so non-replay rendering is byte-identical.
   */
  function effectiveLength(): number {
    const n = renderSeries.length
    if (replayCursor === null) return n
    return Math.min(replayCursor + 1, n)
  }

  /** Re-clamp the replay cursor into the current series bounds (after data changes). */
  function clampReplayCursor(): void {
    if (replayCursor === null) return
    const n = renderSeries.length
    if (n === 0) {
      replayCursor = null
      return
    }
    replayCursor = clamp(replayCursor, 0, n - 1)
  }

  /** One DrawEnv per render/interaction pass (fields are cheap references). */
  function makeEnv(): DrawEnv {
    return { candles, pricePrecision: precision, barMs }
  }

  /**
   * The active up/down colors: settings override the theme's when present.
   * (Used for candle bodies/wicks, bars, volume, the last-price tag, the
   * change-% legend coloring and alert lines.)
   */
  function upColor(colors: ChartColors): string {
    return settings ? settings.upColor : colors.up
  }
  function downColor(colors: ChartColors): string {
    return settings ? settings.downColor : colors.down
  }

  /**
   * Theme palette with the up/down/accent colors swapped to the settings'
   * up/down (line + area series draw with `accent`, which the contract maps to
   * the up color). Background/text/grid base colors stay theme-governed. Cheap
   * shallow spread; built once per render and passed to the series renderers.
   */
  function effectiveColors(colors: ChartColors): ChartColors {
    if (!settings) return colors
    return { ...colors, up: settings.upColor, down: settings.downColor, accent: settings.upColor }
  }

  function gridVisible(): boolean {
    return settings ? settings.gridVisible : true
  }
  function crosshairVisible(): boolean {
    return settings ? settings.crosshairVisible : true
  }

  /**
   * Candidate drawing point at (x, y). With magnet on, the PRICE snaps to the
   * nearest of {open,high,low,close} of the candle under the cursor's bar when
   * that value is within MAGNET_SNAP_PX vertically. Time is never snapped.
   */
  function magnetSnap(x: number, y: number, conv: Converters): { time: number; price: number; snapped: boolean } {
    const time = conv.xToTime(x)
    const price = conv.yToPrice(y)
    if (!magnet || candles.length === 0) return { time, price, snapped: false }
    const idx = Math.floor(ts.xToIndex(x)) // bar i occupies [i, i+1)
    if (idx < 0 || idx >= candles.length) return { time, price, snapped: false }
    const c = candles[idx]
    let best = price
    let bestDy = Infinity
    for (const v of [c.open, c.high, c.low, c.close]) {
      const dy = Math.abs(conv.priceToY(v) - y)
      if (dy < bestDy) {
        bestDy = dy
        best = v
      }
    }
    if (bestDy <= MAGNET_SNAP_PX) return { time, price: best, snapped: true }
    return { time, price, snapped: false }
  }

  // ----- view manipulation ---------------------------------------------------
  // View-bound math uses effectiveLength(), not ts.count: during replay the
  // bars past the cursor are hidden, so zoom-out limits and edge clamps must
  // treat the revealed prefix as the whole dataset or the viewport can end up
  // on (mostly) blank "future" space. Outside replay the two are identical.
  function maxVisibleBars(): number {
    return Math.max(60, Math.round(effectiveLength() * 1.2) + RIGHT_OFFSET_BARS * 2)
  }

  /** Keep at least a couple of bars on screen so the user can't get lost. */
  function clampView(): void {
    const n = effectiveLength()
    if (n === 0) return
    let { start, end } = ts.view
    const range = end - start
    const minEnd = Math.min(n, 2)
    if (end < minEnd) {
      end = minEnd
      start = end - range
    }
    const maxStart = n - 2
    if (start > maxStart) {
      start = maxStart
      end = start + range
    }
    ts.view = { start, end }
  }

  /**
   * Right-edge margin (blank bars) used when pinning the replay cursor. The
   * full RIGHT_OFFSET_BARS on normal zooms, but proportional on tight zooms:
   * with a fixed 5-bar margin and a view narrower than ~7 bars, the pinned
   * viewport would contain only hidden-future bars and the chart would render
   * blank on every playback tick.
   */
  function replayPinMargin(width: number): number {
    return Math.min(RIGHT_OFFSET_BARS, Math.max(0, Math.floor(width / 3)))
  }

  /**
   * After a wheel/pinch zoom while replay is PLAYING, shift the zoomed view
   * just enough to keep an on-screen playhead on screen (same inequalities as
   * the setReplayCursor pin). Without this, pointer-anchored zoom pushes the
   * cursor out of the followed zone, the next playback tick snaps the view
   * back, and the chart ping-pongs for the rest of the gesture. Paused replay
   * is left alone: no tick will snap, and zooming the playhead off screen to
   * inspect revealed history is legitimate.
   */
  function keepReplayCursorVisible(prev: ViewState): void {
    if (replayCursor === null || !replayPlaying) return
    const wasVisible =
      replayCursor >= prev.start && replayCursor <= prev.end - replayPinMargin(prev.end - prev.start)
    if (!wasVisible) return
    let { start, end } = ts.view
    const width = end - start
    const margin = replayPinMargin(width)
    if (replayCursor >= start && replayCursor <= end - margin) return
    if (replayCursor < start) {
      start = replayCursor // slipped off the left edge: hold it there
      end = start + width
    } else {
      end = replayCursor + 1 + margin // off the right: same pin as the tick
      start = end - width
    }
    ts.view = { start, end }
  }

  function checkHistory(): void {
    if (historyArmed && ts.count > 0 && ts.view.start <= HISTORY_TRIGGER_BARS) {
      historyArmed = false // re-armed by the next setData
      options.onRequestHistory?.()
    }
  }

  // ----- smooth motion ---------------------------------------------------------
  function stopMotion(): void {
    viewAnim = null
    momentum = null
  }

  /** `v` clamped the same way clampView clamps the live view. */
  function clampedView(v: ViewState): ViewState {
    const saved = ts.view
    ts.view = { start: v.start, end: v.end }
    clampView()
    const out = ts.view
    ts.view = saved
    return out
  }

  /** Move the view to `v`, eased when smooth motion is on. */
  function animateViewTo(v: ViewState): void {
    momentum = null
    if (!appearance.smooth) {
      viewAnim = null
      ts.view = { start: v.start, end: v.end }
      clampView()
      checkHistory()
      invalidate()
      return
    }
    viewAnim = clampedView(v)
    invalidate()
  }

  /** Advance eased zoom / scroll and fling momentum by `dt` ms; true while still moving. */
  function stepViewMotion(dt: number): boolean {
    let moving = false
    if (viewAnim) {
      const k = 1 - Math.exp(-dt / 55)
      const s = ts.view.start + (viewAnim.start - ts.view.start) * k
      const e = ts.view.end + (viewAnim.end - ts.view.end) * k
      if (Math.abs(viewAnim.start - s) < 0.01 && Math.abs(viewAnim.end - e) < 0.01) {
        ts.view = { start: viewAnim.start, end: viewAnim.end }
        viewAnim = null
      } else {
        ts.view = { start: s, end: e }
        moving = true
      }
      clampView()
      checkHistory()
    }
    if (momentum) {
      const before = ts.view.start
      const shift = momentum.v * dt
      ts.view = { start: ts.view.start + shift, end: ts.view.end + shift }
      clampView()
      checkHistory()
      momentum.v *= Math.pow(0.93, dt / 16)
      if (Math.abs(momentum.v) * ts.barSpacing() < 0.02 || ts.view.start === before) momentum = null
      else moving = true
    }
    return moving
  }

  function viewKey(): string {
    return `${ts.view.start.toFixed(3)}|${ts.view.end.toFixed(3)}`
  }

  function shiftView(deltaBars: number): void {
    ts.view = { start: ts.view.start + deltaBars, end: ts.view.end + deltaBars }
    clampView()
    checkHistory()
    invalidate()
  }

  function resetViewInternal(): void {
    userMovedView = false
    // A full view reset also drops any manual price scale back to auto-fit.
    // effectiveLength keeps the reset off the hidden future during replay.
    exitManualScale()
    const n = effectiveLength()
    if (n === 0) {
      ts.view = { start: -DEFAULT_VISIBLE_BARS / 2, end: DEFAULT_VISIBLE_BARS / 2 }
      return
    }
    const end = n + RIGHT_OFFSET_BARS
    const visible = Math.min(DEFAULT_VISIBLE_BARS, Math.max(MIN_VISIBLE_BARS, n) + RIGHT_OFFSET_BARS)
    ts.view = { start: end - visible, end }
  }

  // ----- manual price-scale helpers ------------------------------------------
  /** The current main-pane price scale (honors auto vs manual mode). */
  function currentMainScale(): PriceScale {
    return computeMainScale(computeLayout().panes[0])
  }

  /**
   * Switch the main pane to MANUAL price scale, seeding the fixed range from
   * whatever is on screen right now (the auto-fit range when coming from 'auto',
   * else the existing manual range). No-op-safe to call when already manual.
   */
  function enterManualScale(): void {
    const s = currentMainScale()
    manualScale = { min: s.min, max: s.max }
    priceScaleMode = 'manual'
  }

  /** Restore the main pane to AUTO price scale (re-fit to visible data). */
  function exitManualScale(): void {
    priceScaleMode = 'auto'
    manualScale = null
  }

  // ----- drawings helpers -----------------------------------------------------
  // Undo/redo: `committed` is the drawing list as of the last emit; every emit
  // pushes the previous list so it can be restored. Drawing objects are
  // replaced (never mutated) on edit, so shallow array copies are enough.
  let committed: Drawing[] = []
  let undoStack: Drawing[][] = []
  let redoStack: Drawing[][] = []

  function emitDrawings(): void {
    undoStack.push(committed)
    if (undoStack.length > MAX_UNDO) undoStack.shift()
    redoStack = []
    committed = drawings.slice()
    options.onDrawingsChange?.(drawings.slice())
    options.onHistoryChange?.()
  }

  /** Restore a list from the undo/redo stacks (without recording it as a new edit). */
  function restoreDrawings(from: Drawing[][], to: Drawing[][]): boolean {
    const prev = from.pop()
    if (!prev) return false
    to.push(committed)
    drawings = prev.slice()
    committed = prev.slice()
    if (selectedId && !drawings.some((d) => d.id === selectedId)) setSelection(null)
    options.onDrawingsChange?.(drawings.slice())
    options.onHistoryChange?.()
    invalidate()
    return true
  }

  /** Delete the topmost drawing under (x, y) on the main pane; true when one was removed. */
  function eraseAt(x: number, y: number): boolean {
    const mainPane = computeLayout().panes[0]
    if (y < mainPane.top || y >= mainPane.top + mainPane.height) return false
    const conv = makeConverters(computeMainScale(mainPane))
    const env = makeEnv()
    for (let i = drawings.length - 1; i >= 0; i--) {
      if (isHiddenDrawing(drawings[i]) || isLockedDrawing(drawings[i])) continue
      if (hitTestDrawing(drawings[i], x, y, conv, env)) {
        const id = drawings[i].id
        drawings = drawings.filter((d) => d.id !== id)
        if (selectedId === id) setSelection(null)
        emitDrawings()
        invalidate()
        return true
      }
    }
    return false
  }

  function replaceDrawing(id: string, updated: Drawing): void {
    const idx = drawings.findIndex((d) => d.id === id)
    if (idx >= 0) drawings[idx] = updated
  }

  /** Change the selection, firing onSelectionChange only when the id actually changes. */
  function setSelection(id: string | null): void {
    if (selectedId === id) return
    selectedId = id
    const d = id !== null ? (drawings.find((x) => x.id === id) ?? null) : null
    options.onSelectionChange?.(d)
  }

  /** Re-announce the selected drawing (post-drag: same object reference onDrawingsChange sees). */
  function emitSelectionCurrent(): void {
    const d = selectedId !== null ? (drawings.find((x) => x.id === selectedId) ?? null) : null
    options.onSelectionChange?.(d)
  }

  function cancelTool(): void {
    pendingPoints = []
    if (activeTool !== null) {
      activeTool = null
      options.onActiveToolChange?.(null)
    }
    invalidate()
  }

  /** Shared post-placement flow: add, auto-select, disarm, notify host. */
  function commitDrawing(d: Drawing): void {
    drawings.push(d)
    pendingPoints = []
    emitDrawings()
    // "Stay in drawing mode": keep the tool armed for the next placement.
    if (stayInDrawing) {
      invalidate()
      return
    }
    selectedId = d.id
    activeTool = null
    options.onActiveToolChange?.(null)
    options.onSelectionChange?.(d)
  }

  /** One placement click of an armed n-point tool (n >= 1; freehand is drag-driven). */
  function placeToolPoint(x: number, y: number, layout: Layout): void {
    const tool = activeTool
    if (!tool) return
    const need = pointsNeeded(tool)
    if (need < 1) return
    const scale = computeMainScale(layout.panes[0])
    const conv = makeConverters(scale)
    const snap = magnetSnap(x, y, conv)
    pendingPoints.push({ time: snap.time, price: snap.price })
    if (pendingPoints.length >= need) {
      const env = makeEnv()
      let drawing = defaultDrawing(tool, pendingPoints[0])
      drawing.points = pendingPoints.slice(0, need)
      const impl = toolImpl(tool)
      if (impl.expandOnCommit) drawing = impl.expandOnCommit(drawing, env)
      commitDrawing(drawing)
    }
    invalidate()
  }

  /** Start freehand (brush) capture: the drawing grows on pointermove, commits on pointerup. */
  function startFreehand(x: number, y: number, layout: Layout): void {
    const tool = activeTool
    if (!tool) return
    const conv = makeConverters(computeMainScale(layout.panes[0]))
    const drawing = defaultDrawing(tool, { time: conv.xToTime(x), price: conv.yToPrice(y) })
    drag = { mode: 'freehand', drawing, lastPx: x, lastPy: y }
    invalidate()
  }

  /**
   * Live preview of the armed tool: placed points + the cursor as the
   * provisional next point. Tool impls tolerate partial point lists.
   */
  function buildPreview(conv: Converters, mainPane: PaneLayout): Drawing | null {
    const tool = activeTool
    if (!tool) return null
    const need = pointsNeeded(tool)
    if (need < 1) return null // freehand previews via the drag state instead
    const inMain =
      hover !== null &&
      hover.x >= 0 &&
      hover.x <= ts.plotWidth &&
      hover.y >= mainPane.top &&
      hover.y < mainPane.top + mainPane.height
    const pts = pendingPoints.slice()
    if (inMain && hover && pts.length < need) {
      const snap = magnetSnap(hover.x, hover.y, conv)
      pts.push({ time: snap.time, price: snap.price })
    }
    if (pts.length === 0) return null
    const preview = defaultDrawing(tool, pts[0])
    preview.id = '__preview__'
    preview.points = pts
    return preview
  }

  // ----- alert hit-testing ------------------------------------------------------
  /** The alert whose right-axis tag/bell is under (x, y), or null. */
  function alertTagAt(x: number, y: number): Alert | null {
    for (const r of alertTagRects) {
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
        return alerts.find((a) => a.id === r.id) ?? null
      }
    }
    return null
  }

  /**
   * The alert whose dashed line is within ALERT_HIT_PX of (x, y) inside the plot
   * area (not the axis). Returns the nearest match when several overlap.
   */
  function alertLineAt(x: number, y: number, layout: Layout, mainScale: PriceScale): Alert | null {
    if (x < 0 || x > layout.plotWidth) return null
    let best: Alert | null = null
    let bestDy = ALERT_HIT_PX + 1
    for (const a of alerts) {
      const ay = mainScale.priceToY(a.price)
      if (ay < mainScale.top || ay > mainScale.bottom) continue
      const dy = Math.abs(ay - y)
      if (dy <= ALERT_HIT_PX && dy < bestDy) {
        best = a
        bestDy = dy
      }
    }
    return best
  }

  // ----- price-axis region hit-testing ----------------------------------------
  /**
   * True when (x, y) is inside the MAIN pane's right price-axis strip
   * (x > plotWidth, within the main pane's vertical span). This is the band the
   * user drags to scale the price range / double-clicks to reset to auto.
   */
  function inMainAxisStrip(x: number, y: number, layout: Layout): boolean {
    const mainPane = layout.panes[0]
    return (
      x > layout.plotWidth &&
      x <= layout.width &&
      y >= mainPane.top &&
      y < mainPane.top + mainPane.height
    )
  }

  /** True when (x, y) is inside the "A" auto/manual toggle button drawn this frame. */
  function inAxisToggle(x: number, y: number): boolean {
    const r = axisToggleRect
    return r !== null && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
  }

  /** True when (x, y) is inside the "L" log-scale toggle button drawn this frame. */
  function inPctToggle(x: number, y: number): boolean {
    const r = pctToggleRect
    return r !== null && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
  }

  /** Bottom-right corner where the price axis meets the time axis (time-zone label). */
  function inCorner(x: number, y: number): boolean {
    const layout = computeLayout()
    return appearance.cornerLabel !== null && x > layout.plotWidth && y > layout.timeAxisTop
  }

  function inLogToggle(x: number, y: number): boolean {
    const r = logToggleRect
    return r !== null && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
  }

  // ----- interactions ----------------------------------------------------------
  /** The separate pane whose top line is under (x, y), for resizing. */
  function separatorAt(x: number, y: number, layout: Layout): PaneLayout | null {
    if (x < 0 || x > layout.plotWidth) return null
    for (let i = 1; i < layout.panes.length; i++) {
      const p = layout.panes[i]
      if (p.kind === 'indicator' && Math.abs(y - (p.top - SEPARATOR_H / 2)) <= SEPARATOR_GRAB) return p
    }
    return null
  }

  function updateCursor(x: number, y: number): void {
    if (drag) return
    const layout = computeLayout()
    if (!activeTool && !eraser && separatorAt(x, y, layout)) {
      canvas.style.cursor = 'row-resize'
      return
    }
    // Right price-axis affordances (no tool armed): the "A" toggle button and
    // the draggable scale strip. Checked before the plot test since both live
    // at x > plotWidth. Alert tags (also in this column) win via their own
    // hit-test below — but only inside the plot, so they never overlap here.
    if (!activeTool) {
      if (inAxisToggle(x, y) || inLogToggle(x, y) || inPctToggle(x, y) || inCorner(x, y)) {
        canvas.style.cursor = 'pointer'
        return
      }
      if (inMainAxisStrip(x, y, layout) && alertTagAt(x, y) === null) {
        canvas.style.cursor = 'ns-resize'
        return
      }
    }
    const inPlot = x >= 0 && x <= layout.plotWidth && y >= 0 && y < layout.timeAxisTop
    if (!inPlot) {
      canvas.style.cursor = 'default'
      return
    }
    if (activeTool || eraser) {
      canvas.style.cursor = 'crosshair'
      return
    }
    const mainPane = layout.panes[0]
    if (drawings.length > 0 && y >= mainPane.top && y < mainPane.top + mainPane.height) {
      const conv = makeConverters(computeMainScale(mainPane))
      const env = makeEnv()
      const sel = selectedId ? drawings.find((d) => d.id === selectedId) : undefined
      if (sel && hitTestHandle(sel, x, y, conv, env) >= 0) {
        canvas.style.cursor = 'pointer'
        return
      }
      for (let i = drawings.length - 1; i >= 0; i--) {
        if (isHiddenDrawing(drawings[i])) continue
        if (hitTestDrawing(drawings[i], x, y, conv, env)) {
          canvas.style.cursor = isLockedDrawing(drawings[i]) ? 'default' : 'pointer'
          return
        }
      }
    }
    // Alerts (only when no drawing/handle is under the cursor — checked above).
    if (alerts.length > 0) {
      if (alertTagAt(x, y) !== null) {
        canvas.style.cursor = 'pointer' // bell/tag removes on click
        return
      }
      const mainScale = computeMainScale(mainPane)
      if (alertLineAt(x, y, layout, mainScale) !== null) {
        canvas.style.cursor = 'grab' // line drags vertically
        return
      }
    }
    canvas.style.cursor = 'crosshair'
  }

  function handlePointerDown(x: number, y: number, ev: MouseEvent): void {
    if (ev.button !== 0) return
    stopMotion()
    const layout = computeLayout()
    const mainPane = layout.panes[0]
    const inMain =
      x >= 0 && x <= layout.plotWidth && y >= mainPane.top && y < mainPane.top + mainPane.height

    if (activeTool) {
      // While a tool is armed, drags never pan the chart. Alerts + axis are inert.
      if (inMain) {
        if (pointsNeeded(activeTool) === -1) startFreehand(x, y, layout)
        else placeToolPoint(x, y, layout)
      }
      return
    }

    // The line above a separate pane: drag to resize that pane.
    const sep = separatorAt(x, y, layout)
    if (sep && sep.indicator) {
      drag = { mode: 'resize-pane', id: sep.indicator.instanceId, startY: y, startH: sep.height }
      canvas.style.cursor = 'row-resize'
      return
    }

    // Eraser: press (and drag) over drawings to delete them; never pans.
    if (eraser && inMain) {
      eraseAt(x, y)
      drag = { mode: 'erase' }
      return
    }

    // Price-axis "A" toggle button: flip auto<->manual. Checked before the axis
    // strip so a click on the button toggles rather than starting a scale drag.
    if (inAxisToggle(x, y)) {
      if (priceScaleMode === 'manual') exitManualScale()
      else enterManualScale() // seeds the manual range from the current visible min/max
      invalidate()
      return
    }

    // Price-axis "%" toggle: percent labels on/off (host-owned when it listens).
    if (inPctToggle(x, y)) {
      const next: PriceDisplayMode = displayMode === 'percent' ? 'price' : 'percent'
      if (options.onPercentToggle) options.onPercentToggle(next)
      else {
        displayMode = next
        shownRange = null
      }
      invalidate()
      return
    }

    // Axis corner (time-zone label): the host opens its time-zone menu.
    if (inCorner(x, y)) {
      const rect = canvas.getBoundingClientRect()
      options.onTimeZoneCornerClick?.(rect.left + x, rect.top + y)
      return
    }

    // Price-axis "L" toggle: flip linear<->log. The cache keys on priceScaleLog,
    // so the next scale read recomputes under the new mode.
    if (inLogToggle(x, y)) {
      priceScaleLog = !priceScaleLog
      invalidate()
      return
    }

    // Right price-axis strip: drag vertically to SCALE the price range about the
    // price under the cursor. This switches the main scale to 'manual'. Alert
    // price tags also live in this column; defer to them (matching updateCursor)
    // so clicking a tag removes its alert instead of starting a scale drag.
    if (inMainAxisStrip(x, y, layout) && alertTagAt(x, y) === null) {
      const s = computeMainScale(mainPane)
      const anchorPrice = s.yToPrice(clamp(y, s.top, s.bottom))
      drag = { mode: 'scale-axis', startMin: s.min, startMax: s.max, anchorPrice, startY: y }
      // The gesture always ends in manual mode; seed it now so the first move
      // (and the toggle button's state) reflect the manual range immediately.
      manualScale = { min: s.min, max: s.max }
      priceScaleMode = 'manual'
      canvas.style.cursor = 'ns-resize'
      invalidate()
      return
    }

    // Alert affordance: clicking the bell/price tag removes the alert. Checked
    // before drawings since the tag sits in the right-axis column (x > plotWidth)
    // where no drawing can be hit.
    if (alerts.length > 0) {
      const tagAlert = alertTagAt(x, y)
      if (tagAlert) {
        options.onAlertRemove?.(tagAlert.id)
        return
      }
    }

    let lockedHit = false
    if (inMain && drawings.length > 0) {
      const conv = makeConverters(computeMainScale(mainPane))
      const env = makeEnv()
      const sel = selectedId ? drawings.find((d) => d.id === selectedId) : undefined
      if (sel && !isHiddenDrawing(sel) && !isLockedDrawing(sel)) {
        const handleIndex = hitTestHandle(sel, x, y, conv, env)
        if (handleIndex >= 0) {
          drag = { mode: 'move-handle', id: sel.id, original: sel, handleIndex, moved: false }
          invalidate()
          return
        }
      }
      for (let i = drawings.length - 1; i >= 0; i--) {
        const d = drawings[i]
        if (isHiddenDrawing(d)) continue
        if (hitTestDrawing(d, x, y, conv, env)) {
          setSelection(d.id)
          // Locked: selectable (for its style toolbar) but never moved — the press pans.
          if (isLockedDrawing(d)) {
            lockedHit = true
            invalidate()
            break
          }
          drag = {
            mode: 'move-drawing',
            id: d.id,
            original: d,
            startTime: conv.xToTime(x),
            startPrice: conv.yToPrice(y),
            moved: false,
          }
          invalidate()
          return
        }
      }
    }

    // Alert line: pressing within ALERT_HIT_PX (and not on a drawing/handle,
    // checked above) starts a vertical drag to move the alert. Never deselects
    // a drawing, and takes priority over panning.
    if (inMain && alerts.length > 0) {
      const mainScale = computeMainScale(mainPane)
      const lineAlert = alertLineAt(x, y, layout, mainScale)
      if (lineAlert) {
        drag = { mode: 'move-alert', id: lineAlert.id, price: lineAlert.price, moved: false }
        canvas.style.cursor = 'grabbing'
        invalidate()
        return
      }
    }

    // Empty click in the main pane deselects the current drawing.
    if (inMain && drawings.length > 0 && selectedId && !lockedHit) {
      setSelection(null)
      invalidate()
    }

    drag = { mode: 'pan', lastX: x, lastY: y }
    panSamples = [{ t: performance.now(), start: ts.view.start }]
    canvas.style.cursor = 'grabbing'
  }

  function handlePointerMove(x: number, y: number, _ev: MouseEvent): void {
    hover = { x, y }
    if (drag) {
      if (drag.mode === 'erase') {
        eraseAt(x, y)
      } else if (drag.mode === 'pan') {
        const spacing = ts.barSpacing()
        if (spacing > 0) {
          const dBars = (x - drag.lastX) / spacing
          drag.lastX = x
          if (dBars !== 0) {
            shiftView(-dBars)
            userMovedView = true
          }
          const now = performance.now()
          panSamples.push({ t: now, start: ts.view.start })
          while (panSamples.length > 2 && now - panSamples[0].t > 100) panSamples.shift()
        }
        // Manual mode: body-drag is 2D — also pan the price range vertically by
        // the drag's price delta. (Auto mode leaves the vertical to auto-fit.)
        if (priceScaleMode === 'manual' && manualScale !== null) {
          const dyPx = y - drag.lastY
          if (dyPx !== 0) {
            const mainPane = computeLayout().panes[0]
            const span = manualScale.max - manualScale.min
            // Convert pixel travel to a price delta; dragging DOWN moves the
            // viewport down (prices shift up), matching a grab-and-drag feel.
            const dPrice = (dyPx / Math.max(1, mainPane.height)) * span
            manualScale = { min: manualScale.min + dPrice, max: manualScale.max + dPrice }
          }
        }
        drag.lastY = y
      } else if (drag.mode === 'resize-pane') {
        // dragging the line up makes the pane below it taller; the main pane gives / takes the room
        const layout = computeLayout()
        const id = drag.id
        const others = layout.panes.slice(1).filter((p) => p.indicator && p.indicator.instanceId !== id).reduce((a, p) => a + p.height + SEPARATOR_H, 0)
        const maxH = Math.max(SUB_PANE_MIN_H, layout.timeAxisTop - MAIN_MIN_H - others - SEPARATOR_H)
        paneHeights = { ...paneHeights, [id]: clamp(drag.startH - (y - drag.startY), SUB_PANE_MIN_H, maxH) }
        invalidate()
      } else if (drag.mode === 'scale-axis') {
        // Dragging the price axis scales the range about the anchor price. Up =
        // smaller range (zoom in), down = larger range (zoom out), exponential
        // in the pixel delta. startMin/startMax keep the gesture stable.
        const dyPx = y - drag.startY
        const factor = Math.exp(dyPx / AXIS_SCALE_PX)
        const newMin = drag.anchorPrice - (drag.anchorPrice - drag.startMin) * factor
        const newMax = drag.anchorPrice + (drag.startMax - drag.anchorPrice) * factor
        // Guard against a degenerate / inverted range from extreme drags.
        if (newMax - newMin > 1e-12 && isFinite(newMin) && isFinite(newMax)) {
          manualScale = { min: newMin, max: newMax }
        }
      } else {
        const layout = computeLayout()
        const mainScale = computeMainScale(layout.panes[0])
        const conv = makeConverters(mainScale)
        if (drag.mode === 'freehand') {
          // Thin to >= FREEHAND_MIN_DIST_PX of screen travel, cap the point count.
          const dx = x - drag.lastPx
          const dy = y - drag.lastPy
          if (
            drag.drawing.points.length < FREEHAND_MAX_POINTS &&
            dx * dx + dy * dy >= FREEHAND_MIN_DIST_PX * FREEHAND_MIN_DIST_PX
          ) {
            drag.drawing.points.push({ time: conv.xToTime(x), price: conv.yToPrice(y) })
            drag.lastPx = x
            drag.lastPy = y
          }
        } else if (drag.mode === 'move-drawing') {
          // Whole-drawing translate never magnet-snaps.
          const t = conv.xToTime(x)
          const p = conv.yToPrice(y)
          replaceDrawing(drag.id, translateDrawing(drag.original, t - drag.startTime, p - drag.startPrice))
          drag.moved = true
        } else if (drag.mode === 'move-alert') {
          // Vertical drag: track the cursor's price (clamped to the main pane).
          // drawAlerts renders the grabbed line here; committed on pointerup.
          const cy = clamp(y, mainScale.top, mainScale.bottom)
          drag.price = mainScale.yToPrice(cy)
          drag.moved = true
          canvas.style.cursor = 'grabbing'
        } else {
          const snap = magnetSnap(x, y, conv)
          replaceDrawing(
            drag.id,
            movePoint(drag.original, drag.handleIndex, { time: snap.time, price: snap.price }, makeEnv()),
          )
          drag.moved = true
        }
      }
    }
    // Cursor-affordance hit-testing happens once per frame in render() (see
    // its call to updateCursor(hover.x, hover.y)), not here — this handler
    // just records the latest pointer position and schedules a frame.
    invalidate()
  }

  function handlePointerUp(_x: number, _y: number, _ev: MouseEvent): void {
    if (drag) {
      if (drag.mode === 'freehand') {
        // A click without any drag travel leaves a single point — an invisible
        // sliver that could never be hit-tested again. Discard it and keep the
        // brush armed so the user can simply try again.
        if (drag.drawing.points.length >= 2) commitDrawing(drag.drawing)
      } else if (drag.mode === 'move-alert') {
        // Hand the new price to the host (which re-runs setAlerts). The local
        // preview already moved the line; a no-travel click is a no-op.
        if (drag.moved) options.onAlertMove?.(drag.id, drag.price)
      } else if (drag.mode === 'resize-pane') {
        options.onPaneHeightsChange?.({ ...paneHeights })
      } else if ((drag.mode === 'move-drawing' || drag.mode === 'move-handle') && drag.moved) {
        emitDrawings()
        emitSelectionCurrent() // same object reference that onDrawingsChange just saw
      }
      // A quick release after a drag keeps the chart gliding (momentum pan).
      if (drag.mode === 'pan' && appearance.smooth && panSamples.length >= 2) {
        const now = performance.now()
        const first = panSamples[0]
        const lastS = panSamples[panSamples.length - 1]
        const dt = now - first.t
        if (now - lastS.t < 50 && dt > 8) {
          const v = (ts.view.start - first.start) / dt
          if (Math.abs(v) * ts.barSpacing() > 0.25) {
            momentum = { v, t: now }
            invalidate()
          }
        }
      }
      // 'pan' and 'scale-axis' need no commit step — their effects (view / manual
      // scale) are applied live during the drag.
    }
    drag = null
    if (hover) updateCursor(hover.x, hover.y)
    invalidate()
  }

  function handlePointerLeave(): void {
    hover = null
    invalidate()
  }

  function handleWheel(x: number, _y: number, ev: WheelEvent): void {
    userMovedView = true
    const layout = computeLayout()
    if (layout.plotWidth <= 0) return
    // Trackpad 2-finger horizontal swipe (deltaX dominant, not a pinch) pans
    // through time instead of zooming. Pinch (ctrlKey) and vertical wheel zoom.
    if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) && !ev.ctrlKey) {
      const barsPerPx = ts.range / layout.plotWidth
      const shift = ev.deltaX * barsPerPx
      ts.view = { start: ts.view.start + shift, end: ts.view.end + shift }
      clampView()
      checkHistory()
      invalidate()
      return
    }
    momentum = null
    const factor = Math.exp(-ev.deltaY * 0.0012)
    // Smooth: zoom toward an accumulated target and let render() ease there.
    if (appearance.smooth && replayCursor === null) {
      const base = viewAnim ?? ts.view
      const r0 = base.end - base.start
      const r1 = clamp(r0 / factor, MIN_VISIBLE_BARS, maxVisibleBars())
      if (r1 === r0) return
      const ratio = clamp(x, 0, layout.plotWidth) / layout.plotWidth
      const anchor = base.start + ratio * r0
      const start = anchor - ratio * r1
      viewAnim = clampedView({ start, end: start + r1 })
      invalidate()
      return
    }
    const range = ts.range
    const newRange = clamp(range / factor, MIN_VISIBLE_BARS, maxVisibleBars())
    if (newRange === range) return
    const cx = clamp(x, 0, layout.plotWidth)
    const anchor = ts.xToIndex(cx) // bar index under the cursor stays put
    const ratio = cx / layout.plotWidth
    const start = anchor - ratio * newRange
    const prev = ts.view
    ts.view = { start, end: start + newRange }
    keepReplayCursorVisible(prev)
    clampView()
    checkHistory()
    invalidate()
  }

  /** Two-finger pinch: zoom the time range around centerX by `scale` (>1 = in). */
  function handlePinch(centerX: number, scale: number): void {
    userMovedView = true
    const layout = computeLayout()
    if (layout.plotWidth <= 0 || !(scale > 0)) return
    const range = ts.range
    const newRange = clamp(range / scale, MIN_VISIBLE_BARS, maxVisibleBars())
    if (newRange === range) return
    const cx = clamp(centerX, 0, layout.plotWidth)
    const anchor = ts.xToIndex(cx) // bar index under the pinch center stays put
    const ratio = cx / layout.plotWidth
    const start = anchor - ratio * newRange
    const prev = ts.view
    ts.view = { start, end: start + newRange }
    keepReplayCursorVisible(prev)
    clampView()
    checkHistory()
    invalidate()
  }

  function handleDoubleClick(x: number, y: number, _ev: MouseEvent): void {
    const layout = computeLayout()
    // Double-click on the price axis (strip or the "A" toggle) resets ONLY the
    // main price scale to auto-fit — the time view is left as-is. Double-click
    // on the chart body still resets the whole view (which also drops to auto).
    if (!activeTool && (inAxisToggle(x, y) || inMainAxisStrip(x, y, layout))) {
      exitManualScale()
      invalidate()
      return
    }
    resetViewInternal()
    invalidate()
  }

  /**
   * Right-click: suppress the native menu and hand the host the cursor's
   * (x, y) in container CSS px plus the main-pane price/time under it (for an
   * "add alert here" action). No-op without an onContextMenu handler — still
   * preventDefault so a stale browser menu never shows over the chart.
   */
  function handleContextMenu(x: number, y: number, ev: MouseEvent): void {
    ev.preventDefault()
    if (!options.onContextMenu) return
    const layout = computeLayout()
    const mainScale = computeMainScale(layout.panes[0])
    const price = mainScale.yToPrice(y)
    const time = ts.xToTime(x)
    options.onContextMenu({ x, y, price, time })
  }

  function handleKeyDown(ev: KeyboardEvent): void {
    if (isEditableTarget(ev.target)) return
    if (ev.key === 'Escape') {
      if (drag !== null && drag.mode === 'freehand') {
        drag = null // discard the partial freehand capture
        cancelTool()
      } else if (activeTool !== null || pendingPoints.length > 0) {
        cancelTool() // discard partial placement
      } else if (selectedId) {
        setSelection(null)
        invalidate()
      }
    } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedId && !drawings.some((d) => d.id === selectedId && isLockedDrawing(d))) {
      drawings = drawings.filter((d) => d.id !== selectedId)
      setSelection(null)
      emitDrawings()
      invalidate()
      ev.preventDefault()
    }
  }

  const disposeInteractions = attachInteractions(canvas, {
    pointerDown: handlePointerDown,
    pointerMove: handlePointerMove,
    pointerUp: handlePointerUp,
    pointerLeave: handlePointerLeave,
    wheel: handleWheel,
    pinch: handlePinch,
    doubleClick: handleDoubleClick,
    contextMenu: handleContextMenu,
    keyDown: handleKeyDown,
  })

  const resizeObserver = new ResizeObserver(() => {
    applySize()
    invalidate()
  })
  resizeObserver.observe(container)

  // ----- formatting helpers ------------------------------------------------
  function formatIndicatorValue(v: number): string {
    const decimals = Math.abs(v) >= 1 ? 2 : 4
    return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  }

  function paneTickLabels(scale: PriceScale, ticks: number[]): { y: number; label: string }[] {
    const step = ticks.length >= 2 ? ticks[1] - ticks[0] : niceStep((scale.max - scale.min) / 8 || 1)
    const dec = decimalsForStep(step)
    return ticks.map((v) => ({
      y: Math.round(scale.priceToY(v)),
      label: v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }),
    }))
  }

  function formatPaneCrosshairValue(v: number, scale: PriceScale): string {
    const dec = decimalsForStep(niceStep((scale.max - scale.min) / 8 || 1))
    return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
  }

  // ----- rendering -----------------------------------------------------------
  function clipPane(pane: PaneLayout, layout: Layout): void {
    ctx.beginPath()
    ctx.rect(0, pane.top, layout.plotWidth, pane.height)
    ctx.clip()
  }

  function drawSeriesByType(scale: PriceScale, colors: ChartColors, from: number, to: number): void {
    // All series draw from `renderSeries` (heikin = remapped OHLC; renko/
    // linebreak = synthetic blocks; kagi via kagiPoints). For the original 4
    // types renderSeries === candles, so output is byte-for-byte unchanged.
    const s = renderSeries
    switch (chartType) {
      case 'candles':
        R.drawCandles(ctx, s, from, to, ts, scale, colors, candleParts())
        break
      case 'volcandles':
        R.drawVolumeCandles(ctx, s, from, to, ts, scale, colors)
        break
      case 'hlcarea':
        R.drawHlcAreaSeries(ctx, s, from, to, ts, scale, colors)
        break
      case 'hollow':
        R.drawHollowCandles(ctx, s, from, to, ts, scale, colors)
        break
      case 'heikin':
        R.drawCandles(ctx, s, from, to, ts, scale, colors, candleParts())
        break
      case 'bars':
        R.drawBars(ctx, s, from, to, ts, scale, colors)
        break
      case 'hlcbars':
        R.drawHlcBars(ctx, s, from, to, ts, scale, colors)
        break
      case 'line':
        R.drawLineSeries(ctx, s, from, to, ts, scale, colors)
        break
      case 'linemarkers':
        R.drawLineMarkers(ctx, s, from, to, ts, scale, colors)
        break
      case 'step':
        R.drawStepSeries(ctx, s, from, to, ts, scale, colors)
        break
      case 'area':
        R.drawAreaSeries(ctx, s, from, to, ts, scale, colors)
        break
      case 'baseline': {
        // Split at the first VISIBLE candle's close.
        const baseline = s[from].close
        R.drawBaselineSeries(ctx, s, from, to, ts, scale, colors, baseline)
        break
      }
      case 'columns':
        R.drawColumnsSeries(ctx, s, from, to, ts, scale, colors)
        break
      case 'highlow':
        R.drawHighLowSeries(ctx, s, from, to, ts, scale, colors)
        break
      case 'renko':
      case 'linebreak':
        R.drawBlockSeries(ctx, s, from, to, ts, scale, colors)
        break
      case 'range':
        // Range bars are full synthetic OHLC bars on the index axis.
        R.drawCandles(ctx, s, from, to, ts, scale, colors, candleParts())
        break
      case 'footprint':
        R.drawFootprintCandles(ctx, s, from, to, ts, scale, colors)
        break
      case 'pnf':
        R.drawPointAndFigure(ctx, s, from, to, ts, scale, colors, pnfBoxSize)
        break
      case 'kagi':
        if (kagiPoints) {
          // Each Kagi vertex maps 1:1 to a renderSeries bar, so during replay
          // `to` is the clipped last-visible index: draw only vertices [0..to]
          // (slicing is a no-op when replay is off, since to === len-1).
          const pts = to >= kagiPoints.length - 1 ? kagiPoints : kagiPoints.slice(0, to + 1)
          R.drawKagiSeries(ctx, pts, ts, scale, colors)
        }
        break
    }
  }

  /** Draws the last-price line + tag (and countdown); returns the axis rows it occupies so level tags can avoid them. */
  function drawLastPrice(layout: Layout, mainScale: PriceScale, colors: ChartColors): { top: number; bottom: number } | null {
    // Track the series on screen (synthetic for re-binned types) so the
    // last-price line/tag matches what's drawn. During replay the "current"
    // bar is the one AT the cursor (effectiveLength()-1), so the line/tag show
    // the replay bar's close, not the hidden future's.
    const n = effectiveLength()
    if (n === 0) return null
    const last = renderSeries[n - 1]
    const prevClose = n > 1 ? renderSeries[n - 2].close : last.open
    const color = last.close >= prevClose ? upColor(colors) : downColor(colors)
    // Glide the line + tag to a new price instead of jumping (big jumps snap).
    lastPriceMoving = false
    let shown = last.close
    if (appearance.smooth && shownLast !== null && Math.abs(shownLast - last.close) < Math.abs(mainScale.max - mainScale.min) * 0.15) {
      const eased = shownLast + (last.close - shownLast) * 0.35
      if (Math.abs(eased - last.close) > Math.abs(mainScale.max - mainScale.min) * 0.0004) {
        shown = eased
        lastPriceMoving = true
      }
    }
    shownLast = shown
    const y = mainScale.priceToY(shown)
    if (appearance.lastPriceLine && y >= mainScale.top && y <= mainScale.bottom) {
      R.drawLastPriceLine(ctx, color, Math.round(y) + 0.5, layout.plotWidth)
    }
    // Countdown to the live candle's close shares the price tag (a two-line
    // pill). Only for real-time, time-based charts: re-binned types aren't
    // time-aligned, and during replay the "current" bar is historical.
    let remaining = -1
    if (appearance.countdown && replayCursor === null && !isRebinnedChartType(chartType) && candles.length > 0 && ts.intervalMs > 0) {
      const r = candles[candles.length - 1].time + ts.intervalMs - Date.now()
      if (r > 0 && r <= ts.intervalMs + 60_000) remaining = r
    }
    if (remaining > 0) {
      const tagY = clamp(y, mainScale.top + 9, mainScale.bottom - 21)
      return R.drawPriceCountdownTag(
        ctx,
        formatMainValue(last.close),
        formatCountdown(remaining),
        tagY,
        layout.plotWidth,
        layout.width - layout.plotWidth,
        color,
        '#ffffff',
      )
    }
    const tagY = clamp(y, mainScale.top + 9, mainScale.bottom - 9)
    R.drawPriceTag(ctx, formatMainValue(last.close), tagY, layout.plotWidth, layout.width - layout.plotWidth, color, '#ffffff')
    const top = tagY - 9
    const bottom = tagY + 9
    return { top, bottom }
  }

  /**
   * Host level tags (setPriceTags) on the main price scale. Each tag wants to sit
   * centred on its price; tags are placed nearest-first and pushed clear of the
   * last-price tag and of each other, so a cluster (VAH/POC/VAL) fans out
   * instead of overprinting. Prices outside the visible range get no tag.
   */
  function drawLevelTags(layout: Layout, mainScale: PriceScale, reserved: { top: number; bottom: number }[]): void {
    if (priceTags.size === 0) return
    const H = 18
    const all: (PriceTag & { want: number })[] = []
    for (const list of priceTags.values()) {
      for (const t of list) {
        if (!isFinite(t.price)) continue
        const y = mainScale.priceToY(t.price)
        if (y < mainScale.top || y > mainScale.bottom) continue // like TradingView: a level off screen has no tag
        all.push({ ...t, want: clamp(y, mainScale.top + H / 2, mainScale.bottom - H / 2) })
      }
    }
    if (all.length === 0) return
    all.sort((a, b) => a.want - b.want)
    const taken: { top: number; bottom: number }[] = reserved.slice()
    const fits = (top: number): boolean => taken.every((r) => top + H <= r.top || top >= r.bottom)
    const axisW = layout.width - layout.plotWidth
    for (const t of all) {
      // Search outward from the wanted spot for the nearest free row.
      let top = t.want - H / 2
      if (!fits(top)) {
        let found: number | null = null
        for (let d = 1; d < mainScale.bottom - mainScale.top; d++) {
          if (top + d + H <= mainScale.bottom && fits(top + d)) { found = top + d; break }
          if (top - d >= mainScale.top && fits(top - d)) { found = top - d; break }
        }
        if (found === null) continue
        top = found
      }
      taken.push({ top, bottom: top + H })
      const fg = t.textColor ?? readableText(t.color)
      R.drawPriceTag(ctx, formatPrice(t.price, precision), top + H / 2, layout.plotWidth, axisW, t.color, fg)
      if (priceTagLabels && t.label) R.drawPlotEdgeChip(ctx, t.label, top + H / 2, layout.plotWidth, t.color, fg)
    }
  }

  /**
   * Draw the current-symbol price alerts on the main pane and rebuild the
   * tag-rect table used for click hit-testing. Lines spanning the plot width;
   * bell + price tag near the right axis. Triggered alerts render muted.
   */
  function drawAlerts(layout: Layout, mainScale: PriceScale, colors: ChartColors): void {
    alertTagRects = []
    if (alerts.length === 0) return
    const axisWidth = layout.width - layout.plotWidth
    const dragAlert = drag !== null && drag.mode === 'move-alert' ? drag : null
    for (const alert of alerts) {
      // While dragging, render the grabbed alert at the live cursor price
      // without mutating the host-owned alert object.
      const price = dragAlert !== null && dragAlert.id === alert.id ? dragAlert.price : alert.price
      const y = mainScale.priceToY(price)
      // Clamp the tag (and thus the bell/click target) inside the main pane so
      // off-screen alerts still expose an affordance at the pane edge.
      const tagY = clamp(y, mainScale.top + 9, mainScale.bottom - 9)
      const color = alert.condition === 'above' ? upColor(colors) : downColor(colors)
      // Only draw the dashed line when it falls inside the main pane.
      const lineVisible = y >= mainScale.top && y <= mainScale.bottom
      const rect = R.drawAlertLine(
        ctx,
        color,
        alert.triggered,
        formatPrice(price, precision),
        y,
        tagY,
        lineVisible,
        layout.plotWidth,
        axisWidth,
      )
      alertTagRects.push({ id: alert.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height })
    }
  }

  function drawLegends(layout: Layout, colors: ChartColors, hoverIdx: number | null): void {
    // Legend reflects the rendered series (synthetic for re-binned types).
    // During replay the resting (non-hover) row shows the bar AT the cursor,
    // and the hovered index is pre-clamped to [0..effectiveLength()-1] by the
    // caller, so indicator values never read into the hidden future.
    const n = effectiveLength()
    if (hoverIdx !== lastLegendIdx) {
      lastLegendIdx = hoverIdx
      options.onLegendIndex?.(hoverIdx)
    }
    const crossTime = hoverIdx !== null && hoverIdx < renderSeries.length ? renderSeries[hoverIdx].time : null
    if (crossTime !== lastCrosshairTime) {
      lastCrosshairTime = crossTime
      options.onCrosshairTime?.(crossTime)
    }
    if (n === 0) return
    const i = hoverIdx ?? n - 1
    const c = renderSeries[i]
    const x0 = 10
    const lineH = 16
    let y = layout.panes[0].top + 12
    const dirColor = c.close >= c.open ? upColor(colors) : downColor(colors)
    const prevClose = i > 0 ? renderSeries[i - 1].close : c.open
    const chg = prevClose !== 0 ? ((c.close - prevClose) / prevClose) * 100 : 0
    const chgColor = chg >= 0 ? upColor(colors) : downColor(colors)
    const fp = (v: number): string => formatPrice(v, precision)
    // Keep the OHLC row inside the plot (narrow charts would spill it onto the price axis).
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, Math.max(0, layout.plotWidth - 6), layout.timeAxisTop)
    ctx.clip()
    if (appearance.ohlcLegend) R.drawLegendLine(
      ctx,
      [
        { text: 'O', color: colors.mutedText },
        { text: fp(c.open), color: dirColor },
        { text: 'H', color: colors.mutedText },
        { text: fp(c.high), color: dirColor },
        { text: 'L', color: colors.mutedText },
        { text: fp(c.low), color: dirColor },
        { text: 'C', color: colors.mutedText },
        { text: fp(c.close), color: dirColor },
        { text: `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, color: chgColor },
        { text: 'Vol', color: colors.mutedText },
        { text: formatCompact(c.volume), color: dirColor },
      ],
      legendInsetX,
      y,
    )
    ctx.restore()
    y += lineH
    legendBottom = y - lineH / 2
    // Re-binned series (renko/kagi/linebreak) don't align bar-for-bar with the
    // candle-indexed indicators, so their legend values would be meaningless —
    // skip them (matching the skipped plots). The hovered `i` here is a
    // synthetic-bar index, not a candle index.
    if (indicatorLegend && !isRebinnedChartType(chartType)) {
      // Overlay indicators, listed under the OHLC row.
      for (const ind of indicators) {
        if (ind.placement !== 'overlay') continue
        const segs: R.LegendSegment[] = [{ text: ind.label, color: colors.mutedText }]
        for (const out of ind.outputs) {
          const v = i < out.values.length ? out.values[i] : null
          segs.push({ text: v == null || !isFinite(v) ? '—' : fp(v), color: out.color })
        }
        R.drawLegendLine(ctx, segs, x0, y)
        y += lineH
        legendBottom = y - lineH / 2
      }
      // Pane indicators, each in its own pane's top-left corner.
      for (let pi = 1; pi < layout.panes.length; pi++) {
        const pane = layout.panes[pi]
        const ind = pane.indicator as IndicatorRenderData
        const segs: R.LegendSegment[] = [{ text: ind.label, color: colors.mutedText }]
        for (const out of ind.outputs) {
          const v = i < out.values.length ? out.values[i] : null
          segs.push({ text: v == null || !isFinite(v) ? '—' : formatIndicatorValue(v), color: out.color })
        }
        R.drawLegendLine(ctx, segs, x0, pane.top + 12)
      }
    }
  }

  function drawCrosshair(layout: Layout, scales: PriceScale[], colors: ChartColors): void {
    if (!hover) return
    const { x, y } = hover
    if (x < 0 || x > layout.plotWidth || y < 0 || y >= layout.timeAxisTop) return
    const idx = Math.floor(ts.xToIndex(x))
    const snappedX = Math.round(ts.centerX(idx)) + 0.5
    R.drawCrosshairVertical(ctx, colors, snappedX, layout.timeAxisTop, crosshairDash())
    if (ts.count > 0) {
      R.drawTimeTag(
        ctx,
        colors,
        formatFullTime(ts.indexToTime(idx), ts.intervalMs),
        Math.round(ts.centerX(idx)),
        layout.plotWidth,
        layout.timeAxisTop,
        TIME_AXIS_H,
      )
    }
    const pi = paneIndexAt(y, layout)
    if (pi >= 0 && pi < scales.length) {
      R.drawCrosshairHorizontal(ctx, colors, Math.round(y) + 0.5, layout.plotWidth, crosshairDash())
      const scale = scales[pi]
      const price = scale.yToPrice(y)
      const label = pi === 0 ? formatMainValue(price) : formatPaneCrosshairValue(price, scale)
      R.drawPriceTag(
        ctx,
        label,
        y,
        layout.plotWidth,
        layout.width - layout.plotWidth,
        colors.crosshairTagBg,
        colors.crosshairTagText,
      )
    }
  }

  function render(): void {
    if (destroyed) return
    if ((window.devicePixelRatio || 1) !== currentDpr) applySize()
    if (size.width <= 0 || size.height <= 0) return
    // Resolve the cursor-affordance hit-test once per frame (see
    // handlePointerMove(), which only stores `hover` and no longer calls
    // updateCursor() synchronously) instead of on every raw mousemove event —
    // mice/trackpads can fire those at several hundred Hz, far above what any
    // display can show, so a same-frame-only cursor update is visually
    // identical while running the O(drawings) hit-test scan far less often.
    if (hover && !drag) updateCursor(hover.x, hover.y)
    // Frame clock for the eased motions (capped so a stalled tab doesn't leap).
    const now = performance.now()
    const dt = lastFrameAt ? Math.min(48, now - lastFrameAt) : 16
    lastFrameAt = now
    let animating = stepViewMotion(dt)
    const colors = THEMES[theme]
    // Effective palette: settings' up/down/accent override the theme's (series,
    // volume, magnet ring). Base bg/text/grid/axis colors stay theme-governed.
    const eColors = effectiveColors(colors)
    const showGrid = gridVisible()
    const showVGrid = showGrid && appearance.gridMode !== 'horizontal' && appearance.gridMode !== 'none'
    const showHGrid = showGrid && appearance.gridMode !== 'vertical' && appearance.gridMode !== 'none'
    const layout = computeLayout()
    ctx.save()
    ctx.font = FONT
    const bgTop = appearance.background ?? colors.bg
    if (appearance.backgroundGradient) {
      const g = ctx.createLinearGradient(0, 0, 0, layout.height)
      g.addColorStop(0, bgTop)
      g.addColorStop(1, appearance.backgroundGradient)
      ctx.fillStyle = g
    } else {
      ctx.fillStyle = bgTop
    }
    ctx.fillRect(0, 0, layout.width, layout.height)

    const timeTicks = computeTimeTicks(ts)
    if (showVGrid) R.drawVerticalGrid(ctx, colors, timeTicks, layout.timeAxisTop)

    const { from, to } = ts.visibleRange()
    // Replay-clipped upper draw index: bars after the cursor are the hidden
    // "future", so every series-derived layer (volume, the drawn series, all
    // indicator plots, projections' anchor) iterates [from..drawTo] instead of
    // [from..to]. With replay OFF, effectiveLength() === renderSeries.length so
    // drawTo === to and the render is byte-identical to before. `from` and the
    // time ticks are untouched, so the x-axis never resizes at the cursor.
    const drawTo = Math.min(to, effectiveLength() - 1)
    const hasData = effectiveLength() > 0 && from <= drawTo
    // Re-binned types (renko/kagi/linebreak) draw a synthetic series on the
    // index axis; volume + indicators (computed on the original candles) no
    // longer align, so they're suppressed to avoid meaningless / garbled plots.
    const rebinned = isRebinnedChartType(chartType)
    const mainPane = layout.panes[0]
    if (stepScaleAnimation(mainPane, dt)) animating = true
    const mainScale = computeMainScale(mainPane)
    const scales: PriceScale[] = [mainScale]

    // Session breaks: a faint dashed line where a new day starts (display time zone).
    if (appearance.sessionBreaks && hasData && !rebinned && ts.intervalMs < 86_400_000) {
      ctx.save()
      ctx.strokeStyle = colors.separator
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      const day = (t: number): number => Math.floor((t + displayZoneOffset(t)) / 86_400_000)
      for (let i = Math.max(1, from); i <= drawTo; i++) {
        if (day(renderSeries[i].time) === day(renderSeries[i - 1].time)) continue
        const x = Math.round(ts.indexToX(i)) + 0.5
        ctx.moveTo(x, 0)
        ctx.lineTo(x, layout.timeAxisTop)
      }
      ctx.stroke()
      ctx.restore()
    }

    // --- main pane ---
    const mainTickInfo = mainAxisTicks(mainScale)
    const mainTicks = mainTickInfo.map((t) => t.price)
    if (showHGrid) R.drawHorizontalGrid(ctx, colors, layout.plotWidth, mainScale, mainTicks)
    // Faint symbol · interval watermark, centred behind the series.
    if (watermark && mainPane.height > 60 && layout.plotWidth > 120) {
      ctx.save()
      const px = Math.round(Math.min(64, Math.max(22, layout.plotWidth / 14)))
      ctx.font = `700 ${px}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
      ctx.fillStyle = colors.mutedText
      ctx.globalAlpha = theme === 'dark' ? 0.07 : 0.09
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(watermark, layout.plotWidth / 2, mainPane.top + mainPane.height / 2, layout.plotWidth - 40)
      ctx.restore()
    }
    // Backdrop (e.g. DOM Heatmap): behind the candles and indicators.
    if (backdrop && mainPane.height > 0 && layout.plotWidth > 0) {
      ctx.save()
      clipPane(mainPane, layout)
      backdrop(ctx, { x: 0, y: mainPane.top, width: layout.plotWidth, height: mainPane.height }, liveConverters)
      ctx.restore()
    }
    if (hasData && mainPane.height > 0 && layout.plotWidth > 0) {
      ctx.save()
      clipPane(mainPane, layout)
      // Volume is no longer drawn built-in on the main pane (it's now an opt-in
      // 'volume' indicator rendered in its own sub-pane via the normal pipeline),
      // so the main pane is full-height price. R.drawVolume remains exported for
      // that indicator's histogram to reuse.
      // Volume faded along the bottom, behind the series.
      if (appearance.volumeOverlay && !rebinned) {
        R.drawVolume(ctx, renderSeries, from, drawTo, ts, mainPane.top, mainPane.height, 0.18, eColors, 0.28)
      }
      drawSeriesByType(mainScale, eColors, from, drawTo)
      if (!rebinned) {
        for (const ind of indicators) {
          if (ind.placement !== 'overlay') continue
          for (const out of ind.outputs) {
            R.drawIndicatorOutput(ctx, out, from, drawTo, ts, mainScale)
          }
        }
      }
      // Compare symbols, re-based to the main series at the first visible bar.
      if (compares.length > 0 && !rebinned) {
        for (const cmp of compares) {
          const base = compareBase(cmp, from, drawTo)
          if (!base) continue
          ctx.save()
          ctx.strokeStyle = cmp.color
          ctx.lineWidth = 1.6
          ctx.lineJoin = 'round'
          ctx.beginPath()
          let pen = false
          for (let i = from; i <= drawTo; i++) {
            const v = cmp.byTime.get(renderSeries[i].time)
            if (v == null) {
              pen = false
              continue
            }
            const x = ts.centerX(i)
            const y = mainScale.priceToY((base.main * v) / base.cmp)
            if (pen) ctx.lineTo(x, y)
            else ctx.moveTo(x, y)
            pen = true
          }
          ctx.stroke()
          ctx.restore()
        }
      }
      // Ghost projections: above candles/overlays, beneath drawings/crosshair.
      // Anchored at the last VISIBLE bar so during replay they sprout from the
      // cursor bar, not the hidden future's last bar.
      if (projLines.length > 0 || projBand !== null) {
        R.drawProjections(ctx, projLines, projBand, effectiveLength() - 1, ts, mainScale)
      }
      ctx.restore()
    }

    // --- indicator sub-panes ---
    for (let pi = 1; pi < layout.panes.length; pi++) {
      const pane = layout.panes[pi]
      const scale = computePaneScale(pane)
      scales.push(scale)
      const ticks = scale.ticks()
      const ind = pane.indicator as IndicatorRenderData
      // a pane with nothing plotted (a hidden indicator, or a tool that paints the pane itself) gets no grid / scale
      if (showHGrid && ind.outputs.length) R.drawHorizontalGrid(ctx, colors, layout.plotWidth, scale, ticks)
      if (ind.range && ind.range[0] === 0 && ind.range[1] === 100) {
        R.drawGuideLines(ctx, colors, layout.plotWidth, scale, [30, 70])
      }
      // Pane indicator plots are also suppressed for re-binned types (they'd be
      // plotted against a synthetic x-axis they weren't computed on). The pane
      // chrome (grid/guides/separator) stays so the layout doesn't jump.
      if (!rebinned && pane.height > 0 && layout.plotWidth > 0) {
        ctx.save()
        clipPane(pane, layout)
        for (const out of ind.outputs) {
          R.drawIndicatorOutput(ctx, out, from, drawTo, ts, scale)
        }
        ctx.restore()
      }
      R.drawSeparator(ctx, colors, pane.top - SEPARATOR_H, layout.width)
    }

    // --- axes ---
    R.drawAxisLines(ctx, colors, layout.plotWidth, layout.timeAxisTop, layout.width, layout.height)
    // Tick labels that would sit under the A / L toggle buttons are skipped, so a
    // label is never half-covered (e.g. "4,148.00" reading as "48.00").
    const togglesBottom = mainPane.top + AXIS_TOGGLE_MARGIN + AXIS_TOGGLE_SIZE * (appearance.percentButton ? 3 : 2) + (appearance.percentButton ? 8 : 4) + 8
    R.drawPriceAxisLabels(
      ctx,
      colors,
      layout.plotWidth,
      mainTickInfo
        .map((t) => ({ y: Math.round(mainScale.priceToY(t.price)), label: t.label }))
        .filter((t) => t.y > togglesBottom),
    )
    for (let pi = 1; pi < layout.panes.length; pi++) {
      if (!layout.panes[pi].indicator?.outputs.length) continue
      R.drawPriceAxisLabels(ctx, colors, layout.plotWidth, paneTickLabels(scales[pi], scales[pi].ticks()))
    }

    // --- price-scale auto/manual "A" toggle (top of the right price axis) ---
    // Drawn only when there is both an axis column and a main pane with height.
    const axisW = layout.width - layout.plotWidth
    if (axisW > AXIS_TOGGLE_SIZE + AXIS_TOGGLE_MARGIN && mainPane.height > AXIS_TOGGLE_SIZE) {
      const bx = layout.plotWidth + AXIS_TOGGLE_MARGIN + 1
      const by = mainPane.top + AXIS_TOGGLE_MARGIN
      R.drawAxisToggleButton(ctx, colors, bx, by, AXIS_TOGGLE_SIZE, priceScaleMode === 'auto')
      axisToggleRect = { x: bx, y: by, width: AXIS_TOGGLE_SIZE, height: AXIS_TOGGLE_SIZE }
      // Log-scale "L" toggle directly below "A" (filled when log is on), when the
      // main pane is tall enough for a second button.
      const ly = by + AXIS_TOGGLE_SIZE + 4
      if (mainPane.top + mainPane.height > ly + AXIS_TOGGLE_SIZE) {
        R.drawAxisToggleButton(ctx, colors, bx, ly, AXIS_TOGGLE_SIZE, priceScaleLog, 'L')
        logToggleRect = { x: bx, y: ly, width: AXIS_TOGGLE_SIZE, height: AXIS_TOGGLE_SIZE }
        // "%" toggle under L: percent labels from the first visible bar.
        const py = ly + AXIS_TOGGLE_SIZE + 4
        if (appearance.percentButton && mainPane.top + mainPane.height > py + AXIS_TOGGLE_SIZE) {
          R.drawAxisToggleButton(ctx, colors, bx, py, AXIS_TOGGLE_SIZE, displayMode === 'percent', '%')
          pctToggleRect = { x: bx, y: py, width: AXIS_TOGGLE_SIZE, height: AXIS_TOGGLE_SIZE }
        } else {
          pctToggleRect = null
        }
      } else {
        logToggleRect = null
        pctToggleRect = null
      }
    } else {
      axisToggleRect = null
      logToggleRect = null
      pctToggleRect = null
    }
    const timeLabels: { x: number; label: string }[] = []
    for (let i = 0; i < timeTicks.length; i++) {
      timeLabels.push({
        x: timeTicks[i].x,
        label: formatTimeTickLabel(timeTicks[i].time, i > 0 ? timeTicks[i - 1].time : null, ts.intervalMs),
      })
    }
    R.drawTimeAxisLabels(ctx, colors, timeLabels, layout.timeAxisTop + TIME_AXIS_H / 2 + 1)
    if (appearance.cornerLabel) {
      ctx.save()
      ctx.font = SMALL_FONT
      ctx.fillStyle = colors.mutedText
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(appearance.cornerLabel, layout.plotWidth + (layout.width - layout.plotWidth) / 2, layout.timeAxisTop + TIME_AXIS_H / 2 + 1)
      ctx.restore()
    }

    // --- last price, then host level tags stacked around it ---
    const lastTagRows = hasData ? drawLastPrice(layout, mainScale, colors) : null

    // --- price alerts (main pane; beneath drawings so drawings win clicks) ---
    drawAlerts(layout, mainScale, colors)
    // Level tags go last so they can step around both the last-price and the alert tags.
    drawLevelTags(layout, mainScale, [
      ...(lastTagRows ? [lastTagRows] : []),
      ...alertTagRects.map((r) => ({ top: r.y, bottom: r.y + r.height })),
    ])

    // --- drawings (main pane only, clipped) ---
    if (mainPane.height > 0 && layout.plotWidth > 0) {
      const conv = makeConverters(mainScale)
      const env = makeEnv()
      ctx.save()
      clipPane(mainPane, layout)
      for (const d of drawings) {
        if (isHiddenDrawing(d)) continue
        renderDrawing(ctx, d, conv, d.id === selectedId, env)
      }
      const preview = buildPreview(conv, mainPane)
      if (preview) renderDrawing(ctx, preview, conv, false, env)
      if (drag !== null && drag.mode === 'freehand') {
        renderDrawing(ctx, drag.drawing, conv, false, env)
      }
      // Magnet feedback: ring on the snapped candidate point while placing / handle-dragging.
      if (magnet && hover) {
        const placing = activeTool !== null && pointsNeeded(activeTool) >= 1
        const handleDragging = drag !== null && drag.mode === 'move-handle'
        const inMain =
          hover.x >= 0 &&
          hover.x <= layout.plotWidth &&
          hover.y >= mainPane.top &&
          hover.y < mainPane.top + mainPane.height
        if ((placing && inMain) || handleDragging) {
          const snap = magnetSnap(hover.x, hover.y, conv)
          if (snap.snapped) R.drawMagnetRing(ctx, hover.x, conv.priceToY(snap.price), eColors.accent)
        }
      }
      ctx.restore()
    }

    // --- crosshair + legend ---
    // Clamp the hovered legend index to the last VISIBLE bar so that, during
    // replay, hovering over the hidden future still reads the cursor bar's
    // values (and the legend never surfaces future OHLC / indicator values).
    const hoverIdx =
      hover && hasData && hover.x >= 0 && hover.x <= layout.plotWidth && hover.y < layout.timeAxisTop
        ? clamp(Math.floor(ts.xToIndex(hover.x)), 0, effectiveLength() - 1)
        : null
    if (crosshairVisible()) drawCrosshair(layout, scales, colors)
    // "Lock vertical cursor here": a fixed accent line with its time tag.
    if (cursorLock !== null && ts.count > 0) {
      const x = Math.round(ts.timeToX(cursorLock)) + 0.5
      if (x >= 0 && x <= layout.plotWidth) {
        R.drawCrosshairVertical(ctx, colors, x, layout.timeAxisTop, [6, 4], eColors.accent)
        R.drawTimeTag(ctx, colors, formatFullTime(cursorLock, ts.intervalMs), x, layout.plotWidth, layout.timeAxisTop, TIME_AXIS_H)
      }
    }
    // Another chart's crosshair (layout sync), only while this chart isn't hovered.
    if (!hover && externalCrosshair !== null && ts.count > 0) {
      const x = Math.round(ts.timeToX(externalCrosshair)) + 0.5
      if (x >= 0 && x <= layout.plotWidth) {
        R.drawCrosshairVertical(ctx, colors, x, layout.timeAxisTop)
        R.drawTimeTag(ctx, colors, formatFullTime(externalCrosshair, ts.intervalMs), x, layout.plotWidth, layout.timeAxisTop, TIME_AXIS_H)
      }
    }
    drawLegends(layout, colors, hoverIdx)

    ctx.restore()

    if (lastPriceMoving) animating = true
    if (animating) invalidate()
    else lastFrameAt = 0
    const key = viewKey()
    if (key !== lastViewEmit) {
      lastViewEmit = key
      options.onViewChange?.()
    }
  }

  function isHiddenDrawing(d: Drawing): boolean {
    return drawingsHidden || d.props?.hidden === true
  }

  function isLockedDrawing(d: Drawing): boolean {
    return drawingsLocked || d.props?.locked === true
  }

  /** Close of the first visible bar: the 0% / 100 anchor for percent / indexed labels. */
  function displayBase(): number | null {
    const n = effectiveLength()
    if (n === 0 || displayMode === 'price') return null
    const i = clamp(ts.visibleRange().from, 0, n - 1)
    return renderSeries[i].close || null
  }

  /** A main-pane price as the axis shows it (price, % change or index). */
  function formatMainValue(price: number): string {
    const base = displayBase()
    if (base === null) return formatPrice(price, precision)
    if (displayMode === 'percent') {
      const pct = (price / base - 1) * 100
      return `${pct > 0.004 ? '+' : ''}${(Math.abs(pct) < 0.005 ? 0 : pct).toFixed(2)}%`
    }
    return ((price / base) * 100).toFixed(2)
  }

  /** Tick prices + labels for the main axis; percent / indexed modes tick on round display values. */
  function mainAxisTicks(scale: PriceScale): { price: number; label: string }[] {
    const base = displayBase()
    if (base === null) return scale.ticks(Math.pow(10, -precision)).map((v) => ({ price: v, label: formatPrice(v, precision) }))
    const toD = (v: number): number => (displayMode === 'percent' ? (v / base - 1) * 100 : (v / base) * 100)
    const fromD = (d: number): number => (displayMode === 'percent' ? base * (1 + d / 100) : (base * d) / 100)
    const display = new PriceScale(scale.top, scale.height, toD(scale.min), toD(scale.max))
    return display.ticks(0.01).map((d) => ({ price: fromD(d), label: formatMainValue(fromD(d)) }))
  }

  // ----- public API -----------------------------------------------------------
  const engine: IChartEngine = {
    setData(newCandles: Candle[]): void {
      // View stability is reasoned in RENDER-SERIES index space (what's on the
      // index axis), so re-binned types stay visually stable too: the synthetic
      // bar count, not the candle count, drives the shift. For the 1:1 types
      // renderSeries mirrors candles, so this matches the original behavior.
      const prevSeries = renderSeries
      const prevCount = prevSeries.length
      const prevView = { ...ts.view }
      stopMotion()
      candles = newCandles.slice()
      computeBarMs()
      rebuildSeries() // recompute transforms + point ts at the new series' times
      targetScaleCache = null
      liveScaleCache = null
      paneScaleCache.clear()
      indicatorRanges.clear()
      const newCount = renderSeries.length
      if (prevCount === 0 || newCount === 0) {
        resetViewInternal()
      } else {
        const sameLast = renderSeries[newCount - 1].time === prevSeries[prevCount - 1].time
        const shift = newCount - prevCount
        if (sameLast) {
          // Same series; history was prepended (or trimmed) at the front:
          // shift indices so the viewport stays visually stable.
          ts.view = { start: prevView.start + shift, end: prevView.end + shift }
        } else if (renderSeries[0].time === prevSeries[0].time) {
          // Same series with newer candles appended: keep the viewport.
          ts.view = prevView
        } else {
          // Different series (symbol/interval switch): start fresh.
          resetViewInternal()
        }
      }
      historyArmed = true // re-arm the onRequestHistory trigger
      clampReplayCursor() // re-pin into the (possibly resized) series bounds
      invalidate()
    },

    updateLast(candle: Candle): void {
      const n = candles.length
      if (n === 0) {
        engine.setData([candle])
        return
      }
      // Capture the right-edge-following state against the CURRENT render-series
      // index space BEFORE mutating candles (for 1:1 types renderSeries aliases
      // candles, so the mutation below would otherwise change this count).
      const prevSeriesCount = renderSeries.length
      const atRightEdge = ts.view.end >= prevSeriesCount - 0.5
      const last = candles[n - 1]
      let isNewBar: boolean
      if (candle.time === last.time) {
        candles[n - 1] = candle
        isNewBar = false
      } else if (candle.time > last.time) {
        candles.push(candle)
        isNewBar = true
      } else {
        return // out-of-order update; ignore
      }
      // Extend the cached transform in O(one candle) instead of rebuildSeries()'s
      // O(candles) full re-transform of the whole loaded array — falls back to a
      // full rebuild when there's no session to extend yet (chart type just
      // switched, first load). Auto-scroll keeps the right edge in view when the
      // series grew and the viewport was already following it — matching the
      // original append behavior for the 4 base types (grew === 1).
      if (extendSeries(candle, isNewBar)) {
        syncTimesAfterExtend(prevSeriesCount)
      } else {
        rebuildSeries()
      }
      targetScaleCache = null
      liveScaleCache = null
      paneScaleCache.clear()
      indicatorRanges.clear()
      const grew = renderSeries.length - prevSeriesCount
      if (atRightEdge && grew > 0) {
        ts.view = { start: ts.view.start + grew, end: ts.view.end + grew }
        if (viewAnim) viewAnim = { start: viewAnim.start + grew, end: viewAnim.end + grew }
      }
      clampReplayCursor() // re-pin if a re-binned transform shrank the series
      invalidate()
    },

    setIndicators(list: IndicatorRenderData[]): void {
      indicators = list.slice()
      targetScaleCache = null
      liveScaleCache = null
      paneScaleCache.clear()
      indicatorRanges.clear()
      invalidate()
    },

    setChartType(type: ChartType): void {
      if (type === chartType) {
        invalidate()
        return
      }
      const prevCount = renderSeries.length
      const axisChanged = isRebinnedChartType(type) !== isRebinnedChartType(chartType)
      chartType = type
      rebuildSeries()
      targetScaleCache = null
      liveScaleCache = null
      paneScaleCache.clear()
      // Refit the viewport when the index axis changes meaning: switching into
      // or out of a re-binned type (different bar count AND different x-axis
      // semantics), or any length change. The 1:1 types all share the candle
      // index axis and keep the same count, so their viewport is preserved.
      if (axisChanged || renderSeries.length !== prevCount) {
        resetViewInternal()
      } else {
        clampView()
      }
      invalidate()
    },

    setRenkoBoxSize(size: number | null): void {
      const next = size !== null && size > 0 && isFinite(size) ? size : null
      if (next === renkoBoxOverride) return
      renkoBoxOverride = next
      if (chartType !== 'renko') return
      const prevCount = renderSeries.length
      rebuildSeries()
      targetScaleCache = null
      liveScaleCache = null
      paneScaleCache.clear()
      if (renderSeries.length !== prevCount) resetViewInternal()
      else clampView()
      invalidate()
    },

    getRenkoBoxSize(): number {
      return chartType === 'renko' ? activeRenkoBox : 0
    },

    barCenterX(index: number): number {
      return ts.centerX(index)
    },

    setTheme(t: Theme): void {
      theme = t
      invalidate()
    },

    setPricePrecision(p: number): void {
      precision = p
      invalidate()
    },

    setActiveTool(tool: DrawingToolId | null): void {
      activeTool = tool
      pendingPoints = []
      if (drag !== null && drag.mode === 'freehand') drag = null // discard mid-stroke capture
      if (tool !== null) setSelection(null)
      invalidate()
    },

    setDrawings(ds: Drawing[]): void {
      drawings = ds.slice()
      // A full replace (restore / symbol switch) starts a fresh undo history.
      committed = drawings.slice()
      undoStack = []
      redoStack = []
      options.onHistoryChange?.()
      if (selectedId && !drawings.some((d) => d.id === selectedId)) setSelection(null)
      invalidate()
    },

    addDrawing(d: Drawing): void {
      drawings.push(d)
      setSelection(d.id)
      emitDrawings()
      invalidate()
    },

    removeDrawing(id: string): void {
      if (!drawings.some((d) => d.id === id)) return
      drawings = drawings.filter((d) => d.id !== id)
      if (selectedId === id) setSelection(null)
      emitDrawings()
      invalidate()
    },

    undo(): boolean {
      return restoreDrawings(undoStack, redoStack)
    },

    redo(): boolean {
      return restoreDrawings(redoStack, undoStack)
    },

    canUndo(): boolean {
      return undoStack.length > 0
    },

    canRedo(): boolean {
      return redoStack.length > 0
    },

    setEraser(on: boolean): void {
      eraser = on
      if (on) {
        activeTool = null
        pendingPoints = []
        setSelection(null)
      }
      invalidate()
    },

    setStayInDrawingMode(on: boolean): void {
      stayInDrawing = on
    },

    setWatermark(text: string | null): void {
      watermark = text
      invalidate()
    },

    setBackdrop(fn: ((g: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, conv: Converters) => void) | null): void {
      backdrop = fn
      invalidate()
    },

    setLegendInset(x: number): void {
      const next = Math.max(10, Math.round(x))
      if (next === legendInsetX) return
      legendInsetX = next
      invalidate()
    },

    updateDrawing(d: Drawing): void {
      const idx = drawings.findIndex((x) => x.id === d.id)
      if (idx < 0) return // unknown id: no-op
      drawings[idx] = d // selection (by id) is untouched, so it stays selected
      emitDrawings() // deliberately NOT onSelectionChange — the inspector is the caller
      invalidate()
    },

    setMagnet(on: boolean): void {
      magnet = on
      invalidate()
    },

    setAlerts(list: Alert[]): void {
      // If the host replaces the set mid-drag (e.g. its own poll), cancel any
      // in-progress alert drag whose target just disappeared so we don't keep a
      // dangling reference or fire onAlertMove for a gone alert.
      if (drag !== null && drag.mode === 'move-alert') {
        const draggedId = drag.id
        if (!list.some((a) => a.id === draggedId)) drag = null
      }
      alerts = list.slice()
      invalidate()
    },

    setSettings(next: ChartSettings): void {
      settings = { ...next }
      invalidate()
    },

    clearDrawings(): void {
      if (drawings.length === 0) return
      drawings = []
      setSelection(null)
      emitDrawings()
      invalidate()
    },

    resetView(): void {
      stopMotion()
      resetViewInternal()
      invalidate()
    },

    resize(): void {
      applySize()
      targetScaleCache = null
      liveScaleCache = null
      paneScaleCache.clear()
      invalidate()
    },

    destroy(): void {
      if (destroyed) return
      destroyed = true
      clearInterval(countdownTimer)
      if (rafId !== 0) cancelAnimationFrame(rafId)
      rafId = 0
      disposeInteractions()
      resizeObserver.disconnect()
      canvas.remove()
    },

    setProjections(lines: ProjectionLine[], band?: ProjectionBand | null): void {
      projLines = lines.slice()
      projBand = band ?? null
      // If the viewport is following the right edge (same criterion as the
      // updateLast auto-scroll), expand the right-edge offset once so the
      // longest projection plus 3 bars of breathing room is on screen. Zoom
      // width is preserved; we never shrink an offset the user already has,
      // and panning away afterwards is respected (no re-expansion until the
      // next setProjections call).
      const n = ts.count
      if (projLines.length > 0 && n > 0 && ts.view.end >= n - 0.5) {
        let maxOffset = 0
        for (const line of projLines) {
          for (const p of line.points) if (p.barOffset > maxOffset) maxOffset = p.barOffset
        }
        if (projBand) {
          for (const p of projBand.upper) if (p.barOffset > maxOffset) maxOffset = p.barOffset
          for (const p of projBand.lower) if (p.barOffset > maxOffset) maxOffset = p.barOffset
        }
        const desiredEnd = n + maxOffset + 3
        if (ts.view.end < desiredEnd) {
          const range = ts.range
          ts.view = { start: desiredEnd - range, end: desiredEnd }
          clampView() // keep at least a couple of candles on screen when zoomed far in
        }
      }
      invalidate()
    },

    ensureRightGutter(px: number): void {
      // Same right-edge-following criterion as updateLast / setProjections.
      const n = ts.count
      if (!(px > 0) || n === 0 || ts.plotWidth <= 0 || ts.view.end < n - 0.5) return
      // Never fight the user: no gutter while they drag, glide or have moved
      // the view themselves (until they reset or come back to the live edge).
      if (drag !== null || momentum !== null || viewAnim !== null) return
      const range = ts.range
      const barPx = ts.plotWidth / range
      // Blank bars after the last bar; capped at half the view so a narrow chart still shows candles.
      const want = Math.min(range / 2, px / barPx + 0.5)
      const desiredEnd = n + want
      if (userMovedView) {
        if (ts.view.end >= desiredEnd - 0.5) userMovedView = false // back at the live edge
        return
      }
      if (ts.view.end >= desiredEnd - 0.01) return
      ts.view = { start: desiredEnd - range, end: desiredEnd }
      clampView()
      invalidate()
    },

    scrollToTime(time: number): void {
      // `ts` is keyed to the render series (synthetic for re-binned types), so
      // clamp to its length, not the candle count.
      const n = renderSeries.length
      if (n === 0) return
      // timeToIndex binary-searches the loaded range (and extrapolates outside
      // it); rounding + clamping yields the nearest (synthetic) bar index.
      const idx = clamp(Math.round(ts.timeToIndex(time)), 0, n - 1)
      stopMotion()
      userMovedView = true
      const range = ts.range
      const center = idx + 0.5 // bar centers live at index + 0.5
      ts.view = { start: center - range / 2, end: center + range / 2 }
      clampView()
      checkHistory()
      invalidate()
    },

    zoomToBars(bars: number): void {
      stopMotion()
      const end = ts.view.end
      ts.view = { start: end - Math.max(2, bars), end }
      clampView()
      checkHistory()
      invalidate()
    },

    setReplayCursor(index: number | null): void {
      stopMotion()
      if (index === null) {
        if (replayCursor === null) return // already off — no repaint needed
        replayCursor = null
        invalidate()
        return
      }
      const n = renderSeries.length
      // No series yet: arm at 0 once data arrives. clampReplayCursor() runs on
      // every setData/updateLast, so storing 0 here is re-clamped (or cleared)
      // when the series materializes; storing the raw value would risk an
      // out-of-range cursor until the next data change.
      const next = n === 0 ? 0 : clamp(Math.round(index), 0, n - 1)
      const entering = replayCursor === null
      if (!entering && next === replayCursor) return
      replayCursor = next
      // Bring the cursor into view: on entry, or when it walks off-screen
      // (during play / scrub). Pin it near the right edge, preserving zoom
      // width, so the revealed history sits on the left and the "now" bar is at
      // the right. Without this, entering replay leaves the viewport on the
      // (now-hidden) future bars and the chart looks empty.
      if (n > 0) {
        const width = ts.view.end - ts.view.start
        const margin = replayPinMargin(width)
        const visible = next >= ts.view.start && next <= ts.view.end - margin
        if (entering || !visible) {
          const end = next + 1 + margin
          ts.view = { start: end - width, end }
          clampView()
          checkHistory()
        }
      }
      invalidate()
    },

    setReplayPlaying(playing: boolean): void {
      // Only consulted by future zoom gestures — no repaint needed.
      replayPlaying = playing
    },

    getMainConverters(): Converters | null {
      if (size.width <= 0 || size.height <= 0) return null
      return liveConverters
    },

    getMainPaneRect(): { x: number; y: number; width: number; height: number } | null {
      if (size.width <= 0 || size.height <= 0) return null
      const pane = computeLayout().panes[0]
      return { x: 0, y: pane.top, width: ts.plotWidth, height: pane.height }
    },

    setPriceTags(source: string, tags: PriceTag[]): void {
      const prev = priceTags.get(source) ?? []
      const same =
        prev.length === tags.length &&
        prev.every((p, i) => p.price === tags[i].price && p.color === tags[i].color && p.label === tags[i].label && p.textColor === tags[i].textColor)
      if (same) return
      if (tags.length === 0) priceTags.delete(source)
      else priceTags.set(source, tags.map((t) => ({ ...t })))
      invalidate()
    },

    setPriceTagLabels(on: boolean): void {
      if (priceTagLabels === on) return
      priceTagLabels = on
      invalidate()
    },

    getPriceScale(): { auto: boolean; log: boolean; mode: PriceDisplayMode; invert: boolean } {
      return { auto: priceScaleMode === 'auto', log: priceScaleLog, mode: displayMode, invert: priceInvert }
    },

    setPriceScale(next: { auto?: boolean; log?: boolean; mode?: PriceDisplayMode; invert?: boolean }): void {
      if (next.auto === true && priceScaleMode === 'manual') exitManualScale()
      else if (next.auto === false && priceScaleMode === 'auto') enterManualScale()
      if (next.log !== undefined) priceScaleLog = next.log
      if (next.mode !== undefined) displayMode = next.mode
      if (next.invert !== undefined) priceInvert = next.invert
      shownRange = null
      invalidate()
    },

    setAppearance(next: ChartAppearance): void {
      for (const [k, v] of Object.entries(next)) {
        if (v !== undefined) (appearance as Record<string, unknown>)[k] = v
      }
      if (!appearance.smooth) {
        stopMotion()
        shownRange = null
        shownLast = null
      }
      invalidate()
    },

    getAppearance(): Required<ChartAppearance> {
      return { ...appearance }
    },

    setCompareSeries(list: CompareSeries[]): void {
      compares = list.map((c) => ({ id: c.id, label: c.label, color: c.color, byTime: new Map(c.candles.map((k) => [k.time, k.close])) }))
      invalidate()
    },

    setDrawingsHidden(hidden: boolean): void {
      drawingsHidden = hidden
      if (hidden) setSelection(null)
      invalidate()
    },

    setDrawingsLocked(locked: boolean): void {
      drawingsLocked = locked
      invalidate()
    },

    selectDrawing(id: string | null): void {
      setSelection(id !== null && drawings.some((d) => d.id === id) ? id : null)
      invalidate()
    },

    getVisibleRange(): { from: number; to: number } {
      return ts.visibleRange()
    },

    getVisibleTimeRange(): { from: number; to: number } | null {
      if (ts.count === 0) return null
      return { from: ts.indexToTime(ts.view.start), to: ts.indexToTime(ts.view.end) }
    },

    setVisibleTimeRange(from: number, to: number): void {
      if (ts.count === 0) return
      const s = ts.timeToIndex(from)
      const e = ts.timeToIndex(to)
      if (!(e - s > 1) || !isFinite(s) || !isFinite(e)) return
      stopMotion()
      userMovedView = true
      ts.view = { start: s, end: e }
      clampView()
      checkHistory()
      lastViewEmit = viewKey() // applied from outside: don't echo it back
      invalidate()
    },

    setExternalCrosshair(time: number | null): void {
      if (externalCrosshair === time) return
      externalCrosshair = time
      invalidate()
    },

    setCursorLock(time: number | null): void {
      cursorLock = time
      invalidate()
    },

    getCursorLock(): number | null {
      return cursorLock
    },

    zoomBy(factor: number): void {
      if (!(factor > 0)) return
      userMovedView = true
      const base = viewAnim ?? ts.view
      const r0 = base.end - base.start
      const r1 = clamp(r0 / factor, MIN_VISIBLE_BARS, maxVisibleBars())
      animateViewTo({ start: base.end - r1, end: base.end })
    },

    scrollBars(bars: number): void {
      userMovedView = true
      const base = viewAnim ?? ts.view
      animateViewTo({ start: base.start + bars, end: base.end + bars })
    },

    getLegendBottom(): number {
      return legendBottom
    },

    setIndicatorLegend(on: boolean): void {
      if (indicatorLegend === on) return
      indicatorLegend = on
      invalidate()
    },

    setPaneHeights(h: Record<string, number>): void {
      paneHeights = { ...h }
      invalidate()
    },
    getPaneHeights(): Record<string, number> {
      return { ...paneHeights }
    },
    getPaneRects(): { top: number; height: number }[] {
      if (size.width <= 0 || size.height <= 0) return []
      return computeLayout().panes.map((p) => ({ top: p.top, height: p.height }))
    },
  }

  // Initial sizing + first paint.
  applySize()
  rebuildSeries() // empty until setData, but keeps renderSeries/ts consistent
  resetViewInternal()
  invalidate()

  return engine
}
