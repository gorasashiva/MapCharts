// "Bullseye Order Flow" — port of BullsEyeOF.pine (MPL 2.0, © goofyfarmer), its default
// "Fast Replay / Lightweight (Geometric Proxy)" engine. Math: src/overlays/bullseyeModel.ts.
// Drawn through the canvas-indicator hook (CanvasSource in custom-indicators.ts):
//   • effort vs. reward candle colours, painted over the chart's candles (candle / hollow charts),
//   • a buy (gold) / sell (purple) volume profile per Cash (09:30–16:00 New York) and Overnight session,
//     with VPOC, VAH / VAL and a Dalton shape badge [D] [P] [b] [B] (plus the LVN on B shapes),
//   • key levels at the right margin: ON-HIGH / ON-LOW, half-back, ON-POC, PD-HIGH / PD-LOW, C-POC,
//     a confluent POC and the virgin POC,
//   • a small dashboard with the session's shape, where price sits against value, and the last bar's state.
// Order flow engine: our own Volume Footprint (Power tools → Footprint, exact taker trades per price row)
// stands in for the script's TradingView footprint — exact delta, stacked diagonal imbalances (projected
// as shelves), boundary absorption and trapped traders. Bars the footprint hasn't built fall back to the
// script's geometric proxy (candle shape), and the dashboard says how many bars used which.

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { computeBullseye, type BullseyeProfile, type BullseyeResult, type CandleState } from '../../src/overlays/bullseyeModel'
import { footprintBars } from '../../src/overlays/footprintBarStore'
import { rgba, type Rect } from './canvasPlot'
import type { CanvasIndicatorContext } from './shankyCombo'

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const G_E = 'Effort & candles'
const G_P = 'Session profiles'
const G_L = 'Key levels'
const G_D = 'Display'

export const bullseyeOf: IndicatorDef = {
  id: 'bullseye_of',
  label: 'Bullseye Order Flow — absorption candles, session profiles and AMT levels',
  shortLabel: 'Bullseye OF',
  placement: 'overlay',
  params: [
    {
      key: 'engine',
      label: 'Order flow engine',
      default: 0,
      group: G_E,
      options: [
        { value: 0, label: 'Footprint where available (our Volume Footprint), else candle shape' },
        { value: 1, label: 'Candle shape only (geometric proxy)' },
      ],
    },
    { key: 'effort', label: 'Institutional effort sensitivity (1 loose – 10 strict)', default: 5, min: 1, max: 10, step: 1, group: G_E },
    toggle('showCandles', 'Colour candles by effort vs. reward', true, G_E),
    toggle('showShelves', 'Project stacked imbalance shelves (footprint bars)', true, G_E),
    toggle('showProfiles', 'Show session volume profiles', true, G_P),
    toggle('showPoc', 'Show session VPOC', true, G_P),
    toggle('showVa', 'Show session VAH / VAL', true, G_P),
    toggle('showShapes', 'Show profile shape badges', true, G_P),
    { key: 'sessions', label: 'Completed sessions to show', default: 15, min: 1, max: 35, step: 1, group: G_P },
    { key: 'profWidth', label: 'Profile width (bars, 0 = auto)', default: 0, min: 0, max: 60, step: 1, group: G_P },
    toggle('showLevels', 'Show key levels at the right margin', true, G_L),
    toggle('showHud', 'Show dashboard', true, G_D),
  ],
  compute: () => [],
}

// The script's default palette.
const C = {
  gold: '#FFD700',
  purple: '#AB47BC',
  bullDrive: '#00E676',
  bearDrive: '#FF1744',
  bull: '#26A69A',
  bear: '#EF5350',
  muted: '#373C4B',
  poc: '#FFFFFF',
  va: '#00E5FF',
  halfBack: '#FF9800',
  confluent: '#CE93D8',
  lvn: '#E040FB',
}
const STATE_COLOR: Record<CandleState, string> = {
  gold: C.gold,
  purple: C.purple,
  muted: C.muted,
  bullDrive: C.bullDrive,
  bearDrive: C.bearDrive,
  bull: C.bull,
  bear: C.bear,
}
const STATE_NAME: Record<CandleState, string> = {
  gold: 'Demand absorption',
  purple: 'Supply absorption',
  muted: 'Dead volume / chop',
  bullDrive: 'Initiative bull drive',
  bearDrive: 'Initiative bear drive',
  bull: 'Standard bull bar',
  bear: 'Standard bear bar',
}

/** Chart interval ('1m', '5m', '1h', 'D', …) as milliseconds. */
function intervalMs(iv: string | undefined): number {
  if (!iv) return 60_000
  if (iv === 'D' || iv === '1D') return 86_400_000
  const m = /^(\d+)([mhdw])$/i.exec(iv)
  if (!m) return 60_000
  const unit = m[2].toLowerCase()
  return Number(m[1]) * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000)
}

export interface BullseyeModel {
  res: BullseyeResult
  tfMs: number
  opts: Record<string, boolean>
  profWidth: number
}

export function computeBullseyeModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): BullseyeModel {
  const tfMs = intervalMs(ctx.interval)
  const sessions = Math.max(1, Math.round(p.sessions ?? 15))
  // Footprint engine: per-price bought / sold volume of each bar, published by our Volume Footprint
  // (Power tools → Footprint) for this symbol and timeframe; bars it hasn't built use the candle shape.
  const flow = Math.round(p.engine ?? 0) === 0 ? footprintBars(`${ctx.symbol}|${ctx.interval}`) : undefined
  const res = computeBullseye(candles, tfMs, { effort: Math.max(1, Math.min(10, p.effort ?? 5)) }, sessions + 1, Date.now(), flow)
  const b = (k: string, d = true): boolean => (p[k] ?? (d ? 1 : 0)) !== 0
  // the script's auto width: about 18 bars on 5m, narrower on higher timeframes
  const tfSec = tfMs / 1000
  const auto = tfSec <= 30 ? 26 : tfSec <= 180 ? 22 : tfSec <= 300 ? 18 : tfSec <= 900 ? 14 : tfSec <= 3600 ? 12 : 8
  return {
    res,
    tfMs,
    opts: {
      candles: b('showCandles') && (ctx.chartType === 'candles' || ctx.chartType === 'hollow'),
      shelves: b('showShelves'),
      footprintOn: Math.round(p.engine ?? 0) === 0,
      profiles: b('showProfiles'),
      poc: b('showPoc'),
      va: b('showVa'),
      shapes: b('showShapes'),
      levels: b('showLevels'),
      hud: b('showHud'),
    },
    profWidth: Math.round(p.profWidth ?? 0) > 0 ? Math.round(p.profWidth) : auto,
  }
}

const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const fmt = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 1 : 2 })

function drawProfile(g: CanvasRenderingContext2D, conv: Converters, p: BullseyeProfile, barW: number, widthBars: number, m: BullseyeModel): void {
  const x0 = conv.timeToX(p.start) - barW / 2
  const xEnd = conv.timeToX(p.end) + barW / 2
  const W = widthBars * barW
  const rows = p.buy.length
  let max = 0
  for (let k = 0; k < rows; k++) max = Math.max(max, p.buy[k], p.sell[k])
  if (m.opts.profiles && max > 0) {
    for (const [vals, color] of [
      [p.buy, C.gold],
      [p.sell, C.purple],
    ] as const) {
      g.beginPath()
      g.moveTo(x0, conv.priceToY(p.lo))
      for (let k = 0; k < rows; k++) g.lineTo(x0 + (vals[k] / max) * W, conv.priceToY(p.lo + (k + 0.5) * p.step))
      g.lineTo(x0, conv.priceToY(p.hi))
      g.closePath()
      g.fillStyle = rgba(color, 0.08)
      g.fill()
      g.strokeStyle = rgba(color, 0.8)
      g.lineWidth = 1.5
      g.stroke()
    }
  }
  const line = (price: number, color: string, width: number, dash: number[]): void => {
    const y = Math.round(conv.priceToY(price)) + 0.5
    g.setLineDash(dash)
    g.strokeStyle = color
    g.lineWidth = width
    g.beginPath()
    g.moveTo(x0, y)
    g.lineTo(xEnd, y)
    g.stroke()
    g.setLineDash([])
  }
  if (m.opts.va) {
    line(p.vah, rgba(C.va, 0.65), 1, [])
    line(p.val, rgba(C.va, 0.65), 1, [])
  }
  if (m.opts.poc) line(p.poc, C.poc, 2, [])
  if (p.lvn !== null) line(p.lvn, rgba(C.lvn, 0.9), 1, [2, 3])
  if (m.opts.shapes) {
    g.font = FONT
    g.textAlign = 'left'
    g.textBaseline = 'bottom'
    g.fillStyle = p.kind === 'cash' ? C.gold : C.purple
    g.fillText(`[${p.shape}] ${p.kind === 'cash' ? 'Cash' : 'ON'}`, x0 + 2, conv.priceToY(p.hi) - 2)
  }
}

export function drawBullseye(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: BullseyeModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  const right = rect.x + rect.width
  const barW = Math.max(1, Math.abs(conv.timeToX(candles[candles.length - 1].time) - conv.timeToX(candles[candles.length - 2].time)))
  const { profiles, levels, states } = m.res

  // 1. session profiles, VPOC, VA, shape
  for (const p of profiles) {
    const x0 = conv.timeToX(p.start)
    const x1 = conv.timeToX(p.end)
    if (x1 < rect.x - m.profWidth * barW || x0 > right) continue
    drawProfile(g, conv, p, barW, m.profWidth, m)
  }

  // 2. stacked imbalance shelves (footprint bars): gold = buy stack (demand), purple = sell stack (supply),
  //    from the bar that printed it until a bar closes through it
  if (m.opts.shelves) {
    g.font = FONT
    for (const s of m.res.shelves) {
      const x0 = conv.timeToX(s.from) - barW / 2
      const x1 = s.end !== null ? conv.timeToX(s.end) : right
      if (x1 < rect.x || x0 > right) continue
      const yTop = conv.priceToY(s.hi)
      const yBot = conv.priceToY(s.lo)
      const col = s.side === 'bull' ? C.gold : C.purple
      g.fillStyle = rgba(col, s.end === null ? 0.1 : 0.05)
      g.fillRect(x0, Math.min(yTop, yBot), Math.max(1, x1 - x0), Math.max(1, Math.abs(yBot - yTop)))
      g.strokeStyle = rgba(col, s.end === null ? 0.7 : 0.3)
      g.lineWidth = 1
      g.strokeRect(x0, Math.min(yTop, yBot), Math.max(1, x1 - x0), Math.max(1, Math.abs(yBot - yTop)))
      g.textAlign = 'left'
      g.textBaseline = 'bottom'
      g.fillStyle = rgba(col, 0.9)
      g.fillText(s.side === 'bull' ? 'BUY IMB' : 'SELL IMB', x0 + 2, Math.min(yTop, yBot) - 1)
    }
  }

  // 3. effort vs. reward candles, painted over the chart's own candles
  if (m.opts.candles) {
    const bodyW = Math.max(1, barW * 0.7)
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]
      const x = conv.timeToX(c.time)
      if (x < rect.x - barW || x > right + barW) continue
      const col = STATE_COLOR[states[i]]
      g.strokeStyle = col
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(Math.round(x) + 0.5, conv.priceToY(c.high))
      g.lineTo(Math.round(x) + 0.5, conv.priceToY(c.low))
      g.stroke()
      const yO = conv.priceToY(c.open)
      const yC = conv.priceToY(c.close)
      g.fillStyle = col
      g.fillRect(x - bodyW / 2, Math.min(yO, yC), bodyW, Math.max(1, Math.abs(yC - yO)))
    }
  }

  // 3. key levels as short dashes at the right margin, with labels
  if (m.opts.levels) {
    const marks: { price: number; label: string; color: string; dash: number[] }[] = []
    const add = (price: number | null, label: string, color: string, dash: number[] = []): void => {
      if (price !== null && Number.isFinite(price)) marks.push({ price, label, color, dash })
    }
    add(levels.onHigh, 'ON-HIGH', C.purple)
    add(levels.onLow, 'ON-LOW', C.purple)
    add(levels.halfBack, 'ON-HB', C.halfBack, [5, 4])
    add(levels.onPoc, 'ON-POC', C.poc)
    add(levels.pdHigh, 'PD-HIGH', C.gold)
    add(levels.pdLow, 'PD-LOW', C.gold)
    add(levels.priorCashPoc, 'C-POC', C.poc)
    add(levels.confluentPoc, 'CONFLUENT POC', C.confluent)
    g.font = FONT
    const used: number[] = []
    for (const mk of marks.sort((a, b) => b.price - a.price)) {
      const y = Math.round(conv.priceToY(mk.price)) + 0.5
      if (y < rect.y || y > rect.y + rect.height) continue
      g.setLineDash(mk.dash)
      g.strokeStyle = mk.color
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(right - 70, y)
      g.lineTo(right - 6, y)
      g.stroke()
      g.setLineDash([])
      if (used.some((u) => Math.abs(u - y) < 11)) continue // close levels share one label
      used.push(y)
      g.textAlign = 'right'
      g.textBaseline = 'middle'
      g.fillStyle = mk.color
      g.fillText(`${mk.label} ${fmt(mk.price)}`, right - 74, y)
    }
    // virgin POC: a dotted trace from its session's end to the live bar while untouched
    if (levels.virginPoc) {
      const y = Math.round(conv.priceToY(levels.virginPoc.price)) + 0.5
      g.setLineDash([2, 3])
      g.strokeStyle = rgba(C.poc, 0.7)
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(conv.timeToX(levels.virginPoc.from), y)
      g.lineTo(right, y)
      g.stroke()
      g.setLineDash([])
    }
  }

  // 4. dashboard
  if (m.opts.hud) {
    const cur = profiles[profiles.length - 1]
    const last = candles[candles.length - 1]
    if (cur && last) {
      const where = last.close > cur.vah ? 'above value (VAH)' : last.close < cur.val ? 'below value (VAL)' : 'inside value'
      const rows = [
        `${cur.kind === 'cash' ? 'Cash' : 'Overnight'} profile [${cur.shape}]  ·  price ${where}`,
        `Session delta ${(cur.deltaShare * 100).toFixed(1)}%`,
        `Last bar: ${STATE_NAME[states[states.length - 1]]}`,
        m.res.footprintBars > 0
          ? `Flow: footprint (exact trades) on ${m.res.footprintBars} of ${candles.length} bars, candle shape on the rest`
          : m.opts.footprintOn
            ? 'Flow: candle shape — no exact-trade footprint bars yet (Power tools → Footprint; tape recorder for history)'
            : 'Flow: estimated from candle shape',
      ]
      g.font = FONT
      const w = Math.max(...rows.map((r) => g.measureText(r).width)) + 16
      const h = rows.length * 14 + 10
      const x = right - w - 8
      const y = rect.y + rect.height - h - 8
      g.fillStyle = 'rgba(12, 15, 24, 0.85)'
      g.fillRect(x, y, w, h)
      g.textAlign = 'left'
      g.textBaseline = 'top'
      rows.forEach((r, i) => {
        g.fillStyle = i === 2 ? STATE_COLOR[states[states.length - 1]] : 'rgba(230, 233, 239, 0.95)'
        g.fillText(r, x + 8, y + 6 + i * 14)
      })
    }
  }
  g.restore()
}
