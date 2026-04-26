/**
 * texas_rebuild_topology_from_plants.ts
 *
 * Rebuild topology.json's `generators` and `candidate_battery_sites` from real
 * HIFLD plant data. Each plant is assigned to the nearest of the 20 ERCOT-aligned
 * topology buses (Voronoi by bus centroid). Per-zone-per-fuel capacity sums become
 * the new generator entries; real BESS plants become candidate battery sites.
 *
 * The buses, lines, and topology shape are preserved.
 *
 * Run: pnpm exec tsx scripts/texas_rebuild_topology_from_plants.ts
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(process.cwd())
const TOPO_PATH    = resolve(ROOT, 'public/data/texas-grid/topology.json')
const PLANTS_PATH  = resolve(ROOT, 'public/data/texas-grid/plants.json')
const BACKUP_PATH  = resolve(ROOT, 'public/data/texas-grid/topology.handauthored.json')

interface Bus { id: string; name: string; lat: number; lon: number; zone: string; kind: string }
interface Line { id: string; from: string; to: string; limit_MW: number; reactance: number }
interface Generator { id: string; bus: string; fuel: string; capacity_MW: number; marginal_cost: number; name?: string }
interface CandidateBatterySite { id: string; bus: string; max_capacity_MWh: number; cost_per_kWh: number; name?: string; tech?: string }

interface Topology {
  buses: Bus[]
  lines: Line[]
  generators: Generator[]
  candidate_battery_sites: CandidateBatterySite[]
}

interface PlantOut {
  id: string
  name: string
  utility?: string
  fuel: string
  tech?: string
  capacity_MW: number
  per_fuel_MW: { coal?: number; gas?: number; wind?: number; solar?: number; nuclear?: number; hydro?: number; battery?: number; other?: number }
  lat: number
  lon: number
}

interface PlantsFile {
  source: string
  fetched_iso: string
  n_plants: number
  plants: PlantOut[]
}

function map_fuel(p: PlantOut): { fuel: string; cost: number; capacity: number } {
  const tech = (p.tech ?? '').toLowerCase()
  const primary = (p.fuel ?? '').toLowerCase()
  if (primary === 'natural gas') {
    const peaker = tech.includes('combustion turbine') || tech.includes('internal combustion')
    return { fuel: 'gas', cost: peaker ? 78 : 38, capacity: p.per_fuel_MW.gas ?? p.capacity_MW }
  }
  if (primary === 'coal')          return { fuel: 'coal',    cost: 28,  capacity: p.per_fuel_MW.coal ?? p.capacity_MW }
  if (primary === 'nuclear')       return { fuel: 'nuclear', cost: 8,   capacity: p.per_fuel_MW.nuclear ?? p.capacity_MW }
  if (primary === 'wind')          return { fuel: 'wind',    cost: 0,   capacity: p.per_fuel_MW.wind ?? p.capacity_MW }
  if (primary === 'solar')         return { fuel: 'solar',   cost: 0,   capacity: p.per_fuel_MW.solar ?? p.capacity_MW }
  if (primary === 'hydroelectric') return { fuel: 'hydro',   cost: 5,   capacity: p.per_fuel_MW.hydro ?? p.capacity_MW }
  if (primary === 'petroleum')     return { fuel: 'gas',     cost: 110, capacity: p.capacity_MW }
  if (primary === 'biomass' || primary === 'other' || primary === 'geothermal') {
    return { fuel: 'gas', cost: 60, capacity: p.capacity_MW }
  }
  return { fuel: 'gas', cost: 60, capacity: p.capacity_MW }
}

function nearest_bus(lat: number, lon: number, buses: Bus[]): number {
  let best = 0, best_d = Infinity
  const cos_lat = Math.cos((lat * Math.PI) / 180)
  for (let i = 0; i < buses.length; i++) {
    const dlat = lat - buses[i].lat
    const dlon = (lon - buses[i].lon) * cos_lat
    const d = dlat * dlat + dlon * dlon
    if (d < best_d) { best_d = d; best = i }
  }
  return best
}

function main() {
  const topology = JSON.parse(readFileSync(TOPO_PATH, 'utf-8')) as Topology
  const { plants } = JSON.parse(readFileSync(PLANTS_PATH, 'utf-8')) as PlantsFile

  if (!existsSync(BACKUP_PATH)) {
    copyFileSync(TOPO_PATH, BACKUP_PATH)
    console.log(`backed up hand-authored topology → ${BACKUP_PATH}`)
  }

  type ZoneFuelKey = `${number}|${string}|${number}`
  const agg = new Map<ZoneFuelKey, { bus: string; fuel: string; cost: number; capacity_MW: number; n_plants: number }>()
  const battery_plants: { p: PlantOut; bus: string; capacity_MW: number }[] = []

  for (const plant of plants) {
    const bi = nearest_bus(plant.lat, plant.lon, topology.buses)
    const bus = topology.buses[bi]
    const m = map_fuel(plant)
    const key: ZoneFuelKey = `${bi}|${m.fuel}|${m.cost}`
    const e = agg.get(key)
    if (e) { e.capacity_MW += m.capacity; e.n_plants += 1 }
    else agg.set(key, { bus: bus.id, fuel: m.fuel, cost: m.cost, capacity_MW: m.capacity, n_plants: 1 })

    const bat_MW = plant.per_fuel_MW.battery
    if (bat_MW && bat_MW >= 50) {
      battery_plants.push({ p: plant, bus: bus.id, capacity_MW: bat_MW })
    }
  }

  const generators: Generator[] = []
  let counter: Record<string, number> = {}
  for (const e of agg.values()) {
    if (e.capacity_MW < 5) continue
    const k = `${e.bus}-${e.fuel}-${e.cost}`
    counter[k] = (counter[k] ?? 0) + 1
    generators.push({
      id: `${e.bus}-${e.fuel}-${e.cost}`,
      bus: e.bus,
      fuel: e.fuel,
      capacity_MW: Math.round(e.capacity_MW),
      marginal_cost: e.cost,
      name: `${e.n_plants} plant${e.n_plants > 1 ? 's' : ''}`,
    })
  }
  generators.sort((a, b) => a.bus.localeCompare(b.bus) || a.marginal_cost - b.marginal_cost)

  battery_plants.sort((a, b) => b.capacity_MW - a.capacity_MW)
  const top_bess = battery_plants.slice(0, 12)
  const candidate_battery_sites: CandidateBatterySite[] = top_bess.map(({ p, bus, capacity_MW }) => ({
    id: `BESS-${p.id}`,
    bus,
    max_capacity_MWh: Math.round(capacity_MW * 4),
    cost_per_kWh: 250,
    name: p.name,
    tech: p.tech,
  }))

  const new_topology: Topology = {
    buses: topology.buses,
    lines: topology.lines,
    generators,
    candidate_battery_sites: candidate_battery_sites.length >= 6 ? candidate_battery_sites : topology.candidate_battery_sites,
  }

  writeFileSync(TOPO_PATH, JSON.stringify(new_topology, null, 2))

  let total_GW = 0
  const by_fuel: Record<string, number> = {}
  for (const g of generators) {
    total_GW += g.capacity_MW / 1000
    by_fuel[g.fuel] = (by_fuel[g.fuel] ?? 0) + g.capacity_MW / 1000
  }
  console.log(`\nrebuild summary:`)
  console.log(`  ${plants.length} HIFLD plants → ${generators.length} zone-fuel-cost generator entries`)
  console.log(`  total capacity: ${total_GW.toFixed(1)} GW`)
  for (const [fuel, gw] of Object.entries(by_fuel).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${fuel.padEnd(10)} ${gw.toFixed(2).padStart(7)} GW`)
  }
  console.log(`\nreal BESS sites: ${battery_plants.length} ≥50 MW, used top ${top_bess.length} as candidates`)
  for (const c of candidate_battery_sites) {
    console.log(`  ${c.id.padEnd(20)} bus=${c.bus.padEnd(15)} ${c.max_capacity_MWh} MWh  ${c.name}`)
  }
  console.log(`\nwrote ${TOPO_PATH}  ${(require('fs').statSync(TOPO_PATH).size/1024).toFixed(1)} KB`)
}

main()
