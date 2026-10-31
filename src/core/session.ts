/**
 * When a symbol's trading day opens. Session-anchored indicators (CPR, IV
 * Walls, Ultra V2's VWAP / IB / session profile, Volume Profile's session
 * mode, DeepCharts Big Trades' session reset) start their day here instead of
 * at a hard-coded UTC midnight.
 *
 * Default: 00:00 UTC (05:30 IST), Delta's daily-candle boundary. Gold follows
 * the metals market open at 22:00 UTC (03:30 IST), so its session that opens
 * Sunday 22:00 UTC is Monday's, and its thin weekend trading is ignored. That
 * covers both gold tokens: Delta's XAUTUSD and Binance's PAXGUSDT.
 */
const SESSION_OPEN_HOUR_UTC: Record<string, number> = {
  XAUTUSD: 22,
  PAXGUSDT: 22,
}

export const SESSION_DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** Markets that are shut Sat/Sun: their dead weekend sessions are left out of daily levels (Monday uses Friday). */
const CLOSED_WEEKENDS = new Set(['XAUTUSD', 'PAXGUSDT'])

export function sessionClosedWeekends(symbol: string): boolean {
  return CLOSED_WEEKENDS.has(symbol.toUpperCase())
}

/** UTC hour the symbol's trading day opens (0 unless listed above). */
export function sessionOpenHourUTC(symbol: string): number {
  return SESSION_OPEN_HOUR_UTC[symbol.toUpperCase()] ?? 0
}

/** Index of the session containing `time` — equal for every bar of one session. */
export function sessionIndex(time: number, openHourUTC: number): number {
  return Math.floor((time - openHourUTC * HOUR_MS) / SESSION_DAY_MS)
}

/** Open time (epoch ms) of the session containing `time`. */
export function sessionStart(time: number, openHourUTC: number): number {
  return sessionIndex(time, openHourUTC) * SESSION_DAY_MS + openHourUTC * HOUR_MS
}

/** "03:30 IST" style label for a UTC open hour. */
export function sessionOpenLabelIST(openHourUTC: number): string {
  const m = (((openHourUTC * 60 + 330) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} IST`
}
