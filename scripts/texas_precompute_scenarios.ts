/**
 * texas_precompute_scenarios.ts
 *
 * Reads topology.json, synthesizes per-zone load/wind/solar profiles for two scenarios
 * (baseline + aug-2023 heat dome), runs DCDispatchSolver over the 24h × 96-interval
 * horizon, and writes the scenario JSON (inputs + baseline_dispatch) to
 * public/data/texas-grid/scenarios/.
 *
 * Run:
 *   pnpm exec tsx scripts/texas_precompute_scenarios.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import {
  ERCOTTopology,
  DCDispatchSolver,
  type Topology,
  type Scenario,
  type ScenarioInputs,
  type ScenarioMetadata,
  type Bus,
} from '../src/lib/power-grid'

const ROOT = resolve(process.cwd())
const TOPOLOGY_PATH = resolve(ROOT, 'public/data/texas-grid/topology.json')
const SCENARIOS_DIR = resolve(ROOT, 'public/data/texas-grid/scenarios')
const INTERVAL_MIN = 15
const HORIZON_H = 24
const N_STEPS = (HORIZON_H * 60) / INTERVAL_MIN

interface ZoneShare {
  load_share: number
  data_center_load_MW: number
}

const ZONE_SHARES: Record<string, ZoneShare> = {
  HOUSTON:        { load_share: 0.190, data_center_load_MW: 1200 },
  DFW:            { load_share: 0.220, data_center_load_MW: 1400 },
  AUSTIN:         { load_share: 0.085, data_center_load_MW: 600 },
  SAN_ANTONIO:    { load_share: 0.090, data_center_load_MW: 350 },
  EL_PASO:        { load_share: 0.030, data_center_load_MW: 80 },
  RGV:            { load_share: 0.040, data_center_load_MW: 50 },
  CORPUS:         { load_share: 0.040, data_center_load_MW: 200 },
  PERMIAN:        { load_share: 0.045, data_center_load_MW: 280 },
  S_TEXAS_WIND:   { load_share: 0.005, data_center_load_MW: 0 },
  PANHANDLE:      { load_share: 0.012, data_center_load_MW: 0 },
  W_TEXAS_SOLAR:  { load_share: 0.005, data_center_load_MW: 0 },
  COMAL:          { load_share: 0.020, data_center_load_MW: 80 },
  COAST_GAS:      { load_share: 0.010, data_center_load_MW: 0 },
  E_TEXAS:        { load_share: 0.040, data_center_load_MW: 100 },
  LCRA:           { load_share: 0.015, data_center_load_MW: 50 },
  BRAZOS:         { load_share: 0.025, data_center_load_MW: 80 },
  SWEETWATER:     { load_share: 0.005, data_center_load_MW: 0 },
  N_TEXAS:        { load_share: 0.045, data_center_load_MW: 200 },
  ROANS_PRAIRIE:  { load_share: 0.008, data_center_load_MW: 0 },
  WACO:           { load_share: 0.020, data_center_load_MW: 50 },
}

function load_curve(t_h: number, peak_pct = 1.0): number {
  const baseline = 0.45
  const morning = 0.18 * Math.exp(-Math.pow((t_h - 7) / 1.8, 2))
  const evening = 0.42 * Math.exp(-Math.pow((t_h - 18) / 2.2, 2))
  const midday = 0.18 * Math.exp(-Math.pow((t_h - 14) / 3.5, 2))
  return peak_pct * (baseline + morning + evening + midday)
}

function solar_curve(t_h: number, peak_cf = 0.78): number {
  if (t_h < 6.5 || t_h > 19.5) return 0
  const x = (t_h - 13) / 4.0
  return Math.max(0, peak_cf * Math.exp(-x * x))
}

function wind_curve(t_h: number, base_cf: number, evening_dip = 0.0): number {
  const slow = base_cf + 0.10 * Math.sin((t_h / 24) * 2 * Math.PI - 1.0)
  const dip = evening_dip * Math.exp(-Math.pow((t_h - 17) / 2.5, 2))
  return Math.max(0.02, slow - dip)
}

function build_inputs(scenario_id: 'baseline' | 'aug-2023-heat-dome', buses: Bus[]): ScenarioInputs {
  const heat_dome = scenario_id === 'aug-2023-heat-dome'
  const peak_total_GW = heat_dome ? 84 : 70
  const dc_growth = heat_dome ? 1.0 : 1.0

  const wind_base_cf = heat_dome ? 0.18 : 0.30
  const wind_evening_dip = heat_dome ? 0.13 : 0.06
  const solar_peak_cf = heat_dome ? 0.82 : 0.74

  const load_MW: number[][] = []
  const wind_cf: number[][] = []
  const solar_cf: number[][] = []
  const T2m_C: number[][] = []
  const wind_80m: number[][] = []

  for (let i = 0; i < buses.length; i++) {
    const bus = buses[i]
    const share = ZONE_SHARES[bus.id] ?? { load_share: 0.005, data_center_load_MW: 0 }
    const load_row: number[] = []
    const wind_row: number[] = []
    const solar_row: number[] = []
    const T_row: number[] = []
    const wind80_row: number[] = []
    for (let t = 0; t < N_STEPS; t++) {
      const t_h = (t * INTERVAL_MIN) / 60
      const base_load = peak_total_GW * 1000 * share.load_share * load_curve(t_h)
      const dc_load = share.data_center_load_MW * dc_growth
      load_row.push(base_load + dc_load)
      const wcf = wind_curve(t_h, wind_base_cf + (bus.id === 'PANHANDLE' ? 0.05 : 0) + (bus.id === 'SWEETWATER' ? 0.04 : 0), wind_evening_dip)
      wind_row.push(wcf)
      const scf = solar_curve(t_h, solar_peak_cf - (bus.id === 'EL_PASO' ? -0.06 : 0))
      solar_row.push(scf)
      const T_base = heat_dome ? 36 : 28
      const T_diurnal = (heat_dome ? 6 : 5) * Math.sin(((t_h - 14) / 24) * 2 * Math.PI - Math.PI / 2)
      T_row.push(T_base + T_diurnal + (bus.lat - 30) * -0.4)
      wind80_row.push(7 + 4 * Math.sin((t_h / 24) * 2 * Math.PI + 1) - (heat_dome ? 2.5 : 0.5))
    }
    load_MW.push(load_row)
    wind_cf.push(wind_row)
    solar_cf.push(solar_row)
    T2m_C.push(T_row)
    wind_80m.push(wind80_row)
  }

  return {
    load_MW,
    wind_capacity_factor: wind_cf,
    solar_capacity_factor: solar_cf,
    weather_T2m_C: T2m_C,
    weather_wind_80m_ms: wind_80m,
  }
}

function build_scenario(
  scenario_id: 'baseline' | 'aug-2023-heat-dome',
  topo: ERCOTTopology,
  solver: DCDispatchSolver,
): Scenario {
  const inputs = build_inputs(scenario_id, topo.buses)
  const metadata: ScenarioMetadata = scenario_id === 'baseline'
    ? {
        scenario_id,
        scenario_name: 'Synthetic 24h Baseline',
        source: 'synthetic',
        horizon_hours: HORIZON_H,
        interval_min: INTERVAL_MIN,
        description: 'Idealised summer weekday with moderate wind, good solar, no shocks.',
      }
    : {
        scenario_id,
        scenario_name: 'Aug 25, 2023 — Heat Dome',
        source: 'real',
        horizon_hours: HORIZON_H,
        interval_min: INTERVAL_MIN,
        description: 'Record ERCOT load day. ~110°F surface temperatures, late-afternoon wind lull, peak demand meets falling renewables.',
      }
  const scenario: Scenario = {
    metadata,
    inputs,
    baseline_dispatch: [],
  }
  scenario.baseline_dispatch = solver.solve_horizon(scenario, [])
  return scenario
}

function main() {
  const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, 'utf-8')) as Topology
  const topo = new ERCOTTopology({ verbosity: 1 }).load(topology).index_buses().index_lines().build_b_matrix()
  const solver = new DCDispatchSolver({ verbosity: 1 }).configure(topo)

  if (!existsSync(SCENARIOS_DIR)) mkdirSync(SCENARIOS_DIR, { recursive: true })

  for (const id of ['baseline', 'aug-2023-heat-dome'] as const) {
    const scenario = build_scenario(id, topo, solver)
    const path = resolve(SCENARIOS_DIR, `${id}.json`)
    writeFileSync(path, JSON.stringify(scenario))
    const peak = Math.max(...scenario.baseline_dispatch.map(s => s.total_load_MW))
    const cong = scenario.baseline_dispatch.reduce((s, x) => s + x.congestion_MWh, 0)
    const cost = scenario.baseline_dispatch.reduce((s, x) => s + x.total_dispatch_cost, 0) * (INTERVAL_MIN / 60)
    console.log(`wrote ${path}  peak=${(peak/1000).toFixed(1)} GW  congestion=${cong.toFixed(0)} MWh  cost=$${(cost/1e6).toFixed(2)}M`)
  }
}

main()
