#!/usr/bin/env python3.12
"""
texas_compress_weather.py

Distill the 2 TB Texas HRRR Zarr into a tiny per-ERCOT-zone hourly time series
for a target week. Runs on deepbluue (where the Zarr lives); output JSON is
scp'd back to public/data/texas-grid/scenarios/.

Process flow:
  1. Open Zarr (xarray, consolidated)
  2. Build nearest-bus assignment mask for the 20 ERCOT-aligned topology buses
  3. Select the requested time window (default: 2023-08-21..2023-08-28 UTC)
  4. For each variable (T2m, |10m wind|, |80m wind|, TCWV), aggregate
     384 x 512 grid → 20 zones via mean over assigned cells
  5. Stream results to JSONL + write final JSON

Instrumentation per docs/REMOTE_COMPUTE.md: ProgressTracker checkpoints every
hour, append-only JSONL with fsync every 25 hours, --resume-friendly.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import xarray as xr

try:
    from job_monitor import ProgressTracker
except Exception:
    ProgressTracker = None

ZARR_PATH = "/home/dderiso/Datasets/energy/atmo/texas_2017_2024.zarr"

BUSES = [
    ("HOUSTON",       29.76,  -95.37),
    ("DFW",           32.78,  -96.80),
    ("AUSTIN",        30.27,  -97.74),
    ("SAN_ANTONIO",   29.42,  -98.49),
    ("EL_PASO",       31.76, -106.49),
    ("RGV",           26.20,  -98.23),
    ("CORPUS",        27.80,  -97.40),
    ("PERMIAN",       31.84, -102.37),
    ("S_TEXAS_WIND",  27.00,  -98.50),
    ("PANHANDLE",     35.22, -101.83),
    ("W_TEXAS_SOLAR", 31.00, -103.00),
    ("COMAL",         29.71,  -98.13),
    ("COAST_GAS",     28.75,  -96.00),
    ("E_TEXAS",       32.30,  -94.50),
    ("LCRA",          30.50,  -98.50),
    ("BRAZOS",        31.00,  -97.00),
    ("SWEETWATER",    32.47, -100.41),
    ("N_TEXAS",       33.50,  -97.00),
    ("ROANS_PRAIRIE", 30.70,  -95.95),
    ("WACO",          31.55,  -97.13),
]


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--zarr", default=ZARR_PATH)
    p.add_argument("--start", default="2023-08-21T00:00")
    p.add_argument("--end",   default="2023-08-28T00:00")
    p.add_argument("--label", default="aug-2023-heat-dome")
    p.add_argument("--out-dir", default="/home/dderiso/sweep-work/public/data/texas-grid/scenarios")
    p.add_argument("--jsonl",   default="/home/dderiso/sweep-work/explorations/texas-grid-precompute/weather_compress.jsonl")
    p.add_argument("--restart", action="store_true")
    return p.parse_args()


def build_assignment(lat_arr, lon_arr_minus180):
    """For each (lat_idx, lon_idx), return the index of the nearest bus."""
    bus_lats = np.array([b[1] for b in BUSES])
    bus_lons = np.array([b[2] for b in BUSES])
    Lat, Lon = np.meshgrid(lat_arr, lon_arr_minus180, indexing="ij")
    flat_lat = Lat.ravel()
    flat_lon = Lon.ravel()
    dlat = flat_lat[:, None] - bus_lats[None, :]
    dlon = (flat_lon[:, None] - bus_lons[None, :]) * np.cos(np.deg2rad(flat_lat[:, None]))
    d2 = dlat * dlat + dlon * dlon
    nearest = d2.argmin(axis=1).reshape(Lat.shape)
    return nearest


def aggregate_per_zone(field_2d, mask_flat, n_zones):
    """field_2d: (n_lat, n_lon) → (n_zones,) means."""
    flat = np.asarray(field_2d).ravel()
    sums = np.bincount(mask_flat, weights=flat, minlength=n_zones)
    counts = np.bincount(mask_flat, minlength=n_zones)
    counts = np.where(counts == 0, 1, counts)
    return sums / counts


def load_existing_jsonl(path):
    rows = {}
    if not os.path.exists(path):
        return rows
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                rows[row["t_iso"]] = row
            except Exception:
                pass
    return rows


def main():
    args = parse_args()
    out_path = Path(args.out_dir) / f"weather-{args.label}.json"
    jsonl_path = Path(args.jsonl)
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if args.restart and jsonl_path.exists():
        jsonl_path.unlink()

    print(f"[texas_compress_weather] opening Zarr: {args.zarr}", flush=True)
    ds = xr.open_zarr(args.zarr, consolidated=True)
    print(f"[texas_compress_weather] vars: {list(ds.data_vars)}", flush=True)

    lat = np.asarray(ds["latitude"].values)
    lon360 = np.asarray(ds["longitude"].values)
    lon180 = ((lon360 + 180) % 360) - 180

    mask = build_assignment(lat, lon180)
    mask_flat = mask.ravel()
    n_zones = len(BUSES)
    print(f"[texas_compress_weather] grid: {len(lat)} x {len(lon180)}, zones: {n_zones}", flush=True)
    counts = np.bincount(mask_flat, minlength=n_zones)
    for i, (bid, blat, blon) in enumerate(BUSES):
        print(f"  zone {bid:14s}  cells={counts[i]:5d}", flush=True)

    sub = ds.sel(time=slice(args.start, args.end))
    times = sub["time"].values
    n_steps = len(times)
    print(f"[texas_compress_weather] window: {args.start} → {args.end}  ({n_steps} hourly steps)", flush=True)

    existing = load_existing_jsonl(jsonl_path)
    print(f"[texas_compress_weather] resume: {len(existing)} prior rows", flush=True)

    tracker = None
    if ProgressTracker is not None and os.environ.get("JOB_MONITOR_JOB_ID"):
        try:
            tracker = ProgressTracker(total_iterations=n_steps, checkpoint_interval_s=30).__enter__()
            tracker.register_log(str(jsonl_path))
        except Exception as e:
            print(f"[texas_compress_weather] tracker init failed: {e}", flush=True)
            tracker = None

    fd = open(jsonl_path, "a")
    t_start = time.time()

    rows_by_t = dict(existing)

    for i, t_val in enumerate(times):
        t_iso = str(np.datetime_as_string(t_val, unit="m"))
        if t_iso in existing:
            if tracker:
                tracker.checkpoint(iteration=i + 1, total=n_steps)
            continue
        snap = sub.isel(time=i)
        T2m_K = np.asarray(snap["2m_temperature"].values)
        U10 = np.asarray(snap["10m_u_component_of_wind"].values)
        V10 = np.asarray(snap["10m_v_component_of_wind"].values)
        U80 = np.asarray(snap["80m_u_component_of_wind"].values)
        V80 = np.asarray(snap["80m_v_component_of_wind"].values)
        TCWV = np.asarray(snap["total_column_water_vapour"].values)
        wind10 = np.sqrt(U10 * U10 + V10 * V10)
        wind80 = np.sqrt(U80 * U80 + V80 * V80)

        row = {
            "t_iso": t_iso,
            "T2m_C":         (aggregate_per_zone(T2m_K - 273.15, mask_flat, n_zones)).tolist(),
            "wind_10m_ms":   (aggregate_per_zone(wind10,         mask_flat, n_zones)).tolist(),
            "wind_80m_ms":   (aggregate_per_zone(wind80,         mask_flat, n_zones)).tolist(),
            "tcwv_kg_m2":    (aggregate_per_zone(TCWV,           mask_flat, n_zones)).tolist(),
        }
        rows_by_t[t_iso] = row
        fd.write(json.dumps(row) + "\n")
        if (i + 1) % 25 == 0:
            fd.flush()
            os.fsync(fd.fileno())

        if (i + 1) % 8 == 0 or i == n_steps - 1:
            elapsed = time.time() - t_start
            rate = (i + 1 - len(existing)) / max(elapsed, 1e-3)
            eta = (n_steps - (i + 1)) / max(rate, 1e-3)
            t_max_C = float(np.max(row["T2m_C"]))
            print(f"  {i+1:4d}/{n_steps}  ({100*(i+1)/n_steps:5.1f}%)  rate={rate:5.2f}/s  ETA={eta:6.0f}s  t={t_iso}  Tmax={t_max_C:5.1f}°C", flush=True)
        if tracker:
            tracker.checkpoint(iteration=i + 1, total=n_steps)
            tracker.report_result({"t_iso": t_iso, "tmax_C": float(np.max(row["T2m_C"]))}, label="weather_fits")

    fd.flush()
    os.fsync(fd.fileno())
    fd.close()

    print(f"[texas_compress_weather] writing {out_path}", flush=True)
    sorted_items = sorted(rows_by_t.items(), key=lambda kv: kv[0])
    sorted_iso = [k for k, _ in sorted_items]
    sorted_rows = [v for _, v in sorted_items]
    n = len(sorted_rows)

    out = {
        "scenario_id":    args.label,
        "source":         "HRRR via texas_2017_2024.zarr",
        "time_iso":       sorted_iso,
        "interval_min":   60,
        "n_timesteps":    n,
        "zones":          [b[0] for b in BUSES],
        "T2m_C":          [[r["T2m_C"][z]       for r in sorted_rows] for z in range(n_zones)],
        "wind_10m_ms":    [[r["wind_10m_ms"][z] for r in sorted_rows] for z in range(n_zones)],
        "wind_80m_ms":    [[r["wind_80m_ms"][z] for r in sorted_rows] for z in range(n_zones)],
        "tcwv_kg_m2":     [[r["tcwv_kg_m2"][z]  for r in sorted_rows] for z in range(n_zones)],
    }
    with open(out_path, "w") as f:
        json.dump(out, f)

    elapsed = time.time() - t_start
    print(f"[texas_compress_weather] done.  rows={n}  zones={n_zones}  elapsed={elapsed:.1f}s  out={out_path}  size={out_path.stat().st_size} bytes", flush=True)
    print(f"Published to {out_path} ({n} rows)", flush=True)

    if tracker:
        try:
            tracker.__exit__(None, None, None)
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main() or 0)
