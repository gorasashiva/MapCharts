// Shared behavior for the small floating "card" widgets that sit absolutely
// positioned over a chart pane (Buy/Sell Poll, Dominance V2, GEX V2, Setup
// Checklist, ...): free dragging, plus corner-slot STACKING so that several
// widgets defaulted to the same corner offset one another instead of
// rendering on top of each other.
//
// Previously each widget hand-rolled its own ~30-line copy of this drag
// logic, all pinned to a fixed CSS corner with no coordination between
// widgets — so e.g. Setup Checklist and Buy/Sell Poll (both top-left by
// default) would fully occlude one another the moment both were enabled, and
// Dominance V2 / GEX V2 (both top-right) would do the same while also
// covering the chart engine's own canvas-drawn price-axis "A"/"L" toggle
// buttons, making them unclickable. This module fixes both: widgets in the
// same corner queue up top-to-bottom (or bottom-to-top), and the top-right
// stack starts clear of the axis toggles.
//
// A widget leaves the stack the moment the user actually drags it — from
// then on it behaves exactly as before (a freely positioned card, clamped to
// the container on resize), matching the pre-existing per-widget behavior.

export type WidgetCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

const GAP_PX = 8

/**
 * Chrome each corner's stack must start clear of, keyed by corner. Currently
 * only the chart engine's price-axis "A" (auto/manual scale) and "L" (log
 * scale) toggle buttons, drawn on the canvas itself (not DOM) at the pane's
 * top-right — see AXIS_TOGGLE_SIZE/AXIS_TOGGLE_MARGIN in src/chart/engine.ts.
 * Both buttons sit within y:[4, 44] of the pane, so a docked stack there
 * starts at 44 + one gap. Top-left holds the chart's title + OHLC row (24px)
 * and the folded indicator legend row below it, so its stack starts under both.
 */
const CORNER_RESERVE_PX: Partial<Record<WidgetCorner, number>> = {
  'top-right': 52,
  'top-left': 54,
}

interface Entry {
  root: HTMLElement
  corner: WidgetCorner
  /** Hidden widgets (setEnabled(false)) neither reserve a slot nor push others. */
  visible: boolean
}

interface Registry {
  entries: Entry[]
}

/** One registry per pane container (each grid pane's widgets stack independently). */
const registries = new WeakMap<HTMLElement, Registry>()

function registryFor(container: HTMLElement): Registry {
  let r = registries.get(container)
  if (!r) {
    r = { entries: [] }
    registries.set(container, r)
  }
  return r
}

function edgeAndSide(corner: WidgetCorner): { edge: 'top' | 'bottom'; side: 'left' | 'right' } {
  return {
    edge: corner.startsWith('top') ? 'top' : 'bottom',
    side: corner.endsWith('left') ? 'left' : 'right',
  }
}

/** Re-stack every still-docked, visible widget in `corner`, offsetting each by
 *  the cumulative size (+gap) of the ones queued before it. */
function reflow(container: HTMLElement, corner: WidgetCorner): void {
  const { entries } = registryFor(container)
  const { edge, side } = edgeAndSide(corner)
  const vertical = edge === 'top' || edge === 'bottom'
  let offset = CORNER_RESERVE_PX[corner] ?? GAP_PX
  for (const e of entries) {
    if (e.corner !== corner || !e.visible) continue
    // Top-left stacks start below the host's legend when the host publishes
    // its height as --tl-reserve (it grows when the legend is expanded).
    const reserve = CORNER_RESERVE_PX[corner] ?? GAP_PX
    e.root.style[edge] = corner === 'top-left' ? `calc(var(--tl-reserve, ${reserve}px) + ${offset - reserve}px)` : `${offset}px`
    // Left-docked widgets also clear the host's floating drawing toolbar, whose
    // width the host publishes as --chart-inset (0 when there is none).
    e.root.style[side] = side === 'left' ? `calc(var(--chart-inset, 0px) + ${GAP_PX}px)` : `${GAP_PX}px`
    offset += (vertical ? e.root.offsetHeight : e.root.offsetWidth) + GAP_PX
  }
}

export interface FloatingWidgetHandle {
  /** Re-stack (if still docked) or re-clamp within bounds (if the user
   *  dragged it away) — call from the pane's resize handling. */
  resize(): void
  /** Toggle visibility bookkeeping for the corner stack. Does NOT itself set
   *  `root.style.display` — callers keep doing that (they already know which
   *  display value the widget wants) and call this alongside it. */
  setVisible(visible: boolean): void
  /** Detach from the corner registry, dropping its effect on the stack, and
   *  reflow whatever remains in its corner. */
  destroy(): void
}

/**
 * Wires free dragging for `root` (grab anywhere on it) and docks it into
 * `corner`'s stack within `container` for as long as it stays visible and
 * hasn't been dragged. Call once, right after `container.appendChild(root)`.
 *
 * `ignoreSelector` excludes sub-elements (e.g. an "add" button or a remove
 * icon inside the card) from starting a drag, matching what a couple of the
 * widgets already needed.
 */
export function attachFloatingWidget(
  container: HTMLElement,
  root: HTMLElement,
  corner: WidgetCorner,
  ignoreSelector?: string,
): FloatingWidgetHandle {
  const reg = registryFor(container)
  const entry: Entry = { root, corner, visible: root.style.display !== 'none' }
  reg.entries.push(entry)
  let docked = true
  reflow(container, corner)

  let dragging = false
  let dragOffsetX = 0
  let dragOffsetY = 0

  function undock(): void {
    if (!docked) return
    docked = false
    const idx = reg.entries.indexOf(entry)
    if (idx >= 0) reg.entries.splice(idx, 1)
    reflow(container, corner)
  }

  root.addEventListener('pointerdown', (e) => {
    if (ignoreSelector && (e.target as HTMLElement).closest(ignoreSelector)) return
    e.preventDefault()
    dragging = true
    const r = root.getBoundingClientRect()
    dragOffsetX = e.clientX - r.left
    dragOffsetY = e.clientY - r.top
    root.classList.add('dragging')
    root.setPointerCapture(e.pointerId)
  })
  root.addEventListener('pointermove', (e) => {
    if (!dragging) return
    undock() // once actually grabbed, it leaves the docked stack for good
    const bounds = container.getBoundingClientRect()
    const maxX = Math.max(0, bounds.width - root.offsetWidth)
    const maxY = Math.max(0, bounds.height - root.offsetHeight)
    const x = Math.min(Math.max(0, e.clientX - bounds.left - dragOffsetX), maxX)
    const y = Math.min(Math.max(0, e.clientY - bounds.top - dragOffsetY), maxY)
    root.style.left = `${x}px`
    root.style.top = `${y}px`
    root.style.right = 'auto'
    root.style.bottom = 'auto'
  })
  const endDrag = (e: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    root.classList.remove('dragging')
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId)
  }
  root.addEventListener('pointerup', endDrag)
  root.addEventListener('pointercancel', endDrag)

  return {
    resize(): void {
      if (docked) {
        reflow(container, corner)
        return
      }
      if (!root.style.left) return // never dragged — shouldn't happen once undocked, but safe
      const bounds = container.getBoundingClientRect()
      const maxX = Math.max(0, bounds.width - root.offsetWidth)
      const maxY = Math.max(0, bounds.height - root.offsetHeight)
      const x = Math.min(Math.max(0, parseFloat(root.style.left) || 0), maxX)
      const y = Math.min(Math.max(0, parseFloat(root.style.top) || 0), maxY)
      root.style.left = `${x}px`
      root.style.top = `${y}px`
    },
    setVisible(visible: boolean): void {
      entry.visible = visible
      if (docked) reflow(container, corner)
    },
    destroy(): void {
      const idx = reg.entries.indexOf(entry)
      if (idx >= 0) reg.entries.splice(idx, 1)
      if (docked) reflow(container, corner)
    },
  }
}
