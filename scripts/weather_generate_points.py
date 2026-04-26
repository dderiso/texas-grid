#!/usr/bin/env python3
"""
weather_generate_points.py

Generate N Lloyd-relaxed points inside the Texas state polygon. Output is the
canonical point set consumed by weather_extract_year.py.

Process flow:
  1. Load TX polygon from public/data/texas-weather/tx_state.json
  2. Seed N candidates by uniform-random rejection sampling inside the polygon
  3. Lloyd's relaxation for `iters` rounds:
       - Voronoi diagram of current points (clipped to a buffered envelope)
       - Intersect each cell with the state polygon
       - Recenter the point to the clipped centroid
       - Drifters that fall outside the polygon are projected to the boundary
  4. Write public/data/texas-weather/points.json

Coordinates are in WGS84 longitude/latitude. Lloyd's runs directly in
lat/lon space; for Texas (~30°N) the cos(lat) distortion is small and not
visually meaningful, so the projection step is skipped for simplicity.

Run:
  python3 scripts/weather_generate_points.py --n 500 --iters 30
"""

import argparse
import json
from pathlib import Path

import numpy as np
from shapely.geometry import MultiPoint, Point, Polygon
from shapely.ops import nearest_points, voronoi_diagram
from shapely.strtree import STRtree


def seed_points(polygon: Polygon, n: int, rng: np.random.Generator) -> list[tuple[float, float]]:
    minx, miny, maxx, maxy = polygon.bounds
    out: list[tuple[float, float]] = []
    attempts = 0
    while len(out) < n and attempts < n * 200:
        x = rng.uniform(minx, maxx)
        y = rng.uniform(miny, maxy)
        if polygon.contains(Point(x, y)):
            out.append((x, y))
        attempts += 1
    if len(out) < n:
        raise RuntimeError(f"only seeded {len(out)}/{n} points after {attempts} attempts")
    return out


def lloyd_iter(
    points: list[tuple[float, float]],
    polygon: Polygon,
) -> tuple[list[tuple[float, float]], float]:
    mp = MultiPoint([(x, y) for x, y in points])
    env = polygon.buffer(2.0).envelope
    diagram = voronoi_diagram(mp, envelope=env)
    cells = list(diagram.geoms)

    point_objs = [Point(x, y) for x, y in points]
    tree = STRtree(point_objs)

    boundary = polygon.boundary
    new_points = list(points)
    max_disp = 0.0

    for cell in cells:
        candidates = tree.query(cell)
        pt_idx = -1
        for idx in candidates:
            if cell.contains(point_objs[int(idx)]):
                pt_idx = int(idx)
                break
        if pt_idx < 0:
            continue

        clipped = cell.intersection(polygon)
        if clipped.is_empty or clipped.area <= 0:
            continue
        if clipped.geom_type == "MultiPolygon":
            clipped = max(clipped.geoms, key=lambda g: g.area)

        c = clipped.centroid
        if polygon.contains(c):
            new_pt = (c.x, c.y)
        else:
            near = nearest_points(boundary, c)[0]
            new_pt = (near.x, near.y)

        old = points[pt_idx]
        d = ((new_pt[0] - old[0]) ** 2 + (new_pt[1] - old[1]) ** 2) ** 0.5
        if d > max_disp:
            max_disp = d
        new_points[pt_idx] = new_pt

    return new_points, max_disp


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument("--n", type=int, default=500, help="target number of points")
    ap.add_argument("--iters", type=int, default=30, help="Lloyd's relaxation rounds")
    ap.add_argument("--seed", type=int, default=42, help="RNG seed")
    ap.add_argument("--tol", type=float, default=1e-4, help="convergence tolerance (degrees)")
    ap.add_argument("--polygon", default="public/data/texas-weather/tx_state.json")
    ap.add_argument("--out", default="public/data/texas-weather/points.json")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    with open(args.polygon) as f:
        geo = json.load(f)
    coords = geo["state_outline"]
    polygon = Polygon(coords)
    if not polygon.is_valid:
        polygon = polygon.buffer(0)

    minx, miny, maxx, maxy = polygon.bounds
    print(
        f"polygon: area={polygon.area:.3f} sq-deg "
        f"bounds=[{minx:.3f},{miny:.3f},{maxx:.3f},{maxy:.3f}]"
    )

    rng = np.random.default_rng(args.seed)
    points = seed_points(polygon, args.n, rng)
    print(f"seeded {len(points)} points")

    iters_done = 0
    for i in range(args.iters):
        points, max_disp = lloyd_iter(points, polygon)
        iters_done = i + 1
        if args.verbose or i % 5 == 0 or i == args.iters - 1:
            print(f"iter {i + 1}/{args.iters}: max_disp={max_disp:.5f} deg, n={len(points)}")
        if max_disp < args.tol:
            print(f"converged at iter {i + 1}")
            break

    out_data = {
        "version": 1,
        "n": len(points),
        "iters_completed": iters_done,
        "seed": args.seed,
        "polygon_source": args.polygon,
        "crs": "WGS84",
        "points": [{"lat": float(y), "lon": float(x)} for x, y in points],
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(out_data, f, indent=2)
    print(f"wrote {len(points)} points → {out_path}")


if __name__ == "__main__":
    main()
