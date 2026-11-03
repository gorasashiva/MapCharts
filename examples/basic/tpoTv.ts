// "TPO (Time Price Opportunity)" — TradingView's periodic TPO indicator, after its help
// page (support/solutions/43000713306). Math: src/overlays/tpoTvModel.ts. Drawn through the
// canvas-indicator hook (CanvasSource in custom-indicators.ts).
//
// Per period (day / week / month): letter blocks A–Z, a–z (or plain colour blocks when the
// letters don't fit), gradient colours, dimmer outside the value area, consolidated or
// expanded; POC, VAH / VAL, Initial Balance, midpoint, open / close, single prints, poor
// high / low — each level optionally extended until price trades through it; a volume
// profile with its own POC / VA; alerts when price crosses an extended level of a
// completed profile.
//
// Data: the chart's candles. A block shorter than the chart timeframe is raised to it.
// Row size Auto follows TradingView's rule and is fixed once per symbol / timeframe (as
// TradingView recalculates it only when the indicator is added or the chart changes), so
// the profiles never re-bucket as new bars arrive.
// Not ported: TradingView's per-profile split / merge commands (chart context menu).

import type { Candle, IndicatorDef, IndicatorParam } from '../../src/index'
import type { Converters } from '../../src/drawings/types'
import { sessionOpenNyHour } from '../../src/core/session'
import { autoRowSize, computeTpo, dayType, firstTouchAfter, inferTick, tpoLetter, type TpoPeriod, type TpoProfile } from '../../src/overlays/tpoTvModel'
import { COL, PALETTE, colorOpts } from './flyingCpr'
import { askNotificationPermissionOnce, fireSignalAlert } from './signalAlert'
import type { CanvasIndicatorContext } from './shankyCombo'

type Rect = { x: number; y: number; width: number; height: number }

const toggle = (key: string, label: string, def: boolean, group: string): IndicatorParam => ({ key, label, default: def ? 1 : 0, toggle: true, group })
const num = (key: string, label: string, def: number, group: string, min?: number, max?: number, step?: number): IndicatorParam => ({ key, label, default: def, min, max, step, group })
const pick = (key: string, label: string, def: number, group: string, options: { value: number; label: string }[]): IndicatorParam => ({ key, label, default: def, group, options })

const G_IN = 'Inputs'
const G_ST = 'Style'
const G_LV = 'Levels'
const G_VP = 'Volume profile'
const G_AL = 'Alerts'
const BLOCKS_MIN = [5, 10, 15, 30, 60, 120, 240]
const EXTEND = [
  { value: 0, label: 'No' },
  { value: 1, label: 'Until bar intersects' },
  { value: 2, label: 'To the right edge' },
]

export const tpoTv: IndicatorDef = {
  id: 'tpo_tv',
  label: 'TPO (Time Price Opportunity)',
  shortLabel: 'TPO',
  placement: 'overlay',
  params: [
    pick('period', 'Period', 0, G_IN, [
      { value: 0, label: 'Day' },
      { value: 1, label: 'Week' },
      { value: 2, label: 'Month' },
    ]),
    pick('block', 'Block size', 3, G_IN, BLOCKS_MIN.map((m, i) => ({ value: i, label: m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}` }))),
    pick('rowMode', 'Row size', 0, G_IN, [
      { value: 0, label: 'Auto' },
      { value: 1, label: 'Ticks per row' },
    ]),
    num('ticksPerRow', 'Ticks per row', 100, G_IN, 1, 1_000_000, 1),
    num('vaPct', 'Value area %', 70, G_IN, 1, 100, 1),
    num('ibBlocks', 'Initial Balance blocks', 2, G_IN, 1, 52, 1),
    num('sessionHour', 'Day starts at (UTC hour, −1 = market default)', -1, G_IN, -1, 23, 1),

    toggle('blocks', 'Blocks', true, G_ST),
    toggle('letters', 'Letters (when they fit)', true, G_ST),
    pick('upFrom', 'Gradient A–Z from', COL.Blue, G_ST, colorOpts),
    pick('upTo', 'Gradient A–Z to', COL.Aqua, G_ST, colorOpts),
    pick('loFrom', 'Gradient a–z from', COL.Purple, G_ST, colorOpts),
    pick('loTo', 'Gradient a–z to', COL.Fuchsia, G_ST, colorOpts),
    num('outsideVa', 'Opacity outside VA %', 45, G_ST, 0, 100, 5),
    toggle('expand', 'Expand blocks (each at its own time)', false, G_ST),
    toggle('dayType', 'Day type label (normal / variation / trend / neutral)', false, G_ST),

    toggle('poc', 'POC highlight', true, G_LV),
    toggle('pocLabel', 'POC label', true, G_LV),
    pick('pocExt', 'Extend POC', 1, G_LV, EXTEND),
    toggle('va', 'VAH / VAL lines', true, G_LV),
    toggle('vaLabel', 'VAH / VAL labels', true, G_LV),
    pick('vaExt', 'Extend VAH / VAL', 0, G_LV, EXTEND),
    toggle('ib', 'Initial Balance', true, G_LV),
    toggle('mid', 'TPO midpoint label', false, G_LV),
    toggle('openClose', 'Open / close labels', true, G_LV),
    toggle('singles', 'Single prints', true, G_LV),
    pick('singleExt', 'Extend single prints', 0, G_LV, EXTEND),
    toggle('poor', 'Poor high / low', true, G_LV),
    pick('poorExt', 'Extend poor high / low', 1, G_LV, EXTEND),
    pick('levelColor', 'Level colour', COL.White, G_LV, colorOpts),

    toggle('vp', 'Show volume profile', false, G_VP),
    toggle('vpValues', 'Values', false, G_VP),
    toggle('vpPoc', 'Volume POC', true, G_VP),
    toggle('vpVa', 'Volume VAH / VAL', true, G_VP),
    pick('vpColor', 'Volume colour', COL.Gray, G_VP, colorOpts),
    pick('vpVaColor', 'Value area colour', COL.Blue, G_VP, colorOpts),
    pick('vpPlace', 'Placement', 0, G_VP, [
      { value: 0, label: 'Right' },
      { value: 1, label: 'Left' },
    ]),

    toggle('alerts', 'Alert when price crosses an extended level (completed profiles)', true, G_AL),
    toggle('alertSound', 'Alert sound', true, G_AL),
  ],
  compute: () => [],
}

interface Display {
  blocks: boolean
  letters: boolean
  up: [string, string]
  lo: [string, string]
  outside: number
  expand: boolean
  dayType: boolean
  poc: boolean
  pocLabel: boolean
  pocExt: number
  va: boolean
  vaLabel: boolean
  vaExt: number
  ib: boolean
  mid: boolean
  openClose: boolean
  singles: boolean
  singleExt: number
  poor: boolean
  poorExt: number
  level: string
  vp: boolean
  vpValues: boolean
  vpPoc: boolean
  vpVa: boolean
  vpColor: string
  vpVaColor: string
  vpRight: boolean
}

export interface TpoTvModel {
  profiles: TpoProfile[]
  display: Display
  blockMs: number
  note: string
  bars: Candle[]
}

// Auto row size is fixed per chart (symbol / timeframe / row settings), as TradingView does
const rowSizeCache = new Map<string, number>()
const alertSeen = new Map<string, Set<string>>()

const chartBarMs = (candles: Candle[]): number => {
  let ms = Infinity
  for (let i = Math.max(1, candles.length - 50); i < candles.length; i++) ms = Math.min(ms, candles[i].time - candles[i - 1].time)
  return ms
}

export function computeTpoTvModel(candles: Candle[], p: Record<string, number>, ctx: CanvasIndicatorContext): TpoTvModel {
  const b = (k: string, d: boolean): boolean => (p[k] === undefined ? d : p[k] !== 0)
  const n = (k: string, d: number): number => (Number.isFinite(p[k]) ? p[k] : d)
  const col = (k: string, d: number): string => (PALETTE[Math.round(n(k, d))] ?? PALETTE[d])[1]
  const display: Display = {
    blocks: b('blocks', true),
    letters: b('letters', true),
    up: [col('upFrom', COL.Blue), col('upTo', COL.Aqua)],
    lo: [col('loFrom', COL.Purple), col('loTo', COL.Fuchsia)],
    outside: Math.min(1, Math.max(0, n('outsideVa', 45) / 100)),
    expand: b('expand', false),
    dayType: b('dayType', false),
    poc: b('poc', true),
    pocLabel: b('pocLabel', true),
    pocExt: Math.round(n('pocExt', 1)),
    va: b('va', true),
    vaLabel: b('vaLabel', true),
    vaExt: Math.round(n('vaExt', 0)),
    ib: b('ib', true),
    mid: b('mid', false),
    openClose: b('openClose', true),
    singles: b('singles', true),
    singleExt: Math.round(n('singleExt', 0)),
    poor: b('poor', true),
    poorExt: Math.round(n('poorExt', 1)),
    level: col('levelColor', COL.White),
    vp: b('vp', false),
    vpValues: b('vpValues', false),
    vpPoc: b('vpPoc', true),
    vpVa: b('vpVa', true),
    vpColor: col('vpColor', COL.Gray),
    vpVaColor: col('vpVaColor', COL.Blue),
    vpRight: Math.round(n('vpPlace', 0)) === 0,
  }
  const base: TpoTvModel = { profiles: [], display, blockMs: 0, note: '', bars: candles }
  if (candles.length < 2) return base
  const barMs = chartBarMs(candles)
  if (!Number.isFinite(barMs) || barMs <= 0) return base
  const wantMs = (BLOCKS_MIN[Math.round(n('block', 3))] ?? 30) * 60_000
  const blockMs = Math.max(barMs, Math.ceil(wantMs / barMs) * barMs)
  const raised = blockMs !== wantMs ? `TPO: block ${fmtDur(wantMs)} raised to ${fmtDur(blockMs)} (the chart timeframe)` : ''

  const tick = inferTick(candles)
  const manual = Math.round(n('rowMode', 0)) === 1
  const key = `${ctx.symbol}|${ctx.interval ?? barMs}|${manual ? `m${n('ticksPerRow', 100)}` : 'auto'}`
  let rowSize = rowSizeCache.get(key)
  if (rowSize === undefined) {
    rowSize = manual ? Math.max(tick, Math.round(n('ticksPerRow', 100)) * tick) : autoRowSize(candles, tick)
    rowSizeCache.set(key, rowSize)
  }
  const period: TpoPeriod = (['day', 'week', 'month'] as const)[Math.round(n('period', 0))] ?? 'day'
  const hour = n('sessionHour', -1)
  const profiles = computeTpo(candles, {
    period,
    blockMs,
    rowSize,
    valueAreaPct: Math.min(100, Math.max(1, n('vaPct', 70))),
    ibBlocks: Math.max(1, Math.round(n('ibBlocks', 2))),
    // market default: gold opens at 18:00 New York, following US daylight saving; others at 00:00 UTC
    dayStartHourUTC: hour >= 0 ? Math.round(hour) : 0,
    dayStartNyHour: hour >= 0 ? null : sessionOpenNyHour(ctx.symbol),
  })
  // TradingView raises an error when the rows are too fine; here: a note, and those profiles are skipped
  const tooFine = profiles.some((pr) => pr.hi - pr.lo > MAX_ROWS)
  const model: TpoTvModel = { profiles, display, blockMs, note: tooFine ? 'TPO: row size too small for this range — raise Ticks per row' : raised, bars: candles }
  if (b('alerts', true)) runAlerts(model, ctx, b('alertSound', true))
  return model
}

const MAX_ROWS = 2000
const fmtDur = (ms: number): string => (ms >= 3_600_000 ? `${ms / 3_600_000}h` : `${ms / 60_000}m`)
const fmtP = (v: number): string => (Math.abs(v) >= 1000 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toPrecision(5))

/** The extended levels of a profile (those whose Extend is on), at their row's middle. */
function extendedLevels(pr: TpoProfile, d: Display): { kind: string; price: number; ext: number }[] {
  const at = (r: number): number => (r + 0.5) * pr.rowSize
  const out: { kind: string; price: number; ext: number }[] = []
  if (d.poc && d.pocExt) out.push({ kind: 'POC', price: at(pr.poc), ext: d.pocExt })
  if (d.va && d.vaExt) out.push({ kind: 'VAH', price: at(pr.vaHi), ext: d.vaExt }, { kind: 'VAL', price: at(pr.vaLo), ext: d.vaExt })
  if (d.poor && d.poorExt) {
    if (pr.poorHigh) out.push({ kind: 'poor high', price: at(pr.hi), ext: d.poorExt })
    if (pr.poorLow) out.push({ kind: 'poor low', price: at(pr.lo), ext: d.poorExt })
  }
  if (d.singles && d.singleExt) for (const r of pr.singles) out.push({ kind: 'single print', price: at(r), ext: d.singleExt })
  return out
}

// alerts: price crossing an extended level of a completed profile, on a closed bar (as TradingView)
function runAlerts(m: TpoTvModel, ctx: CanvasIndicatorContext, sound: boolean): void {
  const bars = m.bars
  if (bars.length < 3) return
  const key = `${ctx.symbol}|${ctx.interval}`
  let seen = alertSeen.get(key)
  const priming = !seen
  if (!seen) alertSeen.set(key, (seen = new Set()))
  const lastClosed = bars.length - 2
  for (const pr of m.profiles) {
    if (!pr.complete) continue
    for (const l of extendedLevels(pr, m.display)) {
      if (l.ext !== 1) continue // a level that ends where price crosses it
      const i = firstTouchAfter(bars, pr.end, l.price)
      if (i < 0 || i > lastClosed) continue
      const id = `${pr.start}|${l.kind}|${l.price}`
      if (seen.has(id)) continue
      seen.add(id)
      if (priming || i !== lastClosed) continue
      askNotificationPermissionOnce()
      const day = new Date(pr.start + 43_200_000).toISOString().slice(0, 10)
      fireSignalAlert(`TPO · ${ctx.symbol}`, `Price crossed the ${day} profile's extended ${l.kind} at ${fmtP(l.price)}`, sound)
    }
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
const hexRgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}
const mix = (a: string, b: string, t: number, alpha: number): string => {
  const x = hexRgb(a), y = hexRgb(b)
  return `rgba(${Math.round(x[0] + (y[0] - x[0]) * t)}, ${Math.round(x[1] + (y[1] - x[1]) * t)}, ${Math.round(x[2] + (y[2] - x[2]) * t)}, ${alpha})`
}
const rgba = (hex: string, a: number): string => {
  const [r, g, b] = hexRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"

export function drawTpoTv(g: CanvasRenderingContext2D, conv: Converters, rect: Rect, candles: Candle[], m: TpoTvModel, _ctx: CanvasIndicatorContext): void {
  if (candles.length < 2 || !m.profiles.length) {
    if (m.note) note(g, rect, m.note)
    return
  }
  const d = m.display
  const right = rect.x + rect.width
  const spacing = Math.abs(conv.timeToX(candles[candles.length - 1].time) - conv.timeToX(candles[candles.length - 2].time)) || 6
  const blockW = (m.blockMs / chartBarMs(candles)) * spacing
  // consolidated: one column per letter, as wide as a bar (2–16px); expanded: one block wide
  const cellW = d.expand ? blockW : Math.max(2, Math.min(16, spacing))
  const lastX = conv.timeToX(candles[candles.length - 1].time) + spacing / 2
  g.save()
  g.beginPath()
  g.rect(rect.x, rect.y, rect.width, rect.height)
  g.clip()
  g.textBaseline = 'middle'

  for (const pr of m.profiles) {
    if (pr.hi - pr.lo > MAX_ROWS) continue
    const x0 = conv.timeToX(pr.start) - spacing / 2
    const xEnd = Math.min(conv.timeToX(pr.end) - spacing / 2, lastX)
    if (xEnd < rect.x || x0 > right) continue
    const rs = pr.rowSize
    const yOf = (price: number): number => conv.priceToY(price)
    const rowTop = (r: number): number => yOf((r + 1) * rs)
    const rowH = Math.abs(yOf(pr.lo * rs) - yOf((pr.lo + 1) * rs))
    const mid = (r: number): number => yOf((r + 0.5) * rs)
    const showLetters = d.letters && cellW >= 7 && rowH >= 8
    const fontPx = Math.max(7, Math.min(12, Math.floor(Math.min(rowH, cellW) * 0.9)))
    // how far right the letters reach
    let tpoRight = x0 + cellW
    for (const letters of pr.rows.values()) {
      const last = letters[letters.length - 1]
      const x = d.expand ? conv.timeToX(pr.start + last * m.blockMs) - spacing / 2 : x0 + (letters.length - 1) * cellW
      tpoRight = Math.max(tpoRight, x + cellW)
    }
    // single prints, behind the blocks
    if (d.singles) {
      g.fillStyle = 'rgba(255, 214, 0, 0.16)'
      for (const r of pr.singles) g.fillRect(x0, rowTop(r), tpoRight - x0, rowH)
    }
    for (const [r, letters] of pr.rows) {
      const y = rowTop(r)
      if (y > rect.y + rect.height || y + rowH < rect.y) continue
      const alpha = r >= pr.vaLo && r <= pr.vaHi ? 1 : d.outside
      letters.forEach((k, j) => {
        const x = d.expand ? conv.timeToX(pr.start + k * m.blockMs) - spacing / 2 : x0 + j * cellW
        if (x > right || x + cellW < rect.x) return
        const t = (k % 26) / 25
        g.fillStyle = k % 52 >= 26 ? mix(d.lo[0], d.lo[1], t, alpha) : mix(d.up[0], d.up[1], t, alpha)
        if (showLetters) {
          g.font = `600 ${fontPx}px ${FONT}`
          g.textAlign = 'center'
          g.fillText(tpoLetter(k), x + cellW / 2, y + rowH / 2 + 0.5)
        } else if (d.blocks) {
          const gap = rowH > 3 ? 0.5 : 0
          g.fillRect(x + 0.5, y + gap, Math.max(1, cellW - 1), Math.max(1, rowH - 2 * gap))
        }
      })
    }
    const labelX = Math.min(tpoRight + 4, right - 60)
    if (d.poc) {
      g.strokeStyle = rgba(d.level, 0.9)
      g.lineWidth = 1
      g.strokeRect(x0, rowTop(pr.poc), tpoRight - x0, rowH)
      extend(g, conv, candles, pr, mid(pr.poc), (pr.poc + 0.5) * rs, d.pocExt, xEnd, right, rgba(d.level, 0.75), [])
      if (d.pocLabel) label(g, 'POC', labelX, mid(pr.poc), d.level)
    }
    if (d.va) {
      for (const [r, name] of [[pr.vaHi, 'VAH'], [pr.vaLo, 'VAL']] as const) {
        const y = mid(r)
        hline(g, x0, xEnd, y, rgba(d.level, 0.55), [4, 3])
        extend(g, conv, candles, pr, y, (r + 0.5) * rs, d.vaExt, xEnd, right, rgba(d.level, 0.45), [4, 3])
        if (d.vaLabel) label(g, name, labelX, y, d.level)
      }
    }
    // Initial Balance: a vertical line left of the profile
    if (d.ib) {
      g.strokeStyle = rgba(d.up[0], 0.95)
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(x0 - 3, yOf(pr.ib[1]))
      g.lineTo(x0 - 3, yOf(pr.ib[0]))
      g.stroke()
      g.lineWidth = 1
    }
    if (d.openClose) {
      marker(g, x0 - 9, yOf(pr.open), 'O', '#ffb74d')
      marker(g, x0 - 9, yOf(pr.close), 'C', pr.close >= pr.open ? '#26a69a' : '#ef5350')
    }
    if (d.mid) label(g, `Mid ${fmtP(pr.mid)}`, labelX, yOf(pr.mid), d.level)
    if (d.poor) {
      for (const [on, r, name] of [[pr.poorHigh, pr.hi, 'Poor high'], [pr.poorLow, pr.lo, 'Poor low']] as const) {
        if (!on) continue
        const y = mid(r)
        hline(g, x0, xEnd, y, rgba('#FF9800', 0.85), [2, 3])
        extend(g, conv, candles, pr, y, (r + 0.5) * rs, d.poorExt, xEnd, right, rgba('#FF9800', 0.6), [2, 3])
        label(g, name, labelX, y, '#FF9800')
      }
    }
    if (d.singles && d.singleExt) for (const r of pr.singles) extend(g, conv, candles, pr, mid(r), (r + 0.5) * rs, d.singleExt, xEnd, right, 'rgba(255, 214, 0, 0.35)', [1, 3])
    if (d.dayType && pr.complete) {
      g.font = `600 10px ${FONT}`
      g.textAlign = 'left'
      g.fillStyle = rgba(d.level, 0.8)
      g.fillText(dayType(pr), x0, rowTop(pr.hi) - 9)
    }
    if (d.vp) drawVolume(g, pr, xEnd, tpoRight, mid, rowTop, rowH, d)
  }
  if (m.note) note(g, rect, m.note)
  g.restore()
}

function hline(g: CanvasRenderingContext2D, x0: number, x1: number, y: number, color: string, dash: number[]): void {
  g.strokeStyle = color
  g.setLineDash(dash)
  g.beginPath()
  g.moveTo(x0, Math.round(y) + 0.5)
  g.lineTo(x1, Math.round(y) + 0.5)
  g.stroke()
  g.setLineDash([])
}

/** A level carried past its profile: until the first bar that trades through it, or to the right edge. */
function extend(g: CanvasRenderingContext2D, conv: Converters, candles: Candle[], pr: TpoProfile, y: number, price: number, mode: number, xEnd: number, right: number, color: string, dash: number[]): void {
  if (!mode || !pr.complete) return // the forming profile has nothing to carry yet
  let x1 = right
  if (mode === 1) {
    const i = firstTouchAfter(candles, pr.end, price)
    if (i >= 0) x1 = conv.timeToX(candles[i].time)
  }
  if (x1 > xEnd) hline(g, xEnd, x1, y, color, dash)
}

function drawVolume(g: CanvasRenderingContext2D, pr: TpoProfile, xEnd: number, tpoRight: number, mid: (r: number) => number, rowTop: (r: number) => number, rowH: number, d: Display): void {
  let max = 0
  for (const v of pr.volume.values()) max = Math.max(max, v)
  if (!(max > 0)) return
  const room = Math.max(10, (xEnd - tpoRight) * 0.35)
  const anchor = d.vpRight ? xEnd : tpoRight + 40
  const gap = rowH > 3 ? 0.5 : 0
  for (const [r, v] of pr.volume) {
    const w = (v / max) * room
    g.fillStyle = rgba(r >= pr.vVaLo && r <= pr.vVaHi ? d.vpVaColor : d.vpColor, 0.55)
    g.fillRect(d.vpRight ? anchor - w : anchor, rowTop(r) + gap, w, Math.max(1, rowH - 2 * gap))
    if (d.vpValues && rowH >= 9 && w > 24) {
      g.font = `500 9px ${FONT}`
      g.textAlign = d.vpRight ? 'right' : 'left'
      g.fillStyle = 'rgba(255, 255, 255, 0.85)'
      g.fillText(fmtVol(v), d.vpRight ? anchor - 2 : anchor + 2, mid(r) + 0.5)
    }
  }
  const x0 = d.vpRight ? anchor - room : anchor, x1 = d.vpRight ? anchor : anchor + room
  if (d.vpPoc) hline(g, x0, x1, mid(pr.vPoc), '#FF9800', [])
  if (d.vpVa) {
    hline(g, x0, x1, mid(pr.vVaHi), rgba(d.vpVaColor, 0.9), [3, 2])
    hline(g, x0, x1, mid(pr.vVaLo), rgba(d.vpVaColor, 0.9), [3, 2])
  }
  if (d.vpValues) {
    g.font = `600 10px ${FONT}`
    g.textAlign = d.vpRight ? 'right' : 'left'
    g.fillStyle = 'rgba(255, 255, 255, 0.8)'
    g.fillText(`Σ ${fmtVol(pr.totalVolume)}`, anchor, rowTop(pr.lo) + rowH + 10)
  }
}

const fmtVol = (v: number): string => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0))

function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  g.font = `600 10px ${FONT}`
  g.textAlign = 'left'
  g.fillStyle = color
  g.fillText(text, x, y + 0.5)
}

function marker(g: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
  g.font = `700 9px ${FONT}`
  g.textAlign = 'center'
  g.fillStyle = color
  g.fillText(text, x, y + 0.5)
}

function note(g: CanvasRenderingContext2D, rect: Rect, text: string): void {
  g.font = `600 11px ${FONT}`
  g.textAlign = 'left'
  g.fillStyle = 'rgba(255, 183, 77, 0.9)'
  g.fillText(text, rect.x + 8, rect.y + rect.height - 40)
}
