/**
 * DCDispatchSolver
 * Per-timestep economic dispatch + DC power flow on a coarsened ERCOT topology.
 *
 * Process flow:
 *   1. configure(topology)         — bind topology and pre-invert the slack-reduced B matrix
 *   2. solve_step(inputs, t, ...)  — economic merit-order dispatch + DC power flow + LMP estimate
 *   3. solve_horizon(scenario, ...) — run all timesteps; supports a battery policy callback
 *
 * Battery policy: a small, deterministic, peak-shaving heuristic. Charges from the cheapest
 * generation when SOC is low and grid stress is low; discharges proportionally to local stress
 * (load - local generation capacity) when stress is high. Phase 2 will replace with a joint optimizer.
 *
 * @example
 * const solver = new DCDispatchSolver({ verbosity: 1 }).configure(topo)
 * const snapshots = solver.solve_horizon(scenario, [])
 */

import type {
  DispatchSnapshot,
  PlacedBattery,
  Scenario,
  ScenarioInputs,
} from './types'
import { ERCOTTopology } from './topology'

export interface DispatchOptions {
  verbosity?: number
  congestion_penalty_dollar_per_MWh?: number
  voll_dollar_per_MWh?: number
  export_capacity_factor?: number
}

interface DispatchSlot {
  bus: number
  available_MW: number
  cost: number
  dispatched_MW: number
}

interface MeritDispatchResult {
  gen_per_bus: Float64Array
  slots: DispatchSlot[]
  total_generation: number
  total_cost: number
  marginal_cost: number
  unserved_MW: number
}

export class DCDispatchSolver {
  private _verbosity: number
  private _congestion_penalty: number
  private _voll: number
  private _export_factor: number
  private _topo!: ERCOTTopology
  private _b_inv: Float64Array = new Float64Array(0)
  private _ptdf: Float64Array = new Float64Array(0)
  private _cached_peak_load_MW = 0
  private _cached_battery_schedule: { charge_MW: Float64Array; discharge_MW: Float64Array }[] | null = null

  constructor(opts: DispatchOptions = {}) {
    this._verbosity = opts.verbosity ?? 0
    this._congestion_penalty = opts.congestion_penalty_dollar_per_MWh ?? 250
    this._voll = opts.voll_dollar_per_MWh ?? 9000
    this._export_factor = opts.export_capacity_factor ?? 0.6
  }

  configure(topo: ERCOTTopology): this {
    this._topo = topo
    this._b_inv = this._invert_reduced_b()
    this._ptdf = this._build_ptdf()
    return this
  }

  solve_step(
    inputs: ScenarioInputs,
    t: number,
    batteries: PlacedBattery[] = [],
    soc_MWh: Float64Array | null = null,
  ): DispatchSnapshot {
    const n = this._topo.n_buses
    const total_load = this._sum_zone(inputs.load_MW, t)

    const battery_targets = this._battery_targets_for_step(inputs, t, batteries, soc_MWh)
    const sum_charge = battery_targets.reduce((s, b) => s + b.p_charge, 0)
    const sum_discharge = battery_targets.reduce((s, b) => s + b.p_discharge, 0)
    const net_target = total_load + sum_charge - sum_discharge

    const dispatch = this._merit_order_dispatch(inputs, t, net_target)
    const battery_net = new Float64Array(n)
    for (const b of battery_targets) {
      const i = this._topo.bus_index(b.bus)
      battery_net[i] += b.p_discharge - b.p_charge
    }
    const bus_load = new Float64Array(n)
    for (let i = 0; i < n; i++) bus_load[i] = this._zone(inputs.load_MW, t, i)

    this._redispatch_for_overloads(dispatch, bus_load, battery_net)

    const net_inj = new Float64Array(n)
    for (let i = 0; i < n; i++) net_inj[i] = dispatch.gen_per_bus[i] - bus_load[i] + battery_net[i]

    const theta = this._dc_power_flow(net_inj)
    const line_flow = this._line_flows(theta)
    const line_loading = new Float64Array(this._topo.n_lines)
    let congestion = 0
    for (let l = 0; l < this._topo.n_lines; l++) {
      const limit = this._topo.line_limit_MW[l]
      const f = Math.abs(line_flow[l])
      line_loading[l] = limit > 0 ? f / limit : 0
      if (f > limit) congestion += (f - limit)
    }

    const lmp = this._estimate_lmp(dispatch.marginal_cost, line_flow)

    const total_renew = this._total_renewable(inputs, t)
    const total_capacity = this._total_available_capacity(inputs, t)
    const reserve = total_capacity - dispatch.total_generation

    const dt_h = 0.25
    const snapshot: DispatchSnapshot = {
      t,
      generation_MW: Array.from(dispatch.gen_per_bus),
      net_injection_MW: Array.from(net_inj),
      theta_rad: Array.from(theta),
      line_flow_MW: Array.from(line_flow),
      line_loading_pct: Array.from(line_loading),
      lmp_dollar_per_MWh: Array.from(lmp),
      total_load_MW: total_load,
      total_generation_MW: dispatch.total_generation,
      total_renewable_MW: total_renew,
      total_dispatch_cost: dispatch.total_cost + congestion * this._congestion_penalty + dispatch.unserved_MW * this._voll,
      congestion_MWh: congestion * dt_h,
      reserve_margin_MW: reserve,
    }
    if (batteries.length > 0) {
      snapshot.battery_p_charge_MW = batteries.map((_b, idx) => battery_targets[idx]?.p_charge ?? 0)
      snapshot.battery_p_discharge_MW = batteries.map((_b, idx) => battery_targets[idx]?.p_discharge ?? 0)
      snapshot.battery_soc_MWh = soc_MWh ? Array.from(soc_MWh) : batteries.map(b => b.initial_SOC * b.capacity_MWh)
    }
    return snapshot
  }

  solve_horizon(scenario: Scenario, batteries: PlacedBattery[] = []): DispatchSnapshot[] {
    const n_steps = scenario.inputs.load_MW[0]?.length ?? 0
    const dt_h = scenario.metadata.interval_min / 60
    const snapshots: DispatchSnapshot[] = []
    const soc = new Float64Array(batteries.length)
    for (let i = 0; i < batteries.length; i++) soc[i] = batteries[i].initial_SOC * batteries[i].capacity_MWh
    this._cached_peak_load_MW = this._compute_peak_load(scenario.inputs)
    this._cached_battery_schedule = this._plan_battery_schedule(scenario.inputs, batteries, dt_h)

    for (let t = 0; t < n_steps; t++) {
      const snap = this.solve_step(scenario.inputs, t, batteries, soc)
      snapshots.push(snap)
      this._advance_soc(soc, batteries, snap, dt_h)
      if (snap.battery_soc_MWh) snap.battery_soc_MWh = Array.from(soc)
    }
    this._cached_peak_load_MW = 0
    this._cached_battery_schedule = null
    if (this._verbosity >= 1) console.log(`solved horizon: ${n_steps} timesteps, ${batteries.length} batteries`)
    return snapshots
  }

  private _plan_battery_schedule(
    inputs: ScenarioInputs,
    batteries: PlacedBattery[],
    dt_h: number,
  ): { charge_MW: Float64Array; discharge_MW: Float64Array }[] | null {
    if (batteries.length === 0) return null
    const n_steps = inputs.load_MW[0]?.length ?? 0
    const peak = this._cached_peak_load_MW
    const load_pct = new Float64Array(n_steps)
    for (let t = 0; t < n_steps; t++) load_pct[t] = peak > 0 ? this._sum_zone(inputs.load_MW, t) / peak : 0

    let dis_weight_sum = 0
    let chg_weight_sum = 0
    const dis_weights = new Float64Array(n_steps)
    const chg_weights = new Float64Array(n_steps)
    for (let t = 0; t < n_steps; t++) {
      if (load_pct[t] > 0.80) {
        dis_weights[t] = Math.pow(load_pct[t] - 0.80, 1.5)
        dis_weight_sum += dis_weights[t]
      }
      if (load_pct[t] < 0.65) {
        chg_weights[t] = Math.pow(0.65 - load_pct[t], 1.2)
        chg_weight_sum += chg_weights[t]
      }
    }

    const schedules: { charge_MW: Float64Array; discharge_MW: Float64Array }[] = []
    for (const b of batteries) {
      const usable = (b.max_SOC - b.min_SOC) * b.capacity_MWh
      const eta = Math.sqrt(b.efficiency_round_trip)
      const start_E = b.initial_SOC * b.capacity_MWh
      const min_E = b.min_SOC * b.capacity_MWh
      const max_E = b.max_SOC * b.capacity_MWh
      const dischargeable_now = Math.max(0, start_E - min_E)
      const headroom_now = Math.max(0, max_E - start_E)
      const chargeable_total = chg_weight_sum > 0 ? Math.min(headroom_now + usable, usable * 1.0) : 0
      const dischargeable_total = dis_weight_sum > 0 ? Math.min(dischargeable_now + chargeable_total * eta * eta, usable) : 0

      const charge_MW = new Float64Array(n_steps)
      const discharge_MW = new Float64Array(n_steps)
      for (let t = 0; t < n_steps; t++) {
        if (dis_weight_sum > 0) {
          const energy_t = (dis_weights[t] / dis_weight_sum) * dischargeable_total
          discharge_MW[t] = Math.min(b.max_power_MW, energy_t / dt_h)
        }
        if (chg_weight_sum > 0) {
          const energy_t = (chg_weights[t] / chg_weight_sum) * chargeable_total
          charge_MW[t] = Math.min(b.max_power_MW, energy_t / dt_h)
        }
      }
      schedules.push({ charge_MW, discharge_MW })
    }
    return schedules
  }

  private _compute_peak_load(inputs: ScenarioInputs): number {
    const n_steps = inputs.load_MW[0]?.length ?? 0
    let peak = 0
    for (let t = 0; t < n_steps; t++) {
      const total = this._sum_zone(inputs.load_MW, t)
      if (total > peak) peak = total
    }
    return peak
  }

  private _merit_order_dispatch(
    inputs: ScenarioInputs,
    t: number,
    target_MW: number,
  ): MeritDispatchResult {
    const n = this._topo.n_buses
    const gen_per_bus = new Float64Array(n)
    const bus_load = new Float64Array(n)
    const bus_quota = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      bus_load[i] = this._zone(inputs.load_MW, t, i)
      bus_quota[i] = bus_load[i] + this._topo.bus_export_capacity_MW[i] * this._export_factor
    }

    const slots: DispatchSlot[] = []
    for (let i = 0; i < n; i++) {
      const wind_cf = this._zone(inputs.wind_capacity_factor, t, i)
      const solar_cf = this._zone(inputs.solar_capacity_factor, t, i)
      for (const g of this._topo.generators_at(i)) {
        const avail_factor = inputs.generator_availability ? this._zone(inputs.generator_availability, t, i) : 1
        let avail = g.capacity_MW * avail_factor
        if (g.fuel === 'wind') avail = g.capacity_MW * wind_cf
        else if (g.fuel === 'solar') avail = g.capacity_MW * solar_cf
        if (avail > 0) slots.push({ bus: i, available_MW: avail, cost: g.marginal_cost, dispatched_MW: 0 })
      }
    }
    slots.sort((a, b) => a.cost - b.cost)

    let remaining = Math.max(0, target_MW)
    let total_cost = 0
    let marginal = 0
    for (const s of slots) {
      if (remaining <= 0) break
      const headroom = bus_quota[s.bus] - gen_per_bus[s.bus]
      if (headroom <= 0) continue
      const take = Math.min(s.available_MW, remaining, headroom)
      if (take <= 0) continue
      gen_per_bus[s.bus] += take
      s.dispatched_MW = take
      total_cost += take * s.cost
      marginal = s.cost
      remaining -= take
    }
    const total_generation = target_MW - remaining
    return {
      gen_per_bus,
      slots,
      total_generation,
      total_cost,
      marginal_cost: marginal,
      unserved_MW: Math.max(0, remaining),
    }
  }

  private _redispatch_for_overloads(
    dispatch: MeritDispatchResult,
    bus_load: Float64Array,
    battery_net: Float64Array,
  ): void {
    const n = this._topo.n_buses
    const max_iters = 10
    for (let iter = 0; iter < max_iters; iter++) {
      const net_inj = new Float64Array(n)
      for (let i = 0; i < n; i++) net_inj[i] = dispatch.gen_per_bus[i] - bus_load[i] + battery_net[i]
      const theta = this._dc_power_flow(net_inj)
      const flows = this._line_flows(theta)
      let worst_l = -1
      let worst_overload = 0
      for (let l = 0; l < this._topo.n_lines; l++) {
        const limit = this._topo.line_limit_MW[l]
        if (limit <= 0) continue
        const o = Math.abs(flows[l]) - limit
        if (o > worst_overload) { worst_overload = o; worst_l = l }
      }
      if (worst_l < 0 || worst_overload < 0.01 * this._topo.line_limit_MW[worst_l]) break
      const flow = flows[worst_l]
      const from_bus = flow > 0 ? this._topo.line_from_index[worst_l] : this._topo.line_to_index[worst_l]
      const to_bus = flow > 0 ? this._topo.line_to_index[worst_l] : this._topo.line_from_index[worst_l]
      const target_swap = worst_overload * 0.65

      const reduced_MW = this._reduce_at_bus(dispatch, from_bus, target_swap)
      if (reduced_MW <= 0) break
      let added_MW = this._increase_at_bus(dispatch, to_bus, reduced_MW)
      if (added_MW < reduced_MW) {
        added_MW += this._increase_anywhere(dispatch, from_bus, reduced_MW - added_MW)
      }
      if (added_MW < reduced_MW * 0.9) break
    }
  }

  private _increase_anywhere(dispatch: MeritDispatchResult, exclude_bus: number, target: number): number {
    const candidates = dispatch.slots.filter(s => s.bus !== exclude_bus && s.dispatched_MW < s.available_MW)
    candidates.sort((a, b) => a.cost - b.cost)
    let added = 0
    for (const s of candidates) {
      if (added >= target) break
      const take = Math.min(s.available_MW - s.dispatched_MW, target - added)
      s.dispatched_MW += take
      dispatch.gen_per_bus[s.bus] += take
      dispatch.total_cost += take * s.cost
      added += take
    }
    return added
  }

  private _reduce_at_bus(dispatch: MeritDispatchResult, bus: number, target: number): number {
    const candidates = dispatch.slots.filter(s => s.bus === bus && s.dispatched_MW > 0)
    candidates.sort((a, b) => b.cost - a.cost)
    let removed = 0
    for (const s of candidates) {
      if (removed >= target) break
      const take = Math.min(s.dispatched_MW, target - removed)
      s.dispatched_MW -= take
      dispatch.gen_per_bus[bus] -= take
      dispatch.total_cost -= take * s.cost
      removed += take
    }
    return removed
  }

  private _increase_at_bus(dispatch: MeritDispatchResult, bus: number, target: number): number {
    const candidates = dispatch.slots.filter(s => s.bus === bus && s.dispatched_MW < s.available_MW)
    candidates.sort((a, b) => a.cost - b.cost)
    let added = 0
    for (const s of candidates) {
      if (added >= target) break
      const take = Math.min(s.available_MW - s.dispatched_MW, target - added)
      s.dispatched_MW += take
      dispatch.gen_per_bus[bus] += take
      dispatch.total_cost += take * s.cost
      added += take
    }
    return added
  }

  private _dc_power_flow(net_inj: Float64Array): Float64Array {
    const n = this._topo.n_buses
    const slack = this._topo.slack_index
    const theta = new Float64Array(n)
    if (n <= 1) return theta
    const reduced_n = n - 1

    const p_reduced = new Float64Array(reduced_n)
    for (let i = 0; i < n; i++) {
      if (i === slack) continue
      const ri = i < slack ? i : i - 1
      p_reduced[ri] = net_inj[i]
    }

    const theta_reduced = new Float64Array(reduced_n)
    for (let i = 0; i < reduced_n; i++) {
      let s = 0
      const row_offset = i * reduced_n
      for (let j = 0; j < reduced_n; j++) s += this._b_inv[row_offset + j] * p_reduced[j]
      theta_reduced[i] = s
    }

    for (let i = 0; i < n; i++) {
      if (i === slack) { theta[i] = 0; continue }
      const ri = i < slack ? i : i - 1
      theta[i] = theta_reduced[ri]
    }
    return theta
  }

  private _line_flows(theta: Float64Array): Float64Array {
    const n_lines = this._topo.n_lines
    const flows = new Float64Array(n_lines)
    for (let l = 0; l < n_lines; l++) {
      const i = this._topo.line_from_index[l]
      const j = this._topo.line_to_index[l]
      flows[l] = (theta[i] - theta[j]) / this._topo.line_reactance[l]
    }
    return flows
  }

  private _estimate_lmp(marginal_cost: number, line_flow: Float64Array): Float64Array {
    const n = this._topo.n_buses
    const lmp = new Float64Array(n)
    lmp.fill(marginal_cost)
    for (let l = 0; l < this._topo.n_lines; l++) {
      const limit = this._topo.line_limit_MW[l]
      const overload_pct = limit > 0 ? Math.abs(line_flow[l]) / limit : 0
      if (overload_pct <= 0.85) continue
      const adj = (overload_pct - 0.85) * marginal_cost * 2
      const i = this._topo.line_from_index[l]
      const j = this._topo.line_to_index[l]
      const sign = line_flow[l] > 0 ? 1 : -1
      lmp[j] += adj * sign
      lmp[i] -= adj * sign
    }
    return lmp
  }

  private _battery_targets_for_step(
    _inputs: ScenarioInputs,
    t: number,
    batteries: PlacedBattery[],
    soc_MWh: Float64Array | null,
  ): { bus: string; p_charge: number; p_discharge: number }[] {
    const targets: { bus: string; p_charge: number; p_discharge: number }[] = []
    const sched = this._cached_battery_schedule
    for (let bi = 0; bi < batteries.length; bi++) {
      const b = batteries[bi]
      const soc = soc_MWh ? soc_MWh[bi] : b.initial_SOC * b.capacity_MWh
      const min_E = b.min_SOC * b.capacity_MWh
      const max_E = b.max_SOC * b.capacity_MWh
      let p_charge = sched ? sched[bi].charge_MW[t] : 0
      let p_discharge = sched ? sched[bi].discharge_MW[t] : 0
      const max_dis = Math.max(0, (soc - min_E) / 0.25)
      const max_chg = Math.max(0, (max_E - soc) / 0.25)
      if (p_discharge > max_dis) p_discharge = max_dis
      if (p_charge > max_chg) p_charge = max_chg
      targets.push({ bus: b.bus, p_charge, p_discharge })
    }
    return targets
  }

  private _bus_available_capacity(inputs: ScenarioInputs, t: number, i: number): number {
    const wcf = this._zone(inputs.wind_capacity_factor, t, i)
    const scf = this._zone(inputs.solar_capacity_factor, t, i)
    const af = inputs.generator_availability ? this._zone(inputs.generator_availability, t, i) : 1
    let s = 0
    for (const g of this._topo.generators_at(i)) {
      if (g.fuel === 'wind') s += g.capacity_MW * wcf
      else if (g.fuel === 'solar') s += g.capacity_MW * scf
      else s += g.capacity_MW * af
    }
    return s
  }

  private _advance_soc(soc: Float64Array, batteries: PlacedBattery[], snap: DispatchSnapshot, dt_h: number) {
    const charge = snap.battery_p_charge_MW ?? []
    const discharge = snap.battery_p_discharge_MW ?? []
    for (let i = 0; i < batteries.length; i++) {
      const b = batteries[i]
      const eta = Math.sqrt(b.efficiency_round_trip)
      soc[i] += (charge[i] ?? 0) * dt_h * eta - (discharge[i] ?? 0) * dt_h / eta
      const min_E = b.min_SOC * b.capacity_MWh
      const max_E = b.max_SOC * b.capacity_MWh
      if (soc[i] < min_E) soc[i] = min_E
      if (soc[i] > max_E) soc[i] = max_E
    }
  }

  private _zone(arr: number[][], t: number, i: number): number {
    return arr[i]?.[t] ?? 0
  }

  private _sum_zone(arr: number[][], t: number): number {
    let s = 0
    for (let i = 0; i < arr.length; i++) s += arr[i][t] ?? 0
    return s
  }

  private _total_renewable(inputs: ScenarioInputs, t: number): number {
    let s = 0
    for (let i = 0; i < this._topo.n_buses; i++) {
      const wcf = this._zone(inputs.wind_capacity_factor, t, i)
      const scf = this._zone(inputs.solar_capacity_factor, t, i)
      for (const g of this._topo.generators_at(i)) {
        if (g.fuel === 'wind') s += g.capacity_MW * wcf
        else if (g.fuel === 'solar') s += g.capacity_MW * scf
      }
    }
    return s
  }

  private _total_available_capacity(inputs: ScenarioInputs, t: number): number {
    let s = 0
    for (let i = 0; i < this._topo.n_buses; i++) {
      const wcf = this._zone(inputs.wind_capacity_factor, t, i)
      const scf = this._zone(inputs.solar_capacity_factor, t, i)
      const af = inputs.generator_availability ? this._zone(inputs.generator_availability, t, i) : 1
      for (const g of this._topo.generators_at(i)) {
        if (g.fuel === 'wind') s += g.capacity_MW * wcf
        else if (g.fuel === 'solar') s += g.capacity_MW * scf
        else s += g.capacity_MW * af
      }
    }
    return s
  }

  private _invert_reduced_b(): Float64Array {
    const n = this._topo.n_buses
    const slack = this._topo.slack_index
    const r = n - 1
    if (r <= 0) return new Float64Array(0)
    const B = new Float64Array(r * r)
    for (let i = 0; i < n; i++) {
      if (i === slack) continue
      const ri = i < slack ? i : i - 1
      for (let j = 0; j < n; j++) {
        if (j === slack) continue
        const rj = j < slack ? j : j - 1
        B[ri * r + rj] = this._topo.b_matrix[i * n + j]
      }
    }
    return _gauss_jordan_invert(B, r)
  }

  private _build_ptdf(): Float64Array {
    return new Float64Array(0)
  }
}

function _gauss_jordan_invert(A: Float64Array, n: number): Float64Array {
  const aug = new Float64Array(n * 2 * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) aug[i * 2 * n + j] = A[i * n + j]
    aug[i * 2 * n + n + i] = 1
  }
  for (let col = 0; col < n; col++) {
    let pivot = col
    let pivot_val = Math.abs(aug[col * 2 * n + col])
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(aug[r * 2 * n + col])
      if (v > pivot_val) { pivot_val = v; pivot = r }
    }
    if (pivot_val < 1e-12) throw new Error(`reduced B matrix singular at column ${col}`)
    if (pivot !== col) {
      for (let j = 0; j < 2 * n; j++) {
        const tmp = aug[col * 2 * n + j]
        aug[col * 2 * n + j] = aug[pivot * 2 * n + j]
        aug[pivot * 2 * n + j] = tmp
      }
    }
    const inv_pivot = 1 / aug[col * 2 * n + col]
    for (let j = 0; j < 2 * n; j++) aug[col * 2 * n + j] *= inv_pivot
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = aug[r * 2 * n + col]
      if (factor === 0) continue
      for (let j = 0; j < 2 * n; j++) aug[r * 2 * n + j] -= factor * aug[col * 2 * n + j]
    }
  }
  const out = new Float64Array(n * n)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = aug[i * 2 * n + n + j]
  return out
}
