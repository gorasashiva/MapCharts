// Claude side of the Trade Buddy: explains scanner ideas and answers chat
// questions, always grounded in the live multi-timeframe briefing built by
// src/buddy/analysis.ts. Requests go to the local Claude Code CLI through the
// dev-server bridge (buddyBridge.mjs) — no API key; usage counts against the
// user's Claude Code plan. Only available while the app runs via `npm run demo`.

export const BUDDY_MODELS = [
  { id: 'opus', label: 'Claude Opus (Claude Code)' },
  { id: 'sonnet', label: 'Claude Sonnet (Claude Code)' },
  { id: 'haiku', label: 'Claude Haiku (Claude Code)' },
] as const
export type BuddyModelId = (typeof BUDDY_MODELS)[number]['id']

// Replaces Claude Code's default system prompt for these headless runs.
const SYSTEM = `You are Trade Buddy, a concise trading assistant embedded in the CandL charting platform. You see a live JSON briefing of the chart (all timeframes from 1m to 1d, Initial Balance, session volume-profile demand/supply zones, timing flags) plus any setups the rule-based scanner has flagged. You have no tools; answer from the briefing.

How to work:
- Ground every statement in the briefing. Quote exact levels from it; never invent prices, indicators or news you were not given.
- The scanner only flags two setups, both backtested out-of-sample on XAUUSDT (Binance USDT-M, Dec 2025 to Sep 2026, 0.10% round-trip fees):
  1. IB breakout: the 120-minute Initial Balance of the UTC session (05:30 to 07:30 IST), traded only when it is wider than its 20-day average; the first 5m close beyond it between 07:30 and 10:30 IST; stop at the opposite IB side; take 50% at 1x IB and exit the rest by 21:30 IST. About 58% win rate, profit factor about 1.9 (about 65% win with the partial).
  2. FVG + Supertrend hybrid: a 5m fair-value-gap reaction with 5m Supertrend(2,2) agreement, filtered and exited by the 1h Supertrend(2,2). It is a swing of about 24 hours, not an intraday trade.
- It may also flag experimental volume-profile zone setups (validated_by_backtest: false): a zone breakout (two 5m closes beyond a zone, stop at the zone midpoint) or a zone bounce (rejection off a zone defended by the dominant side, stop just beyond it), with targets at the next zones. These have NOT been backtested; say so, treat bounces with extra scepticism, and suggest smaller size.
- Each zone in the briefing has a role (support/resistance, with the dominant side and a check or warning mark for whether that side defends it), a 0-100 strength (Strong 70+, Moderate 45-69, Weak below 45) built from volume share, delta, rejections and concentration, and "held" = rejections/tests. The strength score is a heuristic, not a measured probability.
- Other findings from the same research: weekend trading loses badly (spot gold is closed); 20:00 to 21:59, 02:00 to 04:59, 15:00 and 17:00 IST were consistently poor hours; fading moves (VWAP-band fades, failed-IB fades) lost money in every tested variant, while breakouts and acceptance worked; session profile zones are acceptance areas where price tends to slow and rotate, and the thin gaps between them are where price travels quickly.
- These results are specific to XAUUSDT in that period. For any other symbol, say plainly that the setups are unvalidated there.
- Be a candid second opinion, not a cheerleader. If the setup is weak or the timing is poor, say so. Never promise outcomes. Remind the user to size positions by the stop distance.

Style: short and scannable, suited to a narrow side panel. Plain text with simple dash bullets; no headings, tables or markdown emphasis. Use IST times.`

const EXPLAIN_INSTRUCTION = `Explain the flagged setup below for someone about to decide whether to take it. Use at most five short bullets covering: the thesis in one line, what confirms it across timeframes, what argues against it, the exact plan (entry, stop, targets, exit), and what would invalidate it.`

/** Start a fresh chat session after this many turns to keep answers fast. */
const MAX_CHAT_TURNS = 10

export interface BuddyUsage {
  requests: number
  costUsd: number
}

type BridgeLine = { type: 'text'; text: string } | { type: 'done'; text: string; sessionId?: string; costUsd?: number } | { type: 'error'; message: string }

export class BuddyClaude {
  model: BuddyModelId = 'opus'
  readonly usage: BuddyUsage = { requests: 0, costUsd: 0 }
  /** null = not checked yet. */
  available: boolean | null = null
  status = 'Checking the Claude Code bridge…'
  private sessionId: string | null = null
  private turns = 0

  get ready(): boolean {
    return this.available === true
  }

  /** Probe the dev-server bridge and the CLI behind it. */
  async checkBridge(): Promise<boolean> {
    try {
      const res = await fetch('/__buddy/health', { headers: { 'x-buddy-bridge': '1' } })
      if (res.status === 404) throw new Error('no bridge')
      const body = (await res.json()) as { ok: boolean; version?: string; message?: string }
      this.available = body.ok
      this.status = body.ok ? `Connected to Claude Code ${body.version ?? ''}`.trim() : body.message ?? 'Claude Code CLI unavailable'
    } catch {
      this.available = false
      this.status = 'Claude Code bridge not running. It works only with the local dev server (npm run demo) on this machine.'
    }
    return this.available
  }

  resetChat(): void {
    this.sessionId = null
    this.turns = 0
  }

  /** One-shot explanation of a scanner idea; streams text into `onText`. */
  async explain(briefingJson: string, ideaTitle: string, onText: (snapshot: string) => void): Promise<string> {
    const prompt = `<market_briefing>\n${briefingJson}\n</market_briefing>\n\n${EXPLAIN_INSTRUCTION}\n\nSetup: ${ideaTitle}`
    const done = await this.run({ prompt, effort: 'medium', persist: false }, onText)
    return done.text
  }

  /** Chat turn; the conversation continues in one Claude Code session. */
  async ask(briefingJson: string, question: string, onText: (snapshot: string) => void): Promise<string> {
    if (this.turns >= MAX_CHAT_TURNS) this.resetChat()
    const prompt = `<market_briefing>\n${briefingJson}\n</market_briefing>\n\n${question}`
    const done = await this.run({ prompt, effort: 'high', persist: true, sessionId: this.sessionId ?? undefined }, onText)
    if (done.sessionId) this.sessionId = done.sessionId
    this.turns++
    return done.text
  }

  private async run(req: { prompt: string; effort: 'medium' | 'high'; persist: boolean; sessionId?: string }, onText: (snapshot: string) => void): Promise<{ text: string; sessionId?: string }> {
    if (!this.ready && !(await this.checkBridge())) throw new Error(this.status)
    const res = await fetch('/__buddy/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-buddy-bridge': '1' },
      body: JSON.stringify({ ...req, system: SYSTEM, model: this.model }),
    })
    if (!res.ok || !res.body) throw new Error((await res.text().catch(() => '')) || `Bridge error ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line) as BridgeLine
        if (msg.type === 'text') onText(msg.text)
        else if (msg.type === 'error') throw new Error(msg.message)
        else {
          this.usage.requests++
          this.usage.costUsd += msg.costUsd ?? 0
          onText(msg.text)
          return { text: msg.text, sessionId: msg.sessionId }
        }
      }
    }
    throw new Error('Claude Code bridge closed without an answer.')
  }
}

/** User-facing message for any failure. */
export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
