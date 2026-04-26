/**
 * fetch_ercot_load.ts
 *
 * Pull real ERCOT hourly load by weather zone from gridstatus.io for a
 * scenario window, write per-zone JSON to public/data/texas-grid/scenarios/.
 *
 * Auth: GRIDSTATUS_API_KEY in .env (already present at line 79).
 * Dataset: ercot_load_by_weather_zone (hourly, 8 zones + system_total).
 *
 * Run:
 *   pnpm exec tsx scripts/fetch_ercot_load.ts --start 2023-08-21T00:00 --end 2023-08-28T00:00 --label aug-2023-heat-dome
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { config as dotenv } from 'dotenv'

dotenv({ path: resolve(process.cwd(), '.env') })

const API_BASE = 'https://api.gridstatus.io/v1'
const DATASET = 'ercot_load_by_weather_zone'

interface Args {
  start: string
  end: string
  label: string
  out_dir: string
}

function parse_args(): Args {
  const a = process.argv.slice(2)
  const get = (k: string, d?: string) => {
    const i = a.indexOf(k)
    return i >= 0 ? a[i + 1] : d
  }
  return {
    start: get('--start', '2023-08-21T00:00')!,
    end:   get('--end',   '2023-08-28T00:00')!,
    label: get('--label', 'aug-2023-heat-dome')!,
    out_dir: get('--out-dir', resolve(process.cwd(), 'public/data/texas-grid/scenarios'))!,
  }
}

interface LoadRow {
  interval_start_utc: string
  interval_end_utc: string
  coast: number
  east: number
  far_west: number
  north: number
  north_central: number
  south_central: number
  southern: number
  west: number
  system_total: number
}

async function fetch_window(api_key: string, start: string, end: string): Promise<LoadRow[]> {
  const params = new URLSearchParams({ start_time: `${start}:00Z`, end_time: `${end}:00Z`, limit: '10000' })
  const url = `${API_BASE}/datasets/${DATASET}/query?${params}`
  console.log(`fetching ${url}`)
  const r = await fetch(url, { headers: { 'x-api-key': api_key } })
  if (!r.ok) throw new Error(`gridstatus ${r.status}: ${await r.text()}`)
  const j = await r.json() as { status_code: number; data: LoadRow[] }
  return j.data
}

async function main() {
  const args = parse_args()
  const api_key = process.env.GRIDSTATUS_API_KEY
  if (!api_key) throw new Error('GRIDSTATUS_API_KEY not in .env')

  const rows = await fetch_window(api_key, args.start, args.end)
  console.log(`got ${rows.length} hourly rows`)

  const out_path = resolve(args.out_dir, `ercot-load-${args.label}.json`)
  mkdirSync(dirname(out_path), { recursive: true })
  const out = {
    source: 'gridstatus.io ercot_load_by_weather_zone',
    fetched_iso: new Date().toISOString(),
    label: args.label,
    start_iso: rows[0]?.interval_start_utc,
    end_iso: rows[rows.length - 1]?.interval_end_utc,
    n_hours: rows.length,
    interval_min: 60,
    zones: ['coast', 'east', 'far_west', 'north', 'north_central', 'south_central', 'southern', 'west'],
    time_iso: rows.map(r => r.interval_start_utc),
    load_MW: {
      coast:         rows.map(r => r.coast),
      east:          rows.map(r => r.east),
      far_west:      rows.map(r => r.far_west),
      north:         rows.map(r => r.north),
      north_central: rows.map(r => r.north_central),
      south_central: rows.map(r => r.south_central),
      southern:      rows.map(r => r.southern),
      west:          rows.map(r => r.west),
    },
    system_total: rows.map(r => r.system_total),
  }
  writeFileSync(out_path, JSON.stringify(out))
  const stat = require('fs').statSync(out_path)
  console.log(`wrote ${out_path}  (${(stat.size / 1024).toFixed(1)} KB)`)
  const peak = Math.max(...out.system_total)
  const peak_idx = out.system_total.indexOf(peak)
  console.log(`peak ERCOT system load: ${peak.toFixed(0)} MW at ${out.time_iso[peak_idx]}`)
  for (const z of out.zones) {
    const arr = out.load_MW[z as keyof typeof out.load_MW]
    console.log(`  ${z.padEnd(15)} avg=${(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(0).padStart(6)} MW   peak=${Math.max(...arr).toFixed(0).padStart(6)} MW`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
