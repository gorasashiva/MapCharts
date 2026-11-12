// "TPO Strategy Signals" — the Volume Profile / TPO framework's rules as chart signals, on the TPO
// day profile. Math: src/overlays/tpoStrategyModel.ts. Drawn through the canvas-indicator hook
// (CanvasSource in custom-indicators.ts).
//
// Each signal is a marker at its entry bar, with dashed entry / stop / target lines until the trade
// resolves (win at target, loss at stop, or the day's close). Open structure and day type are shown
// on each TPO day. A box lists the win rate and average R per strategy.
// Implemented: Open Drive, Confluence IB Breakout, Open Rejection Reversal, Gap Fill Reversal, Trend Day.
// Not yet: Tail Reversal, LVA Fill, Double Distribution, Day Two Trend, Engulfing VA, Consolidation Breakout
// (they need order flow or multi-day profile detail).

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { computeTpoStrategies, STRATEGY_DEFAULTS, type StrategyName, type StrategySignal } from '../../src/overlays/tpoStrategyModel'
import { COL, PALETTE, colorOpts } from './flyingCpr'
import { rgba, type Rect } from './canvasPlot'
import type { CanvasIndicatorContext } from './shankyCombo'

const STRATEGIES: { name: StrategyName; short: string; key: string }[] = [
  { name: 'Open Drive', short: 'OD', key: 'onOpenDrive' },
  { name: 'Confluence IB Breakout', short: 'IB', key: 'onIbBreak' },
  { name: 'Open Rejection Reversal', short: 'ORR', key: 'onOrr' },
  { name: 'Gap Fill Reversal', short: 'GAP', key: 'onGap' },
  { name: 'Trend Day', short: 'TD', key: 'onTrend' },
]

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const G_S = 'Strategies'
const G_R = 'Rules'
const G_D = 'Display'

export const tpoStrategy: IndicatorDef = {
  id: 'tpo_strategy',
  label: 'TPO Strategy Signals — VP/TPO framework rules as entries, stops and targets',
  shortLabel: 'TPO Signals',
  placement: 'overlay',
  params: [
    ...STRATEGIES.map((s) => toggle(s.key, `Show ${s.name}`, true, G_S)),
    { key: 'confluencePct', label: 'IB confluence tolerance (% of price)', default: 0.1, min: 0.01, max: 1, step: 0.01, group: G_R },
    { key: 'driveFrac', label: 'Open drive: move as share of first 30 min range', default: 0.5, min: 0.2, max: 1, step: 0.05, group: G_R },
    toggle('showStats', 'Show win rate per strategy', true, G_D),
    { key: 'colorLong', label: 'Long colour', default: (COL as Record<string, number>).Green ?? 0, options: colorOpts, group: G_D },
    { key: 'colorShort', label: 'Short colour', default: (COL as Record<string, number>).Red ?? 0, options: colorOpts, group: G_D },
  ],
  compute: () => [],
}

export interface TpoStrategyModel {
  signals: StrategySignal[]
  days: { start: number; openType: string; dayType: string }[]
  enabled: Set<StrategyName>
  showStats: boolean
  colorLong: string
  colorShort: string
}

const GOLD = /XAU|PAXG|GOLD/i
const hexOf = (idx: number, fallback: string): string => (PALETTE[idx] ? PALETTE[idx][1] : fallback)

export function computeTpoStrategyModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): TpoStrategyModel {
  // Gold days start at 18:00 New York (as the TPO indicator does); other markets at 00:00 UTC.
  const res = computeTpoStrategies(
    candles,
    {
      ...STRATEGY_DEFAULTS,
      dayStartNyHour: GOLD.test(ctx.symbol) ? 18 : null,
      confluencePct: Math.max(0.0001, (p.confluencePct ?? 0.1) / 100),
      driveFrac: Math.max(0.1, p.driveFrac ?? 0.5),
    },
    Date.now(),
  )
  const enabled = new Set<StrategyName>(STRATEGIES.filter((s) => (p[s.key] ?? 1) !== 0).map((s) => s.name))
  return {
    signals: res.signals.filter((s) => enabled.has(s.strategy)),
    days: res.days.map((d) => ({ start: d.start, openType: d.openType, dayType: d.dayType })),
    enabled,
    showStats: (p.showStats ?? 1) !== 0,
    colorLong: hexOf(Math.round(p.colorLong ?? (COL as Record<string, number>).Green), '#4CAF50'),
    colorShort: hexOf(Math.round(p.colorShort ?? (COL as Record<string, number>).Red), '#F44336'),
  }
}

const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

export function drawTpoStrategy(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: TpoStrategyModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  const right = rect.x + rect.width
  const shortName = (n: StrategyName): string => STRATEGIES.find((s) => s.name === n)?.short ?? n

  // Each TPO day: its open structure and day type.
  g.font = FONT
  g.textAlign = 'left'
  g.textBaseline = 'top'
  for (const d of m.days) {
    const x = conv.timeToX(d.start)
    if (x < rect.x || x > right) continue
    g.fillStyle = 'rgba(160, 170, 185, 0.85)'
    g.fillText(`${d.openType} · ${d.dayType}`, x + 3, rect.y + 4)
  }

  for (const s of m.signals) {
    const x = conv.timeToX(s.t)
    if (x < rect.x - 60 || x > right + 60) continue
    const colour = s.side === 'long' ? m.colorLong : m.colorShort
    const endX = Math.min(right, s.exit ? conv.timeToX(s.exit.t) : right)
    // entry, stop and target lines until the trade resolves
    g.setLineDash([4, 3])
    g.lineWidth = 1
    for (const [y, c] of [
      [conv.priceToY(s.entry), rgba(colour, 0.9)],
      [conv.priceToY(s.stop), 'rgba(244, 67, 54, 0.7)'],
      [conv.priceToY(s.target), 'rgba(76, 175, 80, 0.7)'],
    ] as const) {
      g.strokeStyle = c
      g.beginPath()
      g.moveTo(x, y)
      g.lineTo(endX, y)
      g.stroke()
    }
    g.setLineDash([])
    // entry marker: a triangle below the entry for longs, above it for shorts
    const yE = conv.priceToY(s.entry)
    const up = s.side === 'long'
    const base = yE + (up ? 9 : -9)
    const tip = base + (up ? 8 : -8)
    g.beginPath()
    g.moveTo(x, base)
    g.lineTo(x - 5, tip)
    g.lineTo(x + 5, tip)
    g.closePath()
    g.fillStyle = rgba(colour, 0.95)
    g.fill()
    g.textAlign = 'center'
    g.textBaseline = up ? 'top' : 'bottom'
    g.fillStyle = rgba(colour, 1)
    g.fillText(shortName(s.strategy), x, tip + (up ? 2 : -2))
    // exit marker: green for a win, red for a loss, grey when it ends at the day's close
    if (s.exit && s.exit.t <= (candles[candles.length - 1]?.time ?? 0) && endX < right) {
      g.beginPath()
      g.arc(endX, conv.priceToY(s.exit.price), 3, 0, Math.PI * 2)
      g.fillStyle = s.exit.result === 'win' ? 'rgba(76, 175, 80, 1)' : s.exit.result === 'loss' ? 'rgba(244, 67, 54, 1)' : 'rgba(180, 180, 180, 1)'
      g.fill()
    }
  }

  if (m.showStats) {
    const rows: string[] = []
    for (const s of STRATEGIES) {
      if (!m.enabled.has(s.name)) continue
      const done = m.signals.filter((x) => x.strategy === s.name && x.exit)
      if (!done.length) continue
      const wins = done.filter((x) => x.exit?.result === 'win').length
      const decided = done.filter((x) => x.exit?.result !== 'end').length
      const avgR = done.reduce((a, x) => a + (x.exit?.r ?? 0), 0) / done.length
      rows.push(`${s.short}  n ${done.length}  win ${decided ? Math.round((100 * wins) / decided) : 0}%  avg ${avgR.toFixed(2)}R`)
    }
    if (rows.length) {
      g.font = FONT
      g.textAlign = 'right'
      g.textBaseline = 'top'
      const w = 230
      const h = 14 * rows.length + 10
      g.fillStyle = 'rgba(12, 14, 20, 0.7)'
      g.fillRect(right - w - 8, rect.y + 24, w, h)
      g.fillStyle = 'rgba(230, 233, 239, 0.95)'
      rows.forEach((r, i) => g.fillText(r, right - 14, rect.y + 30 + i * 14))
    }
  }
  g.restore()
}
