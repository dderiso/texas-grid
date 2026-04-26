/**
 * ScenarioPlayer
 * Loads a pre-computed scenario (baseline dispatch in JSON), optionally re-solves with placed
 * batteries, and emits paired (baseline, with-batteries) frames as the audience scrubs through time.
 *
 * Process flow:
 *   1. load(scenario_id)              — fetch scenario JSON; the baseline dispatch is pre-computed
 *   2. compute_with_batteries(bs)     — re-solve dispatch with placed batteries
 *   3. play() / pause() / seek(t)     — animate via host setInterval; expose state
 *   4. frame(t)                       — return { baseline, with_battery, t }
 *   5. dispose()                      — stop the interval and reset
 *
 * State transitions:
 *   IDLE → LOADING → READY → PLAYING ⇄ PAUSED  (any → DISPOSED on dispose())
 */

import type {
  DispatchSnapshot,
  PlacedBattery,
  Scenario,
} from './types'
import { ERCOTTopology } from './topology'
import { DCDispatchSolver } from './dispatch'

export enum PLAYER_STATE {
  IDLE = 'IDLE',
  LOADING = 'LOADING',
  READY = 'READY',
  PLAYING = 'PLAYING',
  PAUSED = 'PAUSED',
  DISPOSED = 'DISPOSED',
}

export type PlayerListener = (state: { kind: PLAYER_STATE; t: number }) => void

export interface PlayerFrame {
  t: number
  baseline: DispatchSnapshot | null
  with_battery: DispatchSnapshot | null
}

export interface PlayerOptions {
  verbosity?: number
  step_ms?: number
  topology: ERCOTTopology
}

export class ScenarioPlayer {
  state: PLAYER_STATE = PLAYER_STATE.IDLE
  current_t: number = 0
  scenario: Scenario | null = null
  baseline: DispatchSnapshot[] = []
  with_battery: DispatchSnapshot[] = []
  placed_batteries: PlacedBattery[] = []

  private _verbosity: number
  private _step_ms: number
  private _topo: ERCOTTopology
  private _solver: DCDispatchSolver
  private _interval: ReturnType<typeof setInterval> | null = null
  private _listeners: Set<PlayerListener> = new Set()

  constructor(opts: PlayerOptions) {
    this._verbosity = opts.verbosity ?? 0
    this._step_ms = opts.step_ms ?? 120
    this._topo = opts.topology
    this._solver = new DCDispatchSolver({ verbosity: this._verbosity }).configure(this._topo)
  }

  async load(scenario_id: string): Promise<this> {
    this._set_state(PLAYER_STATE.LOADING)
    const r = await fetch(`/data/texas-grid/scenarios/${scenario_id}.json`)
    if (!r.ok) throw new Error(`failed to fetch scenario ${scenario_id}: ${r.status}`)
    const scenario = (await r.json()) as Scenario
    this._validate_scenario(scenario)
    this.scenario = scenario
    this.baseline = scenario.baseline_dispatch
    this.with_battery = []
    this.placed_batteries = []
    this.current_t = 0
    this._set_state(PLAYER_STATE.READY)
    return this
  }

  compute_with_batteries(batteries: PlacedBattery[]): this {
    if (!this.scenario) throw new Error('no scenario loaded')
    this.placed_batteries = batteries
    this.with_battery = batteries.length === 0 ? [] : this._solver.solve_horizon(this.scenario, batteries)
    return this
  }

  play(): this {
    if (this.state === PLAYER_STATE.DISPOSED) return this
    if (this.state !== PLAYER_STATE.READY && this.state !== PLAYER_STATE.PAUSED) return this
    this._set_state(PLAYER_STATE.PLAYING)
    const last_t = this.baseline.length - 1
    if (this.current_t >= last_t) this.current_t = 0
    this._interval = setInterval(() => {
      const next = this.current_t + 1
      if (next >= this.baseline.length) {
        this.pause()
        return
      }
      this.current_t = next
      this._emit()
    }, this._step_ms)
    return this
  }

  pause(): this {
    if (this._interval) { clearInterval(this._interval); this._interval = null }
    if (this.state === PLAYER_STATE.PLAYING) this._set_state(PLAYER_STATE.PAUSED)
    return this
  }

  seek(t: number): this {
    const clamped = Math.max(0, Math.min(t, Math.max(0, this.baseline.length - 1)))
    this.current_t = clamped
    this._emit()
    return this
  }

  frame(t: number): PlayerFrame {
    return {
      t,
      baseline: this.baseline[t] ?? null,
      with_battery: this.with_battery[t] ?? null,
    }
  }

  current_frame(): PlayerFrame {
    return this.frame(this.current_t)
  }

  on(listener: PlayerListener): () => void {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  set_step_ms(ms: number): this {
    this._step_ms = ms
    if (this.state === PLAYER_STATE.PLAYING) {
      this.pause()
      this.play()
    }
    return this
  }

  dispose(): void {
    if (this._interval) { clearInterval(this._interval); this._interval = null }
    this._listeners.clear()
    this._set_state(PLAYER_STATE.DISPOSED)
  }

  private _validate_scenario(s: Scenario) {
    if (!s.metadata) throw new Error('scenario missing metadata')
    if (!s.inputs?.load_MW) throw new Error('scenario missing inputs.load_MW')
    if (!s.baseline_dispatch?.length) throw new Error('scenario missing baseline_dispatch')
    const n_zones = s.inputs.load_MW.length
    if (n_zones !== this._topo.n_buses) {
      throw new Error(`scenario zone count ${n_zones} does not match topology ${this._topo.n_buses}`)
    }
  }

  private _set_state(next: PLAYER_STATE) {
    if (this._verbosity >= 2 && this.state !== next) {
      console.log(`state: ${this.state} → ${next}`)
    }
    this.state = next
    this._emit()
  }

  private _emit() {
    for (const l of this._listeners) l({ kind: this.state, t: this.current_t })
  }
}
