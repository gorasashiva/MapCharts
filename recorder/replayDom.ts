// DOM replay — runs recorded book + trades (recorder/bookRecorder.mjs) through
// the same DomSession the live DOM dashboard uses, on the recorded clock, and
// writes out what the dashboard would have shown, for study:
//
//   npm run replay:dom -- --symbol XAUTUSD --from 2026-10-30 [--to 2026-11-06] [--dir book-data] [--out replay-out/...]
//
// --from / --to are UTC days (YYYY-MM-DD) or hours (YYYY-MM-DDTHH), inclusive.
// Output folder:
//   readings.ndjson  every 2s: time, price, the reading shown (after the 10s hold),
//                    the raw score and factors behind it, cautions, typical move
//   events.ndjson    every DOM marker: pull / taken / absorb / sweep, with side
//   calls.ndjson     every long/short call and how it resolved (target / stop / expired)
//   summary.json     hours replayed, gaps, sessions, call tally, events by kind
//
// A recorder outage longer than a minute starts a fresh session (warm-up and
// all), as reopening the live dashboard would; a short sequence gap just
// resyncs from the next snapshot, as the live book does.
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { createGunzip, constants as zc } from 'node:zlib'
import path from 'node:path'
import { parseLine, type BookTapeRecord } from '../src/overlays/bookTape'
import { DomSession, marketSetup } from '../src/overlays/domSession'
import { advise, type AdvisorCall } from '../src/overlays/domAdvisorModel'
import type { DomEvent } from '../src/overlays/domLevelsModel'

const TICK_MS = 250
/** A silence longer than this is an outage: start a new session. */
const OUTAGE_MS = 60_000

function args(): Record<string, string> {
  const out: Record<string, string> = {}
  const a = process.argv.slice(2).filter((x) => x !== '--')
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) out[a[i].slice(2)] = a[i + 1] === undefined || a[i + 1].startsWith('--') ? 'true' : a[++i]
  return out
}

/** Hour files for a symbol in [from, to], oldest first. */
async function hourFiles(dir: string, symbol: string, from: string, to: string): Promise<string[]> {
  const root = path.join(dir, symbol)
  const days = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  const files: string[] = []
  for (const day of days) {
    if (day < from.slice(0, 10) || day > to.slice(0, 10)) continue
    const names = (await readdir(path.join(root, day))).filter((f) => /^\d\d\.ndjson(\.gz)?$/.test(f)).sort()
    for (const f of names) {
      const key = `${day}T${f.slice(0, 2)}`
      if ((from.length > 10 && key < from) || (to.length > 10 && key > to)) continue
      files.push(path.join(root, day, f))
    }
  }
  return files
}

async function* records(file: string): AsyncGenerator<BookTapeRecord> {
  const raw = createReadStream(file)
  // a gzip cut short still yields what it has
  const input = file.endsWith('.gz') ? raw.pipe(createGunzip({ finishFlush: zc.Z_SYNC_FLUSH })) : raw
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const r = parseLine(line)
    if (r) yield r
  }
}

const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d

async function main(): Promise<void> {
  const a = args()
  const symbol = (a.symbol ?? 'XAUTUSD').toUpperCase()
  const dir = path.resolve(a.dir ?? 'book-data')
  const from = a.from ?? new Date().toISOString().slice(0, 10)
  const to = a.to ?? from
  const out = path.resolve(a.out ?? path.join('replay-out', `${symbol}_${from}_${to}`.replace(/:/g, '')))
  const files = await hourFiles(dir, symbol, from, to).catch(() => [])
  if (!files.length) {
    console.error(`No recorded hours for ${symbol} between ${from} and ${to} in ${dir}`)
    process.exit(1)
  }
  await mkdir(out, { recursive: true })
  const open = (f: string): WriteStream => createWriteStream(path.join(out, f))
  const readingsOut = open('readings.ndjson'), eventsOut = open('events.ndjson'), callsOut = open('calls.ndjson')
  const setup = marketSetup(symbol)

  let session: DomSession | null = null
  let nextTick = 0
  let lastRecv = 0
  let sessions = 0, gaps = 0, bookLines = 0, trades = 0, readings = 0
  const allCalls: AdvisorCall[] = []
  const eventCounts: Record<string, number> = {}
  const emitted = new WeakSet<DomEvent>()

  // new markers sit at the tail of the tracker's list
  const flushEvents = (s: DomSession): void => {
    const ev = s.tracker.events
    const fresh: DomEvent[] = []
    for (let i = ev.length - 1; i >= 0 && !emitted.has(ev[i]); i--) fresh.push(ev[i])
    for (const e of fresh.reverse()) {
      emitted.add(e)
      const key = e.kind === 'absorb' ? `absorb-${e.side}` : `${e.kind}${e.tentative ? '?' : ''}`
      eventCounts[key] = (eventCounts[key] ?? 0) + 1
      eventsOut.write(JSON.stringify({ t: e.t, kind: e.kind, price: e.price, value: Math.round(e.value), side: e.side ?? null, tentative: !!e.tentative }) + '\n')
    }
  }
  const closeSession = (): void => {
    if (!session) return
    flushEvents(session)
    for (const c of session.record.calls) {
      allCalls.push(c)
      callsOut.write(JSON.stringify(c) + '\n')
    }
    session = null
  }
  // run the live dashboard's 250ms timer up to time t
  const advanceTo = (t: number): void => {
    if (!session) return
    while (nextTick <= t) {
      if (session.tick(nextTick) && session.lastInput && session.lastInput.now === nextTick) {
        const raw = advise(session.lastInput)
        const shown = session.advice
        readings++
        readingsOut.write(
          JSON.stringify({
            t: nextTick,
            price: session.lastInput.price,
            shown: session.shownBias,
            raw: raw.bias,
            score: raw.score,
            confidence: shown?.confidence ?? 0,
            typicalMove: round(session.lastInput.typicalMove),
            factors: raw.factors.map((f) => [f.name, round(f.score, 2)]),
            cautions: raw.cautions,
            plan: shown?.plan ? { zone: shown.plan.zone, stop: round(shown.plan.stop), target: round(shown.plan.target), rr: round(shown.plan.rr, 2) } : null,
          }) + '\n',
        )
      }
      flushEvents(session)
      nextTick += TICK_MS
    }
  }

  for (const file of files) {
    for await (const r of records(file)) {
      if (session && r.recvMs - lastRecv > OUTAGE_MS) {
        advanceTo(lastRecv)
        closeSession()
      }
      if (!session) {
        session = new DomSession(setup, r.recvMs)
        nextTick = Math.ceil(r.recvMs / TICK_MS) * TICK_MS
        sessions++
      }
      advanceTo(r.recvMs - 1)
      lastRecv = r.recvMs
      if (r.kind === 'book') {
        session.onBook(r.action, r.bids, r.asks, r.recvMs)
        bookLines++
      } else if (r.kind === 'trade') {
        session.onTrade(r.price, r.qty, r.buy, r.recvMs)
        trades++
      } else if (r.kind === 'gap') gaps++
    }
    process.stderr.write(`replayed ${path.relative(dir, file)}\n`)
  }
  advanceTo(lastRecv)
  closeSession()

  const calls = { calls: allCalls.length, target: 0, stop: 0, expired: 0, open: 0 }
  for (const c of allCalls) calls[c.outcome]++
  const summary = { symbol, from, to, files: files.length, sessions, gaps, bookLines, trades, readings, calls, events: eventCounts, out }
  await Promise.all([readingsOut, eventsOut, callsOut].map((w) => new Promise((res) => w.end(res))))
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}

void main()
