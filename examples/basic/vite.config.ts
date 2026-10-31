import { defineConfig } from 'vite'
import { buddyBridge } from './buddyBridge.mjs'

// Dev config for the demo (root = examples/basic).
//
// No proxy needed. Delta Exchange India's public market-data API
// (api.india.delta.exchange) sends `access-control-allow-origin: *` on every
// endpoint — spot, perpetuals AND options alike — and its WebSocket
// (socket.india.delta.exchange) is browser-reachable, so the page talks to the
// exchange directly in dev and in production. Nothing here needs a server side.
//
// (This is the one place the Binance version of this demo needed a dev-only
// proxy, because its options API sends no CORS headers.)
//
// The server-side pieces: in dev, Trade Buddy's Claude requests go to the
// local Claude Code CLI through buddyBridge (see buddyBridge.mjs), and
// /tape/* (recorded big-trade history) goes to the tape recorder
// (started automatically by `npm run demo` / `npm run charts`). For a
// separately started Vite server, run `npm run recorder` in another terminal.
export default defineConfig({
  plugins: [buddyBridge()],
  // Trailing slash matters: proxy keys are prefixes, and '/tape' would also grab /tapeHistory.ts.
  // /maplevels/* (MAP V3's recorded GLD option chains) goes to recorder/mapRecorder.mjs.
  server: { proxy: { '/tape/': 'http://localhost:8787', '/maplevels/': 'http://localhost:8788' } },
})
