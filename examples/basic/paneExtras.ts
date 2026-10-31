// Per-chart V4 widgets that live inside a pane's canvas host:
//  - DrawingStyleBar: the floating toolbar over a selected drawing (colour,
//    width, line style, lock, hide, clone, alert, delete).
//  - ZoomPill: zoom / scroll / reset buttons that fade in at the bottom of
//    the chart on hover.
//  - CompareManager: other symbols drawn on the chart, re-based to the main
//    series (engine.setCompareSeries), with live updates.
import type { Candle, Interval } from '../../src/index'
import type { IChartEngine } from '../../src/chart/types'
import type { Drawing } from '../../src/drawings/types'
import { el, ICONS } from './ui'

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const I = {
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>'),
  unlock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/>'),
  clone: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>'),
  bell: svg('<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
  solid: svg('<path d="M3 12h18"/>'),
  dashed: svg('<path d="M3 12h4M10 12h4M17 12h4"/>'),
  dotted: svg('<path d="M3 12h.01M7.5 12h.01M12 12h.01M16.5 12h.01M21 12h.01" stroke-width="2.6"/>'),
}

export const DRAWING_COLORS = ['#4c7dff', '#16c784', '#ea3943', '#f59e0b', '#a78bfa', '#22d3ee', '#f472b6', '#e6e9ef', '#8a93a3', '#facc15']

export interface StyleBarHost {
  engine: IChartEngine
  /** Create a price alert at `price` on this chart's symbol. */
  onAlert(price: number): void
}

/** Price of a drawing "now" for an alert: horizontal tools use their level, two-point lines extrapolate to the present. */
function alertPrice(d: Drawing): number | null {
  const pts = d.points
  if (!pts.length) return null
  if (pts.length === 1 || d.tool === 'hline' || d.tool === 'hray') return pts[0].price
  const [a, b] = pts
  if (b.time === a.time) return b.price
  return a.price + ((b.price - a.price) * (Date.now() - a.time)) / (b.time - a.time)
}

export class DrawingStyleBar {
  private readonly root: HTMLElement
  private readonly host: StyleBarHost
  private drawing: Drawing | null = null
  private raf = 0
  private menu: HTMLElement | null = null

  constructor(container: HTMLElement, host: StyleBarHost) {
    this.host = host
    this.root = el('div', { class: 'dsb', role: 'toolbar', 'aria-label': 'Drawing style' })
    this.root.style.display = 'none'
    // Keep chart gestures from starting under the toolbar.
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation())
    this.root.addEventListener('mousedown', (e) => e.stopPropagation())
    container.appendChild(this.root)
  }

  setDrawing(d: Drawing | null): void {
    this.drawing = d
    this.closeMenu()
    if (!d) {
      this.root.style.display = 'none'
      cancelAnimationFrame(this.raf)
      this.raf = 0
      return
    }
    this.render()
    this.root.style.display = 'flex'
    if (!this.raf) this.track()
  }

  destroy(): void {
    cancelAnimationFrame(this.raf)
    this.root.remove()
  }

  private update(patch: Partial<Drawing>): void {
    const d = this.drawing
    if (!d) return
    const next: Drawing = { ...d, ...patch, props: { ...(d.props ?? {}), ...(patch.props ?? {}) } }
    this.drawing = next
    this.host.engine.updateDrawing(next)
    this.render()
  }

  private btn(label: string, html: string, onClick: (b: HTMLButtonElement) => void, extra = ''): HTMLButtonElement {
    const b = el('button', { class: `dsb-btn ${extra}`.trim(), title: label, 'aria-label': label }, html) as HTMLButtonElement
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick(b)
    })
    return b
  }

  private closeMenu(): void {
    this.menu?.remove()
    this.menu = null
  }

  private openMenu(anchor: HTMLElement, build: (menu: HTMLElement) => void): void {
    if (this.menu) {
      this.closeMenu()
      return
    }
    const m = el('div', { class: 'dsb-menu' })
    build(m)
    m.style.left = `${anchor.offsetLeft}px`
    this.root.appendChild(m)
    this.menu = m
  }

  private render(): void {
    const d = this.drawing
    if (!d) return
    const locked = d.props?.locked === true
    const style = (d.props?.lineStyle as string) ?? 'solid'
    this.root.replaceChildren()
    const swatch = el('span', { class: 'dsb-swatch' })
    swatch.style.background = d.color
    const colorBtn = this.btn('Color', '', (b) =>
      this.openMenu(b, (m) => {
        m.classList.add('dsb-colors')
        for (const c of DRAWING_COLORS) {
          const s = el('button', { class: `dsb-color${c.toLowerCase() === d.color.toLowerCase() ? ' on' : ''}`, 'aria-label': `Color ${c}` })
          s.style.background = c
          s.addEventListener('click', (e) => {
            e.stopPropagation()
            this.closeMenu()
            this.update({ color: c })
          })
          m.appendChild(s)
        }
      }),
    )
    colorBtn.appendChild(swatch)
    const widthBtn = this.btn('Line width', `<span class="dsb-mono">${d.width}px</span>`, (b) =>
      this.openMenu(b, (m) => {
        for (const w of [1, 2, 3, 4]) {
          const it = el('button', { class: `dsb-item${w === d.width ? ' on' : ''}` })
          it.innerHTML = `<span class="dsb-line" style="height:${w}px"></span>${w}px`
          it.addEventListener('click', (e) => {
            e.stopPropagation()
            this.closeMenu()
            this.update({ width: w })
          })
          m.appendChild(it)
        }
      }),
    )
    const styleBtn = this.btn('Line style', I[style as 'solid' | 'dashed' | 'dotted'] ?? I.solid, (b) =>
      this.openMenu(b, (m) => {
        for (const s of ['solid', 'dashed', 'dotted'] as const) {
          const it = el('button', { class: `dsb-item${s === style ? ' on' : ''}` }, `${I[s]}<span>${s[0].toUpperCase()}${s.slice(1)}</span>`)
          it.addEventListener('click', (e) => {
            e.stopPropagation()
            this.closeMenu()
            this.update({ props: { lineStyle: s } })
          })
          m.appendChild(it)
        }
      }),
    )
    const sep = el('span', { class: 'dsb-sep' })
    const lockBtn = this.btn(locked ? 'Unlock' : 'Lock', locked ? I.lock : I.unlock, () => this.update({ props: { locked: !locked } }), locked ? 'on' : '')
    const hideBtn = this.btn('Hide (show again from the Object tree)', I.eye, () => {
      this.update({ props: { hidden: true } })
      this.host.engine.selectDrawing(null)
    })
    const cloneBtn = this.btn('Clone', I.clone, () => {
      const conv = this.host.engine.getMainConverters()
      if (!conv) return
      const clone: Drawing = {
        ...d,
        id: `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        props: { ...(d.props ?? {}), locked: false },
        // Nudge 18px down so the copy is visible next to the original.
        points: d.points.map((p) => ({ time: p.time, price: conv.yToPrice(conv.priceToY(p.price) + 18) })),
      }
      this.host.engine.addDrawing(clone)
    })
    const alertBtn = this.btn('Add alert at this line', I.bell, () => {
      const p = alertPrice(d)
      if (p != null && isFinite(p)) this.host.onAlert(p)
    })
    const delBtn = this.btn('Delete', I.trash, () => this.host.engine.removeDrawing(d.id), 'danger')
    this.root.append(colorBtn, widthBtn, styleBtn, sep, lockBtn, hideBtn, cloneBtn, alertBtn, delBtn)
  }

  /** Follow the drawing as the chart pans / zooms (one cheap layout read per frame). */
  private track(): void {
    const step = (): void => {
      const d = this.drawing
      if (!d) {
        this.raf = 0
        return
      }
      const conv = this.host.engine.getMainConverters()
      const rect = this.host.engine.getMainPaneRect()
      if (conv && rect && d.points.length) {
        let minY = Infinity
        let sumX = 0
        for (const p of d.points) {
          minY = Math.min(minY, conv.priceToY(p.price))
          sumX += conv.timeToX(p.time)
        }
        const cx = sumX / d.points.length
        const w = this.root.offsetWidth
        const h = this.root.offsetHeight
        const left = Math.max(8, Math.min(rect.width - w - 8, cx - w / 2))
        let top = minY - h - 14
        if (top < 34) top = minY + 22
        top = Math.max(34, Math.min(rect.height - h - 8, top))
        this.root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
      }
      this.raf = requestAnimationFrame(step)
    }
    this.raf = requestAnimationFrame(step)
  }
}

/** Zoom / scroll / reset buttons centred at the bottom of the chart, shown on hover. */
export function createZoomPill(container: HTMLElement, engine: IChartEngine): HTMLElement {
  const pill = el('div', { class: 'zoom-pill', role: 'group', 'aria-label': 'Zoom and scroll' })
  const quarter = (): number => {
    const r = engine.getVisibleRange()
    return Math.max(5, (r.to - r.from) / 4)
  }
  const b = (label: string, html: string, run: () => void): void => {
    const btn = el('button', { class: 'zp-btn', title: label, 'aria-label': label }, html)
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      run()
    })
    pill.appendChild(btn)
  }
  b('Zoom out', svg('<path d="M5 12h14"/>'), () => engine.zoomBy(0.75))
  b('Zoom in', svg('<path d="M12 5v14M5 12h14"/>'), () => engine.zoomBy(1.33))
  b('Scroll left', svg('<path d="M15 6l-6 6 6 6"/>'), () => engine.scrollBars(-quarter()))
  b('Scroll right', svg('<path d="M9 6l6 6-6 6"/>'), () => engine.scrollBars(quarter()))
  b('Reset view', ICONS.reset, () => engine.resetView())
  pill.addEventListener('pointerdown', (e) => e.stopPropagation())
  pill.addEventListener('mousedown', (e) => e.stopPropagation())
  container.appendChild(pill)
  return pill
}

// ---- compare ----
export const COMPARE_COLORS = ['#f59e0b', '#22d3ee', '#a78bfa', '#f472b6', '#facc15']

export interface CompareEntry {
  symbol: string
  color: string
  hidden?: boolean
}

export interface CompareProvider {
  fetchCandles(symbol: string, interval: Interval, limit?: number): Promise<Candle[]>
  subscribeCandles(symbol: string, interval: Interval, onUpdate: (candle: Candle) => void): () => void
}

/** Loads and streams compare symbols for one chart and hands them to the engine. */
export class CompareManager {
  private entries: CompareEntry[] = []
  private data = new Map<string, Candle[]>()
  private unsubs: (() => void)[] = []
  private interval: Interval = '1m'
  private gen = 0
  private pushQueued = false
  onChange: (() => void) | null = null

  constructor(
    private readonly provider: CompareProvider,
    private readonly engine: IChartEngine,
  ) {}

  set(entries: CompareEntry[], interval: Interval): void {
    this.entries = entries.map((e) => ({ ...e }))
    this.interval = interval
    void this.load()
  }

  destroy(): void {
    this.gen++
    for (const u of this.unsubs) u()
    this.unsubs = []
  }

  /** % change since the first visible main bar, for the legend (null until data is in). */
  changeSinceFirstVisible(symbol: string, mainCandles: Candle[]): number | null {
    const series = this.data.get(symbol)
    if (!series?.length || !mainCandles.length) return null
    const { from } = this.engine.getVisibleRange()
    const byTime = new Map(series.map((c) => [c.time, c.close]))
    let base: number | undefined
    for (let i = Math.max(0, from); i < mainCandles.length && base === undefined; i++) base = byTime.get(mainCandles[i].time)
    const last = series[series.length - 1].close
    return base ? (last / base - 1) * 100 : null
  }

  private async load(): Promise<void> {
    const gen = ++this.gen
    for (const u of this.unsubs) u()
    this.unsubs = []
    const wanted = new Set(this.entries.map((e) => e.symbol))
    for (const k of [...this.data.keys()]) if (!wanted.has(k)) this.data.delete(k)
    this.push()
    await Promise.all(
      this.entries.map(async (e) => {
        try {
          const candles = await this.provider.fetchCandles(e.symbol, this.interval, 1000)
          if (gen !== this.gen) return
          this.data.set(e.symbol, candles)
          this.push()
          this.unsubs.push(
            this.provider.subscribeCandles(e.symbol, this.interval, (c) => {
              const arr = this.data.get(e.symbol)
              if (!arr) return
              const last = arr[arr.length - 1]
              if (last && last.time === c.time) arr[arr.length - 1] = c
              else if (!last || c.time > last.time) arr.push(c)
              this.queuePush()
            }),
          )
        } catch {
          /* offline / unknown symbol — the legend shows it without a value */
        }
      }),
    )
  }

  private queuePush(): void {
    if (this.pushQueued) return
    this.pushQueued = true
    setTimeout(() => {
      this.pushQueued = false
      this.push()
    }, 250)
  }

  private push(): void {
    this.engine.setCompareSeries(
      this.entries
        .filter((e) => !e.hidden && this.data.has(e.symbol))
        .map((e) => ({ id: e.symbol, label: e.symbol, color: e.color, candles: this.data.get(e.symbol)! })),
    )
    this.onChange?.()
  }
}
