// Indicators browser (Vela / TradingView style): a large dialog with families
// on the left, preview cards in the middle and a detail pane on the right.
// Cards draw the indicator on the active chart's own recent candles, so the
// thumbnail is what you'll actually get. Keyboard: ↑↓←→ browse, ↵ add & close,
// ⇧↵ add & keep open, F favourite, Esc close.
import type { Candle, IndicatorDef } from '../../src/index'
import { ALL_INDICATORS } from './custom-indicators'
import { INDICATOR_FAMILIES, indicatorDescription, indicatorFamily, isCustomIndicator, type IndicatorFamily } from './indicatorCatalog'
import { el, ICONS } from './ui'

export interface IndicatorsDialogHost {
  /** Recent candles of the active chart (previews are drawn on these). */
  candles(): Candle[]
  isOnChart(id: string): boolean
  add(id: string): void
  remove(id: string): void
  openSettings(id: string): void
  templates(): { name: string; count: number }[]
  applyTemplate(name: string): void
  saveTemplate(name: string): boolean
  deleteTemplate(name: string): void
}

export type IndicatorsSection = 'favorites' | 'on-chart' | 'templates' | 'all' | 'built-in' | 'custom' | IndicatorFamily

// ---- favourites (shared with the header's ★ dropdown) ----
const FAV_KEY = 'candl.favIndicators'
export function getFavoriteIndicators(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
export function toggleFavoriteIndicator(id: string): boolean {
  const favs = getFavoriteIndicators()
  const on = !favs.includes(id)
  const next = on ? [...favs, id] : favs.filter((x) => x !== id)
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable — favourites last this session only */
  }
  return on
}

export const STAR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/></svg>'
export const STAR_ON_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/></svg>'

// ---- preview drawing ----
const PREVIEW_BARS = 140

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** A stand-in series when the chart has no data yet (deterministic random walk). */
function syntheticCandles(): Candle[] {
  const out: Candle[] = []
  let p = 100
  let seed = 7
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5
  for (let i = 0; i < PREVIEW_BARS; i++) {
    const o = p
    p = Math.max(1, p + rnd() * 2.4 + Math.sin(i / 14) * 0.5)
    const h = Math.max(o, p) + Math.abs(rnd())
    const l = Math.min(o, p) - Math.abs(rnd())
    out.push({ time: i * 60_000, open: o, high: h, low: l, close: p, volume: 50 + Math.abs(rnd()) * 100 })
  }
  return out
}

function defaultParams(def: IndicatorDef): Record<string, number> {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]))
}

function drawPreview(canvas: HTMLCanvasElement, def: IndicatorDef, candles: Candle[]): void {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 240
  const h = canvas.clientHeight || 120
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)
  const bars = candles.slice(-PREVIEW_BARS)
  if (bars.length < 2) return
  let outputs: ReturnType<IndicatorDef['compute']> = []
  try {
    outputs = def.compute(bars, defaultParams(def))
  } catch {
    outputs = []
  }
  const pane = def.placement === 'pane'
  const pad = 6
  const priceTop = pad
  const priceBottom = pane ? h * 0.56 : h - pad
  const n = bars.length
  const x = (i: number): number => pad + (i / (n - 1)) * (w - pad * 2)

  // Candles, with overlay outputs sharing their price scale.
  let lo = Infinity
  let hi = -Infinity
  for (const c of bars) {
    lo = Math.min(lo, c.low)
    hi = Math.max(hi, c.high)
  }
  const span = hi - lo || 1
  const fit = (v: number): boolean => v >= lo - span * 0.5 && v <= hi + span * 0.5
  if (!pane) {
    for (const o of outputs)
      for (const v of o.values)
        if (v != null && isFinite(v) && fit(v)) {
          lo = Math.min(lo, v)
          hi = Math.max(hi, v)
        }
  }
  const py = (v: number): number => priceBottom - ((v - lo) / (hi - lo || 1)) * (priceBottom - priceTop)
  const up = cssVar('--up', '#089981')
  const down = cssVar('--down', '#f23645')
  const bw = Math.max(1, ((w - pad * 2) / n) * 0.6)
  ctx.globalAlpha = 0.55
  for (let i = 0; i < n; i++) {
    const c = bars[i]
    ctx.strokeStyle = ctx.fillStyle = c.close >= c.open ? up : down
    ctx.beginPath()
    ctx.moveTo(x(i), py(c.high))
    ctx.lineTo(x(i), py(c.low))
    ctx.lineWidth = 0.8
    ctx.stroke()
    const top = py(Math.max(c.open, c.close))
    ctx.fillRect(x(i) - bw / 2, top, bw, Math.max(0.8, py(Math.min(c.open, c.close)) - top))
  }
  ctx.globalAlpha = 1
  if (outputs.length === 0) return

  // Pane indicators get their own band under the price.
  let ilo = Infinity
  let ihi = -Infinity
  if (pane) {
    for (const o of outputs)
      for (const v of o.values)
        if (v != null && isFinite(v)) {
          ilo = Math.min(ilo, v)
          ihi = Math.max(ihi, v)
        }
    if (def.range) [ilo, ihi] = def.range
    ctx.strokeStyle = cssVar('--border', '#2a2e39')
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, h * 0.6)
    ctx.lineTo(w, h * 0.6)
    ctx.stroke()
  }
  const iTop = h * 0.64
  const iBottom = h - pad
  const iy = (v: number): number => iBottom - ((v - ilo) / (ihi - ilo || 1)) * (iBottom - iTop)
  const yOf = pane ? iy : py
  for (const o of outputs) {
    ctx.strokeStyle = ctx.fillStyle = o.color
    ctx.lineWidth = 1.4
    if (o.style === 'histogram') {
      const zero = pane ? iy(Math.max(ilo, Math.min(ihi, 0))) : priceBottom
      o.values.forEach((v, i) => {
        if (v == null || !isFinite(v)) return
        const y = yOf(v)
        ctx.fillRect(x(i) - bw / 2, Math.min(y, zero), bw, Math.max(1, Math.abs(zero - y)))
      })
      continue
    }
    ctx.beginPath()
    let pen = false
    o.values.forEach((v, i) => {
      if (v == null || !isFinite(v) || (!pane && !fit(v))) {
        pen = false
        return
      }
      if (pen) ctx.lineTo(x(i), yOf(v))
      else ctx.moveTo(x(i), yOf(v))
      pen = true
    })
    ctx.stroke()
  }
}

// ---- dialog ----
let openDialog: { close(): void } | null = null

export function openIndicatorsDialog(host: IndicatorsDialogHost, start: IndicatorsSection = 'all'): void {
  openDialog?.close()
  const chartCandles = host.candles()
  const candles = chartCandles.length >= 20 ? chartCandles : syntheticCandles()
  let section: IndicatorsSection = start
  let query = ''
  let selected: IndicatorDef | null = null
  let list: IndicatorDef[] = []

  const backdrop = el('div', { class: 'modal-backdrop ind-backdrop' })
  const dlg = el('div', { class: 'ind-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Indicators' })
  backdrop.appendChild(dlg)

  // Header: title + search + close.
  const head = el('div', { class: 'ind-head' })
  const search = el('input', { class: 'ind-search', placeholder: 'Search indicators or families', spellcheck: 'false', 'aria-label': 'Search indicators' }) as HTMLInputElement
  const searchWrap = el('label', { class: 'ind-search-wrap' })
  searchWrap.append(el('span', { class: 'ind-search-icon' }, ICONS.search), search, el('kbd', {}, '/'))
  const closeBtn = el('button', { class: 'mi-icon ind-close', title: 'Close (Esc)', 'aria-label': 'Close' }, ICONS.close)
  head.append(el('h2', { class: 'ind-title' }, 'Indicators'), searchWrap, closeBtn)

  const nav = el('nav', { class: 'ind-nav', 'aria-label': 'Indicator sections' })
  const main = el('div', { class: 'ind-main' })
  const detail = el('aside', { class: 'ind-detail' })
  const body = el('div', { class: 'ind-body' })
  body.append(nav, main, detail)

  const foot = el('div', { class: 'ind-foot' })
  const footCount = el('span', { class: 'ind-foot-count' })
  foot.append(
    el('span', { class: 'ind-keys' }, '<kbd>↑</kbd><kbd>↓</kbd> Browse <kbd>↵</kbd> Add <kbd>⇧</kbd><kbd>↵</kbd> Add, keep open <kbd>F</kbd> Favorite <kbd>Esc</kbd> Close'),
    footCount,
  )
  dlg.append(head, body, foot)

  const close = (): void => {
    backdrop.remove()
    window.removeEventListener('keydown', onKey, true)
    if (previewRaf) cancelAnimationFrame(previewRaf)
    openDialog = null
  }
  openDialog = { close }
  closeBtn.addEventListener('click', close)
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close()
  })

  // ---- left nav ----
  function navItem(label: string, sec: IndicatorsSection, count: number, icon = ''): HTMLElement {
    const b = el('button', { class: `ind-nav-item${section === sec && !query ? ' active' : ''}` })
    b.append(el('span', { class: 'ind-nav-icon' }, icon), el('span', { class: 'ind-nav-label' }, label), el('span', { class: 'ind-nav-count' }, String(count)))
    b.addEventListener('click', () => {
      section = sec
      query = ''
      search.value = ''
      selected = null
      render()
    })
    return b
  }
  function renderNav(): void {
    const favs = getFavoriteIndicators()
    const onChart = ALL_INDICATORS.filter((d) => host.isOnChart(d.id)).length
    nav.replaceChildren(
      el('div', { class: 'ind-nav-head' }, 'Yours'),
      navItem('Favorites', 'favorites', favs.length, STAR_ICON),
      navItem('On this chart', 'on-chart', onChart, ICONS.layers),
      navItem('Templates', 'templates', host.templates().length, ICONS.grid),
      el('div', { class: 'ind-nav-head' }, 'Library'),
      navItem('All', 'all', ALL_INDICATORS.length, ICONS.indicators),
      navItem('Built-in', 'built-in', ALL_INDICATORS.filter((d) => !isCustomIndicator(d.id)).length, ICONS.stats),
      navItem('Custom', 'custom', ALL_INDICATORS.filter((d) => isCustomIndicator(d.id)).length, ICONS.smart),
      el('div', { class: 'ind-nav-head' }, 'Families'),
      ...INDICATOR_FAMILIES.map((f) => [f, ALL_INDICATORS.filter((d) => indicatorFamily(d.id) === f).length] as const)
        .filter(([, n]) => n > 0)
        .map(([f, n]) => navItem(f, f, n)),
    )
  }

  // ---- middle: cards ----
  function filtered(): IndicatorDef[] {
    const q = query.trim().toLowerCase()
    if (q) {
      return ALL_INDICATORS.filter((d) => [d.label, d.shortLabel, d.id, indicatorFamily(d.id)].some((s) => s.toLowerCase().includes(q)))
    }
    const favs = getFavoriteIndicators()
    switch (section) {
      case 'favorites':
        return ALL_INDICATORS.filter((d) => favs.includes(d.id))
      case 'on-chart':
        return ALL_INDICATORS.filter((d) => host.isOnChart(d.id))
      case 'built-in':
        return ALL_INDICATORS.filter((d) => !isCustomIndicator(d.id))
      case 'custom':
        return ALL_INDICATORS.filter((d) => isCustomIndicator(d.id))
      case 'all':
      case 'templates':
        return ALL_INDICATORS
      default:
        return ALL_INDICATORS.filter((d) => indicatorFamily(d.id) === section)
    }
  }

  // Previews are drawn a few per frame so opening the dialog stays instant.
  const previewQueue: (() => void)[] = []
  let previewRaf = 0
  function queuePreview(fn: () => void): void {
    previewQueue.push(fn)
    if (previewRaf) return
    const pump = (): void => {
      const t0 = performance.now()
      while (previewQueue.length && performance.now() - t0 < 12) previewQueue.shift()!()
      previewRaf = previewQueue.length ? requestAnimationFrame(pump) : 0
    }
    previewRaf = requestAnimationFrame(pump)
  }

  function card(def: IndicatorDef): HTMLElement {
    const fav = getFavoriteIndicators().includes(def.id)
    const on = host.isOnChart(def.id)
    const c = el('div', { class: `ind-card${selected?.id === def.id ? ' selected' : ''}`, role: 'option', 'data-id': def.id, 'aria-selected': String(selected?.id === def.id) })
    const thumb = el('canvas', { class: 'ind-thumb' }) as HTMLCanvasElement
    const star = el('button', { class: `ind-star${fav ? ' on' : ''}`, title: fav ? 'Remove from favorites' : 'Add to favorites', 'aria-label': fav ? `Unfavorite ${def.label}` : `Favorite ${def.label}` }, fav ? STAR_ON_ICON : STAR_ICON)
    star.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleFavoriteIndicator(def.id)
      render()
    })
    const meta = el('div', { class: 'ind-card-meta' })
    meta.append(
      el('div', { class: 'ind-card-tag' }, on ? '<span class="ind-on-dot"></span>On chart' : isCustomIndicator(def.id) ? 'Custom' : 'Built-in'),
      el('div', { class: 'ind-card-name' }, def.label),
      el('div', { class: 'ind-card-sub' }, `${indicatorFamily(def.id)} · ${def.shortLabel}`),
    )
    c.append(thumb, star, meta)
    c.addEventListener('click', () => {
      selected = def
      for (const x of Array.from(main.querySelectorAll<HTMLElement>('.ind-card'))) {
        x.classList.toggle('selected', x === c)
        x.setAttribute('aria-selected', String(x === c))
      }
      renderDetail()
    })
    c.addEventListener('dblclick', () => addSelected(false))
    queuePreview(() => drawPreview(thumb, def, candles))
    return c
  }

  function renderTemplates(): void {
    const wrap = el('div', { class: 'ind-templates' })
    const saveRow = el('div', { class: 'ind-tpl-save' })
    const input = el('input', { class: 'menu-search', placeholder: 'Save this chart’s setup as…', 'aria-label': 'Template name' }) as HTMLInputElement
    const save = el('button', { class: 'btn btn-primary' }, 'Save template')
    const doSave = (): void => {
      const name = input.value.trim()
      if (!name) return
      if (host.saveTemplate(name)) render()
      else save.textContent = 'Save failed'
    }
    save.addEventListener('click', doSave)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation()
        doSave()
      }
    })
    saveRow.append(input, save)
    wrap.append(saveRow)
    const tpls = host.templates()
    if (!tpls.length) wrap.append(el('div', { class: 'ind-empty' }, 'No templates yet. A template stores this chart’s indicators, power tools and chart type.'))
    for (const t of tpls) {
      const row = el('div', { class: 'ind-tpl-row' })
      const apply = el('button', { class: 'btn' }, 'Apply')
      apply.addEventListener('click', () => {
        host.applyTemplate(t.name)
        close()
      })
      const del = el('button', { class: 'mi-icon', title: 'Delete template', 'aria-label': `Delete ${t.name}` }, ICONS.trash)
      del.addEventListener('click', () => {
        host.deleteTemplate(t.name)
        render()
      })
      row.append(el('span', { class: 'ind-tpl-name' }), el('span', { class: 'ind-tpl-count' }, `${t.count} items`), apply, del)
      row.firstElementChild!.textContent = t.name
      wrap.append(row)
    }
    main.replaceChildren(el('div', { class: 'ind-section-head' }, 'Templates'), wrap)
    footCount.textContent = `${tpls.length} templates`
  }

  const SECTION_TITLES: Partial<Record<IndicatorsSection, string>> = {
    all: 'All indicators',
    'on-chart': 'On this chart',
    favorites: 'Favorites',
    'built-in': 'Built-in',
    custom: 'Custom',
  }

  function renderMain(): void {
    previewQueue.length = 0
    if (section === 'templates' && !query) {
      renderTemplates()
      return
    }
    list = filtered()
    if (selected && !list.some((d) => d.id === selected!.id)) selected = null
    if (!selected) selected = list[0] ?? null
    const title = query ? 'Results' : (SECTION_TITLES[section] ?? section)
    const grid = el('div', { class: 'ind-grid', role: 'listbox', 'aria-label': title })
    for (const d of list) grid.append(card(d))
    const emptyText = section === 'favorites' && !query ? 'No favorites yet — star an indicator to pin it here and in the ★ menu.' : 'Nothing matches.'
    const headEl = el('div', { class: 'ind-section-head' })
    headEl.append(document.createTextNode(title), el('span', {}, String(list.length)))
    main.replaceChildren(headEl, list.length ? grid : el('div', { class: 'ind-empty' }, emptyText))
    main.scrollTop = 0
    footCount.textContent = `${ALL_INDICATORS.length} indicators · ${ALL_INDICATORS.filter((d) => host.isOnChart(d.id)).length} on this chart`
  }

  // ---- right: detail ----
  function renderDetail(): void {
    if (!selected || (section === 'templates' && !query)) {
      detail.replaceChildren(
        el('div', { class: 'ind-empty' }, section === 'templates' ? 'Applying a template replaces this chart’s indicators and tools. Symbol, timeframe and drawings stay.' : 'Pick an indicator to preview it.'),
      )
      return
    }
    const def = selected
    const on = host.isOnChart(def.id)
    const fav = getFavoriteIndicators().includes(def.id)
    const big = el('canvas', { class: 'ind-detail-thumb' }) as HTMLCanvasElement
    const addBtn = el('button', { class: `btn ${on ? 'btn-danger' : 'btn-primary'} ind-add` }, on ? 'Remove from chart' : 'Add to chart <kbd>↵</kbd>')
    addBtn.addEventListener('click', () => {
      if (on) {
        host.remove(def.id)
        render()
      } else addSelected(false)
    })
    const favBtn = el('button', { class: 'btn ind-fav-btn' }, `${fav ? STAR_ON_ICON : STAR_ICON}<span>${fav ? 'Favorited' : 'Favorite'}</span>`)
    favBtn.addEventListener('click', () => {
      toggleFavoriteIndicator(def.id)
      render()
    })
    const actions = el('div', { class: 'ind-detail-actions' })
    actions.append(addBtn, favBtn)
    if (on) {
      const gear = el('button', { class: 'btn' }, 'Settings')
      gear.addEventListener('click', () => {
        close()
        host.openSettings(def.id)
      })
      actions.append(gear)
    }
    const params = def.params.filter((p) => !p.toggle && !p.options).slice(0, 6)
    const paramList = el('div', { class: 'ind-params' })
    for (const p of params) {
      const chip = el('span', {})
      chip.append(document.createTextNode(p.label), el('b', {}, String(p.default)))
      paramList.append(chip)
    }
    const name = el('h3', { class: 'ind-detail-name' })
    name.textContent = def.label
    detail.replaceChildren(
      big,
      el('div', { class: 'ind-detail-tag' }, `${indicatorFamily(def.id)} · ${def.placement === 'pane' ? 'Separate pane' : 'On price'} · ${isCustomIndicator(def.id) ? 'Custom' : 'Built-in'}`),
      name,
      el('p', { class: 'ind-detail-desc' }, indicatorDescription(def.id)),
      paramList,
      actions,
    )
    requestAnimationFrame(() => drawPreview(big, def, candles))
  }

  function render(): void {
    renderNav()
    renderMain()
    renderDetail()
  }

  function addSelected(keepOpen: boolean): void {
    if (!selected) return
    if (!host.isOnChart(selected.id)) host.add(selected.id)
    if (keepOpen) render()
    else close()
  }

  function moveSelection(delta: number): void {
    if (!list.length) return
    const i = selected ? list.findIndex((d) => d.id === selected!.id) : -1
    selected = list[Math.max(0, Math.min(list.length - 1, i + delta))]
    for (const x of Array.from(main.querySelectorAll<HTMLElement>('.ind-card'))) {
      const on = x.dataset.id === selected.id
      x.classList.toggle('selected', on)
      x.setAttribute('aria-selected', String(on))
      if (on) x.scrollIntoView({ block: 'nearest' })
    }
    renderDetail()
  }

  /** Cards per row, so ↑ / ↓ move a whole row. */
  function columns(): number {
    const cards = Array.from(main.querySelectorAll<HTMLElement>('.ind-card'))
    if (cards.length < 2) return 1
    const top = cards[0].offsetTop
    let n = 0
    for (const c of cards) {
      if (c.offsetTop !== top) break
      n++
    }
    return Math.max(1, n)
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    // The template-name field types freely (Enter there saves).
    if (e.target instanceof HTMLInputElement && e.target !== search) return
    e.stopPropagation() // keep chart shortcuts (1-9, /, Delete…) out while the dialog is open
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveSelection(columns())
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveSelection(-columns())
    } else if (e.key === 'ArrowRight' && e.target !== search) {
      e.preventDefault()
      moveSelection(1)
    } else if (e.key === 'ArrowLeft' && e.target !== search) {
      e.preventDefault()
      moveSelection(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      addSelected(e.shiftKey)
    } else if ((e.key === 'f' || e.key === 'F') && e.target !== search && selected) {
      e.preventDefault()
      toggleFavoriteIndicator(selected.id)
      render()
    } else if (e.key === '/' && e.target !== search) {
      e.preventDefault()
      search.focus()
    }
  }
  window.addEventListener('keydown', onKey, true)

  search.addEventListener('input', () => {
    query = search.value
    selected = null
    renderNav()
    renderMain()
    renderDetail()
  })

  document.body.appendChild(backdrop)
  render()
  search.focus()
}
