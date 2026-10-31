import type { Plugin } from 'vite'

/** Dev-server bridge that answers Trade Buddy requests with the local Claude Code CLI. */
export function buddyBridge(): Plugin
