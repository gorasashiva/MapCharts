/**
 * Tool registry: every drawing tool (standard + smart) registered as a
 * ToolImpl, plus the grouped/flat toolbar metadata derived from it.
 */
import type { DrawingToolId, ToolGroup, ToolImpl } from './types'
import { LINE_IMPLS } from './lines'
import { CHANNEL_IMPLS } from './channels'
import { FIB_IMPLS } from './fib'
import { SHAPE_IMPLS } from './shapes'
import { ANNOTATE_IMPLS } from './annotate'
import { MEASURE_IMPLS } from './measure'
import { SMART_IMPLS } from './smart'
import { LINES2_IMPLS } from './lines2'
import { FIB2_IMPLS } from './fib2'
import { PATTERNS_IMPLS } from './patterns'
import { SHAPES2_IMPLS } from './shapes2'
import { ANNOTATE2_IMPLS } from './annotate2'

const ALL_IMPLS: ToolImpl[] = [
  ...LINE_IMPLS,
  ...CHANNEL_IMPLS,
  ...FIB_IMPLS,
  ...SHAPE_IMPLS,
  ...ANNOTATE_IMPLS,
  ...MEASURE_IMPLS,
  ...SMART_IMPLS,
  ...LINES2_IMPLS,
  ...FIB2_IMPLS,
  ...PATTERNS_IMPLS,
  ...SHAPES2_IMPLS,
  ...ANNOTATE2_IMPLS,
]

/** Every tool implementation, keyed by id. */
export const TOOL_IMPLS: Record<DrawingToolId, ToolImpl> = ALL_IMPLS.reduce(
  (acc, impl) => {
    acc[impl.id] = impl
    return acc
  },
  {} as Record<DrawingToolId, ToolImpl>,
)

/** Canonical tool order — matches the DrawingToolId declaration order in types.ts. */
const TOOL_ORDER: DrawingToolId[] = [
  'trendline',
  'ray',
  'xline',
  'hray',
  'hline',
  'vline',
  'channel',
  'pitchfork',
  'fib',
  'fibext',
  'rect',
  'ellipse',
  'triangle',
  'arrow',
  'brush',
  'note',
  'pricerange',
  'daterange',
  'sigmatape',
  'longpos',
  'shortpos',
  'smartlevel',
  'volxray',
  'avwap',
  // --- expanded set (professional-grade) ---
  // more lines
  'infoline',
  'crossline',
  'trendangle',
  // more channels & forks
  'channeldisjoint',
  'channelflat',
  'regression',
  'pitchforkschiff',
  'pitchforkmod',
  'pitchforkinside',
  'gannfan',
  'gannbox',
  // full Fibonacci family
  'fibtimezone',
  'fibfan',
  'fibchannel',
  'fibcircle',
  'fibtimeext',
  'fibwedge',
  // harmonic & wave patterns
  'xabcd',
  'cypher',
  'abcd',
  'headshoulders',
  'threedrives',
  'elliottimpulse',
  'elliottcorrection',
  'trianglepattern',
  // more shapes
  'rotrect',
  'circle',
  'arc',
  'curve',
  'polyline',
  // more annotation
  'text',
  'callout',
  'comment',
  'pricelabel',
  'signpost',
  'arrowup',
  'arrowdown',
  'flag',
  // projection / forecast
  'forecast',
  'barspattern',
  'ghostfeed',
  'dprange',
]

const GROUP_ORDER: ToolGroup[] = [
  'lines',
  'channels',
  'fib',
  'patterns',
  'shapes',
  'annotate',
  'measure',
  'projection',
  'smart',
]

const GROUP_LABELS: Record<ToolGroup, string> = {
  lines: 'Lines',
  channels: 'Channels',
  fib: 'Fibonacci',
  patterns: 'Patterns',
  shapes: 'Shapes',
  annotate: 'Annotate',
  measure: 'Measure',
  projection: 'Projection',
  smart: 'Smart',
}

/** Toolbar groups in display order; tools within each group follow TOOL_ORDER. */
export const TOOL_GROUPS: {
  group: ToolGroup
  label: string
  tools: { id: DrawingToolId; label: string }[]
}[] = GROUP_ORDER.map((group) => ({
  group,
  label: GROUP_LABELS[group],
  tools: TOOL_ORDER.filter((id) => TOOL_IMPLS[id]?.group === group).map((id) => ({
    id,
    label: TOOL_IMPLS[id].label,
  })),
}))

/** Flat tool list (back-compat with the pre-grouped toolbar). */
export const DRAWING_TOOLS: { id: DrawingToolId; label: string }[] = TOOL_GROUPS.flatMap(
  (g) => g.tools,
)

/** Implementation for a tool id. Throws on an unregistered id — that's a wiring bug. */
export function toolImpl(tool: DrawingToolId): ToolImpl {
  const impl = TOOL_IMPLS[tool]
  if (!impl) throw new Error(`drawings: no ToolImpl registered for tool "${tool}"`)
  return impl
}

/** Number of anchor points the user must place for a tool. -1 = freehand (brush). */
export function pointsNeeded(tool: DrawingToolId): number {
  return toolImpl(tool).pointsNeeded
}
