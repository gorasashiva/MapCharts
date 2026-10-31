// Price alerts. An alert fires when the symbol's live price crosses its level
// in the configured direction; firing shows a browser notification (+ optional
// sound) and marks the alert triggered. Alerts are unlimited and per-account.

export interface Alert {
  id: string
  symbol: string // e.g. "BTCUSDT"
  price: number
  condition: 'above' | 'below' // fires when price crosses to >= (above) / <= (below)
  message?: string // optional user note shown in the notification
  createdAt: number // epoch ms
  triggered: boolean
  triggeredAt?: number // epoch ms when it fired
}

/** Number of built-in alert tunes (see src/alerts/tunes.ts). */
export const ALERT_TUNE_COUNT = 10
/** Bounds for how long an alert tune plays, in whole seconds. */
export const ALERT_DURATION_MIN = 1
export const ALERT_DURATION_MAX = 10

/** Chart appearance + behavior settings (Settings dialog). */
export interface ChartSettings {
  upColor: string // candle/up color (hex)
  downColor: string // candle/down color (hex)
  gridVisible: boolean
  crosshairVisible: boolean
  alertSound: boolean // play a sound when an alert fires
  alertTune: number // which of the 10 tunes (0-based index) plays on fire
  alertDuration: number // how long the tune plays, in whole seconds
}

export const DEFAULT_SETTINGS: ChartSettings = {
  upColor: '#089981',
  downColor: '#f23645',
  gridVisible: false,
  crosshairVisible: true,
  alertSound: true,
  alertTune: 0,
  alertDuration: 2,
}

/** Clamp any value to a valid tune index, falling back to the default. */
export function clampAlertTune(n: unknown): number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < ALERT_TUNE_COUNT
    ? n
    : DEFAULT_SETTINGS.alertTune
}

/** Clamp any value to an in-range whole-second duration. */
export function clampAlertDuration(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_SETTINGS.alertDuration
  return Math.min(ALERT_DURATION_MAX, Math.max(ALERT_DURATION_MIN, Math.round(n)))
}
