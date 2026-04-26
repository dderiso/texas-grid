/**
 * texas_build_real_scenario.ts
 *
 * Turn the deepbluue weather output (`weather-<label>.json`) into a Scenario:
 *   load_MW[bus,t]              = ERCOT-style baseline curve × cooling sensitivity to real T2m
 *   wind_capacity_factor[bus,t] = turbine power curve applied to real |80 m wind|
 *   solar_capacity_factor[bus,t]= clear-sky time-of-day curve × TCWV cloud attenuation
 *   weather_T2m_C, weather_wind_80m_ms = passed through for the demo's heatmap layer
 *
 * Then runs DCDispatchSolver to pre-compute baseline_dispatch and writes the
 * scenario JSON to public/data/texas-grid/scenarios/<label>.json.
 *
 * Run:
 *   pnpm exec tsx scripts/texas_build_real_scenario.ts --label aug-2023-heat-dome
 */

import { readFileSync, writeFileSync } from 'fs'
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

interface WeatherFile {
  scenario_id: string
  source: string
  time_iso: string[]
  interval_min: number
  n_timesteps: number
  zones: string[]
  T2m_C: number[][]
  wind_10m_ms: number[][]
  wind_80m_ms: number[][]
  tcwv_kg_m2: number[][]
}

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

/** Maps each topology bus → ERCOT weather zone (matches gridstatus column names). */
const ERCOT_WEATHER_ZONE: Record<string, string> = {
  HOUSTON:        'coast',
  CORPUS:         'coast',
  COAST_GAS:      'coast',
  ROANS_PRAIRIE:  'coast',
  E_TEXAS:        'east',
  EL_PASO:        'far_west',
  PERMIAN:        'far_west',
  W_TEXAS_SOLAR:  'far_west',
  PANHANDLE:      'north',
  DFW:            'north_central',
  N_TEXAS:        'north_central',
  BRAZOS:         'north_central',
  WACO:           'north_central',
  AUSTIN:         'south_central',
  SAN_ANTONIO:    'south_central',
  COMAL:          'south_central',
  LCRA:           'south_central',
  RGV:            'southern',
  S_TEXAS_WIND:   'southern',
  SWEETWATER:     'west',
}

interface ErcotLoadFile {
  source: string
  start_iso: string
  end_iso: string
  n_hours: number
  interval_min: number
  zones: string[]
  time_iso: string[]
  load_MW: Record<string, number[]>
  system_total: number[]
}

function load_shape(t_h_local: number): number {
  const baseline = 0.45
  const morning = 0.18 * Math.exp(-Math.pow((t_h_local - 7) / 1.8, 2))
  const evening = 0.42 * Math.exp(-Math.pow((t_h_local - 18) / 2.2, 2))
  const midday  = 0.18 * Math.exp(-Math.pow((t_h_local - 14) / 3.5, 2))
  return baseline + morning + evening + midday
}

function temperature_load_multiplier(T_C: number): number {
  const T_threshold = 22
  const sens_per_C = 0.018
  if (T_C <= T_threshold) return 1.0
  return 1.0 + sens_per_C * (T_C - T_threshold)
}

function wind_power_curve(v_ms: number): number {
  const v_cutin = 3.0
  const v_rated = 12.0
  const v_cutout = 25.0
  if (v_ms < v_cutin || v_ms > v_cutout) return 0
  if (v_ms >= v_rated) return 1.0
  const x = (v_ms - v_cutin) / (v_rated - v_cutin)
  return Math.max(0, Math.min(1, x * x * x))
}

function clear_sky_solar(t_h_local: number): number {
  if (t_h_local < 6.5 || t_h_local > 19.5) return 0
  const x = (t_h_local - 13) / 4.0
  return Math.max(0, 0.86 * Math.exp(-x * x))
}

function cloud_attenuation(tcwv_kg_m2: number): number {
  const dry = 18, wet = 55
  const t = Math.max(0, Math.min(1, (tcwv_kg_m2 - dry) / (wet - dry)))
  return 1.0 - 0.55 * t
}

function utc_to_central_hour(iso: string): number {
  const d = new Date(iso + 'Z')
  const utc_h = d.getUTCHours() + d.getUTCMinutes() / 60
  return ((utc_h - 5) + 24) % 24
}

function compute_bus_share_in_ercot_zone(buses: Bus[]): Record<string, number> {
  const zone_total: Record<string, number> = {}
  for (const b of buses) {
    const z = ERCOT_WEATHER_ZONE[b.id]
    const s = ZONE_SHARES[b.id]?.load_share ?? 0
    if (!z || s <= 0) continue
    zone_total[z] = (zone_total[z] ?? 0) + s
  }
  const out: Record<string, number> = {}
  for (const b of buses) {
    const z = ERCOT_WEATHER_ZONE[b.id]
    const s = ZONE_SHARES[b.id]?.load_share ?? 0
    if (!z || zone_total[z] <= 0) { out[b.id] = 0; continue }
    out[b.id] = s / zone_total[z]
  }
  return out
}

function build_inputs(weather: WeatherFile, ercot: ErcotLoadFile | null, topo: Topology, peak_total_GW: number): ScenarioInputs {
  const n_steps = ercot ? Math.min(weather.n_timesteps, ercot.n_hours) : weather.n_timesteps
  const n_buses = topo.buses.length
  const zone_to_weather_idx = new Map(weather.zones.map((z, i) => [z, i]))
  const local_hours = weather.time_iso.map(utc_to_central_hour)
  const bus_share_in_ercot = compute_bus_share_in_ercot_zone(topo.buses)

  const load_MW: number[][] = []
  const wind_cf: number[][] = []
  const solar_cf: number[][] = []
  const T2m: number[][] = []
  const wind80: number[][] = []
  const tcwv: number[][] = []

  for (let i = 0; i < n_buses; i++) {
    const bus = topo.buses[i]
    const w_idx = zone_to_weather_idx.get(bus.id) ?? -1
    const share = ZONE_SHARES[bus.id] ?? { load_share: 0.005, data_center_load_MW: 0 }
    const ercot_zone = ERCOT_WEATHER_ZONE[bus.id]
    const ercot_load_row = ercot && ercot_zone ? ercot.load_MW[ercot_zone] : null
    const bus_frac = bus_share_in_ercot[bus.id] ?? 0
    const load_row: number[] = []
    const wind_row: number[] = []
    const solar_row: number[] = []
    const T_row: number[] = []
    const w80_row: number[] = []
    const tcwv_row: number[] = []
    for (let t = 0; t < n_steps; t++) {
      const t_h_local = local_hours[t]
      const T_C   = w_idx >= 0 ? weather.T2m_C[w_idx][t]       : 28
      const v80   = w_idx >= 0 ? weather.wind_80m_ms[w_idx][t] : 7
      const tcwv_ = w_idx >= 0 ? weather.tcwv_kg_m2[w_idx][t]  : 30
      let load_val: number
      if (ercot_load_row && bus_frac > 0) {
        load_val = ercot_load_row[t] * bus_frac
      } else {
        const base = peak_total_GW * 1000 * share.load_share * load_shape(t_h_local)
        load_val = base * temperature_load_multiplier(T_C) + share.data_center_load_MW
      }
      load_row.push(load_val)
      wind_row.push(wind_power_curve(v80))
      solar_row.push(clear_sky_solar(t_h_local) * cloud_attenuation(tcwv_))
      T_row.push(T_C)
      w80_row.push(v80)
      tcwv_row.push(tcwv_)
    }
    load_MW.push(load_row)
    wind_cf.push(wind_row)
    solar_cf.push(solar_row)
    T2m.push(T_row)
    wind80.push(w80_row)
    tcwv.push(tcwv_row)
  }

  return {
    load_MW,
    wind_capacity_factor: wind_cf,
    solar_capacity_factor: solar_cf,
    weather_T2m_C: T2m,
    weather_wind_80m_ms: wind80,
  }
}

function main() {
  const args = process.argv.slice(2)
  const label_idx = args.indexOf('--label')
  const label = label_idx >= 0 ? args[label_idx + 1] : 'aug-2023-heat-dome'
  const peak_idx = args.indexOf('--peak-GW')
  const peak_total_GW = peak_idx >= 0 ? Number(args[peak_idx + 1]) : 73

  const weather_path = resolve(ROOT, `public/data/texas-grid/scenarios/weather-${label}.json`)
  const ercot_path   = resolve(ROOT, `public/data/texas-grid/scenarios/ercot-load-${label}.json`)
  const topology_path = resolve(ROOT, 'public/data/texas-grid/topology.json')
  const out_path = resolve(ROOT, `public/data/texas-grid/scenarios/${label}.json`)

  const weather = JSON.parse(readFileSync(weather_path, 'utf-8')) as WeatherFile
  const topology = JSON.parse(readFileSync(topology_path, 'utf-8')) as Topology
  let ercot: ErcotLoadFile | null = null
  try {
    ercot = JSON.parse(readFileSync(ercot_path, 'utf-8')) as ErcotLoadFile
    console.log(`ercot load: ${ercot.n_hours} h, ${ercot.start_iso} → ${ercot.end_iso}, peak system_total=${Math.max(...ercot.system_total).toFixed(0)} MW`)
  } catch {
    console.log(`(no ${ercot_path} — falling back to synthesized load)`)
  }

  console.log(`weather: ${weather.n_timesteps} steps × ${weather.zones.length} zones, ${weather.time_iso[0]} → ${weather.time_iso.at(-1)}`)
  const T_max = Math.max(...weather.T2m_C.flat())
  const T_min = Math.min(...weather.T2m_C.flat())
  const w80_max = Math.max(...weather.wind_80m_ms.flat())
  console.log(`  T2m range: ${T_min.toFixed(1)}°C → ${T_max.toFixed(1)}°C   max |80m wind|: ${w80_max.toFixed(1)} m/s`)

  const topo = new ERCOTTopology({ verbosity: 1 }).load(topology).index_buses().index_lines().build_b_matrix()
  const inputs = build_inputs(weather, ercot, topology, peak_total_GW)

  const n_steps = inputs.load_MW[0]?.length ?? 0
  const peak_per_step = new Array(n_steps).fill(0)
  for (let i = 0; i < inputs.load_MW.length; i++) {
    for (let t = 0; t < n_steps; t++) peak_per_step[t] += inputs.load_MW[i][t]
  }
  const peak_load = Math.max(...peak_per_step)
  console.log(`derived peak total load: ${(peak_load/1000).toFixed(1)} GW`)

  const metadata: ScenarioMetadata = {
    scenario_id: label,
    scenario_name: label === 'aug-2023-heat-dome' ? 'Aug 21–28, 2023 — ERCOT Heat Dome (real load + HRRR)' : label,
    source: 'real',
    horizon_hours: n_steps,
    interval_min: weather.interval_min,
    description: `Real ERCOT load (gridstatus.io ercot_load_by_weather_zone) + real HRRR atmospheric forcing (${weather.source}). Hourly ${weather.time_iso[0]} → ${weather.time_iso[n_steps - 1] ?? weather.time_iso.at(-1)} UTC.`,
    start_iso: weather.time_iso[0],
  }

  const scenario: Scenario = { metadata, inputs, baseline_dispatch: [] }
  const solver = new DCDispatchSolver({ verbosity: 1 }).configure(topo)
  scenario.baseline_dispatch = solver.solve_horizon(scenario, [])

  writeFileSync(out_path, JSON.stringify(scenario))
  const cong = scenario.baseline_dispatch.reduce((s, x) => s + x.congestion_MWh, 0)
  const cost = scenario.baseline_dispatch.reduce((s, x) => s + x.total_dispatch_cost, 0) * (weather.interval_min / 60)
  console.log(`wrote ${out_path}  peak=${(peak_load/1000).toFixed(1)} GW  congestion=${cong.toFixed(0)} MWh  cost=$${(cost/1e6).toFixed(2)}M`)
}

main()
