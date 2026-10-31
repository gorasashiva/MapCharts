// Trade Buddy side panel: polls every timeframe of the active symbol on its own
// cadence, runs the rule-based scanner (src/buddy/analysis.ts), shows the
// market read + idea cards, fires alerts for fresh ideas, and lets Claude
// explain ideas / answer questions grounded in the same live briefing.
import type { Candle } from '../../src/core/types'
import type { BuddyLevels } from '../../src/overlays/buddyLevels'
import { BUDDY_TFS, TF_LIMIT, briefing, buildContext, istClock, scanIdeas, type BuddyTf, type CandlesByTf, type IdeaGrade, type MarketContext, type TradeIdea } from '../../src/buddy/analysis'
import { zoneHeadline } from '../../src/overlays/profileZones'
import { ensureNotificationPermission } from '../../src/alerts/notify'
import { playTune } from '../../src/alerts/tunes'
import { BUDDY_MODELS, BuddyClaude, describeError, type BuddyModelId } from './buddyClaude'
import { el, ICONS } from './ui'

export interface BuddyHost {
  fetchCandles(symbol: string, tf: BuddyTf, limit: number): Promise<Candle[]>
  getSymbol(): string | null
  showLevels(levels: BuddyLevels | null): void
}

/** How often each timeframe is refetched. Fast TFs drive the scanner. */
const REFRESH_MS: Record<BuddyTf, number> = { '1m': 30e3, '3m': 30e3, '5m': 30e3, '15m': 120e3, '1h': 120e3, '4h': 600e3, '1d': 600e3 }
const TICK_MS = 5_000
const GRADE_RANK: Record<IdeaGrade, number> = { A: 3, B: 2, C: 1 }

interface Settings {
  model: BuddyModelId
  autoExplain: boolean
  alerts: boolean
  minAlertGrade: IdeaGrade
  /** Experimental volume-profile zone setups (not backtested). */
  zoneSetups: boolean
}
const DEFAULT_SETTINGS: Settings = { model: 'opus', autoExplain: false, alerts: true, minAlertGrade: 'B', zoneSetups: true }
const LS_SETTINGS = 'candl.buddy.settings'
/** Left over from the API-key version; removed on load so no key lingers. */
const LS_LEGACY_KEY = 'candl.buddy.apiKey'

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* storage unavailable (private mode): settings just won't persist */
  }
}

type Tab = 'ideas' | 'chat' | 'settings'

export class TradeBuddy {
  readonly root: HTMLElement
  private readonly host: BuddyHost
  private readonly claude = new BuddyClaude()
  private settings: Settings
  private enabled = false
  private timer = 0
  private busy = false

  private symbol = ''
  private data: CandlesByTf = {}
  private fetchedAt: Partial<Record<BuddyTf, number>> = {}
  private ctx: MarketContext | null = null
  private ideas: TradeIdea[] = []
  private seen = new Set<string>()
  private firstScan = true
  private explanations = new Map<string, string>()
  private explaining = new Set<string>()
  private selected: string | null = null
  private lastError = ''
  private tab: Tab = 'ideas'

  private readonly statusEl: HTMLElement
  private readonly tabsEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly chatLog: HTMLElement
  private readonly chatInput: HTMLTextAreaElement
  private chatBusy = false

  constructor(host: BuddyHost) {
    this.host = host
    let saved: Partial<Settings> = {}
    try {
      saved = JSON.parse(lsGet(LS_SETTINGS) ?? '{}')
    } catch {
      saved = {}
    }
    this.settings = { ...DEFAULT_SETTINGS, ...saved }
    if (!BUDDY_MODELS.some((m) => m.id === this.settings.model)) this.settings.model = DEFAULT_SETTINGS.model
    this.claude.model = this.settings.model
    lsSet(LS_LEGACY_KEY, null)
    void this.claude.checkBridge().then(() => this.render())

    this.root = el('div', { class: 'buddy' })
    const head = el('div', { class: 'buddy-head' })
    head.append(el('span', { class: 'buddy-title' }, 'Trade Buddy'))
    this.statusEl = el('span', { class: 'buddy-status' }, 'idle')
    head.append(this.statusEl)
    this.tabsEl = el('div', { class: 'buddy-tabs' })
    this.bodyEl = el('div', { class: 'buddy-body' })
    this.chatLog = el('div', { class: 'buddy-chat-log' })
    this.chatInput = el('textarea', { class: 'buddy-chat-input', rows: '2', placeholder: 'Ask about this chart…' }) as HTMLTextAreaElement
    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void this.sendChat(this.chatInput.value)
      }
    })
    this.root.append(head, this.tabsEl, this.bodyEl)
    this.renderTabs()
    this.render()
  }

  /** Start/stop scanning (tied to the panel being open). */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      void this.tick()
      this.timer = window.setInterval(() => void this.tick(), TICK_MS)
    } else {
      window.clearInterval(this.timer)
      this.timer = 0
      this.host.showLevels(null)
      this.selected = null
    }
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.busy || !this.enabled) return
    const symbol = this.host.getSymbol()
    if (!symbol) return
    if (symbol !== this.symbol) this.resetFor(symbol)
    const now = Date.now()
    const due = BUDDY_TFS.filter((tf) => now - (this.fetchedAt[tf] ?? 0) >= REFRESH_MS[tf])
    if (!due.length) return
    this.busy = true
    this.setStatus('scanning…')
    try {
      const results = await Promise.allSettled(due.map((tf) => this.host.fetchCandles(symbol, tf, TF_LIMIT[tf])))
      if (symbol !== this.symbol) return // symbol switched mid-fetch
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.length) {
          this.data[due[i]] = r.value
          this.fetchedAt[due[i]] = now
        }
      })
      const failed = results.filter((r) => r.status === 'rejected').length
      this.lastError = failed ? `${failed} timeframe fetch${failed > 1 ? 'es' : ''} failed; retrying` : ''
      this.ctx = buildContext(symbol, this.data, Date.now())
      this.ideas = this.ctx ? scanIdeas(this.ctx, this.data, { zoneSetups: this.settings.zoneSetups }) : []
      this.handleNewIdeas()
      this.setStatus(`live · ${istClock(Date.now())}`)
    } catch (e) {
      this.lastError = describeError(e)
      this.setStatus('error')
    } finally {
      this.busy = false
      if (this.tab === 'ideas') this.render()
    }
  }

  private resetFor(symbol: string): void {
    this.symbol = symbol
    this.data = {}
    this.fetchedAt = {}
    this.ctx = null
    this.ideas = []
    this.seen.clear()
    this.firstScan = true
    this.explanations.clear()
    this.selected = null
    this.host.showLevels(null)
    this.claude.resetChat()
    this.chatLog.replaceChildren()
  }

  private handleNewIdeas(): void {
    for (const idea of this.ideas) {
      if (this.seen.has(idea.id)) continue
      this.seen.add(idea.id)
      // Ideas already in progress when the panel opens are shown, not alerted.
      if (this.firstScan || idea.status !== 'fresh') continue
      if (this.settings.alerts && GRADE_RANK[idea.grade] >= GRADE_RANK[this.settings.minAlertGrade]) this.alert(idea)
      if (this.settings.autoExplain && this.claude.ready) void this.explain(idea)
    }
    this.firstScan = false
  }

  private alert(idea: TradeIdea): void {
    const body = `${idea.grade} · ${idea.side.toUpperCase()} ${idea.title} @ ${idea.entry.toFixed(2)} · stop ${idea.stop.toFixed(2)}`
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(`Trade Buddy · ${this.symbol}`, { body, tag: idea.id })
    } catch {
      /* notifications unavailable — the panel card and sound still fire */
    }
    playTune(0, 2)
    const toast = el('div', { class: 'buddy-toast' })
    toast.textContent = `New idea: ${body}`
    this.root.append(toast)
    window.setTimeout(() => toast.remove(), 8000)
  }

  // ---------------------------------------------------------------------------
  // Claude
  // ---------------------------------------------------------------------------

  private async explain(idea: TradeIdea): Promise<void> {
    if (!this.ctx || this.explaining.has(idea.id)) return
    this.explaining.add(idea.id)
    this.explanations.set(idea.id, '…')
    this.render()
    try {
      const text = await this.claude.explain(briefing(this.ctx, this.ideas), `${idea.title} (${idea.side}) triggered ${istClock(idea.triggeredAt)}`, (snap) => {
        this.explanations.set(idea.id, snap)
        this.updateExplanation(idea.id)
      })
      this.explanations.set(idea.id, text)
    } catch (e) {
      this.explanations.set(idea.id, `⚠ ${describeError(e)}`)
    } finally {
      this.explaining.delete(idea.id)
      this.render()
    }
  }

  private updateExplanation(id: string): void {
    const node = this.bodyEl.querySelector<HTMLElement>(`[data-explain="${CSS.escape(id)}"]`)
    if (node) node.textContent = this.explanations.get(id) ?? ''
  }

  private async sendChat(question: string): Promise<void> {
    const q = question.trim()
    if (!q || this.chatBusy) return
    if (!this.claude.ready && !(await this.claude.checkBridge())) {
      this.appendChat('buddy', this.claude.status)
      return
    }
    if (!this.ctx) {
      this.appendChat('buddy', 'Still loading chart data; try again in a few seconds.')
      return
    }
    this.chatBusy = true
    this.chatInput.value = ''
    this.appendChat('you', q)
    const reply = this.appendChat('buddy', '…')
    try {
      const text = await this.claude.ask(briefing(this.ctx, this.ideas), q, (snap) => {
        reply.textContent = snap
        this.chatLog.scrollTop = this.chatLog.scrollHeight
      })
      reply.textContent = text
    } catch (e) {
      reply.textContent = `⚠ ${describeError(e)}`
    } finally {
      this.chatBusy = false
    }
  }

  private appendChat(who: 'you' | 'buddy', text: string): HTMLElement {
    const msg = el('div', { class: `buddy-msg buddy-msg-${who}` })
    msg.textContent = text
    this.chatLog.append(msg)
    this.chatLog.scrollTop = this.chatLog.scrollHeight
    return msg
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private setStatus(text: string): void {
    this.statusEl.textContent = text
  }

  private renderTabs(): void {
    this.tabsEl.replaceChildren()
    for (const [id, label] of [['ideas', 'Ideas'], ['chat', 'Chat'], ['settings', 'Settings']] as [Tab, string][]) {
      const b = el('button', { class: `buddy-tab${this.tab === id ? ' active' : ''}` }, label)
      b.addEventListener('click', () => {
        this.tab = id
        this.renderTabs()
        this.render()
      })
      this.tabsEl.append(b)
    }
  }

  private render(): void {
    if (this.tab === 'ideas') this.renderIdeas()
    else if (this.tab === 'chat') this.renderChat()
    else this.renderSettings()
  }

  private renderIdeas(): void {
    const frag = document.createDocumentFragment()
    if (this.lastError) frag.append(textEl('div', 'buddy-error', this.lastError))
    const c = this.ctx
    if (!c) {
      frag.append(textEl('div', 'buddy-empty', this.enabled ? 'Loading all timeframes…' : 'Open the panel to start scanning.'))
      this.bodyEl.replaceChildren(frag)
      return
    }
    // ---- market read ----
    const read = el('div', { class: 'buddy-card' })
    read.append(textEl('div', 'buddy-card-title', `${c.symbol} · ${c.price.toFixed(2)} · ${istClock(c.now)}`))
    const chips = el('div', { class: 'buddy-chips' })
    for (const t of c.tfs) {
      const chip = textEl('span', `buddy-chip ${t.trend}`, `${t.tf} ${t.trend === 'up' ? '▲' : t.trend === 'down' ? '▼' : '•'}`)
      chip.title = `${t.tf}: Supertrend ${t.trend} (line ${t.stValue.toFixed(2)})${t.vwap !== null ? `, ${t.close >= t.vwap ? 'above' : 'below'} VWAP ${t.vwap.toFixed(2)}` : ''}`
      chips.append(chip)
    }
    read.append(chips)
    const s = c.session
    if (s) {
      const width = s.ibAvg20 === null ? '' : ` · ${s.ibWide ? 'WIDE' : 'narrow'} vs avg ${s.ibAvg20.toFixed(1)}`
      read.append(textEl('div', 'buddy-line', `IB ${s.ibDone ? '' : '(forming) '}${s.ibLow.toFixed(2)}–${s.ibHigh.toFixed(2)} · ${s.ibWidth.toFixed(1)} pts${width}`))
    }
    // Nearest zone above, the one price is in, and nearest below — with role, dominance and strength.
    const above = c.zones.filter((z) => z.lo > c.price).sort((a, b) => a.lo - b.lo)[0]
    const below = c.zones.filter((z) => z.hi < c.price).sort((a, b) => b.hi - a.hi)[0]
    const inPlay = c.zones.find((z) => z.kind === 'inplay')
    for (const z of [above, inPlay, below]) {
      if (!z) continue
      const cls = z.kind === 'demand' ? 'good' : z.kind === 'supply' ? 'warn' : ''
      read.append(textEl('div', `buddy-line ${cls}`, `${zoneHeadline(z.kind, z.lo, z.hi, c.price, z.buyPct)} ${z.lo.toFixed(2)}–${z.hi.toFixed(2)} · ${z.strength} ${z.score}`))
    }
    const t = c.timing
    const timing = t.weekend ? '⚠ Weekend: historically poor, trade light or not at all' : t.badHour ? `⚠ ${t.istHour}:00 IST is a historically poor hour` : t.mainWindow ? '✓ Main window (05:30–08:59 IST)' : ''
    if (timing) read.append(textEl('div', `buddy-line ${t.weekend || t.badHour ? 'warn' : 'good'}`, timing))
    frag.append(read)

    // ---- ideas ----
    if (!this.ideas.length) {
      frag.append(textEl('div', 'buddy-empty', `No setup right now. Watching for: IB breakout (07:30–10:30 IST on wide-IB days), the FVG + Supertrend 1h hybrid${this.settings.zoneSetups ? ', and experimental zone breakouts/bounces (after 07:30 IST)' : ''}.`))
    }
    for (const idea of this.ideas) frag.append(this.ideaCard(idea))
    if (this.claude.available === false) frag.append(textEl('div', 'buddy-hint', this.claude.status))
    this.bodyEl.replaceChildren(frag)
  }

  private ideaCard(idea: TradeIdea): HTMLElement {
    const card = el('div', { class: `buddy-card idea ${idea.side}${this.selected === idea.id ? ' selected' : ''}` })
    const top = el('div', { class: 'buddy-idea-top' })
    top.append(
      textEl('span', `buddy-side ${idea.side}`, idea.side === 'long' ? 'LONG' : 'SHORT'),
      textEl('span', 'buddy-idea-title', idea.title),
      textEl('span', `buddy-grade g${idea.grade}`, idea.grade),
    )
    if (!idea.validated) {
      const badge = textEl('span', 'buddy-exp', 'EXPERIMENTAL')
      badge.title = 'Not backtested: a heuristic from volume-profile principles. Size small.'
      top.insertBefore(badge, top.lastChild)
    }
    card.append(top)
    card.append(textEl('div', 'buddy-meta', `${idea.tf} · ${idea.status === 'fresh' ? 'NEW' : 'active'} since ${istClock(idea.triggeredAt)}`))
    const lv = el('div', { class: 'buddy-levels' })
    const cell = (k: string, v: number, cls = ''): void => {
      const d = el('div', { class: `buddy-level ${cls}` })
      d.append(textEl('span', 'k', k), textEl('span', 'v', v.toFixed(2)))
      lv.append(d)
    }
    cell('Entry', idea.entry)
    cell(idea.setup === 'fvg-st-hybrid' ? 'Stop (1h ST)' : 'Stop', idea.stop, 'stop')
    idea.targets.forEach((tg, i) => cell(`T${i + 1}`, tg, 'target'))
    card.append(lv)
    card.append(textEl('div', 'buddy-exit', idea.exitRule))
    const ul = el('ul', { class: 'buddy-points' })
    for (const r of idea.reasons) ul.append(textEl('li', 'ok', r))
    for (const w of idea.cautions) ul.append(textEl('li', 'warn', w))
    card.append(ul)
    card.append(textEl('div', 'buddy-evidence', idea.evidence))
    const actions = el('div', { class: 'buddy-actions' })
    const show = el('button', { class: 'buddy-btn' }, this.selected === idea.id ? 'Hide from chart' : 'Show on chart')
    show.addEventListener('click', () => {
      this.selected = this.selected === idea.id ? null : idea.id
      this.host.showLevels(this.selected ? { side: idea.side, from: idea.triggeredAt, entry: idea.entry, stop: idea.stop, targets: idea.targets } : null)
      this.render()
    })
    const ask = el('button', { class: 'buddy-btn primary' }, this.explaining.has(idea.id) ? 'Thinking…' : 'Explain with Claude')
    ask.toggleAttribute('disabled', !this.claude.ready || this.explaining.has(idea.id))
    ask.addEventListener('click', () => void this.explain(idea))
    actions.append(show, ask)
    card.append(actions)
    if (this.explanations.has(idea.id)) {
      const ex = textEl('div', 'buddy-explain', this.explanations.get(idea.id) ?? '')
      ex.dataset.explain = idea.id
      card.append(ex)
    }
    return card
  }

  private renderChat(): void {
    const wrap = el('div', { class: 'buddy-chat' })
    if (!this.chatLog.childElementCount) {
      this.chatLog.append(textEl('div', 'buddy-hint', 'Ask anything about the live chart. Claude sees every timeframe, the IB, SVP zones and the scanner’s ideas.'))
    }
    const quick = el('div', { class: 'buddy-quick' })
    for (const q of ['What is the bias across timeframes?', 'Is anything worth taking right now?', 'Where are the key levels today?']) {
      const b = textEl('button', 'buddy-chip-btn', q)
      b.addEventListener('click', () => void this.sendChat(q))
      quick.append(b)
    }
    const send = el('button', { class: 'buddy-btn primary' }, 'Send')
    send.addEventListener('click', () => void this.sendChat(this.chatInput.value))
    const row = el('div', { class: 'buddy-chat-row' })
    row.append(this.chatInput, send)
    wrap.append(this.chatLog, quick, row)
    this.bodyEl.replaceChildren(wrap)
  }

  private renderSettings(): void {
    const f = el('div', { class: 'buddy-settings' })
    f.append(textEl('div', 'buddy-card-title', 'Claude Code'))
    const statusRow = el('div', { class: 'buddy-chat-row' })
    const recheck = el('button', { class: 'buddy-btn' }, 'Recheck')
    recheck.addEventListener('click', () => void this.claude.checkBridge().then(() => this.render()))
    statusRow.append(textEl('div', `buddy-line ${this.claude.ready ? 'good' : 'warn'}`, this.claude.status), recheck)
    f.append(statusRow)
    f.append(textEl('div', 'buddy-hint', 'Answers come from the Claude Code CLI on this machine (your Claude Code login, no API key). It runs with no tools, only while the local dev server is up.'))

    const model = el('select', { class: 'buddy-input' }) as HTMLSelectElement
    for (const m of BUDDY_MODELS) {
      const o = el('option', { value: m.id }, m.label) as HTMLOptionElement
      o.selected = m.id === this.settings.model
      model.append(o)
    }
    model.addEventListener('change', () => this.update({ model: model.value as BuddyModelId }))
    f.append(labelled('Model', model))
    f.append(this.check('Explain new ideas automatically (one Claude Code run per new idea)', this.settings.autoExplain, (v) => this.update({ autoExplain: v })))
    const u = this.claude.usage
    f.append(textEl('div', 'buddy-hint', `This session: ${u.requests} Claude Code run${u.requests === 1 ? '' : 's'} (≈ $${u.costUsd.toFixed(3)} equivalent, counted against your Claude plan)`))

    f.append(textEl('div', 'buddy-card-title', 'Setups'))
    f.append(this.check('Volume-profile zone setups (experimental, not backtested; graded B at most)', this.settings.zoneSetups, (v) => {
      this.update({ zoneSetups: v })
      this.fetchedAt = {} // rescan now with the new setting
    }))

    f.append(textEl('div', 'buddy-card-title', 'Alerts'))
    f.append(this.check('Pop-up + sound when a new idea fires', this.settings.alerts, (v) => {
      this.update({ alerts: v })
      if (v) void ensureNotificationPermission()
    }))
    const grade = el('select', { class: 'buddy-input' }) as HTMLSelectElement
    for (const [g, label] of [['A', 'A only'], ['B', 'A and B'], ['C', 'All (A, B, C)']] as [IdeaGrade, string][]) {
      const o = el('option', { value: g }, label) as HTMLOptionElement
      o.selected = g === this.settings.minAlertGrade
      grade.append(o)
    }
    grade.addEventListener('change', () => this.update({ minAlertGrade: grade.value as IdeaGrade }))
    f.append(labelled('Alert on grades', grade))
    f.append(textEl('div', 'buddy-hint', 'Scans 1m/3m/5m every 30s, 15m/1h every 2 min, 4h/1d every 10 min while this panel is open. Setups were validated on XAUUSDT only.'))
    this.bodyEl.replaceChildren(f)
  }

  private check(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const row = el('label', { class: 'buddy-check' })
    const input = el('input', { type: 'checkbox' }) as HTMLInputElement
    input.checked = value
    input.addEventListener('change', () => onChange(input.checked))
    row.append(input, textEl('span', '', label))
    return row
  }

  private update(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch }
    this.claude.model = this.settings.model
    lsSet(LS_SETTINGS, JSON.stringify(this.settings))
  }
}

/** Element with plain text content (never innerHTML — LLM text is untrusted). */
function textEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text: string): HTMLElementTagNameMap[K] {
  const n = el(tag, cls ? { class: cls } : {})
  n.textContent = text
  return n
}

function labelled(label: string, control: HTMLElement): HTMLElement {
  const row = el('label', { class: 'buddy-field' })
  row.append(textEl('span', '', label), control)
  return row
}

/** Header toggle icon for the panel. */
export const BUDDY_ICON = ICONS.smart
