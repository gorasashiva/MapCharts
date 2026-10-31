/**
 * DOM event wiring for the chart engine. Pure plumbing: translates browser
 * events into canvas-relative coordinates and forwards them to the engine,
 * which owns all interaction logic (pan vs drawing-drag vs tool placement).
 *
 * While a drag is in progress the move/up listeners live on `window`, so the
 * gesture keeps working when the cursor leaves the canvas.
 */
export interface InteractionHandlers {
  pointerDown(x: number, y: number, ev: MouseEvent): void
  pointerMove(x: number, y: number, ev: MouseEvent): void
  pointerUp(x: number, y: number, ev: MouseEvent): void
  pointerLeave(): void
  wheel(x: number, y: number, ev: WheelEvent): void
  /** Pinch-zoom (touch): scale the time range around `centerX` by `scale` (>1 = zoom in). */
  pinch(centerX: number, scale: number): void
  doubleClick(x: number, y: number, ev: MouseEvent): void
  /** Right-click. The engine calls preventDefault and positions a host menu at (x, y). */
  contextMenu(x: number, y: number, ev: MouseEvent): void
  keyDown(ev: KeyboardEvent): void
}

/** Attach all listeners; returns a dispose function that removes every one. */
export function attachInteractions(
  canvas: HTMLCanvasElement,
  handlers: InteractionHandlers,
): () => void {
  let dragging = false

  const rel = (ev: MouseEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect()
    return { x: ev.clientX - r.left, y: ev.clientY - r.top }
  }

  const onWindowMove = (ev: MouseEvent): void => {
    const { x, y } = rel(ev)
    handlers.pointerMove(x, y, ev)
  }

  const onWindowUp = (ev: MouseEvent): void => {
    dragging = false
    window.removeEventListener('mousemove', onWindowMove)
    window.removeEventListener('mouseup', onWindowUp)
    const { x, y } = rel(ev)
    handlers.pointerUp(x, y, ev)
  }

  const onMouseDown = (ev: MouseEvent): void => {
    if (ev.button !== 0) return
    ev.preventDefault() // avoid text selection while dragging
    dragging = true
    const { x, y } = rel(ev)
    handlers.pointerDown(x, y, ev)
    window.addEventListener('mousemove', onWindowMove)
    window.addEventListener('mouseup', onWindowUp)
  }

  const onMouseMove = (ev: MouseEvent): void => {
    if (dragging) return // window listener already covers it
    const { x, y } = rel(ev)
    handlers.pointerMove(x, y, ev)
  }

  const onMouseLeave = (): void => {
    if (!dragging) handlers.pointerLeave()
  }

  const onWheel = (ev: WheelEvent): void => {
    ev.preventDefault()
    const { x, y } = rel(ev)
    handlers.wheel(x, y, ev)
  }

  const onDblClick = (ev: MouseEvent): void => {
    const { x, y } = rel(ev)
    handlers.doubleClick(x, y, ev)
  }

  const onContextMenu = (ev: MouseEvent): void => {
    const { x, y } = rel(ev)
    handlers.contextMenu(x, y, ev)
  }

  const onKeyDown = (ev: KeyboardEvent): void => {
    handlers.keyDown(ev)
  }

  // ----- touch: 1 finger = pan, 2 fingers = pinch-zoom the chart -----------
  // The canvas has touch-action:none, so the browser never pans/zooms the page
  // from gestures that start here; we preventDefault and drive the chart.
  let touchMode: 'none' | 'pan' | 'pinch' = 'none'
  let lastPinchDist = 0
  // pointerDown only reads ev.button; move/up ignore the event entirely.
  const touchEv = { button: 0, preventDefault: () => {} } as unknown as MouseEvent

  const touchRel = (t: Touch): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect()
    return { x: t.clientX - r.left, y: t.clientY - r.top }
  }
  const pinchDist = (ev: TouchEvent): number => {
    const a = touchRel(ev.touches[0])
    const b = touchRel(ev.touches[1])
    return Math.hypot(a.x - b.x, a.y - b.y)
  }

  const onTouchStart = (ev: TouchEvent): void => {
    if (ev.touches.length >= 2) {
      ev.preventDefault()
      if (touchMode === 'pan') handlers.pointerUp(0, 0, touchEv) // end any single-finger drag
      touchMode = 'pinch'
      lastPinchDist = pinchDist(ev)
    } else if (ev.touches.length === 1) {
      ev.preventDefault()
      touchMode = 'pan'
      const { x, y } = touchRel(ev.touches[0])
      handlers.pointerDown(x, y, touchEv)
    }
  }

  const onTouchMove = (ev: TouchEvent): void => {
    if (touchMode === 'pinch' && ev.touches.length >= 2) {
      ev.preventDefault()
      const dist = pinchDist(ev)
      if (lastPinchDist > 0 && dist > 0) {
        const a = touchRel(ev.touches[0])
        const b = touchRel(ev.touches[1])
        handlers.pinch((a.x + b.x) / 2, dist / lastPinchDist)
      }
      lastPinchDist = dist
    } else if (touchMode === 'pan' && ev.touches.length === 1) {
      ev.preventDefault()
      const { x, y } = touchRel(ev.touches[0])
      handlers.pointerMove(x, y, touchEv)
    }
  }

  const onTouchEnd = (ev: TouchEvent): void => {
    if (touchMode === 'pan') {
      const t = ev.changedTouches[0]
      if (t) {
        const { x, y } = touchRel(t)
        handlers.pointerUp(x, y, touchEv)
      } else handlers.pointerUp(0, 0, touchEv)
      touchMode = 'none'
    } else if (touchMode === 'pinch' && ev.touches.length < 2) {
      // Lifting one finger ends the pinch; don't auto-promote to pan (lift fully
      // and re-touch to pan — avoids a jump).
      touchMode = 'none'
      lastPinchDist = 0
    }
  }

  canvas.addEventListener('mousedown', onMouseDown)
  canvas.addEventListener('mousemove', onMouseMove)
  canvas.addEventListener('mouseleave', onMouseLeave)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('dblclick', onDblClick)
  canvas.addEventListener('contextmenu', onContextMenu)
  canvas.addEventListener('touchstart', onTouchStart, { passive: false })
  canvas.addEventListener('touchmove', onTouchMove, { passive: false })
  canvas.addEventListener('touchend', onTouchEnd)
  canvas.addEventListener('touchcancel', onTouchEnd)
  window.addEventListener('keydown', onKeyDown)

  return () => {
    canvas.removeEventListener('mousedown', onMouseDown)
    canvas.removeEventListener('mousemove', onMouseMove)
    canvas.removeEventListener('mouseleave', onMouseLeave)
    canvas.removeEventListener('wheel', onWheel)
    canvas.removeEventListener('dblclick', onDblClick)
    canvas.removeEventListener('contextmenu', onContextMenu)
    canvas.removeEventListener('touchstart', onTouchStart)
    canvas.removeEventListener('touchmove', onTouchMove)
    canvas.removeEventListener('touchend', onTouchEnd)
    canvas.removeEventListener('touchcancel', onTouchEnd)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('mousemove', onWindowMove)
    window.removeEventListener('mouseup', onWindowUp)
  }
}
