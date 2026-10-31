#!/usr/bin/env node
// Merge recordings uploaded from another machine (<seed>/{tape,book,map}) into
// the instance's data dir (<dest>/{tape,book,map}) without double counting.
//
//   node merge-seed.mjs <seed-dir> <dest-dir>
//
// Seed data is only taken from BEFORE the instance's own first recording of
// that market (the cutoff): the instance's data is never touched, and the
// recorded spans (sessions.json) are clipped at the cutoff so they keep
// describing exactly what is on disk.
//   tape: <SYM>/<YYYY-MM-DD>.ndjson[.gz], lines [timeUs, price, qty, side].
//         Whole days before the cutoff day are copied; the cutoff day's file
//         gets the seed's earlier lines put in front.
//   book: <SYM>/<YYYY-MM-DD>/<HH>.ndjson[.gz]. Hours before the cutoff hour
//         are copied; the cutoff hour and later are left to the instance.
//   map:  daily snapshots, copied when missing.
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const [seedRoot, destRoot] = process.argv.slice(2)
if (!seedRoot || !destRoot) {
  console.error('usage: merge-seed.mjs <seed-dir> <dest-dir>')
  process.exit(1)
}
const HOUR_MS = 3_600_000

const exists = (p) => stat(p).then(() => true, () => false)
const dirs = async (p) => (await readdir(p, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name)
const files = async (p) => (await readdir(p, { withFileTypes: true }).catch(() => [])).filter((e) => e.isFile()).map((e) => e.name)
const readText = async (f) => {
  const raw = await readFile(f)
  return (f.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')
}
const readSpans = async (f) => {
  try {
    return JSON.parse(await readFile(f, 'utf8'))
  } catch {
    return []
  }
}

/** Sorted union of spans, overlapping ones joined. */
function mergeSpanLists(a, b) {
  const out = []
  for (const [x, y] of [...a, ...b].sort((p, q) => p[0] - q[0])) {
    const last = out[out.length - 1]
    if (last && x <= last[1]) last[1] = Math.max(last[1], y)
    else out.push([x, y])
  }
  return out
}

/** Spans cut to end at or before `cutoff`. */
function clipSpans(spans, cutoff) {
  return spans.filter(([a]) => a < cutoff).map(([a, b]) => [a, Math.min(b, cutoff)])
}

async function copyIfMissing(from, to) {
  if (await exists(to)) return false
  await mkdir(path.dirname(to), { recursive: true })
  await copyFile(from, to)
  return true
}

async function mergeSpansFile(seedDir, destDir, cutoff) {
  const seed = clipSpans(await readSpans(path.join(seedDir, 'sessions.json')), cutoff)
  const dest = await readSpans(path.join(destDir, 'sessions.json'))
  const out = mergeSpanLists(dest, seed)
  await writeFile(path.join(destDir, 'sessions.json'), JSON.stringify(out))
  return out.length
}

async function mergeTape(sym) {
  const seedDir = path.join(seedRoot, 'tape', sym)
  const destDir = path.join(destRoot, 'tape', sym)
  await mkdir(destDir, { recursive: true })
  const cutoff = (await readSpans(path.join(destDir, 'sessions.json')))[0]?.[0] ?? Infinity
  const cutDay = Number.isFinite(cutoff) ? new Date(cutoff).toISOString().slice(0, 10) : '9999-99-99'
  let merged = 0
  for (const f of await files(seedDir)) {
    // either side may hold a day plain or gzipped (the recorder gzips finished days)
    const m = /^(\d{4}-\d{2}-\d{2})\.ndjson(\.gz)?$/.exec(f)
    if (!m || m[1] > cutDay) continue
    const plain = path.join(destDir, `${m[1]}.ndjson`)
    const gz = `${plain}.gz`
    if (m[1] < cutDay) {
      if (!(await exists(plain)) && !(await exists(gz)) && (await copyIfMissing(path.join(seedDir, f), path.join(destDir, f)))) merged++
      continue
    }
    // the day the instance started: seed prints before the cutoff go first
    const early = (await readText(path.join(seedDir, f)))
      .split('\n')
      .filter((l) => l && Number(l.slice(1, l.indexOf(','))) / 1000 < cutoff)
    if (!early.length) continue
    const head = early.join('\n') + '\n'
    if (await exists(gz)) await writeFile(gz, gzipSync(head + (await readText(gz))))
    else await writeFile(plain, head + ((await exists(plain)) ? await readFile(plain, 'utf8') : ''))
    merged++
  }
  const spans = await mergeSpansFile(seedDir, destDir, cutoff)
  console.log(`tape ${sym}: ${merged} day files merged, ${spans} recorded spans`)
}

async function mergeBook(sym) {
  const seedDir = path.join(seedRoot, 'book', sym)
  const destDir = path.join(destRoot, 'book', sym)
  await mkdir(destDir, { recursive: true })
  const cutoff = (await readSpans(path.join(destDir, 'sessions.json')))[0]?.[0] ?? Infinity
  const cutHour = Number.isFinite(cutoff) ? Math.floor(cutoff / HOUR_MS) * HOUR_MS : Infinity
  let copied = 0
  for (const day of await dirs(seedDir)) {
    for (const f of await files(path.join(seedDir, day))) {
      const m = /^(\d{2})\.ndjson(\.gz)?$/.exec(f)
      if (!m || Date.parse(`${day}T${m[1]}:00:00Z`) >= cutHour) continue
      if (await copyIfMissing(path.join(seedDir, day, f), path.join(destDir, day, f))) copied++
    }
  }
  // the instance's first hour may begin mid-hour; seed spans stop at that hour's start
  const spans = await mergeSpansFile(seedDir, destDir, cutHour)
  console.log(`book ${sym}: ${copied} hour files copied, ${spans} recorded spans`)
}

async function copyTree(from, to) {
  let n = 0
  for (const e of await readdir(from, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) n += await copyTree(path.join(from, e.name), path.join(to, e.name))
    else if (e.isFile() && (await copyIfMissing(path.join(from, e.name), path.join(to, e.name)))) n++
  }
  return n
}

for (const sym of await dirs(path.join(seedRoot, 'tape'))) await mergeTape(sym)
for (const sym of await dirs(path.join(seedRoot, 'book'))) await mergeBook(sym)
if (await exists(path.join(seedRoot, 'map'))) {
  console.log(`map: ${await copyTree(path.join(seedRoot, 'map'), path.join(destRoot, 'map'))} files copied`)
}
