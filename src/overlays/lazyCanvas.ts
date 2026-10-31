/**
 * Makes an overlay canvas cheap while it has nothing to show.
 *
 * Overlays run their own requestAnimationFrame loop and start every frame with a
 * full clearRect — including overlays that are switched off and draw nothing.
 * A clear still marks the canvas dirty, so the browser re-uploads and re-blends a
 * full-screen, DPR-scaled layer every frame for an empty picture. With ~20
 * overlays per pane that kept the GPU saturated while the chart sat idle.
 *
 * This patches the 2D context instance (not the prototype) so that:
 *  - a clear on an already-empty canvas is skipped (no dirty mark, no upload);
 *  - once a frame ends with nothing drawn, the canvas is set `visibility: hidden`
 *    so the compositor skips the layer; the first draw call shows it again.
 * Drawing code is untouched: overlays that are drawing behave exactly as before.
 * Tracking only errs towards "has content" (e.g. a partial clear), which costs a
 * redundant clear but never leaves stale pixels on screen.
 */
const INK_METHODS = ['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'drawImage', 'putImageData'] as const

export function lazyCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  // A new canvas is blank, and resizing (setting width/height) only ever wipes the
  // bitmap, so "no ink" can never hide pixels that are really there.
  let hasInk = false
  let checkQueued = false

  const syncVisibility = (): void => {
    checkQueued = false
    const want = hasInk ? '' : 'hidden'
    if (canvas.style.visibility !== want) canvas.style.visibility = want
  }
  const queueCheck = (): void => {
    if (checkQueued) return
    checkQueued = true
    // Runs after the current task, i.e. after this frame's draw calls.
    queueMicrotask(syncVisibility)
  }

  const realClear = ctx.clearRect.bind(ctx)
  ctx.clearRect = (x: number, y: number, w: number, h: number): void => {
    if (!hasInk) return
    realClear(x, y, w, h)
    const m = ctx.getTransform()
    const coversAll =
      m.b === 0 && m.c === 0 &&
      m.a * x + m.e <= 0 && m.d * y + m.f <= 0 &&
      m.a * (x + w) + m.e >= canvas.width - 1 && m.d * (y + h) + m.f >= canvas.height - 1
    if (coversAll) {
      hasInk = false
      queueCheck()
    }
  }

  syncVisibility()

  for (const name of INK_METHODS) {
    const real = (ctx[name] as (...a: unknown[]) => unknown).bind(ctx)
    ;(ctx as unknown as Record<string, unknown>)[name] = (...args: unknown[]): unknown => {
      if (!hasInk) {
        hasInk = true
        queueCheck()
      }
      return real(...args)
    }
  }
}
