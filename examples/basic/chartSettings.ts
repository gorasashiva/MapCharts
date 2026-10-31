// Chart settings (TradingView-style dialog): one app-wide set of appearance,
// scale and status-line options, applied live to every chart and persisted by
// the host on every change. Tabs: Symbol · Status line · Scales · Canvas ·
// Trading · Alerts · Events. "Template" saves / applies named presets.
// Cancel / Esc hand back the settings as they were when the dialog opened.
import type { PriceDisplayMode } from '../../src/chart/types'
import { CANDLE_PALETTES, getCandlePalette, inferCandlePalette, isCandlePaletteId, type CandlePaletteId } from '../../src/chart/themes'
import { el, ICONS } from './ui'

export interface ChartSettingsV4 {
  /** Built-in candle template or 'custom' when either colour was edited. */
  candlePalette: CandlePaletteId
  upColor: string
  downColor: string
  /** null = theme default. */
  background: string | null
  gridMode: 'both' | 'horizontal' | 'vertical' | 'none'
  crosshair: boolean
  watermark: boolean
  sessionBreaks: boolean
  volumeOverlay: boolean
  smooth: boolean
  lastPriceLine: boolean
  countdown: boolean
  ohlcLegend: boolean
  /** Show venue in the chart title row. */
  venueInTitle: boolean
  priceMode: PriceDisplayMode
  log: boolean
  invert: boolean
  /** 'auto' = the symbol's own precision. */
  precision: 'auto' | number
  candleBody: boolean
  candleBorder: boolean
  candleWick: boolean
  crosshairStyle: 'dashed' | 'dotted' | 'solid'
  /** Solid background, or a vertical gradient down to `backgroundGradient`. */
  backgroundMode: 'solid' | 'gradient'
  backgroundGradient: string
  /** Trading: paper limit orders from the chart's right-click menu (during a paper session). */
  chartMenuOrders: boolean
  paperQty: number
  confirmChartOrders: boolean
  /** Alerts: draw price-alert lines on the chart. */
  alertLines: boolean
}

export const DEFAULT_CHART_SETTINGS: ChartSettingsV4 = {
  candlePalette: 'classic',
  upColor: '#16c784',
  downColor: '#ea3943',
  background: null,
  gridMode: 'both',
  crosshair: true,
  watermark: false,
  sessionBreaks: false,
  volumeOverlay: true,
  smooth: true,
  lastPriceLine: true,
  countdown: true,
  ohlcLegend: true,
  venueInTitle: true,
  priceMode: 'price',
  log: false,
  invert: false,
  precision: 'auto',
  candleBody: true,
  candleBorder: false,
  candleWick: true,
  crosshairStyle: 'dashed',
  backgroundMode: 'solid',
  backgroundGradient: '#000000',
  chartMenuOrders: true,
  paperQty: 1,
  confirmChartOrders: true,
  alertLines: true,
}

// ---- named presets ("Template ▾") ----
const TPL_KEY = 'candl.chartSettingsTemplates'
export function loadSettingsTemplates(): Record<string, ChartSettingsV4> {
  try {
    const raw = JSON.parse(localStorage.getItem(TPL_KEY) ?? '{}')
    const out: Record<string, ChartSettingsV4> = {}
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) out[k] = normalizeChartSettings(v)
    return out
  } catch {
    return {}
  }
}
function saveSettingsTemplates(m: Record<string, ChartSettingsV4>): boolean {
  try {
    localStorage.setItem(TPL_KEY, JSON.stringify(m))
    return true
  } catch {
    return false
  }
}

/** Extra, host-owned settings shown in the dialog (they live outside ChartSettingsV4). */
export interface ChartSettingsExtras {
  alertSound: { get(): { soundOn: boolean; tune: number; duration: number }; set(patch: Partial<{ soundOn: boolean; tune: number; duration: number }>): void; tunes: string[]; preview(tune: number, seconds: number): void }
  /** Asia / London / New York session boxes on the active chart. */
  sessionsOverlay: { get(): boolean; set(on: boolean): void }
  /** Start a paper-trading session (bar replay) so chart-menu orders become available. */
  paperActive(): boolean
}

const KEY = 'candl.chartSettings.v4'

/**
 * Merge persisted settings without letting an old/invalid palette id make the
 * chart UI lie about the colours it restored. Settings from before palettes
 * existed are classified from their saved up/down pair.
 */
export function normalizeChartSettings(raw: unknown): ChartSettingsV4 {
  const source = raw && typeof raw === 'object' ? raw as Partial<ChartSettingsV4> : {}
  const merged = {
    ...DEFAULT_CHART_SETTINGS,
    ...source,
    upColor: typeof source.upColor === 'string' ? source.upColor : DEFAULT_CHART_SETTINGS.upColor,
    downColor: typeof source.downColor === 'string' ? source.downColor : DEFAULT_CHART_SETTINGS.downColor,
  }
  const normalizedUp = merged.upColor.trim().toLowerCase()
  const normalizedDown = merged.downColor.trim().toLowerCase()
  const hasPalette = Object.prototype.hasOwnProperty.call(source, 'candlePalette')
  let candlePalette: CandlePaletteId

  if (!hasPalette) {
    candlePalette = inferCandlePalette(merged.upColor, merged.downColor)
  } else if (source.candlePalette === 'custom') {
    candlePalette = 'custom'
  } else if (isCandlePaletteId(source.candlePalette)) {
    const palette = getCandlePalette(source.candlePalette)
    candlePalette = palette.up === normalizedUp && palette.down === normalizedDown
      ? source.candlePalette
      : 'custom'
  } else {
    candlePalette = inferCandlePalette(merged.upColor, merged.downColor)
  }

  return { ...merged, candlePalette }
}

export function loadChartSettings(): ChartSettingsV4 {
  try {
    return normalizeChartSettings(JSON.parse(localStorage.getItem(KEY) ?? '{}'))
  } catch {
    return { ...DEFAULT_CHART_SETTINGS }
  }
}

export function saveChartSettings(s: ChartSettingsV4): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable — settings last this session */
  }
}

export type ChartSettingsTab = 'symbol' | 'status' | 'scales' | 'canvas' | 'trading' | 'alerts' | 'events'
const TABS: [ChartSettingsTab, string][] = [
  ['symbol', 'Symbol'],
  ['status', 'Status line'],
  ['scales', 'Scales & lines'],
  ['canvas', 'Canvas'],
  ['trading', 'Trading'],
  ['alerts', 'Alerts'],
  ['events', 'Events'],
]

let open: { close(): void } | null = null

/** Open the dialog; `onChange` receives the full settings on every edit (and the originals on Cancel). */
export function openChartSettings(current: ChartSettingsV4, onChange: (s: ChartSettingsV4) => void, start: ChartSettingsTab = 'canvas', extras?: ChartSettingsExtras): void {
  open?.close()
  const original = { ...current }
  let s = { ...current }
  let tab: ChartSettingsTab = start

  const backdrop = el('div', { class: 'modal-backdrop' })
  const dlg = el('div', { class: 'cs-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Chart settings' })
  const nav = el('nav', { class: 'cs-nav', 'aria-label': 'Settings sections' })
  const body = el('div', { class: 'cs-body' })
  const content = el('div', { class: 'cs-content' })
  const foot = el('div', { class: 'cs-foot' })
  const reset = el('button', { class: 'btn cs-reset' }, 'Reset to defaults')
  const cancel = el('button', { class: 'btn' }, 'Cancel')
  const done = el('button', { class: 'btn btn-primary' }, 'Done')
  const tplWrap = el('div', { class: 'cs-tpl' })
  const tplBtn = el('button', { class: 'btn cs-tpl-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, 'Template ▾')
  const tplMenu = el('div', { class: 'cs-tpl-menu', role: 'menu' })
  tplMenu.style.display = 'none'
  tplWrap.append(tplBtn, tplMenu)
  foot.append(tplWrap, reset, el('span', { style: 'flex:1' }), cancel, done)
  const closeX = el('button', { class: 'mi-icon cs-x', title: 'Close', 'aria-label': 'Close' }, ICONS.close)
  body.append(content, foot)
  dlg.append(nav, body, closeX)
  backdrop.appendChild(dlg)

  const commit = (patch: Partial<ChartSettingsV4>): void => {
    s = { ...s, ...patch }
    onChange(s)
    renderContent()
  }
  const close = (): void => {
    backdrop.remove()
    window.removeEventListener('keydown', onKey, true)
    open = null
  }
  const revert = (): void => {
    onChange(original)
    close()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      revert()
    }
  }
  open = { close }
  window.addEventListener('keydown', onKey, true)
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close()
  })
  closeX.addEventListener('click', close)
  done.addEventListener('click', close)
  cancel.addEventListener('click', revert)
  reset.addEventListener('click', () => commit({ ...DEFAULT_CHART_SETTINGS }))

  // ---- Template ▾: save the current settings under a name / apply / delete ----
  const renderTplMenu = (): void => {
    tplMenu.replaceChildren()
    const saveRow = el('div', { class: 'cs-tpl-save' })
    const name = el('input', { class: 'cs-input', placeholder: 'Template name…', 'aria-label': 'Template name' }) as HTMLInputElement
    const save = el('button', { class: 'btn btn-primary' }, 'Save')
    const doSave = (): void => {
      const n = name.value.trim()
      if (!n) return
      const m = loadSettingsTemplates()
      m[n] = { ...s }
      save.textContent = saveSettingsTemplates(m) ? 'Saved' : 'Save failed'
      renderTplMenu()
    }
    save.addEventListener('click', doSave)
    name.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') doSave()
    })
    saveRow.append(name, save)
    tplMenu.appendChild(saveRow)
    const m = loadSettingsTemplates()
    const names = Object.keys(m)
    tplMenu.appendChild(el('div', { class: 'cs-head' }, names.length ? 'Apply template' : 'No templates yet'))
    for (const n of names) {
      const row = el('div', { class: 'cs-tpl-row', role: 'menuitem' })
      const apply = el('button', { class: 'cs-tpl-apply' })
      apply.textContent = n
      apply.addEventListener('click', () => {
        commit({ ...m[n] })
        tplMenu.style.display = 'none'
        tplBtn.setAttribute('aria-expanded', 'false')
      })
      const del = el('button', { class: 'mi-icon', title: 'Delete template', 'aria-label': `Delete template ${n}` }, ICONS.trash)
      del.addEventListener('click', () => {
        const mm = loadSettingsTemplates()
        delete mm[n]
        saveSettingsTemplates(mm)
        renderTplMenu()
      })
      row.append(apply, del)
      tplMenu.appendChild(row)
    }
    requestAnimationFrame(() => name.focus())
  }
  tplBtn.addEventListener('click', () => {
    const show = tplMenu.style.display === 'none'
    tplMenu.style.display = show ? 'flex' : 'none'
    tplBtn.setAttribute('aria-expanded', String(show))
    if (show) renderTplMenu()
  })

  // ---- field builders ----
  const head = (text: string): HTMLElement => el('div', { class: 'cs-head' }, text)
  const row = (label: string, control: HTMLElement): HTMLElement => {
    const r = el('label', { class: 'cs-row' })
    const l = el('span', {})
    l.textContent = label
    r.append(l, control)
    return r
  }
  const toggle = (label: string, key: keyof ChartSettingsV4): HTMLElement => {
    const input = el('input', { type: 'checkbox', class: 'cs-switch' }) as HTMLInputElement
    input.checked = s[key] === true
    input.addEventListener('change', () => commit({ [key]: input.checked } as Partial<ChartSettingsV4>))
    return row(label, input)
  }
  const select = <K extends keyof ChartSettingsV4>(label: string, key: K, options: [string, string][], parse: (v: string) => ChartSettingsV4[K]): HTMLElement => {
    const sel = el('select', { class: 'cs-select' }) as HTMLSelectElement
    for (const [v, t] of options) sel.add(new Option(t, v, false, String(s[key]) === v))
    sel.addEventListener('change', () => commit({ [key]: parse(sel.value) } as Partial<ChartSettingsV4>))
    return row(label, sel)
  }
  const palettePicker = (): HTMLElement => {
    const grid = el('div', { class: 'cs-palette-grid', role: 'group', 'aria-label': 'Candle color palettes' })
    for (const palette of CANDLE_PALETTES) {
      const selected = s.candlePalette === palette.id
      const button = el('button', {
        type: 'button',
        class: `cs-palette${selected ? ' on' : ''}`,
        'aria-pressed': String(selected),
        'aria-label': `${palette.label}: ${palette.description}`,
      })
      const swatches = el('span', { class: 'cs-palette-swatches', 'aria-hidden': 'true' })
      const up = el('span', { class: 'cs-palette-dot' })
      const down = el('span', { class: 'cs-palette-dot' })
      up.style.background = palette.up
      down.style.background = palette.down
      swatches.append(up, down)
      const copy = el('span', { class: 'cs-palette-copy' })
      copy.append(el('strong', { class: 'cs-palette-name' }, palette.label), el('small', { class: 'cs-palette-note' }, palette.description))
      button.append(swatches, copy)
      button.addEventListener('click', () => commit({ candlePalette: palette.id, upColor: palette.up, downColor: palette.down }))
      grid.appendChild(button)
    }
    return grid
  }

  const color = (label: string, key: 'upColor' | 'downColor'): HTMLElement => {
    const input = el('input', { type: 'color', class: 'cs-color' }) as HTMLInputElement
    input.value = s[key]
    input.addEventListener('change', () => commit({ candlePalette: 'custom', [key]: input.value } as Partial<ChartSettingsV4>))
    return row(label, input)
  }

  function renderNav(): void {
    nav.replaceChildren(el('div', { class: 'cs-title' }, 'Chart settings'))
    for (const [id, label] of TABS) {
      const b = el('button', { class: `cs-tab${id === tab ? ' active' : ''}` }, label)
      if (id === tab) b.setAttribute('aria-current', 'page')
      b.addEventListener('click', () => {
        tab = id
        renderNav()
        renderContent()
      })
      nav.appendChild(b)
    }
  }

  function renderContent(): void {
    content.replaceChildren()
    if (tab === 'symbol') {
      content.append(
        head('Candles'),
        head('Palette templates'),
        palettePicker(),
        color('Up color', 'upColor'),
        color('Down color', 'downColor'),
        head('Candle parts'),
        toggle('Body', 'candleBody'),
        toggle('Borders', 'candleBorder'),
        toggle('Wick', 'candleWick'),
        head('Price'),
        select('Decimal places', 'precision', [['auto', 'Symbol default'], ...[0, 1, 2, 3, 4, 5, 6].map((n): [string, string] => [String(n), String(n)])], (v) => (v === 'auto' ? 'auto' : Number(v))),
      )
    } else if (tab === 'status') {
      content.append(
        head('Chart title'),
        toggle('Show venue (DELTA INDIA)', 'venueInTitle'),
        toggle('OHLC, change and volume', 'ohlcLegend'),
        head('Background text'),
        toggle('Symbol watermark', 'watermark'),
      )
    } else if (tab === 'trading') {
      const qty = el('input', { type: 'number', min: '1', step: '1', class: 'cs-input cs-num', 'aria-label': 'Order quantity (contracts)' }) as HTMLInputElement
      qty.value = String(s.paperQty)
      qty.addEventListener('change', () => {
        const v = Math.max(1, Math.round(Number(qty.value) || 1))
        commit({ paperQty: v })
      })
      content.append(
        head('Paper trading (bar replay)'),
        toggle('Buy / sell limit orders in the chart menu', 'chartMenuOrders'),
        row('Order quantity (contracts)', qty),
        toggle('Confirm before placing from the chart', 'confirmChartOrders'),
        el('p', { class: 'cs-note' }, extras?.paperActive() ? 'A paper session is running — right-click the chart to place limit orders.' : 'Start Replay and pick a start bar to open a paper session; chart-menu orders appear while it runs.'),
      )
    } else if (tab === 'alerts') {
      const a = extras?.alertSound
      content.append(head('On the chart'), toggle('Show price alert lines', 'alertLines'))
      if (a) {
        const cfg = a.get()
        const sound = el('input', { type: 'checkbox', class: 'cs-switch' }) as HTMLInputElement
        sound.checked = cfg.soundOn
        sound.addEventListener('change', () => a.set({ soundOn: sound.checked }))
        const tune = el('select', { class: 'cs-select' }) as HTMLSelectElement
        a.tunes.forEach((t, i) => tune.add(new Option(t, String(i), false, i === cfg.tune)))
        const play = el('button', { class: 'btn cs-play', 'aria-label': 'Preview tune' }, '▶')
        play.addEventListener('click', (e) => {
          e.preventDefault()
          a.preview(Number(tune.value), a.get().duration)
        })
        tune.addEventListener('change', () => a.set({ tune: Number(tune.value) }))
        const tuneWrap = el('span', { class: 'cs-inline' })
        tuneWrap.append(tune, play)
        const dur = el('input', { type: 'number', min: '1', max: '10', step: '1', class: 'cs-input cs-num', 'aria-label': 'Sound length in seconds' }) as HTMLInputElement
        dur.value = String(cfg.duration)
        dur.addEventListener('change', () => a.set({ duration: Math.max(1, Math.min(10, Math.round(Number(dur.value) || 2))) }))
        content.append(head('Sound'), row('Play a sound when an alert fires', sound), row('Tune', tuneWrap), row('Length (seconds)', dur))
      }
    } else if (tab === 'events') {
      const items: HTMLElement[] = [head('Time'), toggle('Session breaks (new day)', 'sessionBreaks')]
      const so = extras?.sessionsOverlay
      if (so) {
        const sess = el('input', { type: 'checkbox', class: 'cs-switch' }) as HTMLInputElement
        sess.checked = so.get()
        sess.addEventListener('change', () => so.set(sess.checked))
        items.push(head('Market sessions'), row('Asia / London / New York boxes (this chart)', sess))
      }
      content.append(...items)
    } else if (tab === 'scales') {
      content.append(
        head('Price scale'),
        select('Labels', 'priceMode', [['price', 'Price'], ['percent', 'Percent (from first visible bar)'], ['indexed', 'Indexed to 100']], (v) => v as PriceDisplayMode),
        toggle('Logarithmic', 'log'),
        toggle('Invert scale', 'invert'),
        head('Last price'),
        toggle('Last price line', 'lastPriceLine'),
        toggle('Countdown to bar close', 'countdown'),
      )
    } else {
      const bg = el('div', { class: 'cs-bg' })
      const themeBtn = el('button', { class: `cs-chip${s.background === null ? ' on' : ''}` }, 'Theme')
      themeBtn.addEventListener('click', () => commit({ background: null }))
      bg.appendChild(themeBtn)
      for (const c of ['#0a0d13', '#000000', '#0f172a', '#131722', '#ffffff']) {
        const b = el('button', { class: `cs-swatch${s.background === c ? ' on' : ''}`, 'aria-label': `Background ${c}`, title: c })
        b.style.background = c
        b.addEventListener('click', () => commit({ background: c }))
        bg.appendChild(b)
      }
      const custom = el('input', { type: 'color', class: 'cs-color', 'aria-label': 'Custom background' }) as HTMLInputElement
      custom.value = s.background ?? '#0a0d13'
      custom.addEventListener('change', () => commit({ background: custom.value }))
      bg.appendChild(custom)
      const mode = el('div', { class: 'cs-bg' })
      for (const [m, label] of [['solid', 'Solid'], ['gradient', 'Gradient']] as const) {
        const b = el('button', { class: `cs-chip${s.backgroundMode === m ? ' on' : ''}`, 'aria-pressed': String(s.backgroundMode === m) }, label)
        b.addEventListener('click', () => commit({ backgroundMode: m }))
        mode.appendChild(b)
      }
      const parts: HTMLElement[] = [head('Background'), mode, bg]
      if (s.backgroundMode === 'gradient') {
        const g = el('input', { type: 'color', class: 'cs-color' }) as HTMLInputElement
        g.value = s.backgroundGradient
        g.addEventListener('change', () => commit({ backgroundGradient: g.value }))
        parts.push(row('Gradient bottom color', g))
      }
      content.append(
        ...parts,
        head('Lines'),
        select('Grid', 'gridMode', [['both', 'Horizontal + vertical'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['none', 'None']], (v) => v as ChartSettingsV4['gridMode']),
        toggle('Crosshair', 'crosshair'),
        select('Crosshair style', 'crosshairStyle', [['dashed', 'Dashed'], ['dotted', 'Dotted'], ['solid', 'Solid']], (v) => v as ChartSettingsV4['crosshairStyle']),
        head('Series'),
        toggle('Volume on the chart (faded, bottom)', 'volumeOverlay'),
        head('Motion'),
        toggle('Smooth scrolling, zoom and autoscale', 'smooth'),
      )
    }
  }

  renderNav()
  renderContent()
  document.body.appendChild(backdrop)
  done.focus()
}
