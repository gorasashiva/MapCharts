# Contributing

Thanks for your interest in CandL Charts!

## Development

- `npm install`
- `npm run typecheck` — type-check the library
- `npm run build` — build (ES + CJS bundles + `.d.ts`) into `dist/`
- `npm run demo` — run the demo with its local trade-tape recorder

## Pull requests

- Keep changes focused and match the existing style (TypeScript strict).
- The library must stay **data-agnostic** — don't add network or data-fetching
  code to the core; supplying data is the consumer's responsibility.
- By submitting a contribution, you agree it is licensed under Apache-2.0.
