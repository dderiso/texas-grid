/**
 * MetricsAccumulator
 * Reduces a sequence of DispatchSnapshots into a MetricsRow + a side-by-side ComparisonMetrics.
 *
 * Process flow:
 *   1. accumulate(snapshots, dt_h)            — fold over snapshots → MetricsRow
 *   2. compare(baseline, with_batteries, dt_h) — both rows + signed deltas
 *   3. cumulative_cost_series(snapshots)       — for the time-series chart
 *
 * @example
 * const m = new MetricsAccumulator().compare(baseline, with_batteries, 0.25)
 */

import type { DispatchSnapshot, MetricsRow, ComparisonMetrics } from './types'

export class MetricsAccumulator {
  accumulate(snapshots: DispatchSnapshot[], dt_h: number): MetricsRow {
    let total_cost = 0
    let congestion = 0
    let peak_load = 0
    let reserve_min = Infinity
    let overload_minutes = 0
    let throughput = 0
    for (const snap of snapshots) {
      total_cost += snap.total_dispatch_cost * dt_h
      congestion += snap.congestion_MWh
      const c = snap.battery_p_charge_MW ?? []
      const d = snap.battery_p_discharge_MW ?? []
      let net_charge = 0
      for (let i = 0; i < Math.max(c.length, d.length); i++) {
        net_charge += (c[i] ?? 0) - (d[i] ?? 0)
        throughput += ((c[i] ?? 0) + (d[i] ?? 0)) * dt_h
      }
      const net_load = snap.total_load_MW + net_charge
      if (net_load > peak_load) peak_load = net_load
      const effective_reserve = snap.reserve_margin_MW + Math.max(0, -net_charge)
      if (effective_reserve < reserve_min) reserve_min = effective_reserve
      let any_overload = false
      for (let i = 0; i < snap.line_loading_pct.length; i++) {
        if (snap.line_loading_pct[i] > 1) { any_overload = true; break }
      }
      if (any_overload) overload_minutes += dt_h * 60
    }
    if (!Number.isFinite(reserve_min)) reserve_min = 0
    return {
      total_cost,
      congestion_MWh: congestion,
      peak_load_MW: peak_load,
      reserve_margin_min_MW: reserve_min,
      line_overload_minutes: overload_minutes,
      battery_throughput_MWh: throughput,
    }
  }

  compare(baseline: DispatchSnapshot[], with_batteries: DispatchSnapshot[], dt_h: number): ComparisonMetrics {
    const a = this.accumulate(baseline, dt_h)
    const b = with_batteries.length === 0 ? a : this.accumulate(with_batteries, dt_h)
    return {
      baseline: a,
      with_batteries: b,
      delta_pct: {
        cost: this._pct(a.total_cost, b.total_cost),
        congestion: this._pct(a.congestion_MWh, b.congestion_MWh),
        peak: this._pct(a.peak_load_MW, b.peak_load_MW),
        reserve: this._pct(a.reserve_margin_min_MW, b.reserve_margin_min_MW),
        overload: this._pct(a.line_overload_minutes, b.line_overload_minutes),
      },
    }
  }

  cumulative_cost_series(snapshots: DispatchSnapshot[], dt_h: number): { t: number[]; values: number[] } {
    const n = snapshots.length
    const t = new Array<number>(n)
    const values = new Array<number>(n)
    let acc = 0
    for (let i = 0; i < n; i++) {
      acc += snapshots[i].total_dispatch_cost * dt_h
      t[i] = i * dt_h
      values[i] = acc
    }
    return { t, values }
  }

  private _pct(baseline: number, candidate: number): number {
    if (baseline === 0) return candidate === 0 ? 0 : 1
    return (candidate - baseline) / baseline
  }
}
