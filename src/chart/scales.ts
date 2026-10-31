/**
 * Bar-index based time scale + per-pane linear price scale,
 * plus number/time formatting helpers shared by the renderers.
 */

/** Fractional bar-index viewport. Bar i occupies [i, i+1); its center is i + 0.5. */
export interface ViewState {
  start: number
  end: number
}

export class TimeScale {
  /** Candle open times, ascending (epoch ms). */
  private times: number[] = []
  /** Estimated uniform bar interval (ms), used to extrapolate beyond the data. */
  intervalMs = 60_000
  /** Plot-area width in CSS px (excludes the price axis column). */
  plotWidth = 0
  view: ViewState = { start: -80, end: 80 }

  setTimes(times: number[]): void {
    this.times = times
    if (times.length >= 2) {
      // Min positive delta is robust against gaps (weekends/outages), which
      // can only make deltas larger than the true interval, never smaller.
      let min = Infinity
      for (let i = 1; i < times.length; i++) {
        const d = times[i] - times[i - 1]
        if (d > 0 && d < min) min = d
      }
      if (isFinite(min)) this.intervalMs = min
    }
  }

  /**
   * O(1) append for the live-tick path: extends `times` by one and folds the
   * new delta into `intervalMs` via the same "running min positive delta"
   * rule `setTimes` uses over the full array — since that rule is a plain
   * min, appending one value and taking min(current, newDelta) is exactly
   * equivalent to a full rescan, not an approximation.
   */
  appendTime(t: number): void {
    const n = this.times.length
    if (n > 0) {
      const d = t - this.times[n - 1]
      if (d > 0 && d < this.intervalMs) this.intervalMs = d
    }
    this.times.push(t)
  }

  /**
   * O(1) overwrite of the last time (interim tick on the still-forming bar).
   * `intervalMs` is left untouched: a bar's open time never changes within
   * its own lifetime, so in practice this is called with the same value.
   */
  replaceLastTime(t: number): void {
    const n = this.times.length
    if (n > 0) this.times[n - 1] = t
  }

  get count(): number {
    return this.times.length
  }

  get range(): number {
    return this.view.end - this.view.start
  }

  /** Width of one bar slot in CSS px. */
  barSpacing(): number {
    return this.range > 0 ? this.plotWidth / this.range : 0
  }

  /** Fractional bar index -> x (left-edge convention). */
  indexToX(index: number): number {
    return ((index - this.view.start) / (this.range || 1)) * this.plotWidth
  }

  /** x -> fractional bar index. */
  xToIndex(x: number): number {
    return this.view.start + (x / (this.plotWidth || 1)) * this.range
  }

  /** x of the center of bar `index`. */
  centerX(index: number): number {
    return this.indexToX(index + 0.5)
  }

  /**
   * time -> fractional bar index. Binary search inside the loaded range,
   * uniform-interval extrapolation outside of it.
   */
  timeToIndex(time: number): number {
    const t = this.times
    const n = t.length
    if (n === 0) return time / this.intervalMs
    if (time <= t[0]) return (time - t[0]) / this.intervalMs
    if (time >= t[n - 1]) return n - 1 + (time - t[n - 1]) / this.intervalMs
    // Greatest k with t[k] <= time.
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (t[mid] <= time) lo = mid
      else hi = mid
    }
    const span = t[hi] - t[lo]
    return lo + (span > 0 ? (time - t[lo]) / span : 0)
  }

  /** Fractional bar index -> time. Inverse of timeToIndex (same extrapolation). */
  indexToTime(index: number): number {
    const t = this.times
    const n = t.length
    if (n === 0) return Math.round(index * this.intervalMs)
    if (index <= 0) return Math.round(t[0] + index * this.intervalMs)
    if (index >= n - 1) return Math.round(t[n - 1] + (index - (n - 1)) * this.intervalMs)
    const k = Math.floor(index)
    return Math.round(t[k] + (t[k + 1] - t[k]) * (index - k))
  }

  /** time -> x, anchored at bar centers (a drawing at a candle's time sits on that candle). */
  timeToX(time: number): number {
    return this.indexToX(this.timeToIndex(time) + 0.5)
  }

  /** x -> time. Inverse of timeToX. */
  xToTime(x: number): number {
    return this.indexToTime(this.xToIndex(x) - 0.5)
  }

  /** Inclusive [from, to] integer bar range intersecting the viewport (clamped to data). */
  visibleRange(): { from: number; to: number } {
    const from = Math.max(0, Math.floor(this.view.start))
    const to = Math.min(this.count - 1, Math.ceil(this.view.end))
    return { from, to }
  }
}

/**
 * Y-scale for one pane. `min`/`max` already include any vertical margins. In
 * `log` mode the price axis is logarithmic (min must be > 0) — equal screen
 * distances mean equal PERCENT moves, which is what traders expect from a "log
 * chart". priceToY/yToPrice and the tick values all respect the mode.
 */
export class PriceScale {
  constructor(
    public readonly top: number,
    public readonly height: number,
    public readonly min: number,
    public readonly max: number,
    public readonly log = false,
    /** Upside-down axis: high prices at the bottom. */
    public readonly inverted = false,
  ) {}

  get bottom(): number {
    return this.top + this.height
  }

  priceToY(price: number): number {
    const y = this.uprightY(price)
    return this.inverted ? 2 * this.top + this.height - y : y
  }

  private uprightY(price: number): number {
    if (this.log) {
      const lo = Math.log(this.min)
      const span = Math.log(this.max) - lo || 1
      return this.top + ((Math.log(this.max) - Math.log(Math.max(price, 1e-12))) / span) * this.height
    }
    const span = this.max - this.min
    return this.top + ((this.max - price) / (span || 1)) * this.height
  }

  yToPrice(yIn: number): number {
    const y = this.inverted ? 2 * this.top + this.height - yIn : yIn
    if (this.log) {
      const hi = Math.log(this.max)
      const span = hi - Math.log(this.min) || 1
      return Math.exp(hi - ((y - this.top) / (this.height || 1)) * span)
    }
    const span = this.max - this.min
    return this.max - ((y - this.top) / (this.height || 1)) * span
  }

  /**
   * Nice round tick values inside the scale, skipping ones whose label would
   * be clipped at the pane edges. `minStep` lets the caller forbid steps finer
   * than the display precision (e.g. 10^-pricePrecision). In log mode, a range
   * spanning multiple decades uses 1/2/5×10^k decade ticks; a narrower range
   * (e.g. crypto within one decade) falls back to nice linear values, which read
   * cleanly and are positioned via the log priceToY anyway.
   */
  ticks(minStep = 0): number[] {
    if (this.height <= 0) return []
    if (this.log && this.min > 0 && this.max > this.min) {
      const decades = this.logDecadeTicks()
      if (decades.length >= 3) return decades
    }
    return this.linearTicks(minStep)
  }

  private linearTicks(minStep: number): number[] {
    const span = this.max - this.min
    if (!(span > 0)) return []
    const targetCount = Math.max(2, Math.floor(this.height / 45))
    let step = niceStep(span / targetCount)
    if (minStep > 0 && step < minStep) step = minStep
    const out: number[] = []
    const first = Math.ceil(this.min / step)
    for (let i = first; i * step <= this.max + step * 0.5; i++) {
      const v = i * step
      const y = this.priceToY(v)
      if (y >= this.top + 8 && y <= this.bottom - 8) out.push(v)
    }
    return out
  }

  private logDecadeTicks(): number[] {
    const out: number[] = []
    const startExp = Math.floor(Math.log10(this.min))
    const endExp = Math.ceil(Math.log10(this.max))
    for (let e = startExp; e <= endExp; e++) {
      const decade = Math.pow(10, e)
      for (const m of [1, 2, 5]) {
        const v = m * decade
        if (v < this.min || v > this.max) continue
        const y = this.priceToY(v)
        if (y >= this.top + 8 && y <= this.bottom - 8) out.push(v)
      }
    }
    return out
  }
}

/** Round `raw` up to a "nice" step: 1, 2 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !isFinite(raw)) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of [1, 2, 5, 10]) {
    if (m * mag >= raw) return m * mag
  }
  return 10 * mag
}

/** Decimals needed to display values on a 1/2/5*10^k step grid. */
export function decimalsForStep(step: number): number {
  if (!(step > 0) || !isFinite(step)) return 2
  return Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9)))
}

/** Fixed-precision price with thousands separators. */
export function formatPrice(value: number, precision: number): string {
  if (!isFinite(value)) return '—'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })
}

/** Compact notation (1.23K / 4.56M / ...) — used for volume only. */
export function formatCompact(value: number): string {
  if (!isFinite(value)) return '—'
  const a = Math.abs(value)
  if (a >= 1e12) return (value / 1e12).toFixed(2) + 'T'
  if (a >= 1e9) return (value / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return (value / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return (value / 1e3).toFixed(2) + 'K'
  if (a >= 100) return value.toFixed(0)
  return a >= 1 ? value.toFixed(2) : value.toFixed(4)
}

// ---------------------------------------------------------------------------
// Time axis ticks
// ---------------------------------------------------------------------------

export interface TimeTick {
  /** Integer bar index of the tick. */
  index: number
  /** x of the bar center. */
  x: number
  /** Time at that index (extrapolated outside the data). */
  time: number
}

/** Smallest 1/2/5*10^k integer >= minBars. */
export function niceBarStep(minBars: number): number {
  let mag = 1
  for (;;) {
    for (const m of [1, 2, 5]) {
      const s = m * mag
      if (s >= minBars) return s
    }
    mag *= 10
  }
}

/** Time-axis ticks at evenly spaced bar indices (~90px apart). */
export function computeTimeTicks(ts: TimeScale): TimeTick[] {
  const spacing = ts.barSpacing()
  if (!(spacing > 0) || ts.plotWidth <= 0) return []
  const step = niceBarStep(Math.max(1, Math.ceil(90 / spacing)))
  const out: TimeTick[] = []
  const first = Math.ceil(ts.view.start / step) * step
  for (let i = first; i < ts.view.end; i += step) {
    const x = ts.centerX(i)
    if (x < -1 || x > ts.plotWidth + 1) continue
    out.push({ index: i, x, time: ts.indexToTime(i) })
  }
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

// Candle times are UTC epoch ms. Chart time display (axis + crosshair) uses
// one app-wide display zone — IST (UTC+5:30) by default, not the viewing
// browser's local timezone, so the chart reads the same for every user.
// Shifting the epoch by the zone's offset and reading it back with the UTC
// getters renders that zone. Fixed-offset zones need no timezone database;
// DST zones (London, New York…) resolve their offset per hour via Intl.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
const HOUR_MS = 3_600_000

let displayZone = 'Asia/Kolkata'
const zoneOffsetCache = new Map<number, number>()

/** Set the IANA zone ('UTC', 'Asia/Kolkata', 'America/New_York', …) the time axis and crosshair display. */
export function setDisplayTimeZone(zone: string): void {
  if (zone === displayZone) return
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
  } catch {
    return // unknown zone: keep the current one
  }
  displayZone = zone
  zoneOffsetCache.clear()
}

export function getDisplayTimeZone(): string {
  return displayZone
}

/** Offset (ms) of the display zone from UTC at `time`. */
export function displayZoneOffset(time: number): number {
  if (displayZone === 'UTC') return 0
  if (displayZone === 'Asia/Kolkata') return IST_OFFSET_MS
  const hour = Math.floor(time / HOUR_MS)
  const hit = zoneOffsetCache.get(hour)
  if (hit !== undefined) return hit
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: displayZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(hour * HOUR_MS))
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const offset = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - hour * HOUR_MS
  if (zoneOffsetCache.size > 5000) zoneOffsetCache.clear()
  zoneOffsetCache.set(hour, offset)
  return offset
}

function toIST(time: number): Date {
  return new Date(time + displayZoneOffset(time))
}

/**
 * Label for a time-axis tick. Shows coarser units at period boundaries
 * (year > month > day) relative to the previous tick, IST.
 */
export function formatTimeTickLabel(time: number, prevTime: number | null, intervalMs: number): string {
  const d = toIST(time)
  const p = prevTime !== null ? toIST(prevTime) : null
  if (intervalMs >= 86_400_000) {
    if (p && d.getUTCFullYear() !== p.getUTCFullYear()) return String(d.getUTCFullYear())
    if (!p || d.getUTCMonth() !== p.getUTCMonth()) return MONTHS[d.getUTCMonth()]
    return String(d.getUTCDate())
  }
  if (!p || d.getUTCDate() !== p.getUTCDate() || d.getUTCMonth() !== p.getUTCMonth() || d.getUTCFullYear() !== p.getUTCFullYear()) {
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  }
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Full date(+time for intraday intervals) — used by the crosshair time tag, e.g. "Wed 15 Oct '26  12:24". */
export function formatFullTime(time: number, intervalMs: number): string {
  const d = toIST(time)
  const base = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} '${pad2(d.getUTCFullYear() % 100)}`
  if (intervalMs >= 86_400_000) return base
  return `${base}  ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}
