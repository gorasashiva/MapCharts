// ⌘K command palette: one box for symbols, actions and indicators.
// "eth" finds symbols; "eth 15" offers "Open ETHUSD on 15m"; anything else
// filters the action / indicator lists. ↑↓ move, ↵ runs, Esc closes.
import { el, ICONS } from './ui'
import { symbolLogo } from './symbolMeta'

export interface PaletteAction {
  label: string
  group: string
  hint?: string
  keywords?: string
  run(): void
}

export interface PaletteHost {
  searchSymbols(q: string): Promise<{ symbol: string; description?: string }[]>
  popularSymbols(): string[]
  /** Timeframes the app offers, e.g. ['1m','5m',…]. */
  intervals(): string[]
  openSymbol(symbol: string, interval?: string): void
  compareSymbol(symbol: string): void
  /** Optional: alert at the symbol's latest price. */
  alertSymbol?(symbol: string): void
  actions(): PaletteAction[]
  indicators(): { label: string; family: string; onChart: boolean; run(): void }[]
}

interface Row {
  group: string
  html: string
  hint?: string
  run(): void
  secondary?: { label: string; run(): void }[]
}

/** "15" → "15m", "1h" → "1h", "d" → "1d" — matched against the app's intervals. */
function parseInterval(tok: string, intervals: string[]): string | null {
  const t = tok.toLowerCase()
  const cands = [t, `${t}m`, t === 'd' ? '1d' : '', t === 'w' ? '1w' : '', t === 'h' ? '1h' : '']
  for (const c of cands) if (c && intervals.includes(c)) return c
  return null
}

const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

let current: { close(): void } | null = null

export function openCommandPalette(host: PaletteHost, initial = ''): void {
  current?.close()
  const backdrop = el('div', { class: 'modal-backdrop cp-backdrop' })
  const box = el('div', { class: 'cp', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' })
  const head = el('div', { class: 'cp-head' })
  const input = el('input', { class: 'cp-input', placeholder: 'Search symbols, actions, indicators…', spellcheck: 'false', 'aria-label': 'Search symbols, actions and indicators', 'aria-controls': 'cp-list' }) as HTMLInputElement
  input.value = initial
  head.append(el('span', { class: 'cp-icon' }, ICONS.search), input, el('kbd', { class: 'cp-kbd' }, 'Esc'))
  const list = el('div', { class: 'cp-list', id: 'cp-list', role: 'listbox' })
  const foot = el('div', { class: 'cp-foot' }, '<span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> run</span><span>Symbol + timeframe works too, e.g. <b>eth 15</b></span>')
  box.append(head, list, foot)
  backdrop.appendChild(box)

  let rows: Row[] = []
  let sel = 0
  let gen = 0

  const close = (): void => {
    backdrop.remove()
    current = null
  }
  current = { close }
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close()
  })

  const run = (r: Row | undefined): void => {
    if (!r) return
    close()
    r.run()
  }

  function paint(): void {
    list.replaceChildren()
    if (!rows.length) {
      list.appendChild(el('div', { class: 'cp-empty' }, 'Nothing found.'))
      return
    }
    let lastGroup = ''
    rows.forEach((r, i) => {
      if (r.group !== lastGroup) {
        list.appendChild(el('div', { class: 'cp-group' }, esc(r.group)))
        lastGroup = r.group
      }
      const item = el('div', { class: `cp-row${i === sel ? ' sel' : ''}`, role: 'option', 'aria-selected': String(i === sel) }, r.html)
      if (r.hint) item.appendChild(el('span', { class: 'cp-hint' }, esc(r.hint)))
      for (const sec of r.secondary ?? []) {
        const b = el('button', { class: 'cp-sec' })
        b.textContent = sec.label
        b.addEventListener('click', (e) => {
          e.stopPropagation()
          close()
          sec.run()
        })
        item.appendChild(b)
      }
      item.addEventListener('mousemove', () => {
        if (sel === i) return
        list.querySelector('.cp-row.sel')?.classList.remove('sel')
        item.classList.add('sel')
        sel = i
      })
      item.addEventListener('click', () => run(r))
      list.appendChild(item)
      if (i === sel) requestAnimationFrame(() => item.scrollIntoView({ block: 'nearest' }))
    })
  }

  async function update(): Promise<void> {
    const my = ++gen
    const q = input.value.trim()
    const toks = q.split(/\s+/).filter(Boolean)
    const ivTok = toks.length > 1 ? parseInterval(toks[toks.length - 1], host.intervals()) : null
    const symQ = (ivTok ? toks.slice(0, -1) : toks).join(' ')
    const lower = q.toLowerCase()

    const actionRows: Row[] = host
      .actions()
      .filter((a) => !q || `${a.label} ${a.keywords ?? ''} ${a.group}`.toLowerCase().includes(lower))
      .slice(0, q ? 8 : 6)
      .map((a) => ({ group: a.group, html: `<span class="cp-glyph">→</span><span>${esc(a.label)}</span>`, hint: a.hint, run: a.run }))
    const indRows: Row[] = q
      ? host
          .indicators()
          .filter((d) => `${d.label} ${d.family}`.toLowerCase().includes(lower))
          .slice(0, 5)
          .map((d) => ({ group: 'Indicators', html: `<span class="cp-glyph">∿</span><span>${esc(d.label)}</span>`, hint: d.onChart ? 'On chart' : d.family, run: d.run }))
      : []

    const symRow = (sym: string, desc?: string): Row => ({
      group: 'Symbols',
      html: `${symbolLogo(sym)}<b>${esc(sym)}</b><span class="cp-muted">${esc(desc ?? '')}${ivTok ? ` · open on ${esc(ivTok)}` : ''}</span>`,
      hint: '↵',
      run: () => host.openSymbol(sym, ivTok ?? undefined),
      secondary: [
        { label: 'Compare', run: () => host.compareSymbol(sym) },
        ...(host.alertSymbol ? [{ label: 'Alert', run: () => host.alertSymbol!(sym) }] : []),
      ],
    })

    let symRows: Row[] = []
    if (!symQ) {
      symRows = q ? [] : host.popularSymbols().slice(0, 4).map((s) => symRow(s))
    } else {
      try {
        const found = await host.searchSymbols(symQ)
        if (my !== gen) return
        symRows = found.slice(0, 6).map((f) => symRow(f.symbol, f.description))
      } catch {
        symRows = []
      }
    }
    if (my !== gen) return
    // Symbol searches put symbols first; plain words put actions first.
    rows = symQ && symRows.length ? [...symRows, ...actionRows, ...indRows] : [...actionRows, ...indRows, ...symRows]
    sel = 0
    paint()
  }

  input.addEventListener('input', () => void update())
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      sel = Math.min(rows.length - 1, sel + 1)
      paint()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      sel = Math.max(0, sel - 1)
      paint()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(rows[sel])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  })

  document.body.appendChild(backdrop)
  input.focus()
  input.select()
  void update()
}
