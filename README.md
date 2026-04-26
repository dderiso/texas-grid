# texas-grid

Coarsened ERCOT topology (≈20 buses, ≈30 lines, ≈60 generators), DC
optimal-power-flow dispatch, greedy battery placement, and time-step
playback for an interactive Texas grid demo.

See `docs/README_web_power_grid.md` for the full architecture writeup.

## Layout

```
src/lib/power-grid/   Self-contained simulation library (TS, no deps)
src/components/       React UI (TexasGridDemo, TexasGridMap, MetricsPanel)
public/data/          Topology, plants, scenarios, weather
scripts/              Pre-compute pipeline (fetch → build → solve)
docs/                 Architecture notes
```

## Note on dependencies

The components reference a few helpers that were intentionally **not**
copied from the source repo (they live in private chart / ml / linalg
libraries):

- `@/lib/charts/MapChart`
- `@/lib/charts/theme` (`colormap_f32`)
- `@/lib/charts/texas-geo-raw` (`TX_STATE_OUTLINE`)

Wire those up (or substitute) before `TexasGridMap.tsx` will compile.
The `power-grid/` library itself has no such dependencies and runs
standalone.

## Quick start

```typescript
import {
  ERCOTTopology,
  ScenarioPlayer,
  BatteryPlacementSolver,
  fetch_topology,
} from './src/lib/power-grid'

const json = await fetch_topology()
const topo = new ERCOTTopology()
  .load(json).index_buses().index_lines().build_b_matrix()

const player = new ScenarioPlayer({ topology: topo, step_ms: 110 })
await player.load('aug-2023-heat-dome')

const placer = new BatteryPlacementSolver()
  .configure(topo, player.baseline, player.scenario!, {
    budget_dollar: 900e6, k_max: 5,
    size_step_MWh: 1500, power_to_energy_ratio: 0.5,
  })
player.compute_with_batteries(placer.greedy())
player.play()
```
