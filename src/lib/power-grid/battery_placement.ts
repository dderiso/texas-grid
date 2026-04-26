/**
 * BatteryPlacementSolver
 * Picks where + how big to put batteries on the coarsened ERCOT topology.
 *
 * Process flow:
 *   1. configure(topology, baseline_dispatch, scenario, options)
 *   2. greedy()    — one site at a time, picks the site with the highest
 *                    marginal congestion-MWh-relief per dollar
 *   3. solve(kind) — dispatcher to method (Phase 1: greedy only)
 *
 * Phase 2 hooks (gradient, enumerate) are stubbed.
 *
 * @example
 * const placer = new BatteryPlacementSolver({ verbosity: 1 })
 *   .configure(topology, baseline, scenario, { budget_dollar: 250e6, k_max: 3 })
 * const batteries = placer.solve('greedy')
 */

import type {
  CandidateBatterySite,
  PlacedBattery,
  Scenario,
  SolverKind,
  DispatchSnapshot,
} from './types'
import { BATTERY_DEFAULTS } from './types'
import { ERCOTTopology } from './topology'
import { DCDispatchSolver } from './dispatch'

export interface PlacementOptions {
  budget_dollar: number
  k_max: number
  size_step_MWh: number
  power_to_energy_ratio: number
}

const DEFAULT_OPTIONS: PlacementOptions = {
  budget_dollar: 250e6,
  k_max: 3,
  size_step_MWh: 200,
  power_to_energy_ratio: 0.5,
}

export interface PlacementOpts {
  verbosity?: number
}

export class BatteryPlacementSolver {
  private _verbosity: number
  private _topo!: ERCOTTopology
  private _baseline: DispatchSnapshot[] = []
  private _scenario!: Scenario
  private _options: PlacementOptions = DEFAULT_OPTIONS
  private _solver!: DCDispatchSolver
  last_score: number = 0
  last_explanation: { site_id: string; relief_MWh: number; cost_dollar: number; ratio: number }[] = []

  constructor(opts: PlacementOpts = {}) {
    this._verbosity = opts.verbosity ?? 0
  }

  configure(
    topology: ERCOTTopology,
    baseline: DispatchSnapshot[],
    scenario: Scenario,
    options: Partial<PlacementOptions> = {},
  ): this {
    this._topo = topology
    this._baseline = baseline
    this._scenario = scenario
    this._options = { ...DEFAULT_OPTIONS, ...options }
    this._solver = new DCDispatchSolver({ verbosity: this._verbosity }).configure(this._topo)
    return this
  }

  solve(kind: SolverKind): PlacedBattery[] {
    if (kind === 'greedy') return this.greedy()
    if (kind === 'gradient') throw new Error('gradient solver is a Phase 2 feature')
    if (kind === 'enumerate') throw new Error('enumerate solver is a Phase 2 feature')
    throw new Error(`unknown solver kind: ${kind}`)
  }

  greedy(): PlacedBattery[] {
    const baseline_metric = this._congestion_MWh(this._baseline)
    const placed: PlacedBattery[] = []
    let budget = this._options.budget_dollar
    const explanation: { site_id: string; relief_MWh: number; cost_dollar: number; ratio: number }[] = []
    const used: Set<string> = new Set()

    for (let pick = 0; pick < this._options.k_max; pick++) {
      let best: { site: CandidateBatterySite; relief: number; cost: number; ratio: number; battery: PlacedBattery } | null = null
      for (const site of this._topo.candidate_battery_sites) {
        if (used.has(site.id)) continue
        const candidate = this._build_battery(site)
        const cost = candidate.capacity_MWh * 1000 * site.cost_per_kWh
        if (cost > budget) continue
        const trial = [...placed, candidate]
        const dispatch_with = this._solver.solve_horizon(this._scenario, trial)
        const m_with = this._congestion_MWh(dispatch_with)
        const placed_metric = placed.length === 0 ? baseline_metric : this._congestion_MWh(this._solver.solve_horizon(this._scenario, placed))
        const relief = Math.max(0, placed_metric - m_with)
        const ratio = relief / cost
        if (this._verbosity >= 2) {
          console.log(`candidate ${site.id} relief=${relief.toFixed(2)} MWh cost=$${cost.toFixed(0)} ratio=${ratio.toExponential(2)}`)
        }
        if (!best || ratio > best.ratio) best = { site, relief, cost, ratio, battery: candidate }
      }
      if (!best || best.ratio <= 0) break
      placed.push(best.battery)
      used.add(best.site.id)
      budget -= best.cost
      explanation.push({ site_id: best.site.id, relief_MWh: best.relief, cost_dollar: best.cost, ratio: best.ratio })
      if (this._verbosity >= 1) {
        console.log(`greedy pick ${pick + 1}: ${best.site.id} (relief=${best.relief.toFixed(2)} MWh, cost=$${(best.cost / 1e6).toFixed(1)}M)`)
      }
    }
    this.last_explanation = explanation
    this.last_score = explanation.reduce((s, e) => s + e.relief_MWh, 0)
    return placed
  }

  private _build_battery(site: CandidateBatterySite): PlacedBattery {
    const capacity = Math.min(site.max_capacity_MWh, this._options.size_step_MWh)
    return {
      id: `BAT-${site.id}`,
      bus: site.bus,
      capacity_MWh: capacity,
      max_power_MW: capacity * this._options.power_to_energy_ratio,
      efficiency_round_trip: BATTERY_DEFAULTS.efficiency_round_trip,
      min_SOC: BATTERY_DEFAULTS.min_SOC,
      max_SOC: BATTERY_DEFAULTS.max_SOC,
      initial_SOC: BATTERY_DEFAULTS.initial_SOC,
      cost_per_kWh: site.cost_per_kWh,
    }
  }

  private _congestion_MWh(snapshots: DispatchSnapshot[]): number {
    let s = 0
    for (const snap of snapshots) s += snap.congestion_MWh
    return s
  }
}
