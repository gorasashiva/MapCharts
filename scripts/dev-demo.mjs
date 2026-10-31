#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const port = process.argv[2] ?? '5180'
const viteCli = path.join(root, 'node_modules/vite/bin/vite.js')
const children = [
  spawn(process.execPath, ['recorder/tapeRecorder.mjs'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['recorder/mapRecorder.mjs'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [viteCli, 'examples/basic', '--port', port, '--strictPort', '--host'], {
    cwd: root,
    stdio: 'inherit',
  }),
]

// The book recorder steps aside (exits 0) when another copy is already
// recording, so its clean exit must not take the demo down with it.
const bookRecorder = spawn(process.execPath, ['recorder/bookRecorder.mjs'], { cwd: root, stdio: 'inherit' })
children.push(bookRecorder)

let stopping = false

function stop(signal) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
}

for (const child of children) {
  child.once('error', (error) => {
    console.error('Failed to start demo service:', error)
    process.exitCode = 1
    stop('SIGTERM')
  })
  child.once('exit', (code, signal) => {
    if (stopping || (child === bookRecorder && code === 0)) return
    process.exitCode = code ?? (signal ? 1 : 0)
    stop('SIGTERM')
  })
}

process.once('SIGINT', () => {
  process.exitCode = 130
  stop('SIGTERM')
})
process.once('SIGTERM', () => {
  process.exitCode = 143
  stop('SIGTERM')
})
