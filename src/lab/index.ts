// CandLlabs — experimental market-analysis tools.
//   - similarity / Echoes : find historical look-alikes of a price stroke
//   - oracle              : probabilistic outcome model from similar pasts
//   - stats               : Market Clock (per-bucket session statistics)
//   - audio               : TradeSonifier (sonify a live trade stream)
//   - absorption          : Buyer/seller absorption detector
//   - footprints          : Institutional footprint detector
//   - levels              : Support/resistance level detector
export * from './types'
export * from './similarity'
export * from './oracle'
export * from './stats'
export * from './audio'
// The public event/type contracts already come from ./types. Re-export only
// the detectors here to avoid duplicate type exports under isolatedModules.
export { AbsorptionDetector } from './absorption'
export { InstitutionalFootprinter } from './footprints'
export { LevelDetector } from './levels'
