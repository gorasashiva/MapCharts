// "TPO VA Fade" — strategy indicator for the previous-session TPO value-area fade
// (researched on gold 5m). Math: src/overlays/tpoFadeModel.ts. Drawn through the
// canvas-indicator hook (see CanvasSource in custom-indicators.ts):
//   - yesterday's TPO VAH / POC / VAL across each session,
//   - the day's limit orders (entry / stop / target) from 07:00 UTC,
//   - each trade as a position box with its result in R,
//   - a plan + stats dashboard,
// and its trades are listed in the Strategy Tester. Live events (orders placed,
// fills, TP / SL, cancels) raise a notification + toast + sound.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import type { StrategyTrade } from '../../src/strategy/types'
import { sessionClosedWeekends, sessionOpenHourUTC } from '../../src/core/session'
import { TPO_FADE_DEFAULTS, computeTpoFade, fadeStats, type FadeOrder, type FadeSession, type TpoFadeOptions, type TpoFadeResult } from '../../src/overlays/tpoFadeModel'
import { COL, PALETTE, colorOpts } from './flyingCpr'
import { askNotificationPermissionOnce, fireSignalAlert } from './signalAlert'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = TPO_FADE_DEFAULTS
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
const pick = (key: string, label: string, def: number, group: string, options: { value: number; label: string }[]): IndicatorParam => ({ key, label, default: def, group, options })
const hourOpts = Array.from({ length: 24 }, (_, h) => {
  const ist = (h * 60 + 330) % 1440
  return { value: h, label: `${String(h).padStart(2, '0')}:00 UTC (${String(Math.floor(ist / 60)).padStart(2, '0')}:${String(ist % 60).padStart(2, '0')} IST)` }
})

const G_LV = 'Levels (previous session TPO)'
const G_RULE = 'Entry / stop / target rules'
const G_RISK = 'Risk & sizing'
const G_ALERT = 'Alerts'
const G_STYLE = 'Style'

export const tpoFade: IndicatorDef = {
  id: 'tpo_va_fade',
  label: 'TPO VA Fade (prev-session TPO value-area fade → POC, auto entry / SL / TP)',
  shortLabel: 'TPO Fade',
  placement: 'overlay',
  params: [
    pick('openHour', 'Session open', -1, G_LV, [{ value: -1, label: 'Auto (symbol session: gold 22:00 UTC)' }, ...hourOpts]),
    pick('weekends', 'Skip Sat / Sun sessions', -1, G_LV, [
      { value: -1, label: 'Auto (on for gold)' },
      { value: 1, label: 'On' },
      { value: 0, label: 'Off' },
    ]),
    num('rowSize', 'TPO row size (0 = auto, $1 for gold)', 0, G_LV, 0, 10000, 0.1),
    num('valueAreaPct', 'Value area %', 70, G_LV, 50, 95, 1),

    pick('windowStart', 'Orders placed at', D.windowStartUTC, G_RULE, hourOpts),
    pick('windowEnd', 'Unfilled orders cancelled at', D.windowEndUTC, G_RULE, hourOpts),
    num('stopAtr', 'Stop distance (× ATR 5m)', D.stopAtr, G_RULE, 0.5, 10, 0.25),
    num('stopMin', 'Minimum stop (price)', D.stopMin, G_RULE, 0, 100000, 0.5),
    num('minRR', 'Min R:R (level → POC ÷ stop)', D.minRR, G_RULE, 0, 10, 0.25),
    num('entryAtr', 'Limit past the level (× ATR)', D.entryAtr, G_RULE, 0, 3, 0.25),
    num('targetAtr', 'Target before the POC (× ATR)', D.targetAtr, G_RULE, 0, 3, 0.25),
    num('fillTol', 'Fill needs a trade-through of (price)', D.fillTol, G_RULE, 0, 1000, 0.05),
    toggle('shorts', 'Shorts at VAH', D.shorts, G_RULE),
    toggle('longs', 'Longs at VAL', D.longs, G_RULE),
    toggle('oneLoss', 'One loss per day (cancel the other side)', D.oneLossPerDay, G_RULE),

    num('account', 'Account size', D.account, G_RISK, 100, 1e9, 100),
    num('riskQuiet', 'Risk % on quiet days', D.riskQuiet, G_RISK, 0, 10, 0.25),
    num('riskNormal', 'Risk % on normal days', D.riskNormal, G_RISK, 0, 10, 0.25),
    num('riskBusy', 'Risk % on busy days', D.riskBusy, G_RISK, 0, 10, 0.25),
    num('quietBelow', 'Quiet: ATR ratio below', D.quietBelow, G_RISK, 0.1, 2, 0.05),
    num('busyFrom', 'Busy: ATR ratio from', D.busyFrom, G_RISK, 0.1, 3, 0.05),
    num('halveAfter', 'Halve risk after N losses in a row (0 = off)', D.halveAfter, G_RISK, 0, 10, 1),

    toggle('alerts', 'Alerts (order placed / filled / TP / SL / cancelled)', true, G_ALERT),
    toggle('alertSound', 'Alert sound', true, G_ALERT),

    toggle('showLevels', 'Previous-session VAH / POC / VAL', true, G_STYLE),
    toggle('showOrders', 'Resting limit orders', true, G_STYLE),
    toggle('showSkipped', 'Skipped sides (R:R / already through)', false, G_STYLE),
    toggle('showTrades', 'Trade boxes + result labels', true, G_STYLE),
    toggle('showDash', 'Plan + stats dashboard', true, G_STYLE),
    pick('dashPos', 'Dashboard position', 0, G_STYLE, [
      { value: 0, label: 'Top right' },
      { value: 1, label: 'Top left' },
      { value: 2, label: 'Bottom right' },
      { value: 3, label: 'Bottom left' },
    ]),
    pick('vaColor', 'VAH / VAL colour', COL.Blue, G_STYLE, colorOpts),
    pick('pocColor', 'POC colour', COL.Orange, G_STYLE, colorOpts),
    pick('longColor', 'Long colour', COL.Teal, G_STYLE, colorOpts),
    pick('shortColor', 'Short colour', COL.Red, G_STYLE, colorOpts),
    pick('tpColor', 'Target colour', COL.Green, G_STYLE, colorOpts),
    pick('slColor', 'Stop colour', COL.Red, G_STYLE, colorOpts),
    num('boxOpacity', 'Trade box opacity %', 14, G_STYLE, 2, 60, 1),
  ],
  compute: () => [],
}

interface Display {
  levels: boolean
  orders: boolean
  skipped: boolean
  trades: boolean
  dash: boolean
  dashPos: number
  va: string
  poc: string
  long: string
  short: string
  tp: string
  sl: string
  boxAlpha: number
}

export interface TpoFadeModel {
  opts: TpoFadeOptions
  display: Display
  result: TpoFadeResult
  symbol: string
}

const colorOf = (i: number, d: number): string => (PALETTE[Math.round(i)] ?? PALETTE[d])[1]
const rgba = (hex: string, a: number): string => {
  const v = parseInt(hex.slice(1), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`
}
const fmt = (p: number): string => (p >= 10 ? p.toFixed(2) : p.toPrecision(5))
const sideName = (s: 1 | -1): string => (s > 0 ? 'BUY' : 'SELL')
const qtyOf = (account: number, riskPct: number, o: { entry: number; stop: number }): number => (account * riskPct) / 100 / Math.abs(o.entry - o.stop)
const fmtQty = (q: number): string => q.toFixed(q < 10 ? 2 : 0)

// ---------------------------------------------------------------------------
// Alerts: once per live event, never for loaded history or bar replay
// ---------------------------------------------------------------------------
const seenEvents = new Map<string, Set<string>>()
const FRESH_MS = 15 * 60_000

function runAlerts(candles: Candle[], m: TpoFadeModel, sound: boolean): void {
  const now = Date.now()
  const last = candles[candles.length - 1]
  // replay or stale data: stay quiet
  if (!last || now - last.time > 2 * 3_600_000) return
  askNotificationPermissionOnce()
  let seen = seenEvents.get(m.symbol)
  // the first pass for a symbol only records what already happened
  const priming = !seen
  if (!seen) seenEvents.set(m.symbol, (seen = new Set()))
  const sess = m.result.sessions[m.result.sessions.length - 1]
  if (!sess) return
  const events: { key: string; time: number; text: string }[] = []
  for (const o of sess.orders) {
    if (o.status.startsWith('skipped') || o.from < 0) continue
    const id = `${sess.start}|${o.side}`
    const q = qtyOf(m.opts.account, sess.riskPct, o)
    events.push({
      key: `${id}|plan`,
      time: candles[o.from].time,
      text: `Order placed: ${sideName(o.side)} LIMIT ${fmt(o.entry)} · SL ${fmt(o.stop)} · TP ${fmt(o.target)} · R:R ${o.rrEntry.toFixed(1)} · qty ${fmtQty(q)} (${sess.regime} day, risk ${sess.riskPct}%)`,
    })
    if (o.status === 'cancelled') events.push({ key: `${id}|cancel`, time: candles[o.to].time, text: `${sideName(o.side)} order cancelled (other side stopped out)` })
    const t = o.trade
    if (t) {
      events.push({ key: `${id}|fill`, time: t.entryTime, text: `${sideName(t.side)} filled at ${fmt(t.entry)} · SL ${fmt(t.stop)} · TP ${fmt(t.target)}` })
      if (t.exitTime !== null && t.r !== null) {
        const what = t.exitReason === 'TP' ? 'Target hit' : t.exitReason === 'SL' ? 'Stop hit' : 'Closed at session end'
        events.push({ key: `${id}|exit`, time: t.exitTime, text: `${what} · ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R` })
      }
    }
  }
  for (const e of events) {
    if (seen.has(e.key)) continue
    seen.add(e.key)
    if (!priming && now - e.time <= FRESH_MS) fireSignalAlert(`TPO VA Fade · ${m.symbol}`, e.text, sound)
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
export function computeTpoFadeModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): TpoFadeModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const openHour = n('openHour', -1)
  const weekends = n('weekends', -1)
  const opts: TpoFadeOptions = {
    ...D,
    openHourUTC: openHour >= 0 ? openHour : sessionOpenHourUTC(ctx.symbol),
    skipWeekends: weekends >= 0 ? weekends === 1 : sessionClosedWeekends(ctx.symbol),
    rowSize: Math.max(0, n('rowSize', 0)),
    valueAreaPct: Math.min(0.95, Math.max(0.5, n('valueAreaPct', 70) / 100)),
    windowStartUTC: n('windowStart', D.windowStartUTC),
    windowEndUTC: n('windowEnd', D.windowEndUTC),
    stopAtr: n('stopAtr', D.stopAtr),
    stopMin: n('stopMin', D.stopMin),
    minRR: n('minRR', D.minRR),
    entryAtr: n('entryAtr', D.entryAtr),
    targetAtr: n('targetAtr', D.targetAtr),
    fillTol: n('fillTol', D.fillTol),
    shorts: b('shorts', D.shorts),
    longs: b('longs', D.longs),
    oneLossPerDay: b('oneLoss', D.oneLossPerDay),
    account: n('account', D.account),
    riskQuiet: n('riskQuiet', D.riskQuiet),
    riskNormal: n('riskNormal', D.riskNormal),
    riskBusy: n('riskBusy', D.riskBusy),
    quietBelow: n('quietBelow', D.quietBelow),
    busyFrom: n('busyFrom', D.busyFrom),
    halveAfter: Math.round(n('halveAfter', D.halveAfter)),
  }
  const model: TpoFadeModel = {
    opts,
    symbol: ctx.symbol,
    result: computeTpoFade(candles, opts),
    display: {
      levels: b('showLevels', true),
      orders: b('showOrders', true),
      skipped: b('showSkipped', false),
      trades: b('showTrades', true),
      dash: b('showDash', true),
      dashPos: Math.round(n('dashPos', 0)),
      va: colorOf(n('vaColor', COL.Blue), COL.Blue),
      poc: colorOf(n('pocColor', COL.Orange), COL.Orange),
      long: colorOf(n('longColor', COL.Teal), COL.Teal),
      short: colorOf(n('shortColor', COL.Red), COL.Red),
      tp: colorOf(n('tpColor', COL.Green), COL.Green),
      sl: colorOf(n('slColor', COL.Red), COL.Red),
      boxAlpha: Math.min(0.6, Math.max(0.02, n('boxOpacity', 14) / 100)),
    },
  }
  if (b('alerts', true)) runAlerts(candles, model, b('alertSound', true))
  return model
}

/** Strategy Tester rows: every trade, sized by its day's risk % of the account. */
export function tpoFadeTrades(model: unknown): StrategyTrade[] {
  return (model as TpoFadeModel).result.trades.map((t) => ({
    side: t.side > 0 ? 'long' : 'short',
    entryTime: t.entryTime,
    entryPrice: t.entry,
    exitTime: t.exitTime,
    exitPrice: t.exitPrice,
    exitReason: t.exitReason ?? undefined,
    stop: t.stop,
    qty: t.qty,
  }))
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const font = (px: number, weight = 600): string => `${weight} ${px}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`

/** Rounded price tag; `align` says which side of x it extends to. */
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

export function drawTpoFade(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: TpoFadeModel, _ctx: CanvasIndicatorContext): void {
  const n = candles.length
  if (n < 2) return
  const { display: s, result: r } = model
  const X = (i: number): number => conv.timeToX(candles[i].time)
  const Y = (v: number): number => Math.round(conv.priceToY(v)) + 0.5
  const barW = Math.abs(X(1) - X(0)) || 6
  const right = rect.x + rect.width
  const t0 = conv.xToTime(rect.x - 50)
  const t1 = conv.xToTime(right + 50)
  const visible = (a: number, z: number): boolean => candles[z].time >= t0 && candles[a].time <= t1

  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

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

  const drawOrder = (o: FadeOrder, sess: FadeSession): void => {
    const col = o.side > 0 ? s.long : s.short
    if (o.status.startsWith('skipped')) {
      if (!s.skipped || o.status === 'skipped-side' || o.from < 0) return
      const why = o.status === 'skipped-rr' ? `R:R ${o.rrLevel.toFixed(1)} < ${model.opts.minRR}` : 'already through'
      g.font = font(9, 500)
      g.fillStyle = 'rgba(120, 123, 134, 0.9)'
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      g.fillText(`skip ${o.side > 0 ? 'long' : 'short'} · ${why}`, X(o.from) + 4, Y(o.level) + (o.side > 0 ? 10 : -10))
      return
    }
    // resting order: entry / stop / target from the window open to fill, cancel or expiry
    if (s.orders && o.from >= 0) {
      const live = o.status === 'pending'
      const xa = X(o.from)
      const xb = live ? right : X(o.to)
      hline(xa, xb, Y(o.entry), rgba(col, 0.95), 1.2, [6, 3])
      hline(xa, xb, Y(o.stop), rgba(s.sl, 0.55), 1, [2, 3])
      hline(xa, xb, Y(o.target), rgba(s.tp, 0.55), 1, [2, 3])
      const status = o.status === 'expired' || o.status === 'cancelled' ? ` · ${o.status}` : ''
      tag(g, xa + 2, Y(o.entry), `${sideName(o.side)} LMT ${fmt(o.entry)} · R:R ${o.rrEntry.toFixed(1)}${status}`, rgba(col, live ? 0.95 : 0.7))
      if (live) {
        tag(g, right - 2, Y(o.stop), `SL ${fmt(o.stop)}`, rgba(s.sl, 0.9), 'right')
        tag(g, right - 2, Y(o.target), `TP ${fmt(o.target)}`, rgba(s.tp, 0.9), 'right')
      }
    }
    const t = o.trade
    if (!t || !s.trades) return
    // position box: target zone and stop zone from fill to exit (to the right edge while open)
    const ea = X(t.entryIndex) - barW / 2
    const eb = t.exitIndex === null ? (sess.complete ? X(sess.i1) + barW / 2 : right) : X(t.exitIndex) + barW / 2
    const ye = Y(t.entry)
    g.fillStyle = rgba(s.tp, s.boxAlpha)
    g.fillRect(ea, Math.min(ye, Y(t.target)), eb - ea, Math.abs(Y(t.target) - ye))
    g.fillStyle = rgba(s.sl, s.boxAlpha)
    g.fillRect(ea, Math.min(ye, Y(t.stop)), eb - ea, Math.abs(Y(t.stop) - ye))
    hline(ea, eb, ye, rgba(col, 0.9), 1, [])
    const c = candles[t.entryIndex]
    const up = t.side > 0
    const my = up ? conv.priceToY(c.low) + 6 : conv.priceToY(c.high) - 6
    g.fillStyle = col
    g.beginPath()
    g.moveTo(X(t.entryIndex), my)
    g.lineTo(X(t.entryIndex) - 5, my + (up ? 8 : -8))
    g.lineTo(X(t.entryIndex) + 5, my + (up ? 8 : -8))
    g.closePath()
    g.fill()
    if (t.exitIndex !== null && t.r !== null && t.exitPrice !== null) {
      const win = t.r > 0
      tag(g, eb + 3, Y(t.exitPrice), `${t.exitReason} ${win ? '+' : ''}${t.r.toFixed(2)}R`, win ? rgba(s.tp, 0.95) : rgba(s.sl, 0.95))
    } else {
      const openR = (t.side * (candles[n - 1].close - t.entry)) / Math.abs(t.entry - t.stop)
      tag(g, right - 2, ye, `${sideName(t.side)} ${fmt(t.entry)} · open ${openR >= 0 ? '+' : ''}${openR.toFixed(2)}R`, rgba(col, 0.95), 'right')
      tag(g, right - 2, Y(t.stop), `SL ${fmt(t.stop)}`, rgba(s.sl, 0.9), 'right')
      tag(g, right - 2, Y(t.target), `TP ${fmt(t.target)}`, rgba(s.tp, 0.9), 'right')
    }
  }

  for (const sess of r.sessions) {
    if (!visible(sess.i0, sess.i1)) continue
    const xa = X(sess.i0) - barW / 2
    const xb = sess.i1 >= n - 1 && !sess.complete ? right : X(sess.i1) + barW / 2
    if (s.levels) {
      hline(xa, xb, Y(sess.vah), rgba(s.va, 0.7), 1, [5, 4])
      hline(xa, xb, Y(sess.val), rgba(s.va, 0.7), 1, [5, 4])
      hline(xa, xb, Y(sess.poc), rgba(s.poc, 0.85), 1.2, [2, 3])
      g.font = font(9, 500)
      g.textAlign = 'left'
      g.textBaseline = 'bottom'
      g.fillStyle = rgba(s.va, 0.9)
      g.fillText('pVAH', xa + 3, Y(sess.vah) - 2)
      g.fillText('pVAL', xa + 3, Y(sess.val) - 2)
      g.fillStyle = rgba(s.poc, 0.95)
      g.fillText('pPOC', xa + 3, Y(sess.poc) - 2)
    }
    for (const o of sess.orders) drawOrder(o, sess)
  }

  // next session's levels (e.g. Monday's over the weekend), from the last bar to the right edge
  const lastX = X(n - 1) + barW / 2
  if (r.next && s.levels && lastX < right) {
    const xa = Math.max(rect.x, lastX)
    const lines: [number, string, string][] = [
      [r.next.vah, s.va, 'next VAH'],
      [r.next.poc, s.poc, 'next POC'],
      [r.next.val, s.va, 'next VAL'],
    ]
    for (const [v, col, name] of lines) {
      hline(xa, right, Y(v), rgba(col, 0.9), 1.2, [6, 3])
      tag(g, right - 2, Y(v), `${name} ${fmt(v)}`, rgba(col, 0.85), 'right')
    }
  }

  if (s.dash) drawDashboard(g, rect, model)
  g.restore()
}

function drawDashboard(g: CanvasRenderingContext2D, rect: Rect, model: TpoFadeModel): void {
  const { result: r, display: s, opts: o } = model
  const sess = r.sessions[r.sessions.length - 1]
  const st = fadeStats(r.trades)
  const rows: [string, string, string?][] = []
  if (sess) {
    rows.push(['Levels (prev TPO)', `VAH ${fmt(sess.vah)} · POC ${fmt(sess.poc)} · VAL ${fmt(sess.val)}`])
    if (sess.windowStart < 0) rows.push(['Orders', `placed at ${String(o.windowStartUTC).padStart(2, '0')}:00 UTC`])
    else {
      const regimeCol = sess.regime === 'quiet' ? '#4CAF50' : sess.regime === 'busy' ? '#FF9800' : '#d1d4dc'
      rows.push(['Regime', `${sess.regime} · ATR ${fmt(sess.atr)} · ratio ${Number.isNaN(sess.atrRatio) ? '—' : sess.atrRatio.toFixed(2)} · risk ${sess.riskPct}%`, regimeCol])
      for (const od of sess.orders) {
        const name = od.side > 0 ? 'Long @ VAL' : 'Short @ VAH'
        if (od.status === 'skipped-side') continue
        if (od.status === 'skipped-rr') rows.push([name, `skip · R:R ${od.rrLevel.toFixed(2)} < ${o.minRR}`, '#787B86'])
        else if (od.status === 'skipped-through') rows.push([name, 'skip · price already through at 07:00', '#787B86'])
        else {
          const t = od.trade
          const state = t ? (t.exitReason ? `${t.exitReason} ${(t.r ?? 0) >= 0 ? '+' : ''}${(t.r ?? 0).toFixed(2)}R` : 'IN TRADE') : od.status.toUpperCase()
          rows.push([name, `${state} · ${fmt(od.entry)} / SL ${fmt(od.stop)} / TP ${fmt(od.target)} · qty ${fmtQty(qtyOf(o.account, sess.riskPct, od))}`, od.side > 0 ? s.long : s.short])
        }
      }
    }
  }
  if (r.next) {
    const day = new Date(r.next.start + 86_400_000 - 1).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    rows.push([`Next (${day})`, `VAH ${fmt(r.next.vah)} · POC ${fmt(r.next.poc)} · VAL ${fmt(r.next.val)} · orders at ${String(o.windowStartUTC).padStart(2, '0')}:00 UTC`, '#FFEB3B'])
  }
  rows.push(['History', `${st.n} trades · win ${st.winRate.toFixed(0)}% · ${st.netR >= 0 ? '+' : ''}${st.netR.toFixed(1)}R · avg ${st.avgR.toFixed(2)}R · PF ${Number.isFinite(st.pf) ? st.pf.toFixed(2) : '∞'} · maxDD ${st.maxDD.toFixed(1)}R`])
  rows.push(['Loaded', `${r.sessions.length} sessions — scroll left to load more history`, '#787B86'])
  if (!r.atrFrom5m) rows.push(['Note', 'built for 5m — ATR read from this timeframe', '#FF9800'])

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
  g.fillStyle = '#FFEB3B'
  g.fillText('TPO VA Fade', x + 7, y + rowH / 2 + 1)
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
