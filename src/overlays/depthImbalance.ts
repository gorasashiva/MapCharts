// Order-book imbalance gauge — a LEADING signal, unlike everything else in
// this app (trade rain/poll/dominance/absorption all describe trades that
// already executed). Resting bid/ask liquidity reflects intent before it
// fills, so imbalance here often moves ahead of price.
// imbalance = (bidVol - askVol) / (bidVol + askVol) over the top-20 levels,
// range -1 (ask/sell-heavy) to +1 (bid/buy-heavy).
import type { DepthSnapshot } from '../data/types'

export interface DepthProvider {
  subscribeDepth(symbol: string, onDepth: (depth: DepthSnapshot) => void): () => void
}

export default class DepthImbalanceOverlay {
  private readonly root: HTMLElement
  private readonly barEl: HTMLElement
  private readonly pctEl: HTMLElement
  private readonly provider: DepthProvider
  private symbol = ''
  private enabled = false
  private imbalance = 0
  private unsub: (() => void) | null = null

  constructor(container: HTMLElement, provider: DepthProvider) {
    this.provider = provider
    this.root = document.createElement('div')
    this.root.className = 'dpi-widget'
    this.root.style.display = 'none'
    const track = document.createElement('div')
    track.className = 'dpi-track'
    this.barEl = document.createElement('div')
    this.barEl.className = 'dpi-bar'
    track.appendChild(this.barEl)
    this.pctEl = document.createElement('div')
    this.pctEl.className = 'dpi-pct'
    this.root.append(track, this.pctEl)
    container.appendChild(this.root)
  }

  setSymbol(symbol: string): void {
    this.symbol = symbol
    this.resubscribe()
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.root.style.display = on ? 'flex' : 'none'
    this.resubscribe()
  }

  /** Current imbalance, -1..+1. 0 while disabled/no data yet. */
  getImbalance(): number {
    return this.enabled ? this.imbalance : 0
  }

  destroy(): void {
    this.unsub?.()
    this.root.remove()
  }

  private resubscribe(): void {
    this.unsub?.()
    this.unsub = this.enabled && this.symbol ? this.provider.subscribeDepth(this.symbol, (d) => this.onDepth(d)) : null
  }

  private onDepth(d: DepthSnapshot): void {
    const bidVol = d.bids.reduce((s, [, q]) => s + q, 0)
    const askVol = d.asks.reduce((s, [, q]) => s + q, 0)
    const total = bidVol + askVol
    this.imbalance = total > 0 ? (bidVol - askVol) / total : 0
    const heightPct = Math.min(100, Math.abs(this.imbalance) * 100)
    this.barEl.style.height = `${heightPct}%`
    this.barEl.className = `dpi-bar ${this.imbalance >= 0 ? 'buy' : 'sell'}`
    this.pctEl.textContent = `${this.imbalance >= 0 ? '+' : ''}${Math.round(this.imbalance * 100)}%`
  }
}
