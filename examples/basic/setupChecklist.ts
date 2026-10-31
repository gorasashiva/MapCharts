// Setup Checklist — the Ninja GEX System's 4-part checklist (EMA Stack +
// GEX level + Flag pattern + Volume confirmation) collapsed into one glance,
// instead of checking 4 separate power tools by hand. Pure aggregation: it
// computes its own EMA stack + volume read from the candles it's already
// given, and reads the other two conditions off GexV2Overlay/FlagPatternsOverlay's
// own already-computed state (getEnvironment()/getLatestSignal()) — no new
// data source, no extra network calls, matching how GEX V2 itself reuses
// GEX's fetch instead of polling twice.
import type { Candle } from '../../src/index'
import { emaSeries } from '../../src/indicators/helpers'
import { attachFloatingWidget, type FloatingWidgetHandle } from '../../src/overlays/floatingWidget'
import type GexV2Overlay from './gexV2'
import type FlagPatternsOverlay from './flagPatterns'

export interface SetupChecklistOptions {
  enabled: boolean
}
const DEFAULTS: SetupChecklistOptions = { enabled: false }

type CheckState = 'yes' | 'no' | 'unknown'
interface ChecklistItem {
  label: string
  state: CheckState
  detail: string
}

const STATE_ICON: Record<CheckState, string> = { yes: '✓', no: '✕', unknown: '–' }
const STATE_COLOR: Record<CheckState, string> = { yes: '#0ecb81', no: '#f6465d', unknown: '#787b86' }

export default class SetupChecklistOverlay {
  private readonly root: HTMLElement
  private readonly scoreEl: HTMLElement
  private readonly listEl: HTMLElement
  private opts: SetupChecklistOptions
  private candles: Candle[] = []
  private gexV2: GexV2Overlay | null = null
  private flagPatterns: FlagPatternsOverlay | null = null
  private timer: number | null = null
  private readonly dock: FloatingWidgetHandle

  constructor(container: HTMLElement, opts?: Partial<SetupChecklistOptions>) {
    this.opts = { ...DEFAULTS, ...opts }

    this.root = document.createElement('div')
    this.root.className = 'sck-widget'
    this.root.style.display = this.opts.enabled ? 'flex' : 'none'

    const head = document.createElement('div')
    head.className = 'sck-head'
    head.textContent = 'SETUP CHECKLIST'
    this.scoreEl = document.createElement('div')
    this.scoreEl.className = 'sck-score'
    head.appendChild(this.scoreEl)

    this.listEl = document.createElement('div')
    this.listEl.className = 'sck-list'

    this.root.append(head, this.listEl)
    container.appendChild(this.root)
    this.dock = attachFloatingWidget(container, this.root, 'top-left')
  }

  /** References to the two tools this reads state from — see module doc comment. */
  setSources(gexV2: GexV2Overlay, flagPatterns: FlagPatternsOverlay): void {
    this.gexV2 = gexV2
    this.flagPatterns = flagPatterns
  }

  setCandles(candles: Candle[]): void {
    this.candles = candles
  }

  setOptions(opts: Partial<SetupChecklistOptions>): void {
    this.opts = { ...this.opts, ...opts }
  }
  getOptions(): SetupChecklistOptions {
    return { ...this.opts }
  }

  setEnabled(on: boolean): void {
    this.opts.enabled = on
    this.root.style.display = on ? 'flex' : 'none'
    this.dock.setVisible(on)
    if (on) this.start()
    else this.stop()
  }

  start(): void {
    if (this.timer !== null) return
    this.render()
    this.timer = window.setInterval(() => this.render(), 2000)
  }
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Re-stack (docked) or re-clamp (dragged away) after the container resizes. */
  resize(): void {
    this.dock.resize()
  }

  destroy(): void {
    this.stop()
    this.dock.destroy()
    this.root.remove()
  }

  /** Bullish stack: 9 above 21 above 50 and still rising. Bearish: mirrored. Neither: no clear trend. */
  private checkTrend(): ChecklistItem {
    const label = 'Trend lined up (EMA 9/21/50)'
    if (this.candles.length < 55) return { label, state: 'unknown', detail: 'Not enough history yet' }
    const closes = this.candles.map((c) => c.close)
    const n = closes.length
    const e9 = emaSeries(closes, 9)
    const e21 = emaSeries(closes, 21)
    const e50 = emaSeries(closes, 50)
    const a9 = e9[n - 1]
    const a21 = e21[n - 1]
    const a50 = e50[n - 1]
    const p9 = e9[n - 6]
    if (a9 == null || a21 == null || a50 == null || p9 == null) return { label, state: 'unknown', detail: 'Not enough history yet' }
    if (a9 > a21 && a21 > a50 && a9 > p9) return { label, state: 'yes', detail: 'Trending up — short-term average above the rest and rising' }
    if (a9 < a21 && a21 < a50 && a9 < p9) return { label, state: 'yes', detail: 'Trending down — short-term average below the rest and falling' }
    return { label, state: 'no', detail: 'No clear trend right now' }
  }

  /** Last candle's volume vs the recent average — matches the 1.5x confirmation bar used elsewhere (Deep Trades, Flag Patterns). */
  private checkVolume(): ChecklistItem {
    const label = 'Volume confirms it'
    const n = this.candles.length
    if (n < 21) return { label, state: 'unknown', detail: 'Not enough history yet' }
    const last = this.candles[n - 1].volume
    let sum = 0
    for (let i = n - 21; i < n - 1; i++) sum += this.candles[i].volume
    const avg = sum / 20
    const ratio = avg > 0 ? last / avg : 0
    return ratio >= 1.5
      ? { label, state: 'yes', detail: `${ratio.toFixed(1)}x the recent average` }
      : { label, state: 'no', detail: `${ratio.toFixed(1)}x the recent average — under 1.5x` }
  }

  private checkGex(): ChecklistItem {
    const label = 'Clear price level nearby (GEX)'
    if (!this.gexV2) return { label, state: 'unknown', detail: 'Turn on GEX V2 to check this' }
    const env = this.gexV2.getEnvironment()
    if (!env) return { label, state: 'unknown', detail: 'Waiting for GEX V2 data…' }
    if (env.env === 'mixed') return { label, state: 'no', detail: 'Market looks steady, but a risk level is close by' }
    return { label, state: 'yes', detail: env.env.includes('positive') ? 'Steady market' : 'Fast-moving market' }
  }

  private checkFlag(): ChecklistItem {
    const label = 'Flag pattern forming/confirmed'
    if (!this.flagPatterns) return { label, state: 'unknown', detail: 'Turn on Auto Flag Patterns to check this' }
    const sig = this.flagPatterns.getLatestSignal()
    if (!sig) return { label, state: 'no', detail: 'No recent flag pattern' }
    return {
      label,
      state: 'yes',
      detail: `${sig.bullish ? 'Bullish' : 'Bearish'} flag ${sig.confirmed ? '— breakout confirmed' : '— still forming'}`,
    }
  }

  private render(): void {
    const items = [this.checkTrend(), this.checkGex(), this.checkFlag(), this.checkVolume()]
    const yes = items.filter((i) => i.state === 'yes').length
    const known = items.filter((i) => i.state !== 'unknown').length
    this.scoreEl.textContent = known > 0 ? `${yes}/${known}` : '–'
    this.scoreEl.style.color = yes >= 3 ? '#0ecb81' : yes >= 2 ? '#ffc107' : '#787b86'

    this.listEl.innerHTML = ''
    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'sck-item'
      const top = document.createElement('div')
      top.className = 'sck-item-top'
      const icon = document.createElement('span')
      icon.className = 'sck-icon'
      icon.textContent = STATE_ICON[item.state]
      icon.style.color = STATE_COLOR[item.state]
      const label = document.createElement('span')
      label.className = 'sck-label'
      label.textContent = item.label
      top.append(icon, label)
      const detail = document.createElement('div')
      detail.className = 'sck-detail'
      detail.textContent = item.detail
      row.append(top, detail)
      this.listEl.appendChild(row)
    }
  }
}
