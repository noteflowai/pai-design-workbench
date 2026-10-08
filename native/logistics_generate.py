"""Synthetic, labelled road-transport instances for the off-site logistics planning artifact (pai-logistics-problem-1).

    python3 logistics_generate.py --seed 7 --orders 24 --vehicles 5 --output problem.json [--scenario normal|tight|overload]

Everything here is synthetic: random sites in a ~60 x 40 km box around one depot, road distance = great-circle
distance x 1.3 (a common detour factor), travel time at 50 km/h. It is not a real road network, real customers or
real demand, and results on it say nothing about production performance. The same seed always gives the same file.
Scenarios: `normal` (solvable), `tight` (time windows narrowed so some orders cannot be served),
`overload` (one order heavier than any vehicle: infeasible unless orders may be left unassigned).
"""
import argparse
import json
import math
import random
from pathlib import Path

ROAD_FACTOR, SPEED_KMH = 1.3, 50.0
DEPOT = (31.2304, 121.4737)  # a reference point only; the instance is synthetic


def haversine(a, b):
    r = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def generate(seed, n_orders, n_vehicles, scenario="normal"):
    rng = random.Random(seed)
    sites = [DEPOT] + [(DEPOT[0] + rng.uniform(-0.18, 0.18), DEPOT[1] + rng.uniform(-0.32, 0.32)) for _ in range(2 * n_orders)]
    n = len(sites)
    dist = [[round(haversine(sites[i], sites[j]) * ROAD_FACTOR, 3) for j in range(n)] for i in range(n)]
    time = [[int(math.ceil(dist[i][j] / SPEED_KMH * 60)) for j in range(n)] for i in range(n)]
    orders = []
    for k in range(n_orders):
        p, d = 1 + 2 * k, 2 + 2 * k
        start = rng.randrange(0, 300, 15)
        width = 90 if scenario == "tight" else 240
        orders.append({"id": f"O{k + 1:03d}", "pickup": p, "delivery": d, "weightKg": rng.choice([200, 400, 600, 800, 1200]),
                       "serviceMin": 10, "pickupWindow": [start, start + width],
                       "deliveryWindow": [start + time[p][d], start + time[p][d] + width + 120]})
    if scenario == "tight":
        for o in orders[: max(2, n_orders // 6)]:  # narrow windows that the travel time cannot meet
            o["deliveryWindow"] = [o["pickupWindow"][0], o["pickupWindow"][0] + 5]
    if scenario == "overload":
        orders[0]["weightKg"] = 9000
    vehicles = [{"id": f"V{v + 1}", "capacityKg": 3000, "shift": [0, 600], "costPerKm": 1.0, "fixedCost": 50.0} for v in range(n_vehicles)]
    return {
        "schema": "pai-logistics-problem-1", "synthetic": True,
        "label": f"synthetic road-transport instance seed={seed} orders={n_orders} vehicles={n_vehicles} scenario={scenario}",
        "units": {"distance": "km", "time": "min", "load": "kg"},
        "matrix": {"source": f"great-circle x {ROAD_FACTOR} at {SPEED_KMH:g} km/h (synthetic, not a road network)", "distanceKm": dist, "timeMin": time},
        "depot": 0, "horizonMin": 600, "vehicles": vehicles, "orders": orders,
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--orders", type=int, default=24)
    ap.add_argument("--vehicles", type=int, default=5)
    ap.add_argument("--scenario", choices=("normal", "tight", "overload"), default="normal")
    ap.add_argument("--output", required=True)
    a = ap.parse_args()
    Path(a.output).write_text(json.dumps(generate(a.seed, a.orders, a.vehicles, a.scenario)) + "\n")
