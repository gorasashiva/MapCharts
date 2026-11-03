// Indicator signal alerts: a browser notification (when permitted), an in-page
// toast and the alert tune. Used by indicators that raise their own events
// (TPO VA Fade orders / fills, Heavy Absorption prints) rather than price-cross
// alerts, which live in src/alerts.

import { ensureNotificationPermission } from '../../src/alerts/notify'
import { playTune } from '../../src/alerts/tunes'

let permissionAsked = false

/** Ask for notification permission once per page (the browser remembers the answer). */
export function askNotificationPermissionOnce(): void {
  if (permissionAsked) return
  permissionAsked = true
  void ensureNotificationPermission()
}

function toast(text: string): void {
  if (typeof document === 'undefined') return
  const el = document.createElement('div')
  el.className = 'alert-toast'
  el.setAttribute('role', 'status')
  el.textContent = text
  document.body.appendChild(el)
  requestAnimationFrame(() => el.classList.add('show'))
  const remove = (): void => {
    el.classList.remove('show')
    window.setTimeout(() => el.remove(), 250)
  }
  window.setTimeout(remove, 9000)
  el.addEventListener('click', remove)
}

export function fireSignalAlert(title: string, text: string, sound: boolean): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body: text, tag: `${title}:${text}`, silent: false })
  } catch {
    /* notifications unavailable — the toast and sound still fire */
  }
  toast(`${title}: ${text}`)
  if (sound) playTune(0, 2)
}
