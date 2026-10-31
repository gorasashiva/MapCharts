/**
 * Harmonic & wave pattern tools — multi-point polylines with labelled
 * vertices and Fibonacci-ratio chips on the legs.
 *
 *  - abcd            4 pts A-B-C-D (AB=CD ratio, BC retrace)
 *  - xabcd           5 pts X-A-B-C-D (AB/XA, BC/AB, CD/BC) + translucent triangles
 *  - cypher          5 pts, same geometry as xabcd, Cypher ratio targets noted
 *  - headshoulders   7 pts (LS-low, LS, neck1, head, neck2, RS, RS-low) + neckline
 *  - threedrives     7 pts (drives 1/2/3 with A/B retraces)
 *  - elliottimpulse  6 pts 0-1-2-3-4-5 (wave labels 1..5)
 *  - elliottcorrection 4 pts 0-A-B-C (labels A,B,C)
 *  - trianglepattern 4 pts p0-p3 with two converging trendlines + fill
 *
 * Pure canvas 2D; all colors derive from d.color. Every render tolerates an
 * in-progress drawing with fewer than pointsNeeded points.
 */
import type { ReactElement } from 'react'
import type { Converters, Drawing, DrawingToolId, ToolImpl } from './types'
import type { Pt } from './helpers'
import {
  FONT_10,
  contrastText,
  drawHandles,
  extendLine,
  fillDot,
  logicalSize,
  measureTextWidth,
  roundRectPath,
  screenPts,
  segDist,
  strokeLine,
  strokeTol,
  toXY,
  withAlpha,
} from './helpers'

/** Fill opacity for the translucent harmonic / consolidation triangles. */
const PATTERN_FILL_ALPHA = 0.08

/** Offset (px) of a vertex chip from its anchor, away from the polyline body. */
const LABEL_OFFSET = 14

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Connect the anchors with a polyline in d.color (rounded joins). */
function strokePolyline(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  if (pts.length < 2) return
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.stroke()
}

/** Small square vertex marker (filled d.color) at every anchor. */
function drawVertices(ctx: CanvasRenderingContext2D, d: Drawing, pts: Pt[]): void {
  ctx.fillStyle = d.color
  for (const p of pts) ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5)
}

/**
 * Compact label pill centered at (cx, cy). Used for the single-letter vertex
 * tags (A, B, C…) and short ratio chips. Solid d.color fill, contrast text.
 */
function drawTag(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  text: string,
  bg: string,
): void {
  ctx.font = FONT_10
  const padX = 4
  const w = measureTextWidth(ctx, FONT_10, text) + padX * 2
  const h = 14
  roundRectPath(ctx, cx - w / 2, cy - h / 2, w, h, 3)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.fillStyle = contrastText(ctx, bg)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, cx, cy + 0.5)
}

/**
 * Place a vertex tag just outside the polyline body. `dir` is the rough
 * direction (in screen space) away from the body's centroid; the chip is
 * pushed LABEL_OFFSET px along it.
 */
function drawVertexLabel(
  ctx: CanvasRenderingContext2D,
  p: Pt,
  dir: Pt,
  text: string,
  bg: string,
): void {
  const len = Math.hypot(dir.x, dir.y) || 1
  drawTag(ctx, p.x + (dir.x / len) * LABEL_OFFSET, p.y + (dir.y / len) * LABEL_OFFSET, text, bg)
}

/** Centroid of the placed anchors (for outward label placement). */
function centroid(pts: Pt[]): Pt {
  let sx = 0
  let sy = 0
  for (const p of pts) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / pts.length, y: sy / pts.length }
}

/** Outward direction from the centroid toward p (with a vertical fallback). */
function outward(p: Pt, c: Pt): Pt {
  const dx = p.x - c.x
  const dy = p.y - c.y
  if (Math.hypot(dx, dy) < 1) return { x: 0, y: -1 }
  return { x: dx, y: dy }
}

/** Translucent filled triangle through three screen points. */
function fillTriangle(
  ctx: CanvasRenderingContext2D,
  a: Pt,
  b: Pt,
  c: Pt,
  color: string,
): void {
  ctx.fillStyle = withAlpha(ctx, color, PATTERN_FILL_ALPHA)
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.lineTo(c.x, c.y)
  ctx.closePath()
  ctx.fill()
}

/** Ratio chip at the midpoint of segment a-b. */
function drawLegRatio(
  ctx: CanvasRenderingContext2D,
  a: Pt,
  b: Pt,
  text: string,
  bg: string,
): void {
  drawTag(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, text, bg)
}

/** |price move| of leg from anchor i to j; 0 when either is missing. */
function legSize(d: Drawing, i: number, j: number): number {
  const a = d.points[i]
  const b = d.points[j]
  if (!a || !b) return 0
  return Math.abs(b.price - a.price)
}

/** Ratio of two leg sizes, formatted to 3 dp; '—' when denominator ~ 0. */
function ratioText(num: number, den: number): string {
  if (!(den > 1e-12)) return '—'
  return (num / den).toFixed(3)
}

/** hitTest helper: within tolerance of any polyline segment. */
function nearPolyline(d: Drawing, x: number, y: number, conv: Converters): boolean {
  if (d.points.length < 2) return false
  const pts = screenPts(d, conv)
  const tol = strokeTol(d)
  for (let i = 0; i < pts.length - 1; i++) {
    if (segDist(x, y, pts[i], pts[i + 1]) <= tol) return true
  }
  return false
}

/**
 * Standard partial-preview head: dot for 1 point, polyline + vertices otherwise.
 * `connector` (default true) draws the line joining the anchors — Elliott tools
 * let the user turn it off and keep just the labelled vertices.
 */
function previewBody(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  conv: Converters,
  connector = true,
): Pt[] {
  const pts = screenPts(d, conv)
  if (pts.length === 1) {
    fillDot(ctx, pts[0].x, pts[0].y, d.width)
    return pts
  }
  if (connector) strokePolyline(ctx, pts)
  drawVertices(ctx, d, pts)
  return pts
}

/** props boolean with a default (Elliott connector toggle). */
function propBool(d: Drawing, key: string, fallback: boolean): boolean {
  const v = d.props?.[key]
  return typeof v === 'boolean' ? v : fallback
}

/** props string ('' when unset) — used for the Elliott wave-degree label. */
function propStr(d: Drawing, key: string): string {
  const v = d.props?.[key]
  return typeof v === 'string' ? v : ''
}

// ---------------------------------------------------------------------------
// ABCD — 4 points
// ---------------------------------------------------------------------------

const abcd: ToolImpl = {
  id: 'abcd',
  label: 'ABCD Pattern',
  group: 'patterns',
  pointsNeeded: 4,
  render(ctx, d, conv, selected) {
    const pts = previewBody(ctx, d, conv)
    const labels = ['A', 'B', 'C', 'D']
    const c = centroid(pts)
    for (let i = 0; i < pts.length; i++) {
      drawVertexLabel(ctx, pts[i], outward(pts[i], c), labels[i], d.color)
    }
    // BC retracement (of AB) on the B-C leg, and CD=AB ratio on the C-D leg.
    if (pts.length >= 3) {
      drawLegRatio(ctx, pts[1], pts[2], ratioText(legSize(d, 1, 2), legSize(d, 0, 1)), d.color)
    }
    if (pts.length >= 4) {
      drawLegRatio(ctx, pts[2], pts[3], `CD ${ratioText(legSize(d, 2, 3), legSize(d, 0, 1))}`, d.color)
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (d.points.length < 4) return false
    return nearPolyline(d, x, y, conv)
  },
}

// ---------------------------------------------------------------------------
// XABCD — 5 points (with harmonic triangles)
// ---------------------------------------------------------------------------

/** Shared render for xabcd & cypher; `targetNote` is appended to the CD chip. */
function renderHarmonic(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  conv: Converters,
  selected: boolean,
  cdNote: string,
): void {
  const pts = screenPts(d, conv)
  if (pts.length === 1) {
    fillDot(ctx, pts[0].x, pts[0].y, d.width)
    if (selected) drawHandles(ctx, d, conv)
    return
  }
  // Translucent X-A-B-C and B-C-D triangles (only once their vertices exist).
  if (pts.length >= 4) fillTriangle(ctx, pts[1], pts[2], pts[3], d.color) // A-B-C region
  if (pts.length >= 3) fillTriangle(ctx, pts[0], pts[1], pts[2], d.color) // X-A-B region
  if (pts.length >= 5) fillTriangle(ctx, pts[2], pts[3], pts[4], d.color) // C-D leg region

  strokePolyline(ctx, pts)
  drawVertices(ctx, d, pts)

  const labels = ['X', 'A', 'B', 'C', 'D']
  const c = centroid(pts)
  for (let i = 0; i < pts.length; i++) {
    drawVertexLabel(ctx, pts[i], outward(pts[i], c), labels[i], d.color)
  }
  // Three harmonic ratios on their respective legs.
  if (pts.length >= 3) {
    drawLegRatio(ctx, pts[1], pts[2], ratioText(legSize(d, 1, 2), legSize(d, 0, 1)), d.color) // AB/XA on A-B
  }
  if (pts.length >= 4) {
    drawLegRatio(ctx, pts[2], pts[3], ratioText(legSize(d, 2, 3), legSize(d, 1, 2)), d.color) // BC/AB on B-C
  }
  if (pts.length >= 5) {
    const cd = ratioText(legSize(d, 3, 4), legSize(d, 2, 3)) // CD/BC on C-D
    drawLegRatio(ctx, pts[3], pts[4], cdNote ? `${cd} ${cdNote}` : cd, d.color)
  }
  if (selected) drawHandles(ctx, d, conv)
}

const xabcd: ToolImpl = {
  id: 'xabcd',
  label: 'XABCD Pattern',
  group: 'patterns',
  pointsNeeded: 5,
  render(ctx, d, conv, selected) {
    renderHarmonic(ctx, d, conv, selected, '')
  },
  hitTest(d, x, y, conv) {
    if (d.points.length < 5) return false
    return nearPolyline(d, x, y, conv)
  },
}

const cypher: ToolImpl = {
  id: 'cypher',
  label: 'Cypher Pattern',
  group: 'patterns',
  pointsNeeded: 5,
  render(ctx, d, conv, selected) {
    // Cypher targets: B in 0.382–0.618 of XA, C in 1.272–1.414 of XA, D = 0.786 XC.
    renderHarmonic(ctx, d, conv, selected, 'Cypher 0.786')
  },
  hitTest(d, x, y, conv) {
    if (d.points.length < 5) return false
    return nearPolyline(d, x, y, conv)
  },
}

// ---------------------------------------------------------------------------
// Head & Shoulders — 7 points (LS-low, LS, neck1, head, neck2, RS, RS-low)
// ---------------------------------------------------------------------------

const headshoulders: ToolImpl = {
  id: 'headshoulders',
  label: 'Head & Shoulders',
  group: 'patterns',
  pointsNeeded: 7,
  render(ctx, d, conv, selected) {
    const pts = previewBody(ctx, d, conv)
    // Neckline runs through the two troughs (anchors 2 & 4), extended to edges.
    if (pts.length >= 5) {
      const n1 = pts[2]
      const n2 = pts[4]
      const { w, h } = logicalSize(ctx)
      const ext = extendLine(n1.x, n1.y, n2.x, n2.y, w, h, true, true)
      if (ext) {
        ctx.save()
        ctx.setLineDash([5, 4])
        ctx.strokeStyle = withAlpha(ctx, d.color, 0.6)
        ctx.lineWidth = Math.max(1, d.width)
        strokeLine(ctx, ext[0], ext[1], ext[2], ext[3])
        ctx.restore()
      }
    }
    // Peak labels: LS (anchor 1), H (anchor 3), RS (anchor 5).
    const c = centroid(pts)
    const peakLabels: Array<[number, string]> = [
      [1, 'LS'],
      [3, 'H'],
      [5, 'RS'],
    ]
    for (const [i, txt] of peakLabels) {
      const p = pts[i]
      if (p) {
        // Push peaks upward (away from the centroid, biased up).
        const dir = outward(p, c)
        drawVertexLabel(ctx, p, { x: dir.x, y: -Math.abs(dir.y) - 0.5 }, txt, d.color)
      }
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (d.points.length < 7) return false
    return nearPolyline(d, x, y, conv)
  },
}

// ---------------------------------------------------------------------------
// Three Drives — 7 points (drives 1/2/3 with A/B retraces)
// ---------------------------------------------------------------------------

const threedrives: ToolImpl = {
  id: 'threedrives',
  label: 'Three Drives',
  group: 'patterns',
  pointsNeeded: 7,
  render(ctx, d, conv, selected) {
    const pts = previewBody(ctx, d, conv)
    // Layout: origin(0), drive1(1), retraceA(2), drive2(3), retraceB(4),
    // drive3(5), end(6). Label the three drives and the two retraces.
    const c = centroid(pts)
    const labels: Record<number, string> = {
      1: '1',
      2: 'A',
      3: '2',
      4: 'B',
      5: '3',
    }
    for (let i = 0; i < pts.length; i++) {
      const txt = labels[i]
      if (txt) drawVertexLabel(ctx, pts[i], outward(pts[i], c), txt, d.color)
    }
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (d.points.length < 7) return false
    return nearPolyline(d, x, y, conv)
  },
}

// ---------------------------------------------------------------------------
// Elliott Impulse — 6 points 0-1-2-3-4-5
// ---------------------------------------------------------------------------

/**
 * Elliott-wave "degree" labels, largest cycle to smallest. Empty string = no
 * degree label shown. Exposed for the inspector's degree picker.
 */
export const WAVE_DEGREES: readonly string[] = [
  'Grand Supercycle',
  'Supercycle',
  'Cycle',
  'Primary',
  'Intermediate',
  'Minor',
  'Minute',
  'Minuette',
  'Subminuette',
]

const elliottimpulse: ToolImpl = {
  id: 'elliottimpulse',
  label: 'Elliott Impulse',
  group: 'patterns',
  pointsNeeded: 6,
  defaultProps: { showConnector: true, waveDegree: '' },
  render(ctx, d, conv, selected) {
    const pts = previewBody(ctx, d, conv, propBool(d, 'showConnector', true))
    // Anchor 0 is the origin (carries the optional wave-degree label); anchors
    // 1..5 are waves 1..5.
    const c = centroid(pts)
    for (let i = 1; i < pts.length; i++) {
      drawVertexLabel(ctx, pts[i], outward(pts[i], c), String(i), d.color)
    }
    const degree = propStr(d, 'waveDegree')
    if (degree && pts.length >= 1) drawVertexLabel(ctx, pts[0], outward(pts[0], c), degree, d.color)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (d.points.length < 6) return false
    return nearPolyline(d, x, y, conv)
  },
}

// ---------------------------------------------------------------------------
// Elliott Correction — 4 points 0-A-B-C
// ---------------------------------------------------------------------------

const elliottcorrection: ToolImpl = {
  id: 'elliottcorrection',
  label: 'Elliott Correction',
  group: 'patterns',
  pointsNeeded: 4,
  defaultProps: { showConnector: true, waveDegree: '' },
  render(ctx, d, conv, selected) {
    const pts = previewBody(ctx, d, conv, propBool(d, 'showConnector', true))
    // Anchor 0 is the origin (carries the optional wave-degree label); anchors
    // 1..3 are A, B, C.
    const labels = ['', 'A', 'B', 'C']
    const c = centroid(pts)
    for (let i = 1; i < pts.length; i++) {
      drawVertexLabel(ctx, pts[i], outward(pts[i], c), labels[i], d.color)
    }
    const degree = propStr(d, 'waveDegree')
    if (degree && pts.length >= 1) drawVertexLabel(ctx, pts[0], outward(pts[0], c), degree, d.color)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (d.points.length < 4) return false
    return nearPolyline(d, x, y, conv)
  },
}

// ---------------------------------------------------------------------------
// Triangle (consolidation) — 4 points with two converging trendlines
// ---------------------------------------------------------------------------

/** Intersection point of segments p0-p2 and p1-p3, or null if parallel. */
function lineIntersect(p0: Pt, p2: Pt, p1: Pt, p3: Pt): Pt | null {
  const r = { x: p2.x - p0.x, y: p2.y - p0.y }
  const s = { x: p3.x - p1.x, y: p3.y - p1.y }
  const denom = r.x * s.y - r.y * s.x
  if (Math.abs(denom) < 1e-9) return null
  const t = ((p1.x - p0.x) * s.y - (p1.y - p0.y) * s.x) / denom
  return { x: p0.x + t * r.x, y: p0.y + t * r.y }
}

const trianglepattern: ToolImpl = {
  id: 'trianglepattern',
  label: 'Triangle Pattern',
  group: 'patterns',
  pointsNeeded: 4,
  render(ctx, d, conv, selected) {
    const pts = screenPts(d, conv)
    if (pts.length === 1) {
      fillDot(ctx, pts[0].x, pts[0].y, d.width)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    if (pts.length === 2) {
      strokeLine(ctx, pts[0].x, pts[0].y, pts[1].x, pts[1].y)
      drawVertices(ctx, d, pts)
      if (selected) drawHandles(ctx, d, conv)
      return
    }
    // Two converging trendlines: upper p0-p2, lower p1-p3. With only 3 points
    // we can still draw p0-p2 plus the partial p1-? leg.
    if (pts.length >= 4) {
      const apex = lineIntersect(pts[0], pts[2], pts[1], pts[3])
      // Translucent fill of the consolidation body (the p0-p1-p3-p2 quad).
      ctx.fillStyle = withAlpha(ctx, d.color, PATTERN_FILL_ALPHA)
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      ctx.lineTo(pts[1].x, pts[1].y)
      ctx.lineTo(pts[3].x, pts[3].y)
      ctx.lineTo(pts[2].x, pts[2].y)
      ctx.closePath()
      ctx.fill()
      // The two converging lines, extended to their apex (or canvas edge).
      ctx.strokeStyle = d.color
      ctx.lineWidth = Math.max(1, d.width)
      const upperEnd = apex ?? pts[2]
      const lowerEnd = apex ?? pts[3]
      strokeLine(ctx, pts[0].x, pts[0].y, upperEnd.x, upperEnd.y)
      strokeLine(ctx, pts[1].x, pts[1].y, lowerEnd.x, lowerEnd.y)
    } else {
      // 3 points: connect p0-p2 (upper) and start the lower from p1.
      strokeLine(ctx, pts[0].x, pts[0].y, pts[2].x, pts[2].y)
      strokeLine(ctx, pts[0].x, pts[0].y, pts[1].x, pts[1].y)
    }
    drawVertices(ctx, d, pts)
    if (selected) drawHandles(ctx, d, conv)
  },
  hitTest(d, x, y, conv) {
    if (d.points.length < 4) return false
    const pts = screenPts(d, conv)
    const tol = strokeTol(d)
    return segDist(x, y, pts[0], pts[2]) <= tol || segDist(x, y, pts[1], pts[3]) <= tol
  },
}

export const PATTERNS_IMPLS: ToolImpl[] = [
  abcd,
  xabcd,
  cypher,
  headshoulders,
  threedrives,
  elliottimpulse,
  elliottcorrection,
  trianglepattern,
]

// ---------------------------------------------------------------------------
// Icons — 18x18, stroke=currentColor, matching src/components/toolIcons.tsx
// ---------------------------------------------------------------------------

const S = {
  width: 18,
  height: 18,
  viewBox: '0 0 18 18',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export const PATTERNS_ICONS: Partial<Record<DrawingToolId, ReactElement>> = {
  // A-B-C-D zig-zag.
  abcd: (
    <svg {...S}>
      <polyline points="2.5,13 6,5 10,12 15.5,4" />
    </svg>
  ),
  // X-A-B-C-D zig-zag (five vertices).
  xabcd: (
    <svg {...S}>
      <polyline points="2,5 5,13 8.5,6 12,13 16,4" />
    </svg>
  ),
  // Cypher — same zig-zag with a small mark at the turn.
  cypher: (
    <svg {...S}>
      <polyline points="2,6 5.5,13 9,5 12.5,12 16,5" />
      <circle cx="9" cy="5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  ),
  // Head & shoulders silhouette with a neckline.
  headshoulders: (
    <svg {...S}>
      <polyline points="2,12 4.5,7 7,11 9,3 11,11 13.5,7 16,12" />
      <line x1="2" y1="11.5" x2="16" y2="11.5" strokeDasharray="2.2 2.2" />
    </svg>
  ),
  // Three drives — three ascending peaks.
  threedrives: (
    <svg {...S}>
      <polyline points="2,14 4,8 6,11 9,5 11,8 14,2.5 16,5" />
    </svg>
  ),
  // Elliott impulse — five-leg upward wave.
  elliottimpulse: (
    <svg {...S}>
      <polyline points="2,15 5,8 6.5,11 10,4 11.5,7 16,2.5" />
    </svg>
  ),
  // Elliott correction — A-B-C three-leg.
  elliottcorrection: (
    <svg {...S}>
      <polyline points="3,5 7,13 11,6 15,12" />
    </svg>
  ),
  // Converging triangle.
  trianglepattern: (
    <svg {...S}>
      <line x1="2.5" y1="4" x2="15.5" y2="9" />
      <line x1="2.5" y1="14" x2="15.5" y2="9" />
      <line x1="2.5" y1="4" x2="2.5" y2="14" strokeDasharray="2 2" />
    </svg>
  ),
}
