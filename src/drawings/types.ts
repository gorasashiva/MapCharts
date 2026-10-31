import type { Candle } from '../core/types'

export type DrawingToolId =
  // lines
  | 'trendline' // segment p0-p1
  | 'ray' // from p0 through p1, extended one way
  | 'xline' // infinite line through p0-p1, extended both ways
  | 'hray' // horizontal from p0, extended right
  | 'hline' // infinite horizontal at p0.price
  | 'vline' // infinite vertical at p0.time
  // channels & forks
  | 'channel' // 3 points: p0-p1 base line, p2 sets parallel offset
  | 'pitchfork' // Andrews pitchfork: p0 handle, p1/p2 tines
  // fibs
  | 'fib' // retracement p0-p1
  | 'fibext' // extension, 3 points (A-B-C, levels projected from C)
  // shapes
  | 'rect' // p0/p1 opposite corners
  | 'ellipse' // inscribed in p0/p1 bounding box
  | 'triangle' // 3 points
  | 'arrow' // p0 tail -> p1 head
  | 'brush' // freehand polyline, variable point count
  // annotate
  | 'note' // 1 point pin with text + optional emoji (props.emoji)
  // measure
  | 'pricerange' // 2 points: price delta / %
  | 'daterange' // 2 points: bars / elapsed time
  | 'sigmatape' // 2 points: data-aware measure (%, bars, ATR multiples, percentile)
  // smart (data-aware)
  | 'longpos' // entry/stop/target long position (points [entry, stop, target])
  | 'shortpos' // same, short
  | 'smartlevel' // self-scoring S/R zone at p0.price (counts touches)
  | 'volxray' // fixed-range volume profile inside p0/p1 box
  | 'avwap' // anchored VWAP from p0's candle, with ±1σ bands
  // --- expanded set (professional-grade) ---
  // more lines
  | 'infoline' // trend segment with price-Δ / % / bar-count / angle label
  | 'crossline' // infinite horizontal + vertical through one point
  | 'trendangle' // segment p0-p1 with angle-from-horizontal arc + label
  // more channels & forks
  | 'channeldisjoint' // 4 points: two independent (non-parallel) edges
  | 'channelflat' // 3 points: flat top/bottom horizontal channel
  | 'regression' // linear-regression channel over the p0-p1 bar range (data-aware)
  | 'pitchforkschiff' // Schiff pitchfork (median origin at midpoint of p0-p1)
  | 'pitchforkmod' // modified Schiff pitchfork
  | 'pitchforkinside' // inside pitchfork
  | 'gannfan' // Gann fan: 1x1..8x1 angle rays from p0
  | 'gannbox' // Gann box p0-p1 with price/time ratio grid
  // full Fibonacci family
  | 'fibtimezone' // vertical fib time zones from the p0-p1 span
  | 'fibfan' // fib speed/resistance fan from p0-p1
  | 'fibchannel' // fib parallel channel (3 points)
  | 'fibcircle' // concentric fib circles centred at p0, radius to p1
  | 'fibtimeext' // trend-based fib time (3 points A-B-C)
  | 'fibwedge' // fib speed-resistance arcs (wedge) p0-p1
  // harmonic & wave patterns
  | 'xabcd' // 5 points X-A-B-C-D with ratio labels
  | 'cypher' // 5 points, Cypher harmonic ratios
  | 'abcd' // 4 points A-B-C-D
  | 'headshoulders' // 7 points (LS, neckline, head, RS …) with labels
  | 'threedrives' // 7 points, three-drives pattern
  | 'elliottimpulse' // 6 points 0-1-2-3-4-5 with wave labels
  | 'elliottcorrection' // 4 points 0-A-B-C
  | 'trianglepattern' // 4 points consolidation triangle
  // more shapes
  | 'rotrect' // rotated rectangle: 3 points (edge p0-p1 + width via p2)
  | 'circle' // centre p0, radius to p1
  | 'arc' // 3-point circular arc
  | 'curve' // quadratic curve p0-(control p1)-p2
  | 'polyline' // click-placed multi-point open polyline (variable points)
  // more annotation
  | 'text' // free text box at p0 (no pin)
  | 'callout' // text bubble with a leader line to an anchor (2 points)
  | 'comment' // speech-bubble comment at p0
  | 'pricelabel' // tag showing p0.price on the axis line
  | 'signpost' // vertical marker with a flag label at p0
  | 'arrowup' // up (bullish) marker glyph at p0
  | 'arrowdown' // down (bearish) marker glyph at p0
  | 'flag' // flag marker at p0
  // projection / forecast
  | 'forecast' // 2 points: projected move with a translucent outcome cone
  | 'barspattern' // copy the last N real candles forward as a ghost projection (data-aware)
  | 'ghostfeed' // freehand-extend the chart with synthetic candles (data-aware)
  | 'dprange' // date + price range in one box (Δprice, Δ%, bars, time)

export interface DrawingPoint {
  time: number // epoch ms
  price: number
}

export interface Drawing {
  id: string
  tool: DrawingToolId
  points: DrawingPoint[] // length === pointsNeeded(tool); variable for 'brush'
  color: string // CSS color
  width: number // stroke width px
  text?: string // 'note' body text
  /** Tool-specific settings (JSON-serializable), e.g. { side, stake, riskR } for positions. */
  props?: Record<string, number | string | boolean>
}

/**
 * Coordinate converters supplied by the chart engine for the main price pane.
 * Implementations must extrapolate beyond the loaded data range
 * (using the current bar spacing) so drawings work in empty space.
 */
export interface Converters {
  timeToX(time: number): number
  xToTime(x: number): number
  priceToY(price: number): number
  yToPrice(y: number): number
}

/**
 * Read-only market context the engine hands to data-aware ("smart") tools at
 * render/hit-test time. Pure-geometry tools may ignore it.
 */
export interface DrawEnv {
  candles: Candle[] // ascending by time; the engine's full loaded array
  pricePrecision: number
  barMs: number // median candle spacing, ms (use for bar/duration math)
}

export type ToolGroup =
  | 'lines'
  | 'channels'
  | 'fib'
  | 'patterns'
  | 'shapes'
  | 'annotate'
  | 'measure'
  | 'projection'
  | 'smart'

/**
 * One drawing tool implementation. All tools (old and new) are registered as
 * ToolImpls; src/drawings/index.ts dispatches on Drawing.tool.
 */
export interface ToolImpl {
  id: DrawingToolId
  label: string
  group: ToolGroup
  /** Anchor points the user must click. -1 = freehand: capture points while dragging (brush). */
  pointsNeeded: number
  /** Initial Drawing.props for new drawings of this tool. */
  defaultProps?: Record<string, number | string | boolean>
  /**
   * Called once right after placement completes, before the drawing is
   * committed — lets a tool add computed points or props (e.g. position tools
   * turn 1 clicked entry into [entry, stop, target] using ATR from env).
   */
  expandOnCommit?(d: Drawing, env: DrawEnv): Drawing
  /**
   * Draw. MUST tolerate an in-progress drawing with fewer points than
   * pointsNeeded (render a sensible partial preview).
   */
  render(ctx: CanvasRenderingContext2D, d: Drawing, conv: Converters, selected: boolean, env: DrawEnv): void
  /** ~6px tolerance. Return false for drawings still missing points. */
  hitTest(d: Drawing, x: number, y: number, conv: Converters, env: DrawEnv): boolean
  /**
   * Optional override for handle hit-testing (default: 8px boxes on d.points).
   * Returns the handle (point) index under the cursor, or -1.
   */
  handleAt?(d: Drawing, x: number, y: number, conv: Converters, env: DrawEnv): number
  /**
   * Optional override for what dragging handle `index` to `p` means
   * (default: replace points[index] with p). E.g. position stop/target
   * handles move only in price.
   */
  moveHandle?(d: Drawing, index: number, p: DrawingPoint, env: DrawEnv): Drawing
}
