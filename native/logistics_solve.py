"""Off-site (road) logistics planning: pickup-and-delivery vehicle routing with capacities and time windows.

    PAI_LOGISTICS_PYTHON logistics_solve.py --problem problem.json --output plan.json [--strategy deterministic|guided]
        [--time-limit 10] [--allow-unassigned] [--baseline]

Solver: Google OR-Tools routing (pinned in native/logistics-requirements.txt). It models capacity (kg), pickup before
delivery on the same vehicle, pickup/delivery time windows with service and waiting, vehicle shifts and a fixed cost
per used vehicle, minimising road distance plus fixed cost. It does not prove optimality; the plan's feasibility is
decided by the independent verifier (logistics_verify.py), not by this script or by any model.

Strategies:
- deterministic: parallel cheapest insertion, then local search to a local optimum. Same input, same plan (replayable).
- guided: guided local search within the time limit (better plans, but timing-dependent and not replayable).
- --baseline: a simple sequential heuristic (each order alone, pickup then delivery, first vehicle that still fits)
  used only as a comparison point; it never uses the optimiser.

Statuses: feasible (every order planned) | partial (some orders unassigned; only with --allow-unassigned) |
infeasible (the solver proved no plan, or an order is heavier than every vehicle) | timeout (no plan within the time
limit) | unknown (the search ended without a plan and without a proof) | error. Other solver states are reported as
error with the raw status, never as success.
"""
import argparse
import json
import resource
import sys
import time
from pathlib import Path

MAX_ORDERS, MAX_VEHICLES, MAX_SECONDS = 500, 100, 120

ap = argparse.ArgumentParser()
ap.add_argument("--problem", required=True)
ap.add_argument("--output", required=True)
ap.add_argument("--strategy", choices=("deterministic", "guided"), default="deterministic")
ap.add_argument("--time-limit", type=float, default=10.0)
ap.add_argument("--allow-unassigned", action="store_true")
ap.add_argument("--baseline", action="store_true")
ap.add_argument("--max-memory-mb", type=int, default=4096, help="address-space limit for this process (resource bound)")
a = ap.parse_args()
# Resource bounds: address space and CPU time (time limit + margin); the caller also enforces a wall deadline.
resource.setrlimit(resource.RLIMIT_AS, (a.max_memory_mb << 20, a.max_memory_mb << 20))
resource.setrlimit(resource.RLIMIT_CPU, (int(min(a.time_limit, MAX_SECONDS)) + 60,) * 2)
t0 = time.monotonic()
p = json.loads(Path(a.problem).read_text())
out_path = Path(a.output)


def emit(plan):
    ru = resource.getrusage(resource.RUSAGE_SELF)
    plan.update({"schema": "pai-logistics-plan-1", "problemLabel": p.get("label"), "synthetic": bool(p.get("synthetic")),
                 "seconds": round(time.monotonic() - t0, 3),
                 # Measured by this process (native compute; no model tokens are involved in solving).
                 "usage": {"cpuSeconds": round(ru.ru_utime + ru.ru_stime, 3), "maxRssKb": ru.ru_maxrss}})
    out_path.write_text(json.dumps(plan, indent=1) + "\n")
    print(json.dumps({"status": plan["status"], "routes": len(plan.get("routes", [])), "unassigned": len(plan.get("unassigned", [])),
                      "distanceKm": plan.get("totalDistanceKm"), "seconds": plan["seconds"]}), file=sys.stderr)
    sys.exit(0)


# ---------------------------------------------------------------- input bounds (fail closed, before any solving)
problems = []
if p.get("schema") != "pai-logistics-problem-1":
    problems.append("schema must be pai-logistics-problem-1")
D, T = p.get("matrix", {}).get("distanceKm"), p.get("matrix", {}).get("timeMin")
orders, vehicles = p.get("orders") or [], p.get("vehicles") or []
n = len(D or [])
if not (isinstance(D, list) and isinstance(T, list) and n == len(T) and all(len(r) == n for r in D + T)):
    problems.append("distanceKm and timeMin must be square matrices of the same size")
if not 1 <= len(orders) <= MAX_ORDERS or not 1 <= len(vehicles) <= MAX_VEHICLES:
    problems.append(f"1-{MAX_ORDERS} orders and 1-{MAX_VEHICLES} vehicles are supported")
if not 0 < a.time_limit <= MAX_SECONDS:
    problems.append(f"time limit must be in (0, {MAX_SECONDS}] s")
if not problems:
    nodes = [o["pickup"] for o in orders] + [o["delivery"] for o in orders]
    if len(set(nodes)) != len(nodes) or any(not 0 < i < n for i in nodes) or p.get("depot", 0) != 0:
        problems.append("each order needs its own pickup and delivery location (depot is index 0)")
if problems:
    emit({"status": "error", "error": "; ".join(problems), "routes": [], "unassigned": [o.get("id") for o in orders]})

cap_max = max(v["capacityKg"] for v in vehicles)
too_heavy = [o["id"] for o in orders if o["weightKg"] > cap_max]
service = {0: 0}
window = {0: (0, p.get("horizonMin", 600))}
for o in orders:
    service[o["pickup"]], service[o["delivery"]] = o.get("serviceMin", 0), o.get("serviceMin", 0)
    window[o["pickup"]], window[o["delivery"]] = tuple(o["pickupWindow"]), tuple(o["deliveryWindow"])


def route_record(vehicle, seq):
    """Stops with arrival (after waiting), departure and load, from the matrices; used by both solver and baseline."""
    stops, t, load, prev, dist = [], vehicle["shift"][0], 0, 0, 0.0
    stops.append({"location": 0, "kind": "depot", "arrival": t, "departure": t, "loadKg": 0})
    for node, order, kind in seq:
        t += T[prev][node]; dist += D[prev][node]
        t = max(t, window[node][0])
        load += order["weightKg"] if kind == "pickup" else -order["weightKg"]
        stops.append({"location": node, "order": order["id"], "kind": kind, "arrival": t, "departure": t + service[node], "loadKg": load})
        t += service[node]; prev = node
    t += T[prev][0]; dist += D[prev][0]
    stops.append({"location": 0, "kind": "depot", "arrival": t, "departure": t, "loadKg": load})
    return {"vehicle": vehicle["id"], "stops": stops, "distanceKm": round(dist, 3), "durationMin": t - vehicle["shift"][0]}


def summary(routes, unassigned, extra):
    used = [r for r in routes if len(r["stops"]) > 2]
    vcost = {v["id"]: v for v in vehicles}
    cost = sum(r["distanceKm"] * vcost[r["vehicle"]]["costPerKm"] + vcost[r["vehicle"]]["fixedCost"] for r in used)
    return {"routes": used, "unassigned": unassigned, "vehiclesUsed": len(used), "totalDistanceKm": round(sum(r["distanceKm"] for r in used), 3),
            "totalCost": round(cost, 3), **extra}


# ---------------------------------------------------------------- baseline (comparison only)
if a.baseline:
    routes, unassigned, vi = [], [], 0
    seqs = {v["id"]: [] for v in vehicles}
    for o in orders:
        placed = False
        for v in vehicles:
            trial = seqs[v["id"]] + [(o["pickup"], o, "pickup"), (o["delivery"], o, "delivery")]
            r = route_record(v, trial)
            ok = all(s["arrival"] <= window[s["location"]][1] for s in r["stops"][1:-1]) and r["stops"][-1]["arrival"] <= v["shift"][1] \
                and o["weightKg"] <= v["capacityKg"]
            if ok:
                seqs[v["id"]] = trial; placed = True; break
        if not placed:
            unassigned.append(o["id"])
    routes = [route_record(v, seqs[v["id"]]) for v in vehicles]
    # A heuristic cannot prove infeasibility: orders it could not place make the plan partial, never "infeasible".
    status = "feasible" if not unassigned else "partial"
    emit({"status": status, **summary(routes, unassigned, {"solver": {"name": "sequential-baseline", "strategy": "baseline"}})})

# ---------------------------------------------------------------- OR-Tools routing
if too_heavy and not a.allow_unassigned:
    emit({"status": "infeasible", "reason": f"orders heavier than any vehicle: {', '.join(too_heavy)}", "routes": [], "unassigned": [o["id"] for o in orders],
          "solver": {"name": "ortools", "strategy": a.strategy, "proof": "input check: weight > max capacity"}})

import ortools  # noqa: E402
from ortools.constraint_solver import pywrapcp, routing_enums_pb2  # noqa: E402

manager = pywrapcp.RoutingIndexManager(n, len(vehicles), 0)
routing = pywrapcp.RoutingModel(manager)
# Objective in milli cost units: distance x the vehicle's own rate, plus its fixed cost when used.
for v, veh in enumerate(vehicles):
    rate = veh["costPerKm"]
    cb = routing.RegisterTransitCallback(lambda i, j, rate=rate: int(round(D[manager.IndexToNode(i)][manager.IndexToNode(j)] * rate * 1000)))
    routing.SetArcCostEvaluatorOfVehicle(cb, v)
    routing.SetFixedCostOfVehicle(int(round(veh["fixedCost"] * 1000)), v)
time_cb = routing.RegisterTransitCallback(lambda i, j: T[manager.IndexToNode(i)][manager.IndexToNode(j)] + service.get(manager.IndexToNode(i), 0))
horizon = max([v["shift"][1] for v in vehicles] + [w[1] for w in window.values()])
routing.AddDimension(time_cb, horizon, horizon, False, "Time")
tdim = routing.GetDimensionOrDie("Time")
for node, (lo, hi) in window.items():
    if node == 0:
        continue
    tdim.CumulVar(manager.NodeToIndex(node)).SetRange(int(lo), int(hi))
for v, veh in enumerate(vehicles):
    tdim.CumulVar(routing.Start(v)).SetRange(*map(int, veh["shift"]))
    tdim.CumulVar(routing.End(v)).SetRange(*map(int, veh["shift"]))
demand = {0: 0}
for o in orders:
    demand[o["pickup"]], demand[o["delivery"]] = o["weightKg"], -o["weightKg"]
load_cb = routing.RegisterUnaryTransitCallback(lambda i: demand.get(manager.IndexToNode(i), 0))
routing.AddDimensionWithVehicleCapacity(load_cb, 0, [int(v["capacityKg"]) for v in vehicles], True, "Load")
for o in orders:
    pi, di = manager.NodeToIndex(o["pickup"]), manager.NodeToIndex(o["delivery"])
    routing.AddPickupAndDelivery(pi, di)
    routing.solver().Add(routing.VehicleVar(pi) == routing.VehicleVar(di))
    routing.solver().Add(tdim.CumulVar(pi) <= tdim.CumulVar(di))
    if a.allow_unassigned:
        routing.AddDisjunction([pi], 10_000_000)  # 10 000 km equivalent: drop only when it cannot be served
        routing.AddDisjunction([di], 10_000_000)
params = pywrapcp.DefaultRoutingSearchParameters()
params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
params.time_limit.FromMilliseconds(int(a.time_limit * 1000))
if a.strategy == "guided":
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
t_solve = time.monotonic()
solution = routing.SolveWithParameters(params)
t_solve = time.monotonic() - t_solve
raw = routing_enums_pb2.RoutingSearchStatus.Value.Name(routing.status())
solver = {"name": "ortools", "version": ortools.__version__, "strategy": a.strategy, "timeLimitSeconds": a.time_limit,
          "rawStatus": raw, "objective": solution.ObjectiveValue() if solution else None,
          "optimality": "not proven" if raw != "ROUTING_OPTIMAL" else "proven by the solver",
          # Replayable only when the deterministic search ended at its local optimum, not at the time limit.
          "replayable": a.strategy == "deterministic" and raw in ("ROUTING_SUCCESS", "ROUTING_OPTIMAL")}
if solution is None:
    # Only a proof is "infeasible". "No solution found" is "timeout" when the search used up its time limit (OR-Tools
    # reports ROUTING_FAIL or ROUTING_FAIL_TIMEOUT depending on where the limit hit), otherwise "unknown".
    hit_limit = raw == "ROUTING_FAIL_TIMEOUT" or (raw == "ROUTING_FAIL" and t_solve >= 0.95 * a.time_limit)
    status = "timeout" if hit_limit else {"ROUTING_INFEASIBLE": "infeasible", "ROUTING_FAIL": "unknown"}.get(raw, "error")
    solver["searchSeconds"] = round(t_solve, 3)
    emit({"status": status, "reason": f"solver returned {raw} without a plan", "routes": [], "unassigned": [o["id"] for o in orders], "solver": solver})
by_node = {}
for o in orders:
    by_node[o["pickup"]], by_node[o["delivery"]] = (o, "pickup"), (o, "delivery")
routes, served = [], set()
for v, veh in enumerate(vehicles):
    seq, idx = [], routing.NextVar(routing.Start(v))
    idx = solution.Value(routing.NextVar(routing.Start(v)))
    while not routing.IsEnd(idx):
        node = manager.IndexToNode(idx)
        order, kind = by_node[node]
        seq.append((node, order, kind)); served.add(order["id"])
        idx = solution.Value(routing.NextVar(idx))
    routes.append(route_record(veh, seq))
unassigned = [o["id"] for o in orders if o["id"] not in served]
status = "feasible" if not unassigned else "partial"
emit({"status": status, **summary(routes, unassigned, {"solver": solver})})
