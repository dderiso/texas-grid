'use client'

/**
 * TexasGridMap
 * Texas-coarsened ERCOT topology rendered through the shared MapChart system.
 * Layers (toggleable): supply (gen halos + real plant markers), demand (load halos),
 * infrastructure (transmission lines), weather (T2m heatmap interpolated to a fine
 * grid and clipped to the Texas outline).
 *
 * Process flow:
 *   1. MapChart provides projection (cosine-corrected) + Texas state outline + counties
 *   2. children render-prop draws four custom layers in z-order:
 *        weather heatmap → real plants → transmission lines → load/gen halos → bus dots → batteries
 *   3. Hover on a bus dot opens a small stats tooltip
 */

import { useMemo, useState } from 'react'
import { MapChart } from '@/lib/charts/MapChart'
import { colormap_f32 } from '@/lib/charts/theme'
import { TX_STATE_OUTLINE } from '@/lib/charts/texas-geo-raw'
import type {
  DispatchSnapshot,
  PlacedBattery,
  Topology,
  LayerKind,
  ScenarioInputs,
  BalanceHorizon,
} from '@/lib/power-grid'

const HEATMAP_ROWS = 56
const HEATMAP_COLS = 80
const HEATMAP_T_MIN_C = 18
const HEATMAP_T_MAX_C = 44
const TX_BOUNDS = { lon: [-106.7, -93.5] as [number, number], lat: [25.8, 36.6] as [number, number] }

export interface PlantMarker {
  id: string
  bus: string
  name: string
  fuel: string
  capacity_MW: number
  lat: number
  lon: number
}

export interface TransmissionLine {
  id: string
  voltage_kv: number
  type: string
  owner?: string
  coords: [number, number][]
}

/* HIFLD voltage-class palette: faint sub-transmission → bright bulk transmission. */
function voltage_color(kv: number): string {
  if (kv < 0)   return 'rgba(120,130,150,0.30)'
  if (kv < 230) return 'rgba(120,140,170,0.45)'
  if (kv < 345) return 'rgba(56,189,248,0.65)'
  if (kv < 500) return 'rgba(168,85,247,0.80)'
  return 'rgba(220,38,38,0.90)'
}

function voltage_width(kv: number): number {
  if (kv < 0)   return 0.4
  if (kv < 230) return 0.5
  if (kv < 345) return 0.8
  if (kv < 500) return 1.1
  return 1.4
}

interface TexasGridMapProps {
  topology: Topology
  baseline_snap: DispatchSnapshot | null
  with_battery_snap: DispatchSnapshot | null
  baseline_series?: DispatchSnapshot[]
  with_battery_series?: DispatchSnapshot[]
  inputs: ScenarioInputs | null
  t: number
  active_layers: Set<LayerKind>
  show_with_battery: boolean
  placed_batteries: PlacedBattery[]
  plants?: PlantMarker[]
  transmission_lines?: TransmissionLine[]
  balance_horizon?: BalanceHorizon
  height?: number
  className?: string
}

const ZONE_COLORS: Record<string, string> = {
  Coast: '#0ea5e9',
  North: '#a855f7',
  'South Central': '#f59e0b',
  South: '#22c55e',
  'Far West': '#f97316',
  Central: '#ec4899',
  East: '#8b5cf6',
  West: '#06b6d4',
}

const FUEL_COLORS: Record<string, string> = {
  gas:     '#f97316',
  coal:    '#71717a',
  nuclear: '#a855f7',
  wind:    '#22c55e',
  solar:   '#fbbf24',
  hydro:   '#0ea5e9',
  storage: '#10b981',
  other:   '#94a3b8',
}

function lmp_color(lmp: number, marginal_default = 40): string {
  const t = Math.max(0, Math.min(1, (lmp - marginal_default) / 80))
  const r = Math.round(80 + 175 * t)
  const g = Math.round(180 - 130 * t)
  const b = Math.round(220 - 200 * t)
  return `rgb(${r},${g},${b})`
}

function loading_color(load: number): string {
  if (load < 0.6) return '#10b981'
  if (load < 0.85) return '#f59e0b'
  if (load < 1.0) return '#ef4444'
  return '#dc2626'
}

function fuel_color(fuel: string): string {
  return FUEL_COLORS[fuel.toLowerCase()] ?? FUEL_COLORS.other
}

function _interpolate_field(
  zone_values: number[],
  zone_lon_lat: [number, number][],
  rows: number,
  cols: number,
  bounds: { lon: [number, number]; lat: [number, number] },
  power = 2.5,
): Float32Array {
  const out = new Float32Array(rows * cols)
  const lon_min = bounds.lon[0], lon_max = bounds.lon[1]
  const lat_min = bounds.lat[0], lat_max = bounds.lat[1]
  for (let r = 0; r < rows; r++) {
    const lat = lat_max - (r + 0.5) * (lat_max - lat_min) / rows
    const cos_lat = Math.cos((lat * Math.PI) / 180)
    for (let c = 0; c < cols; c++) {
      const lon = lon_min + (c + 0.5) * (lon_max - lon_min) / cols
      let w_sum = 0, v_sum = 0
      for (let i = 0; i < zone_lon_lat.length; i++) {
        const [zlon, zlat] = zone_lon_lat[i]
        const dlat = lat - zlat
        const dlon = (lon - zlon) * cos_lat
        const d2 = dlat * dlat + dlon * dlon + 1e-6
        const w = 1 / Math.pow(d2, power / 2)
        w_sum += w
        v_sum += w * zone_values[i]
      }
      out[r * cols + c] = v_sum / w_sum
    }
  }
  return out
}

function _heatmap_image_url(
  values: Float32Array,
  rows: number,
  cols: number,
  v_min: number,
  v_max: number,
  cmap: 'heat' | 'viridis' | 'cool' | 'blue' | 'signal' | 'red_green' | 'diverging' = 'heat',
  alpha = 220,
  alpha_floor = 0,
  diverging_center: number | null = null,
): string | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(cols, rows)
  const span = Math.max(1e-9, v_max - v_min)
  const is_diverging = diverging_center !== null
  for (let i = 0; i < rows * cols; i++) {
    const t = Math.max(0, Math.min(1, (values[i] - v_min) / span))
    const [r, g, b] = colormap_f32(t, cmap)
    img.data[i * 4 + 0] = Math.round(r * 255)
    img.data[i * 4 + 1] = Math.round(g * 255)
    img.data[i * 4 + 2] = Math.round(b * 255)
    let strength: number
    if (is_diverging) {
      const half = (v_max - v_min) / 2
      strength = half > 0 ? Math.min(1, Math.abs(values[i] - diverging_center!) / half) : 0
    } else {
      strength = Math.sqrt(t)
    }
    img.data[i * 4 + 3] = Math.round(alpha_floor + (alpha - alpha_floor) * strength)
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL()
}

function _polygon_path(coords: [number, number][], project: (lon: number, lat: number) => [number, number]): string {
  if (coords.length === 0) return ''
  const pts = coords.map(([lon, lat]) => project(lon, lat))
  return 'M ' + pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L ') + ' Z'
}

export function TexasGridMap(props: TexasGridMapProps) {
  const {
    topology,
    baseline_snap,
    with_battery_snap,
    baseline_series = [],
    with_battery_series = [],
    inputs,
    t,
    active_layers,
    show_with_battery,
    placed_batteries,
    plants = [],
    transmission_lines = [],
    balance_horizon = 'instant',
    height = 480,
    className = '',
  } = props
  const [hover_bus, setHoverBus] = useState<string | null>(null)
  const [hover_plant, setHoverPlant] = useState<string | null>(null)

  const bus_index = useMemo(() => new Map(topology.buses.map((b, i) => [b.id, i])), [topology.buses])

  const bus_load = useMemo(() => {
    if (!inputs) return new Float64Array(topology.buses.length)
    const arr = new Float64Array(topology.buses.length)
    for (let i = 0; i < topology.buses.length; i++) arr[i] = inputs.load_MW[i]?.[t] ?? 0
    return arr
  }, [inputs, t, topology.buses.length])

  const active_snap = show_with_battery && with_battery_snap ? with_battery_snap : baseline_snap

  const zone_lon_lat = useMemo(
    () => topology.buses.map(b => [b.lon, b.lat] as [number, number]),
    [topology.buses],
  )

  const supply_max_per_zone = useMemo(() => {
    const n = topology.buses.length
    const max = new Float64Array(n)
    if (!inputs) return max
    for (let i = 0; i < n; i++) {
      const wcf_row = inputs.wind_capacity_factor[i] ?? []
      const scf_row = inputs.solar_capacity_factor[i] ?? []
      let zone_max_cap_at_peak_cf = 0
      for (const g of topology.generators) {
        if (g.bus !== topology.buses[i].id) continue
        if (g.fuel === 'wind') zone_max_cap_at_peak_cf += g.capacity_MW * Math.max(0.5, ...wcf_row)
        else if (g.fuel === 'solar') zone_max_cap_at_peak_cf += g.capacity_MW * Math.max(0.5, ...scf_row)
        else zone_max_cap_at_peak_cf += g.capacity_MW
      }
      max[i] = zone_max_cap_at_peak_cf
    }
    return max
  }, [inputs, topology])

  const demand_max_per_zone = useMemo(() => {
    const n = topology.buses.length
    const max = new Float64Array(n)
    if (!inputs) return max
    for (let i = 0; i < n; i++) {
      const row = inputs.load_MW[i] ?? []
      let m = 0
      for (let j = 0; j < row.length; j++) if (row[j] > m) m = row[j]
      max[i] = m
    }
    return max
  }, [inputs, topology.buses.length])

  const supply_domain_MW = useMemo(() => {
    let m = 0
    for (let i = 0; i < supply_max_per_zone.length; i++) if (supply_max_per_zone[i] > m) m = supply_max_per_zone[i]
    return Math.max(1000, Math.ceil(m / 1000) * 1000)
  }, [supply_max_per_zone])

  const demand_domain_MW = useMemo(() => {
    let m = 0
    for (let i = 0; i < demand_max_per_zone.length; i++) if (demand_max_per_zone[i] > m) m = demand_max_per_zone[i]
    return Math.max(1000, Math.ceil(m / 1000) * 1000)
  }, [demand_max_per_zone])

  const active_series = show_with_battery && with_battery_series.length > 0 ? with_battery_series : baseline_series

  const balance_avg_MW_per_zone = useMemo(() => {
    const n = topology.buses.length
    const out = new Float64Array(n)
    if (!inputs || active_series.length === 0) return out
    for (let i = 0; i < n; i++) {
      let s = 0
      for (const snap of active_series) {
        const gen = snap.generation_MW[i] ?? 0
        const load = inputs.load_MW[i]?.[snap.t] ?? 0
        s += gen - load
      }
      out[i] = s / active_series.length
    }
    return out
  }, [active_series, inputs, topology.buses.length])

  const balance_horizon_hours = balance_horizon === 'day' ? 24 : balance_horizon === 'month' ? 24 * 30 : balance_horizon === 'year' ? 24 * 365 : 0

  const balance_domain_MW_or_MWh = useMemo(() => {
    if (balance_horizon === 'instant') {
      const n = topology.buses.length
      let m = 0
      const baseline_arr = baseline_snap ? [baseline_snap] : []
      const wb_arr = with_battery_snap ? [with_battery_snap] : []
      for (const snap of [...baseline_arr, ...wb_arr]) {
        for (let i = 0; i < n; i++) {
          const v = Math.abs((snap.generation_MW[i] ?? 0) - (inputs?.load_MW[i]?.[snap.t] ?? 0))
          if (v > m) m = v
        }
      }
      for (let i = 0; i < n; i++) {
        if (demand_max_per_zone[i] * 0.7 > m) m = demand_max_per_zone[i] * 0.7
      }
      return Math.max(2000, Math.ceil(m / 500) * 500)
    }
    let m = 0
    for (let i = 0; i < balance_avg_MW_per_zone.length; i++) {
      const v = Math.abs(balance_avg_MW_per_zone[i]) * balance_horizon_hours
      if (v > m) m = v
    }
    return Math.max(1, m)
  }, [balance_horizon, balance_horizon_hours, balance_avg_MW_per_zone, baseline_snap, with_battery_snap, inputs, topology.buses.length, demand_max_per_zone])

  const n_field_layers = (active_layers.has('weather') ? 1 : 0)
    + (active_layers.has('supply') ? 1 : 0)
    + (active_layers.has('demand') ? 1 : 0)
    + (active_layers.has('balance') ? 1 : 0)
  const layer_alpha = n_field_layers <= 1 ? 220 : (n_field_layers === 2 ? 150 : 110)

  const weather_url = useMemo(() => {
    if (!active_layers.has('weather') || !inputs?.weather_T2m_C) return null
    const zone_values = topology.buses.map((_b, i) => inputs.weather_T2m_C![i]?.[t] ?? 0)
    const grid = _interpolate_field(zone_values, zone_lon_lat, HEATMAP_ROWS, HEATMAP_COLS, TX_BOUNDS)
    return _heatmap_image_url(grid, HEATMAP_ROWS, HEATMAP_COLS, HEATMAP_T_MIN_C, HEATMAP_T_MAX_C, 'heat', layer_alpha, layer_alpha * 0.15)
  }, [topology.buses, inputs, t, active_layers, zone_lon_lat, layer_alpha])

  const supply_url = useMemo(() => {
    if (!active_layers.has('supply') || !active_snap) return null
    const zone_values = topology.buses.map((_b, i) => active_snap.generation_MW[i] ?? 0)
    const grid = _interpolate_field(zone_values, zone_lon_lat, HEATMAP_ROWS, HEATMAP_COLS, TX_BOUNDS, 3)
    return _heatmap_image_url(grid, HEATMAP_ROWS, HEATMAP_COLS, 0, supply_domain_MW, 'cool', layer_alpha, 0)
  }, [topology.buses, active_snap, active_layers, zone_lon_lat, supply_domain_MW, layer_alpha])

  const demand_url = useMemo(() => {
    if (!active_layers.has('demand') || !inputs) return null
    const zone_values = topology.buses.map((_b, i) => inputs.load_MW[i]?.[t] ?? 0)
    const grid = _interpolate_field(zone_values, zone_lon_lat, HEATMAP_ROWS, HEATMAP_COLS, TX_BOUNDS, 3)
    return _heatmap_image_url(grid, HEATMAP_ROWS, HEATMAP_COLS, 0, demand_domain_MW, 'viridis', layer_alpha, 0)
  }, [topology.buses, inputs, t, active_layers, zone_lon_lat, demand_domain_MW, layer_alpha])

  const balance_url = useMemo(() => {
    if (!active_layers.has('balance') || !inputs) return null
    let zone_values: number[]
    if (balance_horizon === 'instant') {
      if (!active_snap) return null
      zone_values = topology.buses.map((_b, i) => (active_snap.generation_MW[i] ?? 0) - (inputs.load_MW[i]?.[t] ?? 0))
    } else {
      zone_values = topology.buses.map((_b, i) => balance_avg_MW_per_zone[i] * balance_horizon_hours)
    }
    const grid = _interpolate_field(zone_values, zone_lon_lat, HEATMAP_ROWS, HEATMAP_COLS, TX_BOUNDS, 3)
    return _heatmap_image_url(
      grid, HEATMAP_ROWS, HEATMAP_COLS,
      -balance_domain_MW_or_MWh, balance_domain_MW_or_MWh,
      'red_green', layer_alpha, 0, 0,
    )
  }, [topology.buses, active_snap, inputs, t, active_layers, zone_lon_lat, balance_domain_MW_or_MWh, layer_alpha, balance_horizon, balance_horizon_hours, balance_avg_MW_per_zone])

  return (
    <div className={`relative w-full bg-white dark:bg-[#141414] rounded-lg border border-gray-200 dark:border-[#333] overflow-hidden ${className}`} style={{ height }}>
      <MapChart
        city="tx"
        height={height}
        feature_opacity={0.18}
        coastline_color="rgba(160,170,200,0.65)"
        coastline_width={1.4}
        margins={{ left: 8, right: 8, top: 8, bottom: 8 }}
      >
        {(layout) => {
          const project = (lon: number, lat: number): [number, number] => [layout.lon_scale(lon), layout.lat_scale(lat)]
          const tx_clip_d = _polygon_path(TX_STATE_OUTLINE, project)
          const heatmap_box = (() => {
            const [x0, y0] = project(TX_BOUNDS.lon[0], TX_BOUNDS.lat[1])
            const [x1, y1] = project(TX_BOUNDS.lon[1], TX_BOUNDS.lat[0])
            return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
          })()

          const lines_rendered = active_snap ? topology.lines.map((line, i) => {
            const flow = active_snap.line_flow_MW[i] ?? 0
            const loading = active_snap.line_loading_pct[i] ?? 0
            const a = bus_index.get(line.from)
            const b = bus_index.get(line.to)
            if (a === undefined || b === undefined) return null
            const [x1, y1] = project(topology.buses[a].lon, topology.buses[a].lat)
            const [x2, y2] = project(topology.buses[b].lon, topology.buses[b].lat)
            return { id: line.id, x1, y1, x2, y2, loading, flow }
          }).filter(Boolean) as { id: string; x1: number; y1: number; x2: number; y2: number; loading: number; flow: number }[] : []

          const buses_rendered = topology.buses.map((bus, i) => {
            const [x, y] = project(bus.lon, bus.lat)
            const lmp = active_snap?.lmp_dollar_per_MWh[i] ?? 0
            const gen = active_snap?.generation_MW[i] ?? 0
            const load = bus_load[i]
            return { bus, x, y, lmp, gen, load }
          })

          const batteries_rendered = placed_batteries.map((b, idx) => {
            const i = bus_index.get(b.bus)
            if (i === undefined) return null
            const bus = topology.buses[i]
            const [x, y] = project(bus.lon, bus.lat)
            const soc_E = active_snap?.battery_soc_MWh?.[idx] ?? b.initial_SOC * b.capacity_MWh
            const soc_pct = Math.max(0, Math.min(1, soc_E / b.capacity_MWh))
            return { battery: b, x, y, soc_pct }
          }).filter(Boolean) as { battery: PlacedBattery; x: number; y: number; soc_pct: number }[]

          const plants_rendered = active_layers.has('plants') && plants.length > 0
            ? plants.map(p => {
                const [x, y] = project(p.lon, p.lat)
                const r = Math.max(1.4, Math.min(6, Math.sqrt(p.capacity_MW) * 0.22))
                return { plant: p, x, y, r }
              })
            : []

          return (
            <g>
              <defs>
                <clipPath id="tx-clip-heatmap">
                  <path d={tx_clip_d} />
                </clipPath>
              </defs>

              <g clipPath="url(#tx-clip-heatmap)">
                {weather_url && (
                  <image href={weather_url}
                    x={heatmap_box.x} y={heatmap_box.y}
                    width={heatmap_box.w} height={heatmap_box.h}
                    preserveAspectRatio="none"
                    style={{ imageRendering: 'pixelated' }}
                  />
                )}
                {supply_url && (
                  <image href={supply_url}
                    x={heatmap_box.x} y={heatmap_box.y}
                    width={heatmap_box.w} height={heatmap_box.h}
                    preserveAspectRatio="none"
                    style={{ imageRendering: 'pixelated' }}
                  />
                )}
                {demand_url && (
                  <image href={demand_url}
                    x={heatmap_box.x} y={heatmap_box.y}
                    width={heatmap_box.w} height={heatmap_box.h}
                    preserveAspectRatio="none"
                    style={{ imageRendering: 'pixelated' }}
                  />
                )}
                {balance_url && (
                  <image href={balance_url}
                    x={heatmap_box.x} y={heatmap_box.y}
                    width={heatmap_box.w} height={heatmap_box.h}
                    preserveAspectRatio="none"
                    style={{ imageRendering: 'pixelated' }}
                  />
                )}
              </g>

              {plants_rendered.map(({ plant, x, y, r }) => (
                <circle key={`p-${plant.id}`}
                  cx={x} cy={y} r={r}
                  fill={fuel_color(plant.fuel)}
                  fillOpacity={0.7}
                  stroke="rgba(15,23,42,0.4)"
                  strokeWidth={0.4}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoverPlant(plant.id)}
                  onMouseLeave={() => setHoverPlant(null)}
                />
              ))}

              {active_layers.has('infrastructure') && transmission_lines.length > 0 && (
                <g>
                  {transmission_lines.map(line => {
                    const pts = line.coords.map(([lon, lat]) => project(lon, lat))
                    const d = 'M ' + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ')
                    return (
                      <path key={line.id} d={d}
                        fill="none"
                        stroke={voltage_color(line.voltage_kv)}
                        strokeWidth={voltage_width(line.voltage_kv)}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )
                  })}
                </g>
              )}

              {active_layers.has('infrastructure') && transmission_lines.length === 0 && lines_rendered.map(({ id, x1, y1, x2, y2, loading }) => {
                const c = loading_color(loading)
                const w = 1.0 + Math.min(4, loading * 3)
                return (
                  <line key={id} x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={c} strokeWidth={w} opacity={loading > 1 ? 0.95 : 0.75}
                    strokeLinecap="round" strokeDasharray={loading > 1 ? '4,3' : undefined}
                  />
                )
              })}

              {active_layers.has('plants') && buses_rendered.map(({ bus, x, y, lmp }) => (
                <g key={bus.id}
                  onMouseEnter={() => setHoverBus(bus.id)}
                  onMouseLeave={() => setHoverBus(null)}
                  style={{ cursor: 'pointer' }}
                >
                  <circle cx={x} cy={y} r={4} fill={lmp_color(lmp)} stroke="rgba(15,23,42,0.6)" strokeWidth={0.8} />
                </g>
              ))}

              {batteries_rendered.map(({ battery, x, y, soc_pct }) => {
                const r_outer = 11
                const r_inner = 7
                const angle = -Math.PI / 2 + 2 * Math.PI * soc_pct
                const arc_x = x + r_outer * Math.cos(angle)
                const arc_y = y + r_outer * Math.sin(angle)
                const large_arc = soc_pct > 0.5 ? 1 : 0
                const arc_path = `M ${x} ${y - r_outer} A ${r_outer} ${r_outer} 0 ${large_arc} 1 ${arc_x.toFixed(1)} ${arc_y.toFixed(1)}`
                return (
                  <g key={battery.id}>
                    <circle cx={x} cy={y} r={r_outer} fill="rgba(34,197,94,0.10)" stroke="rgba(34,197,94,0.5)" strokeWidth={1} />
                    <path d={arc_path} fill="none" stroke="#22c55e" strokeWidth={2.2} strokeLinecap="round" />
                    <circle cx={x} cy={y} r={r_inner} fill="#0f172a" stroke="#22c55e" strokeWidth={1.4} />
                    <text x={x} y={y + 3} textAnchor="middle" style={{ fontSize: '8px', fill: '#22c55e', fontWeight: 700, pointerEvents: 'none' }}>B</text>
                  </g>
                )
              })}

              {hover_bus && (() => {
                const bi = buses_rendered.find(b => b.bus.id === hover_bus)
                if (!bi) return null
                const left_side = bi.x > layout.inner_width * 0.55
                return (
                  <foreignObject x={left_side ? bi.x - 200 : bi.x + 14} y={bi.y - 32} width={185} height={92} style={{ pointerEvents: 'none' }}>
                    <div className="text-[10px] leading-tight px-2 py-1.5 rounded bg-white/95 dark:bg-[#0f172a]/95 border border-gray-300 dark:border-[#333] shadow text-gray-800 dark:text-gray-200">
                      <div className="font-bold text-[11px]" style={{ color: ZONE_COLORS[bi.bus.zone] ?? '#888' }}>{bi.bus.name}</div>
                      <div className="text-gray-500 text-[9px] mb-0.5">{bi.bus.zone} · {bi.bus.kind}</div>
                      <div>load <span className="font-mono">{bi.load.toFixed(0)}</span> MW</div>
                      <div>gen  <span className="font-mono">{bi.gen.toFixed(0)}</span> MW</div>
                      <div>LMP  <span className="font-mono">${bi.lmp.toFixed(0)}</span>/MWh</div>
                    </div>
                  </foreignObject>
                )
              })()}

              {hover_plant && (() => {
                const ph = plants_rendered.find(p => p.plant.id === hover_plant)
                if (!ph) return null
                const left_side = ph.x > layout.inner_width * 0.55
                return (
                  <foreignObject x={left_side ? ph.x - 220 : ph.x + 12} y={ph.y - 28} width={210} height={60} style={{ pointerEvents: 'none' }}>
                    <div className="text-[10px] leading-tight px-2 py-1.5 rounded bg-white/95 dark:bg-[#0f172a]/95 border border-gray-300 dark:border-[#333] shadow text-gray-800 dark:text-gray-200">
                      <div className="font-bold text-[11px] truncate" style={{ color: fuel_color(ph.plant.fuel) }}>{ph.plant.name}</div>
                      <div className="font-mono">{ph.plant.capacity_MW.toFixed(0)} MW · <span className="capitalize">{ph.plant.fuel}</span></div>
                    </div>
                  </foreignObject>
                )
              })()}
            </g>
          )
        }}
      </MapChart>

      <div className="absolute bottom-1 right-2 flex flex-col gap-1 text-[9px] text-gray-500 dark:text-gray-400 font-mono pointer-events-none select-none">
        {active_layers.has('weather') && (
          <div className="flex gap-1.5 items-center">
            <span className="w-12 text-right">T2m</span>
            <span>{HEATMAP_T_MIN_C}°C</span>
            <span className="inline-block h-2 w-16 rounded" style={{ background: 'linear-gradient(to right, rgb(255,255,240), rgb(254,240,170), rgb(253,200,100), rgb(249,115,22), rgb(220,50,32))' }}/>
            <span>{HEATMAP_T_MAX_C}°C</span>
          </div>
        )}
        {active_layers.has('supply') && (
          <div className="flex gap-1.5 items-center">
            <span className="w-12 text-right">supply</span>
            <span>0</span>
            <span className="inline-block h-2 w-16 rounded" style={{ background: 'linear-gradient(to right, rgb(15,23,42), rgb(54,116,167), rgb(67,178,195), rgb(143,226,176), rgb(220,253,200))' }}/>
            <span>{(supply_domain_MW/1000).toFixed(0)} GW</span>
          </div>
        )}
        {active_layers.has('demand') && (
          <div className="flex gap-1.5 items-center">
            <span className="w-12 text-right">demand</span>
            <span>0</span>
            <span className="inline-block h-2 w-16 rounded" style={{ background: 'linear-gradient(to right, rgb(68,1,84), rgb(72,40,120), rgb(38,130,142), rgb(122,209,81), rgb(253,231,37))' }}/>
            <span>{(demand_domain_MW/1000).toFixed(0)} GW</span>
          </div>
        )}
        {active_layers.has('balance') && (() => {
          const is_instant = balance_horizon === 'instant'
          const fmt = (v: number) => {
            if (is_instant) return `${(v/1000).toFixed(0)} GW`
            const abs = Math.abs(v)
            if (abs >= 1e6) return `${(v/1e6).toFixed(1)} TWh`
            if (abs >= 1e3) return `${(v/1e3).toFixed(1)} GWh`
            return `${v.toFixed(0)} MWh`
          }
          const lbl = is_instant ? 'balance' : `bal·${balance_horizon}`
          return (
            <div className="flex gap-1.5 items-center">
              <span className="w-12 text-right">{lbl}</span>
              <span>−{fmt(balance_domain_MW_or_MWh).replace(/^-/, '')}</span>
              <span className="inline-block h-2 w-16 rounded" style={{ background: 'linear-gradient(to right, rgb(220,38,38), rgb(248,113,113), rgb(245,245,245), rgb(134,239,172), rgb(22,163,74))' }}/>
              <span>+{fmt(balance_domain_MW_or_MWh)}</span>
            </div>
          )
        })()}
        {active_layers.has('infrastructure') && transmission_lines.length > 0 && (
          <div className="flex gap-1.5 items-center">
            <span className="w-12 text-right">kV</span>
            <span className="inline-block w-3 h-[2px]" style={{ background: 'rgb(120,140,170)' }}/>
            <span>&lt;230</span>
            <span className="inline-block w-3 h-[2px]" style={{ background: 'rgb(56,189,248)' }}/>
            <span>230-345</span>
            <span className="inline-block w-3 h-[2px]" style={{ background: 'rgb(168,85,247)' }}/>
            <span>345-500</span>
            <span className="inline-block w-3 h-[2px]" style={{ background: 'rgb(220,38,38)' }}/>
            <span>500+</span>
          </div>
        )}
        {active_layers.has('infrastructure') && transmission_lines.length === 0 && (
          <div className="flex gap-1.5 items-center">
            <span className="w-12 text-right">line load</span>
            <span className="w-2 h-2 rounded" style={{ background: '#10b981' }}/>
            <span>&lt;60%</span>
            <span className="w-2 h-2 rounded" style={{ background: '#f59e0b' }}/>
            <span>&lt;85%</span>
            <span className="w-2 h-2 rounded" style={{ background: '#ef4444' }}/>
            <span>≤100%</span>
            <span className="w-2 h-2 rounded" style={{ background: '#dc2626' }}/>
            <span>over</span>
          </div>
        )}
      </div>

      <div className="absolute bottom-1 left-2 text-[8px] text-gray-400 dark:text-gray-500 pointer-events-none select-none">
        plants &amp; transmission: HIFLD 2025 · weather: NOAA HRRR · grid: Census us-atlas
      </div>
    </div>
  )
}

export default TexasGridMap
