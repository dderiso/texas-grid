/**
 * Power Grid Types
 * Core types for the Texas grid simulation, dispatch, and battery placement demo.
 *
 * Conventions:
 *   - All power values in MW
 *   - All energy values in MWh
 *   - All costs in $/MWh
 *   - Time index t is 0..n_intervals-1, where each interval is interval_min long
 *   - Bus / line / generator / battery ids are stable string identifiers
 */

export type FuelType = 'wind' | 'solar' | 'gas' | 'coal' | 'nuclear' | 'hydro'
export type BusKind = 'load' | 'generation' | 'mixed'

export interface Bus {
  id: string
  name: string
  lat: number
  lon: number
  zone: string
  kind: BusKind
}

export interface Line {
  id: string
  from: string
  to: string
  limit_MW: number
  reactance: number
}

export interface Generator {
  id: string
  bus: string
  fuel: FuelType
  capacity_MW: number
  marginal_cost: number
}

export interface CandidateBatterySite {
  id: string
  bus: string
  max_capacity_MWh: number
  cost_per_kWh: number
}

export interface Topology {
  buses: Bus[]
  lines: Line[]
  generators: Generator[]
  candidate_battery_sites: CandidateBatterySite[]
}

export interface PlacedBattery {
  id: string
  bus: string
  capacity_MWh: number
  max_power_MW: number
  efficiency_round_trip: number
  min_SOC: number
  max_SOC: number
  initial_SOC: number
  cost_per_kWh: number
}

export interface ScenarioMetadata {
  scenario_id: string
  scenario_name: string
  source: 'synthetic' | 'real'
  horizon_hours: number
  interval_min: number
  description?: string
  start_iso?: string
}

export interface ScenarioInputs {
  load_MW: number[][]
  wind_capacity_factor: number[][]
  solar_capacity_factor: number[][]
  generator_availability?: number[][]
  weather_T2m_C?: number[][]
  weather_wind_80m_ms?: number[][]
}

export interface DispatchSnapshot {
  t: number
  generation_MW: number[]
  net_injection_MW: number[]
  theta_rad: number[]
  line_flow_MW: number[]
  line_loading_pct: number[]
  lmp_dollar_per_MWh: number[]
  total_load_MW: number
  total_generation_MW: number
  total_renewable_MW: number
  total_dispatch_cost: number
  congestion_MWh: number
  reserve_margin_MW: number
  battery_soc_MWh?: number[]
  battery_p_charge_MW?: number[]
  battery_p_discharge_MW?: number[]
}

export interface Scenario {
  metadata: ScenarioMetadata
  inputs: ScenarioInputs
  baseline_dispatch: DispatchSnapshot[]
}

export interface MetricsRow {
  total_cost: number
  congestion_MWh: number
  peak_load_MW: number
  reserve_margin_min_MW: number
  line_overload_minutes: number
  battery_throughput_MWh: number
}

export interface ComparisonMetrics {
  baseline: MetricsRow
  with_batteries: MetricsRow
  delta_pct: {
    cost: number
    congestion: number
    peak: number
    reserve: number
    overload: number
  }
}

export const BATTERY_DEFAULTS = {
  efficiency_round_trip: 0.88,
  min_SOC: 0.10,
  max_SOC: 0.95,
  initial_SOC: 0.50,
} as const

export type LayerKind = 'supply' | 'demand' | 'infrastructure' | 'weather' | 'plants' | 'balance'
export type BalanceHorizon = 'instant' | 'day' | 'month' | 'year'
export type SolverKind = 'greedy' | 'gradient' | 'enumerate'
