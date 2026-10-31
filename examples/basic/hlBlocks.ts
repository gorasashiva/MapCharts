// "1H / 4H Block" — Indicators-menu entry ported from "1h/4h blocks.pine".
// Math: src/overlays/hlBlocksModel.ts. Draws through the canvas-indicator hook
// (see CanvasSource in custom-indicators.ts): HIGH zones (red) and LOW zones
// (green) where the last closed lower-TF and higher-TF highs / lows align; the
// newest zone of each side extends right.
//
// Not ported: alertcondition() calls (no alert hook for canvas indicators) and
// the zone colour inputs (fixed to the script's red / green defaults).

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { INTERVAL_MS, type Interval } from '../../src/core/types'
import { HL_BLOCKS_DEFAULTS, computeHlBlocks, tfName, type HlBlocksOptions, type HlBlocksResult } from '../../src/overlays/hlBlocksModel'
import { detectChartSec } from '../../src/overlays/mtfCisdModel'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const D = HL_BLOCKS_DEFAULTS
const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })

const TF_OPTIONS = [300, 900, 1800, 3600, 7200, 14_400, 86_400].map((v) => ({ value: v, label: tfName(v) }))

const G_T = 'Timeframes'
const G_C = 'Closeness'
const G_D = 'Display'

export const hlBlocks: IndicatorDef = {
  id: 'hl_blocks_1h_4h',
  label: '1H/4H Block',
  shortLabel: '1H/4H Block',
  placement: 'overlay',
  params: [
    { key: 'tfLow', label: 'Lower timeframe', default: D.tfLow, options: TF_OPTIONS, group: G_T },
    { key: 'tfHigh', label: 'Higher timeframe', default: D.tfHigh, options: TF_OPTIONS, group: G_T },

    { key: 'tolMode', label: 'Tolerance mode', default: 0, options: [{ value: 0, label: 'Percent' }, { value: 1, label: 'ATR' }], group: G_C },
    num('tolPct', 'Tolerance (%)', D.tolPct, G_C, 0, 10, 0.01),
    num('tolAtrMult', 'Tolerance (× ATR of lower TF)', D.tolAtrMult, G_C, 0, 10, 0.05),
    num('atrLen', 'ATR length', D.atrLen, G_C, 1, 200, 1),
    num('minHeightF', 'Min zone height (fraction of tolerance)', D.minHeightF, G_C, 0, 5, 0.05),
    toggle('onePerHigh', 'Only one zone per higher-TF candle', D.onePerHigh, G_C),

    toggle('showHigh', 'Show HIGH zones', D.showHigh, G_D),
    toggle('showLow', 'Show LOW zones', D.showLow, G_D),
    toggle('showText', 'Show zone label', true, G_D),
    num('maxZones', 'Max zones kept per side', D.maxZones, G_D, 1, 240, 1),
  ],
  compute: () => [],
}

export interface HlBlocksModel {
  showText: boolean
  label: string
  result: HlBlocksResult
}

export function computeHlBlocksModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): HlBlocksModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const opts: HlBlocksOptions = {
    tfLow: n('tfLow', D.tfLow),
    tfHigh: n('tfHigh', D.tfHigh),
    tolMode: n('tolMode', 0) === 1 ? 'atr' : 'percent',
    tolPct: Math.max(0, n('tolPct', D.tolPct)),
    tolAtrMult: Math.max(0, n('tolAtrMult', D.tolAtrMult)),
    atrLen: Math.max(1, Math.round(n('atrLen', D.atrLen))),
    minHeightF: Math.max(0, n('minHeightF', D.minHeightF)),
    onePerHigh: b('onePerHigh', D.onePerHigh),
    showHigh: b('showHigh', D.showHigh),
    showLow: b('showLow', D.showLow),
    maxZones: Math.max(1, Math.round(n('maxZones', D.maxZones))),
  }
  const intervalMs = ctx.interval ? INTERVAL_MS[ctx.interval as Interval] : undefined
  const chartSec = intervalMs ? intervalMs / 1000 : detectChartSec(candles)
  return {
    showText: b('showText', true),
    label: `${tfName(opts.tfLow)}/${tfName(opts.tfHigh)}`,
    result: computeHlBlocks(candles, opts, chartSec),
  }
}

// ---------------------------------------------------------------------------
// Drawing — the script's colours: color.new(red / green, 80) fill, 40 border
// ---------------------------------------------------------------------------
const C = {
  hiFill: 'rgba(242, 54, 69, 0.2)',
  hiBorder: 'rgba(242, 54, 69, 0.6)',
  loFill: 'rgba(8, 153, 129, 0.2)',
  loBorder: 'rgba(8, 153, 129, 0.6)',
  dim: '#8b8f9a',
  noteBg: 'rgba(19, 23, 34, 0.92)',
}
const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

export function drawHlBlocks(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], model: HlBlocksModel): void {
  if (candles.length < 2) return
  const { result: r } = model
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  g.font = `600 10px ${FONT_FAMILY}`
  g.textAlign = 'left'
  g.textBaseline = 'top'

  if (r.error) {
    // Bottom-left on a dark pill, clear of the legend, the top-left widgets and the drawing toolbar.
    const text = `1H/4H Block — ${r.error}`
    const x = rect.x + 72
    const y = rect.y + rect.height - 26
    g.fillStyle = C.noteBg
    g.fillRect(x - 6, y - 3, g.measureText(text).width + 12, 18)
    g.fillStyle = C.dim
    g.fillText(text, x, y + 1)
    g.restore()
    return
  }

  const t0 = conv.xToTime(rect.x)
  const t1 = conv.xToTime(rect.x + rect.width)
  const xEnd = rect.x + rect.width
  for (const z of r.zones) {
    if (z.left > t1 || (z.right !== null && z.right < t0)) continue
    const x1 = Math.round(conv.timeToX(z.left))
    const x2 = z.right === null ? xEnd : Math.round(conv.timeToX(z.right))
    const yTop = Math.round(conv.priceToY(z.top))
    const h = Math.max(1, Math.round(conv.priceToY(z.bottom)) - yTop)
    const hi = z.side === 'high'
    g.fillStyle = hi ? C.hiFill : C.loFill
    g.fillRect(x1, yTop, x2 - x1, h)
    g.strokeStyle = hi ? C.hiBorder : C.loBorder
    g.lineWidth = 1
    g.strokeRect(x1 + 0.5, yTop + 0.5, x2 - x1 - 1, h - 1)
    if (model.showText) {
      g.fillStyle = hi ? C.hiBorder : C.loBorder
      g.fillText(`${model.label} ${hi ? 'High' : 'Low'}`, Math.max(x1, rect.x) + 3, yTop + 2)
    }
  }
  g.restore()
}
