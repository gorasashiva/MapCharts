// "NY First-Hour Fade" — sessions strategy indicator (researched on gold 1m: research/xau-sessions.mjs,
// research/xau-ny-fade.mjs). Math: src/overlays/nyFadeModel.ts. Drawn through the canvas-indicator hook
// (see CanvasSource in custom-indicators.ts):
//   - Asia / London / New York session shading (each in its own city's clock, so daylight saving is automatic),
//   - NY's first hour as a box with its move and the fade direction,
//   - each trade as a BUY / SELL label with entry, stop, TP1 and TP2 (src/overlays/tradePlot.ts),
//   - the planned levels while waiting for 09:00 NY, and the 17:00 NY exit line,
//   - a plan + stats dashboard with the times in IST,
// and its trades are listed in the Strategy Tester. Live events (plan, entry, TP1, stop, close) raise a
// notification + toast + sound.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import type { StrategyTrade } from '../../src/strategy/types'
import { NY_FADE_DEFAULTS, computeNyFade, nyFadeStats, nyWallToUtc, type NyFadeDay, type NyFadeExitMode, type NyFadeOptions, type NyFadeResult } from '../../src/overlays/nyFadeModel'
import { drawTradePlot, TRADE_COLORS, type PlotTrade } from '../../src/overlays/tradePlot'
import { askNotificationPermissionOnce, fireSignalAlert } from './signalAlert'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = NY_FADE_DEFAULTS
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
const pick = (key: string, label: string, def: number, group: string, options: { value: number; label: string }[]): IndicatorParam => ({ key, label, default: def, group, options })
const hhmm = (m: number): string => {
  const x = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`
}
const nyQuarterHours = Array.from({ length: 96 }, (_, i) => ({ value: i * 15, label: `${hhmm(i * 15)} New York` }))
const EXIT_MODES: NyFadeExitMode[] = ['close', 'tp1', 'tp2', 'half']

const G_S = 'Session (New York time, follows daylight saving)'
const G_R = 'Entry / stop / targets'
const G_ALERT = 'Alerts'
const G_STYLE = 'Style'

export const nyFade: IndicatorDef = {
  id: 'ny_first_hour_fade',
  label: 'NY First-Hour Fade (sessions strategy: fade NY 08:00-09:00, entry / SL / TP1 / TP2, alerts)',
  shortLabel: 'NY Fade',
  placement: 'overlay',
  params: [
    pick('start', 'First hour starts', D.sessionStartNY, G_S, nyQuarterHours),
    num('minutes', 'First-hour length (minutes)', D.firstMinutes, G_S, 15, 240, 15),
    pick('exit', 'Close everything at', D.exitNY, G_S, nyQuarterHours),

    pick('stopMode', 'Stop', 0, G_R, [
      { value: 0, label: 'Typical day range x multiple (backtested)' },
      { value: 1, label: "Beyond the first hour's high / low" },
    ]),
    num('stopRange', 'Stop: x typical day range', D.stopRange, G_R, 0.05, 2, 0.05),
    num('extremeBuffer', 'Stop beyond the first-hour extreme: x day range', D.extremeBuffer, G_R, 0, 0.5, 0.01),
    pick('exitMode', 'Exit', 0, G_R, [
      { value: 0, label: 'Hold to the session close (backtest best; targets shown)' },
      { value: 1, label: 'Take profit at TP1 (first-hour open)' },
      { value: 2, label: 'Take profit at TP2' },
      { value: 3, label: 'Half at TP1, stop to breakeven, rest at TP2 / close' },
    ]),
    num('targetR', 'TP2 (R multiple)', D.targetR, G_R, 0.5, 10, 0.25),
    num('minMove', 'Skip first hours smaller than x day range', D.minMove, G_R, 0, 1, 0.05),
    num('rangeDays', 'Typical day range: median of last N weekdays', D.rangeDays, G_R, 3, 60, 1),
    toggle('longs', 'Take longs (fade a falling first hour)', D.longs, G_R),
    toggle('shorts', 'Take shorts (fade a rising first hour)', D.shorts, G_R),

    toggle('alerts', 'Alerts (plan / entry / TP1 / stop / close)', true, G_ALERT),
    toggle('alertSound', 'Alert sound', true, G_ALERT),

    toggle('showSessions', 'Shade Asia / London / New York sessions', true, G_STYLE),
    toggle('showFirstHour', 'First-hour box + fade direction', true, G_STYLE),
    toggle('showTrades', 'Trades: BUY / SELL, entry, SL, TP1, TP2', true, G_STYLE),
    toggle('showExits', 'Exit markers', true, G_STYLE),
    toggle('showDash', 'Plan + stats dashboard', true, G_STYLE),
    pick('dashPos', 'Dashboard position', 0, G_STYLE, [
      { value: 0, label: 'Top right' },
      { value: 1, label: 'Top left' },
      { value: 2, label: 'Bottom right' },
      { value: 3, label: 'Bottom left' },
    ]),
  ],
  compute: () => [],
}

interface Display {
  sessions: boolean
  firstHour: boolean
  trades: boolean
  exits: boolean
  dash: boolean
  dashPos: number
}

export interface NyFadeModel {
  opts: NyFadeOptions
  display: Display
  result: NyFadeResult
  symbol: string
}

const fmt = (p: number): string => (Math.abs(p) >= 10 ? p.toFixed(2) : p.toPrecision(5))
const money = (p: number): string => `${p >= 0 ? '+' : '-'}$${Math.abs(p).toFixed(2)}`
const sideName = (s: number): string => (s > 0 ? 'BUY' : 'SELL')
/** IST clock (UTC+5:30, no daylight saving) of an epoch time. */
const ist = (t: number): string => {
  const d = new Date(t + 330 * 60_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const EXIT_TEXT: Record<NyFadeExitMode, string> = {
  close: 'hold to the session close',
  tp1: 'take profit at TP1',
  tp2: 'take profit at TP2',
  half: 'half at TP1 + breakeven, rest TP2 / close',
}

// ---------------------------------------------------------------------------
// Alerts: once per live event, never for loaded history or bar replay
// ---------------------------------------------------------------------------
const seenEvents = new Map<string, Set<string>>()
const FRESH_MS = 15 * 60_000

function runAlerts(candles: Candle[], m: NyFadeModel, sound: boolean): void {
  const now = Date.now()
  const last = candles[candles.length - 1]
  if (!last || now - last.time > 2 * 3_600_000) return // replay or stale data: stay quiet
  askNotificationPermissionOnce()
  let seen = seenEvents.get(m.symbol)
  const priming = !seen // the first pass for a symbol only records what already happened
  if (!seen) seenEvents.set(m.symbol, (seen = new Set()))
  const d = m.result.days[m.result.days.length - 1]
  if (!d) return
  const events: { key: string; time: number; text: string }[] = []
  if (d.plan && d.dir) {
    events.push({
      key: `${d.day}|plan`,
      time: d.entryAt,
      text: `NY first hour ${d.move > 0 ? 'up' : 'down'} $${Math.abs(d.move).toFixed(2)} → fade ${sideName(d.dir)} now (IST ${ist(d.entryAt)}) · SL ~${fmt(d.plan.stop)} · TP1 ${fmt(d.plan.tp1)} · TP2 ~${fmt(d.plan.tp2)}`,
    })
  }
  if (d.status === 'skipped-small') events.push({ key: `${d.day}|skip`, time: d.entryAt, text: `First hour moved only ${money(d.move)}: below the minimum, no fade today` })
  const t = d.trade
  if (t) {
    events.push({ key: `${d.day}|fill`, time: t.entryTime, text: `${sideName(t.side)} ${fmt(t.entry)} · SL ${fmt(t.stop)} · TP1 ${fmt(t.tp1)} · TP2 ${fmt(t.tp2)} · exit by IST ${ist(d.exitAt)}` })
    if (t.tp1Time !== null) events.push({ key: `${d.day}|tp1`, time: t.tp1Time, text: `TP1 ${fmt(t.tp1)} hit: half closed, stop to breakeven` })
    if (t.exitTime !== null && t.pnl !== null && t.r !== null) {
      const what = t.exitReason === 'SL' ? 'Stop hit' : t.exitReason === 'BE' ? 'Stopped at breakeven' : t.exitReason === 'Session end' ? 'Closed at the session end' : `${t.exitReason} hit`
      events.push({ key: `${d.day}|exit`, time: t.exitTime, text: `${what} · ${money(t.pnl)} per unit (${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R)` })
    }
  }
  for (const e of events) {
    if (seen.has(e.key)) continue
    seen.add(e.key)
    if (!priming && now - e.time <= FRESH_MS && e.time <= now + 60_000) fireSignalAlert(`NY Fade · ${m.symbol}`, e.text, sound)
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
export function computeNyFadeModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): NyFadeModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const opts: NyFadeOptions = {
    ...D,
    sessionStartNY: n('start', D.sessionStartNY),
    firstMinutes: Math.max(15, n('minutes', D.firstMinutes)),
    exitNY: n('exit', D.exitNY),
    stopMode: n('stopMode', 0) === 1 ? 'extreme' : 'range',
    stopRange: Math.max(0.01, n('stopRange', D.stopRange)),
    extremeBuffer: Math.max(0, n('extremeBuffer', D.extremeBuffer)),
    exitMode: EXIT_MODES[Math.round(n('exitMode', 0))] ?? 'close',
    targetR: Math.max(0.25, n('targetR', D.targetR)),
    minMove: Math.max(0, n('minMove', D.minMove)),
    rangeDays: Math.max(1, Math.round(n('rangeDays', D.rangeDays))),
    longs: b('longs', D.longs),
    shorts: b('shorts', D.shorts),
  }
  const model: NyFadeModel = {
    opts,
    symbol: ctx.symbol,
    result: computeNyFade(candles, opts),
    display: {
      sessions: b('showSessions', true),
      firstHour: b('showFirstHour', true),
      trades: b('showTrades', true),
      exits: b('showExits', true),
      dash: b('showDash', true),
      dashPos: Math.round(n('dashPos', 0)),
    },
  }
  if (b('alerts', true)) runAlerts(candles, model, b('alertSound', true))
  return model
}

/** Strategy Tester rows: one per trade; a split exit ('half' mode) is reported at its average price. */
export function nyFadeTrades(model: unknown): StrategyTrade[] {
  return (model as NyFadeModel).result.trades.map((t) => ({
    side: t.side > 0 ? 'long' : 'short',
    entryTime: t.entryTime,
    entryPrice: t.entry,
    exitTime: t.exitTime,
    exitPrice: t.avgExit,
    exitReason: t.exitReason ?? undefined,
    stop: t.stop,
  }))
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const font = (px: number, weight = 600): string => `${weight} ${px}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
const SESSION_STYLE: Record<number, { name: string; fill: string; text: string }> = {
  1: { name: 'ASIA', fill: 'rgba(126, 87, 194, 0.06)', text: 'rgba(179, 157, 219, 0.85)' },
  2: { name: 'LONDON', fill: 'rgba(66, 165, 245, 0.06)', text: 'rgba(144, 202, 249, 0.85)' },
  3: { name: 'NEW YORK', fill: 'rgba(255, 167, 38, 0.06)', text: 'rgba(255, 204, 128, 0.9)' },
}

function tag(g: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, align: 'left' | 'right' = 'left'): void {
  g.font = font(10)
  const w = g.measureText(text).width + 8
  const x0 = align === 'left' ? x : x - w
  g.fillStyle = bg
  g.beginPath()
  g.roundRect(x0, y - 8, w, 16, 3)
  g.fill()
  g.fillStyle = '#fff'
  g.textAlign = 'left'
  g.textBaseline = 'middle'
  g.fillText(text, x0 + 4, y + 0.5)
}

/** First candle index whose time is >= t (candles are time-ordered). */
function lowerBound(candles: Candle[], t: number): number {
  let lo = 0, hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].time < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function drawNyFade(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: NyFadeModel, _ctx: CanvasIndicatorContext): void {
  const n = candles.length
  if (n < 2) return
  const { display: s, result: r } = model
  const X = (i: number): number => conv.timeToX(candles[i].time)
  const Y = (v: number): number => Math.round(conv.priceToY(v)) + 0.5
  const barW = Math.abs(X(1) - X(0)) || 6
  const right = rect.x + rect.width
  const a = Math.max(0, lowerBound(candles, conv.xToTime(rect.x - 50)) - 1)
  const z = Math.min(n - 1, lowerBound(candles, conv.xToTime(right + 50)))

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  // session shading: runs of the same block across the visible bars
  if (s.sessions && r.blocks.length === n) {
    let k = a
    while (k <= z) {
      const blk = r.blocks[k]
      let e = k
      while (e + 1 <= z && r.blocks[e + 1] === blk) e++
      const st = SESSION_STYLE[blk]
      if (st) {
        const xa = X(k) - barW / 2, xb = X(e) + barW / 2
        g.fillStyle = st.fill
        g.fillRect(xa, rect.y, xb - xa, rect.height)
        if (xb - xa > 60) {
          g.font = font(9, 600)
          g.fillStyle = st.text
          g.textAlign = 'left'
          g.textBaseline = 'top'
          g.fillText(st.name, Math.max(rect.x + 4, xa + 4), rect.y + 4)
        }
      }
      k = e + 1
    }
  }

  const hline = (x0: number, x1: number, y: number, color: string, width: number, dash: number[]): void => {
    g.strokeStyle = color
    g.lineWidth = width
    g.setLineDash(dash)
    g.beginPath()
    g.moveTo(x0, y)
    g.lineTo(x1, y)
    g.stroke()
    g.setLineDash([])
  }

  // first-hour boxes, the plan while waiting for the entry, and the exit time of an open trade
  for (const d of r.days) {
    if (d.i1 < a || d.i0 > z) continue
    if (s.firstHour) {
      const xa = X(d.i0) - barW / 2, xb = X(d.i1) + barW / 2
      const col = d.move >= 0 ? 'rgba(38, 166, 154,' : 'rgba(239, 83, 80,'
      g.fillStyle = `${col} 0.10)`
      g.fillRect(xa, Y(d.high), xb - xa, Y(d.low) - Y(d.high))
      g.strokeStyle = `${col} 0.7)`
      g.lineWidth = 1
      g.strokeRect(xa, Y(d.high), xb - xa, Y(d.low) - Y(d.high))
      const fade = d.dir ? ` → fade ${sideName(d.dir)}` : d.status === 'first-hour' ? ' (forming)' : ''
      const skip = d.status === 'skipped-small' ? ' · too small, skip' : d.status === 'skipped-no-range' ? ' · need more history' : d.status === 'skipped-side' ? ' · side off' : ''
      g.font = font(9, 600)
      g.fillStyle = 'rgba(209, 212, 220, 0.9)'
      g.textAlign = 'left'
      g.textBaseline = 'bottom'
      g.fillText(`NY 1st hr ${money(d.move)}${fade}${skip}`, xa, Y(d.high) - 3)
    }
    if (d.status === 'waiting-entry' && d.plan && d.dir) {
      const xa = X(d.i1) + barW / 2
      hline(xa, right, Y(d.plan.entry), TRADE_COLORS.entry, 1.2, [6, 3])
      hline(xa, right, Y(d.plan.stop), TRADE_COLORS.sl, 1, [4, 3])
      hline(xa, right, Y(d.plan.tp1), TRADE_COLORS.tp1, 1, [4, 3])
      hline(xa, right, Y(d.plan.tp2), TRADE_COLORS.tp2, 1, [4, 3])
      tag(g, right - 2, Y(d.plan.entry), `${sideName(d.dir)} at NY ${hhmm(model.opts.sessionStartNY + model.opts.firstMinutes)} (IST ${ist(d.entryAt)}) ~${fmt(d.plan.entry)}`, d.dir > 0 ? TRADE_COLORS.buy : TRADE_COLORS.sell, 'right')
      tag(g, right - 2, Y(d.plan.stop), `SL ~${fmt(d.plan.stop)}`, TRADE_COLORS.sl, 'right')
      tag(g, right - 2, Y(d.plan.tp1), `TP1 ${fmt(d.plan.tp1)}`, 'rgba(38, 166, 154, 0.75)', 'right')
      tag(g, right - 2, Y(d.plan.tp2), `TP2 ~${fmt(d.plan.tp2)}`, TRADE_COLORS.tp2, 'right')
    }
    if (d.trade && d.trade.exitTime === null) {
      const x = Math.round(conv.timeToX(d.exitAt)) + 0.5
      if (x > rect.x && x < right) {
        g.strokeStyle = 'rgba(255, 204, 128, 0.7)'
        g.lineWidth = 1
        g.setLineDash([4, 4])
        g.beginPath()
        g.moveTo(x, rect.y)
        g.lineTo(x, rect.y + rect.height)
        g.stroke()
        g.setLineDash([])
        g.font = font(9, 600)
        g.fillStyle = 'rgba(255, 204, 128, 0.95)'
        g.textAlign = 'left'
        g.textBaseline = 'top'
        g.fillText(`exit NY ${hhmm(model.opts.exitNY)} · IST ${ist(d.exitAt)}`, x + 4, rect.y + 18)
      }
    }
  }
  g.restore()

  // trades: BUY / SELL label, entry, stop, TP1 and TP2 lines, exits (shared TradingView-style plot)
  if (s.trades && r.trades.length) {
    const plot: PlotTrade[] = r.trades
      .filter((t) => t.entryIndex <= z + 1 && (t.exitIndex === null || t.exitIndex >= a - 1))
      .map((t) => ({
        side: t.side > 0 ? 'long' : 'short',
        entryTime: t.entryTime,
        entryPrice: t.entry,
        stop: t.stop,
        tp1: t.tp1,
        tp1Time: t.tp1Time,
        target: t.tp2,
        exitTime: t.exitTime,
        exitPrice: t.exitPrice,
        exitReason: t.exitReason === 'Session end' ? 'Day end' : t.exitReason,
        barHigh: candles[t.entryIndex].high,
        barLow: candles[t.entryIndex].low,
        grossR: t.r ?? 0,
        label: t.side > 0 ? 'FADE BUY' : 'FADE SELL',
      }))
    drawTradePlot(g, conv, rect, plot, { lastTime: candles[n - 1].time, barMs: r.barMs, showSignals: true, showLevels: true, showExits: s.exits })
  }

  if (s.dash) drawDashboard(g, rect, model)
}

function drawDashboard(g: CanvasRenderingContext2D, rect: Rect, model: NyFadeModel): void {
  const { result: r, display: s, opts: o } = model
  const st = nyFadeStats(r.trades)
  const rows: [string, string, string?][] = []
  const fhEnd = o.sessionStartNY + o.firstMinutes
  if (!r.usable) rows.push(['Note', 'needs bars of 1 hour or less (best on 1m-15m)', '#FF9800'])
  const d: NyFadeDay | undefined = r.days[r.days.length - 1]
  const ref = d?.day ?? new Date().toISOString().slice(0, 10)
  rows.push(['Times (IST)', `1st hour ${ist(nyWallToUtc(ref, o.sessionStartNY))}-${ist(nyWallToUtc(ref, fhEnd))} · entry ${ist(nyWallToUtc(ref, fhEnd))} · exit ${ist(nyWallToUtc(ref, o.exitNY))}`])
  if (d) {
    const statusText: Record<string, [string, string]> = {
      'first-hour': ['first hour forming', '#d1d4dc'],
      'waiting-entry': [`fade ${d.dir ? sideName(d.dir) : ''} at the next bar`, d.dir > 0 ? TRADE_COLORS.buy : TRADE_COLORS.sell],
      'skipped-small': ['skip: first hour too small', '#787B86'],
      'skipped-side': ['skip: that side is switched off', '#787B86'],
      'skipped-no-range': ['skip: not enough history for the typical range', '#787B86'],
      traded: ['traded', '#d1d4dc'],
    }
    const [txt, col] = statusText[d.status] ?? [d.status, '#d1d4dc']
    rows.push([`Today ${d.day.slice(5)}`, `NY 1st hour ${money(d.move)} · ${txt}`, col])
    const t = d.trade
    if (t) {
      const state = t.exitReason ? `${t.exitReason} ${money(t.pnl ?? 0)} (${(t.r ?? 0) >= 0 ? '+' : ''}${(t.r ?? 0).toFixed(2)}R)` : t.tp1Time !== null ? 'IN TRADE · half banked at TP1' : 'IN TRADE'
      rows.push([sideName(t.side), `${state} · ${fmt(t.entry)} / SL ${fmt(t.stop)} / TP1 ${fmt(t.tp1)} / TP2 ${fmt(t.tp2)}`, t.side > 0 ? TRADE_COLORS.buy : TRADE_COLORS.sell])
    } else if (d.plan && d.dir) rows.push(['Plan', `${sideName(d.dir)} ~${fmt(d.plan.entry)} / SL ~${fmt(d.plan.stop)} / TP1 ${fmt(d.plan.tp1)} / TP2 ~${fmt(d.plan.tp2)}`, d.dir > 0 ? TRADE_COLORS.buy : TRADE_COLORS.sell])
    if (Number.isFinite(d.scale)) rows.push(['Typical day range', `$${d.scale.toFixed(2)} (median of ${d.scaleDays} weekdays) · stop ${o.stopMode === 'range' ? `${o.stopRange}x = $${(o.stopRange * d.scale).toFixed(2)}` : 'beyond the first-hour extreme'}`])
    if (d.scaleDays < Math.min(10, o.rangeDays)) rows.push(['Note', `range from only ${d.scaleDays} days: scroll left to load more history for steadier stops`, '#FF9800'])
  }
  rows.push(['Exit rule', `${EXIT_TEXT[o.exitMode]} · TP2 ${o.targetR}R`])
  rows.push(['History', `${st.n} trades · win ${st.winRate.toFixed(0)}% · ${money(st.totalPnl)} · avg ${money(st.avgPnl)} / ${st.avgR.toFixed(2)}R · PF ${Number.isFinite(st.pf) ? st.pf.toFixed(2) : '∞'} · maxDD $${st.maxDD.toFixed(2)}`])
  rows.push(['Research', 'gold 1m Apr-Nov 2026: +$11.5/trade train, +$6 test (no stop, $0.50 cost) · not advice', '#787B86'])

  const px = 10
  const rowH = 18
  g.font = font(px, 600)
  const c0 = Math.max(...rows.map((x) => g.measureText(x[0]).width)) + 14
  g.font = font(px, 500)
  const c1 = Math.max(...rows.map((x) => g.measureText(x[1]).width)) + 14
  const W = c0 + c1
  const H = (rows.length + 1) * rowH
  const pad = 8
  const x = s.dashPos === 1 || s.dashPos === 3 ? rect.x + pad : rect.x + rect.width - W - pad - 110
  const y = s.dashPos >= 2 ? rect.y + rect.height - H - pad - 24 : rect.y + pad + 28
  g.fillStyle = 'rgba(19, 23, 34, 0.86)'
  g.fillRect(x, y, W, H)
  g.strokeStyle = 'rgba(120, 123, 134, 0.5)'
  g.lineWidth = 1
  g.strokeRect(x + 0.5, y + 0.5, W, H)
  g.textBaseline = 'middle'
  g.textAlign = 'left'
  g.font = font(px + 1, 700)
  g.fillStyle = '#FFCC80'
  g.fillText('NY First-Hour Fade', x + 7, y + rowH / 2 + 1)
  g.font = font(px, 500)
  g.fillStyle = '#B2B5BE'
  g.fillText(model.symbol, x + c0 + 7, y + rowH / 2 + 1)
  rows.forEach(([l, v, col], k) => {
    const ry = y + (k + 1) * rowH + rowH / 2 + 0.5
    g.font = font(px, 600)
    g.fillStyle = '#B2B5BE'
    g.fillText(l, x + 7, ry)
    g.font = font(px, 500)
    g.fillStyle = col ?? '#d1d4dc'
    g.fillText(v, x + c0 + 7, ry)
  })
}
