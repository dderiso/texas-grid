#!/usr/bin/env python3
"""
weather_extract_year.py

Sample 2m_temperature at N pre-generated point locations across all hours of
one year, write the result as a flat WTHR-headed binary that weather_compress
(C++) consumes. Runs on deepbluue where the 2 TB Zarr lives.

Process flow:
  1. Load points.json (lat/lon, WGS84)
  2. Open Zarr, snap each point to nearest (i, j) cell of the 384 x 512 grid
  3. For the requested year, vectorized fancy-index 2m_temperature → T x N float32
  4. Convert K → °C in-place
  5. Compute vmin / vmax (drop NaN)
  6. Write WTHR header + payload to --out

Instrumentation: ProgressTracker per chunk (1 day = 24 hours) when available.

Run on deepbluue:
  python3 scripts/weather_extract_year.py \\
      --year 2017 \\
      --points public/data/texas-weather/points.json \\
      --out data/texas-weather/raw/2017.bin
"""

import argparse
import json
import struct
import sys
import time
from pathlib import Path

import numpy as np
import xarray as xr

try:
    from job_monitor import ProgressTracker
except Exception:
    ProgressTracker = None

ZARR_PATH_DEFAULT = "/home/dderiso/Datasets/energy/atmo/texas_2017_2024.zarr"

WTHR_MAGIC = b"WTHR"
WTHR_VERSION = 1
WTHR_HEADER_BYTES = 104


def lon_to_360(lon: float) -> float:
    """Convert -180..180 → 0..360 to match the dataset's longitude convention."""
    return (lon + 360.0) % 360.0


def snap_points_to_grid(points: list[dict], lat_grid: np.ndarray, lon_grid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """For each point, find nearest (i, j) into 384 x 512 HRRR grid."""
    n = len(points)
    i_arr = np.empty(n, dtype=np.int64)
    j_arr = np.empty(n, dtype=np.int64)
    for k, p in enumerate(points):
        i_arr[k] = int(np.argmin(np.abs(lat_grid - p["lat"])))
        j_arr[k] = int(np.argmin(np.abs(lon_grid - lon_to_360(p["lon"]))))
    return i_arr, j_arr


def write_wthr(
    out_path: Path,
    matrix: np.ndarray,
    year: int,
    start_unix_sec: int,
    interval_sec: int,
    vmin: float,
    vmax: float,
) -> None:
    """Layout (104 bytes header):
        magic[4] version:u32 T:u32 N:u32 year:u32 interval:u32 start_unix:i64 vmin:f32 vmax:f32 reserved[64]
    Field order is 8-aligned so the i64 sits at offset 24 with no padding.
    Must match cpp_weather/include/weather_compress/types.hpp::raw_header.
    """
    assert matrix.dtype == np.float32, "matrix must be float32"
    assert matrix.ndim == 2, "matrix must be 2-D (T, N)"
    T, N = matrix.shape
    header = struct.pack(
        "<4sIIIIIqff",
        WTHR_MAGIC, WTHR_VERSION, T, N, year, interval_sec, start_unix_sec, vmin, vmax,
    )
    header += b"\x00" * (WTHR_HEADER_BYTES - len(header))
    assert len(header) == WTHR_HEADER_BYTES

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(header)
        f.write(matrix.tobytes(order="C"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--year", type=int, required=True)
    ap.add_argument("--points", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--zarr", default=ZARR_PATH_DEFAULT)
    ap.add_argument("--var", default="2m_temperature")
    ap.add_argument("--chunk-hours", type=int, default=168, help="hours per dask compute step")
    ap.add_argument("--job-id", default=None)
    args = ap.parse_args()

    with open(args.points) as f:
        pts_doc = json.load(f)
    points = pts_doc["points"]
    N = len(points)
    print(f"loaded {N} points from {args.points}")

    print(f"opening zarr: {args.zarr}")
    ds = xr.open_zarr(args.zarr, consolidated=True)
    lat_grid = ds["latitude"].values
    lon_grid = ds["longitude"].values
    print(f"grid: lat {lat_grid.shape} {lat_grid.min():.3f}..{lat_grid.max():.3f}, "
          f"lon {lon_grid.shape} {lon_grid.min():.3f}..{lon_grid.max():.3f}")

    i_arr, j_arr = snap_points_to_grid(points, lat_grid, lon_grid)
    print(f"snapped points: i ∈ [{i_arr.min()}, {i_arr.max()}], j ∈ [{j_arr.min()}, {j_arr.max()}]")

    da = ds[args.var].sel(time=str(args.year))
    T = da.sizes["time"]
    times = da["time"].values
    interval_sec = int((times[1] - times[0]) / np.timedelta64(1, "s"))
    start_unix_sec = int(times[0].astype("datetime64[s]").astype(np.int64))
    print(f"year {args.year}: T={T}, interval={interval_sec}s, "
          f"start={np.datetime_as_string(times[0])}")

    # Spot-check uniform spacing — HRRR has known outages.
    diffs = np.diff(times) / np.timedelta64(1, "s")
    if not np.all(diffs == interval_sec):
        bad = int(np.sum(diffs != interval_sec))
        print(f"  WARN: {bad} non-uniform time steps in {args.year}", file=sys.stderr)

    out = np.empty((T, N), dtype=np.float32)
    pt_dim = xr.DataArray(np.arange(N), dims="point")
    i_da = xr.DataArray(i_arr, dims="point")
    j_da = xr.DataArray(j_arr, dims="point")

    pt = ProgressTracker(args.job_id, total=T) if (ProgressTracker and args.job_id) else None

    chunk = int(args.chunk_hours)
    t0 = time.time()
    for s in range(0, T, chunk):
        e = min(T, s + chunk)
        block = da.isel(time=slice(s, e), latitude=i_da, longitude=j_da).values
        out[s:e] = block.astype(np.float32, copy=False)
        if pt is not None:
            pt.update(e)
        if s % (chunk * 4) == 0 or e == T:
            rate = e / max(time.time() - t0, 1e-9)
            print(f"  {e}/{T} hours ({rate:.0f} h/s)")

    # Convert K → °C.
    out -= 273.15

    nan_count = int(np.isnan(out).sum())
    if nan_count > 0:
        print(f"WARN: {nan_count} NaN values in extracted matrix", file=sys.stderr)

    finite = out[np.isfinite(out)]
    vmin = float(np.min(finite)) if finite.size else 0.0
    vmax = float(np.max(finite)) if finite.size else 0.0
    print(f"matrix: {out.shape} dtype={out.dtype} vmin={vmin:.2f} vmax={vmax:.2f} °C")

    out_path = Path(args.out)
    write_wthr(out_path, out, args.year, start_unix_sec, interval_sec, vmin, vmax)
    sz = out_path.stat().st_size
    print(f"wrote {out_path} ({sz / 1024 / 1024:.2f} MB)")


if __name__ == "__main__":
    main()
