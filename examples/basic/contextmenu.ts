// TradingView-style right-click menu: a single reusable popup, positioned at
// the click point and filled with a fresh set of actions each time it opens.
// The chart engine already emits onContextMenu (container-relative x/y +
// price/time under the cursor) via ChartPane.onContextMenu — this module is
// just the menu widget + main.ts wires it to real actions.
import { el } from './ui'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  /** Right-aligned shortcut / hint text, e.g. "⌥R". */
  hint?: string
}

/** One flat list of items, or several — rendered with separators between groups. */
export type ContextMenuSection = ContextMenuItem[]

export class ContextMenu {
  private readonly root: HTMLElement

  constructor() {
    this.root = el('div', { class: 'ctx-menu' })
    document.body.appendChild(this.root)
    this.hide()
    // A plain left-click anywhere closes the menu. There's deliberately no
    // document-level 'contextmenu' auto-hide here: right-clicking a chart
    // re-opens (repopulates + repositions) this same menu via show(), and a
    // document listener on 'contextmenu' would fire on that SAME bubbling
    // event right after show() runs — closing the menu in the same tick it
    // opened, before it was ever visible.
    document.addEventListener('click', () => this.hide())
    window.addEventListener('resize', () => this.hide())
    window.addEventListener('scroll', () => this.hide(), true)
  }

  show(pageX: number, pageY: number, sections: ContextMenuSection[]): void {
    this.root.innerHTML = ''
    let wroteAny = false
    for (const section of sections) {
      if (section.length === 0) continue
      if (wroteAny) this.root.appendChild(el('div', { class: 'ctx-sep' }))
      for (const item of section) {
        const row = el('div', { class: `ctx-item${item.danger ? ' danger' : ''}`, role: 'menuitem' })
        const label = el('span', { class: 'ctx-label' })
        label.textContent = item.label
        row.appendChild(label)
        if (item.hint) row.appendChild(el('span', { class: 'ctx-hint' }, item.hint))
        row.addEventListener('click', (e) => {
          e.stopPropagation()
          this.hide()
          item.onClick()
        })
        this.root.appendChild(row)
      }
      wroteAny = true
    }
    if (!wroteAny) return
    this.root.style.left = `${pageX}px`
    this.root.style.top = `${pageY}px`
    this.root.style.display = 'block'
    // Keep it on screen — measure after layout, then clamp.
    requestAnimationFrame(() => {
      const r = this.root.getBoundingClientRect()
      if (r.right > window.innerWidth) this.root.style.left = `${Math.max(0, window.innerWidth - r.width - 6)}px`
      if (r.bottom > window.innerHeight) this.root.style.top = `${Math.max(0, window.innerHeight - r.height - 6)}px`
    })
  }

  hide(): void {
    this.root.style.display = 'none'
  }
}
