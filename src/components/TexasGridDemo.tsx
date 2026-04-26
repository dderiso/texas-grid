'use client'

/**
 * TexasGridDemo
 * Top-level interactive simulation: Texas-coarsened ERCOT grid + 24-h dispatch playback +
 * battery-placement greedy solver + side-by-side baseline-vs-with-batteries comparison.
 *
 * Process flow:
 *   1. Mount → fetch topology + initial scenario; build ScenarioPlayer
 *   2. User picks a scenario via the scenario tab strip
 *   3. User toggles map layers (supply, demand, infrastructure, weather)
 *   4. User clicks Place batteries → BatteryPlacementSolver.greedy() → ScenarioPlayer.compute_with_batteries()
 *   5. User scrubs time / plays the comparison
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import {
  ERCOTTopology,
  ScenarioPlayer,
  PLAYER_STATE,
  BatteryPlacementSolver,
  fetch_topology,
  type Topology,
  type Scenario,
  type DispatchSnapshot,
  type PlacedBattery,
  type LayerKind,
  type BalanceHorizon,
} from '@/lib/power-grid'
import { TexasGridMap, type PlantMarker, type TransmissionLine } from './TexasGridMap'
import { TexasGridMetricsPanel } from './TexasGridMetricsPanel'

interface PlantsFile {
  source: string
  fetched_iso: string
  n_plants: number
  plants: { id: string; name: string; fuel: string; capacity_MW: number; lat: number; lon: number; tech?: string; per_fuel_MW?: Record<string, number> }[]
}

interface TransmissionLinesFile {
  source: string
  fetched_iso: string
  n_lines: number
  lines: TransmissionLine[]
}

const SCENARIOS: { id: string; label: string; source: 'synthetic' | 'real' }[] = [
  { id: 'baseline',            label: 'Synthetic baseline',     source: 'synthetic' },
  { id: 'aug-2023-heat-dome',  label: 'Aug 2023 heat dome',    source: 'real' },
]

const LAYER_LABELS: { id: LayerKind; label: string; tone: string }[] = [
  { id: 'supply',         label: 'Supply',         tone: 'sky' },
  { id: 'demand',         label: 'Demand',         tone: 'pink' },
  { id: 'balance',        label: 'Balance',        tone: 'red' },
  { id: 'infrastructure', label: 'Infrastructure', tone: 'amber' },
  { id: 'weather',        label: 'Weather',        tone: 'rose' },
  { id: 'plants',         label: 'Stations',       tone: 'emerald' },
]

const STEP_MS_OPTIONS = [
  { ms: 200, label: '0.5×' },
  { ms: 110, label: '1×' },
  { ms: 60,  label: '2×' },
  { ms: 30,  label: '4×' },
]

function format_t(t_h: number): string {
  if (t_h < 24) {
    const hh = String(Math.floor(t_h)).padStart(2, '0')
    const mm = String(Math.round((t_h % 1) * 60)).padStart(2, '0')
    return `${t_h.toFixed(2)}h (${hh}:${mm})`
  }
  const days = Math.floor(t_h / 24)
  const rem_h = t_h - days * 24
  const hh = String(Math.floor(rem_h)).padStart(2, '0')
  const mm = String(Math.round((rem_h % 1) * 60)).padStart(2, '0')
  return `d${days+1} ${hh}:${mm} (${t_h.toFixed(0)}h)`
}

function resolve_start_iso(meta: { start_iso?: string; description?: string } | undefined): string | undefined {
  if (!meta) return undefined
  if (meta.start_iso) return meta.start_iso
  const m = meta.description?.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/)
  return m ? m[1] : undefined
}

function format_clock(start_iso: string | undefined, t_hours: number): { date: string; time: string } | null {
  if (!start_iso) return null
  const start_ms = Date.parse(start_iso)
  if (!Number.isFinite(start_ms)) return null
  const cur = new Date(start_ms + t_hours * 3600 * 1000)
  const yyyy = cur.getUTCFullYear()
  const mm = String(cur.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(cur.getUTCDate()).padStart(2, '0')
  const hh = String(cur.getUTCHours()).padStart(2, '0')
  const mi = String(cur.getUTCMinutes()).padStart(2, '0')
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}Z` }
}

interface TexasGridDemoProps {
  className?: string
}

export function TexasGridDemo({ className = '' }: TexasGridDemoProps) {
  const [mounted, setMounted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scenario_id, setScenarioId] = useState<string>(SCENARIOS[1].id)
  const [data_source, setDataSource] = useState<'synthetic' | 'real'>('real')
  const [topology, setTopology] = useState<Topology | null>(null)
  const [plants, setPlants] = useState<PlantMarker[]>([])
  const [transmission_lines, setTransmissionLines] = useState<TransmissionLine[]>([])
  const [scenario, setScenario] = useState<Scenario | null>(null)
  const [baseline, setBaseline] = useState<DispatchSnapshot[]>([])
  const [with_battery, setWithBattery] = useState<DispatchSnapshot[]>([])
  const [placed_batteries, setPlacedBatteries] = useState<PlacedBattery[]>([])
  const [active_layers, setActiveLayers] = useState<Set<LayerKind>>(new Set(['supply', 'demand', 'infrastructure', 'plants']))
  const [balance_horizon, setBalanceHorizon] = useState<BalanceHorizon>('instant')
  const [show_with_battery, setShowWithBattery] = useState(false)
  const [t, setT] = useState(0)
  const [is_playing, setIsPlaying] = useState(false)
  const [step_ms, setStepMs] = useState(STEP_MS_OPTIONS[1].ms)
  const [solver_status, setSolverStatus] = useState<string>('')
  const [budget_M, setBudgetM] = useState(900)

  const player_ref = useRef<ScenarioPlayer | null>(null)
  const topo_ref = useRef<ERCOTTopology | null>(null)

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    if (!mounted) return
    let cancelled = false
    Promise.all([
      fetch_topology(),
      fetch('/data/texas-grid/plants.json').then(r => r.ok ? r.json() as Promise<PlantsFile> : null).catch(() => null),
      fetch('/data/texas-grid/transmission_lines.json').then(r => r.ok ? r.json() as Promise<TransmissionLinesFile> : null).catch(() => null),
    ]).then(([t, pfile, tfile]) => {
        if (cancelled) return
        setTopology(t)
        const topo = new ERCOTTopology({ verbosity: 0 }).load(t).index_buses().index_lines().build_b_matrix()
        topo_ref.current = topo
        const player = new ScenarioPlayer({ topology: topo, step_ms })
        player_ref.current = player
        if (pfile?.plants) {
          const bus_ids = topo.buses.map(b => b.id)
          const cos_at = (lat: number) => Math.cos((lat * Math.PI) / 180)
          const nearest = (lat: number, lon: number) => {
            let best = 0, best_d = Infinity
            const cl = cos_at(lat)
            for (let i = 0; i < topo.buses.length; i++) {
              const dlat = lat - topo.buses[i].lat
              const dlon = (lon - topo.buses[i].lon) * cl
              const d = dlat * dlat + dlon * dlon
              if (d < best_d) { best_d = d; best = i }
            }
            return bus_ids[best]
          }
          setPlants(pfile.plants.map(p => ({
            id: p.id,
            bus: nearest(p.lat, p.lon),
            name: p.name,
            fuel: p.fuel === 'natural gas' ? 'gas' : (p.fuel === 'hydroelectric' ? 'hydro' : (p.fuel === 'batteries' ? 'storage' : p.fuel)),
            capacity_MW: p.capacity_MW,
            lat: p.lat,
            lon: p.lon,
          })))
        }
        if (tfile?.lines) setTransmissionLines(tfile.lines)
      })
      .catch(e => setError(`failed to load topology: ${e.message}`))
    return () => { cancelled = true }
  }, [mounted])

  useEffect(() => {
    const player = player_ref.current
    if (!player || !topology) return
    let cancelled = false
    setT(0)
    setWithBattery([])
    setPlacedBatteries([])
    setShowWithBattery(false)
    player.load(scenario_id)
      .then(() => {
        if (cancelled) return
        if (player.scenario) {
          setScenario(player.scenario)
          setBaseline(player.baseline)
        }
      })
      .catch(e => setError(`failed to load scenario ${scenario_id}: ${e.message}`))
    return () => { cancelled = true }
  }, [scenario_id, topology])

  useEffect(() => {
    const player = player_ref.current
    if (!player) return
    const off = player.on(({ kind, t: pt }) => {
      setT(pt)
      setIsPlaying(kind === PLAYER_STATE.PLAYING)
    })
    return () => { off() }
  }, [topology])

  useEffect(() => {
    const player = player_ref.current
    if (player) player.set_step_ms(step_ms)
  }, [step_ms])

  const handle_play_pause = useCallback(() => {
    const player = player_ref.current
    if (!player) return
    if (is_playing) player.pause()
    else player.play()
  }, [is_playing])

  const handle_seek = useCallback((next_t: number) => {
    const player = player_ref.current
    if (!player) return
    if (is_playing) player.pause()
    player.seek(next_t)
  }, [is_playing])

  const toggle_layer = useCallback((id: LayerKind) => {
    setActiveLayers(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handle_place_batteries = useCallback(() => {
    const player = player_ref.current
    const topo = topo_ref.current
    if (!player || !topo || !scenario) return
    setSolverStatus('solving…')
    setTimeout(() => {
      try {
        const solver = new BatteryPlacementSolver({ verbosity: 0 })
          .configure(topo, baseline, scenario, {
            budget_dollar: budget_M * 1e6,
            k_max: 5,
            size_step_MWh: 1500,
            power_to_energy_ratio: 0.5,
          })
        const placed = solver.greedy()
        player.compute_with_batteries(placed)
        setPlacedBatteries(placed)
        setWithBattery(player.with_battery)
        setShowWithBattery(true)
        setSolverStatus(`placed ${placed.length} batteries (${(placed.reduce((s, b) => s + b.capacity_MWh, 0)).toFixed(0)} MWh, $${(placed.reduce((s, b) => s + b.capacity_MWh * 1000 * b.cost_per_kWh, 0) / 1e6).toFixed(0)}M)`)
      } catch (e) {
        setSolverStatus(`solver error: ${(e as Error).message}`)
      }
    }, 30)
  }, [scenario, baseline, budget_M])

  const handle_reset_batteries = useCallback(() => {
    const player = player_ref.current
    if (!player) return
    player.compute_with_batteries([])
    setPlacedBatteries([])
    setWithBattery([])
    setShowWithBattery(false)
    setSolverStatus('')
  }, [])

  useEffect(() => {
    if (!scenario) return
    if (scenario.metadata.source !== data_source) {
      const next = SCENARIOS.find(s => s.source === data_source)
      if (next) setScenarioId(next.id)
    }
  }, [data_source, scenario])

  if (!mounted || !topology) {
    return (
      <div className={`w-full h-[640px] bg-white dark:bg-[#141414] rounded-lg border border-gray-200 dark:border-[#333] flex items-center justify-center text-sm text-gray-400 ${className}`}>
        {error ? <span className="text-red-500">{error}</span> : 'loading topology…'}
      </div>
    )
  }

  const total_steps = baseline.length
  const dt_h = scenario ? scenario.metadata.interval_min / 60 : 0.25
  const t_hours = t * dt_h
  const baseline_snap = baseline[t] ?? null
  const with_battery_snap = with_battery[t] ?? null
  const clock = format_clock(resolve_start_iso(scenario?.metadata), t_hours)

  return (
    <div data-testid="texas-grid-demo" className={`w-full bg-white dark:bg-[#141414] rounded-lg border border-gray-200 dark:border-[#333] p-3 flex flex-col gap-3 ${className}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="flex rounded border border-gray-300 dark:border-[#333] overflow-hidden">
          {(['real', 'synthetic'] as const).map(src => (
            <button key={src}
              onClick={() => setDataSource(src)}
              className={`px-2 py-1 ${data_source === src ? 'bg-sky-500/20 text-sky-700 dark:text-sky-300 font-semibold' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-[#222]'}`}
            >
              {src}
            </button>
          ))}
        </div>
        <div className="flex rounded border border-gray-300 dark:border-[#333] overflow-hidden">
          {SCENARIOS.filter(s => s.source === data_source).map(sc => (
            <button key={sc.id}
              onClick={() => setScenarioId(sc.id)}
              className={`px-2.5 py-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-[#222]'}`}
            >
              {sc.label}
            </button>
          ))}
        </div>
        <div className="text-gray-500 text-[11px] ml-auto truncate max-w-[40%]">
          {scenario?.metadata.description}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-500 text-[10px] uppercase tracking-wider">Layers</span>
        {LAYER_LABELS.map(({ id, label }) => {
          const active = active_layers.has(id)
          return (
            <button key={id}
              onClick={() => toggle_layer(id)}
              className={`px-2 py-0.5 rounded border ${active ? 'bg-gray-900/90 dark:bg-white/10 text-white dark:text-gray-100 border-gray-900 dark:border-white/20' : 'border-gray-300 dark:border-[#333] text-gray-500 hover:bg-gray-100 dark:hover:bg-[#222]'}`}
            >
              {label}
            </button>
          )
        })}
        {active_layers.has('balance') && (
          <div className="flex items-center gap-0.5 ml-1 rounded border border-gray-300 dark:border-[#333] overflow-hidden">
            <span className="text-gray-500 text-[10px] px-1.5">∫</span>
            {(['instant', 'day', 'month', 'year'] as BalanceHorizon[]).map(h => (
              <button key={h}
                onClick={() => setBalanceHorizon(h)}
                className={`px-1.5 py-0.5 text-[10px] ${balance_horizon === h ? 'bg-red-500/20 text-red-700 dark:text-red-300 font-semibold' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-[#222]'}`}
              >
                {h}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex gap-1 items-center">
          <span className="text-gray-500 text-[10px]">budget</span>
          <input type="range" min="200" max="2000" step="50" value={budget_M} onChange={e => setBudgetM(Number(e.target.value))} className="w-20" />
          <span className="font-mono text-[10px] w-12 text-right">${budget_M}M</span>
          <button onClick={handle_place_batteries} className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white">
            Place batteries
          </button>
          {placed_batteries.length > 0 && (
            <button onClick={handle_reset_batteries} className="px-2 py-0.5 rounded border border-gray-300 dark:border-[#333] text-gray-500">
              clear
            </button>
          )}
        </div>
      </div>

      {solver_status && (
        <div className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono px-1">{solver_status}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 flex flex-col gap-2">
          <div className="flex gap-1 text-[10px] items-center">
            {placed_batteries.length > 0 && (
              <div className="flex rounded border border-gray-300 dark:border-[#333] overflow-hidden">
                <button onClick={() => setShowWithBattery(false)} className={`px-2 py-0.5 ${!show_with_battery ? 'bg-gray-200 dark:bg-[#222] font-semibold' : 'text-gray-500'}`}>Baseline</button>
                <button onClick={() => setShowWithBattery(true)} className={`px-2 py-0.5 ${show_with_battery ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 font-semibold' : 'text-gray-500'}`}>+ batteries</button>
              </div>
            )}
            <div className="ml-auto flex items-center gap-3 text-gray-500">
              {clock && (
                <span className="font-mono text-gray-700 dark:text-gray-300">
                  {clock.date} {clock.time}
                </span>
              )}
              <span>t = <span className="font-mono">{format_t(t_hours)}</span></span>
            </div>
          </div>
          <TexasGridMap
            topology={topology}
            baseline_snap={baseline_snap}
            with_battery_snap={with_battery_snap}
            baseline_series={baseline}
            with_battery_series={with_battery}
            inputs={scenario?.inputs ?? null}
            t={t}
            active_layers={active_layers}
            show_with_battery={show_with_battery}
            placed_batteries={placed_batteries}
            plants={plants}
            balance_horizon={balance_horizon}
            height={420}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handle_play_pause}
              aria-label={is_playing ? 'pause' : 'play'}
              className="w-7 h-7 rounded flex items-center justify-center border border-gray-300 dark:border-[#333] text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-white/10"
            >
              {is_playing ? (
                <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden>
                  <rect x="0" y="0" width="3" height="12" />
                  <rect x="7" y="0" width="3" height="12" />
                </svg>
              ) : (
                <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden>
                  <path d="M0 0 L10 6 L0 12 Z" />
                </svg>
              )}
            </button>
            <input type="range" min="0" max={Math.max(0, total_steps - 1)} value={t} onChange={e => handle_seek(Number(e.target.value))}
              className="flex-1" />
            <div className="flex rounded border border-gray-300 dark:border-[#333] overflow-hidden">
              {STEP_MS_OPTIONS.map(({ ms, label }) => (
                <button key={ms} onClick={() => setStepMs(ms)}
                  className={`px-1.5 py-0.5 text-[10px] ${step_ms === ms ? 'bg-gray-900 dark:bg-white/10 text-white' : 'text-gray-500'}`}
                >{label}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <TexasGridMetricsPanel
            baseline={baseline}
            with_batteries={with_battery}
            current_t={t}
            dt_h={dt_h}
          />
          {placed_batteries.length > 0 && (
            <div className="text-[10px] bg-white dark:bg-[#141414] border border-gray-200 dark:border-[#333] rounded p-2">
              <div className="text-gray-500 uppercase tracking-wider mb-1">Placed batteries</div>
              <ul className="space-y-0.5">
                {placed_batteries.map(b => (
                  <li key={b.id} className="flex justify-between font-mono">
                    <span>{b.bus}</span>
                    <span>{b.capacity_MWh}MWh / {b.max_power_MW.toFixed(0)}MW</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default TexasGridDemo
