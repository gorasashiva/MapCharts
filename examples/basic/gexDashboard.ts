// GEX Dashboard — a standalone top-level view (alongside Charts / Options):
// left half is a strike x expiry gamma-exposure heatmap, right half is a
// collapsed per-strike histogram (either one selected expiry or all shown
// expiries aggregated). Same underlying data/model as gex.ts's GexOverlay
// (Delta Exchange India's public options chain — see the caveat there about GEX being a
// model of dealer hedging pressure, not a measured fact), just laid out as
// its own dashboard instead of plotted on a price chart.
import { el } from './ui'
import { computeGexGrid, type GexGridResult, type GexUnderlying } from './gex'
import { SUPPORTED_OPTION_UNDERLYINGS, UNDERLYING_LABEL } from './options'

const isRateLimited = (err: unknown): boolean => /HTTP 429/.test(String(err))

const POS_RGB = '217, 26, 217' // magenta — net positive (call) gamma
const NEG_RGB = '0, 200, 210' // cyan — net negative (put) gamma

function cellColor(v: number, maxAbs: number): string {
  if (maxAbs <= 0 || v === 0) return 'transparent'
  const t = Math.min(1, Math.abs(v) / maxAbs)
  const alpha = 0.12 + t * 0.68
  return `rgba(${v >= 0 ? POS_RGB : NEG_RGB}, ${alpha.toFixed(2)})`
}

function fmtGex(v: number): string {
  const k = v / 1000
  const abs = Math.abs(k)
  const text = abs >= 1000 ? abs.toLocaleString(undefined, { maximumFractionDigits: 0 }) : abs.toFixed(abs >= 100 ? 0 : 0)
  return `${v < 0 ? '-' : ''}$${text}K`
}

function fmtExpiry(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCFullYear()).slice(-2)}`
}

/** Spot reference for the GEX $-scaling — the underlying perpetual's own ticker. */
async function fetchSpot(underlying: GexUnderlying): Promise<number> {
  const res = await fetch(`https://api.india.delta.exchange/v2/tickers/${underlying}`)
  if (!res.ok) throw new Error(`Delta tickers → HTTP ${res.status}`)
  const body = (await res.json()) as { result?: { spot_price?: string; mark_price?: string } }
  return +(body.result?.spot_price ?? body.result?.mark_price ?? 0)
}

const REFRESH_MS = 60_000

export class GexDashboardView {
  readonly el: HTMLElement
  private underlyingSelect: HTMLSelectElement
  private expirySelect: HTMLSelectElement
  private nearInput: HTMLInputElement
  private spotLabel: HTMLElement
  private statusEl: HTMLElement
  private body: HTMLElement

  private underlying: GexUnderlying = 'BTCUSD'
  private nearExpiries = 5
  private viewExpiry: number | 'all' = 'all'
  private active = false
  private fetching = false
  private pollTimer: number | null = null
  private retryTimer: number | null = null
  private result: GexGridResult | null = null

  constructor(container: HTMLElement) {
    this.el = container

    const toolbar = el('div', { class: 'opt-toolbar' })
    this.underlyingSelect = el('select', { class: 'opt-select', title: 'Underlying' }) as HTMLSelectElement
    for (const u of SUPPORTED_OPTION_UNDERLYINGS) this.underlyingSelect.appendChild(el('option', { value: u }, UNDERLYING_LABEL[u]))
    this.underlyingSelect.addEventListener('change', () => {
      this.underlying = this.underlyingSelect.value as GexUnderlying
      this.result = null
      void this.refresh()
    })

    this.expirySelect = el('select', { class: 'opt-select', title: 'Timeframe (expiry) for the histogram' }) as HTMLSelectElement
    this.expirySelect.addEventListener('change', () => {
      this.viewExpiry = this.expirySelect.value === 'all' ? 'all' : Number(this.expirySelect.value)
      this.render()
    })

    this.nearInput = el('input', { type: 'number', class: 'opt-select gxd-near', min: '1', max: '20', value: '5', title: 'Near expiries' }) as HTMLInputElement
    this.nearInput.addEventListener('change', () => {
      this.nearExpiries = Math.max(1, Math.min(20, Number(this.nearInput.value) || 5))
      this.result = null
      void this.refresh()
    })

    this.spotLabel = el('span', { class: 'opt-spot' }, '—')
    this.statusEl = el('span', { class: 'opt-status' }, '')

    toolbar.append(
      this.underlyingSelect,
      el('span', { class: 'gxd-label' }, 'Timeframe'),
      this.expirySelect,
      el('span', { class: 'gxd-label' }, 'Near expiries'),
      this.nearInput,
      this.spotLabel,
      el('span', { class: 'foot-grow' }),
      this.statusEl,
    )

    this.body = el('div', { class: 'gxd-body' })
    this.el.append(toolbar, this.body)
  }

  async activate(): Promise<void> {
    this.active = true
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    await this.refresh()
    this.startPolling()
  }

  deactivate(): void {
    this.active = false
    this.stopPolling()
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = window.setInterval(() => void this.refresh(), REFRESH_MS)
  }
  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async refresh(): Promise<void> {
    if (!this.active || this.fetching) return
    this.fetching = true
    this.statusEl.textContent = 'loading…'
    try {
      const spot = await fetchSpot(this.underlying)
      this.spotLabel.textContent = `${UNDERLYING_LABEL[this.underlying]} ${spot.toFixed(0)}`
      const result = await computeGexGrid(this.underlying, spot, this.nearExpiries)
      this.result = result
      this.statusEl.textContent = result ? 'live' : 'no chain data'
      if (result && this.viewExpiry !== 'all' && !result.expiries.includes(this.viewExpiry)) this.viewExpiry = 'all'
      this.syncExpirySelect()
      this.render()
    } catch (err) {
      console.warn('[gexDashboard]', err)
      if (isRateLimited(err)) {
        this.statusEl.textContent = 'Delta rate-limited — retrying in 30s…'
        if (this.active) this.retryTimer = window.setTimeout(() => void this.refresh(), 30_000)
      } else {
        this.statusEl.textContent = 'Delta options unavailable'
      }
    } finally {
      this.fetching = false
    }
  }

  private syncExpirySelect(): void {
    const expiries = this.result?.expiries ?? []
    const wantValue = this.viewExpiry === 'all' ? 'all' : String(this.viewExpiry)
    const have = [...this.expirySelect.options].map((o) => o.value)
    const want = ['all', ...expiries.map(String)]
    if (have.join(',') === want.join(',')) {
      this.expirySelect.value = wantValue
      return
    }
    this.expirySelect.innerHTML = ''
    this.expirySelect.appendChild(el('option', { value: 'all' }, 'All (aggregated)'))
    for (const e of expiries) this.expirySelect.appendChild(el('option', { value: String(e) }, fmtExpiry(e)))
    this.expirySelect.value = wantValue
  }

  private render(): void {
    this.body.innerHTML = ''
    const r = this.result
    if (!r) {
      this.body.appendChild(el('div', { class: 'gxd-empty' }, this.statusEl.textContent || 'No data'))
      return
    }

    const strikesDesc = [...r.strikes].sort((a, b) => b - a)
    let maxAbs = 0
    for (const row of r.grid.values()) for (const v of row.values()) maxAbs = Math.max(maxAbs, Math.abs(v))

    const histByStrike = new Map<number, number>()
    for (const strike of r.strikes) {
      const row = r.grid.get(strike)
      if (!row) continue
      const v = this.viewExpiry === 'all' ? [...row.values()].reduce((s, x) => s + x, 0) : (row.get(this.viewExpiry) ?? 0)
      histByStrike.set(strike, v)
    }
    const maxHistAbs = Math.max(...[...histByStrike.values()].map(Math.abs), 1e-9)

    // The strike with the most positive / most negative net gamma in view: bright green / yellow bars.
    let peakPos: number | null = null
    let peakNeg: number | null = null
    for (const [strike, v] of histByStrike) {
      if (v > 0 && (peakPos === null || v > histByStrike.get(peakPos)!)) peakPos = strike
      if (v < 0 && (peakNeg === null || v < histByStrike.get(peakNeg)!)) peakNeg = strike
    }

    const table = el('table', { class: 'gxd-table' })
    const thead = el('thead', {})
    const headRow = el('tr', {})
    headRow.appendChild(el('th', { class: 'gxd-th-strike' }, 'STRIKE'))
    for (const e of r.expiries) headRow.appendChild(el('th', {}, fmtExpiry(e)))
    headRow.appendChild(el('th', { class: 'gxd-th-sep' }, ''))
    headRow.appendChild(
      el('th', { class: 'gxd-th-hist', colspan: '3' }, this.viewExpiry === 'all' ? 'ALL EXPIRIES' : fmtExpiry(this.viewExpiry)),
    )
    thead.appendChild(headRow)

    const tbody = el('tbody', {})
    for (const strike of strikesDesc) {
      const tr = el('tr', {})
      tr.appendChild(el('td', { class: 'gxd-td-strike' }, String(strike)))
      const row = r.grid.get(strike)
      for (const e of r.expiries) {
        const v = row?.get(e)
        const td = el('td', { class: 'gxd-cell' }, v === undefined ? '' : fmtGex(v))
        td.style.background = v === undefined ? 'transparent' : cellColor(v, maxAbs)
        tr.appendChild(td)
      }
      tr.appendChild(el('td', { class: 'gxd-td-sep' }, ''))

      // Diverging histogram: strike in the middle, negative (put) side grows
      // left, positive (call) side grows right — same layout as the reference.
      const histV = histByStrike.get(strike) ?? 0
      const pct = (Math.abs(histV) / maxHistAbs) * 100

      const negTd = el('td', { class: 'gxd-td-histneg' })
      if (histV < 0) {
        negTd.append(el('span', { class: 'gxd-bar-val' }, fmtGex(histV)), el('div', { class: `gxd-bar neg${strike === peakNeg ? ' peak-neg' : ''}`, style: `width:${pct.toFixed(1)}%` }))
      }
      tr.appendChild(negTd)

      tr.appendChild(el('td', { class: 'gxd-td-strike2' }, String(strike)))

      const posTd = el('td', { class: 'gxd-td-histpos' })
      if (histV > 0) {
        posTd.append(el('div', { class: `gxd-bar pos${strike === peakPos ? ' peak-pos' : ''}`, style: `width:${pct.toFixed(1)}%` }), el('span', { class: 'gxd-bar-val' }, fmtGex(histV)))
      }
      tr.appendChild(posTd)
      tbody.appendChild(tr)
    }

    const netRow = el('tr', { class: 'gxd-net' })
    netRow.appendChild(el('td', { class: 'gxd-td-strike' }, 'NET'))
    for (const e of r.expiries) netRow.appendChild(el('td', {}, fmtGex(r.netByExpiry.get(e) ?? 0)))
    netRow.appendChild(el('td', { class: 'gxd-td-sep' }, ''))
    const netHist = [...histByStrike.values()].reduce((s, v) => s + v, 0)
    netRow.appendChild(el('td', { colspan: '3' }, fmtGex(netHist)))
    tbody.appendChild(netRow)

    table.append(thead, tbody)
    this.body.appendChild(table)
  }
}
