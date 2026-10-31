// Shared demo UI helpers: a tiny DOM builder, a popover/dropdown registry, and
// the inline SVG icon set. Kept framework-free to match the library.

/** Create an element, set attributes, optionally set innerHTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  html?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  if (html != null) node.innerHTML = html
  return node
}

// ---- popover registry: only one dropdown/flyout open at a time ----
const popovers: HTMLElement[] = []
export function closeAllPopovers(): void {
  for (const p of popovers) p.classList.remove('open')
}
/** Wire `trigger` to toggle `wrapper.open`; clicks inside `menu` don't auto-close. */
export function registerPopover(wrapper: HTMLElement, trigger: HTMLElement, menu: HTMLElement): void {
  trigger.addEventListener('click', (e) => {
    e.stopPropagation()
    const wasOpen = wrapper.classList.contains('open')
    closeAllPopovers()
    if (!wasOpen) wrapper.classList.add('open')
  })
  menu.addEventListener('click', (e) => e.stopPropagation())
  popovers.push(wrapper)
}
document.addEventListener('click', closeAllPopovers)

// ---- icons (stroke = currentColor; filled variants set fill) ----
const L = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
const F = (inner: string) => `<svg viewBox="0 0 24 24" fill="currentColor">${inner}</svg>`

export const ICONS = {
  search: L('<circle cx="11" cy="11" r="6"/><path d="M16.5 16.5L21 21"/>'),
  chevron: L('<path d="M6 9l6 6 6-6"/>'),
  candles: `<svg viewBox="0 0 24 24"><g fill="currentColor"><rect x="5" y="9" width="3.4" height="7" rx=".5"/><rect x="15.2" y="8" width="3.4" height="5.5" rx=".5"/></g><g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6.7 5.5v3.5M6.7 16v2.5M16.9 4.5v3.5M16.9 13.5v3"/></g></svg>`,
  indicators: L('<path d="M3 12c3-7 6-7 9 0s6 7 9 0"/>'),
  cursor: F('<path d="M5 3l13 6.5-5.4 1.6L10.2 21z"/>'),
  trendline: L('<path d="M5 19L19 5"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/>'),
  channels: L('<path d="M3 17L17 3M7 21L21 7"/>'),
  fib: L('<path d="M3 5h18M3 10h18M3 14h18M3 19h18"/>'),
  patterns: L('<path d="M3 17l4-7 4 5 4-9 4 7 2-3"/>'),
  shapes: L('<rect x="4" y="6" width="16" height="12" rx="1.5"/>'),
  text: L('<path d="M5 6h14M12 6v13"/>'),
  measure: L('<rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 8v3M11 8v4M15 8v3"/>'),
  projection: L('<path d="M4 20L20 4M12 4h8v8"/>'),
  smart: F('<path d="M12 3l1.9 5.4L19 10l-5.1 1.6L12 17l-1.9-5.4L5 10l5.1-1.6z"/>'),
  magnet: L('<path d="M7 4v7a5 5 0 0010 0V4M7 4H4M17 4h3M7 8H4M17 8h3"/>'),
  trash: L('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  reset: L('<path d="M4 4v6h6M20 20v-6h-6"/><path d="M5 14a8 8 0 0014 1M19 10A8 8 0 005 9"/>'),
  sun: L('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>'),
  moon: F('<path d="M21 13.5A8.5 8.5 0 1110.5 3 6.6 6.6 0 0021 13.5z"/>'),
  gear: L('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"/>'),
  close: L('<path d="M6 6l12 12M18 6L6 18"/>'),
  grid: L('<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M12 3v18M3 12h18"/>'),
  layers: L('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
  eye: L('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: L('<path d="M3 3l18 18M10.6 10.6a3 3 0 004.2 4.2M9.8 5.1A10.6 10.6 0 0112 5c6.5 0 10 7 10 7a18.4 18.4 0 01-3.2 4M6.5 6.6C3.7 8.1 2 12 2 12s3.5 7 10 7a10.5 10.5 0 003.5-.6"/>'),
  bell: L('<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/>'),
  replay: L('<path d="M3 4v5h5"/><path d="M3.5 9a8 8 0 113.2 8.6"/><path d="M11 9l4.5 3L11 15z" fill="currentColor" stroke="none"/>'),
  play: F('<path d="M8 5v14l11-7z"/>'),
  pause: F('<path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z"/>'),
  stepBack: F('<path d="M7 6h2.4v12H7zM20 6v12l-9-6z"/>'),
  stepFwd: F('<path d="M14.6 6H17v12h-2.4zM4 6v12l9-6z"/>'),
  stats: L('<path d="M3 21h18"/><path d="M6 21V11M11 21V4M16 21v-6M21 21v-10" stroke-width="2"/>'),
}

/** A small layout-preview SVG (cols × rows of cells) for the layout menu. */
export function layoutPreview(cols: number, rows: number): string {
  const cells: string[] = []
  const gap = 1.5
  const w = (22 - gap * (cols + 1)) / cols
  const h = (22 - gap * (rows + 1)) / rows
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = gap + c * (w + gap)
      const y = gap + r * (h + gap)
      cells.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1.2"/>`)
    }
  }
  return `<svg viewBox="0 0 22 22" fill="currentColor">${cells.join('')}</svg>`
}

/** Best-effort conversion of a CSS color to a #rrggbb hex (for <input type=color>). */
export function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c
  if (/^#[0-9a-f]{3}$/i.test(c)) {
    const m = c.slice(1)
    return '#' + m.split('').map((x) => x + x).join('')
  }
  const m = c.match(/rgba?\(([^)]+)\)/i)
  if (m) {
    const [r, g, b] = m[1].split(',').map((s) => parseInt(s, 10))
    return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v || 0)).toString(16).padStart(2, '0')).join('')
  }
  return '#888888'
}
