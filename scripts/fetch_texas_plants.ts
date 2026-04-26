/**
 * fetch_texas_plants.ts
 *
 * Pulls the HIFLD "Power Plants in the US" GeoJSON for Texas plants ≥ 50 MW
 * and writes a slimmed-down JSON to public/data/texas-grid/plants.json.
 *
 * Run: pnpm exec tsx scripts/fetch_texas_plants.ts
 */

import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

const SERVICE_URL = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/Power_Plants_in_the_US/FeatureServer/0/query'
const OUT_PATH = resolve(process.cwd(), 'public/data/texas-grid/plants.json')

const FIELDS = [
  'Plant_Code', 'Plant_Name', 'Utility_Na', 'PrimSource', 'tech_desc',
  'Install_MW', 'Total_MW',
  'Coal_MW', 'NG_MW', 'Wind_MW', 'Solar_MW', 'Nuclear_MW', 'Hydro_MW', 'Bat_MW', 'Other_MW',
  'Latitude', 'Longitude',
  'Period',
]

interface Feature {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] } | null
  properties: Record<string, string | number | null>
}

async function fetch_page(offset: number, page: number): Promise<{ features: Feature[]; exceededTransferLimit?: boolean }> {
  const params = new URLSearchParams({
    where: "State='Texas' AND Total_MW>=50",
    outFields: FIELDS.join(','),
    outSR: '4326',
    f: 'geojson',
    resultOffset: String(offset),
    resultRecordCount: String(page),
    orderByFields: 'Plant_Code',
  })
  const url = `${SERVICE_URL}?${params}`
  const r = await fetch(url, { headers: { 'User-Agent': 'personal-site-texas-grid/1.0' } })
  if (!r.ok) throw new Error(`HIFLD ${r.status}: ${url}`)
  return r.json()
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
  period?: number
}

function clean_plant(props: Record<string, string | number | null>, geom: [number, number]): PlantOut | null {
  const code = props.Plant_Code
  if (code == null) return null
  const total = Number(props.Total_MW ?? 0)
  if (!isFinite(total) || total <= 0) return null
  const [lon, lat] = geom
  if (!isFinite(lon) || !isFinite(lat)) return null

  const num = (k: string): number | undefined => {
    const v = props[k]
    if (v == null) return undefined
    const n = Number(v)
    return isFinite(n) && n > 0 ? n : undefined
  }
  const per_fuel: PlantOut['per_fuel_MW'] = {}
  const c = num('Coal_MW');    if (c)  per_fuel.coal = c
  const g = num('NG_MW');      if (g)  per_fuel.gas = g
  const w = num('Wind_MW');    if (w)  per_fuel.wind = w
  const s = num('Solar_MW');   if (s)  per_fuel.solar = s
  const n = num('Nuclear_MW'); if (n)  per_fuel.nuclear = n
  const h = num('Hydro_MW');   if (h)  per_fuel.hydro = h
  const b = num('Bat_MW');     if (b)  per_fuel.battery = b
  const o = num('Other_MW');   if (o)  per_fuel.other = o

  return {
    id: String(code),
    name: String(props.Plant_Name ?? `Plant ${code}`),
    utility: props.Utility_Na ? String(props.Utility_Na) : undefined,
    fuel: String(props.PrimSource ?? 'unknown').toLowerCase(),
    tech: props.tech_desc ? String(props.tech_desc) : undefined,
    capacity_MW: total,
    per_fuel_MW: per_fuel,
    lat, lon,
    period: props.Period ? Number(props.Period) : undefined,
  }
}

async function main() {
  const PAGE = 1000
  const out: PlantOut[] = []
  for (let offset = 0, page_num = 0; ; page_num++) {
    console.log(`page ${page_num + 1}: fetching offset=${offset}`)
    const json = await fetch_page(offset, PAGE)
    const features = json.features ?? []
    let kept = 0
    for (const f of features) {
      if (!f.geometry || f.geometry.type !== 'Point') continue
      const p = clean_plant(f.properties, f.geometry.coordinates)
      if (p) { out.push(p); kept++ }
    }
    console.log(`  got ${features.length} features, kept ${kept} (running total ${out.length})`)
    if (features.length < PAGE) break
    offset += PAGE
    if (page_num >= 5) break
  }

  out.sort((a, b) => b.capacity_MW - a.capacity_MW)

  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify({
    source: 'HIFLD Power Plants in the US (ArcGIS FeatureServer)',
    fetched_iso: new Date().toISOString(),
    filter: "State='Texas' AND Total_MW>=50",
    n_plants: out.length,
    plants: out,
  }, null, 1))
  const stat = require('fs').statSync(OUT_PATH)
  console.log(`wrote ${OUT_PATH}  (${(stat.size / 1024).toFixed(1)} KB, ${out.length} plants)`)

  const fuels: Record<string, number> = {}
  let total_MW = 0
  for (const p of out) {
    fuels[p.fuel] = (fuels[p.fuel] ?? 0) + p.capacity_MW
    total_MW += p.capacity_MW
  }
  console.log(`total nameplate: ${(total_MW/1000).toFixed(1)} GW`)
  for (const [fuel, mw] of Object.entries(fuels).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${fuel.padEnd(20)} ${(mw/1000).toFixed(2).padStart(8)} GW`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
