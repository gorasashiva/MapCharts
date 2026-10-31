// GEX V2 — a live "gamma environment" dashboard, modeled on the Ninja GEX
// System (ninjagex.com/system): a floating readout classifying the CURRENT
// dealer-positioning backdrop (Positive / Negative / Mixed / Full Positive /
// Full Negative gamma) plus its key levels, separate from GexOverlay (gex.ts)
// which plots Call Wall/Put Wall/Net GEX Crossover lines on the price chart itself.
// Both tools share the SAME computeGex() data — this is a second read of it,
// not a duplicate fetch.
//
// Ninja GEX vocabulary this implements:
//  - Positive Gamma Zone: dealers stabilize price (lower volatility).
//  - Negative Gamma Zone: dealers amplify moves (higher volatility,
//    "explosive breakouts").
//  - Mixed: backdrop is mostly one sign, but a same-side-relevant opposite
//    sign strike sits close to spot — a "trap door" level worth watching
//    before trading the backdrop's direction.
//  - Full Positive / Full Negative: virtually every strike agrees ("the
//    entire table is negative — no positive zones at all").
// The site's worked examples don't fully specify the exact thresholds, so
// the constants below are a documented, reasonable reading of them — not a
// literal transcription of an undisclosed formula.
import { computeGex, isGexUnderlying, type GexResult, type GexUnderlying } from './gex'
import { recordAndRank } from './ivRank'
import { observeGexSignal, type SignalDirection } from './gexValidation'
import { attachFloatingWidget, type FloatingWidgetHandle } from '../../src/overlays/floatingWidget'

export type GammaEnvironment = 'positive' | 'negative' | 'mixed' | 'full-positive' | 'full-negative'

export interface GexEnvironment {
  env: GammaEnvironment
  posShare: number // fraction of total unsigned GEX that's net positive (calls)
  negShare: number // fraction that's net negative (puts)
  criticalLevel: number | null // trap door (mixed) / target (full-negative) / flip (otherwise)
}

const FULL_SHARE_THRESHOLD = 0.05 // one side under 5% of total unsigned GEX == "the entire table" is the other sign
const TRAP_DOOR_BAND_PCT = 0.05 // fallback only when no ATM IV is available

export function classifyEnvironment(r: GexResult): GexEnvironment {
  const totalAbs = r.levels.reduce((s, l) => s + Math.abs(l.gex), 0) || 1
  const posShare = r.levels.filter((l) => l.gex > 0).reduce((s, l) => s + l.gex, 0) / totalAbs
  const negShare = r.levels.filter((l) => l.gex < 0).reduce((s, l) => s - l.gex, 0) / totalAbs

  if (negShare < FULL_SHARE_THRESHOLD) return { env: 'full-positive', posShare, negShare, criticalLevel: null }
  if (posShare < FULL_SHARE_THRESHOLD) return { env: 'full-negative', posShare, negShare, criticalLevel: r.putWall }

  // No crossover means the book never changes sign: the backdrop is total net GEX's sign.
  const positiveBackdrop = r.flipStrike === null ? r.totals.netGex >= 0 : r.spot >= r.flipStrike
  // A fixed 5% BTC band is far too broad in quiet markets. Use roughly 1.5
  // expected daily moves when ATM IV is available, with conservative bounds.
  const expectedDay = r.atmIV ? r.atmIV / Math.sqrt(365) : TRAP_DOOR_BAND_PCT
  const bandPct = Math.min(0.03, Math.max(0.005, expectedDay * 1.5))
  const band = r.spot * bandPct
  const trapDoor = r.levels
    .filter((l) => (positiveBackdrop ? l.gex < 0 : l.gex > 0) && Math.abs(l.strike - r.spot) <= band)
    .sort((a, b) => Math.abs(a.strike - r.spot) - Math.abs(b.strike - r.spot))[0]

  if (trapDoor) return { env: 'mixed', posShare, negShare, criticalLevel: trapDoor.strike }
  return { env: positiveBackdrop ? 'positive' : 'negative', posShare, negShare, criticalLevel: r.flipStrike }
}

export interface TradeIdea {
  direction: 'Buy Calls' | 'Buy Puts' | 'Avoid new premium'
  targetLabel: string // e.g. 'Call Wall', 'Net GEX Crossover', 'Trap Door' — '' when direction is 'Avoid new premium'
  targetLevel: number | null
  rationale: string
  /** 0-100 HEURISTIC score from how skewed the gamma backdrop is and how
   *  close price already sits to the target level — NOT a backtested win
   *  rate (this codebase has no trade-outcome history to derive one from).
   *  Capped well under 100 on purpose; treat as relative conviction, not a
   *  statistical probability. */
  confidence: number
}

/** A directional setup deliberately needs price confirmation in addition to
 * GEX. Gamma positioning can amplify or dampen a move, but cannot reveal
 * whether the next initiating order flow will be buyers or sellers. */
export interface DirectionalSetup {
  direction: SignalDirection | null
  state: 'confirmed' | 'waiting'
  score: number
  trigger: number | null
  rationale: string
}

/**
 * Produces a deliberately selective GEX directional setup.
 *
 * A trade direction is permitted only when price is beyond the relevant wall,
 * on the matching side of the net-GEX crossover, in a negative-gamma regime,
 * and has continued in that direction over the most recent five minutes. The
 * small buffer stops a one-tick touch of a wall being mistaken for a break.
 */
export function evaluateDirectionalSetup(
  r: GexResult,
  ge: GexEnvironment,
  momentum5mPct: number | null,
): DirectionalSetup {
  const expectedDay = r.atmIV ? r.atmIV / Math.sqrt(365) : 0.01
  const bufferPct = Math.min(0.006, Math.max(0.0015, expectedDay * 0.12))
  const momentumThreshold = Math.min(0.0035, Math.max(0.0008, expectedDay * 0.08))
  const negativeRegime = ge.env === 'negative' || ge.env === 'full-negative'
  const upBreak = r.callWall !== null && r.spot > r.callWall * (1 + bufferPct)
  const downBreak = r.putWall !== null && r.spot < r.putWall * (1 - bufferPct)
  const aboveCrossover = r.flipStrike === null || r.spot > r.flipStrike * (1 + bufferPct)
  const belowCrossover = r.flipStrike === null || r.spot < r.flipStrike * (1 - bufferPct)
  const upMomentum = momentum5mPct !== null && momentum5mPct >= momentumThreshold * 100
  const downMomentum = momentum5mPct !== null && momentum5mPct <= -momentumThreshold * 100
  const fmt = (v: number): string => v.toFixed(0)

  if (negativeRegime && upBreak && aboveCrossover && upMomentum) {
    return {
      direction: 'up', state: 'confirmed', trigger: r.callWall,
      score: 70,
      rationale: `Confirmed upside: price is above the ${fmt(r.callWall!)} call wall and crossover, with 5m momentum still positive. Negative gamma can amplify continuation.`,
    }
  }
  if (negativeRegime && downBreak && belowCrossover && downMomentum) {
    return {
      direction: 'down', state: 'confirmed', trigger: r.putWall,
      score: 70,
      rationale: `Confirmed downside: price is below the ${fmt(r.putWall!)} put wall and crossover, with 5m momentum still negative. Negative gamma can amplify continuation.`,
    }
  }

  const pendingLevel = r.callWall !== null && r.spot >= r.callWall * (1 - bufferPct)
    ? r.callWall
    : r.putWall !== null && r.spot <= r.putWall * (1 + bufferPct)
      ? r.putWall
      : r.flipStrike
  let rationale: string
  if (!negativeRegime) rationale = 'No directional setup: positive gamma tends to dampen moves. Treat the walls as range boundaries, not entries.'
  else if (momentum5mPct === null) rationale = 'No directional setup: waiting for a full five-minute price confirmation after a level break.'
  else rationale = 'No directional setup: wait for a buffered wall break, crossover alignment, and five-minute momentum in the same direction.'
  return { direction: null, state: 'waiting', score: 0, trigger: pendingLevel, rationale }
}

/** Rule-based trade-idea generator for OPTION BUYING (long premium) only —
 *  see the module doc comment. Every idea is anchored to a real computed
 *  level (wall/flip/trap door); confidence scales with (a) how lopsided
 *  posShare/negShare is — a cleaner regime read = more conviction in the
 *  behavior it implies — and (b) proximity of spot to the target level —
 *  a level 4%+ away is a "watch it" idea, not an actionable one right now. */
export function generateTradeIdeas(r: GexResult, ge: GexEnvironment): TradeIdea[] {
  const skew = Math.abs(ge.posShare - ge.negShare) // 0 = perfectly balanced, 1 = one-sided
  const proximity = (target: number | null): number => {
    if (target === null || target <= 0 || r.spot <= 0) return 0
    return Math.max(0, 1 - Math.abs(target - r.spot) / r.spot / 0.05)
  }
  const conf = (base: number, prox: number): number => Math.max(10, Math.min(85, Math.round(base + skew * 35 + prox * 25)))
  const fmt = (v: number): string => v.toFixed(0)

  const ideas: TradeIdea[] = []
  switch (ge.env) {
    case 'positive':
    case 'full-positive':
      if (r.callWall !== null)
        ideas.push({
          direction: 'Buy Calls',
          targetLabel: 'Resistance',
          targetLevel: r.callWall,
          rationale: `Price tends to stay in a range here. Only buy calls if price clearly breaks above ${fmt(r.callWall)} — that would signal more room to run higher.`,
          confidence: conf(15, proximity(r.callWall)),
        })
      if (r.putWall !== null)
        ideas.push({
          direction: 'Buy Puts',
          targetLabel: 'Support',
          targetLevel: r.putWall,
          rationale: `This looks like a steady, range-bound market — not the best setup for buying options. Only buy puts if price clearly breaks below ${fmt(r.putWall)}.`,
          confidence: conf(12, proximity(r.putWall)),
        })
      break
    case 'negative':
    case 'full-negative':
      if (r.putWall !== null)
        ideas.push({
          direction: 'Buy Puts',
          targetLabel: 'Support',
          targetLevel: r.putWall,
          rationale: `This market can move fast once it starts falling. While price stays below ${fmt(r.flipStrike ?? r.putWall)}, buying puts targets a move down toward ${fmt(r.putWall)}.`,
          confidence: conf(30, proximity(r.putWall)),
        })
      if (r.flipStrike !== null)
        ideas.push({
          direction: 'Buy Calls',
          targetLabel: 'Key Level',
          targetLevel: r.flipStrike,
          rationale: `If price climbs back above ${fmt(r.flipStrike)}, that flips the market to a calmer footing — buying calls targets a quick move higher off that reclaim.`,
          confidence: conf(25, proximity(r.flipStrike)),
        })
      break
    case 'mixed':
      if (ge.criticalLevel !== null)
        ideas.push({
          direction: 'Buy Puts',
          targetLabel: 'Risk Level',
          targetLevel: ge.criticalLevel,
          rationale: `Market looks steady for now, but there's a risk level at ${fmt(ge.criticalLevel)}. If price breaks below it, a fast drop becomes more likely — that's the trigger to buy puts.`,
          confidence: conf(28, proximity(ge.criticalLevel)),
        })
      ideas.push({
        direction: 'Avoid new premium',
        targetLabel: '',
        targetLevel: null,
        rationale: 'Price is still above the risk level, so the market looks steady for now — not a strong setup for buying options right now.',
        confidence: conf(10, 0),
      })
      break
  }
  return ideas.slice(0, 2)
}

const ENV_LABEL: Record<GammaEnvironment, string> = {
  positive: 'STEADY MARKET',
  'full-positive': 'VERY STEADY MARKET',
  negative: 'FAST-MOVING MARKET',
  'full-negative': 'VERY FAST-MOVING MARKET',
  mixed: 'MOSTLY STEADY — ONE RISK LEVEL',
}
const ENV_COLOR: Record<GammaEnvironment, string> = {
  positive: '#0ecb81',
  'full-positive': '#0ecb81',
  negative: '#f6465d',
  'full-negative': '#f6465d',
  mixed: '#ff9800',
}
const ENV_NOTE: Record<GammaEnvironment, string> = {
  positive: 'Price tends to stay in a range',
  'full-positive': 'Price tends to stay in a range',
  negative: 'Price can move fast in one direction',
  'full-negative': 'Price can move fast in one direction',
  mixed: 'Mostly steady, but watch the risk level below',
}

export interface GexV2Options {
  enabled: boolean
  refreshMs: number
  nearExpiries: number
}

const DEFAULTS: GexV2Options = { enabled: false, refreshMs: 90_000, nearExpiries: 6 }

export default class GexV2Overlay {
  private readonly root: HTMLElement
  private readonly badge: HTMLElement
  private readonly note: HTMLElement
  private readonly barPos: HTMLElement
  private readonly barNeg: HTMLElement
  private readonly rows: HTMLElement
  private readonly ivEl: HTMLElement
  private readonly ideas: HTMLElement
  private readonly statusEl: HTMLElement

  private opts: GexV2Options
  private symbol: GexUnderlying | null = null
  private spot = 0
  private spotHistory: Array<{ at: number; price: number }> = []
  private lastEnv: GexEnvironment | null = null
  private fetching = false
  private pollTimer: number | null = null
  // Set true while GEX (v1) is also enabled: pane.ts feeds this overlay v1's
  // fetched result via applyResult() instead, so the two never show
  // different snapshots of the same options chain and Delta doesn't get
  // polled twice as often. Falls back to fetching independently — this is
  // still a fully standalone tool when v1 is off.
  private drivenExternally = false
  private readonly dock: FloatingWidgetHandle

  constructor(container: HTMLElement, opts?: Partial<GexV2Options>) {
    this.opts = { ...DEFAULTS, ...opts }

    this.root = document.createElement('div')
    this.root.className = 'gv2-widget'
    this.root.style.display = 'none'

    const head = document.createElement('div')
    head.className = 'gv2-head'
    this.badge = document.createElement('div')
    this.badge.className = 'gv2-badge'
    this.badge.textContent = 'GEX V2'
    head.appendChild(this.badge)

    this.note = document.createElement('div')
    this.note.className = 'gv2-note'

    const bar = document.createElement('div')
    bar.className = 'gv2-bar'
    this.barPos = document.createElement('div')
    this.barPos.className = 'gv2-bar-pos'
    this.barNeg = document.createElement('div')
    this.barNeg.className = 'gv2-bar-neg'
    bar.append(this.barPos, this.barNeg)

    this.rows = document.createElement('div')
    this.rows.className = 'gv2-rows'

    this.ivEl = document.createElement('div')
    this.ivEl.className = 'gv2-iv'

    this.ideas = document.createElement('div')
    this.ideas.className = 'gv2-ideas'

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'gv2-status'
    this.statusEl.textContent = 'loading…'

    this.root.append(head, this.note, bar, this.rows, this.ivEl, this.ideas, this.statusEl)
    container.appendChild(this.root)
    this.dock = attachFloatingWidget(container, this.root, 'top-right')
  }

  /** Re-stack (docked) or re-clamp (dragged away) after the container resizes. */
  resize(): void {
    this.dock.resize()
  }

  setOptions(opts: Partial<GexV2Options>): void {
    const refreshChanged = opts.refreshMs !== undefined && opts.refreshMs !== this.opts.refreshMs
    const expiriesChanged = opts.nearExpiries !== undefined && opts.nearExpiries !== this.opts.nearExpiries
    this.opts = { ...this.opts, ...opts }
    if (refreshChanged && this.pollTimer !== null) this.restartPolling()
    if (expiriesChanged) void this.fetchNow()
  }

  getOptions(): GexV2Options {
    return { ...this.opts }
  }

  /** Applies to an options underlying's perpetual (BTCUSD/ETHUSD/XAUTUSD) — anything else is a no-op. */
  setSymbol(symbol: string): void {
    const next = isGexUnderlying(symbol) ? symbol : null
    if (next === this.symbol) return
    this.symbol = next
    this.spotHistory = [] // never carry a confirmation window across symbols
    this.spot = 0 // the old symbol's price must not scale the new chain — fetch on the next setSpot()
  }

  setSpot(price: number): void {
    if (!Number.isFinite(price) || price <= 0) return
    const first = this.spot <= 0
    this.spot = price
    if (first && this.opts.enabled) void this.fetchNow()
    const now = Date.now()
    const last = this.spotHistory[this.spotHistory.length - 1]
    // Keep the latest live price, while retaining enough observations for a
    // five-minute confirmation window. Update-in-place limits noisy feeds.
    if (last && now - last.at < 1_000) last.price = price
    else this.spotHistory.push({ at: now, price })
    const keepAfter = now - 20 * 60_000
    this.spotHistory = this.spotHistory.filter((sample) => sample.at >= keepAfter)
  }

  setEnabled(on: boolean): void {
    this.opts.enabled = on
    this.root.style.display = on ? 'flex' : 'none'
    this.dock.setVisible(on)
    if (on && !this.drivenExternally) {
      void this.fetchNow()
      this.startPolling()
    } else if (!on) {
      this.stopPolling()
    }
  }

  /** See drivenExternally above — called by pane.ts whenever GEX (v1)'s own
   *  enabled state changes. */
  setDrivenExternally(driven: boolean): void {
    if (driven === this.drivenExternally) return
    this.drivenExternally = driven
    if (driven) {
      this.stopPolling() // v1's onResult feed will call applyResult() from here on
    } else if (this.opts.enabled) {
      void this.fetchNow()
      this.startPolling()
    }
  }

  /** Repaint with a result fetched elsewhere (see drivenExternally) instead of fetching our own. */
  applyResult(result: GexResult | null): void {
    if (!this.opts.enabled) return
    if (result) {
      this.render(result)
      this.statusEl.textContent = 'live (via GEX)'
    } else {
      this.statusEl.textContent = 'no chain data'
    }
  }

  destroy(): void {
    this.stopPolling()
    this.dock.destroy()
    this.root.remove()
  }

  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = window.setInterval(() => void this.fetchNow(), this.opts.refreshMs)
  }
  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
  private restartPolling(): void {
    if (this.opts.enabled) this.startPolling()
  }

  private async fetchNow(): Promise<void> {
    if (!this.opts.enabled || !this.symbol || this.spot <= 0 || this.fetching || this.drivenExternally) return
    this.fetching = true
    this.statusEl.textContent = 'loading…'
    try {
      const result = await computeGex(this.symbol, this.spot, this.opts.nearExpiries)
      if (result) {
        this.render(result)
        this.statusEl.textContent = 'live'
      } else {
        this.statusEl.textContent = 'no chain data'
      }
    } catch (err) {
      this.statusEl.textContent = /HTTP 4(18|29)/.test(String(err)) ? 'rate-limited' : 'unavailable'
      console.warn('[gexV2]', err)
    } finally {
      this.fetching = false
    }
  }

  /** Last computed environment, for other tools (Setup Checklist) to reuse without a fetch of their own. */
  getEnvironment(): GexEnvironment | null {
    return this.lastEnv
  }

  private momentum5mPct(): number | null {
    if (this.spotHistory.length < 2 || this.spot <= 0) return null
    const target = Date.now() - 5 * 60_000
    let reference: { at: number; price: number } | null = null
    for (let i = this.spotHistory.length - 1; i >= 0; i--) {
      if (this.spotHistory[i].at <= target) {
        reference = this.spotHistory[i]
        break
      }
    }
    return reference && reference.price > 0 ? ((this.spot - reference.price) / reference.price) * 100 : null
  }

  private render(r: GexResult): void {
    const ge = classifyEnvironment(r)
    this.lastEnv = ge
    const { env, posShare, negShare } = ge
    this.badge.textContent = ENV_LABEL[env]
    this.badge.style.background = ENV_COLOR[env]
    this.note.textContent = ENV_NOTE[env]
    this.barPos.style.width = `${Math.round(posShare * 100)}%`
    this.barNeg.style.width = `${Math.round(negShare * 100)}%`

    const fmt = (v: number | null): string => (v === null ? '—' : v.toFixed(0))
    this.rows.innerHTML = ''
    const addRow = (label: string, value: string, color: string): void => {
      const row = document.createElement('div')
      row.className = 'gv2-row'
      row.append(el('span', label), el('span', value, color))
      this.rows.appendChild(row)
    }
    const el = (tag: 'span', text: string, color?: string): HTMLElement => {
      const s = document.createElement(tag)
      s.textContent = text
      if (color) s.style.color = color
      return s
    }
    addRow('Call wall', fmt(r.callWall), '#f6465d')
    addRow('Put wall', fmt(r.putWall), '#0ecb81')
    addRow('Crossover', fmt(r.flipStrike), '#ffc107')
    const dte = r.quality.nearestDteDays === null ? '—' : `${r.quality.nearestDteDays.toFixed(1)}d`
    addRow('Chain', `${(r.quality.quotedShare * 100).toFixed(0)}% quoted · ${dte}`, r.quality.quotedShare >= 0.5 ? '#0ecb81' : '#ff9800')

    this.ivEl.innerHTML = ''
    if (r.atmIV !== null) {
      const ivr = recordAndRank(this.symbol ?? 'BTCUSD', r.atmIV)
      const cheap = ivr.percentile < 30
      const expensive = ivr.percentile > 70
      const tag = cheap ? 'CHEAP' : expensive ? 'EXPENSIVE' : 'FAIR'
      const color = cheap ? '#0ecb81' : expensive ? '#f6465d' : '#ffc107'
      const line1 = document.createElement('div')
      line1.className = 'gv2-iv-line'
      line1.append(
        el('span', `Options price (IV): ${(ivr.currentIV * 100).toFixed(0)}%`, '#d1d4dc'),
        el('span', `${tag} · ${ivr.percentile}%`, color),
      )
      const line2 = document.createElement('div')
      line2.className = 'gv2-iv-sub'
      line2.textContent = ivr.sufficient
        ? `Cheaper than ${ivr.percentile}% of the last ${Math.round(ivr.daysCovered)} days seen`
        : `Still learning this market — only ${ivr.sampleCount} readings over ${ivr.daysCovered.toFixed(1)} days so far`
      this.ivEl.append(line1, line2)
    }

    const qualityGood = r.quality.contractCount >= 20 && r.quality.quotedShare >= 0.5
    const setup = qualityGood
      ? evaluateDirectionalSetup(r, ge, this.momentum5mPct())
      : { direction: null, state: 'waiting' as const, score: 0, trigger: null, rationale: 'No directional setup: too few liquid option quotes in this snapshot. Levels remain visible for research only.' }
    const validation = observeGexSignal(this.symbol ?? 'BTCUSD', r.spot, setup.direction, setup.score)

    this.ideas.innerHTML = ''
    const head = document.createElement('div')
    head.className = 'gv2-ideas-head'
    head.textContent = validation.validated
      ? `SETUP IDEAS · ${validation.hitRate!.toFixed(0)}% observed 1h direction hit rate (${validation.matured} samples)`
      : `SETUP IDEAS · PROSPECTIVE VALIDATION ${validation.matured}/100 OBSERVATIONS`
    this.ideas.appendChild(head)
    const card = document.createElement('div')
    card.className = 'gv2-idea'
    const top = document.createElement('div')
    top.className = 'gv2-idea-top'
    const dirColor = setup.direction === 'up' ? '#0ecb81' : setup.direction === 'down' ? '#f6465d' : '#787b86'
    const dirText = setup.direction === 'up'
      ? `UPSIDE CONFIRMED → above ${fmt(setup.trigger)}`
      : setup.direction === 'down'
        ? `DOWNSIDE CONFIRMED → below ${fmt(setup.trigger)}`
        : 'NO TRADE · WAIT FOR CONFIRMATION'
    const dir = el('span', dirText, dirColor)
    dir.className = 'gv2-idea-dir'
    const score = el('span', setup.direction ? `${setup.score} score` : 'gated', dirColor)
    score.className = 'gv2-idea-conf'
    top.append(dir, score)
    const why = document.createElement('div')
    why.className = 'gv2-idea-why'
    why.textContent = setup.rationale
    card.append(top, why)
    this.ideas.appendChild(card)
  }
}
