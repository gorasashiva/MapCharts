// Dominance V2 — a small floating table showing live buy/sell dominance for
// the pane's symbol across several timeframes the user picks, independent of
// whatever interval the chart itself is displaying. Each row opens its OWN
// candle subscription at its own timeframe (the same PaneProvider methods a
// ChartPane already uses for its main series), so "1m" and "15m" rows update
// live and independently of each other and of the chart.
//
// The dominance RULE itself is untouched — every row calls the exact same
// candleDominanceSide() used by the "Candle Buy/Sell Dominance" chart-dot
// indicator (custom-indicators.ts), so this is purely a second presentation
// of the same computation, not a re-implementation of it.
import type { Candle, Interval } from '../../src/index'
import { INTERVALS } from '../../src/index'
import { candleDominanceSide } from './custom-indicators'
import { attachFloatingWidget, type FloatingWidgetHandle } from '../../src/overlays/floatingWidget'
import { ICONS } from './ui'

export interface DominanceTableProvider {
  fetchCandles(symbol: string, interval: Interval, limit?: number): Promise<Candle[]>
  subscribeCandles(symbol: string, interval: Interval, onUpdate: (candle: Candle) => void): () => void
}

const LS_KEY = 'candl.dominanceV2.timeframes'
const DEFAULT_TIMEFRAMES: Interval[] = ['1m', '3m', '5m', '15m']

function readTimeframes(): Interval[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_TIMEFRAMES.slice()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length && parsed.every((v) => (INTERVALS as string[]).includes(v))
      ? (parsed as Interval[])
      : DEFAULT_TIMEFRAMES.slice()
  } catch {
    return DEFAULT_TIMEFRAMES.slice()
  }
}

function sortByNaturalOrder(list: Interval[]): Interval[] {
  return [...list].sort((a, b) => INTERVALS.indexOf(a) - INTERVALS.indexOf(b))
}

interface Row {
  root: HTMLElement
  dotEl: HTMLElement
  lastTime?: number // guards against the initial seed fetch resolving AFTER a live tick and overwriting it with stale data
}

export default class DominanceTableOverlay {
  private readonly provider: DominanceTableProvider
  private readonly root: HTMLElement
  private readonly listEl: HTMLElement
  private readonly addWrap: HTMLElement
  private readonly addBtn: HTMLButtonElement
  private readonly addMenu: HTMLElement

  private symbol = ''
  private enabled = false
  private timeframes: Interval[]
  private rows = new Map<Interval, Row>()
  private subs = new Map<Interval, () => void>()
  private readonly dock: FloatingWidgetHandle

  constructor(container: HTMLElement, provider: DominanceTableProvider) {
    this.provider = provider
    this.timeframes = sortByNaturalOrder(readTimeframes())

    this.root = document.createElement('div')
    this.root.className = 'dt2-widget'
    this.root.style.display = 'none'

    this.listEl = document.createElement('div')
    this.listEl.className = 'dt2-list'

    this.addWrap = document.createElement('div')
    this.addWrap.className = 'dt2-add-wrap'
    this.addBtn = document.createElement('button')
    this.addBtn.className = 'dt2-add-btn'
    this.addBtn.textContent = '+'
    this.addBtn.title = 'Add timeframe'
    this.addMenu = document.createElement('div')
    this.addMenu.className = 'dt2-add-menu'
    this.addWrap.append(this.addBtn, this.addMenu)

    this.root.append(this.listEl, this.addWrap)
    container.appendChild(this.root)
    this.dock = attachFloatingWidget(container, this.root, 'top-right', '.dt2-add-wrap, .dt2-remove')

    this.addBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.addWrap.classList.toggle('open')
    })
    this.addMenu.addEventListener('click', (e) => e.stopPropagation())
    document.addEventListener('click', () => this.addWrap.classList.remove('open'))

    this.renderRows()
  }

  /** Re-stack (docked) or re-clamp (dragged away) after the container resizes. */
  resize(): void {
    this.dock.resize()
  }

  setSymbol(symbol: string): void {
    this.symbol = symbol
    this.resubscribeAll()
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.root.style.display = on ? 'flex' : 'none'
    this.dock.setVisible(on)
    if (on) this.resubscribeAll()
    else this.unsubscribeAll()
  }

  destroy(): void {
    this.unsubscribeAll()
    this.dock.destroy()
    this.root.remove()
  }

  private save(): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.timeframes))
    } catch {
      /* storage unavailable/full — the selection still works for this session */
    }
  }

  private addTimeframe(iv: Interval): void {
    if (this.timeframes.includes(iv)) return
    this.timeframes = sortByNaturalOrder([...this.timeframes, iv])
    this.save()
    this.renderRows()
    if (this.enabled && this.symbol) this.subscribeRow(iv)
  }

  private removeTimeframe(iv: Interval): void {
    this.timeframes = this.timeframes.filter((t) => t !== iv)
    this.save()
    this.unsubscribeRow(iv)
    this.renderRows()
  }

  private renderRows(): void {
    this.listEl.innerHTML = ''
    this.rows.clear()
    for (const iv of this.timeframes) {
      const row = document.createElement('div')
      row.className = 'dt2-row'

      const label = document.createElement('span')
      label.className = 'dt2-label'
      label.textContent = iv

      const dot = document.createElement('span')
      dot.className = 'dt2-dot'

      const removeBtn = document.createElement('button')
      removeBtn.className = 'dt2-remove'
      removeBtn.innerHTML = ICONS.close
      removeBtn.title = `Remove ${iv}`
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.removeTimeframe(iv)
      })

      row.append(label, dot, removeBtn)
      this.listEl.appendChild(row)
      this.rows.set(iv, { root: row, dotEl: dot })
    }
    this.renderAddMenu()
  }

  private renderAddMenu(): void {
    this.addMenu.innerHTML = ''
    const available = INTERVALS.filter((iv) => !this.timeframes.includes(iv))
    if (available.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'dt2-add-empty'
      empty.textContent = 'All added'
      this.addMenu.appendChild(empty)
      return
    }
    for (const iv of available) {
      const item = document.createElement('div')
      item.className = 'dt2-add-item'
      item.textContent = iv
      item.addEventListener('click', () => {
        this.addWrap.classList.remove('open')
        this.addTimeframe(iv)
      })
      this.addMenu.appendChild(item)
    }
  }

  private resubscribeAll(): void {
    this.unsubscribeAll()
    if (!this.enabled || !this.symbol) return
    for (const iv of this.timeframes) this.subscribeRow(iv)
  }

  private subscribeRow(iv: Interval): void {
    const symbol = this.symbol
    this.provider
      .fetchCandles(symbol, iv, 1)
      .then((candles) => {
        // Bail if the symbol/timeframe moved on while this was in flight.
        if (this.symbol !== symbol || !this.timeframes.includes(iv) || !this.subs.has(iv)) return
        if (candles.length) this.applyCandle(iv, candles[candles.length - 1])
      })
      .catch(() => {
        /* transient fetch error — subscribeCandles below still updates the row once live data arrives */
      })
    const unsub = this.provider.subscribeCandles(symbol, iv, (c) => this.applyCandle(iv, c))
    this.subs.set(iv, unsub)
  }

  private unsubscribeRow(iv: Interval): void {
    this.subs.get(iv)?.()
    this.subs.delete(iv)
  }

  private unsubscribeAll(): void {
    for (const unsub of this.subs.values()) unsub()
    this.subs.clear()
  }

  private applyCandle(iv: Interval, c: Candle): void {
    const row = this.rows.get(iv)
    if (!row) return
    if (row.lastTime !== undefined && c.time < row.lastTime) return // older than what's already shown — ignore
    row.lastTime = c.time
    const dom = candleDominanceSide(c)
    row.dotEl.className = `dt2-dot${dom ? ` ${dom}` : ''}`
  }
}
