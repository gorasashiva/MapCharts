// "VP Fade 1:2" — the Volume Profile Playbook FADE with a minimum 1:2 reward:risk, as chart signals.
// Math: src/overlays/vpFadeModel.ts (same rules as research/vp-fade-ltf.ts). Drawn through the
// canvas-indicator hook (CanvasSource in custom-indicators.ts); trades also go to the Strategy Tester.
//
// Each trade: a marker on the entry bar, a red risk box (entry → stop) and a green reward box
// (entry → T2) until the trade ends, a dashed T1 (POC) line, and a label with entry, SL, T1 and T2
// prices and their R multiples. The exit dot shows the result in R (net of the cost setting).
// Tags that were skipped because T1 was under the minimum R:R are shown as small grey crosses.
// Research: 15m with a 0.2 stop is the tested setup; 3m with a 0.3 stop is a candidate (Auto picks these).

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import type { StrategyTrade } from '../../src/strategy/types'
import { computeVpFade, type VpFadeDay, type VpFadeSignal } from '../../src/overlays/vpFadeModel'
import { COL, PALETTE, colorOpts } from './flyingCpr'
import { rgba, type Rect } from './canvasPlot'
import type { CanvasIndicatorContext } from './shankyCombo'

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const G_R = 'Rules'
const G_D = 'Display'

export const vpFade: IndicatorDef = {
  id: 'vp_fade',
  label: 'VP Fade 1:2 — fade prior VAH / VAL to POC, min 1:2 reward:risk',
  shortLabel: 'VP Fade 1:2',
  placement: 'overlay',
  params: [
    {
      key: 'stopK',
      label: 'Stop beyond the value edge',
      default: 0,
      options: [
        { value: 0, label: 'Auto (3m: 0.3 VA, else 0.2 VA)' },
        { value: 0.1, label: '0.1 × value width' },
        { value: 0.2, label: '0.2 × value width' },
        { value: 0.3, label: '0.3 × value width' },
      ],
      group: G_R,
    },
    { key: 'minRR', label: 'Minimum reward:risk to T1 (POC)', default: 2, min: 1, max: 5, step: 0.5, group: G_R },
    { key: 'costBps', label: 'Round-trip cost (bps) for net R', default: 4, min: 0, max: 50, step: 1, group: G_R },
    toggle('showLevels', 'Show prior VAH / VAL / POC', true, G_D),
    toggle('showSkipped', 'Show skipped tags (R:R too low)', true, G_D),
    toggle('showLabels', 'Show price labels', true, G_D),
    toggle('showStats', 'Show stats box', true, G_D),
    { key: 'colorLong', label: 'Long colour', default: (COL as Record<string, number>).Green ?? 0, options: colorOpts, group: G_D },
    { key: 'colorShort', label: 'Short colour', default: (COL as Record<string, number>).Red ?? 0, options: colorOpts, group: G_D },
  ],
  compute: () => [],
}

export interface VpFadeModel {
  days: VpFadeDay[]
  signals: VpFadeSignal[]
  stopK: number
  minRR: number
  showLevels: boolean
  showSkipped: boolean
  showLabels: boolean
  showStats: boolean
  colorLong: string
  colorShort: string
  decimals: number
}

const GOLD = /XAU|PAXG|GOLD/i
const hexOf = (idx: number, fallback: string): string => (PALETTE[idx] ? PALETTE[idx][1] : fallback)

export function computeVpFadeModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): VpFadeModel {
  const stopK = p.stopK && p.stopK > 0 ? p.stopK : ctx.interval === '3m' ? 0.3 : 0.2
  const minRR = Math.max(0.5, p.minRR ?? 2)
  const res = computeVpFade(candles, { stopK, minRR, costBps: Math.max(0, p.costBps ?? 4), goldDay: GOLD.test(ctx.symbol) })
  const last = candles[candles.length - 1]?.close ?? 1
  return {
    ...res,
    stopK,
    minRR,
    showLevels: (p.showLevels ?? 1) !== 0,
    showSkipped: (p.showSkipped ?? 1) !== 0,
    showLabels: (p.showLabels ?? 1) !== 0,
    showStats: (p.showStats ?? 1) !== 0,
    colorLong: hexOf(Math.round(p.colorLong ?? (COL as Record<string, number>).Green), '#4CAF50'),
    colorShort: hexOf(Math.round(p.colorShort ?? (COL as Record<string, number>).Red), '#F44336'),
    decimals: last >= 1000 ? 1 : last >= 10 ? 2 : 4,
  }
}

/** Taken trades for the Strategy Tester (exit price blends the two halves). */
export function vpFadeTrades(model: unknown): StrategyTrade[] {
  return (model as VpFadeModel).signals
    .filter((s) => s.taken)
    .map((s) => ({
      side: s.side,
      entryTime: s.entryTime,
      entryPrice: s.entry,
      exitTime: s.exit?.time ?? null,
      exitPrice: s.exit?.price ?? null,
      exitReason: s.exit?.reason,
      stop: s.stop,
    }))
}

const FONT = "600 10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const FONT_SMALL = "500 9px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const IST = (t: number): string => {
  const d = new Date(t + 5.5 * 3_600_000)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} IST`
}

export function drawVpFade(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: VpFadeModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2) return
  const right = rect.x + rect.width
  const lastT = candles[candles.length - 1].time
  const barW = Math.max(1, Math.abs(conv.timeToX(candles[1].time) - conv.timeToX(candles[0].time)))
  const fx = (v: number): string => v.toFixed(m.decimals)
  // zoomed out: keep the shapes, drop the small text so labels don't pile up
  const roomy = barW >= 3
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()

  // Prior value levels on each day (solid when the day opened inside value, faint otherwise).
  if (m.showLevels) {
    g.font = FONT_SMALL
    g.textBaseline = 'bottom'
    g.textAlign = 'left'
    for (const d of m.days) {
      const x0 = conv.timeToX(d.start)
      const x1 = Math.min(right, d.end >= lastT ? right : conv.timeToX(d.end) + barW)
      if (x1 < rect.x || x0 > right) continue
      const a = d.open === 'inside' ? 0.75 : 0.3
      for (const [v, name, c] of [
        [d.vah, 'pVAH', `rgba(120, 170, 255, ${a})`],
        [d.poc, 'pPOC', `rgba(255, 200, 80, ${a})`],
        [d.val, 'pVAL', `rgba(120, 170, 255, ${a})`],
      ] as const) {
        const y = conv.priceToY(v)
        g.strokeStyle = c
        g.lineWidth = 1
        g.setLineDash(name === 'pPOC' ? [2, 3] : [])
        g.beginPath()
        g.moveTo(Math.max(rect.x, x0), y)
        g.lineTo(x1, y)
        g.stroke()
        if (roomy && x0 >= rect.x && x1 - x0 > 40) {
          g.fillStyle = c
          g.fillText(name, x0 + 2, y - 1)
        }
      }
      g.setLineDash([])
    }
  }

  for (const s of m.signals) {
    const x = conv.timeToX(s.entryTime)
    if (!s.taken) {
      if (!m.showSkipped) continue
      const xs = conv.timeToX(s.signalTime)
      if (xs < rect.x - 10 || xs > right + 10) continue
      const y = conv.priceToY(s.entry)
      g.strokeStyle = 'rgba(160, 165, 175, 0.8)'
      g.lineWidth = 1.5
      g.beginPath()
      g.moveTo(xs - 3, y - 3)
      g.lineTo(xs + 3, y + 3)
      g.moveTo(xs + 3, y - 3)
      g.lineTo(xs - 3, y + 3)
      g.stroke()
      if (m.showLabels && roomy) {
        g.font = FONT_SMALL
        g.fillStyle = 'rgba(160, 165, 175, 0.9)'
        g.textAlign = 'left'
        g.textBaseline = 'middle'
        g.fillText(`skip R:R ${s.rr1.toFixed(1)}`, xs + 6, y)
      }
      continue
    }
    const xEnd = s.exit ? Math.min(right, conv.timeToX(s.exit.time) + barW / 2) : right
    if (xEnd < rect.x || x > right + 10) continue
    const colour = s.side === 'long' ? m.colorLong : m.colorShort
    const yE = conv.priceToY(s.entry)
    const yS = conv.priceToY(s.stop)
    const y1 = conv.priceToY(s.t1)
    const y2 = conv.priceToY(s.t2)
    const xl = Math.max(rect.x, x)
    // risk and reward boxes
    g.fillStyle = 'rgba(244, 67, 54, 0.14)'
    g.fillRect(xl, Math.min(yE, yS), xEnd - xl, Math.abs(yS - yE))
    g.fillStyle = 'rgba(76, 175, 80, 0.12)'
    g.fillRect(xl, Math.min(yE, y2), xEnd - xl, Math.abs(y2 - yE))
    // entry, stop, T1, T2 lines
    const line = (y: number, c: string, dash: number[], w = 1): void => {
      g.strokeStyle = c
      g.lineWidth = w
      g.setLineDash(dash)
      g.beginPath()
      g.moveTo(xl, y)
      g.lineTo(xEnd, y)
      g.stroke()
    }
    line(yE, rgba(colour, 0.95), [], 1.5)
    line(yS, 'rgba(244, 67, 54, 0.9)', [])
    line(y1, 'rgba(76, 175, 80, 0.9)', [4, 3])
    line(y2, 'rgba(76, 175, 80, 0.9)', [])
    g.setLineDash([])
    // entry marker
    const up = s.side === 'long'
    if (x >= rect.x - 6) {
      const base = yE + (up ? 10 : -10)
      const tip = base + (up ? 8 : -8)
      g.beginPath()
      g.moveTo(x, base)
      g.lineTo(x - 5, tip)
      g.lineTo(x + 5, tip)
      g.closePath()
      g.fillStyle = rgba(colour, 0.95)
      g.fill()
    }
    // labels
    if (m.showLabels && x >= rect.x - 4) {
      g.font = FONT_SMALL
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      const tag = (y: number, text: string, c: string): void => {
        const w = g.measureText(text).width + 6
        g.fillStyle = 'rgba(12, 14, 20, 0.72)'
        g.fillRect(x + 4, y - 6, w, 12)
        g.fillStyle = c
        g.fillText(text, x + 7, y)
      }
      tag(yE, `${up ? 'LONG' : 'SHORT'} ${fx(s.entry)}`, rgba(colour, 1))
      tag(yS, `SL ${fx(s.stop)}  −1R`, 'rgba(255, 120, 110, 1)')
      tag(y1, `T1 POC ${fx(s.t1)}  ${s.rr1.toFixed(1)}R · ½ off, SL→BE`, 'rgba(120, 220, 130, 1)')
      // keep the T2 label clear of the T1 label when the two prices are close
      const y2l = Math.abs(y2 - y1) < 13 ? y1 + (y2 >= y1 ? 13 : -13) : y2
      tag(y2l, `T2 ${fx(s.t2)}  ${s.rr2.toFixed(1)}R`, 'rgba(120, 220, 130, 1)')
    }
    // T1 fill and exit
    if (s.exit?.t1Time) {
      const xt = conv.timeToX(s.exit.t1Time)
      if (xt >= rect.x && xt <= right) {
        g.beginPath()
        g.arc(xt, y1, 3, 0, Math.PI * 2)
        g.fillStyle = 'rgba(76, 175, 80, 1)'
        g.fill()
      }
    }
    if (s.exit && xEnd < right) {
      const yX = conv.priceToY(s.exit.price)
      const win = s.exit.netR > 0
      g.beginPath()
      g.arc(xEnd, yX, 3.5, 0, Math.PI * 2)
      g.fillStyle = win ? 'rgba(76, 175, 80, 1)' : 'rgba(244, 67, 54, 1)'
      g.fill()
      g.font = FONT
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      g.fillStyle = win ? 'rgba(120, 220, 130, 1)' : 'rgba(255, 120, 110, 1)'
      g.fillText(`${s.exit.reason} ${s.exit.netR >= 0 ? '+' : ''}${s.exit.netR.toFixed(2)}R`, xEnd + 6, yX)
    }
  }

  if (m.showStats) {
    const done = m.signals.filter((s) => s.taken && s.exit)
    const open = m.signals.filter((s) => s.taken && !s.exit)
    const wins = done.filter((s) => (s.exit?.netR ?? 0) > 0)
    const sumW = wins.reduce((a, s) => a + (s.exit?.netR ?? 0), 0)
    const sumL = -done.filter((s) => (s.exit?.netR ?? 0) <= 0).reduce((a, s) => a + (s.exit?.netR ?? 0), 0)
    const avg = done.length ? done.reduce((a, s) => a + (s.exit?.netR ?? 0), 0) / done.length : 0
    const rows = [
      `VP Fade · stop ${m.stopK} VA · min ${m.minRR}R to POC`,
      `trades ${done.length}  win ${done.length ? Math.round((100 * wins.length) / done.length) : 0}%  avg ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}R  PF ${sumL > 0 ? (sumW / sumL).toFixed(2) : '—'}`,
      `skipped (R:R < ${m.minRR}): ${m.signals.filter((s) => !s.taken).length}`,
    ]
    for (const s of open) rows.push(`OPEN ${s.side.toUpperCase()} ${IST(s.entryTime)} @ ${fx(s.entry)} SL ${fx(s.stop)} T1 ${fx(s.t1)} T2 ${fx(s.t2)}`)
    const today = m.days[m.days.length - 1]
    if (today) rows.push(today.open === 'inside' ? `today: inside value · fade ${fx(today.vah)} / ${fx(today.val)} → ${fx(today.poc)}` : `today: opened ${today.open} value · no fade`)
    g.font = FONT
    const w = Math.max(...rows.map((r) => g.measureText(r).width)) + 16
    const h = 14 * rows.length + 10
    g.fillStyle = 'rgba(12, 14, 20, 0.75)'
    g.fillRect(right - w - 8, rect.y + 24, w, h)
    g.fillStyle = 'rgba(230, 233, 239, 0.95)'
    g.textAlign = 'left'
    g.textBaseline = 'top'
    rows.forEach((r, i) => g.fillText(r, right - w, rect.y + 30 + i * 14))
  }
  g.restore()
}
