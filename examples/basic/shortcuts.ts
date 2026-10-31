// App-level keyboard shortcuts. The chart engine already owns Escape (cancel
// tool / deselect) and Delete/Backspace (remove selected drawing) globally —
// see src/chart/engine.ts's handleKeyDown — so this only adds the shortcuts
// the engine doesn't: chart-type quick switch, replay stepping, symbol
// search focus, and the watchlist toggle.
import type { ChartType } from '../../src/index'

export interface ShortcutHooks {
  setChartType(type: ChartType): void
  focusSymbolSearch(): void
  toggleWatchlist(): void
  isReplayActive(): boolean
  replayStepBack(): void
  replayStepForward(): void
}

/** 1-9 → these chart types, in order (matches the most commonly used types first). */
const NUMBER_CHART_TYPES: ChartType[] = ['candles', 'heikin', 'bars', 'line', 'area', 'baseline', 'hollow', 'columns', 'renko']

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable
}

/** Installs the global keydown listener; returns a function that removes it. */
export function installShortcuts(hooks: ShortcutHooks): () => void {
  function onKeyDown(e: KeyboardEvent): void {
    if (isEditableTarget(e.target)) return
    if (e.metaKey || e.ctrlKey) return // never hijack browser/OS shortcuts

    if (e.key === '/') {
      e.preventDefault()
      hooks.focusSymbolSearch()
      return
    }
    if (e.altKey && e.key.toLowerCase() === 'w') {
      e.preventDefault()
      hooks.toggleWatchlist()
      return
    }
    if (hooks.isReplayActive() && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      if (e.key === 'ArrowLeft') hooks.replayStepBack()
      else hooks.replayStepForward()
      return
    }
    if (!e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
      const type = NUMBER_CHART_TYPES[Number(e.key) - 1]
      if (type) {
        e.preventDefault()
        hooks.setChartType(type)
      }
    }
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}
