/**
 * ERCOTTopology
 * Loads the Texas grid topology and computes index maps + the DC power-flow B matrix.
 *
 * Process flow:
 *   1. load(json)         — parse + validate
 *   2. index_buses()      — bus_id → row index
 *   3. index_lines()      — incidence + reactance vector
 *   4. build_b_matrix()   — DC susceptance matrix (full n×n; slack row/col handled in dispatch)
 *
 * The B matrix is built dense for the small (~20-bus) system. Inverting B with the slack
 * row/col removed once at scenario load is cheap; per-timestep we only multiply.
 *
 * @example
 * const topo = new ERCOTTopology({ verbosity: 1 }).load(json).index_buses().index_lines().build_b_matrix()
 */

import type { Topology, Bus, Line, Generator, CandidateBatterySite } from './types'

export class ERCOTTopology {
  buses: Bus[] = []
  lines: Line[] = []
  generators: Generator[] = []
  candidate_battery_sites: CandidateBatterySite[] = []

  bus_id_to_index: Map<string, number> = new Map()
  generators_by_bus: Map<number, Generator[]> = new Map()
  candidates_by_bus: Map<number, CandidateBatterySite[]> = new Map()

  n_buses = 0
  n_lines = 0
  slack_index = 0

  line_from_index: Int32Array = new Int32Array(0)
  line_to_index: Int32Array = new Int32Array(0)
  line_reactance: Float64Array = new Float64Array(0)
  line_limit_MW: Float64Array = new Float64Array(0)

  bus_export_capacity_MW: Float64Array = new Float64Array(0)
  b_matrix: Float64Array = new Float64Array(0)

  private _verbosity: number

  constructor(opts: { verbosity?: number } = {}) {
    this._verbosity = opts.verbosity ?? 0
  }

  load(topology: Topology): this {
    this.buses = topology.buses
    this.lines = topology.lines
    this.generators = topology.generators
    this.candidate_battery_sites = topology.candidate_battery_sites
    this.n_buses = this.buses.length
    this.n_lines = this.lines.length
    if (this._verbosity >= 1) {
      console.log(`topology loaded: ${this.n_buses} buses, ${this.n_lines} lines, ${this.generators.length} generators, ${this.candidate_battery_sites.length} battery sites`)
    }
    return this
  }

  index_buses(): this {
    this.bus_id_to_index.clear()
    for (let i = 0; i < this.buses.length; i++) {
      this.bus_id_to_index.set(this.buses[i].id, i)
    }
    this.generators_by_bus.clear()
    for (const g of this.generators) {
      const i = this._require_bus(g.bus)
      const list = this.generators_by_bus.get(i) ?? []
      list.push(g)
      this.generators_by_bus.set(i, list)
    }
    this.candidates_by_bus.clear()
    for (const c of this.candidate_battery_sites) {
      const i = this._require_bus(c.bus)
      const list = this.candidates_by_bus.get(i) ?? []
      list.push(c)
      this.candidates_by_bus.set(i, list)
    }
    let max_load_capacity = -Infinity
    let slack = 0
    for (let i = 0; i < this.n_buses; i++) {
      const cap = (this.generators_by_bus.get(i) ?? []).reduce((s, g) => s + g.capacity_MW, 0)
      if (cap > max_load_capacity) {
        max_load_capacity = cap
        slack = i
      }
    }
    this.slack_index = slack
    return this
  }

  index_lines(): this {
    const n = this.n_lines
    this.line_from_index = new Int32Array(n)
    this.line_to_index = new Int32Array(n)
    this.line_reactance = new Float64Array(n)
    this.line_limit_MW = new Float64Array(n)
    this.bus_export_capacity_MW = new Float64Array(this.n_buses)
    for (let l = 0; l < n; l++) {
      const line = this.lines[l]
      const i = this._require_bus(line.from)
      const j = this._require_bus(line.to)
      this.line_from_index[l] = i
      this.line_to_index[l] = j
      this.line_reactance[l] = line.reactance
      this.line_limit_MW[l] = line.limit_MW
      this.bus_export_capacity_MW[i] += line.limit_MW
      this.bus_export_capacity_MW[j] += line.limit_MW
    }
    return this
  }

  build_b_matrix(): this {
    const n = this.n_buses
    this.b_matrix = new Float64Array(n * n)
    for (let l = 0; l < this.n_lines; l++) {
      const i = this.line_from_index[l]
      const j = this.line_to_index[l]
      const b = 1 / this.line_reactance[l]
      this.b_matrix[i * n + i] += b
      this.b_matrix[j * n + j] += b
      this.b_matrix[i * n + j] -= b
      this.b_matrix[j * n + i] -= b
    }
    return this
  }

  bus_index(id: string): number {
    return this._require_bus(id)
  }

  generators_at(bus_index: number): Generator[] {
    return this.generators_by_bus.get(bus_index) ?? []
  }

  candidates_at(bus_index: number): CandidateBatterySite[] {
    return this.candidates_by_bus.get(bus_index) ?? []
  }

  private _require_bus(id: string): number {
    const i = this.bus_id_to_index.get(id)
    if (i === undefined) throw new Error(`unknown bus id: ${id}`)
    return i
  }
}

export async function fetch_topology(url = '/data/texas-grid/topology.json'): Promise<Topology> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`failed to fetch topology: ${r.status}`)
  return r.json() as Promise<Topology>
}
