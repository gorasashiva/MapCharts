// The left edge the chart's own content should start at: the floating drawing toolbar
// covers the first --chart-inset px of the plot (main.ts publishes it on #grid from the
// toolbar's measured edge; the legend already sits past it). Canvas overlays read it here
// for text they pin to the left, so it isn't hidden under the toolbar.

const cache = new WeakMap<Element, { at: number; px: number }>()

/** --chart-inset (px) as seen from `el`, re-read at most twice a second (getComputedStyle is not free). */
export function chartInset(el: Element | null | undefined): number {
  if (!el || typeof getComputedStyle !== 'function') return 0
  const now = performance.now()
  const hit = cache.get(el)
  if (hit && now - hit.at < 500) return hit.px
  const px = parseFloat(getComputedStyle(el).getPropertyValue('--chart-inset')) || 0
  cache.set(el, { at: now, px })
  return px
}
