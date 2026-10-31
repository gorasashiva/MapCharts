// Right-dock panels opened from the widget bar: the Object tree (everything on
// the active chart — indicators, power tools, drawings — with show / hide /
// settings / remove) and the Data window (the bar under the crosshair with
// every indicator and tool value).
import { formatFullTime, getDisplayTimeZone } from '../../src/chart/scales'
import type { DataWindowSnapshot } from './pane'
import { el, ICONS } from './ui'

export interface TreeItem {
  label: string
  sub?: string
  hidden?: boolean
  onToggle?: () => void
  onSettings?: () => void
  onRemove?: () => void
}

export interface TreeSection {
  title: string
  items: TreeItem[]
  empty: string
  /** Optional header action, e.g. "Remove all". */
  action?: { label: string; run: () => void }
}

function panelHead(title: string, onClose: () => void): HTMLElement {
  const head = el('div', { class: 'watchlist-head' })
  const close = el('button', { class: 'mi-icon', title: `Close ${title}`, 'aria-label': `Close ${title}` }, ICONS.close)
  close.addEventListener('click', onClose)
  head.append(el('span', { class: 'watchlist-title' }, title), close)
  return head
}

export class ObjectTree {
  readonly root: HTMLElement
  private readonly body: HTMLElement
  private sig = ''

  constructor(onClose: () => void) {
    this.root = el('div', { class: 'side-panel' })
    this.body = el('div', { class: 'side-body' })
    this.root.append(panelHead('Object tree', onClose), this.body)
  }

  render(sections: TreeSection[]): void {
    const sig = JSON.stringify(sections.map((s) => [s.title, s.items.map((i) => [i.label, i.sub, i.hidden])]))
    if (sig === this.sig) return
    this.sig = sig
    this.body.replaceChildren()
    for (const s of sections) {
      const head = el('div', { class: 'ot-head' })
      head.append(el('span', {}, s.title), el('span', { class: 'ot-count' }, String(s.items.length)))
      if (s.action && s.items.length) {
        const b = el('button', { class: 'ot-action' }, s.action.label)
        b.addEventListener('click', s.action.run)
        head.append(b)
      }
      this.body.append(head)
      if (!s.items.length) {
        this.body.append(el('div', { class: 'ot-empty' }, s.empty))
        continue
      }
      for (const it of s.items) {
        const row = el('div', { class: `ot-row${it.hidden ? ' hidden' : ''}` })
        const text = el('span', { class: 'ot-text' })
        const name = el('span', { class: 'ot-name' })
        name.textContent = it.label
        text.append(name)
        if (it.sub) {
          const sub = el('span', { class: 'ot-sub' })
          sub.textContent = it.sub
          text.append(sub)
        }
        row.append(text)
        const btn = (title: string, icon: string, fn: () => void): void => {
          const b = el('button', { class: 'mi-icon', title, 'aria-label': `${title} ${it.label}` }, icon)
          b.addEventListener('click', (e) => {
            e.stopPropagation()
            fn()
          })
          row.append(b)
        }
        if (it.onToggle) btn(it.hidden ? 'Show' : 'Hide', it.hidden ? ICONS.eyeOff : ICONS.eye, it.onToggle)
        if (it.onSettings) btn('Settings', ICONS.gear, it.onSettings)
        if (it.onRemove) btn('Remove', ICONS.trash, it.onRemove)
        this.body.append(row)
      }
    }
  }
}

export class DataWindow {
  readonly root: HTMLElement
  private readonly body: HTMLElement
  private sig = ''

  constructor(onClose: () => void) {
    this.root = el('div', { class: 'side-panel' })
    this.body = el('div', { class: 'side-body dw' })
    this.root.append(panelHead('Data window', onClose), this.body)
  }

  render(symbol: string, interval: string, intervalMs: number, snap: DataWindowSnapshot): void {
    const c = snap.candle
    const sig = JSON.stringify([symbol, interval, getDisplayTimeZone(), c, snap.hovering, snap.rows])
    if (sig === this.sig) return
    this.sig = sig
    const fp = (v: number): string => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(v) >= 1 ? 2 : 6 })
    this.body.replaceChildren()
    const head = el('div', { class: 'dw-sym' })
    head.textContent = `${symbol} · ${interval}`
    this.body.append(head)
    const line = (k: string, v: string, color?: string): void => {
      const r = el('div', { class: 'dw-row' })
      const key = el('span', {})
      key.textContent = k
      const val = el('b', {})
      val.textContent = v
      if (color) val.style.color = color
      r.append(key, val)
      this.body.append(r)
    }
    if (!c) {
      this.body.append(el('div', { class: 'ot-empty' }, 'No data yet.'))
      return
    }
    const diff = c.close - c.open
    const chg = c.open ? (diff / c.open) * 100 : 0
    const dir = c.close >= c.open ? 'var(--up)' : 'var(--down)'
    line(snap.hovering ? 'Bar (crosshair)' : 'Bar (latest)', formatFullTime(c.time, intervalMs))
    line('Open', fp(c.open), dir)
    line('High', fp(c.high), dir)
    line('Low', fp(c.low), dir)
    line('Close', fp(c.close), dir)
    line('Change', `${diff >= 0 ? '+' : ''}${fp(diff)} (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)`, dir)
    line('Volume', c.volume.toLocaleString('en-US', { maximumFractionDigits: 2 }))
    for (const r of snap.rows) {
      const h = el('div', { class: `dw-ind${r.hidden ? ' hidden' : ''}` })
      h.textContent = r.hidden ? `${r.label} (hidden)` : r.label
      this.body.append(h)
      if (r.hidden || !r.values.length) continue
      r.values.forEach((v, i) => line(r.values.length > 1 ? `Plot ${i + 1}` : 'Value', v.text, v.color))
    }
  }
}

// ---------------------------------------------------------------------------
// Alerts panel: every price alert, grouped active / triggered, with remove.
// ---------------------------------------------------------------------------
export interface AlertRow {
  id: string
  symbol: string
  price: number
  condition: 'above' | 'below'
  triggered: boolean
  triggeredAt?: number
  /** Latest price for the symbol, when known (for the distance column). */
  last?: number
}

export class AlertsPanel {
  readonly root: HTMLElement
  private readonly body: HTMLElement
  private sig = ''
  onRemove: ((id: string) => void) | null = null
  onAddHere: (() => void) | null = null
  onClearTriggered: (() => void) | null = null
  onPick: ((symbol: string) => void) | null = null

  constructor(onClose: () => void) {
    this.root = el('div', { class: 'side-panel' })
    const head = panelHead('Alerts', onClose)
    const add = el('button', { class: 'mi-icon', title: 'Add alert at the current price', 'aria-label': 'Add alert at the current price' }, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>')
    add.addEventListener('click', () => this.onAddHere?.())
    head.insertBefore(add, head.lastChild)
    this.body = el('div', { class: 'side-body' })
    this.root.append(head, this.body)
  }

  render(rows: AlertRow[]): void {
    const sig = JSON.stringify(rows.map((r) => [r.id, r.price, r.triggered, r.last?.toFixed(2)]))
    if (sig === this.sig) return
    this.sig = sig
    this.body.replaceChildren()
    const active = rows.filter((r) => !r.triggered)
    const fired = rows.filter((r) => r.triggered).sort((a, b) => (b.triggeredAt ?? 0) - (a.triggeredAt ?? 0))
    const section = (title: string, list: AlertRow[], empty: string, action?: { label: string; run: () => void }): void => {
      const h = el('div', { class: 'ot-head' })
      h.append(el('span', {}, title), el('span', { class: 'ot-count' }, String(list.length)))
      if (action && list.length) {
        const b = el('button', { class: 'ot-action' }, action.label)
        b.addEventListener('click', action.run)
        h.append(b)
      }
      this.body.append(h)
      if (!list.length) {
        this.body.append(el('div', { class: 'ot-empty' }, empty))
        return
      }
      for (const r of list) {
        const row = el('div', { class: `ot-row al-row${r.triggered ? ' hidden' : ''}` })
        const text = el('span', { class: 'ot-text' })
        const name = el('button', { class: 'al-sym' })
        name.textContent = `${r.symbol} ${r.condition === 'above' ? '≥' : '≤'} ${r.price.toLocaleString('en-US', { maximumFractionDigits: 6 })}`
        name.addEventListener('click', () => this.onPick?.(r.symbol))
        const sub = el('span', { class: 'ot-sub' })
        if (r.triggered) sub.textContent = r.triggeredAt ? `Triggered ${new Date(r.triggeredAt).toLocaleTimeString()}` : 'Triggered'
        else if (r.last) {
          const d = ((r.price - r.last) / r.last) * 100
          sub.textContent = `${d >= 0 ? '+' : ''}${d.toFixed(2)}% away · last ${r.last.toLocaleString('en-US', { maximumFractionDigits: 6 })}`
        }
        text.append(name, sub)
        const rm = el('button', { class: 'mi-icon', title: 'Remove alert', 'aria-label': `Remove alert ${r.symbol} ${r.price}` }, ICONS.trash)
        rm.addEventListener('click', () => this.onRemove?.(r.id))
        row.append(text, rm)
        this.body.append(row)
      }
    }
    section('Active', active, 'No active alerts. Right-click the chart or use + to add one.')
    section('Triggered', fired, 'Nothing has fired yet.', { label: 'Clear', run: () => this.onClearTriggered?.() })
  }
}

// ---------------------------------------------------------------------------
// Order book: top-of-book ladder for the active symbol with depth bars.
// ---------------------------------------------------------------------------
export interface DepthProvider {
  subscribeDepth(symbol: string, onDepth: (d: { bids: [number, number][]; asks: [number, number][] }) => void): () => void
}

export class OrderBookPanel {
  readonly root: HTMLElement
  private readonly body: HTMLElement
  private readonly titleSym: HTMLElement
  private symbol = ''
  private visible = false
  private unsub: (() => void) | null = null
  private pending: { bids: [number, number][]; asks: [number, number][] } | null = null
  private raf = 0
  private readonly LEVELS = 14

  constructor(
    private readonly provider: DepthProvider,
    onClose: () => void,
  ) {
    this.root = el('div', { class: 'side-panel' })
    const head = panelHead('Order book', onClose)
    this.titleSym = el('span', { class: 'ob-sym' })
    head.insertBefore(this.titleSym, head.lastChild)
    this.body = el('div', { class: 'side-body ob' })
    this.root.append(head, this.body)
  }

  setSymbol(symbol: string): void {
    if (symbol === this.symbol) return
    this.symbol = symbol
    this.titleSym.textContent = symbol
    this.resubscribe()
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return
    this.visible = v
    this.resubscribe()
  }

  private resubscribe(): void {
    this.unsub?.()
    this.unsub = null
    if (!this.visible || !this.symbol) return
    this.body.replaceChildren(el('div', { class: 'ot-empty' }, 'Connecting…'))
    try {
      this.unsub = this.provider.subscribeDepth(this.symbol, (d) => {
        this.pending = d
        if (!this.raf) this.raf = requestAnimationFrame(() => this.paint())
      })
    } catch {
      this.body.replaceChildren(el('div', { class: 'ot-empty' }, 'Order book unavailable for this symbol.'))
    }
  }

  private paint(): void {
    this.raf = 0
    const d = this.pending
    if (!d) return
    const asks = d.asks.slice(0, this.LEVELS)
    const bids = d.bids.slice(0, this.LEVELS)
    const max = Math.max(1e-12, ...asks.map((a) => a[1]), ...bids.map((b) => b[1]))
    const fp = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 6 })
    const fq = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: 4 })
    const line = (p: number, q: number, side: 'ask' | 'bid'): HTMLElement => {
      const r = el('div', { class: `ob-row ${side}` })
      const bar = el('span', { class: 'ob-bar' })
      bar.style.width = `${((q / max) * 100).toFixed(1)}%`
      r.append(bar, el('span', { class: 'ob-p' }, fp(p)), el('span', { class: 'ob-q' }, fq(q)))
      return r
    }
    const frag = document.createDocumentFragment()
    const hdr = el('div', { class: 'ob-row ob-hdr' }, '<span class="ob-p">Price</span><span class="ob-q">Size</span>')
    frag.appendChild(hdr)
    for (const a of [...asks].reverse()) frag.appendChild(line(a[0], a[1], 'ask'))
    const spread = asks.length && bids.length ? asks[0][0] - bids[0][0] : NaN
    const mid = asks.length && bids.length ? (asks[0][0] + bids[0][0]) / 2 : NaN
    frag.appendChild(el('div', { class: 'ob-spread' }, isFinite(spread) ? `<b>${fp(mid)}</b><span>Spread ${fp(spread)} · ${((spread / mid) * 10000).toFixed(1)} bp</span>` : ''))
    for (const b of bids) frag.appendChild(line(b[0], b[1], 'bid'))
    this.body.replaceChildren(frag)
  }
}
