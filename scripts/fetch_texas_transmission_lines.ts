/**
 * fetch_texas_transmission_lines.ts
 *
 * Pull real Texas transmission-line geometry from the HIFLD (Homeland
 * Infrastructure Foundation-Level Data) Electric Power Transmission Lines
 * feature service (ArcGIS REST). The schema has no STATE field, so we filter
 * spatially via an envelope query against the Texas bounding box, then
 * tighten with a per-vertex bbox check after fetch. Pagination at the
 * server-imposed 2000-row cap. Each polyline is Douglas-Peucker-simplified
 * at ≈0.005° tolerance and written to
 * public/data/texas-grid/transmission_lines.json.
 *
 * Output shape:
 *   { source, fetched_iso, n_lines, lines: [{ id, voltage_kv, type, owner?, coords: [[lon,lat], …] }] }
 *
 * Run: pnpm exec tsx scripts/fetch_texas_transmission_lines.ts
 */

import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'

const ENDPOINT = 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/ArcGIS/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0/query'
const OUT_PATH = resolve(process.cwd(), 'public/data/texas-grid/transmission_lines.json')
const PAGE = 2000
const SIMPLIFY_TOL_DEG = 0.005

interface ArcFeature {
  attributes: Record<string, unknown>
  geometry?: { paths?: number[][][] }
}

interface ArcPage {
  features: ArcFeature[]
  exceededTransferLimit?: boolean
}

interface OutLine {
  id: string
  voltage_kv: number
  type: string
  owner?: string
  coords: [number, number][]
}

const TX_ENVELOPE = JSON.stringify({
  xmin: -107.0, ymin: 25.5, xmax: -93.0, ymax: 37.0,
  spatialReference: { wkid: 4326 },
})

async function fetch_page(offset: number): Promise<ArcPage> {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: TX_ENVELOPE,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID,ID,VOLTAGE,VOLT_CLASS,TYPE,OWNER,STATUS,SUB_1,SUB_2',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    orderByFields: 'OBJECTID',
  })
  const url = `${ENDPOINT}?${params}`
  const r = await fetch(url, { headers: { 'User-Agent': 'personal_site/fetch_texas_transmission_lines' } })
  if (!r.ok) throw new Error(`HIFLD ${r.status} ${r.statusText} at offset ${offset}`)
  const json = (await r.json()) as ArcPage & { error?: { message?: string } }
  if (json.error) throw new Error(`HIFLD error: ${json.error.message ?? JSON.stringify(json.error)}`)
  if (!json.features) throw new Error(`HIFLD response missing features at offset ${offset}: ${JSON.stringify(json).slice(0, 200)}`)
  return json
}

function dp_simplify(coords: [number, number][], tol: number): [number, number][] {
  if (coords.length < 3) return coords
  const sq_tol = tol * tol
  const keep = new Uint8Array(coords.length)
  keep[0] = 1
  keep[coords.length - 1] = 1
  const stack: [number, number][] = [[0, coords.length - 1]]
  while (stack.length > 0) {
    const [i, j] = stack.pop()!
    if (j - i < 2) continue
    const [x1, y1] = coords[i]
    const [x2, y2] = coords[j]
    const dx = x2 - x1
    const dy = y2 - y1
    const len2 = dx * dx + dy * dy
    let max_d2 = 0
    let max_k = -1
    for (let k = i + 1; k < j; k++) {
      const [px, py] = coords[k]
      let d2: number
      if (len2 === 0) {
        const ex = px - x1
        const ey = py - y1
        d2 = ex * ex + ey * ey
      } else {
        const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
        const ex = x1 + t * dx - px
        const ey = y1 + t * dy - py
        d2 = ex * ex + ey * ey
      }
      if (d2 > max_d2) { max_d2 = d2; max_k = k }
    }
    if (max_d2 > sq_tol && max_k > 0) {
      keep[max_k] = 1
      stack.push([i, max_k])
      stack.push([max_k, j])
    }
  }
  const out: [number, number][] = []
  for (let k = 0; k < coords.length; k++) if (keep[k]) out.push(coords[k])
  return out
}

function parse_voltage(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return -1
  return Math.round(n)
}

function in_texas_bbox([lon, lat]: [number, number]): boolean {
  return lon >= -107 && lon <= -93 && lat >= 25.5 && lat <= 37
}

async function main() {
  console.log(`fetching HIFLD transmission lines for STATE LIKE '%TX%'`)
  const lines: OutLine[] = []
  let offset = 0
  let raw_segments = 0
  let raw_points = 0
  let kept_points = 0
  while (true) {
    const page = await fetch_page(offset)
    const n = page.features.length
    if (n === 0) break
    for (const f of page.features) {
      const paths = f.geometry?.paths
      if (!paths || paths.length === 0) continue
      const id = String(f.attributes.OBJECTID ?? f.attributes.ID ?? `${offset}-${lines.length}`)
      const voltage_kv = parse_voltage(f.attributes.VOLTAGE)
      const type = String(f.attributes.TYPE ?? 'AC').trim() || 'AC'
      const owner = f.attributes.OWNER ? String(f.attributes.OWNER).trim() : undefined
      for (let pi = 0; pi < paths.length; pi++) {
        const path = paths[pi]
        raw_segments++
        raw_points += path.length
        const filtered: [number, number][] = []
        for (const [lon, lat] of path) {
          if (typeof lon === 'number' && typeof lat === 'number' && in_texas_bbox([lon, lat])) {
            filtered.push([Number(lon.toFixed(4)), Number(lat.toFixed(4))])
          }
        }
        if (filtered.length < 2) continue
        const simp = dp_simplify(filtered, SIMPLIFY_TOL_DEG)
        if (simp.length < 2) continue
        kept_points += simp.length
        lines.push({
          id: paths.length === 1 ? id : `${id}.${pi}`,
          voltage_kv,
          type,
          owner,
          coords: simp,
        })
      }
    }
    console.log(`  offset=${offset} fetched=${n} cumulative_lines=${lines.length}`)
    offset += n
    if (!page.exceededTransferLimit && n < PAGE) break
  }
  console.log(`raw segments: ${raw_segments}  raw pts: ${raw_points}  kept pts: ${kept_points}`)

  const histogram: Record<string, number> = {}
  for (const l of lines) {
    const k = l.voltage_kv < 0 ? 'unknown' : l.voltage_kv < 115 ? '<115' : l.voltage_kv < 230 ? '115-230' : l.voltage_kv < 345 ? '230-345' : l.voltage_kv < 500 ? '345-500' : '500+'
    histogram[k] = (histogram[k] ?? 0) + 1
  }
  console.log('voltage histogram:', histogram)

  mkdirSync(dirname(OUT_PATH), { recursive: true })
  const out = {
    source: 'HIFLD Electric Power Transmission Lines (https://hifld-geoplatform.opendata.arcgis.com/)',
    fetched_iso: new Date().toISOString(),
    n_lines: lines.length,
    lines,
  }
  writeFileSync(OUT_PATH, JSON.stringify(out))
  const stat = require('fs').statSync(OUT_PATH)
  console.log(`wrote ${OUT_PATH}  (${(stat.size / (1024 * 1024)).toFixed(2)} MB, ${lines.length} polylines, ${kept_points} pts)`)
}

main().catch(e => { console.error(e); process.exit(1) })
