# Power Grid Simulation Library (`web/src/lib/power-grid/`)

Texas-coarsened ERCOT grid topology, DC optimal-power-flow dispatch,
greedy battery placement, and time-step playback for the
`/presentations/power-grid-optimization` slide deck and the
`<TexasGridDemo />` component.

The library is self-contained — no GPU, no workers — because the
coarsened ERCOT grid is small (≈20 buses, ≈30 lines, ≈60 generators) and
each scenario horizon is at most a few hundred timesteps. Everything
runs synchronously on the main thread inside a JS-only DC-OPF.

## Architecture

```
power-grid/
├── index.ts              # Public exports
├── types.ts              # Topology, Scenario, DispatchSnapshot, PlacedBattery, BalanceHorizon, …
├── topology.ts           # ERCOTTopology (load → index → B-matrix)
├── dispatch.ts           # DCDispatchSolver (merit order + DC PF + redispatch + LMP)
├── scenario_player.ts    # ScenarioPlayer (state machine + playback loop)
├── battery_placement.ts  # BatteryPlacementSolver (greedy)
└── metrics.ts            # MetricsAccumulator (baseline vs with-batteries)
```

The library has three React companions in `src/components/`:

```
TexasGridDemo.tsx          # Top-level orchestrator: scenario picker, layer toggles,
                             # horizon selector, budget slider, transport bar, side panel.
TexasGridMap.tsx           # MapChart-driven Texas map. Owns layer rendering: heatmaps
                             # (weather / supply / demand / balance) + transmission lines
                             # + bus zone-markers + 537 HIFLD plant dots + battery markers.
TexasGridMetricsPanel.tsx  # Side-by-side baseline-vs-with-batteries metrics + cumulative
                             # cost time series.
```

## Quick start

```typescript
import {
  ERCOTTopology,
  ScenarioPlayer,
  BatteryPlacementSolver,
  fetch_topology,
} from '@/lib/power-grid'

const json = await fetch_topology()
const topo = new ERCOTTopology({ verbosity: 0 })
  .load(json).index_buses().index_lines().build_b_matrix()

const player = new ScenarioPlayer({ topology: topo, step_ms: 110 })
await player.load('aug-2023-heat-dome')

const placer = new BatteryPlacementSolver({ verbosity: 0 })
  .configure(topo, player.baseline, player.scenario!, {
    budget_dollar: 900e6, k_max: 5,
    size_step_MWh: 1500, power_to_energy_ratio: 0.5,
  })
const placed = placer.greedy()
player.compute_with_batteries(placed)
player.play()
```

## Classes

All classes follow `rules/CLASSES.md`: single procedural process,
chainable builder methods, `lowercase_snake_case`, private members
prefixed with `_`, explicit CAPS state enums where relevant.

### `ERCOTTopology` (`topology.ts`)

Loads the grid topology JSON and pre-computes everything per-step
dispatch needs.

Process flow:

1. `load(topology)` — accept the validated JSON object.
2. `index_buses()` — build `bus_id → row` map; group generators and
   candidate battery sites by bus; pick the bus with the largest total
   generation capacity as the slack bus.
3. `index_lines()` — flatten lines into typed arrays
   (`line_from_index`, `line_to_index`, `line_reactance`,
   `line_limit_MW`); accumulate per-bus export capacity.
4. `build_b_matrix()` — assemble the dense susceptance matrix
   `B ∈ R^{n×n}` from the line reactances. The slack row/column is
   removed at dispatch time.

Outputs are read-only typed arrays consumed by `DCDispatchSolver`.

`fetch_topology(url?)` is a thin convenience wrapper around
`fetch('/data/texas-grid/topology.json')`.

### `DCDispatchSolver` (`dispatch.ts`)

Per-timestep economic dispatch + DC power flow on the coarsened grid.

Process flow:

1. `configure(topology)` — bind topology, invert the slack-reduced B
   matrix once via Gauss-Jordan elimination (cheap because the system
   is ≈20 buses).
2. `solve_step(inputs, t, batteries, soc)` — for one timestep:
   - **Merit order**: enumerate `(bus, available_MW, cost)` slots
     from `topology.generators_at(bus)`, scaling renewables by the
     per-zone wind/solar capacity factors and conventional units by
     `generator_availability`. Sort by marginal cost; assign cheapest
     first up to a per-bus quota of `bus_load + export_factor *
     bus_export_capacity_MW`.
   - **DC power flow**: `θ = B⁻¹ p_reduced` (slack-reduced); recover
     line flows as `(θ_i − θ_j) / x_ij`.
   - **Congestion redispatch** (`_redispatch_for_overloads`): up to
     10 iterations of "reduce expensive generation at the upstream
     bus, increase cheaper generation at the downstream bus" to drive
     the worst-overloaded line back inside its limit.
   - **LMP estimate** (`_estimate_lmp`): start with marginal cost
     uniformly, then add a directional adjustment proportional to the
     line overload past 85 % of limit.
3. `solve_horizon(scenario, batteries)` — run all timesteps; advance
   battery state-of-charge; store snapshots in a flat array.

Battery scheduling is a deterministic peak-shaving heuristic
(`_plan_battery_schedule`): allocate discharge weights proportional to
`(load_pct − 0.80)^1.5` on hours above 80 % of system peak, charge
weights proportional to `(0.65 − load_pct)^1.2` on hours below 65 %.
The schedule is normalised to respect each unit's usable energy
window and round-trip efficiency. The interface accepts a callback
slot for a future joint optimizer; `_build_ptdf` is a Phase-2 stub.

Penalty knobs (constructor-time):

| Option | Default | Role |
|---|---|---|
| `congestion_penalty_dollar_per_MWh` | 250 | Adds to dispatch cost when lines exceed limits after redispatch |
| `voll_dollar_per_MWh` | 9000 | Value of lost load — penalises unserved demand |
| `export_capacity_factor` | 0.6 | Bus generation cap = local load + factor × line export limits |

### `ScenarioPlayer` (`scenario_player.ts`)

Loads a pre-computed scenario, optionally re-solves dispatch with
placed batteries, and animates frames for the demo.

State machine:

```
IDLE → LOADING → READY → PLAYING ⇄ PAUSED
               ↘ DISPOSED (any → DISPOSED on dispose())
```

Surface:

| Method | Effect |
|---|---|
| `load(scenario_id)` | Fetch + validate `/data/texas-grid/scenarios/<id>.json`; populate `baseline` from the pre-computed `baseline_dispatch` |
| `compute_with_batteries(bs)` | Re-run `DCDispatchSolver.solve_horizon` with the placed batteries; store as `with_battery` |
| `play()` / `pause()` | Toggle a `setInterval` that advances `current_t` by 1 every `step_ms` ms |
| `seek(t)` | Clamp + jump to step `t`, emit a frame |
| `frame(t)` | `{ t, baseline: snap, with_battery: snap | null }` |
| `on(listener)` | Subscribe to `{ kind: PLAYER_STATE, t }` updates; returns an unsubscribe fn |
| `set_step_ms(ms)` | Restart the interval at the new cadence if currently playing |
| `dispose()` | Stop the interval, drop listeners, transition to `DISPOSED` |

Validation (`_validate_scenario`) enforces that the scenario's per-zone
arrays match the topology's bus count.

### `BatteryPlacementSolver` (`battery_placement.ts`)

Picks where + how big to put batteries on the topology.

Process flow:

1. `configure(topology, baseline, scenario, options)` — bind inputs;
   build a private `DCDispatchSolver` for trial dispatches.
2. `greedy()` — for each of `k_max` picks:
   - For every unused candidate site, build a trial battery, run
     `solve_horizon` on `[…placed, candidate]`, and score
     `relief = previous_congestion_MWh − new_congestion_MWh`.
   - Pick the site with the highest `relief / cost` (congestion-MWh
     of relief per dollar) and add it to the placement.
   - Stop when no remaining site fits the budget or yields positive
     relief.
3. `solve(kind)` — dispatcher; `'gradient'` and `'enumerate'` are
   explicit Phase-2 stubs that throw.

`last_explanation` exposes the per-pick `(site_id, relief_MWh,
cost_dollar, ratio)` rows so the demo can render a status line.

### `MetricsAccumulator` (`metrics.ts`)

Pure reduction over snapshots — no state, no I/O.

| Method | Returns |
|---|---|
| `accumulate(snaps, dt_h)` | `MetricsRow` — total $, congestion-MWh, peak load (net of charging), min reserve margin, line-overload minutes, battery throughput |
| `compare(baseline, with_batteries, dt_h)` | `ComparisonMetrics` — both rows + signed `delta_pct` |
| `cumulative_cost_series(snaps, dt_h)` | `{ t, values }` for the cost time-series chart |

## Data model

Defined in `types.ts`. All fields use SI-ish power-system units.

| Type | Shape | Notes |
|---|---|---|
| `Bus` | `{ id, name, lat, lon, zone, kind: 'load'\|'generation'\|'mixed' }` | One per coarsened ERCOT zone |
| `Line` | `{ id, from, to, limit_MW, reactance }` | Per-unit reactance |
| `Generator` | `{ id, bus, fuel: 'wind'\|'solar'\|'gas'\|'coal'\|'nuclear'\|'hydro', capacity_MW, marginal_cost }` | `marginal_cost` in $/MWh |
| `CandidateBatterySite` | `{ id, bus, max_capacity_MWh, cost_per_kWh }` | Used by `BatteryPlacementSolver` |
| `PlacedBattery` | `{ id, bus, capacity_MWh, max_power_MW, efficiency_round_trip, min_SOC, max_SOC, initial_SOC, cost_per_kWh }` | Sized via `power_to_energy_ratio` |
| `ScenarioMetadata` | `{ scenario_id, scenario_name, source: 'synthetic'\|'real', horizon_hours, interval_min, description?, start_iso? }` | `start_iso` is the UTC anchor for the wall-clock display |
| `ScenarioInputs` | per-bus × per-step matrices: `load_MW`, `wind_capacity_factor`, `solar_capacity_factor`, optional `generator_availability`, optional `weather_T2m_C` / `weather_wind_80m_ms` | The weather fields drive the heatmap layer |
| `Scenario` | `{ metadata, inputs, baseline_dispatch }` | The shape on disk under `public/data/texas-grid/scenarios/` |
| `DispatchSnapshot` | per-step output: `generation_MW`, `net_injection_MW`, `theta_rad`, `line_flow_MW`, `line_loading_pct`, `lmp_dollar_per_MWh`, totals, congestion, optional battery `soc_MWh` / `p_charge_MW` / `p_discharge_MW` | One per timestep |
| `LayerKind` | `'supply' \| 'demand' \| 'infrastructure' \| 'weather' \| 'plants' \| 'balance'` | The toggleable map layers; `<TexasGridMap />` renders only the active subset |
| `BalanceHorizon` | `'instant' \| 'day' \| 'month' \| 'year'` | Time window for the Balance heatmap. `instant` shows MW now; the others show the time-integrated MWh / GWh / TWh per zone |

`BATTERY_DEFAULTS` (used when a candidate is converted to a placed
battery): `efficiency_round_trip = 0.88`, `min_SOC = 0.10`, `max_SOC =
0.95`, `initial_SOC = 0.50`.

Conventions: `MW` for power, `MWh` for energy, `$/MWh` for marginal
cost, `t` is an integer step index (interval length is
`metadata.interval_min`).

## Scenarios

Layout under `public/data/texas-grid/`:

| Path | Contents |
|---|---|
| `topology.json` | The coarsened ERCOT graph (buses, lines, generators, candidate sites) |
| `topology.handauthored.json` | Reference hand-edited topology kept alongside the auto-rebuilt one |
| `plants.json` | EIA-860 generator catalog (lat/lon/fuel/capacity) — used as the `<TexasGridMap />` station overlay |
| `scenarios/<id>.json` | A `Scenario` (metadata + inputs + pre-computed `baseline_dispatch`) |
| `scenarios/weather-<id>.json` | Per-zone hourly weather time series produced by the deepbluue compress step |

Two scenarios ship today:

| `scenario_id` | Source | Horizon | Interval | Notes |
|---|---|---|---|---|
| `baseline` | synthetic | 24 h | 15 min | Idealised summer weekday — moderate wind, good solar, no shocks |
| `aug-2023-heat-dome` | real | 169 h | 60 min | HRRR atmospheric forcing for the 2023-08-21 → 2023-08-28 UTC ERCOT heat dome |

## Pre-compute pipeline

The scenario JSONs are produced offline so the demo can render
instantly. The chain (in dependency order):

| Script | Role |
|---|---|
| `scripts/fetch_texas_geo.ts` | Pull Texas state / county boundary GeoJSON used by `<TexasGridMap />` |
| `scripts/fetch_texas_plants.ts` | Pull the EIA-860 generator catalog → `public/data/texas-grid/plants.json` |
| `scripts/texas_rebuild_topology_from_plants.ts` | Aggregate plants into the per-zone `Generator` list and emit `topology.json` |
| `scripts/texas_compress_weather.py` | Run on **deepbluue** — reduces the 2 TB Texas HRRR Zarr (see `docs/TEXAS_ATMO_DATASET.md`) to a per-ERCOT-zone hourly JSON via nearest-bus assignment masks. ProgressTracker checkpoints per `docs/REMOTE_COMPUTE.md` |
| `scripts/texas_build_real_scenario.ts` | Turn the weather JSON into a `Scenario`: load = ERCOT baseline curve × cooling sensitivity to T2m; wind CF = turbine power curve on \|80 m wind\|; solar CF = clear-sky time-of-day × TCWV cloud attenuation. Pre-compute baseline dispatch via `DCDispatchSolver` and write the scenario JSON |
| `scripts/texas_precompute_scenarios.ts` | Synthetic baseline path: synthesize 24 h × 96-step zone profiles and pre-compute baseline dispatch |

Run examples:

```bash
pnpm exec tsx scripts/texas_precompute_scenarios.ts
pnpm exec tsx scripts/texas_build_real_scenario.ts --label aug-2023-heat-dome
```

## Demo wiring

`src/components/TexasGridDemo.tsx` ties everything together:

1. **Mount** — fetch `topology.json` + `plants.json` in parallel; build
   `ERCOTTopology` via the chained builder; instantiate
   `ScenarioPlayer`. Each plant is assigned to its nearest of the 20
   topology buses (Voronoi by bus centroid, cosine-corrected).
2. **Scenario tabs** — `setScenarioId(...)` triggers
   `player.load(scenario_id)`; the player resets `with_battery` and
   `placed_batteries` and emits a fresh `READY` frame.
3. **Layer toggles** — six independent toggles, each routed to
   `<TexasGridMap />`:

   | Layer | Renders | Default |
   |---|---|---|
   | `supply` | Generation field heatmap (`cool` colormap, 0 → max zone capacity) | on |
   | `demand` | Load field heatmap (`viridis`, 0 → peak zone load) | on |
   | `balance` | Net `(gen − load)` heatmap (`red_green` diverging, ±realized range, transparent at zero) | off |
   | `infrastructure` | Transmission lines, color/width by loading | on |
   | `weather` | T2m heatmap (`heat`, 18 → 44 °C) | off |
   | `plants` | 537 real HIFLD plant dots + 20 zone bus-markers (LMP-colored) | on |

   When `balance` is selected, an inline `∫ instant · day · month · year`
   selector appears for the integration window. Stacking N field
   heatmaps reduces per-layer alpha (220 → 150 → 110) so they blend
   instead of obscuring each other.
4. **Place batteries** — `<BatteryPlacementSolver>.greedy()` runs on
   the user's `budget_M`; the result is fed back into
   `player.compute_with_batteries(...)`, which re-solves the horizon
   and unlocks the "+ batteries" comparison toggle.
5. **Playback** — `play() / pause() / seek()` drive `current_t`; the
   component subscribes via `player.on(...)` and rerenders. The
   transport bar shows `start_iso + t_hours` as the wall-clock anchor
   for real scenarios; synthetic scenarios show only `t = …h`.
6. **Metrics** — `<TexasGridMetricsPanel />` consumes the same
   snapshots through `MetricsAccumulator` for the side-by-side
   comparison.

## Visualization layers (`TexasGridMap.tsx`)

The map is a `MapChart` (from `src/lib/charts/MapChart.tsx`) configured
with `city="tx"` and a `children` render-prop that draws the custom
overlays in their own SVG group, projected via the layout's
`lon_scale` / `lat_scale`.

The `tx` city map lives in `src/lib/charts/map-data.ts` and uses two
auto-generated arrays from `src/lib/charts/texas-geo-raw.ts` — the real
Texas state outline (FIPS 48) and 254 county boundary rings, both
sourced from `us-atlas@3` TopoJSON via `scripts/fetch_texas_geo.ts`.
The `CityMap` interface gained an opt-in `cosine_correct: boolean`
field; the Texas entry sets it so a 12° × 11° viewport doesn't render
~13 % too wide. SF / LA / NY are unaffected.

### Heatmap pipeline

Each field heatmap goes through the same path:

1. **Per-zone field** — pull a length-20 array of values from the
   active dispatch snapshot (`generation_MW[i]`, `lmp_dollar_per_MWh[i]`,
   …) or from `inputs` (`load_MW[i][t]`, `weather_T2m_C[i][t]`, …).
2. **IDW interpolation** (`_interpolate_field`) — for each cell of a
   56 × 80 grid spanning `TX_BOUNDS`, compute weighted average using
   `1 / d^p` with cosine-corrected distance. Power `p = 2.5` for
   weather (smooth), `p = 3` for supply / demand / balance (more
   localised).
3. **Canvas → data-URL image** (`_heatmap_image_url`) — write the
   colormap-mapped `ImageData` to an off-screen canvas, then
   `toDataURL()`. The result is rendered as an SVG `<image>` with
   `preserveAspectRatio="none"` and `imageRendering: pixelated`.
4. **Clip to Texas outline** — wrapped in a `<g
   clipPath="url(#tx-clip-heatmap)">` whose `<clipPath>` is the
   simplified state outline path. Heatmap cells outside Texas are
   masked away.
5. **Alpha shaping** — `_heatmap_image_url` accepts an `alpha_floor`
   and an optional `diverging_center`. For sequential fields, alpha
   grows as `√t` (low values fade out). For diverging fields (balance),
   alpha grows linearly with `|value − center| / half_span` so balanced
   zones (white) become fully transparent and the user only sees the
   surplus / deficit blobs.

### Balance horizon

Selecting Balance unlocks the horizon selector. The map maintains:

- `balance_avg_MW_per_zone[i]` = mean of `(gen − load)` across the
  active series (baseline or with-batteries).
- `balance_horizon_hours` = `0` (instant) / `24` / `720` / `8760`.
- `balance_url` switches between the per-snapshot value (`instant`) and
  `avg × hours` (integral). Same `red_green` colormap, same diverging
  alpha — only the units change.
- `balance_domain_MW_or_MWh` auto-tightens to the realized range so
  the legend always frames the data tightly. Legend formatter cycles
  units (`MW` → `MWh` → `GWh` → `TWh`) based on magnitude. Label
  switches to `bal·day` / `bal·month` / `bal·year` so the meaning is
  unambiguous.

### Colormaps

All colormaps come from `src/lib/charts/theme.ts`:

| Layer | Colormap | Domain |
|---|---|---|
| weather (T2m) | `heat` | 18 – 44 °C, fixed |
| supply (gen) | `cool` | 0 – auto max-zone-capacity |
| demand (load) | `viridis` | 0 – auto max-zone-load |
| balance (gen − load) | `red_green` | ±auto realized magnitude |
| infrastructure (line loading) | discrete `green / amber / red / dark-red` | < 60 / < 85 / ≤ 100 / over % |
| LMP (bus markers) | inline 3-stop blue → orange → red ramp | $0 – marginal_default + 80 |
| plant fuel (dots) | per-fuel solid color | gas / coal / nuclear / wind / solar / hydro / storage |

The `red_green` colormap (deep red `#dc2626` → light red → white →
light green → deep green `#16a34a`) was added to `theme.ts` to support
the Balance layer; it's also generally usable for any
deficit-surplus / before-after diverging signal.

## Phase 2 hooks

Discoverable extension points for future work:

- `BatteryPlacementSolver.solve('gradient' | 'enumerate')` — currently
  throws; gradient and exhaustive enumeration solvers are stubbed.
- `DCDispatchSolver._build_ptdf()` — returns an empty array; intended
  to back a PTDF-based redispatch path that replaces the current
  iterative overload swap.
- `ScenarioInputs.generator_availability` — optional; can be wired to
  outage schedules or thermal derate signals.
- `ScenarioMetadata.start_iso` — optional; new scenario builders
  should populate it directly. Existing JSONs are read-compatible
  through a description-regex fallback in the demo.
