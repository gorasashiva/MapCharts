// CandL Charts — TradingView-style demo shell.
//
// Built entirely from the library's exported metadata + engine methods (the
// library ships no UI chrome): a top toolbar, a left drawing-tool rail, a
// multi-chart GRID (1/2/4), per-indicator SETTINGS (params + colors), SAVED
// LAYOUTS (incl. drawings, in localStorage), and a dark/light toggle.
//
// Run with:  npx vite examples/basic   (then open the printed localhost URL)
import {
  INTERVALS,
  INTERVAL_LABELS,
  INTERVAL_MS,
  CHART_TYPES,
  TOOL_GROUPS,
  checkAndFireAlerts,
  ensureNotificationPermission,
  playTune,
  ALERT_TUNES,
  primeAlertAudio,
  onAlertAudioBlocked,
  isAlertAudioBlocked,
  DEFAULT_SETTINGS as ENGINE_DEFAULT_SETTINGS,
  type Interval,
  type ChartType,
  type Theme,
  type DrawingToolId,
  type Alert,
} from '../../src/index'
import { el, ICONS, registerPopover, closeAllPopovers, layoutPreview, toHex } from './ui'
import { ChartPane, defaultIndicatorInstance, type PaneState, type IndicatorInstance } from './pane'
import type { BigTradesOptions } from '../../src/overlays/bigTrades'
import type { HeavyAbsorptionOverlayOptions } from '../../src/overlays/heavyAbsorption'
import type { FvgStrategyOptions } from '../../src/overlays/fvgStrategy'
import type { IvFadeOptions } from '../../src/overlays/ivFade'
import { sessionOpenHourUTC, sessionOpenLabelIST } from '../../src/core/session'
import { CPR_TIMEFRAME_LABEL, MAX_PERIODS as CPR_MAX_PERIODS, type CprTimeframe, type PivotType } from '../../src/overlays/cpr'
import type { DcBigTradesOptions } from '../../src/overlays/dcBigTrades'
import type { UltraV2Options } from '../../src/overlays/ultraV2'
import type { DeepTradesOptions } from '../../src/overlays/deepTrades'
import type { VolumeProfileOptions } from '../../src/overlays/volumeProfile'
import type { FootprintOptions } from '../../src/overlays/footprint'
import type { GexOptions } from './gex'
import type { GexV2Options } from './gexV2'
import type { FlagPatternsOptions } from './flagPatterns'
import { ALL_INDICATORS, resolveIndicator, getSignalSource } from './custom-indicators'
import type { Candle } from '../../src/index'
import { OptionsView } from './options'
import { GexDashboardView } from './gexDashboard'
import { DomDashboardView } from './domDashboard'
import { UnifiedProvider } from './provider'
import { Watchlist } from './watchlist'
import { TradeBuddy, BUDDY_ICON } from './buddy'
import { ContextMenu } from './contextmenu'
import { installShortcuts } from './shortcuts'
import { fetchOptionChain, SUPPORTED_OPTION_UNDERLYINGS, type OptionUnderlying } from './options'
import { selectWeeklyIronCondor } from './deltaNeutralPredictor'
import { StrategyTester } from './strategyTester'
import { PaperTrading } from './paperTrading'
import { SymbolDetails, displayZoneLabel } from './symbolDetails'
import { ObjectTree, DataWindow, type TreeSection } from './sidePanels'
import { openIndicatorsDialog, getFavoriteIndicators, STAR_ICON, type IndicatorsDialogHost } from './indicatorsDialog'
import { setDisplayTimeZone, getDisplayTimeZone } from '../../src/chart/scales'
import './v3.css'
import './v4.css'
import { loadChartSettings, saveChartSettings, openChartSettings, type ChartSettingsV4 } from './chartSettings'
import { openCommandPalette, type PaletteAction } from './commandPalette'
import { AlertsPanel, OrderBookPanel } from './sidePanels'
import { COMPARE_COLORS } from './paneExtras'
import { indicatorFamily } from './indicatorCatalog'
import { symbolLogo } from './symbolMeta'
import { CANDLE_PALETTES, getCandlePalette, isCandlePaletteId, type CandlePaletteId } from '../../src/chart/themes'

const headerEl = document.getElementById('tv-header')!
const railEl = document.getElementById('tv-rail')!
const footerEl = document.getElementById('tv-footer')!
const gridEl = document.getElementById('grid')!
const optionsEl = document.getElementById('options')!
const gexdashEl = document.getElementById('gexdash')!
const domdashEl = document.getElementById('domdash')!
const watchlistEl = document.getElementById('tv-watchlist')!
const buddyEl = document.getElementById('tv-buddy')!
const widgetBarEl = document.getElementById('tv-widgetbar')!
if (!headerEl || !railEl || !footerEl || !gridEl || !optionsEl || !gexdashEl || !domdashEl || !watchlistEl || !buddyEl)
  throw new Error('demo: layout containers missing')

// ----------------------------------------------------------------------------
// Static config.
// ----------------------------------------------------------------------------
const GRID_LAYOUTS: Record<string, { count: number; cols: string; rows: string; label: string }> = {
  '1': { count: 1, cols: '1fr', rows: '1fr', label: 'Single' },
  '2h': { count: 2, cols: '1fr 1fr', rows: '1fr', label: 'Two columns' },
  '2v': { count: 2, cols: '1fr', rows: '1fr 1fr', label: 'Two rows' },
  '3h': { count: 3, cols: '1fr 1fr 1fr', rows: '1fr', label: 'Three columns' },
  '4': { count: 4, cols: '1fr 1fr', rows: '1fr 1fr', label: 'Grid 2×2' },
}
const LAYOUT_PREVIEW: Record<string, string> = {
  '1': layoutPreview(1, 1),
  '2h': layoutPreview(2, 1),
  '2v': layoutPreview(1, 2),
  '3h': layoutPreview(3, 1),
  '4': layoutPreview(2, 2),
}
// Delta India's own symbols: USD-quoted perpetuals, plus its INR spot pairs.
const DEFAULT_SYMBOLS = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD']
const SEARCH_POPULAR = ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'XAUTUSD', 'PAXGUSD', 'BTC_INR', 'ETH_INR']
const CHART_TYPE_LABELS: Record<string, string> = {
  candles: 'Candles', volcandles: 'Volume candles', hollow: 'Hollow candles', heikin: 'Heikin Ashi',
  bars: 'Bars', hlcbars: 'HLC bars', hlcarea: 'HLC area', line: 'Line', linemarkers: 'Line + markers',
  step: 'Step line', area: 'Area', baseline: 'Baseline', columns: 'Columns', highlow: 'High–low',
  renko: 'Renko', kagi: 'Kagi', linebreak: 'Line break', pnf: 'Point & figure', range: 'Range', footprint: 'Volume footprint',
}
/** Curated subset for the right-click menu's quick chart-type switch (the full picker is in the header dropdown). */
const QUICK_CHART_TYPES = ['candles', 'heikin', 'bars', 'line', 'area']
const UNIT_LABEL: Record<string, string> = { s: 'Seconds', m: 'Minutes', h: 'Hours', d: 'Days', w: 'Days' }
// Timeframes offered in this demo. The library's INTERVALS also includes 1s,
// which Delta doesn't publish — its finest candle is 5s — so it's left out
// rather than shown as a timeframe that quietly serves 5s bars. Everything
// else here is either native to Delta or aggregated from 5s (15s/30s).
const DEMO_INTERVALS: Interval[] = INTERVALS.filter((iv) => iv !== '1s')
const LS_KEY = 'candl.layouts'

function defaultPaneState(i: number): PaneState {
  return {
    symbol: DEFAULT_SYMBOLS[i % DEFAULT_SYMBOLS.length],
    interval: '1m',
    chartType: 'candles',
    indicators: [defaultIndicatorInstance('volume')],
    drawings: [],
    tradeRain: true,
    buySellPoll: true,
  }
}

// ----------------------------------------------------------------------------
// App state.
// ----------------------------------------------------------------------------
const provider = new UnifiedProvider()
const watchlist = new Watchlist(provider)
const contextMenu = new ContextMenu()
let theme: Theme = 'dark'
let panes: ChartPane[] = []
let activeIdx = 0
let layoutKey = '1'
let magnet = false
/** Eraser mode on the active chart (click / drag over drawings deletes them). */
let eraserOn = false
/** Keep drawing tools armed after each placement (applies to every chart). */
let stayInDrawing = false
const active = (): ChartPane => panes[activeIdx]
const symbolDetails = new SymbolDetails(provider)
// Trade Buddy reads the active pane's symbol lazily, so it can be built before the panes.
const buddy = new TradeBuddy({
  fetchCandles: (symbol, tf, limit) => provider.fetchCandles(symbol, tf, limit),
  getSymbol: () => active()?.state.symbol ?? null,
  showLevels: (levels) => {
    for (const p of panes) p.setBuddyLevels(p === active() ? levels : null)
  },
})

/** Load `sym` into the active pane — shared by the symbol-search popover and the watchlist. */
function pickSymbol(sym: string): void {
  closeAllPopovers()
  exitReplay()
  for (const p of layoutSync.symbol ? panes : [active()]) void p.setSymbol(sym)
  symbolInput.value = sym.toUpperCase()
  watchlist.setActiveSymbol(sym)
  symbolDetails.setSymbol(sym)
  updateSymbolChip(sym.toUpperCase())
}

// ----- persistence (session + alerts) -----
function readJSON<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
const SESSION_KEY = 'candl.session'
const ALERTS_KEY = 'candl.alerts'
const ALERT_CFG_KEY = 'candl.alertCfg'
const TEMPLATES_KEY = 'candl.indicatorTemplates'
let alerts: Alert[] = readJSON<Alert[]>(ALERTS_KEY, [])
const alertCfg = readJSON(ALERT_CFG_KEY, { soundOn: true, tune: 0, duration: 2 })
const lastPriceBySym = new Map<string, number>()
let alertSeq = 0

// Toolbar update hooks (assigned during build).
let symbolInput: HTMLInputElement
let intervalLabelSpan: HTMLElement
let intervalMenu: HTMLElement
let chartTypeMenu: HTMLElement
let indMenu: HTMLElement
let layoutMenu: HTMLElement
let savedMenu: HTMLElement
let alertMenu: HTMLElement
let alertBadge: HTMLElement
let vpBtn: HTMLButtonElement
let themeBtn: HTMLButtonElement
let railItems: HTMLElement[] = []
let cursorItem: HTMLElement
// bar replay
let replayActive = false
let replayPane: ChartPane | null = null
let replayIndex = 0
let replayPlaying = false
let replaySpeed = 1
let replayTimer: number | null = null
let replayBar: HTMLElement
let replaySlider: HTMLInputElement
let replayPos: HTMLElement
let replayPlayBtn: HTMLButtonElement
let replayToggleBtn: HTMLButtonElement
type AppMode = 'charts' | 'options' | 'gex' | 'dom'
let mode: AppMode = 'charts'
let strategyTester: StrategyTester | null = null
let strategyTesterBtn: HTMLButtonElement | null = null
let paper: PaperTrading | null = null
let spotControls: HTMLElement
const modeButtons: Partial<Record<AppMode, HTMLElement>> = {}
const optionsView = new OptionsView(optionsEl, theme)
const gexDashboardView = new GexDashboardView(gexdashEl)
const domDashboardView = new DomDashboardView(domdashEl, provider, () => active()?.state.interval ?? '1m')
domDashboardView.start() // runs in the background so the DOM view never starts over
const footerStatus = el('div', { class: 'status loading' })
const footerDot = el('span', { class: 'dot' })
const footerText = el('span', {}, 'loading…')
footerStatus.append(footerDot, footerText)

// ----------------------------------------------------------------------------
// Grid management.
// ----------------------------------------------------------------------------
function makePane(state: PaneState): ChartPane {
  const p = new ChartPane(provider, theme, state)
  p.setPriceTagLabels(priceTagLabels)
  p.onActivate = () => setActive(panes.indexOf(p))
  // Legend row actions act on that pane, so make it the active one first.
  p.onIndicatorSettings = (defId) => {
    setActive(panes.indexOf(p))
    openIndicatorSettings(defId)
  }
  p.onIndicatorsChanged = () => {
    if (panes[activeIdx] === p) {
      refreshIndicatorsMenu()
      refreshSidePanels()
    }
  }
  p.onDrawingsUpdate = () => {
    if (panes[activeIdx] === p) refreshSidePanels()
    syncDrawingsFrom(p)
  }
  p.onHistoryChange = () => {
    if (panes[activeIdx] === p) syncUndoButtons()
  }
  p.onLegendIndexChange = () => {
    if (panes[activeIdx] === p) scheduleDataWindow()
  }
  p.engine.setStayInDrawingMode(stayInDrawing)
  applySettingsTo(p)
  p.engine.setDrawingsHidden(drawingsHiddenAll)
  p.engine.setDrawingsLocked(drawingsLockedAll)
  // Layout sync: crosshair + visible time range follow the chart being used.
  p.onCrosshairTime = (t) => {
    if (!layoutSync.crosshair) return
    for (const q of panes) if (q !== p) q.engine.setExternalCrosshair(t)
  }
  p.onViewChange = () => {
    if (!layoutSync.time || panes[activeIdx] !== p || panes.length < 2) return
    const r = p.engine.getVisibleTimeRange()
    if (!r) return
    for (const q of panes) if (q !== p) q.engine.setVisibleTimeRange(r.from, r.to)
  }
  p.onComparesChanged = () => applySettingsTo(p)
  p.onPercentToggle = (next) => updateChartSettings({ priceMode: next })
  // The axis corner opens the footer's time-zone menu (after this click finishes,
  // so the document click that closes popovers doesn't close it straight away).
  p.onTimeZoneCorner = () => {
    window.addEventListener('mouseup', () => setTimeout(() => (document.querySelector('.tz-dd .foot-clock') as HTMLElement | null)?.click(), 0), { once: true })
  }
  p.onStatusChange = () => {
    if (panes[activeIdx] === p) syncFooter()
  }
  p.onToolDone = () => {
    if (panes[activeIdx] === p) setRailActive(null)
  }
  p.onTick = fireFor // every live tick evaluates this symbol's alerts
  p.onData = () => {
    if (panes[activeIdx] === p) updatePaneAlerts()
  }
  p.onAlertRemove = (id) => removeAlert(id)
  p.onAlertMove = (id, price) => moveAlert(id, price)
  p.onAddAlert = (sym, price) => addAlert(sym, price) // "+" on the price scale
  p.onContextMenu = (info) => {
    setActive(panes.indexOf(p))
    const canvasRect = p.getCanvasRect()
    const pageX = canvasRect.left + info.x
    const pageY = canvasRect.top + info.y
    const priceLabel = info.price.toFixed(2)
    contextMenu.show(pageX, pageY, [
      [
        { label: 'Reset chart view', hint: '⌥R', onClick: () => p.engine.resetView() },
        { label: `Add alert at ${priceLabel}`, hint: '⌥A', onClick: () => addAlert(p.state.symbol, info.price) },
        { label: `Copy price ${priceLabel}`, hint: '⌘C', onClick: () => void navigator.clipboard?.writeText(String(info.price)) },
      ],
      paper?.hasSession && chartSettings.chartMenuOrders
        ? [
            { label: `Paper buy limit ${chartSettings.paperQty} @ ${priceLabel}`, onClick: () => placeChartOrder('buy', info.price) },
            { label: `Paper sell limit ${chartSettings.paperQty} @ ${priceLabel}`, onClick: () => placeChartOrder('sell', info.price) },
          ]
        : [],
      [
        p.engine.getCursorLock() === null
          ? { label: 'Lock vertical cursor here', onClick: () => setCursorLockAll(info.time) }
          : { label: 'Unlock vertical cursor', onClick: () => setCursorLockAll(null) },
        { label: `${drawingsHiddenAll ? 'Show' : 'Hide'} all drawings`, hint: '⌘⌥H', onClick: () => setDrawingsHiddenAll(!drawingsHiddenAll) },
        { label: `${drawingsLockedAll ? 'Unlock' : 'Lock'} all drawings`, onClick: () => setDrawingsLockedAll(!drawingsLockedAll) },
        { label: 'Remove all drawings', danger: true, onClick: () => p.clearDrawings() },
      ],
      [
        { label: `Price scale: ${chartSettings.priceMode === 'percent' ? 'back to price' : 'percent'}`, onClick: () => updateChartSettings({ priceMode: chartSettings.priceMode === 'percent' ? 'price' : 'percent' }) },
        { label: `${chartSettings.invert ? 'Un-invert' : 'Invert'} scale`, onClick: () => updateChartSettings({ invert: !chartSettings.invert }) },
        ...QUICK_CHART_TYPES.map((t) => ({ label: `Chart type: ${CHART_TYPE_LABELS[t] ?? t}`, onClick: () => p.setChartType(t as ChartType) })),
      ],
      [
        { label: 'Object tree', onClick: () => setDockView('objects') },
        { label: 'Chart settings…', onClick: () => openSettingsDialog() },
      ],
    ])
  }
  void p.reload()
  return p
}

function applyGridCss(def: { count: number; cols: string; rows: string }): void {
  gridEl.style.gridTemplateColumns = def.cols
  gridEl.style.gridTemplateRows = def.rows
  gridEl.classList.toggle('single', def.count === 1)
}

function setLayout(key: string): void {
  const def = GRID_LAYOUTS[key]
  if (!def) return
  exitReplay() // panes may be destroyed/reshuffled
  layoutKey = key
  while (panes.length < def.count) {
    const p = makePane(defaultPaneState(panes.length))
    panes.push(p)
    gridEl.appendChild(p.root)
    p.refresh()
  }
  while (panes.length > def.count) {
    panes.pop()!.destroy()
  }
  applyGridCss(def)
  if (activeIdx >= panes.length) activeIdx = 0
  setActive(activeIdx)
  updateLayoutSel()
}

function setActive(i: number): void {
  if (replayActive && panes[i] !== replayPane) exitReplay() // don't strand a clipped pane
  activeIdx = i
  panes.forEach((p, idx) => {
    p.root.classList.toggle('active', idx === i)
    // The eraser is a mode of the active chart only.
    p.engine.setEraser(idx === i && eraserOn)
  })
  active()?.setMagnet(magnet)
  setRailActive(null)
  syncToolbar()
  syncUndoButtons()
  refreshSidePanels()
}

// ----------------------------------------------------------------------------
// Toolbar ⇄ active pane sync.
// ----------------------------------------------------------------------------
function markSel(menu: HTMLElement, attr: string, value: string): void {
  menu.querySelectorAll('.menu-item').forEach((n) => {
    const on = (n as HTMLElement).getAttribute(attr) === value
    n.classList.toggle('sel', on)
    const check = n.querySelector('.mi-check') as HTMLElement | null
    if (check) check.textContent = on ? '✓' : ''
  })
}
function syncFooter(): void {
  const p = active()
  if (!p) return
  footerStatus.className = `status ${p.status}`
  const ageMs = p.lastUpdateAt ? Date.now() - p.lastUpdateAt : 0
  const freshness = ageMs > 0
    ? ageMs < 5_000
      ? 'live now'
      : ageMs < 60_000
        ? `updated ${Math.floor(ageMs / 1000)}s ago`
        : `stale ${Math.floor(ageMs / 60_000)}m ago`
    : ''
  footerText.textContent = [p.state.symbol, p.state.interval, p.statusDetail, freshness].filter(Boolean).join(' · ')
}
function syncToolbar(): void {
  const p = active()
  if (!p) return
  symbolInput.value = p.state.symbol
  setIntervalLabel(p.state.interval)
  markSel(intervalMenu, 'data-iv', p.state.interval)
  markSel(chartTypeMenu, 'data-ct', p.state.chartType)
  refreshIndicatorsMenu()
  updatePaneAlerts()
  if (vpBtn) vpBtn.classList.toggle('active', p.volumeProfile)
  watchlist.setActiveSymbol(p.state.symbol)
  symbolDetails.setSymbol(p.state.symbol)
  updateSymbolChip(p.state.symbol)
  syncFooter()
}

// ----------------------------------------------------------------------------
// Header: symbol search.
// ----------------------------------------------------------------------------
function buildSymbol(): HTMLElement {
  const wrap = el('div', { class: 'dd' })
  const trigger = el('button', { class: 'tv-btn symbol-btn', title: 'Symbol search' })
  symbolInput = el('input', { class: 'symbol-input', value: DEFAULT_SYMBOLS[0], spellcheck: 'false', 'aria-label': 'Symbol' })
  chipLogo = el('span', { class: 'chip-logo' }, ICONS.search)
  chipTag = el('span', { class: 'chip-tag' })
  chipTag.style.display = 'none'
  trigger.append(chipLogo, symbolInput, chipTag)

  const menu = el('div', { class: 'dd-menu' })
  const box = el('input', { class: 'menu-search', placeholder: 'Search e.g. ETH, SOL…' })
  const results = el('div', {})
  menu.append(box, results)
  wrap.append(trigger, menu)
  registerPopover(wrap, trigger, menu)

  const pick = pickSymbol
  // Spot pairs are "BTC_INR"; every derivative is "<ASSET>USD".
  const popular = SEARCH_POPULAR.map((s) =>
    s.includes('_')
      ? { symbol: s, base: s.split('_')[0], quote: s.split('_')[1] }
      : { symbol: s, base: s.replace(/USD$/, ''), quote: 'USD' },
  )
  const render = (list: { symbol: string; base: string; quote: string }[], head: string): void => {
    results.innerHTML = ''
    results.appendChild(el('div', { class: 'menu-head' }, head))
    for (const s of list.slice(0, 12)) {
      const item = el('div', { class: 'menu-item' })
      const label = s.symbol.includes('-')
        ? `<b>${s.symbol}</b>` // option symbol — show it in full
        : `<b>${s.base}</b><span style="opacity:.55">${s.quote}</span>`
      item.appendChild(el('span', { class: 'mi-grow' }, label))
      item.addEventListener('click', () => pick(s.symbol))
      results.appendChild(item)
    }
  }
  render(popular, 'Popular')

  let searchGen = 0
  box.addEventListener('input', async () => {
    const q = box.value.trim()
    const gen = ++searchGen
    if (!q) return render(popular, 'Popular')
    try {
      const found = await provider.searchSymbols(q)
      if (gen === searchGen) render(found, 'Results')
    } catch {
      /* offline — keep last list */
    }
  })
  box.addEventListener('click', (e) => e.stopPropagation())
  symbolInput.addEventListener('click', (e) => e.stopPropagation())
  symbolInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = symbolInput.value.trim()
      if (v) pick(v)
      symbolInput.blur()
    }
  })
  return wrap
}

// ----------------------------------------------------------------------------
// Header: interval dropdown.
// ----------------------------------------------------------------------------
/** Favourite timeframes shown inline in the header, TradingView-style; the rest live in the dropdown. */
const FAVOURITE_INTERVALS: Interval[] = (['1m', '5m', '15m', '1h', '4h', '1d'] as Interval[]).filter((iv) => DEMO_INTERVALS.includes(iv))
const favouriteButtons = new Map<string, HTMLElement>()
const shortInterval = (iv: string): string => (iv === '1d' ? 'D' : iv === '1w' ? 'W' : iv)
/** Reflect the active timeframe: highlight its favourite, or name it on the dropdown when it isn't one. */
function setIntervalLabel(iv: string): void {
  for (const [k, b] of favouriteButtons) b.classList.toggle('active', k === iv)
  intervalLabelSpan.textContent = favouriteButtons.has(iv) ? '' : shortInterval(iv)
}
/** Switch timeframe on the active chart (or every chart when interval sync is on). */
function chooseInterval(iv: Interval): void {
  setIntervalLabel(iv)
  markSel(intervalMenu, 'data-iv', iv)
  closeAllPopovers()
  exitReplay()
  for (const p of layoutSync.interval ? panes : [active()]) void p.setInterval(iv)
}
function buildInterval(): HTMLElement {
  const group = el('div', { class: 'interval-group', role: 'group', 'aria-label': 'Timeframe' })
  const choose = chooseInterval
  for (const iv of FAVOURITE_INTERVALS) {
    const b = el('button', { class: 'tv-btn iv-fav', title: INTERVAL_LABELS[iv] }, shortInterval(iv))
    b.addEventListener('click', () => choose(iv))
    favouriteButtons.set(iv, b)
    group.appendChild(b)
  }
  const wrap = el('div', { class: 'dd' })
  const trigger = el('button', { class: 'tv-btn iv-more', title: 'More timeframes' })
  intervalLabelSpan = el('span', { class: 'iv-current' }, '')
  trigger.append(intervalLabelSpan, el('span', { class: 'chev' }, ICONS.chevron))
  intervalMenu = el('div', { class: 'dd-menu' })
  wrap.append(trigger, intervalMenu)
  registerPopover(wrap, trigger, intervalMenu)
  group.appendChild(wrap)

  let lastUnit = ''
  for (const iv of DEMO_INTERVALS) {
    const unit = UNIT_LABEL[iv.slice(-1)] ?? ''
    if (unit !== lastUnit) {
      intervalMenu.appendChild(el('div', { class: 'menu-head' }, unit))
      lastUnit = unit
    }
    const item = el('div', { class: 'menu-item', 'data-iv': iv })
    item.append(
      el('span', { class: 'mi-check' }, ''),
      el('span', { class: 'mi-grow' }, INTERVAL_LABELS[iv]),
      el('span', { style: 'opacity:.55' }, iv),
    )
    item.addEventListener('click', () => choose(iv as Interval))
    intervalMenu.appendChild(item)
  }
  return group
}

// ----------------------------------------------------------------------------
// Header: chart-type dropdown.
// ----------------------------------------------------------------------------
function buildChartType(): HTMLElement {
  const wrap = el('div', { class: 'dd' })
  const trigger = el('button', { class: 'tv-btn', title: 'Chart type' })
  trigger.append(el('span', {}, ICONS.candles), el('span', { class: 'chev' }, ICONS.chevron))
  chartTypeMenu = el('div', { class: 'dd-menu' })
  wrap.append(trigger, chartTypeMenu)
  registerPopover(wrap, trigger, chartTypeMenu)

  for (const t of CHART_TYPES) {
    const item = el('div', { class: 'menu-item', 'data-ct': t })
    item.append(el('span', { class: 'mi-check' }, ''), el('span', { class: 'mi-grow' }, CHART_TYPE_LABELS[t] ?? t))
    item.addEventListener('click', () => {
      markSel(chartTypeMenu, 'data-ct', t)
      closeAllPopovers()
      exitReplay() // cursor maps to the render series, which chart-type changes
      active().setChartType(t as ChartType)
    })
    chartTypeMenu.appendChild(item)
  }
  return wrap
}

// ----------------------------------------------------------------------------
// Header: indicators (add / remove / settings) on the active pane.
// ----------------------------------------------------------------------------
// ----- indicator templates (save the current set, apply to any chart) -----
// A template is the whole chart setup — indicators, every power tool / strategy
// (on/off + options), chart type — minus what belongs to the chart itself
// (symbol, interval, drawings). Older templates were a bare indicator array.
type ChartTemplate = Omit<PaneState, 'symbol' | 'interval' | 'drawings' | 'drawingsBySymbol'>
type StoredTemplate = ChartTemplate | IndicatorInstance[]
const loadTemplates = (): Record<string, StoredTemplate> => readJSON(TEMPLATES_KEY, {})
function templateFromState(s: PaneState): ChartTemplate {
  const { symbol: _s, interval: _i, drawings: _d, drawingsBySymbol: _b, ...setup } = JSON.parse(JSON.stringify(s)) as PaneState
  return setup
}
/** Indicators + switched-on tools/strategies, for the "(N)" next to a template's name. */
function templateCount(t: StoredTemplate): number {
  if (Array.isArray(t)) return t.length
  let n = t.indicators?.length ?? 0
  for (const [k, v] of Object.entries(t)) {
    if (k === 'legendExpanded' || k === 'indicators') continue
    if (v === true) n++
    else if (v && typeof v === 'object' && !Array.isArray(v) && (v as { enabled?: unknown }).enabled === true) n++
  }
  return n
}
function saveTemplate(name: string): boolean {
  const m = loadTemplates()
  m[name] = templateFromState(active().state)
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(m))
    return true
  } catch {
    // Storage quota exceeded (or disabled) — the template was NOT persisted.
    return false
  }
}
function applyTemplate(name: string): void {
  const tpl = loadTemplates()[name]
  if (!tpl) return
  if (Array.isArray(tpl)) {
    // Legacy indicator-only template: swap indicators, leave tools as they are.
    active().state.indicators = JSON.parse(JSON.stringify(tpl)) as IndicatorInstance[]
    active().renderIndicators()
    refreshIndicatorsMenu()
    return
  }
  // Overlays read their options at construction, so rebuild the pane from the
  // merged state (same path as restoring a saved layout) — keeps this chart's
  // symbol, interval and drawings.
  exitReplay()
  const old = active()
  const { symbol, interval, drawings, drawingsBySymbol } = old.state
  const state: PaneState = { ...(JSON.parse(JSON.stringify(tpl)) as ChartTemplate), symbol, interval, drawings, drawingsBySymbol }
  const p = makePane(state)
  gridEl.insertBefore(p.root, old.root)
  old.destroy()
  panes[activeIdx] = p
  p.refresh()
  setActive(activeIdx)
}
function deleteTemplate(name: string): void {
  const m = loadTemplates()
  delete m[name]
  try {
    localStorage.setItem(TEMPLATES_KEY, JSON.stringify(m))
  } catch {
    /* quota */
  }
  refreshIndicatorsMenu()
}

// The Indicators button opens the full browser dialog (indicatorsDialog.ts);
// the ★ caret beside it is a quick menu of favourite indicators.
const indicatorsHost: IndicatorsDialogHost = {
  candles: () => active()?.candles ?? [],
  isOnChart: (id) => !!active()?.hasIndicator(id),
  add: (id) => {
    active().addIndicator(id)
    refreshIndicatorsMenu()
    refreshSidePanels()
  },
  remove: (id) => {
    active().removeIndicator(id)
    refreshIndicatorsMenu()
    refreshSidePanels()
  },
  openSettings: (id) => openIndicatorSettings(id),
  templates: () => Object.entries(loadTemplates()).map(([name, t]) => ({ name, count: templateCount(t) })),
  applyTemplate: (name) => applyTemplate(name),
  saveTemplate: (name) => saveTemplate(name),
  deleteTemplate: (name) => deleteTemplate(name),
}

function refreshIndicatorsMenu(): void {
  if (!indMenu) return
  indMenu.innerHTML = ''
  const p = active()
  if (!p) return

  indMenu.appendChild(el('div', { class: 'menu-head' }, 'Favorite indicators'))
  const favs = getFavoriteIndicators().map((id) => resolveIndicator(id)).filter((d): d is NonNullable<typeof d> => !!d)
  if (!favs.length) {
    indMenu.appendChild(el('div', { class: 'menu-hint' }, 'Star indicators in the Indicators dialog to pin them here.'))
  }
  for (const def of favs) {
    const on = p.hasIndicator(def.id)
    const row = el('div', { class: `menu-item${on ? ' sel' : ''}`, title: on ? 'Remove from chart' : 'Add to chart' })
    row.append(el('span', { class: 'mi-check' }, on ? '✓' : '+'), el('span', { class: 'mi-grow' }, def.label), el('span', { style: 'opacity:.55' }, def.shortLabel))
    if (on && getSignalSource(def.id)) {
      const bt = el('button', { class: 'mi-icon', title: 'Strategy tester (backtest signals)' }, ICONS.stats)
      bt.addEventListener('click', (e) => {
        e.stopPropagation()
        closeAllPopovers()
        openStrategyTester(def.id)
      })
      row.appendChild(bt)
    }
    row.addEventListener('click', () => {
      if (on) p.removeIndicator(def.id)
      else p.addIndicator(def.id)
      refreshIndicatorsMenu()
      refreshSidePanels()
    })
    indMenu.appendChild(row)
  }
  indMenu.appendChild(el('div', { class: 'menu-sep' }))
  const link = (label: string, section: Parameters<typeof openIndicatorsDialog>[1]): void => {
    const row = el('div', { class: 'menu-item' })
    row.append(el('span', { class: 'mi-grow' }, label))
    row.addEventListener('click', () => {
      closeAllPopovers()
      openIndicatorsDialog(indicatorsHost, section)
    })
    indMenu.appendChild(row)
  }
  link('Browse all indicators…', 'all')
  link(`On this chart (${p.state.indicators.length})`, 'on-chart')
  link(`Templates (${Object.keys(loadTemplates()).length})`, 'templates')
}
function buildIndicators(): HTMLElement {
  const wrap = el('div', { class: 'dd split-btn' })
  const trigger = el('button', { class: 'tv-btn', title: 'Indicators', 'aria-haspopup': 'dialog' })
  trigger.append(el('span', {}, ICONS.indicators), el('span', {}, 'Indicators'))
  trigger.addEventListener('click', () => {
    closeAllPopovers()
    openIndicatorsDialog(indicatorsHost, 'all')
  })
  const caret = el('button', { class: 'tv-btn split-caret', title: 'Favorite indicators', 'aria-label': 'Favorite indicators' }, STAR_ICON)
  indMenu = el('div', { class: 'dd-menu' })
  wrap.append(trigger, caret, indMenu)
  registerPopover(wrap, caret, indMenu)
  caret.addEventListener('click', refreshIndicatorsMenu)
  return wrap
}

// ----------------------------------------------------------------------------
// Strategy tester — backtest an indicator's signals (stop-and-reverse model).
// ----------------------------------------------------------------------------
interface BacktestResult {
  count: number
  wins: number
  losses: number
  net: number
  winRate: number
  profitFactor: number
  avgWin: number
  avgLoss: number
  maxDD: number
  equity: number[]
}
function backtest(candles: Candle[], signals: { time: number; kind: 'buy' | 'sell' }[]): BacktestResult {
  const closeAt = new Map<number, number>()
  for (const c of candles) closeAt.set(c.time, c.close)
  let pos: 'long' | 'short' | null = null
  let entry = 0
  const pnls: number[] = []
  for (const s of signals) {
    const dir: 'long' | 'short' = s.kind === 'buy' ? 'long' : 'short'
    const px = closeAt.get(s.time)
    if (px == null) continue
    if (pos && pos !== dir) {
      pnls.push(pos === 'long' ? px - entry : entry - px) // close on the opposite flip
      pos = null
    }
    if (pos !== dir) {
      pos = dir
      entry = px
    }
  }
  let net = 0
  let gp = 0
  let gl = 0
  let wins = 0
  const equity = [0]
  for (const pnl of pnls) {
    net += pnl
    equity.push(net)
    if (pnl > 0) {
      gp += pnl
      wins++
    } else {
      gl += -pnl
    }
  }
  let peak = 0
  let maxDD = 0
  for (const e of equity) {
    if (e > peak) peak = e
    maxDD = Math.max(maxDD, peak - e)
  }
  const losses = pnls.length - wins
  return {
    count: pnls.length,
    wins,
    losses,
    net,
    winRate: pnls.length ? wins / pnls.length : 0,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgWin: wins ? gp / wins : 0,
    avgLoss: losses ? gl / losses : 0,
    maxDD,
    equity,
  }
}
/** Inline SVG line of the equity curve. */
function equitySvg(values: number[], w: number, h: number, color: string): string {
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
    .join(' ')
  const zeroY = (h - ((0 - min) / span) * h).toFixed(1)
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none"><line x1="0" y1="${zeroY}" x2="${w}" y2="${zeroY}" stroke="var(--border)" stroke-dasharray="3 3"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`
}
function openStrategyTester(defId: string): void {
  const p = active()
  const def = resolveIndicator(defId)
  const src = getSignalSource(defId)
  const inst = p.getIndicator(defId)
  if (!def || !src || !inst) return
  // Neutral 'flag' markers (e.g. Blast Candle) aren't directional trade
  // calls, so they don't participate in the backtest — only buy/sell do.
  const tradeSignals = src(p.candles, inst.params).filter(
    (s): s is typeof s & { kind: 'buy' | 'sell' } => s.kind === 'buy' || s.kind === 'sell',
  )
  const r = backtest(p.candles, tradeSignals)

  const fmt = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : '∞')
  const signed = (n: number): string => `${n >= 0 ? '+' : ''}${fmt(n)}`
  const stats: [string, string, string?][] = [
    ['Net P&L (pts)', signed(r.net), r.net >= 0 ? 'up' : 'down'],
    ['Total trades', String(r.count)],
    ['Win rate', `${(r.winRate * 100).toFixed(1)}%`],
    ['Profit factor', fmt(r.profitFactor, 2)],
    ['Wins / Losses', `${r.wins} / ${r.losses}`],
    ['Avg win / loss', `${fmt(r.avgWin)} / ${fmt(r.avgLoss)}`],
    ['Max drawdown', `-${fmt(r.maxDD)}`, 'down'],
  ]

  const backdrop = el('div', { class: 'modal-backdrop' })
  const modal = el('div', { class: 'modal' })
  modal.appendChild(el('h3', { class: 'modal-title' }, `Strategy Tester — ${def.label}`))
  if (r.count === 0) {
    modal.appendChild(el('div', { class: 'modal-head' }, 'No closed trades in the visible data'))
  } else {
    const grid = el('div', { class: 'bt-grid' })
    for (const [label, value, cls] of stats) {
      const cell = el('div', { class: 'bt-cell' })
      cell.append(el('div', { class: 'bt-label' }, label), el('div', { class: `bt-value ${cls ?? ''}` }, value))
      grid.appendChild(cell)
    }
    modal.appendChild(grid)
    modal.appendChild(el('div', { class: 'modal-head' }, 'Equity curve (points)'))
    modal.appendChild(el('div', { class: 'bt-equity' }, equitySvg(r.equity, 300, 70, r.net >= 0 ? '#26a69a' : '#ef5350')))
  }
  modal.appendChild(el('div', { class: 'bt-note' }, 'Stop-and-reverse model: enter on each signal, exit on the opposite one. Points = price units; commissions/slippage not modeled.'))
  const foot = el('div', { class: 'modal-foot' })
  const doneBtn = el('button', { class: 'btn btn-primary', style: 'margin-left:auto' }, 'Close')
  doneBtn.addEventListener('click', () => backdrop.remove())
  foot.appendChild(doneBtn)
  modal.appendChild(foot)
  backdrop.appendChild(modal)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove()
  })
  document.body.appendChild(backdrop)
}

// ----------------------------------------------------------------------------
// Indicator settings dialog (params + colors), editing the active pane.
// ----------------------------------------------------------------------------
function openIndicatorSettings(defId: string): void {
  const p = active()
  const def = resolveIndicator(defId)!
  const inst = p.getIndicator(defId)!
  if (!def || !inst) return // runtime guard; the `!` keeps types non-undefined inside closures

  const backdrop = el('div', { class: 'modal-backdrop' })
  const modal = el('div', { class: 'modal' })
  const close = (): void => backdrop.remove()

  modal.appendChild(el('h3', { class: 'modal-title' }, def.label))

  if (def.params.length) {
    if (!def.params[0].group) modal.appendChild(el('div', { class: 'modal-head' }, 'Inputs'))
    let group: string | undefined
    for (const param of def.params) {
      if (param.group && param.group !== group) modal.appendChild(el('div', { class: 'modal-head' }, param.group))
      group = param.group
      const set = (v: number): void => {
        inst.params[param.key] = v
        p.renderIndicators()
        renderColors()
      }
      const row = el('label', { class: 'field' })
      row.appendChild(el('span', { class: 'field-label' }, param.label))
      if (param.toggle) {
        const box = el('input', { type: 'checkbox' }) as HTMLInputElement
        box.checked = inst.params[param.key] !== 0
        box.addEventListener('change', () => set(box.checked ? 1 : 0))
        row.appendChild(box)
      } else if (param.options) {
        const sel = el('select', { class: 'field-input' }) as HTMLSelectElement
        for (const o of param.options) {
          const opt = el('option', { value: String(o.value) }, o.label) as HTMLOptionElement
          if (o.value === inst.params[param.key]) opt.selected = true
          sel.appendChild(opt)
        }
        sel.addEventListener('change', () => set(Number(sel.value)))
        row.appendChild(sel)
      } else {
        const input = el('input', { type: 'number', class: 'field-input', value: String(inst.params[param.key]) })
        if (param.min != null) input.min = String(param.min)
        if (param.max != null) input.max = String(param.max)
        if (param.step != null) input.step = String(param.step)
        input.addEventListener('change', () => {
          const v = Number(input.value)
          if (Number.isFinite(v)) set(v)
        })
        row.appendChild(input)
      }
      modal.appendChild(row)
    }
  }

  modal.appendChild(el('div', { class: 'modal-head' }, 'Style'))
  const colorBox = el('div', {})
  modal.appendChild(colorBox)
  function renderColors(): void {
    colorBox.innerHTML = ''
    const hidden = new Set(inst.hidden ?? [])
    for (const out of p.indicatorOutputs(defId)) {
      const isHidden = hidden.has(out.name)
      const row = el('div', { class: 'field' })

      const left = el('div', { class: 'field-left' })
      const eye = el('button', { class: 'mi-icon', title: isHidden ? 'Show line' : 'Hide line' }, isHidden ? ICONS.eyeOff : ICONS.eye)
      eye.addEventListener('click', () => {
        const h = new Set(inst.hidden ?? [])
        if (h.has(out.name)) h.delete(out.name)
        else h.add(out.name)
        inst.hidden = [...h]
        p.renderIndicators()
        renderColors()
      })
      left.append(eye, el('span', { class: `field-label${isHidden ? ' dim' : ''}` }, out.name))

      const ci = el('input', { type: 'color', class: 'field-color', value: inst.colors[out.name] ?? toHex(out.color) })
      ci.addEventListener('input', () => {
        inst.colors[out.name] = ci.value
        p.renderIndicators()
      })

      row.append(left, ci)
      colorBox.appendChild(row)
    }
  }
  renderColors()

  const foot = el('div', { class: 'modal-foot' })
  const removeBtn = el('button', { class: 'btn btn-danger' }, 'Remove')
  removeBtn.addEventListener('click', () => {
    p.removeIndicator(defId)
    refreshIndicatorsMenu()
    close()
  })
  const doneBtn = el('button', { class: 'btn btn-primary' }, 'Done')
  doneBtn.addEventListener('click', close)
  foot.append(removeBtn, doneBtn)
  modal.appendChild(foot)

  backdrop.appendChild(modal)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close()
  })
  document.body.appendChild(backdrop)
}

// ----------------------------------------------------------------------------
// Header: Power Tools — every optional per-pane overlay (trade rain through
// volume profile & TPO) in one dropdown, next to Layouts, instead of a row
// of buttons crammed into each pane's own head. Everything here dispatches
// to active() and only flips an overlay's own on/off or settings — none of
// it touches the chart engine (setData/indicators/zoom), so toggling or
// configuring a tool never affects the chart itself.
// ----------------------------------------------------------------------------
interface PowerTool {
  id: string
  label: string
  icon: string
  isOn: (p: ChartPane) => boolean
  setOn: (p: ChartPane, on: boolean) => void
  openSettings?: (p: ChartPane) => void
  action?: (p: ChartPane) => void
  /** Quick-switch dropdown shown on the tool's legend row. */
  legendSelect?: (p: ChartPane) => { title: string; value: string; options: [string, string][]; onChange(v: string): void }
}

function openModal(title: string): { backdrop: HTMLElement; modal: HTMLElement; close: () => void } {
  const backdrop = el('div', { class: 'modal-backdrop' })
  const modal = el('div', { class: 'modal' })
  const close = (): void => backdrop.remove()
  modal.appendChild(el('h3', { class: 'modal-title' }, title))
  backdrop.appendChild(modal)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close()
  })
  return { backdrop, modal, close }
}
function modalSelectField(modal: HTMLElement, label: string, value: string, options: [string, string][], onChange: (v: string) => void): HTMLSelectElement {
  const row = el('label', { class: 'field' })
  row.appendChild(el('span', { class: 'field-label' }, label))
  const select = el('select', { class: 'field-input' }) as HTMLSelectElement
  for (const [v, text] of options) {
    const o = el('option', { value: v }, text) as HTMLOptionElement
    if (v === value) o.selected = true
    select.appendChild(o)
  }
  select.addEventListener('change', () => onChange(select.value))
  row.appendChild(select)
  modal.appendChild(row)
  return select
}
/** Trading-day open: "Auto" follows the symbol (gold 03:30 IST, others 05:30 IST), or a fixed UTC hour. */
function modalSessionField(modal: HTMLElement, symbol: string, value: number | null, onChange: (v: number | null) => void): HTMLSelectElement {
  const options: [string, string][] = [['auto', `Auto — ${symbol} opens ${sessionOpenLabelIST(sessionOpenHourUTC(symbol))}`]]
  for (let h = 0; h < 24; h++) options.push([String(h), `${String(h).padStart(2, '0')}:00 UTC · ${sessionOpenLabelIST(h)}`])
  return modalSelectField(modal, 'Session start', value === null ? 'auto' : String(value), options, (v) => onChange(v === 'auto' ? null : Number(v)))
}
function modalNumField(modal: HTMLElement, label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLInputElement {
  const row = el('label', { class: 'field' })
  row.appendChild(el('span', { class: 'field-label' }, label))
  const input = el('input', { type: 'number', class: 'field-input', value: String(value), min: String(min), max: String(max), step: String(step) }) as HTMLInputElement
  input.addEventListener('change', () => {
    const v = parseFloat(input.value)
    if (Number.isFinite(v)) onChange(v)
  })
  row.appendChild(input)
  modal.appendChild(row)
  return input
}
function modalCheckField(modal: HTMLElement, label: string, checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const row = el('label', { class: 'field' })
  row.appendChild(el('span', { class: 'field-label' }, label))
  const input = el('input', { type: 'checkbox' }) as HTMLInputElement
  input.checked = checked
  input.addEventListener('change', () => onChange(input.checked))
  row.appendChild(input)
  modal.appendChild(row)
  return input
}
function modalColorField(modal: HTMLElement, label: string, value: string, onChange: (v: string) => void): void {
  const row = el('label', { class: 'field' })
  row.appendChild(el('span', { class: 'field-label' }, label))
  const input = el('input', { type: 'color', class: 'field-color', value }) as HTMLInputElement
  input.addEventListener('input', () => onChange(input.value))
  row.appendChild(input)
  modal.appendChild(row)
}
/**
 * TradingView-style settings dialog: title + "?" (reveals the explanation),
 * Inputs / Style tabs, Done. Each tab is rebuilt from current options on switch.
 */
function openTabbedModal(title: string, note: string | null, tabs: { label: string; build: (body: HTMLElement) => void }[]): void {
  const backdrop = el('div', { class: 'modal-backdrop' })
  const modal = el('div', { class: 'modal modal-tabbed', role: 'dialog', 'aria-label': title })
  const close = (): void => backdrop.remove()
  const head = el('div', { class: 'mt-head' })
  head.appendChild(el('h3', { class: 'modal-title' }, title))
  const noteEl = el('p', { class: 'mt-note', style: 'display:none' }, note ?? '')
  if (note) {
    const info = el('button', { class: 'mt-info', title: 'About', 'aria-label': `About ${title}` }, '?')
    info.addEventListener('click', () => (noteEl.style.display = noteEl.style.display === 'none' ? 'block' : 'none'))
    head.appendChild(info)
  }
  const x = el('button', { class: 'mt-close', title: 'Close', 'aria-label': 'Close' }, ICONS.close)
  x.addEventListener('click', close)
  head.appendChild(x)
  const bar = el('div', { class: 'mt-tabs', role: 'tablist' })
  const body = el('div', { class: 'mt-body' })
  const buttons = tabs.map((t, i) => {
    const b = el('button', { class: 'mt-tab', role: 'tab' }, t.label)
    b.addEventListener('click', () => select(i))
    bar.appendChild(b)
    return b
  })
  const select = (i: number): void => {
    buttons.forEach((b, j) => {
      b.classList.toggle('active', j === i)
      b.setAttribute('aria-selected', String(j === i))
    })
    body.replaceChildren()
    tabs[i].build(body)
  }
  const foot = el('div', { class: 'mt-foot' })
  const done = el('button', { class: 'btn btn-primary' }, 'Done')
  done.addEventListener('click', close)
  foot.appendChild(done)
  modal.append(head, noteEl, bar, body, foot)
  backdrop.appendChild(modal)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close()
  })
  select(0)
  document.body.appendChild(backdrop)
}

/** Level names beside price-scale tags — one workspace-wide preference. */
const TAG_LABELS_KEY = 'candl.priceTagLabels'
let priceTagLabels = ((): boolean => {
  try {
    return localStorage.getItem(TAG_LABELS_KEY) !== '0'
  } catch {
    return true
  }
})()
function tagLabelsField(body: HTMLElement): void {
  body.appendChild(el('div', { class: 'modal-head' }, 'Price scale'))
  modalCheckField(body, 'Level names beside price tags (all tools)', priceTagLabels, (v) => {
    priceTagLabels = v
    try {
      localStorage.setItem(TAG_LABELS_KEY, v ? '1' : '0')
    } catch {
      /* storage unavailable — applies for this session */
    }
    for (const pane of panes) pane.setPriceTagLabels(v)
  })
}

function modalDoneFoot(modal: HTMLElement, close: () => void): void {
  const foot = el('div', { class: 'modal-foot' })
  const doneBtn = el('button', { class: 'btn btn-primary' }, 'Done')
  doneBtn.style.marginLeft = 'auto'
  doneBtn.addEventListener('click', close)
  foot.appendChild(doneBtn)
  modal.appendChild(foot)
}

function openBigTradesSettings(p: ChartPane): void {
  const opts = p.getBigTradesOptions()
  const { backdrop, modal, close } = openModal('Big Trades')

  modal.appendChild(el('div', { class: 'modal-head' }, 'Filtering'))
  modalSelectField(modal, 'Calculation mode', opts.calculationMode, [
    ['cumulative', 'Cumulative trades'],
    ['order', 'Per taker order'],
    ['separate', 'Separate prints'],
  ], (v) => p.applyBigTradesOption({ calculationMode: v as BigTradesOptions['calculationMode'] }))
  modalSelectField(modal, 'Price location', opts.priceLocation, [
    ['any', 'Any'],
    ['high', 'At high'],
    ['low', 'At low'],
    ['highOrLow', 'At high or low'],
    ['body', 'Body'],
    ['upperWick', 'Upper wick'],
    ['lowerWick', 'Lower wick'],
  ], (v) => p.applyBigTradesOption({ priceLocation: v as BigTradesOptions['priceLocation'] }))
  const minVolInput = modalNumField(modal, 'Min volume', opts.minVolume, 0, 100_000, 1, (v) => p.applyBigTradesOption({ minVolume: v }))
  const maxVolInput = modalNumField(modal, 'Max volume (0 = none)', opts.maxVolume, 0, 1_000_000, 1, (v) => p.applyBigTradesOption({ maxVolume: v }))
  minVolInput.disabled = opts.autoFilter
  maxVolInput.disabled = opts.autoFilter
  let intensitySelect: HTMLSelectElement | null = null
  modalCheckField(modal, 'Auto filter', opts.autoFilter, (v) => {
    p.applyBigTradesOption({ autoFilter: v })
    minVolInput.disabled = v
    maxVolInput.disabled = v
    if (intensitySelect) intensitySelect.disabled = !v
  })
  intensitySelect = modalSelectField(modal, 'Intensity', opts.intensity, [
    ['low', 'Low ≈ 20/day'],
    ['medium', 'Medium ≈ 10/day'],
    ['strong', 'Strong ≈ 5/day'],
  ], (v) => p.applyBigTradesOption({ intensity: v as BigTradesOptions['intensity'] }))
  intensitySelect.disabled = !opts.autoFilter
  modalNumField(modal, 'Days to load', opts.daysToLoad, 1, 31, 1, (v) => p.applyBigTradesOption({ daysToLoad: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Appearance'))
  modalCheckField(modal, 'Fixed sizes', opts.fixedSizes, (v) => p.applyBigTradesOption({ fixedSizes: v }))
  modalNumField(modal, 'Min size (px)', opts.minSize, 4, 100, 1, (v) => p.applyBigTradesOption({ minSize: v }))
  modalNumField(modal, 'Max size (px)', opts.maxSize, 4, 200, 1, (v) => p.applyBigTradesOption({ maxSize: v }))
  modalNumField(modal, 'Opacity', opts.alpha, 0.1, 1, 0.05, (v) => p.applyBigTradesOption({ alpha: v }))
  modalNumField(modal, 'Historical sensitivity (σ)', opts.historicalZThreshold, 0.5, 5, 0.5, (v) => p.applyBigTradesOption({ historicalZThreshold: v }))
  modalCheckField(modal, 'Show value', opts.showValue, (v) => p.applyBigTradesOption({ showValue: v }))

  // Zones: reverse = the trade went against its candle (absorbed), trend = with it.
  modal.appendChild(el('div', { class: 'modal-head' }, 'Zones'))
  const zoneModes: [string, string][] = [
    ['all', 'All'],
    ['reverse', 'Reverse only'],
    ['trend', 'Trend only'],
    ['none', 'None'],
  ]
  modalSelectField(modal, 'Wick trades', opts.zoneWick, zoneModes, (v) => p.applyBigTradesOption({ zoneWick: v as BigTradesOptions['zoneWick'] }))
  modalSelectField(modal, 'Body trades', opts.zoneBody, zoneModes, (v) => p.applyBigTradesOption({ zoneBody: v as BigTradesOptions['zoneBody'] }))
  modalNumField(modal, 'Extend (bars)', opts.zoneExtendBars, 1, 500, 1, (v) => p.applyBigTradesOption({ zoneExtendBars: v }))

  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)
}

function openHeavyAbsorptionSettings(p: ChartPane): void {
  const opts = p.getHeavyAbsorptionOptions()
  const set = (patch: Partial<HeavyAbsorptionOverlayOptions>): void => p.applyHeavyAbsorptionOption(patch)
  const { backdrop, modal, close } = openModal('Heavy Absorption')

  // Big = rare for this symbol's own tape: a rolling percentile is steady on skewed crypto order sizes.
  modal.appendChild(el('div', { class: 'modal-head' }, 'Detection'))
  let pctInput: HTMLInputElement | null = null
  let kInput: HTMLInputElement | null = null
  modalSelectField(modal, 'Threshold method', opts.method, [
    ['percentile', 'Percentile (rarest orders)'],
    ['logSigma', 'Mean + k·σ of log size'],
    ['sigma', 'Mean + k·σ of size (classic)'],
  ], (v) => {
    set({ method: v as HeavyAbsorptionOverlayOptions['method'] })
    if (pctInput) pctInput.disabled = v !== 'percentile'
    if (kInput) kInput.disabled = v === 'percentile'
  })
  pctInput = modalNumField(modal, 'Percentile (99.95 = top 0.05%)', opts.percentile, 90, 99.999, 0.01, (v) => set({ percentile: v }))
  kInput = modalNumField(modal, 'Std-dev multiplier (k)', opts.stdMult, 0.5, 6, 0.1, (v) => set({ stdMult: v }))
  pctInput.disabled = opts.method !== 'percentile'
  kInput.disabled = opts.method === 'percentile'
  modalNumField(modal, 'Lookback (bars)', opts.lookback, 10, 2000, 10, (v) => set({ lookback: v }))
  modalNumField(modal, 'Min volume filter', opts.minVolume, 0, 1_000_000, 0.1, (v) => set({ minVolume: v }))
  modalSelectField(modal, 'Markers', opts.group, [
    ['bar', 'One per bar and side (total big volume)'],
    ['order', 'One per big order'],
  ], (v) => set({ group: v as HeavyAbsorptionOverlayOptions['group'] }))
  modalNumField(modal, 'Days of recorded tape', opts.daysToLoad, 1, 14, 1, (v) => set({ daysToLoad: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Absorption check'))
  modalNumField(modal, 'Confirmation bars', opts.confirmBars, 1, 50, 1, (v) => set({ confirmBars: v }))
  modalNumField(modal, 'Break tolerance (× ATR)', opts.tolAtr, 0, 3, 0.05, (v) => set({ tolAtr: v }))
  modalSelectField(modal, 'Show', opts.show, [
    ['all', 'All markers'],
    ['notFailed', 'Absorbed + pending'],
    ['absorbed', 'Absorbed only'],
  ], (v) => set({ show: v as HeavyAbsorptionOverlayOptions['show'] }))
  modalCheckField(modal, 'Level line until broken', opts.showLevels, (v) => set({ showLevels: v }))
  modalNumField(modal, 'Max level length (bars)', opts.maxLevelBars, 5, 2000, 5, (v) => set({ maxLevelBars: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Appearance'))
  modalColorField(modal, 'Bull (buy) circles', opts.bullColor, (v) => set({ bullColor: v }))
  modalColorField(modal, 'Bear (sell) circles', opts.bearColor, (v) => set({ bearColor: v }))
  modalColorField(modal, 'Text', opts.textColor, (v) => set({ textColor: v }))
  modalNumField(modal, 'Min size (px)', opts.minSize, 4, 100, 1, (v) => set({ minSize: v }))
  modalNumField(modal, 'Max size (px)', opts.maxSize, 4, 200, 1, (v) => set({ maxSize: v }))
  modalNumField(modal, 'Opacity', opts.alpha, 0.1, 1, 0.05, (v) => set({ alpha: v }))
  modalCheckField(modal, 'Show volume', opts.showValue, (v) => set({ showValue: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Alerts'))
  modalCheckField(modal, 'New big trade (at bar close)', opts.alertOnBarClose, (v) => set({ alertOnBarClose: v }))
  modalCheckField(modal, 'Absorption confirmed', opts.alertOnConfirm, (v) => set({ alertOnConfirm: v }))
  modalCheckField(modal, 'Sound', opts.alertSound, (v) => set({ alertSound: v }))

  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)
}

function openDeepTradesSettings(p: ChartPane): void {
  const opts = p.getDeepTradesOptions()
  const { backdrop, modal, close } = openModal('Deep Trades')

  const note = el(
    'p',
    {},
    'Approximates DeepCharts’ Deep Trades. That indicator needs a Level 2 feed with MBO (per-order book data), which no public exchange API exposes — this instead rebuilds taker orders from the trade tape (how many orders a cluster holds stands in for "many small orders") and reads the size resting at each price just before it was hit from the live order book, refills included (stands in for "a large resting order"). Recorded history has no book, so it shows circles only. Same intuition, not the same signal quality as true MBO.',
  )
  note.style.cssText = 'font-size:11.5px;color:var(--muted);line-height:1.5;margin:0 0 4px;'
  modal.appendChild(note)

  modal.appendChild(el('div', { class: 'modal-head' }, 'Filtering'))
  modalSelectField(
    modal,
    'Intensity',
    opts.intensity,
    [
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['strong', 'Strong'],
    ],
    (v) => p.applyDeepTradesOption({ intensity: v as DeepTradesOptions['intensity'] }),
  )
  const minVolInput = modalNumField(modal, 'Min trade size', opts.minVolume, 0, 100_000, 1, (v) => p.applyDeepTradesOption({ minVolume: v }))
  const minRestInput = modalNumField(modal, 'Min resting size', opts.minRestingSize, 0, 100_000, 1, (v) => p.applyDeepTradesOption({ minRestingSize: v }))
  minVolInput.disabled = opts.autoFilter
  minRestInput.disabled = opts.autoFilter
  modalCheckField(modal, 'Auto filter', opts.autoFilter, (v) => {
    p.applyDeepTradesOption({ autoFilter: v })
    minVolInput.disabled = v
    minRestInput.disabled = v
  })
  modalNumField(modal, 'Hollow: min taker orders', opts.hollowMinCount, 2, 20, 1, (v) => p.applyDeepTradesOption({ hollowMinCount: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Appearance'))
  modalNumField(modal, 'Min size (px)', opts.minSize, 4, 100, 1, (v) => p.applyDeepTradesOption({ minSize: v }))
  modalNumField(modal, 'Max size (px)', opts.maxSize, 4, 200, 1, (v) => p.applyDeepTradesOption({ maxSize: v }))
  modalNumField(modal, 'Opacity', opts.alpha, 0.1, 1, 0.05, (v) => p.applyDeepTradesOption({ alpha: v }))
  modalColorField(modal, 'Ask side (buy)', opts.askColor, (v) => p.applyDeepTradesOption({ askColor: v }))
  modalColorField(modal, 'Bid side (sell)', opts.bidColor, (v) => p.applyDeepTradesOption({ bidColor: v }))
  modalColorField(modal, 'Battle (diamond)', opts.battleColor, (v) => p.applyDeepTradesOption({ battleColor: v }))

  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)
}

function openFootprintSettings(p: ChartPane): void {
  const o = p.getFootprintOptions()
  const { backdrop, modal, close } = openModal('Volume Footprint')
  const set = (patch: Partial<FootprintOptions>): void => p.applyFootprintOption(patch)
  modalSelectField(modal, 'Display', o.mode, [
    ['bidask', 'Sell x Buy (bid x ask)'],
    ['delta', 'Delta (buy − sell)'],
    ['volume', 'Total volume'],
    ['profile', 'Profile per candle'],
  ], (v) => set({ mode: v as FootprintOptions['mode'] }))
  modalNumField(modal, 'Row size (price, 0 = auto)', o.rowSize, 0, 1e6, 0.01, (v) => set({ rowSize: v }))
  modalNumField(modal, 'Auto: rows per bar', o.autoRows, 4, 60, 1, (v) => set({ autoRows: v }))
  modalNumField(modal, 'Imbalance ratio %', o.imbalancePct, 110, 1000, 10, (v) => set({ imbalancePct: v }))
  modalNumField(modal, 'Value area %', Math.round(o.valueAreaPct * 100), 10, 100, 5, (v) => set({ valueAreaPct: v / 100 }))
  modalCheckField(modal, 'Show POC', o.showPoc, (v) => set({ showPoc: v }))
  modalCheckField(modal, 'Shade value area', o.showValueArea, (v) => set({ showValueArea: v }))
  modalCheckField(modal, 'Show delta / volume under bars', o.showTotals, (v) => set({ showTotals: v }))
  modalCheckField(modal, 'Yellow candles where delta disagrees with direction', o.divergenceCandles, (v) => set({ divergenceCandles: v }))
  modalNumField(modal, 'History depth (bars)', o.historyBars, 20, 2000, 10, (v) => set({ historyBars: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Trade signals'))
  const sigNote = el(
    'p',
    {},
    'Setups read off exact-trade footprint bars, each with entry, stop and target. Tested on ~150 h of recorded XAUT/BTC/ETH tape (5m): absorption and trapped traders taken only when price is stretched ≥ 1 average range from the 20-bar EMA won 50% at 2R (+0.5R gross, +0.24R after 0.02% costs; negative at 0.05%). Stacked-imbalance retests and delta divergence did not hold up after costs, so they start off. A small sample — the scorecard on the chart keeps the live record.',
  )
  sigNote.style.cssText = 'font-size:11.5px;color:var(--muted);line-height:1.5;margin:0 0 4px;'
  modal.appendChild(sigNote)
  modalCheckField(modal, 'Show trade signals', o.signals, (v) => set({ signals: v }))
  modalCheckField(modal, 'Absorption at extreme', o.sigAbsorb, (v) => set({ sigAbsorb: v }))
  modalCheckField(modal, 'Trapped traders', o.sigTrap, (v) => set({ sigTrap: v }))
  modalCheckField(modal, 'Stacked imbalance retest (weak in the study)', o.sigStack, (v) => set({ sigStack: v }))
  modalCheckField(modal, 'Delta divergence at extreme (weak in the study)', o.sigDiverge, (v) => set({ sigDiverge: v }))
  modalNumField(modal, 'Target (R multiple)', o.sigRR, 0.5, 10, 0.5, (v) => set({ sigRR: v }))
  modalNumField(modal, 'Reversals: stretch from EMA (avg ranges, 0 = off)', o.sigStretchAtr, 0, 5, 0.25, (v) => set({ sigStretchAtr: v }))
  modalNumField(modal, 'EMA length (bars)', o.sigTrendBars, 5, 200, 1, (v) => set({ sigTrendBars: v }))
  modalCheckField(modal, 'Show past signals and results', o.sigHistory, (v) => set({ sigHistory: v }))
  modalCheckField(modal, 'Alerts on new signals and exits', o.sigAlerts, (v) => set({ sigAlerts: v }))
  modalCheckField(modal, 'Alert sound', o.sigSound, (v) => set({ sigSound: v }))
  modalCheckField(modal, 'Draw a long/short position for each new signal', o.sigAutoDraw, (v) => set({ sigAutoDraw: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'GEX Sabers confluence'))
  const gexNote = el(
    'p',
    {},
    'Weighs each new signal against the GEX Sabers levels (Delta options: BTC, ETH, gold) at the moment it fires: a long whose low tested a GEX level, or a short whose high did, is tagged "@GEX", and the next GEX level past the entry (≥ 1R away) becomes a second target (TP2). GEX has no history, so past signals are never tagged and this combination is untested — the scorecard keeps its own live record.',
  )
  gexNote.style.cssText = 'font-size:11.5px;color:var(--muted);line-height:1.5;margin:0 0 4px;'
  modal.appendChild(gexNote)
  modalSelectField(modal, 'Use GEX levels', String(o.sigGex), [
    ['0', 'Off'],
    ['1', 'Tag signals at a GEX level'],
    ['2', 'Only signals at a GEX level (alerts, drawings, live)'],
  ], (v) => set({ sigGex: Number(v) }))
  modalNumField(modal, 'At a level = within (avg bar ranges)', o.sigGexNear, 0.1, 3, 0.1, (v) => set({ sigGexNear: v }))
  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)
}

function openVolumeProfileSettings(p: ChartPane): void {
  const opts = p.getVolumeProfileOptions()
  const { backdrop, modal, close } = openModal('Volume Profile & TPO')

  modal.appendChild(el('div', { class: 'modal-head' }, 'Data'))
  modalSelectField(modal, 'Mode', opts.mode, [
    ['profile', 'Profile (volume, delta-colored)'],
    ['delta', 'Delta (net buy − sell per row)'],
    ['tpo', 'TPO'],
  ], (v) => p.applyVolumeProfileOption({ mode: v as VolumeProfileOptions['mode'] }))
  modalSelectField(modal, 'Period', opts.period, [
    ['session', 'Session (fixed)'],
    ['bars', 'Last N bars'],
    ['visible', 'Visible range'],
  ], (v) => {
    p.applyVolumeProfileOption({ period: v as VolumeProfileOptions['period'] })
    barsInput.disabled = v !== 'bars'
  })
  const barsInput = modalNumField(modal, 'Bars count', opts.barsCount, 10, 5000, 10, (v) => p.applyVolumeProfileOption({ barsCount: v }))
  barsInput.disabled = opts.period !== 'bars'
  modalSelectField(modal, 'Placement', opts.placement, [
    ['right', 'Right'],
    ['left', 'Left'],
  ], (v) => p.applyVolumeProfileOption({ placement: v as VolumeProfileOptions['placement'] }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Shape'))
  modalNumField(modal, 'Rows (price bins)', opts.bins, 5, 100, 1, (v) => p.applyVolumeProfileOption({ bins: v }))
  modalNumField(modal, 'Value area %', opts.valueAreaPct, 0.1, 0.99, 0.05, (v) => p.applyVolumeProfileOption({ valueAreaPct: v }))
  modalNumField(modal, 'Width %', opts.widthPct, 0.05, 0.6, 0.01, (v) => p.applyVolumeProfileOption({ widthPct: v }))
  modalNumField(modal, 'Opacity', opts.alpha, 0.1, 1, 0.05, (v) => p.applyVolumeProfileOption({ alpha: v }))
  modalCheckField(modal, 'Show value (Delta mode)', opts.showValue, (v) => p.applyVolumeProfileOption({ showValue: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'VPOC / Value Area'))
  modalCheckField(modal, 'Show VPOC', opts.showVpoc, (v) => p.applyVolumeProfileOption({ showVpoc: v }))
  modalCheckField(modal, 'Show VAH', opts.showVah, (v) => p.applyVolumeProfileOption({ showVah: v }))
  modalCheckField(modal, 'Show VAL', opts.showVal, (v) => p.applyVolumeProfileOption({ showVal: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Supply / Demand zones (v2)'))
  const zoneNote = el(
    'p',
    {},
    'High-volume rows grouped into zones: below price = support (demand), above = resistance (supply). Strength 0–100 blends volume acceptance, buy/sell delta, how often price was rejected there, and concentration. Strong ≥70, Moderate 45–69, Weak <45. A heuristic, not a backtested probability.',
  )
  zoneNote.style.cssText = 'font-size:11.5px;color:var(--muted);line-height:1.5;margin:0 0 4px;'
  modal.appendChild(zoneNote)
  modalCheckField(modal, 'Show zones', opts.showZones, (v) => p.applyVolumeProfileOption({ showZones: v }))
  modalSelectField(modal, 'Which zones', opts.zoneFocus, [
    ['nearest', 'Nearest to price (declutter)'],
    ['all', 'All zones'],
  ], (v) => p.applyVolumeProfileOption({ zoneFocus: v as VolumeProfileOptions['zoneFocus'] }))
  modalNumField(modal, 'Zones per side (nearest mode)', opts.zonesPerSide, 1, 5, 1, (v) => p.applyVolumeProfileOption({ zonesPerSide: Math.round(v) }))
  modalNumField(modal, 'Merge zones split by ≤ N thin rows', opts.mergeGapRows, 0, 3, 1, (v) => p.applyVolumeProfileOption({ mergeGapRows: Math.round(v) }))
  modalNumField(modal, 'Zone threshold (% of VPOC volume)', opts.zoneThresholdPct, 10, 100, 5, (v) => p.applyVolumeProfileOption({ zoneThresholdPct: v }))
  modalCheckField(modal, 'Show strength labels', opts.showZoneLabels, (v) => p.applyVolumeProfileOption({ showZoneLabels: v }))
  modalNumField(modal, 'Hide zones below strength', opts.minZoneScore, 0, 100, 5, (v) => p.applyVolumeProfileOption({ minZoneScore: v }))
  modalCheckField(modal, 'Show LVN gaps (fast-travel areas)', opts.showLvn, (v) => p.applyVolumeProfileOption({ showLvn: v }))
  modalNumField(modal, 'LVN threshold (% of VPOC volume)', opts.lvnPct, 5, 60, 5, (v) => p.applyVolumeProfileOption({ lvnPct: v }))
  modalCheckField(modal, 'Previous session zones (Session period)', opts.showPrevSessionZones, (v) => p.applyVolumeProfileOption({ showPrevSessionZones: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Colors'))
  modalColorField(modal, 'Buy', opts.buyColor, (v) => p.applyVolumeProfileOption({ buyColor: v }))
  modalColorField(modal, 'Sell', opts.sellColor, (v) => p.applyVolumeProfileOption({ sellColor: v }))
  modalColorField(modal, 'VPOC', opts.vpocColor, (v) => p.applyVolumeProfileOption({ vpocColor: v }))
  modalColorField(modal, 'VAH', opts.vahColor, (v) => p.applyVolumeProfileOption({ vahColor: v }))
  modalColorField(modal, 'VAL', opts.valColor, (v) => p.applyVolumeProfileOption({ valColor: v }))

  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)
}

function openGexSettings(p: ChartPane): void {
  openTabbedModal(
    'GEX (Gamma Exposure)',
    'Only applies on BTCUSD/ETHUSD/XAUTUSD — derived from Delta Exchange India’s public options chain, using the exchange’s own published gamma and open interest. A model of dealer hedging pressure, not a measured fact.',
    [
      {
        label: 'Inputs',
        build: (body) => {
          const opts = p.getGexOptions()
          body.appendChild(el('div', { class: 'modal-head' }, 'Data'))
          modalNumField(body, 'Near expiries included', opts.nearExpiries, 1, 20, 1, (v) => p.applyGexOption({ nearExpiries: v }))
          modalNumField(body, 'Refresh interval (s)', opts.refreshMs / 1000, 15, 600, 15, (v) => p.applyGexOption({ refreshMs: v * 1000 }))
        },
      },
      {
        label: 'Style',
        build: (body) => {
          const opts = p.getGexOptions()
          body.appendChild(el('div', { class: 'modal-head' }, 'Levels'))
          modalCheckField(body, 'Call Wall', opts.showCallWall, (v) => p.applyGexOption({ showCallWall: v }))
          modalColorField(body, 'Call Wall colour', opts.callWallColor, (v) => p.applyGexOption({ callWallColor: v }))
          modalCheckField(body, 'Put Wall', opts.showPutWall, (v) => p.applyGexOption({ showPutWall: v }))
          modalColorField(body, 'Put Wall colour', opts.putWallColor, (v) => p.applyGexOption({ putWallColor: v }))
          modalCheckField(body, 'Net GEX Crossover', opts.showFlip, (v) => p.applyGexOption({ showFlip: v }))
          modalColorField(body, 'Crossover colour', opts.flipColor, (v) => p.applyGexOption({ flipColor: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Profile'))
          modalCheckField(body, 'Per-strike profile', opts.showProfile, (v) => p.applyGexOption({ showProfile: v }))
          tagLabelsField(body)
        },
      },
    ],
  )
}

function openGexV2Settings(p: ChartPane): void {
  const opts = p.getGexV2Options()
  const { backdrop, modal, close } = openModal('GEX V2 (Gamma Environment)')

  const note = el(
    'p',
    {},
    'Only applies on BTCUSD/ETHUSD/XAUTUSD. A live dashboard showing whether the market looks steady or fast-moving, and a directional setup only after wall break, crossover alignment, negative-gamma regime, and five-minute price confirmation agree. Built on the same options-chain data as GEX, not a separate feed.',
  )
  note.style.cssText = 'font-size:11.5px;color:var(--muted);line-height:1.5;margin:0 0 4px;'
  modal.appendChild(note)

  modal.appendChild(el('div', { class: 'modal-head' }, 'Data'))
  modalNumField(modal, 'Near expiries included', opts.nearExpiries, 1, 20, 1, (v) => p.applyGexV2Option({ nearExpiries: v }))
  modalNumField(modal, 'Refresh interval (s)', opts.refreshMs / 1000, 15, 600, 15, (v) => p.applyGexV2Option({ refreshMs: v * 1000 }))

  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)
}

function openIVWallsSettings(p: ChartPane): void {
  openTabbedModal(
    'IV Walls',
    'Dashed σ walls are ±0.5/1/1.5/2σ from the session open, sized by the nearest expiry’s option IV read off the smile on each side (BTCUSD/ETHUSD/XAUTUSD; other symbols use realized vol). Filled zones show where past sessions’ HOD/LOD landed, scaled to today’s realized σ. The “reversed in zone” rate is a walk-forward test, so each session is scored only against zones built before it. Delta publishes no historical IV, so earlier sessions are redrawn with HV walls.',
    [
      {
        label: 'Inputs',
        build: (body) => {
          const opts = p.getIVWallsOptions()
          body.appendChild(el('div', { class: 'modal-head' }, 'Session'))
          modalSessionField(body, p.state.symbol, opts.sessionStartHourUTC, (v) => p.applyIVWallsOption({ sessionStartHourUTC: v }))
          modalNumField(body, 'Past sessions drawn', opts.pastDays, 0, 30, 1, (v) => p.applyIVWallsOption({ pastDays: Math.round(v) }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Model'))
          modalNumField(body, 'HV lookback (sessions)', opts.hvLookback, 5, 60, 1, (v) => p.applyIVWallsOption({ hvLookback: Math.round(v) }))
          modalNumField(body, 'Calibration history (sessions)', opts.calibrationDays, 30, 500, 10, (v) => p.applyIVWallsOption({ calibrationDays: Math.round(v) }))
          modalNumField(body, 'Zone start (percentile of past HOD/LOD)', opts.zoneLo * 100, 10, 95, 5, (v) => p.applyIVWallsOption({ zoneLo: v / 100 }))
          modalNumField(body, 'Zone end (percentile)', opts.zoneHi * 100, 15, 99, 5, (v) => p.applyIVWallsOption({ zoneHi: v / 100 }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Data'))
          modalNumField(body, 'Refresh interval (s)', opts.refreshMs / 1000, 30, 900, 30, (v) => p.applyIVWallsOption({ refreshMs: v * 1000 }))
        },
      },
      {
        label: 'Style',
        build: (body) => {
          const opts = p.getIVWallsOptions()
          body.appendChild(el('div', { class: 'modal-head' }, 'Levels'))
          modalCheckField(body, 'σ walls', opts.showSigmaLines, (v) => p.applyIVWallsOption({ showSigmaLines: v }))
          modalColorField(body, 'σ walls colour', opts.lineColor, (v) => p.applyIVWallsOption({ lineColor: v }))
          modalCheckField(body, 'HOD / LOD zones', opts.showZones, (v) => p.applyIVWallsOption({ showZones: v }))
          modalColorField(body, 'HOD zone colour', opts.hodColor, (v) => p.applyIVWallsOption({ hodColor: v }))
          modalColorField(body, 'LOD zone colour', opts.lodColor, (v) => p.applyIVWallsOption({ lodColor: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Panels'))
          modalCheckField(body, 'Stats chip', opts.showPanel, (v) => p.applyIVWallsOption({ showPanel: v }))
          tagLabelsField(body)
        },
      },
    ],
  )
}

function openIvZonesSettings(p: ChartPane): void {
  openTabbedModal(
    'IV Expected-Move Zones',
    'Port of "IV walls modified V2.pine". AUTO: zones at the previous session close ± 0.5 / 1 / 1.5 × the expected move, EM = prev close × IV × scale ÷ √(days per year) × √(days ahead) — 252 days for gold (closed weekends), 365 for 24/7 crypto. The Pine script reads VIX / VXN / GVZ; here IV is the IV % you type (e.g. today\'s GVZ), else the live ATM IV of the nearest Delta options expiry (BTCUSD / ETHUSD / XAUTUSD), else realized volatility. Past sessions use realized volatility — Delta publishes no historical IV. MANUAL: your own wall levels × the conversion ratio, ± the half-thickness, red above the session open and green below.',
    [
      {
        label: 'Inputs',
        build: (body) => {
          const opts = p.getIvZonesOptions()
          const set = (patch: Parameters<ChartPane['applyIvZonesOption']>[0]): void => p.applyIvZonesOption(patch)
          body.appendChild(el('div', { class: 'modal-head' }, 'Mode'))
          modalSelectField(body, 'Mode', opts.mode, [['auto', 'Auto (expected move)'], ['manual', 'Manual (typed walls)']], (v) => set({ mode: v as 'auto' | 'manual' }))
          modalCheckField(body, "Keep previous sessions' zones", opts.showHistory, (v) => set({ showHistory: v }))
          modalNumField(body, 'Previous sessions kept', opts.historyDays, 1, 30, 1, (v) => set({ historyDays: Math.round(v) }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Auto mode'))
          modalNumField(body, 'IV override % (0 = options chain / HV)', opts.ivOverridePct ?? 0, 0, 300, 0.5, (v) => set({ ivOverridePct: v > 0 ? v : null }))
          modalNumField(body, 'IV scale', opts.ivScale, 0.1, 5, 0.05, (v) => set({ ivScale: v }))
          modalNumField(body, 'Trading days ahead', opts.daysAhead, 0.25, 20, 0.25, (v) => set({ daysAhead: v }))
          modalNumField(body, 'Level 1 (× expected move)', opts.m1, 0.05, 5, 0.05, (v) => set({ m1: v }))
          modalNumField(body, 'Level 2 (× expected move)', opts.m2, 0.05, 5, 0.05, (v) => set({ m2: v }))
          modalNumField(body, 'Level 3 (× expected move)', opts.m3, 0.05, 5, 0.05, (v) => set({ m3: v }))
          modalNumField(body, 'Zone thickness (fraction of EM)', opts.zoneFrac, 0.01, 1, 0.01, (v) => set({ zoneFrac: v }))
          modalNumField(body, 'HV fallback lookback (sessions)', opts.hvLookback, 5, 60, 1, (v) => set({ hvLookback: Math.round(v) }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Manual mode'))
          modalNumField(body, 'Conversion ratio', opts.manRatio, 0.0001, 1000, 0.01, (v) => set({ manRatio: v }))
          modalNumField(body, 'Zone half-thickness (points)', opts.manHalf, 0, 1000, 0.25, (v) => set({ manHalf: v }))
          opts.walls.forEach((w, i) =>
            modalNumField(body, `Wall ${i + 1} (0 = off)`, w, 0, 10_000_000, 0.01, (v) => {
              const walls = p.getIvZonesOptions().walls
              walls[i] = v
              set({ walls })
            }),
          )
        },
      },
      {
        label: 'Style',
        build: (body) => {
          const opts = p.getIvZonesOptions()
          const set = (patch: Parameters<ChartPane['applyIvZonesOption']>[0]): void => p.applyIvZonesOption(patch)
          modalColorField(body, 'Upper (resistance) colour', opts.resColor, (v) => set({ resColor: v }))
          modalColorField(body, 'Lower (support) colour', opts.supColor, (v) => set({ supColor: v }))
          modalCheckField(body, 'Zone labels (+0.5x / price)', opts.showLabels, (v) => set({ showLabels: v }))
        },
      },
    ],
  )
}

const CPR_TIMEFRAMES = Object.entries(CPR_TIMEFRAME_LABEL) as [CprTimeframe, string][]

function openCprSettings(p: ChartPane): void {
  openTabbedModal(
    'CPR & Pivots',
    'Central Pivot Range from the previous period: P = (H+L+C)/3, BC = (H+L)/2, TC = 2P − BC. R1–R4 / S1–S4 are floor pivots (Traditional matches TradingView’s Pivot Points Standard; Classic spaces R3/R4 by whole ranges). Each period’s levels span that period only; the previous period’s high/low (PDH/PDL, PWH/PWL, PMH/PML) are dashed. A narrow CPR versus recent sessions often precedes a trending day. In replay, levels follow the replayed bar.',
    [
      {
        label: 'Inputs',
        build: (body) => {
          const opts = p.getCprOptions()
          body.appendChild(el('div', { class: 'modal-head' }, 'Pivots'))
          modalSelectField(body, 'Timeframe', opts.timeframe, CPR_TIMEFRAMES, (v) => {
            p.applyCprOption({ timeframe: v as CprTimeframe })
            refreshToolLegends()
          })
          modalSelectField(
            body,
            'Pivot type',
            opts.pivotType,
            [
              ['traditional', 'Traditional'],
              ['classic', 'Classic'],
            ],
            (v) => p.applyCprOption({ pivotType: v as PivotType }),
          )
          modalNumField(body, 'Periods shown (current included)', opts.periods, 1, CPR_MAX_PERIODS, 1, (v) => p.applyCprOption({ periods: Math.round(v) }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Session'))
          modalSessionField(body, p.state.symbol, opts.sessionStartHourUTC, (v) => p.applyCprOption({ sessionStartHourUTC: v }))
        },
      },
      {
        label: 'Style',
        build: (body) => {
          const opts = p.getCprOptions()
          body.appendChild(el('div', { class: 'modal-head' }, 'Levels'))
          modalCheckField(body, 'CPR (P / TC / BC)', opts.showCpr, (v) => p.applyCprOption({ showCpr: v }))
          modalColorField(body, 'CPR colour', opts.cprColor, (v) => p.applyCprOption({ cprColor: v }))
          modalSelectField(
            body,
            'Support / resistance',
            String(opts.levels),
            [
              ['0', 'None'],
              ['1', 'R1 / S1'],
              ['2', 'Up to R2 / S2'],
              ['3', 'Up to R3 / S3'],
              ['4', 'Up to R4 / S4'],
            ],
            (v) => p.applyCprOption({ levels: Number(v) }),
          )
          modalColorField(body, 'Resistance colour', opts.resColor, (v) => p.applyCprOption({ resColor: v }))
          modalColorField(body, 'Support colour', opts.supColor, (v) => p.applyCprOption({ supColor: v }))
          modalCheckField(body, 'Previous high / low', opts.showPrevHL, (v) => p.applyCprOption({ showPrevHL: v }))
          modalColorField(body, 'Previous high / low colour', opts.prevHLColor, (v) => p.applyCprOption({ prevHLColor: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Labels'))
          modalCheckField(body, 'Level names on the chart', opts.showLabels, (v) => p.applyCprOption({ showLabels: v }))
          modalCheckField(body, 'Current levels on the price scale', opts.showTags, (v) => p.applyCprOption({ showTags: v }))
          tagLabelsField(body)
        },
      },
    ],
  )
}

function openDeltaNeutralDashboard(p: ChartPane): void {
  const { backdrop, modal, close } = openModal('Delta-Neutral Weekly Predictor')
  modal.classList.add('dnp-modal')
  const body = el('div', { class: 'dnp-loading' }, 'Loading live weekly option chain…')
  modal.appendChild(body)
  modal.appendChild(el('p', { class: 'dnp-disclaimer' }, 'Model estimate from the current Delta chain and IV. It is not a guaranteed probability, trade instruction, or backtest result.'))
  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)

  const symbol = p.state.symbol.toUpperCase()
  if (!(SUPPORTED_OPTION_UNDERLYINGS as readonly string[]).includes(symbol)) {
    body.textContent = `Weekly options analysis is currently available for BTCUSD, ETHUSD, and XAUTUSD. ${symbol} has no supported Delta option chain.`
    return
  }
  const spot = p.candles.length ? p.candles[p.candles.length - 1].close : 0
  void fetchOptionChain(symbol as OptionUnderlying).then((chain) => {
    const idea = selectWeeklyIronCondor(chain, spot)
    if (!idea) {
      body.textContent = 'No liquid 2–10 DTE weekly iron-condor candidate is available right now. Check again after the chain refreshes.'
      return
    }
    const date = new Date(idea.expiry).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: spot >= 100 ? 0 : 2 })
    const premium = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
    body.innerHTML = ''
    const badge = el('div', { class: `dnp-badge ${idea.quality}` }, idea.quality === 'candidate' ? 'RANGE CANDIDATE' : 'AVOID / HIGH-MOVE REGIME')
    const title = el('div', { class: 'dnp-expiry' }, `${date} · ${idea.dte} DTE · spot ${money(spot)}`)
    const stats = el('div', { class: 'dnp-grid' })
    const stat = (label: string, value: string) => {
      const cell = el('div', { class: 'dnp-stat' })
      cell.append(el('span', {}, label), el('strong', {}, value))
      stats.appendChild(cell)
    }
    stat('Modeled inside break-evens', `${idea.modeledInsidePct.toFixed(0)}%`)
    stat('Implied 1σ move', `±${idea.impliedMovePct.toFixed(1)}%`)
    stat('Break-even range', `${money(idea.breakEvenLow)} – ${money(idea.breakEvenHigh)}`)
    stat('Suggested net-credit limit', premium(idea.suggestedCredit))
    stat('Profit if range holds to expiry*', `$${premium(idea.maxProfitPerContract)}`)
    stat('50% credit take-profit*', `$${premium(idea.earlyTakeProfitPerContract)}`)
    stat('Max loss / contract*', `$${premium(idea.maxLoss * idea.shortPut.contractValue)}`)
    stat('Return on risk*', `${idea.returnOnRiskPct.toFixed(1)}%`)
    const legs = el('div', { class: 'dnp-legs' })
    legs.append(
      el('div', {}, `BUY  ${money(idea.longPut.strike)} Put   limit ${premium(idea.longPut.ask)} (ask)`),
      el('div', {}, `SELL ${money(idea.shortPut.strike)} Put   limit ${premium(idea.shortPut.bid)} (bid)`),
      el('div', {}, `SELL ${money(idea.shortCall.strike)} Call  limit ${premium(idea.shortCall.bid)} (bid)`),
      el('div', {}, `BUY  ${money(idea.longCall.strike)} Call  limit ${premium(idea.longCall.ask)} (ask)`),
    )
    body.append(badge, title, stats, legs, el('p', { class: 'dnp-reason' }, `${idea.reason} If the modelled range holds and price expires between the two short strikes, the displayed expiry profit is the full net credit. Between a short strike and its break-even, profit is smaller; outside break-evens, the trade loses. *Before fees/slippage; per one option contract (${idea.shortPut.contractValue} base units). Mid credit: ${premium(idea.credit)}; conservative fill credit: ${premium(idea.conservativeCredit)}.`))
  }).catch(() => {
    body.textContent = 'Delta option-chain data is unavailable or rate-limited. Try again shortly.'
  })
}

function openFlagPatternsSettings(p: ChartPane): void {
  const opts = p.getFlagPatternsOptions()
  const { backdrop, modal, close } = openModal('Auto Flag Patterns')

  const note = el(
    'p',
    {},
    'Detects the classic flag: a strong impulsive move (the pole) followed by a tight consolidation that breaks out with volume confirmation. Shows both the live forming flag and confirmed historical ones on whatever timeframe is loaded.',
  )
  note.style.cssText = 'font-size:11.5px;color:var(--muted);line-height:1.5;margin:0 0 4px;'
  modal.appendChild(note)

  modal.appendChild(el('div', { class: 'modal-head' }, 'Pole'))
  modalNumField(modal, 'Pole length (bars)', opts.poleLen, 3, 50, 1, (v) => p.applyFlagPatternsOption({ poleLen: v }))
  modalNumField(modal, 'Min pole strength (x avg range)', opts.poleMinAtrMult, 1, 10, 0.1, (v) => p.applyFlagPatternsOption({ poleMinAtrMult: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Flag'))
  modalNumField(modal, 'Min bars', opts.flagMinBars, 1, 30, 1, (v) => p.applyFlagPatternsOption({ flagMinBars: v }))
  modalNumField(modal, 'Max bars', opts.flagMaxBars, 3, 60, 1, (v) => p.applyFlagPatternsOption({ flagMaxBars: v }))
  modalNumField(modal, 'Max retrace (fraction of pole)', opts.flagMaxRetrace, 0.1, 1, 0.05, (v) => p.applyFlagPatternsOption({ flagMaxRetrace: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Breakout'))
  modalNumField(modal, 'Volume confirm (x average)', opts.volumeMult, 1, 5, 0.1, (v) => p.applyFlagPatternsOption({ volumeMult: v }))

  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)
}

function openUltraV2Settings(p: ChartPane): void {
  const opts = p.getUltraV2Options()
  const { backdrop, modal, close } = openModal('Ultra V2')
  const set = (patch: Partial<UltraV2Options>): void => p.applyUltraV2Option(patch)
  const check = (label: string, key: keyof UltraV2Options): void => {
    modalCheckField(modal, label, opts[key] as boolean, (v) => set({ [key]: v }))
  }

  modal.appendChild(el('div', { class: 'modal-head' }, 'VWAP'))
  check('Show VWAP', 'showVwap')
  check('VWAP line', 'showVwapLine')
  modalSelectField(modal, 'Bands mode', opts.vwapBandsMode, [
    ['stdev', 'Standard deviation'],
    ['pct', 'Percentage'],
  ], (v) => set({ vwapBandsMode: v as UltraV2Options['vwapBandsMode'] }))
  check('Band #1', 'showVwapBand1')
  modalNumField(modal, 'Band #1 multiplier', opts.vwapBand1Mult, 0.1, 10, 0.1, (v) => set({ vwapBand1Mult: v }))
  check('Band #2', 'showVwapBand2')
  modalNumField(modal, 'Band #2 multiplier', opts.vwapBand2Mult, 0.1, 10, 0.1, (v) => set({ vwapBand2Mult: v }))
  check('Band #3', 'showVwapBand3')
  modalNumField(modal, 'Band #3 multiplier', opts.vwapBand3Mult, 0.1, 10, 0.1, (v) => set({ vwapBand3Mult: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Initial Balance'))
  check('Show Initial Balance', 'showIB')
  modalNumField(modal, 'IB window (minutes)', opts.ibMinutes, 5, 480, 5, (v) => set({ ibMinutes: v }))
  check('Completed IB boxes', 'showIBBoxes')
  check('Live (forming) IB box', 'showIBLiveBox')
  check('IB high / low lines', 'showIBHighLow')
  check('Extension levels (x2 / x3)', 'showIBExtraLevels')
  check('Intermediate levels (50%)', 'showIBIntermediateLevels')
  check('IB delta table', 'showIBDeltaTable')

  modal.appendChild(el('div', { class: 'modal-head' }, 'Session Volume Profile'))
  check('Show Session Volume Profile', 'showSVP')
  check('Histogram', 'showSvpHistogram')
  check('Value-area shading', 'showSvpValueAreaFill')
  check('POC line', 'showPoc')
  check('VAH / VAL lines', 'showVahVal')
  check('Demand / supply zones', 'showSvpZones')
  modalNumField(modal, 'Zone threshold (% of POC volume)', opts.svpZoneThresholdPct, 10, 100, 5, (v) => set({ svpZoneThresholdPct: v }))
  modalNumField(modal, 'Rows', opts.svpRows, 5, 200, 1, (v) => set({ svpRows: Math.round(v) }))
  modalNumField(modal, 'Value area (%)', Math.round(opts.svpValueAreaPct * 100), 10, 100, 1, (v) => set({ svpValueAreaPct: v / 100 }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'TJR BOS 2.0'))
  check('Show BOS', 'showBOS')
  check('Bullish breaks', 'showBosUp')
  check('Bearish breaks', 'showBosDown')

  modal.appendChild(el('div', { class: 'modal-head' }, 'Supertrend'))
  check('Show Supertrend', 'showSupertrend')
  check('Uptrend line', 'showSupertrendUp')
  check('Downtrend line', 'showSupertrendDown')
  modalNumField(modal, 'ATR period', opts.atrPeriod, 1, 100, 1, (v) => set({ atrPeriod: Math.round(v) }))
  modalNumField(modal, 'Factor', opts.atrFactor, 0.1, 20, 0.1, (v) => set({ atrFactor: v }))

  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)
}

function openCprStrategySettings(p: ChartPane): void {
  openTabbedModal(
    'CPR Strategy',
    'Two-mode Day-CPR playbook, built and backtested on 5m XAUTUSD. On a NARROW CPR day (width in the narrowest 30% of the last 20 sessions) it BUYs the first 5m close above R1 / SELLs the first close below S1, stop 0.1×ATR beyond the level, target 3R. On any other day it waits for price to close outside the CPR and then back inside, and trades back through it (stop 0.3×ATR, target 1R). One trade per session; open trades exit at the session end. Signals use closed candles only, so labels never repaint. Card figures are R multiples net of Delta India fees.',
    [
      {
        label: 'Inputs',
        build: (body) => {
          const opts = p.getCprStrategyOptions()
          body.appendChild(el('div', { class: 'modal-head' }, 'Narrow-CPR breakout'))
          modalNumField(body, 'Narrow = narrowest % of last 20 sessions', opts.narrowPct * 100, 5, 60, 5, (v) => p.applyCprStrategyOption({ narrowPct: v / 100 }))
          modalNumField(body, 'Stop beyond R1/S1 (× ATR)', opts.breakoutStopAtr, 0.05, 1, 0.05, (v) => p.applyCprStrategyOption({ breakoutStopAtr: v }))
          modalNumField(body, 'Target (R)', opts.breakoutTargetR, 0.5, 6, 0.5, (v) => p.applyCprStrategyOption({ breakoutTargetR: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'CPR reclaim'))
          modalNumField(body, 'Stop (× ATR)', opts.reclaimStopAtr, 0.1, 1, 0.05, (v) => p.applyCprStrategyOption({ reclaimStopAtr: v }))
          modalNumField(body, 'Target (R)', opts.reclaimTargetR, 0.5, 4, 0.25, (v) => p.applyCprStrategyOption({ reclaimTargetR: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Filters'))
          const cutoffs: [string, string][] = [['off', 'Any time'], ...[12, 15, 18, 21].map((h): [string, string] => [String(h * 60), `${h}:00 IST`])]
          modalSelectField(body, 'No new entries from', opts.entryCutoffIST === null ? 'off' : String(opts.entryCutoffIST), cutoffs, (v) =>
            p.applyCprStrategyOption({ entryCutoffIST: v === 'off' ? null : Number(v) }),
          )
          modalCheckField(body, 'Take longs (BUY)', opts.allowLongs, (v) => p.applyCprStrategyOption({ allowLongs: v }))
          modalCheckField(body, 'Take shorts (SELL)', opts.allowShorts, (v) => p.applyCprStrategyOption({ allowShorts: v }))
        },
      },
      {
        label: 'Style',
        build: (body) => {
          const opts = p.getCprStrategyOptions()
          body.appendChild(el('div', { class: 'modal-head' }, 'On the chart'))
          modalCheckField(body, 'BUY / SELL labels', opts.showSignals, (v) => p.applyCprStrategyOption({ showSignals: v }))
          modalCheckField(body, 'Exit markers (TP / SL / END)', opts.showExits, (v) => p.applyCprStrategyOption({ showExits: v }))
          modalCheckField(body, 'Stop & target lines', opts.showTradeLines, (v) => p.applyCprStrategyOption({ showTradeLines: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Panels'))
          modalCheckField(body, 'Backtest card', opts.showStats, (v) => p.applyCprStrategyOption({ showStats: v }))
        },
      },
    ],
  )
}

function openHalfTrendSettings(p: ChartPane): void {
  openTabbedModal(
    'HalfTrend',
    'Port of "halftrend.pine" (everget). The line follows the highest recent low in an uptrend (blue) and the lowest recent high in a downtrend (red), flipping when the amplitude-bar average crosses it and price closes beyond the prior bar. The channel is the line ± deviation × ATR(100)/2; Buy / Sell marks each flip. Like the Pine script it updates on the forming candle, so the latest flip can change until that candle closes.',
    [
      {
        label: 'Inputs',
        build: (body) => {
          const opts = p.getHalfTrendOptions()
          body.appendChild(el('div', { class: 'modal-head' }, 'Calculation'))
          modalNumField(body, 'Amplitude', opts.amplitude, 1, 50, 1, (v) => p.applyHalfTrendOption({ amplitude: Math.round(v) }))
          modalNumField(body, 'Channel deviation', opts.channelDeviation, 0, 10, 0.5, (v) => p.applyHalfTrendOption({ channelDeviation: v }))
        },
      },
      {
        label: 'Style',
        build: (body) => {
          const opts = p.getHalfTrendOptions()
          body.appendChild(el('div', { class: 'modal-head' }, 'Visuals'))
          modalCheckField(body, 'Arrows', opts.showArrows, (v) => p.applyHalfTrendOption({ showArrows: v }))
          modalCheckField(body, 'ATR channel', opts.showChannels, (v) => p.applyHalfTrendOption({ showChannels: v }))
          modalCheckField(body, 'Buy / Sell labels', opts.showLabels, (v) => p.applyHalfTrendOption({ showLabels: v }))
        },
      },
    ],
  )
}

function openFvVwapEmaSettings(p: ChartPane): void {
  const windows: [string, string][] = [
    ['210-1080', '03:30 – 18:00 IST (Asia + London)'],
    ['210-750', '03:30 – 12:30 IST (Asia)'],
    ['750-1080', '12:30 – 18:00 IST (London)'],
    ['off', 'Any time'],
  ]
  openTabbedModal(
    'FV + VWAP + EMA',
    'Port of "test strategy.pine": fractal vector, session VWAP with ±σ bands and EMA 9/21/50, plus BUY / SELL signals with stop, TP1 and TP2 drawn on the chart. ALIGNED FLIP — the chart vector flips in the higher-timeframe direction, the close is beyond VWAP but inside the band, and EMA 9 agrees with EMA 21. EMA21 PULLBACK — the HTFs, the chart vector and the 9>21>50 stack agree and price dips through EMA 21 and closes back. Both only enter within 0.75σ of VWAP (not chasing). Stop at the vector; by default half closes at TP1 = 1R, the stop moves to breakeven and the rest targets TP2 = 3R. AUTO-TUNE (on by default) uses the settings that tested best on weekday XAUTUSD: 1m — flip with 15m + 1h agreeing; 3m — flip with 1h; 5m — pullback with 15m + 1h, fractal 3. One trade at a time, closed candles only, flat at the session end. The card shows R before fees and net of Delta India fees — on 1m–5m gold the fees exceed most stops, so net figures are usually negative.',
    [
      {
        label: 'Inputs',
        build: (body) => {
          const opts = p.getFvVwapEmaOptions()
          const set = (patch: Parameters<ChartPane['applyFvVwapEmaOption']>[0]): void => p.applyFvVwapEmaOption(patch)
          body.appendChild(el('div', { class: 'modal-head' }, 'Fractal vector'))
          modalCheckField(body, 'Auto-tune for chart timeframe (1m / 3m / 5m)', opts.autoTune, (v) => set({ autoTune: v }))
          modalSelectField(body, 'Higher timeframe', String(opts.htfMinutes), [['15', '15m'], ['30', '30m'], ['60', '1h'], ['240', '4h']], (v) => set({ htfMinutes: Number(v) }))
          modalSelectField(body, 'Second HTF must agree', String(opts.htf2Minutes ?? 'off'), [['off', 'Off'], ['30', '30m'], ['60', '1h'], ['240', '4h']], (v) =>
            set({ htf2Minutes: v === 'off' ? null : Number(v) }),
          )
          modalNumField(body, 'Fractal length (bars each side)', opts.fracLen, 1, 10, 1, (v) => set({ fracLen: Math.round(v) }))
          body.appendChild(el('div', { class: 'modal-head' }, 'VWAP bands'))
          modalSelectField(body, 'Anchor', opts.vwapAnchor, [['Day', 'Day (session)'], ['Week', 'Week'], ['Month', 'Month']], (v) => set({ vwapAnchor: v as 'Day' | 'Week' | 'Month' }))
          modalNumField(body, 'Band multiplier', opts.bandMult, 0.25, 4, 0.25, (v) => set({ bandMult: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'EMAs'))
          modalNumField(body, 'EMA 1', opts.ema1, 1, 400, 1, (v) => set({ ema1: Math.round(v) }))
          modalNumField(body, 'EMA 2', opts.ema2, 1, 400, 1, (v) => set({ ema2: Math.round(v) }))
          modalNumField(body, 'EMA 3', opts.ema3, 1, 400, 1, (v) => set({ ema3: Math.round(v) }))
        },
      },
      {
        label: 'Signals',
        build: (body) => {
          const opts = p.getFvVwapEmaOptions()
          const set = (patch: Parameters<ChartPane['applyFvVwapEmaOption']>[0]): void => p.applyFvVwapEmaOption(patch)
          body.appendChild(el('div', { class: 'modal-head' }, opts.autoTune ? 'Setups (auto-tuned on 1m / 3m / 5m)' : 'Setups'))
          modalCheckField(body, 'Aligned flip', opts.flipSignals, (v) => set({ flipSignals: v }))
          modalCheckField(body, 'EMA 21 pullback', opts.pullbackSignals, (v) => set({ pullbackSignals: v }))
          modalSelectField(body, 'Max distance from VWAP', String(opts.maxVwapDistSigma ?? 'off'), [['0.5', '0.5σ'], ['0.75', '0.75σ (tested)'], ['1', '1σ'], ['off', 'Off']], (v) =>
            set({ maxVwapDistSigma: v === 'off' ? null : Number(v) }),
          )
          body.appendChild(el('div', { class: 'modal-head' }, 'Exits'))
          modalSelectField(body, 'Exit plan', opts.exitMode, [
            ['scale', 'Half at TP1 → breakeven, rest at TP2'],
            ['fixed', 'All at target'],
            ['trail', 'Trail: exit on vector flip'],
          ], (v) => set({ exitMode: v as 'scale' | 'fixed' | 'trail' }))
          modalNumField(body, 'TP1 (R) — scale-out', opts.tp1R, 0.25, 3, 0.25, (v) => set({ tp1R: v }))
          modalNumField(body, 'TP2 / target (R)', opts.targetR, 0.5, 6, 0.5, (v) => set({ targetR: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Risk'))
          modalNumField(body, 'Minimum stop (× ATR 14)', opts.minRiskAtr, 0, 5, 0.25, (v) => set({ minRiskAtr: v }))
          modalNumField(body, 'Skip stops wider than (× ATR 14)', opts.maxRiskAtr, 1, 20, 0.5, (v) => set({ maxRiskAtr: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Filters'))
          const cur = opts.entryWindowIST ? opts.entryWindowIST.join('-') : 'off'
          modalSelectField(body, 'Entry window', cur, windows, (v) =>
            set({ entryWindowIST: v === 'off' ? null : (v.split('-').map(Number) as [number, number]) }),
          )
          modalCheckField(body, 'Weekdays only', opts.weekdaysOnly, (v) => set({ weekdaysOnly: v }))
          modalCheckField(body, 'Take longs (BUY)', opts.allowLongs, (v) => set({ allowLongs: v }))
          modalCheckField(body, 'Take shorts (SELL)', opts.allowShorts, (v) => set({ allowShorts: v }))
        },
      },
      {
        label: 'Style',
        build: (body) => {
          const opts = p.getFvVwapEmaOptions()
          const set = (patch: Parameters<ChartPane['applyFvVwapEmaOption']>[0]): void => p.applyFvVwapEmaOption(patch)
          body.appendChild(el('div', { class: 'modal-head' }, 'On the chart'))
          modalCheckField(body, 'Fractal vector (chart TF)', opts.showLtfVector, (v) => set({ showLtfVector: v }))
          modalCheckField(body, 'Fractal vector (HTF)', opts.showHtfVector, (v) => set({ showHtfVector: v }))
          modalCheckField(body, 'VWAP', opts.showVwap, (v) => set({ showVwap: v }))
          modalCheckField(body, 'VWAP bands', opts.showBands, (v) => set({ showBands: v }))
          modalCheckField(body, 'EMAs', opts.showEmas, (v) => set({ showEmas: v }))
          modalCheckField(body, 'EMA floating labels', opts.showEmaLabels, (v) => set({ showEmaLabels: v }))
          modalCheckField(body, 'BUY / SELL labels', opts.showSignals, (v) => set({ showSignals: v }))
          modalCheckField(body, 'Entry / SL / TP1 / TP2 lines', opts.showTradeLevels, (v) => set({ showTradeLevels: v }))
          modalCheckField(body, 'Exit markers', opts.showExits, (v) => set({ showExits: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Panels'))
          modalCheckField(body, 'Backtest card', opts.showStats, (v) => set({ showStats: v }))
        },
      },
    ],
  )
}

function openZoneRetestSettings(p: ChartPane): void {
  openTabbedModal(
    'IV Zone Retest Strategy',
    'Built for gold on 5m / 15m. Zones: previous close ± 0.382 / 0.618 / 1 / 1.618 / 2.618 × EM (EM = prev close × 10-session return stdev × 0.75), each ±0.10 EM thick. LONG (shorts mirror): price breaks up through a zone and reaches the next zone; on the first pullback buy a limit at the broken zone\'s top edge; stop 0.15 EM below its bottom edge; half off at 1R with the stop to breakeven, the rest at the swing high; flat at session end. Filters: fills only 03:30–09:30 and 12:30–18:30 IST, skip days after a narrow-range day, skip days that opened against the trade, skip zones with a CPR / PDH / PDL level 0.1–0.25 × scale EM away, and the swing high must be at least 1R away. GRADE from DeepCharts big trades on 15m between the swing and the fill: in your direction = A (full size), none = B (half size), only against = skipped. Walk-forward on gold 2025–26: about 62% wins and +0.27R per trade overall; A trades about 69% wins and +0.47R. Card figures before fees and net of Delta fees.',
    [
      {
        label: 'Inputs',
        build: (body) => {
          const opts = p.getZoneRetestOptions()
          const set = (patch: Parameters<ChartPane['applyZoneRetestOption']>[0]): void => p.applyZoneRetestOption(patch)
          body.appendChild(el('div', { class: 'modal-head' }, 'Zones'))
          modalSelectField(body, 'Levels', opts.levels, [['fib', 'Fibonacci 0.382 / 0.618 / 1 / 1.618 (tested)'], ['standard', 'Standard 0.5 / 1 / 1.5']], (v) => set({ levels: v as 'fib' | 'standard' }))
          modalNumField(body, 'EM scale', opts.scale, 0.25, 2, 0.05, (v) => set({ scale: v }))
          modalNumField(body, 'Volatility lookback (sessions)', opts.hvLookback, 5, 60, 1, (v) => set({ hvLookback: Math.round(v) }))
          modalNumField(body, 'Zone half-thickness (× EM)', opts.half, 0.02, 0.3, 0.01, (v) => set({ half: v }))
          modalNumField(body, 'Stop beyond zone (× EM)', opts.stopBuffer, 0.05, 0.5, 0.05, (v) => set({ stopBuffer: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Filters'))
          modalCheckField(body, 'Only 03:30–09:30 and 12:30–18:30 IST', opts.sessionWindows, (v) => set({ sessionWindows: v }))
          modalCheckField(body, 'Skip days after a narrow-range day', opts.skipSmallRange, (v) => set({ skipSmallRange: v }))
          modalCheckField(body, 'Skip days that opened against the trade', opts.skipAgainstOpen, (v) => set({ skipAgainstOpen: v }))
          modalCheckField(body, 'Skip zones with a CPR level just beside them', opts.cprFilter, (v) => set({ cprFilter: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Big trades (15m)'))
          modalSelectField(body, 'Use big trades', opts.bigTrades, [['grade', 'Grade A / B, skip opposite (tested)'], ['A only', 'A trades only'], ['off', 'Off (all retests, no grade)']], (v) => set({ bigTrades: v as 'grade' | 'A only' | 'off' }))
          modalCheckField(body, 'Take longs (BUY)', opts.allowLongs, (v) => set({ allowLongs: v }))
          modalCheckField(body, 'Take shorts (SELL)', opts.allowShorts, (v) => set({ allowShorts: v }))
        },
      },
      {
        label: 'Style',
        build: (body) => {
          const opts = p.getZoneRetestOptions()
          const set = (patch: Parameters<ChartPane['applyZoneRetestOption']>[0]): void => p.applyZoneRetestOption(patch)
          modalCheckField(body, 'Strategy zones (faint bands, no text)', opts.showZones, (v) => set({ showZones: v }))
          modalCheckField(body, 'BUY / SELL labels with grade', opts.showSignals, (v) => set({ showSignals: v }))
          modalCheckField(body, 'Entry / SL / TP1 / TP2 lines', opts.showTradeLevels, (v) => set({ showTradeLevels: v }))
          modalCheckField(body, 'Exit markers (TP / SL / BE / END)', opts.showExits, (v) => set({ showExits: v }))
          modalCheckField(body, 'Strategy card', opts.showStats, (v) => set({ showStats: v }))
        },
      },
    ],
  )
}

function openIvFvStrategySettings(p: ChartPane): void {
  const windows: [string, string][] = [
    ['210-1080', '03:30 – 18:00 IST (Asia + London)'],
    ['210-750', '03:30 – 12:30 IST (Asia)'],
    ['750-1080', '12:30 – 18:00 IST (London)'],
    ['off', 'Any time'],
  ]
  openTabbedModal(
    'IV × FV Strategy',
    'Trades only — no indicator lines. Entries are the FV + VWAP + EMA signals, auto-tuned to the chart (1m: flip with 15m + 1h agreeing; 3m: flip with 1h; 5m: EMA21 pullback with 15m + 1h), only within 0.75σ of VWAP, 03:30–18:00 IST on weekdays. Stop at the fractal vector; half closes at TP1 = 1R and the stop moves to breakeven; TP2 is 3R or the next IV expected-move zone (prev close ± 0.5 / 1 / 1.5 × EM), whichever is nearer, if that zone is at least 2R away. Backtested on XAUTUSD May–Oct 2026, after a $0.30 spread: 3m +0.42R/trade, 67% win (the timeframe to watch); 1m +0.36R; 5m +0.19R. Optional ±1× ZONE FADE: limit at the first touch of the ±1× zone, stop just past it, target the previous close (28% win, +0.32R — off by default). Net of Delta India fees these are negative; card shows both.',
    [
      {
        label: 'Inputs',
        build: (body) => {
          const opts = p.getIvFvStrategyOptions()
          const set = (patch: Parameters<ChartPane['applyIvFvStrategyOption']>[0]): void => p.applyIvFvStrategyOption(patch)
          body.appendChild(el('div', { class: 'modal-head' }, 'Setups'))
          modalCheckField(body, 'Auto-tune for chart timeframe (1m / 3m / 5m)', opts.autoTune, (v) => set({ autoTune: v }))
          modalCheckField(body, '±1× IV zone fade (limit order)', opts.fadeSetup, (v) => set({ fadeSetup: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Targets'))
          modalNumField(body, 'TP1 (R) — half off, stop to breakeven', opts.tp1R, 0.25, 3, 0.25, (v) => set({ tp1R: v }))
          modalNumField(body, 'TP2 (R)', opts.targetR, 1, 6, 0.5, (v) => set({ targetR: v }))
          modalCheckField(body, 'Cap TP2 at the next IV zone', opts.zoneTargets, (v) => set({ zoneTargets: v }))
          modalNumField(body, 'Only if that zone is at least (R)', opts.zoneMinR, 1, 4, 0.5, (v) => set({ zoneMinR: v }))
          body.appendChild(el('div', { class: 'modal-head' }, 'IV zones'))
          modalNumField(body, 'IV override % (0 = option IV / HV)', opts.ivOverridePct ?? 0, 0, 300, 0.5, (v) => set({ ivOverridePct: v > 0 ? v : null }))
          body.appendChild(el('div', { class: 'modal-head' }, 'Filters'))
          const cur = opts.entryWindowIST ? opts.entryWindowIST.join('-') : 'off'
          modalSelectField(body, 'Entry window', cur, windows, (v) => set({ entryWindowIST: v === 'off' ? null : (v.split('-').map(Number) as [number, number]) }))
          modalCheckField(body, 'Take longs (BUY)', opts.allowLongs, (v) => set({ allowLongs: v }))
          modalCheckField(body, 'Take shorts (SELL)', opts.allowShorts, (v) => set({ allowShorts: v }))
        },
      },
      {
        label: 'Style',
        build: (body) => {
          const opts = p.getIvFvStrategyOptions()
          const set = (patch: Parameters<ChartPane['applyIvFvStrategyOption']>[0]): void => p.applyIvFvStrategyOption(patch)
          modalCheckField(body, 'BUY / SELL labels', opts.showSignals, (v) => set({ showSignals: v }))
          modalCheckField(body, 'Entry / SL / TP1 / TP2 lines', opts.showTradeLevels, (v) => set({ showTradeLevels: v }))
          modalCheckField(body, 'Exit markers (TP / SL / BE / END)', opts.showExits, (v) => set({ showExits: v }))
          modalCheckField(body, 'Strategy card', opts.showStats, (v) => set({ showStats: v }))
        },
      },
    ],
  )
}

function openFvgStrategySettings(p: ChartPane): void {
  const opts = p.getFvgStrategyOptions()
  const { backdrop, modal, close } = openModal('FVG + Supertrend Strategy')

  const note = el(
    'p',
    {},
    'BUY when price trades into a "bullish" FVG (a gap down, per the Pine source) with Supertrend green and close above it; SELL mirrors that. Exits on the opposite Supertrend flip. One position at a time, filled on bar close. Backtest numbers are % of entry price, no fees.',
  )
  note.style.cssText = 'font-size:11.5px;color:var(--muted);line-height:1.5;margin:0 0 4px;'
  modal.appendChild(note)

  modal.appendChild(el('div', { class: 'modal-head' }, 'MTF'))
  modalSelectField(modal, 'FVG source', opts.mtfMode, [
    ['current', 'Current TF'],
    ['currentHtf', 'Current + HTF'],
    ['htf', 'HTF'],
  ], (v) => p.applyFvgStrategyOption({ mtfMode: v as FvgStrategyOptions['mtfMode'] }))
  modalSelectField(modal, 'HTF timeframe', opts.htfTimeframe, [
    ['1h', '1 hour'],
    ['4h', '4 hours'],
    ['D', '1 day'],
    ['W', '1 week'],
  ], (v) => p.applyFvgStrategyOption({ htfTimeframe: v as FvgStrategyOptions['htfTimeframe'] }))
  modalNumField(modal, 'Label offset (bars)', opts.labelOffset, 0, 500, 1, (v) => p.applyFvgStrategyOption({ labelOffset: v }))
  modalNumField(modal, 'HTF label offset (bars)', opts.htfLabelOffset, 0, 500, 1, (v) => p.applyFvgStrategyOption({ htfLabelOffset: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Gaps'))
  modalCheckField(modal, 'Midpoint line', opts.fillByMid, (v) => p.applyFvgStrategyOption({ fillByMid: v }))
  modalCheckField(modal, 'Delete old on fill', opts.deleteOnFill, (v) => p.applyFvgStrategyOption({ deleteOnFill: v }))
  modalCheckField(modal, 'Label FVG timeframe', opts.labelTf, (v) => p.applyFvgStrategyOption({ labelTf: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Supertrend'))
  modalNumField(modal, 'ATR period', opts.stAtrPeriod, 1, 100, 1, (v) => p.applyFvgStrategyOption({ stAtrPeriod: v }))
  modalNumField(modal, 'Factor', opts.stFactor, 0.1, 20, 0.1, (v) => p.applyFvgStrategyOption({ stFactor: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Display'))
  modalCheckField(modal, 'Supertrend line', opts.showSupertrend, (v) => p.applyFvgStrategyOption({ showSupertrend: v }))
  modalCheckField(modal, 'BUY / SELL / EXIT labels', opts.showSignals, (v) => p.applyFvgStrategyOption({ showSignals: v }))
  modalCheckField(modal, 'Backtest card', opts.showStats, (v) => p.applyFvgStrategyOption({ showStats: v }))

  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)
}

function openDcBigTradesSettings(p: ChartPane): void {
  const opts = p.getDcBigTradesOptions()
  const set = (patch: Partial<DcBigTradesOptions>): void => p.applyDcBigTradesOption(patch)
  const { backdrop, modal, close } = openModal('DeepCharts Big Trades')

  const note = el(
    'p',
    {},
    'A big trade = a candle whose approximated delta beats its average by the multiplier. Its price is the busiest 1-minute bar inside the candle, and where that sits names the pattern: absorption / acceptance in the body, contrarian absorption / rejection in the wick. Sessions are UTC days.',
  )
  note.style.cssText = 'font-size:11.5px;color:var(--muted);line-height:1.5;margin:0 0 4px;'
  modal.appendChild(note)

  modal.appendChild(el('div', { class: 'modal-head' }, 'Detection'))
  modalNumField(modal, 'Delta smoothing length', opts.len, 1, 200, 1, (v) => set({ len: Math.max(1, Math.round(v)) }))
  modalNumField(modal, 'Big trade strength multiplier', opts.mult, 0.1, 20, 0.1, (v) => set({ mult: v }))
  modalNumField(modal, 'Absorption zone (share of body from the start side)', opts.bodyZone, 0.05, 0.9, 0.05, (v) => set({ bodyZone: v }))
  modalNumField(modal, 'Wick split (far part = contrarian absorption)', opts.wickSplit, 0.1, 0.9, 0.05, (v) => set({ wickSplit: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Patterns to show'))
  modalCheckField(modal, 'Absorption (continuation)', opts.showAbsCont, (v) => set({ showAbsCont: v }))
  modalCheckField(modal, 'Acceptance', opts.showAccept, (v) => set({ showAccept: v }))
  modalCheckField(modal, 'Absorption (contrarian)', opts.showAbsContra, (v) => set({ showAbsContra: v }))
  modalCheckField(modal, 'Rejection', opts.showReject, (v) => set({ showReject: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Circles'))
  modalColorField(modal, 'Teal circle', opts.tealColor, (v) => set({ tealColor: v }))
  modalColorField(modal, 'Magenta circle', opts.magentaColor, (v) => set({ magentaColor: v }))
  modalNumField(modal, 'Circle transparency (0–100)', opts.transp, 0, 100, 5, (v) => set({ transp: Math.round(v) }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Bias dashboard'))
  modalCheckField(modal, 'Show bias dashboard (3m / 5m / 15m / 30m / 1h)', opts.showBiasPanel, (v) => set({ showBiasPanel: v }))
  modalSelectField(modal, 'Position', opts.biasPanelPos, [
    ['topRight', 'Top right'],
    ['bottomRight', 'Bottom right'],
  ], (v) => set({ biasPanelPos: v as 'topRight' | 'bottomRight' }))
  modal.appendChild(el('div', { class: 'modal-head' }, 'Zones'))
  modalCheckField(modal, 'Enable zones', opts.showZones, (v) => set({ showZones: v }))
  modalNumField(modal, 'Number of latest zones', opts.maxZones, 1, 500, 1, (v) => set({ maxZones: Math.max(1, Math.round(v)) }))
  modalCheckField(modal, 'Biggest only (one zone per session)', opts.biggestOnly, (v) => set({ biggestOnly: v }))
  modalSelectField(modal, 'Zone height', opts.zoneSource, [
    ['thin', 'Thin line at big trade price'],
    ['ltfBar', 'Big trade 1m bar'],
    ['body', 'Candle body'],
    ['range', 'Full candle range'],
  ], (v) => set({ zoneSource: v as DcBigTradesOptions['zoneSource'] }))
  modalNumField(modal, 'Thin zone thickness (ticks)', opts.thickTicks, 0.5, 100, 0.5, (v) => set({ thickTicks: v }))
  modalSelectField(modal, 'Extension', opts.extMode, [
    ['untilNext', 'Until next big trade'],
    ['fixed', 'Fixed number of bars'],
  ], (v) => set({ extMode: v as DcBigTradesOptions['extMode'] }))
  modalNumField(modal, 'Bars (fixed mode)', opts.extBars, 1, 500, 1, (v) => set({ extBars: Math.max(1, Math.round(v)) }))
  modalCheckField(modal, 'Reset on new session', opts.resetSession, (v) => set({ resetSession: v }))
  modalNumField(modal, 'Zone fill transparency (0–100)', opts.zoneTransp, 0, 100, 5, (v) => set({ zoneTransp: Math.round(v) }))
  modalCheckField(modal, 'Zone border', opts.zoneBorder, (v) => set({ zoneBorder: v }))
  modalNumField(modal, 'Zone border transparency (0–100)', opts.zoneBorderTransp, 0, 100, 5, (v) => set({ zoneBorderTransp: Math.round(v) }))
  modalCheckField(modal, 'Pattern label in zone', opts.zoneLabel, (v) => set({ zoneLabel: v }))

  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)
}

function openIvFadeSettings(p: ChartPane): void {
  const opts = p.getIvFadeOptions()
  const set = (patch: Partial<IvFadeOptions>): void => p.applyIvFadeOption(patch)
  const { backdrop, modal, close } = openModal('IV Walls × Big Trades Fade')

  const note = el(
    'p',
    {},
    'SHORT when a big-trade candle pokes into the HOD zone and closes back below it (sell-stop at its low); LONG mirrors that at the LOD zone. Stop beyond the candle by an ATR buffer, target in R or the day open. Zones use UTC days. Backtest P&L is price points × 1 unit, no fees.',
  )
  note.style.cssText = 'font-size:11.5px;color:var(--muted);line-height:1.5;margin:0 0 4px;'
  modal.appendChild(note)

  modal.appendChild(el('div', { class: 'modal-head' }, 'Big trades'))
  modalNumField(modal, 'Delta smoothing length', opts.deltaLen, 1, 200, 1, (v) => set({ deltaLen: Math.max(1, Math.round(v)) }))
  modalNumField(modal, 'Big trade strength multiplier', opts.bigMult, 0.1, 20, 0.1, (v) => set({ bigMult: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'HOD / LOD zones'))
  modalNumField(modal, 'HV lookback (days)', opts.hvLookback, 5, 100, 1, (v) => set({ hvLookback: Math.round(v) }))
  modalNumField(modal, 'Calibration history (days)', opts.calibrationDays, 30, 2000, 10, (v) => set({ calibrationDays: Math.round(v) }))
  modalNumField(modal, 'Zone start percentile', opts.zoneLo, 5, 95, 5, (v) => set({ zoneLo: v }))
  modalNumField(modal, 'Zone end percentile', opts.zoneHi, 10, 99, 5, (v) => set({ zoneHi: v }))
  modalCheckField(modal, 'Draw zones', opts.showZones, (v) => set({ showZones: v }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Trade'))
  modalSelectField(modal, 'Signal', opts.signalMode, [
    ['reject', 'Reject (close back outside zone)'],
    ['wick', 'Wick big trade (uses 1m bars)'],
  ], (v) => set({ signalMode: v as IvFadeOptions['signalMode'] }))
  modalSelectField(modal, 'Take profit', opts.tpMode, [
    ['fixedR', 'Fixed R'],
    ['dayOpen', 'Day open'],
  ], (v) => set({ tpMode: v as IvFadeOptions['tpMode'] }))
  modalNumField(modal, 'Fixed R multiple', opts.fixedR, 0.5, 20, 0.5, (v) => set({ fixedR: v }))
  modalNumField(modal, 'Minimum reward:risk (day-open mode)', opts.minRR, 0.1, 20, 0.1, (v) => set({ minRR: v }))
  modalNumField(modal, 'Stop buffer beyond wick (× ATR 14)', opts.slAtr, 0, 5, 0.05, (v) => set({ slAtr: v }))
  modalNumField(modal, 'Entry order valid for (bars)', opts.validBars, 1, 100, 1, (v) => set({ validBars: Math.max(1, Math.round(v)) }))
  modalNumField(modal, 'Max signals per side per day', opts.maxPerSide, 1, 20, 1, (v) => set({ maxPerSide: Math.max(1, Math.round(v)) }))
  modalCheckField(modal, 'Close open trade at day change', opts.eodExit, (v) => set({ eodExit: v }))
  modalCheckField(modal, 'Only trade inside session', opts.useSession, (v) => set({ useSession: v }))
  modalNumField(modal, 'Session start (UTC hour)', opts.sessionStartMin / 60, 0, 23.5, 0.5, (v) => set({ sessionStartMin: Math.round(v * 60) }))
  modalNumField(modal, 'Session end (UTC hour)', opts.sessionEndMin / 60, 0, 24, 0.5, (v) => set({ sessionEndMin: Math.round(v * 60) }))

  modal.appendChild(el('div', { class: 'modal-head' }, 'Display'))
  modalCheckField(modal, 'Signal triangles', opts.showSignals, (v) => set({ showSignals: v }))
  modalCheckField(modal, 'TP / SL position boxes', opts.showTrades, (v) => set({ showTrades: v }))
  modalCheckField(modal, 'Trade result labels', opts.showTradeLabels, (v) => set({ showTradeLabels: v }))
  modalCheckField(modal, 'Backtest card', opts.showStats, (v) => set({ showStats: v }))

  modalDoneFoot(modal, close)
  document.body.appendChild(backdrop)
}

const POWER_TOOLS: PowerTool[] = [
  { id: 'deltaNeutralPredictor', label: 'Delta-Neutral Predictor', icon: '⚖️', isOn: () => false, setOn: () => {}, action: openDeltaNeutralDashboard },
  { id: 'tradeRain', label: 'Trade Rain', icon: '☔', isOn: (p) => !!p.state.tradeRain, setOn: (p, on) => p.setTradeRainEnabled(on) },
  { id: 'orderFlow', label: 'Order Flow Analysis', icon: '📊', isOn: (p) => !!p.state.orderFlow, setOn: (p, on) => p.setOrderFlowEnabled(on) },
  { id: 'buySellPoll', label: 'Buy/Sell Poll', icon: '🗳️', isOn: (p) => !!p.state.buySellPoll, setOn: (p, on) => p.setBuySellPollEnabled(on) },
  { id: 'dominanceV2', label: 'Dominance V2', icon: '⏱️', isOn: (p) => !!p.state.dominanceV2, setOn: (p, on) => p.setDominanceV2Enabled(on) },
  { id: 'ict', label: 'ICT / Smart Money Concepts', icon: '🧠', isOn: (p) => !!p.state.ict, setOn: (p, on) => p.setICTEnabled(on) },
  { id: 'depthImbalance', label: 'Order Book Imbalance', icon: '📖', isOn: (p) => !!p.state.depthImbalance, setOn: (p, on) => p.setDepthImbalanceEnabled(on) },
  { id: 'liquidityLevels', label: 'Live Liquidity Levels', icon: '🌊', isOn: (p) => !!p.state.liquidityLevels, setOn: (p, on) => p.setLiquidityLevelsEnabled(on) },
  { id: 'confluence', label: 'Confluence Setups', icon: '🎯', isOn: (p) => !!p.state.confluence, setOn: (p, on) => p.setConfluenceEnabled(on) },
  { id: 'bigTrades', label: 'Big Trades', icon: '🐋', isOn: (p) => !!p.state.bigTrades, setOn: (p, on) => p.setBigTradesEnabled(on), openSettings: openBigTradesSettings },
  { id: 'deepTrades', label: 'Deep Trades', icon: '💎', isOn: (p) => !!p.state.deepTrades, setOn: (p, on) => p.setDeepTradesEnabled(on), openSettings: openDeepTradesSettings },
  { id: 'heavyAbsorption', label: 'Heavy Absorption', icon: '🧲', isOn: (p) => !!p.state.heavyAbsorption, setOn: (p, on) => p.setHeavyAbsorptionEnabled(on), openSettings: openHeavyAbsorptionSettings },
  {
    id: 'footprint',
    label: 'Volume Footprint',
    icon: '👣',
    isOn: (p) => p.state.chartType === 'footprint',
    setOn: (p, on) => {
      exitReplay()
      p.setChartType(on ? 'footprint' : 'candles')
      markSel(chartTypeMenu, 'data-ct', p.state.chartType)
    },
    openSettings: openFootprintSettings,
  },
  {
    id: 'volumeProfileTool',
    label: 'Volume Profile & TPO',
    icon: '📶',
    isOn: (p) => !!p.state.volumeProfileOptions?.enabled,
    setOn: (p, on) => p.setVolumeProfileToolEnabled(on),
    openSettings: openVolumeProfileSettings,
  },
  {
    id: 'gex',
    label: 'GEX (Gamma Exposure)',
    icon: '🧲',
    isOn: (p) => !!p.state.gexOptions?.enabled,
    setOn: (p, on) => p.setGexEnabled(on),
    openSettings: openGexSettings,
  },
  {
    id: 'gexV2',
    label: 'GEX V2 (Gamma Environment)',
    icon: '🌡️',
    isOn: (p) => !!p.state.gexV2Options?.enabled,
    setOn: (p, on) => p.setGexV2Enabled(on),
    openSettings: openGexV2Settings,
  },
  {
    id: 'ivWalls',
    label: 'IV Walls (HOD/LOD zones)',
    icon: '🧱',
    isOn: (p) => !!p.state.ivWallsOptions?.enabled,
    setOn: (p, on) => p.setIVWallsEnabled(on),
    openSettings: openIVWallsSettings,
  },
  {
    id: 'ivZones',
    label: 'IV Expected-Move Zones',
    icon: '📐',
    isOn: (p) => !!p.state.ivZonesOptions?.enabled,
    setOn: (p, on) => p.setIvZonesEnabled(on),
    openSettings: openIvZonesSettings,
  },
  {
    id: 'cpr',
    label: 'CPR & Pivots',
    icon: '📐',
    isOn: (p) => !!p.state.cprOptions?.enabled,
    setOn: (p, on) => p.setCprEnabled(on),
    openSettings: openCprSettings,
    legendSelect: (p) => ({
      title: 'CPR timeframe',
      value: p.getCprOptions().timeframe,
      options: CPR_TIMEFRAMES,
      onChange: (v) => {
        p.applyCprOption({ timeframe: v as CprTimeframe })
        refreshToolLegends()
      },
    }),
  },
  {
    id: 'flagPatterns',
    label: 'Auto Flag Patterns',
    icon: '🚩',
    isOn: (p) => !!p.state.flagPatternsOptions?.enabled,
    setOn: (p, on) => p.setFlagPatternsEnabled(on),
    openSettings: openFlagPatternsSettings,
  },
  {
    id: 'setupChecklist',
    label: 'Setup Checklist',
    icon: '✅',
    isOn: (p) => !!p.state.setupChecklistOptions?.enabled,
    setOn: (p, on) => p.setSetupChecklistEnabled(on),
  },
  {
    id: 'ultraV2',
    label: 'Ultra V2 (VWAP + IB + SVP + BOS + Supertrend)',
    icon: '🌀',
    isOn: (p) => !!p.state.ultraV2,
    setOn: (p, on) => p.setUltraV2Enabled(on),
    openSettings: openUltraV2Settings,
  },
  {
    id: 'fvgStrategy',
    label: 'FVG + Supertrend Strategy',
    icon: '🕳️',
    isOn: (p) => !!p.state.fvgStrategy,
    setOn: (p, on) => p.setFvgStrategyEnabled(on),
    openSettings: openFvgStrategySettings,
  },
  {
    id: 'cprStrategy',
    label: 'CPR Strategy (breakout / reclaim)',
    icon: '🏹',
    isOn: (p) => !!p.state.cprStrategy,
    setOn: (p, on) => p.setCprStrategyEnabled(on),
    openSettings: openCprStrategySettings,
  },
  {
    id: 'fvVwapEma',
    label: 'FV + VWAP + EMA (fractal vector)',
    icon: '🧭',
    isOn: (p) => !!p.state.fvVwapEma,
    setOn: (p, on) => p.setFvVwapEmaEnabled(on),
    openSettings: openFvVwapEmaSettings,
  },
  {
    id: 'halfTrend',
    label: 'HalfTrend',
    icon: '〰️',
    isOn: (p) => !!p.state.halfTrend,
    setOn: (p, on) => p.setHalfTrendEnabled(on),
    openSettings: openHalfTrendSettings,
  },
  {
    id: 'ivFvStrategy',
    label: 'IV × FV Strategy (entries, SL, targets)',
    icon: '🎯',
    isOn: (p) => !!p.state.ivFvStrategy,
    setOn: (p, on) => p.setIvFvStrategyEnabled(on),
    openSettings: openIvFvStrategySettings,
  },
  {
    id: 'zoneRetest',
    label: 'IV Zone Retest Strategy (big-trade graded)',
    icon: '🎚️',
    isOn: (p) => !!p.state.zoneRetest,
    setOn: (p, on) => p.setZoneRetestEnabled(on),
    openSettings: openZoneRetestSettings,
  },
  {
    id: 'ivFade',
    label: 'IV Walls × Big Trades Fade',
    icon: '🧲',
    isOn: (p) => !!p.state.ivFade,
    setOn: (p, on) => p.setIvFadeEnabled(on),
    openSettings: openIvFadeSettings,
  },
  {
    id: 'dcBigTrades',
    label: 'DeepCharts Big Trades (patterns)',
    icon: '🔵',
    isOn: (p) => !!p.state.dcBigTrades,
    setOn: (p, on) => p.setDcBigTradesEnabled(on),
    openSettings: openDcBigTradesSettings,
  },
  {
    id: 'tradeBuddy',
    label: 'Trade Buddy (AI ideas + chat)',
    icon: '🤝',
    isOn: () => !buddyEl.classList.contains('hidden'),
    setOn: (_p, on) => setBuddyVisible(on),
  },
]

let ptMenu: HTMLElement
function refreshPowerToolsMenu(): void {
  if (!ptMenu) return
  ptMenu.innerHTML = ''
  const p = active()
  if (!p) return
  for (const tool of POWER_TOOLS) {
    const on = tool.isOn(p)
    const row = el('div', { class: 'menu-item' })
    row.append(el('span', { class: 'mi-check' }, on ? '✓' : ''), el('span', {}, tool.icon), el('span', { class: 'mi-grow' }, tool.label))
    row.addEventListener('click', () => {
      if (tool.action) {
        closeAllPopovers()
        tool.action(p)
        return
      }
      tool.setOn(p, !on)
      if (p.state.hiddenTools?.includes(tool.id)) p.state.hiddenTools = p.state.hiddenTools.filter((id) => id !== tool.id)
      refreshPowerToolsMenu()
      refreshToolLegends()
    })
    if (tool.openSettings) {
      const gear = el('button', { class: 'mi-icon', title: 'Settings' }, ICONS.gear)
      gear.addEventListener('click', (e) => {
        e.stopPropagation()
        closeAllPopovers()
        tool.openSettings!(p)
      })
      row.appendChild(gear)
    }
    ptMenu.appendChild(row)
  }
}
function buildPowerTools(): HTMLElement {
  const wrap = el('div', { class: 'dd' })
  const trigger = el('button', { class: 'tv-btn', title: 'Power tools — order flow, footprints, and profile overlays for the active chart' })
  trigger.append(el('span', {}, '⚡'), el('span', {}, 'Power Tools'), el('span', { class: 'chev' }, ICONS.chevron))
  ptMenu = el('div', { class: 'dd-menu' })
  wrap.append(trigger, ptMenu)
  registerPopover(wrap, trigger, ptMenu)
  trigger.addEventListener('click', refreshPowerToolsMenu)
  return wrap
}

// ----------------------------------------------------------------------------
// Header: grid layout selector + saved layouts.
// ----------------------------------------------------------------------------
function updateLayoutSel(): void {
  if (!layoutMenu) return
  layoutMenu.querySelectorAll('.menu-item').forEach((n) => {
    const on = (n as HTMLElement).getAttribute('data-lk') === layoutKey
    n.classList.toggle('sel', on)
    const c = n.querySelector('.mi-check') as HTMLElement
    if (c) c.textContent = on ? '✓' : ''
  })
}
function buildLayoutSelector(): HTMLElement {
  const wrap = el('div', { class: 'dd' })
  const trigger = el('button', { class: 'tv-btn', title: 'Chart layout' })
  trigger.append(el('span', {}, ICONS.grid), el('span', { class: 'chev' }, ICONS.chevron))
  layoutMenu = el('div', { class: 'dd-menu' })
  for (const key of ['1', '2h', '2v', '3h', '4']) {
    const def = GRID_LAYOUTS[key]
    const item = el('div', { class: 'menu-item', 'data-lk': key })
    item.append(
      el('span', { class: 'mi-check' }, ''),
      el('span', { class: 'lp' }, LAYOUT_PREVIEW[key]),
      el('span', { class: 'mi-grow' }, def.label),
    )
    item.addEventListener('click', () => {
      closeAllPopovers()
      setLayout(key)
    })
    layoutMenu.appendChild(item)
  }
  appendSyncControls(layoutMenu)
  wrap.append(trigger, layoutMenu)
  registerPopover(wrap, trigger, layoutMenu)
  return wrap
}

interface SavedLayout {
  theme: Theme
  layout: string
  active: number
  panes: PaneState[]
  /** Workspace-wide candle treatment; optional for layouts saved before palettes existed. */
  candlePalette?: CandlePaletteId
  /** Stored with custom palettes so a named layout restores the exact pair. */
  upColor?: string
  downColor?: string
}
const loadSaved = (): Record<string, SavedLayout> => {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}')
  } catch {
    return {}
  }
}
const persistSaved = (m: Record<string, SavedLayout>): void => localStorage.setItem(LS_KEY, JSON.stringify(m))

function snapshot(): SavedLayout {
  return {
    theme,
    layout: layoutKey,
    active: activeIdx,
    panes: panes.map((p) => JSON.parse(JSON.stringify(p.state)) as PaneState),
    candlePalette: chartSettings.candlePalette,
    upColor: chartSettings.upColor,
    downColor: chartSettings.downColor,
  }
}
function applySaved(s: SavedLayout): void {
  applyTheme(s.theme)
  const savedPalette = isCandlePaletteId(s.candlePalette) ? s.candlePalette : chartSettings.candlePalette
  if (savedPalette === 'custom') {
    updateChartSettings({
      candlePalette: 'custom',
      upColor: typeof s.upColor === 'string' ? s.upColor : chartSettings.upColor,
      downColor: typeof s.downColor === 'string' ? s.downColor : chartSettings.downColor,
    })
  } else {
    const palette = getCandlePalette(savedPalette)
    updateChartSettings({ candlePalette: savedPalette, upColor: palette.up, downColor: palette.down })
  }
  for (const p of panes) p.destroy()
  panes = []
  const def = GRID_LAYOUTS[s.layout] ?? GRID_LAYOUTS['1']
  layoutKey = GRID_LAYOUTS[s.layout] ? s.layout : '1'
  for (let i = 0; i < def.count; i++) {
    const st = s.panes[i] ?? defaultPaneState(i)
    const p = makePane(st)
    panes.push(p)
    gridEl.appendChild(p.root)
  }
  applyGridCss(def)
  activeIdx = Math.min(Math.max(0, s.active), panes.length - 1)
  setActive(activeIdx)
  updateLayoutSel()
}

function refreshSavedMenu(): void {
  if (!savedMenu) return
  savedMenu.innerHTML = ''
  const saveRow = el('div', { class: 'save-row' })
  const input = el('input', { class: 'menu-search', placeholder: 'Layout name…' })
  input.addEventListener('click', (e) => e.stopPropagation())
  const saveBtn = el('button', { class: 'btn btn-primary' }, 'Save')
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    const name = input.value.trim()
    if (!name) return
    const m = loadSaved()
    m[name] = snapshot()
    persistSaved(m)
    input.value = ''
    refreshSavedMenu()
  })
  saveRow.append(input, saveBtn)
  savedMenu.appendChild(saveRow)

  const m = loadSaved()
  const names = Object.keys(m)
  savedMenu.appendChild(el('div', { class: 'menu-head' }, names.length ? 'Saved layouts' : 'No saved layouts yet'))
  for (const name of names) {
    const row = el('div', { class: 'menu-item' })
    const load = el('span', { class: 'mi-grow' }, name)
    load.addEventListener('click', () => {
      closeAllPopovers()
      applySaved(m[name])
    })
    const del = el('button', { class: 'mi-icon', title: 'Delete' }, ICONS.trash)
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      const mm = loadSaved()
      delete mm[name]
      persistSaved(mm)
      refreshSavedMenu()
    })
    row.append(load, del)
    savedMenu.appendChild(row)
  }
}
function buildSavedLayouts(): HTMLElement {
  const wrap = el('div', { class: 'dd' })
  const trigger = el('button', { class: 'tv-btn', title: 'Saved layouts' })
  trigger.append(el('span', {}, ICONS.layers), el('span', {}, 'Layouts'), el('span', { class: 'chev' }, ICONS.chevron))
  savedMenu = el('div', { class: 'dd-menu' })
  wrap.append(trigger, savedMenu)
  registerPopover(wrap, trigger, savedMenu)
  trigger.addEventListener('click', refreshSavedMenu)
  return wrap
}

// ----------------------------------------------------------------------------
// Header: theme toggle.
// ----------------------------------------------------------------------------
function applyTheme(t: Theme): void {
  theme = t
  document.documentElement.setAttribute('data-theme', t)
  for (const p of panes) p.setTheme(t)
  optionsView.setTheme(t)
  domDashboardView.readColors()
  if (themeBtn) {
    themeBtn.innerHTML = t === 'dark' ? ICONS.sun : ICONS.moon
    themeBtn.title = t === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  }
}
function buildTheme(): HTMLElement {
  themeBtn = el('button', { class: 'tv-btn' })
  themeBtn.addEventListener('click', () => applyTheme(theme === 'dark' ? 'light' : 'dark'))
  return themeBtn
}

function buildVolumeProfile(): HTMLElement {
  vpBtn = el('button', { class: 'tv-btn', title: 'Visible-range Volume Profile' })
  vpBtn.append(el('span', {}, ICONS.stats))
  vpBtn.addEventListener('click', () => {
    const p = active()
    p.setVolumeProfile(!p.volumeProfile)
    vpBtn.classList.toggle('active', p.volumeProfile)
  })
  return vpBtn
}

// ----------------------------------------------------------------------------
// Header: watchlist show/hide toggle.
// ----------------------------------------------------------------------------
// The right dock (#tv-watchlist) shows ONE panel at a time, chosen from the
// widget bar: Watchlist (+ symbol details under it), Object tree, or Data window.
type DockView = 'watchlist' | 'objects' | 'data' | 'alerts' | 'book'
const DOCK_KEY = 'candl.dockView'
const WATCHLIST_VISIBLE_KEY = 'candl.watchlistVisible' // pre-V3 key, read once for migration
const DETAILS_H_KEY = 'candl.detailsHeight'
let dockView: DockView | null = null
const dockButtons = new Map<DockView, HTMLButtonElement>()
const objectTree = new ObjectTree(() => setDockView(null))
const dataWindow = new DataWindow(() => setDockView(null))
const watchDock = el('div', { class: 'dock-watch' })
const dockSplit = el('div', { class: 'dock-split', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize symbol details', tabindex: '0' })

function setDockView(view: DockView | null, persist = true): void {
  dockView = view
  watchlistEl.classList.toggle('hidden', view === null)
  watchDock.style.display = view === 'watchlist' ? 'flex' : 'none'
  objectTree.root.style.display = view === 'objects' ? 'flex' : 'none'
  dataWindow.root.style.display = view === 'data' ? 'flex' : 'none'
  alertsPanel.root.style.display = view === 'alerts' ? 'flex' : 'none'
  orderBook.root.style.display = view === 'book' ? 'flex' : 'none'
  orderBook.setVisible(view === 'book')
  for (const [k, b] of dockButtons) {
    b.classList.toggle('active', k === view)
    b.setAttribute('aria-pressed', String(k === view))
  }
  symbolDetails.setVisible(view === 'watchlist')
  if (persist) {
    try {
      localStorage.setItem(DOCK_KEY, view ?? '')
    } catch {
      /* storage unavailable — the dock still works for this session */
    }
  }
  refreshSidePanels()
}
function setWatchlistVisible(visible: boolean, persist = true): void {
  setDockView(visible ? 'watchlist' : null, persist)
}
function toggleWatchlist(): void {
  setWatchlistVisible(dockView !== 'watchlist')
}
function restoreDockView(): void {
  const saved = localStorage.getItem(DOCK_KEY)
  if (saved === 'watchlist' || saved === 'objects' || saved === 'data' || saved === 'alerts' || saved === 'book') setDockView(saved, false)
  else if (saved === null && localStorage.getItem(WATCHLIST_VISIBLE_KEY) === '1') setDockView('watchlist', false)
  else setDockView(null, false)
}

/** Watchlist on top, drag handle, symbol details below (height remembered). */
function buildWatchDock(): void {
  const details = el('div', { class: 'dock-details' })
  details.appendChild(symbolDetails.root)
  // Default: details take ~45% of the dock, the watchlist the rest.
  const h = readJSON<number>(DETAILS_H_KEY, Math.round(Math.max(260, (window.innerHeight - 90) * 0.45)))
  details.style.height = `${h}px`
  watchDock.append(watchlist.root, dockSplit, details)
  const clampH = (v: number): number => Math.max(90, Math.min(watchDock.clientHeight - 260, v))
  const setH = (v: number): void => {
    const next = clampH(v)
    details.style.height = `${next}px`
    try {
      localStorage.setItem(DETAILS_H_KEY, String(Math.round(next)))
    } catch {
      /* storage unavailable */
    }
  }
  dockSplit.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    dockSplit.setPointerCapture(e.pointerId)
    const startY = e.clientY
    const startH = details.offsetHeight
    const move = (ev: PointerEvent): void => setH(startH - (ev.clientY - startY))
    const up = (): void => {
      dockSplit.removeEventListener('pointermove', move)
      dockSplit.removeEventListener('pointerup', up)
    }
    dockSplit.addEventListener('pointermove', move)
    dockSplit.addEventListener('pointerup', up)
  })
  dockSplit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      setH(details.offsetHeight + (e.key === 'ArrowUp' ? 24 : -24))
    }
  })
}

// ---- Object tree + Data window content (active chart) ----
function objectTreeSections(): TreeSection[] {
  const p = active()
  if (!p) return []
  const indicators = p.state.indicators.map((inst) => {
    const def = resolveIndicator(inst.defId)
    return {
      label: def?.label ?? inst.defId,
      sub: def ? (def.placement === 'pane' ? 'Separate pane' : 'On price') : undefined,
      hidden: inst.visible === false,
      onToggle: () => p.setIndicatorVisible(inst.defId, inst.visible === false),
      onSettings: () => openIndicatorSettings(inst.defId),
      onRemove: () => {
        p.removeIndicator(inst.defId)
        refreshIndicatorsMenu()
        refreshSidePanels()
      },
    }
  })
  const hiddenTools = new Set(p.state.hiddenTools ?? [])
  const tools = POWER_TOOLS.filter((t) => !t.action && (t.isOn(p) || hiddenTools.has(t.id))).map((t) => {
    const isHidden = !t.isOn(p)
    const setHidden = (h: boolean): void => {
      const next = new Set(p.state.hiddenTools ?? [])
      if (h) next.add(t.id)
      else next.delete(t.id)
      p.state.hiddenTools = [...next]
    }
    return {
      label: t.label,
      hidden: isHidden,
      onToggle: () => {
        t.setOn(p, isHidden)
        setHidden(!isHidden)
        refreshToolLegends()
        refreshPowerToolsMenu()
        refreshSidePanels()
      },
      onSettings: t.openSettings ? () => t.openSettings!(p) : undefined,
      onRemove: () => {
        t.setOn(p, false)
        setHidden(false)
        refreshToolLegends()
        refreshPowerToolsMenu()
        refreshSidePanels()
      },
    }
  })
  const fmtT = (t: number): string => new Date(t).toISOString().slice(5, 16).replace('T', ' ')
  const drawings = p.state.drawings.map((d) => ({
    label: (TOOL_GROUPS.flatMap((g) => g.tools).find((x) => x.id === d.tool)?.label ?? d.tool) + (d.text ? ` — ${d.text}` : ''),
    sub: d.points.length ? `${d.points[0].price.toFixed(2)} · ${fmtT(d.points[0].time)} UTC` : undefined,
    hidden: d.props?.hidden === true,
    onToggle: () => p.engine.updateDrawing({ ...d, props: { ...(d.props ?? {}), hidden: !(d.props?.hidden === true) } }),
    onRemove: () => p.engine.removeDrawing(d.id),
  }))
  return [
    { title: 'Indicators', items: indicators, empty: 'No indicators on this chart.' },
    { title: 'Power tools', items: tools, empty: 'No power tools on.' },
    { title: 'Drawings', items: drawings, empty: 'No drawings on this chart.', action: { label: 'Remove all', run: () => active().clearDrawings() } },
  ]
}
let dataWindowRaf = 0
function scheduleDataWindow(): void {
  if (dockView !== 'data' || dataWindowRaf) return
  dataWindowRaf = requestAnimationFrame(() => {
    dataWindowRaf = 0
    const p = active()
    if (p) dataWindow.render(p.state.symbol, p.state.interval, INTERVAL_MS[p.state.interval] ?? 60_000, p.getDataWindow())
  })
}
function refreshSidePanels(): void {
  if (!panes.length || !active()) return
  if (dockView === 'objects') objectTree.render(objectTreeSections())
  if (dockView === 'data') scheduleDataWindow()
  if (dockView === 'alerts') alertsPanel.render(alerts.map((a) => ({ ...a, last: lastPriceBySym.get(a.symbol) })))
  orderBook.setSymbol(active().state.symbol)
}

function dockButton(view: DockView, title: string, icon: string): HTMLElement {
  const b = el('button', { class: 'wb-btn', title, 'aria-label': title, 'aria-pressed': 'false' }) as HTMLButtonElement
  b.innerHTML = icon
  b.addEventListener('click', () => setDockView(dockView === view ? null : view))
  dockButtons.set(view, b)
  return b
}

function buildSettingsButton(): HTMLElement {
  const b = el('button', { class: 'wb-btn', title: 'Chart settings', 'aria-label': 'Chart settings' }, WIDGET_ICONS.settings)
  b.addEventListener('click', openSettingsDialog)
  return b
}

// ---- Screenshot (active chart → PNG download or clipboard) ----
function chartImage(): HTMLCanvasElement {
  const p = active()
  const shot = p.screenshot()
  // Footer strip: symbol · interval · time, so a shared image explains itself.
  const dpr = window.devicePixelRatio || 1
  const out = document.createElement('canvas')
  out.width = shot.width
  out.height = shot.height + Math.round(24 * dpr)
  const ctx = out.getContext('2d')!
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#131722'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(shot, 0, 0)
  ctx.scale(dpr, dpr)
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#787b86'
  ctx.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${p.state.symbol} · ${p.state.interval} · Delta India · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · ⚡Charts`, 10, shot.height / dpr + 12)
  return out
}
function flashToast(text: string): void {
  const toast = el('div', { class: 'alert-toast show', role: 'status' })
  toast.textContent = text
  document.body.appendChild(toast)
  window.setTimeout(() => toast.remove(), 2400)
}
function buildScreenshot(): HTMLElement {
  const wrap = el('div', { class: 'dd wb-dd' })
  const b = el('button', { class: 'wb-btn', title: 'Screenshot', 'aria-label': 'Screenshot' }, WIDGET_ICONS.camera)
  const menu = el('div', { class: 'dd-menu' })
  const item = (label: string, run: () => void): void => {
    const row = el('div', { class: 'menu-item' }, label)
    row.addEventListener('click', () => {
      closeAllPopovers()
      run()
    })
    menu.appendChild(row)
  }
  item('Download image (PNG)', () => {
    const p = active()
    const a = document.createElement('a')
    a.download = `${p.state.symbol}_${p.state.interval}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
    a.href = chartImage().toDataURL('image/png')
    a.click()
  })
  item('Copy image to clipboard', () => {
    chartImage().toBlob((blob) => {
      if (!blob || !navigator.clipboard || typeof ClipboardItem === 'undefined') {
        flashToast('Clipboard images are not supported in this browser — use Download instead.')
        return
      }
      navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(
        () => flashToast('Chart image copied to clipboard.'),
        () => flashToast('Could not copy — the browser blocked clipboard access.'),
      )
    })
  })
  menu.insertBefore(el('div', { class: 'menu-head' }, 'Screenshot'), menu.firstChild)
  wrap.append(b, menu)
  registerPopover(wrap, b, menu)
  return wrap
}

// ----------------------------------------------------------------------------
// Header: Trade Buddy show/hide toggle. Scanning runs only while it is open.
// ----------------------------------------------------------------------------
let buddyToggleBtn: HTMLButtonElement
const BUDDY_VISIBLE_KEY = 'candl.buddyVisible'
function setBuddyVisible(visible: boolean, persist = true): void {
  buddyEl.classList.toggle('hidden', !visible)
  buddyToggleBtn?.classList.toggle('active', visible)
  buddy.setEnabled(visible)
  if (persist) {
    try {
      localStorage.setItem(BUDDY_VISIBLE_KEY, visible ? '1' : '0')
    } catch {
      /* storage unavailable — visibility still works for this session */
    }
  }
  requestAnimationFrame(() => panes.forEach((p) => p.refresh()))
}
function buildBuddyToggle(): HTMLElement {
  buddyToggleBtn = el('button', { class: 'wb-btn', title: 'Trade Buddy: live multi-timeframe ideas + chat', 'aria-label': 'Trade Buddy' })
  buddyToggleBtn.innerHTML = BUDDY_ICON
  buddyToggleBtn.addEventListener('click', () => setBuddyVisible(buddyEl.classList.contains('hidden')))
  return buddyToggleBtn
}

/** A compact product mark keeps the workspace recognisable without spending
 *  chart real estate on a large application header. */
function buildBrand(): HTMLElement {
  const brand = el('div', { class: 'brand', title: '⚡Charts' })
  brand.append(el('span', { class: 'brand-mark' }, '⚡'))
  return brand
}

const svgI = (body: string, size = 18): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const WIDGET_ICONS = {
  watchlist: svgI('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  fullscreen: svgI('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  exitFullscreen: svgI('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  calendar: svgI('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', 15),
  objects: svgI('<path d="M4 5h6M4 12h6M4 19h6"/><rect x="13" y="3" width="7" height="4" rx="1"/><rect x="13" y="10" width="7" height="4" rx="1"/><rect x="13" y="17" width="7" height="4" rx="1"/>'),
  data: svgI('<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M9 9v11"/>'),
  bell: svgI('<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/>'),
  book: svgI('<path d="M4 6h10M4 10h14M4 14h8M4 18h12"/>'),
  settings: svgI('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"/>'),
  camera: svgI('<path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"/><circle cx="12" cy="13" r="3.5"/>'),
}

// Fullscreen (button or Shift+F): the whole page, with Safari's prefixed API
// as a fallback. The icon flips to "exit" and charts re-fit when it changes.
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void }
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }
const fsElement = (): Element | null => document.fullscreenElement ?? (document as FsDoc).webkitFullscreenElement ?? null
function toggleFullscreen(): void {
  const doc = document as FsDoc
  // The whole page, not #app: dialogs, menus, the ⌘K palette and toasts mount
  // on <body>, and anything outside the fullscreen element is invisible.
  const root = document.documentElement as FsEl
  try {
    if (fsElement()) {
      const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(doc)
      void Promise.resolve(exit?.()).catch(() => undefined)
    } else {
      const req = root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root)
      if (!req) {
        flashToast('Fullscreen is not available in this browser.')
        return
      }
      void Promise.resolve(req()).catch(() => flashToast('The browser blocked fullscreen — click the button again.'))
    }
  } catch {
    flashToast('The browser blocked fullscreen — click the button again.')
  }
}
let fullscreenBtn: HTMLButtonElement | null = null
function syncFullscreenButton(): void {
  const on = !!fsElement()
  if (fullscreenBtn) {
    fullscreenBtn.innerHTML = on ? WIDGET_ICONS.exitFullscreen : WIDGET_ICONS.fullscreen
    fullscreenBtn.title = on ? 'Exit fullscreen (Shift+F or Esc)' : 'Fullscreen (Shift+F)'
    fullscreenBtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen')
    fullscreenBtn.setAttribute('aria-pressed', String(on))
  }
  // Layout changed size — let every chart re-measure on the next frame.
  requestAnimationFrame(() => panes.forEach((p) => p.refresh()))
}
document.addEventListener('fullscreenchange', syncFullscreenButton)
document.addEventListener('webkitfullscreenchange', syncFullscreenButton)
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'KeyF') {
    e.preventDefault()
    toggleFullscreen()
  }
})
function buildFullscreen(): HTMLElement {
  const b = el('button', { class: 'tv-btn fs-btn', title: 'Fullscreen (Shift+F)', 'aria-label': 'Fullscreen', 'aria-pressed': 'false' }) as HTMLButtonElement
  b.innerHTML = WIDGET_ICONS.fullscreen
  b.addEventListener('click', toggleFullscreen)
  fullscreenBtn = b
  return b
}

/** Opens the Strategy Tester dock under the chart (results of the active pane's strategies). */
function buildStrategyTesterToggle(): HTMLElement {
  const b = el('button', { class: 'tv-btn', title: 'Strategy Tester', 'aria-pressed': 'false' })
  b.append(
    el('span', {}, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M5 15l4-5 4 3 6-7"/></svg>'),
    el('span', {}, 'Strategy Tester'),
  )
  b.addEventListener('click', () => strategyTester?.toggle())
  strategyTesterBtn = b
  return b
}

/** Replay lives in the header like TradingView; its transport controls stay in the bottom bar. */
function buildReplayToggle(): HTMLElement {
  replayToggleBtn = el('button', { class: 'tv-btn', title: 'Bar replay' })
  replayToggleBtn.append(el('span', {}, ICONS.replay), el('span', {}, 'Replay'))
  replayToggleBtn.addEventListener('click', () => (replayActive ? exitReplay() : enterReplay()))
  return replayToggleBtn
}

// ----------------------------------------------------------------------------
// Header: undo / redo for drawing edits on the active chart (⌘Z / ⇧⌘Z, Ctrl+Y).
// ----------------------------------------------------------------------------
let undoBtn: HTMLButtonElement
let redoBtn: HTMLButtonElement
const UNDO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg>'
const REDO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/></svg>'
function syncUndoButtons(): void {
  const e = active()?.engine
  if (!undoBtn || !e) return
  undoBtn.disabled = !e.canUndo()
  redoBtn.disabled = !e.canRedo()
}
function buildUndoRedo(): HTMLElement {
  const wrap = el('span', { class: 'undo-redo' })
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  undoBtn = el('button', { class: 'tv-btn icon-only', title: `Undo (${isMac ? '⌘Z' : 'Ctrl+Z'})`, 'aria-label': 'Undo' }, UNDO_ICON) as HTMLButtonElement
  redoBtn = el('button', { class: 'tv-btn icon-only', title: `Redo (${isMac ? '⇧⌘Z' : 'Ctrl+Y'})`, 'aria-label': 'Redo' }, REDO_ICON) as HTMLButtonElement
  undoBtn.addEventListener('click', () => active()?.engine.undo())
  redoBtn.addEventListener('click', () => active()?.engine.redo())
  wrap.append(undoBtn, redoBtn)
  return wrap
}
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  if (!(e.metaKey || e.ctrlKey) || mode !== 'charts') return
  const k = e.key.toLowerCase()
  if (k === 'z' && !e.shiftKey) {
    if (active()?.engine.undo()) e.preventDefault()
  } else if ((k === 'z' && e.shiftKey) || k === 'y') {
    if (active()?.engine.redo()) e.preventDefault()
  }
})

// ----------------------------------------------------------------------------
// Header: Charts / Options mode toggle.
// ----------------------------------------------------------------------------
function setMode(m: AppMode): void {
  if (m !== 'charts') exitReplay()
  mode = m
  const charts = m === 'charts'
  modeButtons.charts?.classList.toggle('active', m === 'charts')
  modeButtons.options?.classList.toggle('active', m === 'options')
  modeButtons.gex?.classList.toggle('active', m === 'gex')
  modeButtons.dom?.classList.toggle('active', m === 'dom')
  gridEl.style.display = charts ? 'grid' : 'none'
  railEl.style.display = charts ? 'flex' : 'none'
  requestAnimationFrame(updateChartInset)
  optionsEl.style.display = m === 'options' ? 'flex' : 'none'
  gexdashEl.style.display = m === 'gex' ? 'flex' : 'none'
  domdashEl.style.display = m === 'dom' ? 'flex' : 'none'
  spotControls.style.display = charts ? 'inline-flex' : 'none'
  strategyTester?.root.classList.toggle('mode-hidden', !charts)
  closeAllPopovers()
  if (m === 'options') void optionsView.activate()
  else optionsView.deactivate()
  if (m === 'gex') void gexDashboardView.activate()
  else gexDashboardView.deactivate()
  if (m === 'dom') void domDashboardView.activate()
  else domDashboardView.deactivate()
}
function buildModeToggle(): HTMLElement {
  const wrap = el('div', { class: 'mode-toggle' })
  const chartsBtn = el('button', { class: 'active' }, 'Charts')
  const optionsBtn = el('button', {}, 'Options')
  const gexBtn = el('button', {}, 'GEX')
  const domBtn = el('button', { title: 'Order book, liquidity levels and big trades on live candles' }, 'DOM')
  chartsBtn.addEventListener('click', () => setMode('charts'))
  optionsBtn.addEventListener('click', () => setMode('options'))
  gexBtn.addEventListener('click', () => setMode('gex'))
  domBtn.addEventListener('click', () => setMode('dom'))
  modeButtons.charts = chartsBtn
  modeButtons.options = optionsBtn
  modeButtons.gex = gexBtn
  modeButtons.dom = domBtn
  wrap.append(chartsBtn, optionsBtn, gexBtn, domBtn)
  return wrap
}

// ----------------------------------------------------------------------------
// Left rail: cursor + grouped drawing tools + magnet + clear.
// ----------------------------------------------------------------------------
const GROUP_ICON: Record<string, string> = {
  lines: ICONS.trendline, channels: ICONS.channels, fib: ICONS.fib, patterns: ICONS.patterns,
  shapes: ICONS.shapes, annotate: ICONS.text, measure: ICONS.measure, projection: ICONS.projection,
  smart: ICONS.smart,
}
const RAIL_ICONS = {
  eraser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 4.5l3 3a1.5 1.5 0 010 2.1L11 18H6.5l-2.9-2.9a1.5 1.5 0 010-2.1l9-8.5a1.5 1.5 0 012.1 0z"/><path d="M9 9.5l5.5 5.5M11 18h9"/></svg>',
  stay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l3.5-1 10-10-2.5-2.5-10 10z"/><path d="M13.5 5.5l2.5 2.5"/><rect x="15" y="14" width="6" height="6" rx="1.2"/><path d="M16.5 14v-1.5a1.5 1.5 0 013 0V14"/></svg>',
  lockAll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>',
  hideAll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 3l18 18M10.6 10.6a3 3 0 004.2 4.2M9.8 5.1A10.6 10.6 0 0112 5c6.5 0 10 7 10 7a18.4 18.4 0 01-3.2 4M6.5 6.6C3.7 8.1 2 12 2 12s3.5 7 10 7a10.5 10.5 0 003.5-.6"/></svg>',
  collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 7l-5 5 5 5"/></svg>',
}
const RAIL_LAST_TOOL_KEY = 'candl.railLastTool'
const RAIL_COLLAPSED_KEY = 'candl.railCollapsed'
const STAY_KEY = 'candl.stayInDrawing'
stayInDrawing = readJSON<number>(STAY_KEY, 0) === 1
let eraserItem: HTMLElement
const railLastTool: Record<string, string> = readJSON(RAIL_LAST_TOOL_KEY, {})

function setRailActive(item: HTMLElement | null): void {
  for (const r of railItems) r.classList.remove('active')
  cursorItem.classList.toggle('active', item === null && !eraserOn)
  if (item) item.classList.add('active')
}
function setEraser(on: boolean): void {
  eraserOn = on
  panes.forEach((p, i) => p.engine.setEraser(on && i === activeIdx))
  eraserItem?.classList.toggle('active', on)
  if (on) {
    active().setActiveTool(null)
    for (const r of railItems) r.classList.remove('active')
    cursorItem.classList.remove('active')
  } else {
    cursorItem.classList.toggle('active', !railItems.some((r) => r.classList.contains('active')))
  }
}
/**
 * Chart title + legend (and top-left widgets) start just right of the floating
 * drawing toolbar's measured edge, published as --chart-inset on #grid.
 */
function updateChartInset(): void {
  const hidden = railEl.offsetParent === null || getComputedStyle(railEl).display === 'none'
  const r = railEl.getBoundingClientRect()
  const g = gridEl.getBoundingClientRect()
  const inset = hidden ? 0 : Math.max(0, Math.round(r.right - g.left + 6))
  gridEl.style.setProperty('--chart-inset', `${inset}px`)
}
new ResizeObserver(() => {
  updateChartInset()
  panes.forEach((p) => p.syncLegendInset())
}).observe(railEl)
window.addEventListener('resize', updateChartInset)
// Padding / size transitions don't always trip the ResizeObserver: settle on their end too.
railEl.addEventListener('transitionend', (e) => {
  if (e.target !== railEl && !(e.target as HTMLElement).classList?.contains('rail-collapse')) return
  updateChartInset()
  panes.forEach((p) => p.syncLegendInset())
})

const RAIL_ANIM_MS = 280
let railAnimEnd: (() => void) | null = null
let railAnimTimer = 0
/**
 * Collapse / expand the floating drawing toolbar with a height + fade
 * transition. The tool list's height is animated from its measured size
 * (CSS can't transition to `auto`), and each chart's OHLC row follows its
 * sliding title every frame so nothing jumps at the end.
 */
function setRailCollapsed(collapsed: boolean): void {
  const tools = railEl.querySelector<HTMLElement>('.rail-tools')
  railAnimEnd?.()
  // No backdrop blur while the toolbar animates: re-blurring the live chart
  // behind a resizing box every frame is what made it shimmer.
  railEl.classList.add('rail-animating')
  window.clearTimeout(railAnimTimer)
  railAnimTimer = window.setTimeout(() => railEl.classList.remove('rail-animating'), RAIL_ANIM_MS + 80)
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  if (tools && !reduce) {
    const from = tools.getBoundingClientRect().height
    railEl.classList.toggle('collapsed', collapsed)
    tools.style.maxHeight = 'none'
    const to = collapsed ? 0 : tools.scrollHeight
    tools.style.maxHeight = `${from}px`
    void tools.offsetHeight // commit the start height before transitioning
    tools.style.maxHeight = `${to}px`
    const finish = (): void => {
      tools.removeEventListener('transitionend', onEnd)
      if (!collapsed) tools.style.maxHeight = '' // expanded: back to natural (scrollable) sizing
      railAnimEnd = null
    }
    const onEnd = (e: TransitionEvent): void => {
      if (e.target === tools && e.propertyName === 'max-height') finish()
    }
    tools.addEventListener('transitionend', onEnd)
    railAnimEnd = finish
  } else {
    railEl.classList.toggle('collapsed', collapsed)
    if (tools) tools.style.maxHeight = collapsed ? '0px' : ''
  }
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
  // Keep the canvas OHLC row glued to the sliding title for the whole transition.
  // The charts themselves don't change size (the toolbar floats over them), so
  // no full refresh — that used to reset every canvas and flash a blank frame.
  const t0 = performance.now()
  const follow = (): void => {
    updateChartInset()
    panes.forEach((p) => p.syncLegendInset())
    if (performance.now() - t0 < RAIL_ANIM_MS + 60) requestAnimationFrame(follow)
  }
  requestAnimationFrame(follow)
}
/** A rail button with an optional corner triangle that opens its flyout (Vela / TradingView style). */
function railToggle(title: string, icon: string, onClick: (item: HTMLElement) => void, pressed = false): HTMLElement {
  const item = el('div', { class: `rail-item${pressed ? ' active' : ''}` })
  const btn = el('button', { class: 'rail-btn', title, 'aria-label': title, 'aria-pressed': String(pressed) }, icon)
  btn.addEventListener('click', () => {
    onClick(item)
    btn.setAttribute('aria-pressed', String(item.classList.contains('active')))
  })
  item.appendChild(btn)
  return item
}
function buildRail(): void {
  railItems = []
  const tools = el('div', { class: 'rail-tools' })
  cursorItem = el('div', { class: 'rail-item active' })
  const cursorBtn = el('button', { class: 'rail-btn', title: 'Cursor', 'aria-label': 'Cursor' }, ICONS.cursor)
  cursorBtn.addEventListener('click', () => {
    closeAllPopovers()
    setEraser(false)
    active().setActiveTool(null)
    setRailActive(null)
  })
  cursorItem.appendChild(cursorBtn)
  tools.appendChild(cursorItem)
  tools.appendChild(el('div', { class: 'rail-div' }))

  for (const g of TOOL_GROUPS) {
    if (g.tools.length === 0) continue
    const item = el('div', { class: 'rail-item has-more' })
    const lastTool = (): (typeof g.tools)[number] => g.tools.find((t) => t.id === railLastTool[g.group]) ?? g.tools[0]
    const btn = el('button', { class: 'rail-btn', title: `${g.label}: ${lastTool().label}`, 'aria-label': `${g.label}: ${lastTool().label}` }, GROUP_ICON[g.group] ?? ICONS.shapes)
    const more = el('button', { class: 'rail-more', title: `More ${g.label.toLowerCase()}`, 'aria-label': `More ${g.label.toLowerCase()}` })
    const fly = el('div', { class: 'rail-flyout' })
    const arm = (t: (typeof g.tools)[number]): void => {
      setEraser(false)
      active().setActiveTool(t.id as DrawingToolId)
      setRailActive(item)
      closeAllPopovers()
      railLastTool[g.group] = t.id
      try {
        localStorage.setItem(RAIL_LAST_TOOL_KEY, JSON.stringify(railLastTool))
      } catch {
        /* storage unavailable */
      }
      btn.title = `${g.label}: ${t.label}`
      btn.setAttribute('aria-label', btn.title)
      for (const n of Array.from(fly.querySelectorAll('.menu-item'))) n.classList.toggle('sel', n.getAttribute('data-tool') === t.id)
    }
    fly.appendChild(el('div', { class: 'menu-head' }, g.label))
    for (const t of g.tools) {
      const ti = el('div', { class: `menu-item${t.id === lastTool().id ? ' sel' : ''}`, 'data-tool': t.id }, t.label)
      ti.addEventListener('click', () => arm(t))
      fly.appendChild(ti)
    }
    // The icon and the corner triangle both open the flyout listing every tool in
    // the group (CandlV2 behaviour); the last-used tool stays highlighted there.
    item.append(btn, more, fly)
    registerPopover(item, btn, fly)
    registerPopover(item, more, fly)
    railItems.push(item)
    tools.appendChild(item)
  }

  tools.appendChild(el('div', { class: 'rail-div' }))
  eraserItem = railToggle('Eraser — click or drag over drawings to delete', RAIL_ICONS.eraser, () => setEraser(!eraserOn))
  const magItem = railToggle('Magnet (snap to OHLC)', ICONS.magnet, (item) => {
    magnet = !magnet
    active().setMagnet(magnet)
    item.classList.toggle('active', magnet)
  })
  const stayItem = railToggle(
    'Stay in drawing mode',
    RAIL_ICONS.stay,
    (item) => {
      stayInDrawing = !stayInDrawing
      for (const p of panes) p.engine.setStayInDrawingMode(stayInDrawing)
      item.classList.toggle('active', stayInDrawing)
      try {
        localStorage.setItem(STAY_KEY, stayInDrawing ? '1' : '0')
      } catch {
        /* storage unavailable */
      }
    },
    stayInDrawing,
  )
  const clrItem = railToggle('Remove all drawings', ICONS.trash, () => {
    setEraser(false)
    active().clearDrawings()
    setRailActive(null)
  })
  lockAllItem = railToggle('Lock all drawings', RAIL_ICONS.lockAll, () => setDrawingsLockedAll(!drawingsLockedAll))
  hideAllItem = railToggle('Hide all drawings (⌘⌥H)', RAIL_ICONS.hideAll, () => setDrawingsHiddenAll(!drawingsHiddenAll))
  tools.append(eraserItem, magItem, stayItem, lockAllItem, hideAllItem, clrItem)

  const collapse = el('button', { class: 'rail-btn rail-collapse', title: 'Collapse toolbar', 'aria-label': 'Collapse drawing toolbar' }, RAIL_ICONS.collapse)
  collapse.addEventListener('click', () => {
    const next = !railEl.classList.contains('collapsed')
    setRailCollapsed(next)
    collapse.title = next ? 'Expand toolbar' : 'Collapse toolbar'
    collapse.setAttribute('aria-label', next ? 'Expand drawing toolbar' : 'Collapse drawing toolbar')
  })
  railEl.append(tools, el('span', { class: 'rail-grow' }), collapse)
  if (localStorage.getItem(RAIL_COLLAPSED_KEY) === '1') {
    railEl.classList.add('collapsed')
    tools.style.maxHeight = '0px'
    collapse.title = 'Expand toolbar'
  }
}

// ----------------------------------------------------------------------------
// Price alerts (sound + browser notification, managed list).
// ----------------------------------------------------------------------------
const persistAlerts = (): void => {
  try {
    localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts))
  } catch {
    /* quota */
  }
}
const persistAlertCfg = (): void => {
  try {
    localStorage.setItem(ALERT_CFG_KEY, JSON.stringify(alertCfg))
  } catch {
    /* quota */
  }
}
/** Render the active pane's alerts (its symbol only) as lines on the chart. */
function updatePaneAlerts(): void {
  const p = active()
  if (p) p.engine.setAlerts(chartSettings.alertLines ? alerts.filter((a) => a.symbol === p.state.symbol) : [])
}
/** Best current price for a symbol: latest tick, else a loaded pane's last close. */
function currentPrice(symbol: string): number | undefined {
  const live = lastPriceBySym.get(symbol)
  if (live != null) return live
  const pane = panes.find((p) => p.state.symbol === symbol)
  return pane?.candles[pane.candles.length - 1]?.close
}
function addAlert(symbol: string, price: number): void {
  const ref = currentPrice(symbol) ?? price
  const condition: 'above' | 'below' = price >= ref ? 'above' : 'below'
  alerts.push({ id: `al_${Date.now().toString(36)}_${alertSeq++}`, symbol, price, condition, createdAt: Date.now(), triggered: false })
  persistAlerts()
  updatePaneAlerts()
  refreshAlertsMenu()
  syncAlertFeeds()
  void ensureNotificationPermission()
}
function removeAlert(id: string): void {
  alerts = alerts.filter((a) => a.id !== id)
  persistAlerts()
  updatePaneAlerts()
  refreshAlertsMenu()
  syncAlertFeeds()
}
function moveAlert(id: string, price: number): void {
  const a = alerts.find((x) => x.id === id)
  if (!a) return
  a.price = price
  a.triggered = false // moved line re-arms
  persistAlerts()
  updatePaneAlerts()
  refreshAlertsMenu()
  syncAlertFeeds()
}
/**
 * Called on every live price update (pane candle ticks AND the alert trade feed below):
 * fire any alerts that just crossed, then store the price. high / low = the range traded
 * since the caller's previous update, `since` = when that was.
 */
function fireFor(symbol: string, price: number, high?: number, low?: number, since?: number): void {
  checkAndFireAlerts({
    symbol,
    price,
    prevPrice: lastPriceBySym.get(symbol) ?? null,
    high,
    low,
    extremesSince: since,
    alerts,
    soundOn: alertCfg.soundOn,
    tune: alertCfg.tune,
    tuneDurationSec: alertCfg.duration,
    onTriggered: (id, at) => {
      const a = alerts.find((x) => x.id === id)
      if (a) {
        a.triggered = true
        a.triggeredAt = at
      }
      persistAlerts()
      updatePaneAlerts()
      refreshAlertsMenu()
      syncAlertFeeds()
    },
  })
  lastPriceBySym.set(symbol, price)
}

/**
 * Alert trade feed: every symbol with an armed alert gets its own live trade stream,
 * whether or not a chart shows it — so an alert on a symbol you are not looking at still
 * fires, and every exchange print is checked (a touch between candle updates can't slip
 * through). Re-synced whenever alerts change.
 */
const alertFeeds = new Map<string, () => void>()
function syncAlertFeeds(): void {
  const want = new Set(alerts.filter((a) => !a.triggered).map((a) => a.symbol))
  for (const [sym, stop] of alertFeeds) {
    if (want.has(sym)) continue
    stop()
    alertFeeds.delete(sym)
  }
  for (const sym of want) {
    if (alertFeeds.has(sym)) continue
    try {
      alertFeeds.set(sym, provider.subscribeTrades(sym, (t) => fireFor(sym, t.price)))
    } catch {
      /* symbol without a trade stream — pane ticks still cover it while it is on a chart */
    }
  }
  updateSoundArmHint()
}

/**
 * While alerts are armed but the browser still blocks sound (no click since the page
 * loaded), keep a small "click to enable alert sound" pill on screen — rather than only
 * finding out when an alert fires silently.
 */
let soundArmHint: HTMLElement | null = null
function updateSoundArmHint(): void {
  const need = alertCfg.soundOn && alerts.some((a) => !a.triggered) && isAlertAudioBlocked()
  if (need && !soundArmHint) {
    soundArmHint = el('div', { class: 'alert-toast sound-hint show', role: 'status' }, '🔇 Click anywhere to enable alert sounds')
    document.body.appendChild(soundArmHint)
  } else if (!need && soundArmHint) {
    soundArmHint.remove()
    soundArmHint = null
  }
}
window.addEventListener('pointerdown', () => window.setTimeout(updateSoundArmHint, 150), true)
window.addEventListener('keydown', () => window.setTimeout(updateSoundArmHint, 150), true)

function refreshAlertsMenu(): void {
  if (!alertMenu) return
  alertMenu.innerHTML = ''

  const cfg = el('div', { class: 'alert-cfg' })
  const soundBtn = el('button', { class: `mini-btn${alertCfg.soundOn ? ' on' : ''}` }, alertCfg.soundOn ? '🔊 Sound' : '🔇 Muted')
  soundBtn.addEventListener('click', () => {
    alertCfg.soundOn = !alertCfg.soundOn
    persistAlertCfg()
    refreshAlertsMenu()
    updateSoundArmHint()
  })
  const tuneSel = el('select', { class: 'opt-select' }) as HTMLSelectElement
  for (const t of ALERT_TUNES) tuneSel.appendChild(el('option', { value: String(t.id) }, t.name))
  tuneSel.value = String(alertCfg.tune)
  tuneSel.addEventListener('change', () => {
    alertCfg.tune = Number(tuneSel.value)
    persistAlertCfg()
  })
  const testBtn = el('button', { class: 'mini-btn' }, 'Test')
  testBtn.addEventListener('click', () => playTune(alertCfg.tune, alertCfg.duration))
  cfg.append(soundBtn, tuneSel, testBtn)
  alertMenu.appendChild(cfg)

  const addBtn = el('button', { class: 'btn btn-primary', style: 'width:100%;margin:6px 0' }, 'Add alert at current price')
  addBtn.addEventListener('click', () => {
    const p = active()
    const price = lastPriceBySym.get(p.state.symbol) ?? p.candles[p.candles.length - 1]?.close
    if (price != null) addAlert(p.state.symbol, price)
  })
  alertMenu.appendChild(addBtn)

  alertMenu.appendChild(el('div', { class: 'menu-head' }, alerts.length ? 'Alerts' : 'No alerts — right-click the chart to add one'))
  for (const a of alerts) {
    const row = el('div', { class: 'menu-item' })
    const txt = `${a.symbol} · ${a.condition} ${a.price}`
    const label = el(
      'span',
      { class: 'mi-grow' },
      a.triggered
        ? `<span style="opacity:.5;text-decoration:line-through">${txt}</span> <span style="color:var(--up)">✓ fired</span>`
        : txt,
    )
    const del = el('button', { class: 'mi-icon', title: 'Delete' }, ICONS.close)
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      removeAlert(a.id)
    })
    row.append(label, del)
    alertMenu.appendChild(row)
  }

  if (alertBadge) {
    const pending = alerts.filter((a) => !a.triggered).length
    alertBadge.textContent = pending > 0 ? String(pending) : ''
    alertBadge.style.display = pending > 0 ? '' : 'none'
  }
}
function buildAlerts(): HTMLElement {
  const wrap = el('div', { class: 'dd' })
  const trigger = el('button', { class: 'tv-btn', title: 'Price alerts' })
  alertBadge = el('span', { class: 'alert-badge', style: 'display:none' })
  trigger.append(el('span', {}, ICONS.bell), el('span', {}, 'Alert'), alertBadge)
  alertMenu = el('div', { class: 'dd-menu' })
  wrap.append(trigger, alertMenu)
  registerPopover(wrap, trigger, alertMenu)
  trigger.addEventListener('click', refreshAlertsMenu)
  return wrap
}

// ----------------------------------------------------------------------------
// Session persistence — restore the workspace (layout, charts, drawings, mode).
// ----------------------------------------------------------------------------
function persistSession(): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ ...snapshot(), mode }))
  } catch {
    /* quota */
  }
}
function restoreSession(): void {
  let ok = false
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (raw) {
      const s = JSON.parse(raw) as SavedLayout & { mode?: 'charts' | 'options' }
      if (s && Array.isArray(s.panes) && s.panes.length) {
        applySaved(s)
        setMode(s.mode === 'options' ? 'options' : 'charts')
        ok = true
      }
    }
  } catch {
    /* corrupt — fall through to default */
  }
  if (!ok) {
    setLayout('1')
    applyTheme('dark')
    setMode('charts')
  }
}

// ----------------------------------------------------------------------------
// Bar replay — step/scrub the active chart through history.
// ----------------------------------------------------------------------------
// Replay is bound to the pane it started on (replayPane), not active(), so
// switching panes/symbols cleanly un-clips the right chart.
const replayTotal = (): number => replayPane?.totalBars ?? 0
function stopReplayTimer(): void {
  if (replayTimer !== null) {
    clearInterval(replayTimer)
    replayTimer = null
  }
}
function updateReplayUI(): void {
  const total = replayTotal()
  if (replaySlider) {
    replaySlider.max = String(Math.max(0, total - 1))
    replaySlider.value = String(replayIndex)
  }
  if (replayPos) replayPos.textContent = replayIndex < 0 ? 'Click a bar to start' : `${replayIndex + 1} / ${total}`
  if (replayPlayBtn) replayPlayBtn.innerHTML = replayPlaying ? ICONS.pause : ICONS.play
}
function setReplayIndex(i: number): void {
  if (!replayPane) return
  const total = replayTotal()
  const next = Math.max(0, Math.min(total - 1, i))
  // Paper fills are history: once the session has traded, replay only moves forward.
  if (replayIndex >= 0 && next < replayIndex && paper && !paper.canRewind()) {
    paper.flash('Paper trades are open in this session. End the session to go back in time.', 'err')
    updateReplayUI()
    return
  }
  replayPane.cancelBarPick()
  replayIndex = next
  replayPane.setReplayIndex(replayIndex) // indicators/overlays recompute on bars [0..index]
  paper?.onReplayBar()
  updateReplayUI()
  refreshToolLegends() // live-only tools say they're paused; GEX names the snapshot it shows
  if (replayIndex >= total - 1) {
    replayPause() // reached the live edge
    paper?.endSession('Replay end')
  }
}
function replayPlay(): void {
  if (!replayActive || !replayPane || replayIndex < 0 || replayIndex >= replayTotal() - 1) return
  replayPlaying = true
  replayPane.engine.setReplayPlaying(true)
  stopReplayTimer()
  const stepMs = Math.max(60, 700 / replaySpeed)
  replayTimer = window.setInterval(() => setReplayIndex(replayIndex + 1), stepMs)
  updateReplayUI()
}
function replayPause(): void {
  replayPlaying = false
  stopReplayTimer()
  replayPane?.engine.setReplayPlaying(false)
  updateReplayUI()
}
function enterReplay(): void {
  const p = active()
  if (!p || p.candles.length < 10 || mode !== 'charts') return
  replayActive = true
  replayPane = p
  replayIndex = -1
  replayBar.style.display = 'flex'
  replayToggleBtn.classList.add('active')
  paper?.start(p)
  selectReplayStart()
}
/** TV-style "Select bar": show the full chart, hover to preview, click to start there. */
function selectReplayStart(): void {
  const p = replayPane
  if (!p) return
  if (paper && !paper.canRewind()) {
    paper.flash('Paper trades are open in this session. End the session to pick a new start bar.', 'err')
    return
  }
  replayPause()
  const resumeAt = replayIndex
  p.endReplay()
  replayIndex = -1
  updateReplayUI()
  p.pickReplayBar(
    (i) => setReplayIndex(i),
    () => (resumeAt >= 0 ? setReplayIndex(resumeAt) : exitReplay()),
  )
}
function exitReplay(): void {
  if (!replayActive) return
  stopReplayTimer()
  replayActive = false
  replayPlaying = false
  replayPane?.engine.setReplayPlaying(false)
  replayPane?.endReplay()
  replayPane = null
  refreshToolLegends()
  paper?.stop() // flattens, saves and summarizes the paper session
  if (replayBar) replayBar.style.display = 'none'
  replayToggleBtn?.classList.remove('active')
}

// ----------------------------------------------------------------------------
// Footer.
// ----------------------------------------------------------------------------
/** Date ranges zoom the active chart to that span of the loaded history at its current timeframe. */
const DAY_MS = 86_400_000
const RANGES: [string, number | 'ytd' | 'all'][] = [
  ['1D', DAY_MS], ['5D', 5 * DAY_MS], ['1M', 30 * DAY_MS], ['3M', 91 * DAY_MS],
  ['6M', 182 * DAY_MS], ['YTD', 'ytd'], ['1Y', 365 * DAY_MS], ['All', 'all'],
]
function zoomToRange(span: number | 'ytd' | 'all'): void {
  const p = active()
  if (!p) return
  if (span === 'all') return p.engine.zoomToBars(Math.max(10, p.totalBars))
  const ms = span === 'ytd' ? Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1) : span
  const ivMs = INTERVAL_MS[p.state.interval] ?? 60_000
  p.engine.zoomToBars(Math.max(10, Math.round(ms / ivMs)))
}

function buildGoToDate(): HTMLElement {
  const wrap = el('div', { class: 'dd foot-dd' })
  const trigger = el('button', { class: 'tv-btn foot-btn', title: 'Go to date', 'aria-label': 'Go to date' })
  trigger.innerHTML = WIDGET_ICONS.calendar
  const menu = el('div', { class: 'dd-menu' })
  const input = el('input', { type: 'datetime-local', class: 'goto-input' }) as HTMLInputElement
  const go = el('button', { class: 'btn btn-primary' }, 'Go to')
  go.addEventListener('click', () => {
    const t = Date.parse(input.value)
    if (Number.isFinite(t)) active()?.engine.scrollToTime(t)
    closeAllPopovers()
  })
  input.addEventListener('click', (e) => e.stopPropagation())
  menu.append(el('div', { class: 'menu-head' }, 'Go to date'), input, go)
  wrap.append(trigger, menu)
  registerPopover(wrap, trigger, menu)
  return wrap
}

function buildFooter(): void {
  const ranges = el('div', { class: 'range-group' })
  for (const [label, span] of RANGES) {
    const b = el('button', { class: 'tv-btn foot-btn' }, label)
    b.addEventListener('click', () => zoomToRange(span))
    ranges.appendChild(b)
  }
  const reset = el('button', { class: 'tv-btn foot-btn', title: 'Reset view', 'aria-label': 'Reset view' }, ICONS.reset)
  reset.addEventListener('click', () => active().engine.resetView())

  replayBar = el('div', { class: 'replay-bar', style: 'display:none' })
  const exitBtn = el('button', { class: 'mini-btn', title: 'Exit replay' }, '✕')
  exitBtn.addEventListener('click', exitReplay)
  const pickBtn = el(
    'button',
    { class: 'mini-btn', title: 'Select bar (hover + click the replay start)' },
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v18"/><path d="M5 9l-3 3 3 3"/><path d="M19 9l3 3-3 3"/></svg>',
  )
  pickBtn.addEventListener('click', selectReplayStart)
  const back = el('button', { class: 'mini-btn', title: 'Step back' }, ICONS.stepBack)
  back.addEventListener('click', () => {
    replayPause()
    setReplayIndex(replayIndex - 1)
  })
  replayPlayBtn = el('button', { class: 'mini-btn', title: 'Play / pause' }, ICONS.play)
  replayPlayBtn.addEventListener('click', () => (replayPlaying ? replayPause() : replayPlay()))
  const fwd = el('button', { class: 'mini-btn', title: 'Step forward' }, ICONS.stepFwd)
  fwd.addEventListener('click', () => {
    replayPause()
    setReplayIndex(replayIndex + 1)
  })
  const speedSel = el('select', { class: 'opt-select', title: 'Speed' }) as HTMLSelectElement
  for (const s of [0.5, 1, 2, 5, 10]) speedSel.appendChild(el('option', { value: String(s) }, `${s}×`))
  speedSel.value = '1'
  speedSel.addEventListener('change', () => {
    replaySpeed = Number(speedSel.value)
    if (replayPlaying) replayPlay() // restart timer at the new cadence
  })
  replaySlider = el('input', { type: 'range', class: 'replay-slider', min: '0', max: '100', value: '0' }) as HTMLInputElement
  replaySlider.addEventListener('input', () => {
    replayPause()
    setReplayIndex(Number(replaySlider.value))
  })
  replayPos = el('span', { class: 'replay-pos' }, '')
  replayBar.append(exitBtn, pickBtn, back, replayPlayBtn, fwd, speedSel, replaySlider, replayPos)

  // Price-scale modes for the active chart (the axis "A"/"L" buttons do the same).
  const pctBtn = el('button', { class: 'tv-btn foot-btn', title: 'Percent price scale (from the first visible bar)' }, '%')
  pctBtn.addEventListener('click', () => {
    updateChartSettings({ priceMode: chartSettings.priceMode === 'percent' ? 'price' : 'percent' })
    syncScaleButtons()
  })
  const logBtn = el('button', { class: 'tv-btn foot-btn', title: 'Logarithmic price scale' }, 'log')
  logBtn.addEventListener('click', () => {
    updateChartSettings({ log: !chartSettings.log })
    syncScaleButtons()
  })
  const autoBtn = el('button', { class: 'tv-btn foot-btn', title: 'Auto-fit price scale to the visible bars' }, 'auto')
  autoBtn.addEventListener('click', () => {
    const e = active()?.engine
    if (e) e.setPriceScale({ auto: !e.getPriceScale().auto })
    syncScaleButtons()
  })
  const syncScaleButtons = (): void => {
    const sc = active()?.engine.getPriceScale()
    logBtn.classList.toggle('active', !!sc?.log)
    pctBtn.classList.toggle('active', sc?.mode === 'percent')
    autoBtn.classList.toggle('active', !!sc?.auto)
  }

  // Clock + time-zone menu: the zone drives the chart's time axis, crosshair,
  // Data window and the sessions timeline.
  const tzWrap = el('div', { class: 'dd foot-dd tz-dd' })
  const clock = el('button', { class: 'tv-btn foot-btn foot-clock', title: 'Time zone', 'aria-haspopup': 'menu' }, '—')
  const tzMenu = el('div', { class: 'dd-menu tz-menu' })
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const ZONES: [string, string][] = [
    ['UTC', 'UTC'],
    ['Asia/Kolkata', 'Kolkata (IST) — exchange time'],
    ['Asia/Dubai', 'Dubai'],
    ['Asia/Singapore', 'Singapore'],
    ['Asia/Tokyo', 'Tokyo'],
    ['Australia/Sydney', 'Sydney'],
    ['Europe/London', 'London'],
    ['America/New_York', 'New York'],
    ['America/Chicago', 'Chicago'],
  ]
  if (browserZone && !ZONES.some(([z]) => z === browserZone)) ZONES.push([browserZone, `${browserZone} (this device)`])
  const renderTzMenu = (): void => {
    tzMenu.replaceChildren(el('div', { class: 'menu-head' }, 'Time zone'))
    for (const [zone, label] of ZONES) {
      const on = zone === getDisplayTimeZone()
      const row = el('div', { class: `menu-item${on ? ' sel' : ''}` })
      row.append(el('span', { class: 'mi-check' }, on ? '✓' : ''), el('span', { class: 'mi-grow' }, label))
      row.addEventListener('click', () => {
        setDisplayTimeZone(zone)
        try {
          localStorage.setItem('candl.timeZone', zone)
        } catch {
          /* storage unavailable */
        }
        closeAllPopovers()
        for (const p of panes) {
          applySettingsTo(p) // axis-corner time-zone label
          p.refresh()
        }
        symbolDetails.refreshTimes()
        refreshSidePanels()
        tick()
      })
      tzMenu.appendChild(row)
    }
  }
  clock.addEventListener('click', renderTzMenu)
  tzWrap.append(clock, tzMenu)
  registerPopover(tzWrap, clock, tzMenu)
  let savedZone: string | null = null
  try {
    savedZone = localStorage.getItem('candl.timeZone')
  } catch {
    /* storage unavailable — keep the IST default */
  }
  if (savedZone) setDisplayTimeZone(savedZone)

  const tick = (): void => {
    const now = new Date()
    let hms = now.toISOString().slice(11, 19)
    try {
      hms = new Intl.DateTimeFormat('en-GB', { timeZone: getDisplayTimeZone(), hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now)
    } catch {
      /* unknown zone — UTC fallback */
    }
    clock.textContent = `${hms} ${displayZoneLabel()}`
    if (mode === 'charts' && panes[activeIdx]) {
      updateSymbolChip(panes[activeIdx].state.symbol)
      syncFooter()
      syncScaleButtons()
      refreshToolLegends()
      refreshSidePanels()
    }
  }
  tick()
  setInterval(tick, 1000)

  footerEl.append(
    ranges,
    el('span', { class: 'tv-sep' }),
    buildGoToDate(),
    reset,
    replayBar,
    footerStatus,
    latencyEl,
    el('span', { class: 'foot-grow' }),
    tzWrap,
    el('span', { class: 'tv-sep' }),
    pctBtn,
    logBtn,
    autoBtn,
  )
}

// ----------------------------------------------------------------------------
// Pane legend rows for active power tools (name + key values + hide/settings/remove).
// ----------------------------------------------------------------------------
function refreshToolLegends(): void {
  for (const p of panes) {
    const hidden = new Set(p.state.hiddenTools ?? [])
    const rows = POWER_TOOLS.filter((t) => !t.action && (t.isOn(p) || hidden.has(t.id))).map((t) => {
      const isHidden = !t.isOn(p)
      const setHidden = (h: boolean): void => {
        const next = new Set(p.state.hiddenTools ?? [])
        if (h) next.add(t.id)
        else next.delete(t.id)
        p.state.hiddenTools = [...next]
      }
      return {
        id: t.id,
        label: t.label,
        values: isHidden ? [] : p.getToolValues(t.id),
        hidden: isHidden,
        onToggle: (): void => {
          t.setOn(p, isHidden)
          setHidden(!isHidden)
          refreshToolLegends()
          refreshPowerToolsMenu()
        },
        onSettings: t.openSettings ? (): void => t.openSettings!(p) : undefined,
        select: t.legendSelect?.(p),
        onRemove: (): void => {
          t.setOn(p, false)
          setHidden(false)
          refreshToolLegends()
          refreshPowerToolsMenu()
        },
      }
    })
    // the faded volume at the bottom of the chart is a chart setting, not an indicator:
    // give it a row too, or it looks impossible to close once the Vol pane is gone
    const volumeOff = (): void => updateChartSettings({ volumeOverlay: false })
    const volumeRow = chartSettings.volumeOverlay
      ? [{ id: 'volume-overlay', label: 'Volume on chart', values: [], hidden: false, onToggle: volumeOff, onSettings: openSettingsDialog, onRemove: volumeOff }]
      : []
    p.setToolLegend([...volumeRow, ...rows])
  }
}

// ----------------------------------------------------------------------------
// V4: chart settings, layout sync, compare, command palette, save, dock panels.
// ----------------------------------------------------------------------------
let chartSettings: ChartSettingsV4 = loadChartSettings()
// One-time: the symbol watermark is now off by default — switch it off in
// settings saved before that change too (it can be re-enabled in Status line).
try {
  if (localStorage.getItem('candl.watermarkOff.v1') !== '1') {
    chartSettings = { ...chartSettings, watermark: false }
    saveChartSettings(chartSettings)
    localStorage.setItem('candl.watermarkOff.v1', '1')
  }
} catch {
  /* storage unavailable — the default (off) still applies */
}
let drawingsHiddenAll = false
let drawingsLockedAll = false
const SYNC_KEY = 'candl.layoutSync'
const layoutSync: { symbol: boolean; interval: boolean; crosshair: boolean; time: boolean; drawings: boolean } = {
  symbol: false,
  interval: false,
  crosshair: true,
  time: true,
  drawings: false,
  ...readJSON<Partial<{ symbol: boolean; interval: boolean; crosshair: boolean; time: boolean; drawings: boolean }>>(SYNC_KEY, {}),
}

/** Apply the app-wide chart settings to one chart (compares force % labels, like TradingView). */
function applySettingsTo(p: ChartPane): void {
  const s = chartSettings
  p.engine.setSettings({ ...ENGINE_DEFAULT_SETTINGS, upColor: s.upColor, downColor: s.downColor, gridVisible: s.gridMode !== 'none', crosshairVisible: s.crosshair })
  p.engine.setAppearance({
    background: s.background,
    gridMode: s.gridMode,
    sessionBreaks: s.sessionBreaks,
    lastPriceLine: s.lastPriceLine,
    countdown: s.countdown,
    ohlcLegend: s.ohlcLegend,
    volumeOverlay: s.volumeOverlay,
    smooth: s.smooth,
    candleBody: s.candleBody,
    candleBorder: s.candleBorder,
    candleWick: s.candleWick,
    crosshairStyle: s.crosshairStyle,
    backgroundGradient: s.backgroundMode === 'gradient' ? s.backgroundGradient : null,
    percentButton: true,
    cornerLabel: displayZoneLabel(),
  })
  const mode = p.getCompares().length > 0 && s.priceMode === 'price' ? 'percent' : s.priceMode
  p.engine.setPriceScale({ log: s.log, invert: s.invert, mode })
  p.setDisplayOptions({ watermark: s.watermark, venue: s.venueInTitle, precision: s.precision === 'auto' ? null : s.precision })
}
function updateChartSettings(patch: Partial<ChartSettingsV4>): void {
  chartSettings = { ...chartSettings, ...patch }
  saveChartSettings(chartSettings)
  for (const p of panes) applySettingsTo(p)
  updatePaneAlerts()
  refreshToolLegends()
}
function openSettingsDialog(): void {
  closeAllPopovers()
  openChartSettings(
    chartSettings,
    (next) => {
      chartSettings = next
      saveChartSettings(next)
      for (const p of panes) applySettingsTo(p)
      updatePaneAlerts()
      refreshToolLegends()
    },
    'canvas',
    {
      alertSound: {
        get: () => ({ soundOn: alertCfg.soundOn, tune: alertCfg.tune, duration: alertCfg.duration }),
        set: (patch) => {
          Object.assign(alertCfg, patch)
          persistAlertCfg()
          refreshAlertsMenu()
        },
        tunes: ALERT_TUNES.map((t) => t.name),
        preview: (tune, seconds) => void playTune(tune, seconds),
      },
      sessionsOverlay: {
        get: () => active().hasIndicator('sessions'),
        set: (on) => {
          if (on) indicatorsHost.add('sessions')
          else indicatorsHost.remove('sessions')
        },
      },
      paperActive: () => !!paper?.hasSession,
    },
  )
}
function setDrawingsHiddenAll(on: boolean): void {
  drawingsHiddenAll = on
  for (const p of panes) p.engine.setDrawingsHidden(on)
  hideAllItem?.classList.toggle('active', on)
}
function setDrawingsLockedAll(on: boolean): void {
  drawingsLockedAll = on
  for (const p of panes) p.engine.setDrawingsLocked(on)
  lockAllItem?.classList.toggle('active', on)
}
/** Paper limit order from the chart menu (Chart settings → Trading). */
function placeChartOrder(side: 'buy' | 'sell', price: number): void {
  if (!paper) return
  const qty = chartSettings.paperQty
  const px = Number(price.toFixed(price >= 100 ? 2 : 6))
  if (chartSettings.confirmChartOrders && !window.confirm(`Place a paper ${side.toUpperCase()} LIMIT for ${qty} contract${qty === 1 ? '' : 's'} at ${px}?`)) return
  const r = paper.placeLimitAt(side, px, qty)
  flashToast(r.ok ? `Paper ${side} limit ${qty} @ ${px} placed.` : r.error)
}
/** "Lock vertical cursor here" applies to every chart in the layout (same time). */
function setCursorLockAll(time: number | null): void {
  for (const p of panes) p.engine.setCursorLock(time)
}
/** Drawings sync: copy one chart's drawings to the other charts showing the same symbol. */
let syncingDrawings = false
function syncDrawingsFrom(src: ChartPane): void {
  if (!layoutSync.drawings || syncingDrawings || panes.length < 2) return
  syncingDrawings = true
  try {
    const list = JSON.parse(JSON.stringify(src.state.drawings)) as typeof src.state.drawings
    for (const q of panes) {
      if (q === src || q.state.symbol !== src.state.symbol) continue
      q.engine.setDrawings(list)
      q.state.drawings = list
      q.state.drawingsBySymbol = { ...(q.state.drawingsBySymbol ?? {}), [q.state.symbol]: list }
    }
  } finally {
    syncingDrawings = false
  }
}

// ---- Footer: REST round-trip latency to Delta (every 15 s while visible) ----
const latencyEl = el('span', { class: 'foot-latency', title: 'Round trip to Delta India (public API)' })
async function probeLatency(): Promise<void> {
  if (document.visibilityState !== 'visible' || mode !== 'charts' || !panes.length) return
  const sym = encodeURIComponent(active().state.symbol)
  const t0 = performance.now()
  try {
    const res = await fetch(`https://api.india.delta.exchange/v2/tickers/${sym}`, { cache: 'no-store' })
    await res.arrayBuffer()
    const ms = Math.round(performance.now() - t0)
    latencyEl.textContent = `${ms} ms`
    latencyEl.className = `foot-latency ${ms < 250 ? 'good' : ms < 800 ? 'ok' : 'slow'}`
  } catch {
    latencyEl.textContent = 'offline'
    latencyEl.className = 'foot-latency slow'
  }
}
setInterval(() => void probeLatency(), 15_000)
setTimeout(() => void probeLatency(), 2_000)

// ---- Header symbol chip: coin logo + instrument tag (PERP / SPOT / CALL / PUT) ----
let chipLogo: HTMLElement | null = null
let chipTag: HTMLElement | null = null
let chipSymbol = ''
function instrumentTag(sym: string): string {
  const s = sym.toUpperCase()
  if (s.startsWith('C-')) return 'CALL'
  if (s.startsWith('P-')) return 'PUT'
  if (s.includes('_')) return 'SPOT'
  if (/USDT?$/.test(s)) return 'PERP'
  return ''
}
function updateSymbolChip(sym: string): void {
  if (!chipLogo || !chipTag || sym === chipSymbol) return
  chipSymbol = sym
  chipLogo.innerHTML = symbolLogo(sym)
  const tag = instrumentTag(sym)
  chipTag.textContent = tag
  chipTag.style.display = tag ? '' : 'none'
}

let hideAllItem: HTMLElement | null = null
let lockAllItem: HTMLElement | null = null

// ---- Compare ----
function addCompare(sym: string): void {
  const p = active()
  const symbol = sym.trim().toUpperCase()
  if (!symbol || symbol === p.state.symbol || p.getCompares().some((c) => c.symbol === symbol)) return
  const used = new Set(p.getCompares().map((c) => c.color))
  const color = COMPARE_COLORS.find((c) => !used.has(c)) ?? COMPARE_COLORS[p.getCompares().length % COMPARE_COLORS.length]
  p.setCompares([...p.getCompares(), { symbol, color }])
  applySettingsTo(p)
  refreshCompareMenu()
}
let compareMenu: HTMLElement
function refreshCompareMenu(): void {
  if (!compareMenu) return
  const p = active()
  compareMenu.replaceChildren()
  const box = el('input', { class: 'menu-search', placeholder: 'Add symbol to compare…', spellcheck: 'false', 'aria-label': 'Symbol to compare' }) as HTMLInputElement
  const results = el('div', {})
  compareMenu.append(box)
  const list = p.getCompares()
  if (list.length) {
    compareMenu.appendChild(el('div', { class: 'menu-head' }, 'On this chart'))
    for (const c of list) {
      const row = el('div', { class: 'menu-item' })
      const dot = el('span', { class: 'cmp-dot' })
      dot.style.background = c.color
      const name = el('span', { class: 'mi-grow' })
      name.textContent = c.symbol
      const rm = el('button', { class: 'mi-icon', title: 'Remove', 'aria-label': `Remove ${c.symbol}` }, ICONS.close)
      rm.addEventListener('click', (e) => {
        e.stopPropagation()
        p.setCompares(p.getCompares().filter((x) => x.symbol !== c.symbol))
        applySettingsTo(p)
        refreshCompareMenu()
      })
      row.append(dot, name, rm)
      compareMenu.appendChild(row)
    }
  }
  compareMenu.append(results)
  const render = (syms: string[], head: string): void => {
    results.replaceChildren(el('div', { class: 'menu-head' }, head))
    for (const sym of syms.filter((x) => x !== p.state.symbol).slice(0, 10)) {
      const item = el('div', { class: 'menu-item' })
      const t = el('span', { class: 'mi-grow' })
      t.textContent = sym
      item.append(el('span', { class: 'mi-check' }, '+'), t)
      item.addEventListener('click', () => addCompare(sym))
      results.appendChild(item)
    }
  }
  render(SEARCH_POPULAR, 'Popular')
  let gen = 0
  box.addEventListener('click', (e) => e.stopPropagation())
  box.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && box.value.trim()) addCompare(box.value)
  })
  box.addEventListener('input', async () => {
    const q = box.value.trim()
    const my = ++gen
    if (!q) return render(SEARCH_POPULAR, 'Popular')
    try {
      const found = await provider.searchSymbols(q)
      if (my === gen) render(found.map((f) => f.symbol), 'Results')
    } catch {
      /* offline */
    }
  })
  requestAnimationFrame(() => box.focus())
}
function buildCompare(): HTMLElement {
  const wrap = el('div', { class: 'dd' })
  const trigger = el('button', { class: 'tv-btn', title: 'Compare or add symbol' })
  trigger.append(el('span', {}, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'), el('span', {}, 'Compare'))
  compareMenu = el('div', { class: 'dd-menu' })
  wrap.append(trigger, compareMenu)
  registerPopover(wrap, trigger, compareMenu)
  trigger.addEventListener('click', refreshCompareMenu)
  return wrap
}

// ---- Command palette (⌘K) ----
function paletteActions(): PaletteAction[] {
  const a: PaletteAction[] = []
  for (const iv of DEMO_INTERVALS) {
    a.push({ group: 'Timeframe', label: `Switch timeframe to ${INTERVAL_LABELS[iv]}`, hint: iv, keywords: `${iv} interval timeframe`, run: () => chooseInterval(iv) })
  }
  for (const t of CHART_TYPES) {
    a.push({ group: 'Chart type', label: `Chart type: ${CHART_TYPE_LABELS[t] ?? t}`, keywords: 'chart type style', run: () => active().setChartType(t) })
  }
  const toggle = (label: string, on: boolean, run: () => void, keywords = ''): void => {
    a.push({ group: 'Chart', label: `${on ? 'Turn off' : 'Turn on'} ${label}`, keywords, run })
  }
  for (const palette of CANDLE_PALETTES) {
    a.push({
      group: 'Chart',
      label: `Candle palette: ${palette.label}`,
      keywords: `candles colors palette ${palette.description}`,
      run: () => updateChartSettings({ candlePalette: palette.id, upColor: palette.up, downColor: palette.down }),
    })
  }
  toggle('percent price scale', chartSettings.priceMode === 'percent', () => updateChartSettings({ priceMode: chartSettings.priceMode === 'percent' ? 'price' : 'percent' }), '% scale')
  toggle('log scale', chartSettings.log, () => updateChartSettings({ log: !chartSettings.log }), 'logarithmic')
  toggle('inverted scale', chartSettings.invert, () => updateChartSettings({ invert: !chartSettings.invert }), 'flip invert')
  toggle('volume on chart', chartSettings.volumeOverlay, () => updateChartSettings({ volumeOverlay: !chartSettings.volumeOverlay }))
  toggle('session breaks', chartSettings.sessionBreaks, () => updateChartSettings({ sessionBreaks: !chartSettings.sessionBreaks }), 'day separator')
  toggle('smooth motion', chartSettings.smooth, () => updateChartSettings({ smooth: !chartSettings.smooth }), 'animation kinetic')
  a.push(
    { group: 'Chart', label: 'Reset chart view', hint: '⌥R', run: () => active().engine.resetView() },
    { group: 'Chart', label: 'Chart settings…', keywords: 'appearance colors background grid', run: openSettingsDialog },
    { group: 'Chart', label: 'Indicators…', keywords: 'study add', run: () => openIndicatorsDialog(indicatorsHost, 'all') },
    { group: 'Chart', label: 'Add alert at the last price', keywords: 'alert bell', run: () => addAlert(active().state.symbol, (active().candles[active().candles.length - 1]?.close ?? 0)) },
    { group: 'Chart', label: `${replayActive ? 'Exit' : 'Start'} bar replay`, keywords: 'replay history', run: () => (replayActive ? exitReplay() : enterReplay()) },
    { group: 'Drawings', label: `${drawingsHiddenAll ? 'Show' : 'Hide'} all drawings`, run: () => setDrawingsHiddenAll(!drawingsHiddenAll) },
    { group: 'Drawings', label: `${drawingsLockedAll ? 'Unlock' : 'Lock'} all drawings`, run: () => setDrawingsLockedAll(!drawingsLockedAll) },
    { group: 'Drawings', label: 'Remove all drawings', run: () => active().clearDrawings() },
    { group: 'Panels', label: 'Watchlist', run: () => setDockView('watchlist') },
    { group: 'Panels', label: 'Alerts', run: () => setDockView('alerts') },
    { group: 'Panels', label: 'Order book', keywords: 'depth ladder', run: () => setDockView('book') },
    { group: 'Panels', label: 'Object tree', run: () => setDockView('objects') },
    { group: 'Panels', label: 'Data window', run: () => setDockView('data') },
    { group: 'Layout', label: 'Single chart', run: () => setLayout('1') },
    { group: 'Layout', label: 'Two charts side by side', run: () => setLayout('2h') },
    { group: 'Layout', label: 'Four charts', run: () => setLayout('4') },
    { group: 'Layout', label: 'Save layout', keywords: 'save', run: () => quickSave() },
    { group: 'App', label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`, keywords: 'theme dark light', run: () => applyTheme(theme === 'dark' ? 'light' : 'dark') },
  )
  return a
}
/** "Add alert on <symbol>" from ⌘K: an alert at that symbol's latest price. */
async function alertAtLastPrice(sym: string): Promise<void> {
  try {
    const c = await provider.fetchCandles(sym, '1m', 1)
    const last = c[c.length - 1]?.close
    if (!last) throw new Error('no price')
    addAlert(sym, last)
    flashToast(`Alert added on ${sym} at ${last}. Drag its line on the chart to move it.`)
  } catch {
    flashToast(`Could not read a price for ${sym}.`)
  }
}
function openPalette(initial = ''): void {
  closeAllPopovers()
  openCommandPalette(
    {
      searchSymbols: async (q) => (await provider.searchSymbols(q)).map((f) => ({ symbol: f.symbol, description: f.description })),
      popularSymbols: () => SEARCH_POPULAR,
      intervals: () => DEMO_INTERVALS,
      openSymbol: (sym, iv) => {
        setMode('charts')
        if (iv) chooseInterval(iv as Interval)
        pickSymbol(sym)
      },
      compareSymbol: (sym) => addCompare(sym),
      alertSymbol: (sym) => void alertAtLastPrice(sym),
      actions: paletteActions,
      indicators: () =>
        ALL_INDICATORS.map((d) => ({
          label: d.label,
          family: indicatorFamily(d.id),
          onChart: active().hasIndicator(d.id),
          run: () => {
            if (!active().hasIndicator(d.id)) indicatorsHost.add(d.id)
          },
        })),
    },
    initial,
  )
}
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    openPalette()
    return
  }
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  if (e.altKey && !e.metaKey && !e.ctrlKey && mode === 'charts') {
    const k = e.code
    if (k === 'KeyR') {
      e.preventDefault()
      active().engine.resetView()
    } else if (k === 'KeyA') {
      e.preventDefault()
      const last = active().candles[active().candles.length - 1]
      if (last) addAlert(active().state.symbol, last.close)
    } else if (k === 'KeyH' && e.metaKey) {
      e.preventDefault()
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyH') {
    e.preventDefault()
    setDrawingsHiddenAll(!drawingsHiddenAll)
  }
})

// ---- Save (quick-save the current workspace as a named layout) ----
let currentLayoutName: string | null = readJSON<string | null>('candl.currentLayoutName', null)
function quickSave(): void {
  const name = currentLayoutName ?? `Layout ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  const m = loadSaved()
  m[name] = snapshot()
  persistSaved(m)
  currentLayoutName = name
  try {
    localStorage.setItem('candl.currentLayoutName', JSON.stringify(name))
  } catch {
    /* storage unavailable */
  }
  flashToast(`Saved “${name}”. Rename or load it from Layouts.`)
}
function buildSave(): HTMLElement {
  const b = el('button', { class: 'tv-btn save-btn', title: 'Save layout (⌘S)' })
  b.append(el('span', {}, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h8l4 4v12a2 2 0 01-2 2z"/><path d="M8 3v5h7"/></svg>'), el('span', {}, 'Save'))
  b.addEventListener('click', quickSave)
  return b
}
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    quickSave()
  }
})

// ---- Layout sync toggles (inside the layout menu) ----
function appendSyncControls(menu: HTMLElement): void {
  menu.appendChild(el('div', { class: 'menu-head' }, 'Sync in layout'))
  for (const [key, label] of [['symbol', 'Symbol'], ['interval', 'Interval'], ['crosshair', 'Crosshair'], ['time', 'Time scroll'], ['drawings', 'Drawings (same symbol)']] as const) {
    const row = el('label', { class: 'menu-item sync-row' })
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement
    cb.checked = layoutSync[key]
    cb.addEventListener('change', () => {
      layoutSync[key] = cb.checked
      try {
        localStorage.setItem(SYNC_KEY, JSON.stringify(layoutSync))
      } catch {
        /* storage unavailable */
      }
      if (key === 'crosshair' && !cb.checked) for (const p of panes) p.engine.setExternalCrosshair(null)
      if (key === 'drawings' && cb.checked) syncDrawingsFrom(active())
    })
    row.addEventListener('click', (e) => e.stopPropagation())
    const t = el('span', { class: 'mi-grow' })
    t.textContent = label
    row.append(t, cb)
    menu.appendChild(row)
  }
}

// ---- Alerts + Order book dock panels ----
const alertsPanel = new AlertsPanel(() => setDockView(null))
alertsPanel.onRemove = (id) => {
  removeAlert(id)
  refreshSidePanels()
}
alertsPanel.onAddHere = () => {
  const p = active()
  const last = p.candles[p.candles.length - 1]
  if (last) addAlert(p.state.symbol, last.close)
  refreshSidePanels()
}
alertsPanel.onClearTriggered = () => {
  for (const a of alerts.filter((x) => x.triggered)) removeAlert(a.id)
  refreshSidePanels()
}
alertsPanel.onPick = (sym) => pickSymbol(sym)
const orderBook = new OrderBookPanel(provider, () => setDockView(null))

// ----------------------------------------------------------------------------
// Assemble.
// ----------------------------------------------------------------------------
// Spot-only controls (hidden in Options mode).
spotControls = el('span', { class: 'spot-controls' })
spotControls.append(
  buildSymbol(),
  el('span', { class: 'tv-sep' }),
  buildInterval(),
  el('span', { class: 'tv-sep' }),
  buildChartType(),
  el('span', { class: 'tv-sep' }),
  buildIndicators(),
  hideAt(2, buildCompare()),
  hideAt(2, buildVolumeProfile()),
  hideAt(3, buildAlerts()),
  hideAt(3, buildReplayToggle()),
  hideAt(2, buildUndoRedo()),
  el('span', { class: 'tv-sep' }),
  buildPowerTools(),
  hideAt(3, buildStrategyTesterToggle()),
)
headerEl.append(
  buildBrand(),
  spotControls,
  el('span', { class: 'tv-spacer' }),
  buildModeToggle(),
  hideAt(2, el('span', { class: 'tv-sep' })),
  hideAt(3, buildLayoutSelector()),
  buildSavedLayouts(),
  buildSave(),
  buildTheme(),
  buildFullscreen(),
)
// Fit the header to any screen: while it is wider than the window, step through
// compact levels (tighter spacing → fewer interval chips, compare / undo → alerts,
// replay, tester, grid picker → swipe to scroll). Everything hidden stays reachable:
// alerts and the tester from the right dock, the rest from ⌘K, undo from the keyboard.
function hideAt<T extends HTMLElement>(level: number, node: T): T {
  node.dataset.hideAt = String(level)
  return node
}
const FIT_LEVELS = 4
function fitHeader(): void {
  for (let l = 1; l <= FIT_LEVELS; l++) headerEl.classList.remove(`fit-${l}`)
  for (let l = 1; l <= FIT_LEVELS && headerEl.scrollWidth > headerEl.clientWidth + 1; l++) headerEl.classList.add(`fit-${l}`)
}
const headerFit = new ResizeObserver(() => fitHeader())
headerFit.observe(headerEl)
headerFit.observe(spotControls)
window.addEventListener('resize', fitHeader)
widgetBarEl.append(
  dockButton('watchlist', 'Watchlist (Alt+W)', WIDGET_ICONS.watchlist),
  dockButton('objects', 'Object tree — indicators, tools and drawings on this chart', WIDGET_ICONS.objects),
  dockButton('data', 'Data window — values under the crosshair', WIDGET_ICONS.data),
  dockButton('alerts', 'Alerts', WIDGET_ICONS.bell),
  dockButton('book', 'Order book', WIDGET_ICONS.book),
  buildBuddyToggle(),
  el('span', { class: 'wb-sep' }),
  buildScreenshot(),
  buildSettingsButton(),
)
buildRail()
buildFooter()

strategyTester = new StrategyTester({
  activePane: () => (mode === 'charts' ? panes[activeIdx] : undefined),
  onOpenChange: (open) => {
    strategyTesterBtn?.classList.toggle('active', open)
    strategyTesterBtn?.setAttribute('aria-pressed', String(open))
    for (const p of panes) p.refresh() // the chart area just changed height
  },
})
footerEl.before(strategyTester.root)

paper = new PaperTrading({
  getSymbolInfo: (symbol) => provider.getSymbolInfo(symbol),
  onLayout: () => {
    for (const p of panes) p.refresh() // the chart area just changed width
  },
  openStrategyTester: (id) => strategyTester?.showStrategy(id),
})
watchlistEl.before(paper.root)
strategyTester.root.classList.toggle('mode-hidden', mode !== 'charts')

watchlist.onSelect = pickSymbol
watchlist.onClose = () => setDockView(null)
buildWatchDock()
watchlistEl.append(watchDock, objectTree.root, dataWindow.root, alertsPanel.root, orderBook.root)
// Closed is the unobtrusive default; a deliberate user choice survives reloads.
restoreDockView()
buddyEl.appendChild(buddy.root)
setBuddyVisible(localStorage.getItem(BUDDY_VISIBLE_KEY) === '1', false)

installShortcuts({
  setChartType: (type) => active()?.setChartType(type),
  focusSymbolSearch: () => {
    symbolInput.focus()
    symbolInput.select()
  },
  toggleWatchlist,
  isReplayActive: () => replayActive,
  replayStepBack: () => {
    replayPause()
    setReplayIndex(replayIndex - 1)
  },
  replayStepForward: () => {
    replayPause()
    setReplayIndex(replayIndex + 1)
  },
})

// From the Options tab, load the selected option into the active chart pane with
// the full toolbox (indicators / drawings / timeframes). Options have no
// sub-minute klines, so bump a sub-minute timeframe up to 1m.
optionsView.onOpenInCharts = (sym) => {
  setMode('charts')
  const p = active()
  if (p.state.interval === '1s' || p.state.interval === '15s' || p.state.interval === '30s') {
    p.state.interval = '1m'
    setIntervalLabel('1m')
    markSel(intervalMenu, 'data-iv', '1m')
  }
  symbolInput.value = sym
  void p.setSymbol(sym)
}

/**
 * Deep link: `?symbol=BTCUSD&interval=15m` opens straight onto that market.
 *
 * Applied AFTER restoreSession so it overrides the saved workspace for the
 * active pane only — everything else (layout, indicators, drawings, theme) is
 * still whatever the user left behind. This is what lets an external page (the
 * marketing site's market cards, a link in a report) launch the app on a
 * specific symbol without owning the rest of the workspace.
 *
 * Unknown symbols are left to the normal load path, which falls back to the
 * synthetic feed and shows "offline" — no special error handling needed here.
 */
function applyDeepLink(): void {
  const q = new URLSearchParams(location.search)
  const symbol = q.get('symbol')?.trim().toUpperCase()
  const interval = q.get('interval')?.trim() as Interval | null

  if (interval && DEMO_INTERVALS.includes(interval)) {
    active().state.interval = interval
    setIntervalLabel(interval)
    markSel(intervalMenu, 'data-iv', interval)
  }
  if (symbol) {
    symbolInput.value = symbol
    watchlist.setActiveSymbol(symbol)
    void active().setSymbol(symbol)
  }
}

// Alert sound: browsers keep audio locked until the page gets a click or key
// press. Unlock on the first one, and if an alert fires before that, say why it
// was silent — its tune plays as soon as the user clicks (see alerts/tunes.ts).
primeAlertAudio()
syncAlertFeeds()
onAlertAudioBlocked(() => {
  const toast = el('div', { class: 'alert-toast sound-hint show', role: 'status' }, '🔇 Alert sound is blocked by the browser until you click the page — click anywhere and it will play.')
  document.body.appendChild(toast)
  const remove = (): void => toast.remove()
  window.addEventListener('pointerdown', remove, { once: true, capture: true })
  window.setTimeout(remove, 12_000)
})

restoreSession()
applyDeepLink()

// Persist the workspace so a refresh restores it (not just on explicit Save).
window.addEventListener('beforeunload', persistSession)
window.addEventListener('pagehide', persistSession)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistSession()
})

// Dev-only handle for debugging from the browser console (not in production builds).
if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) (window as unknown as { __candl: unknown }).__candl = { panes: () => panes, active }
