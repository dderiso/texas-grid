'use client'

/**
 * TexasGridMetricsPanel
 * Side-by-side baseline vs with-batteries metrics + cumulative cost time-series.
 */

import { useMemo, useRef, useState, useEffect } from 'react'
import type { ComparisonMetrics, DispatchSnapshot } from '@/lib/power-grid'
import { MetricsAccumulator } from '@/lib/power-grid'

interface TexasGridMetricsPanelProps {
  baseline: DispatchSnapshot[]
  with_batteries: DispatchSnapshot[]
  current_t: number
  dt_h: number
  className?: string
}

interface MetricCellProps {
  label: string
  unit: string
  baseline: number
  candidate: number
  format: (v: number) => string
  better_when: 'lower' | 'higher'
  show_candidate: boolean
}

function MetricCell({ label, unit, baseline, candidate, format, better_when, show_candidate }: MetricCellProps) {
  const denom = Math.max(Math.abs(baseline), Math.abs(candidate), 1e-6)
  const delta = (candidate - baseline) / denom
  const better = better_when === 'lower' ? candidate < baseline - 1e-6 : candidate > baseline + 1e-6
  const worse  = better_when === 'lower' ? candidate > baseline + 1e-6 : candidate < baseline - 1e-6
  const tone = better ? 'text-emerald-500' : worse ? 'text-red-400' : 'text-gray-500'
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1 rounded bg-white/40 dark:bg-[#0f172a]/40 border border-gray-200 dark:border-[#222]">
      <div className="text-[9px] text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="flex justify-between items-baseline">
        <div className="font-mono text-[12px] text-gray-700 dark:text-gray-300">{format(baseline)}<span className="text-[9px] text-gray-400 ml-0.5">{unit}</span></div>
        {show_candidate && (
          <div className={`font-mono text-[12px] ${tone}`}>{format(candidate)}<span className="text-[9px] opacity-60 ml-0.5">{unit}</span></div>
        )}
      </div>
      {show_candidate && (better || worse) && (
        <div className={`text-[9px] text-right ${tone}`}>
          {Math.abs(delta) > 5
            ? (better ? 'improved' : 'worse')
            : `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`}
        </div>
      )}
    </div>
  )
}

export function TexasGridMetricsPanel({ baseline, with_batteries, current_t, dt_h, className = '' }: TexasGridMetricsPanelProps) {
  const has_batteries = with_batteries.length > 0
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current
    setWidth(el.offsetWidth)
    const obs = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const metrics: ComparisonMetrics = useMemo(() => {
    const cap = Math.min(current_t + 1, baseline.length)
    const sliced_base = baseline.slice(0, cap)
    const sliced_with = has_batteries ? with_batteries.slice(0, cap) : []
    return new MetricsAccumulator().compare(sliced_base, sliced_with, dt_h)
  }, [baseline, with_batteries, current_t, dt_h, has_batteries])

  const cost_series = useMemo(() => {
    const acc = new MetricsAccumulator()
    return {
      base: acc.cumulative_cost_series(baseline, dt_h),
      with: has_batteries ? acc.cumulative_cost_series(with_batteries, dt_h) : null,
    }
  }, [baseline, with_batteries, dt_h, has_batteries])

  const chart = useMemo(() => {
    if (width === 0) return null
    const h = 96
    const padding = { top: 6, right: 8, bottom: 14, left: 36 }
    const inner_w = width - padding.left - padding.right
    const inner_h = h - padding.top - padding.bottom
    const max_t = Math.max(...cost_series.base.t, 0.0001)
    const max_v = Math.max(
      ...cost_series.base.values,
      ...(cost_series.with ? cost_series.with.values : [0]),
      1,
    )
    const xs = (t: number) => padding.left + (t / max_t) * inner_w
    const ys = (v: number) => padding.top + inner_h - (v / max_v) * inner_h
    const path_base = cost_series.base.t.length === 0 ? '' :
      'M ' + cost_series.base.t.map((t, i) => `${xs(t).toFixed(1)},${ys(cost_series.base.values[i]).toFixed(1)}`).join(' L ')
    const path_with = cost_series.with && cost_series.with.t.length > 0
      ? 'M ' + cost_series.with.t.map((t, i) => `${xs(t).toFixed(1)},${ys(cost_series.with!.values[i]).toFixed(1)}`).join(' L ')
      : null
    const cursor_x = xs(current_t * dt_h)
    const horizon_h = max_t
    const horizon_label = horizon_h >= 48 ? `${(horizon_h / 24).toFixed(0)}d` : `${horizon_h.toFixed(0)}h`
    return { h, padding, xs, ys, path_base, path_with, cursor_x, max_v, horizon_label }
  }, [width, cost_series, current_t, dt_h])

  return (
    <div ref={containerRef} className={`w-full bg-white dark:bg-[#141414] rounded-lg border border-gray-200 dark:border-[#333] p-2 flex flex-col gap-2 ${className}`}>
      <div className="grid grid-cols-2 gap-1">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 px-2">Baseline</div>
        <div className="text-[10px] uppercase tracking-wider px-2 text-emerald-500">{has_batteries ? 'With batteries' : 'Place batteries to compare'}</div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <MetricCell label="dispatch cost"   unit="M$" baseline={metrics.baseline.total_cost / 1e6} candidate={metrics.with_batteries.total_cost / 1e6} format={v => v.toFixed(1)} better_when="lower" show_candidate={has_batteries} />
        <MetricCell label="net peak"        unit="GW" baseline={metrics.baseline.peak_load_MW / 1000} candidate={metrics.with_batteries.peak_load_MW / 1000} format={v => v.toFixed(2)} better_when="lower" show_candidate={has_batteries} />
        <MetricCell label="congestion"      unit="GWh" baseline={metrics.baseline.congestion_MWh / 1000} candidate={metrics.with_batteries.congestion_MWh / 1000} format={v => v.toFixed(1)} better_when="lower" show_candidate={has_batteries} />
        <MetricCell label="overload-min"    unit="" baseline={metrics.baseline.line_overload_minutes} candidate={metrics.with_batteries.line_overload_minutes} format={v => v.toFixed(0)} better_when="lower" show_candidate={has_batteries} />
        <MetricCell label="reserve floor"   unit="MW" baseline={metrics.baseline.reserve_margin_min_MW} candidate={metrics.with_batteries.reserve_margin_min_MW} format={v => v.toFixed(0)} better_when="higher" show_candidate={has_batteries} />
        <MetricCell label="batt throughput" unit="MWh" baseline={0} candidate={metrics.with_batteries.battery_throughput_MWh} format={v => v.toFixed(0)} better_when="higher" show_candidate={has_batteries} />
      </div>

      <div className="border-t border-gray-200 dark:border-[#222] pt-2">
        <div className="flex justify-between items-baseline mb-1 px-1">
          <div className="text-[10px] uppercase tracking-wider text-gray-500">Cumulative cost</div>
          <div className="text-[9px] text-gray-400">$ / MWh × time</div>
        </div>
        {chart && (
          <svg width={width} height={chart.h} style={{ display: 'block' }}>
            <line x1={chart.padding.left} y1={chart.padding.top} x2={chart.padding.left} y2={chart.h - chart.padding.bottom}
              stroke="rgba(125,125,125,0.4)" strokeWidth={1} />
            <line x1={chart.padding.left} y1={chart.h - chart.padding.bottom} x2={width - chart.padding.right} y2={chart.h - chart.padding.bottom}
              stroke="rgba(125,125,125,0.4)" strokeWidth={1} />
            <text x={4} y={chart.padding.top + 8} style={{ fontSize: '9px', fill: 'rgba(125,125,125,0.8)' }}>${(chart.max_v / 1e6).toFixed(0)}M</text>
            <text x={4} y={chart.h - chart.padding.bottom - 1} style={{ fontSize: '9px', fill: 'rgba(125,125,125,0.8)' }}>$0</text>
            <text x={chart.padding.left} y={chart.h - 1} style={{ fontSize: '9px', fill: 'rgba(125,125,125,0.8)' }}>0h</text>
            <text x={width - chart.padding.right - 18} y={chart.h - 1} style={{ fontSize: '9px', fill: 'rgba(125,125,125,0.8)' }}>{chart.horizon_label}</text>
            <path d={chart.path_base} fill="none" stroke="#94a3b8" strokeWidth={1.6} />
            {chart.path_with && <path d={chart.path_with} fill="none" stroke="#10b981" strokeWidth={1.6} />}
            <line x1={chart.cursor_x} y1={chart.padding.top} x2={chart.cursor_x} y2={chart.h - chart.padding.bottom}
              stroke="rgba(245,158,11,0.7)" strokeWidth={1.2} strokeDasharray="3,2" />
          </svg>
        )}
      </div>
    </div>
  )
}

export default TexasGridMetricsPanel
