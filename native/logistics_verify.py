"""Independent verifier for logistics plans (pai-logistics-plan-1 against pai-logistics-problem-1).

    python3 logistics_verify.py --problem problem.json --plan plan.json --output checks.json

Standard library only, and no code shared with the solver: it re-derives every arrival, load and distance from the
problem's own matrices, so a solver bug, a hand-edited plan or a model's guess cannot pass by assertion. Checks:
  routes-continuous   every route starts and ends at the depot and every reported leg uses the matrix
  each-order-once     every order is either served exactly once (one pickup + one delivery) or listed unassigned
  pickup-before-delivery   same vehicle, pickup visited first
  capacity            the load never exceeds the vehicle's capacity and never goes negative
  time-windows        recomputed earliest arrival (waiting allowed) within every stop's window and the vehicle shift
  reported-figures    reported distance, arrivals and loads equal the recomputed values (tolerance 1e-6)
  status-consistent   "feasible" only with no unassigned order; "partial" lists them; failure statuses have no routes
Each vehicle has at most one route; plan totals (distance, cost, vehicles used) are required and recomputed.
A plan with status infeasible/timeout/unknown/error passes `status-consistent` when it carries no routes, and the verdict is
then "no-plan" (not a failure of the verifier, not a feasible plan). Scope: the synthetic instance only.
"""
import argparse
import json
import resource
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--problem", required=True)
ap.add_argument("--plan", required=True)
ap.add_argument("--output", required=True)
a = ap.parse_args()
P, plan = json.loads(Path(a.problem).read_text()), json.loads(Path(a.plan).read_text())
D, T = P["matrix"]["distanceKm"], P["matrix"]["timeMin"]
orders = {o["id"]: o for o in P["orders"]}
vehicles = {v["id"]: v for v in P["vehicles"]}
problems = {k: [] for k in ("routes-continuous", "each-order-once", "pickup-before-delivery", "capacity", "time-windows",
                            "reported-figures", "status-consistent")}
status = plan.get("status")
routes = plan.get("routes") or []
unassigned = set(plan.get("unassigned") or [])
if plan.get("schema") != "pai-logistics-plan-1" or status not in {"feasible", "partial", "infeasible", "timeout", "unknown", "error"}:
    problems["status-consistent"].append("unknown plan schema or status")
served = {}
total, cost, used, seen = 0.0, 0.0, 0, set()
for r in routes:
    v = vehicles.get(r.get("vehicle"))
    stops = r.get("stops") or []
    if v is None or len(stops) < 2 or stops[0].get("location") != 0 or stops[-1].get("location") != 0:
        problems["routes-continuous"].append(f"{r.get('vehicle')}: must start and end at the depot with a known vehicle")
        continue
    if v["id"] in seen:
        problems["routes-continuous"].append(f"{v['id']}: vehicle has more than one route")
        continue
    seen.add(v["id"])
    t, load, dist, prev = v["shift"][0], 0, 0.0, 0
    if stops[0].get("arrival") != t or stops[0].get("departure") != t:
        problems["reported-figures"].append(f"{v['id']}: depot departure {stops[0].get('departure')} vs shift start {t}")
    for k, s in enumerate(stops[1:], 1):
        node = s.get("location")
        if not isinstance(node, int) or not 0 <= node < len(D):
            problems["routes-continuous"].append(f"{v['id']} stop {k}: unknown location"); break
        t += T[prev][node]; dist += D[prev][node]
        if node != 0:
            o = orders.get(s.get("order"))
            kind = s.get("kind")
            if o is None or kind not in ("pickup", "delivery") or o[kind] != node:
                problems["routes-continuous"].append(f"{v['id']} stop {k}: stop does not match its order's {kind} location"); break
            lo, hi = o["pickupWindow"] if kind == "pickup" else o["deliveryWindow"]
            t = max(t, lo)
            if t > hi:
                problems["time-windows"].append(f"{v['id']} {o['id']} {kind}: arrives {t} after window end {hi}")
            load += o["weightKg"] if kind == "pickup" else -o["weightKg"]
            if load > v["capacityKg"] or load < 0:
                problems["capacity"].append(f"{v['id']} after {o['id']} {kind}: load {load} kg (capacity {v['capacityKg']})")
            served.setdefault(o["id"], []).append((v["id"], k, kind))
            if not all(isinstance(s.get(f), (int, float)) for f in ("arrival", "departure", "loadKg")) \
                    or abs(s["arrival"] - t) > 1e-6 or abs(s["loadKg"] - load) > 1e-6 or abs(s["departure"] - t - o.get("serviceMin", 0)) > 1e-6:
                problems["reported-figures"].append(f"{v['id']} stop {k}: reported arrival/departure/load {s.get('arrival')}/{s.get('departure')}/{s.get('loadKg')} vs {t}/{t + o.get('serviceMin', 0)}/{load}")
            t += o.get("serviceMin", 0)
        elif k != len(stops) - 1:
            problems["routes-continuous"].append(f"{v['id']}: depot visited mid-route"); break
        elif s.get("arrival") != t:
            problems["reported-figures"].append(f"{v['id']}: reported return {s.get('arrival')} vs {t}")
        prev = node
    if t > v["shift"][1]:
        problems["time-windows"].append(f"{v['id']}: returns at {t} after shift end {v['shift'][1]}")
    if abs(r.get("distanceKm", -1) - round(dist, 3)) > 1e-6:
        problems["reported-figures"].append(f"{v['id']}: reported {r.get('distanceKm')} km vs {round(dist, 3)} km")
    total += dist
    if len(stops) > 2:
        used += 1
        cost += round(dist, 3) * v["costPerKm"] + v["fixedCost"]
for oid, visits in served.items():
    kinds = [k for _, _, k in visits]
    if sorted(kinds) != ["delivery", "pickup"] or len({veh for veh, _, _ in visits}) != 1:
        problems["each-order-once"].append(f"{oid}: visits {visits}")
    elif [k for _, _, k in sorted(visits, key=lambda x: x[1])] != ["pickup", "delivery"]:
        problems["pickup-before-delivery"].append(f"{oid}: delivery before pickup")
for oid in unassigned - set(orders):
    problems["each-order-once"].append(f"{oid}: unassigned id is not an order of this problem")
for oid in orders:
    if (oid in served) == (oid in unassigned):
        problems["each-order-once"].append(f"{oid}: {'both served and unassigned' if oid in served else 'neither served nor unassigned'}")
if routes or status in {"feasible", "partial"}:
    # Totals are part of the plan's claim: required, and recomputed (cost = distance x rate + fixed cost per used vehicle).
    for field, value, tol in (("totalDistanceKm", round(total, 3), 1e-3), ("totalCost", round(cost, 3), 1e-3), ("vehiclesUsed", used, 0)):
        got = plan.get(field)
        if not isinstance(got, (int, float)) or abs(got - value) > tol:
            problems["reported-figures"].append(f"{field} reported {got} vs recomputed {value}")
if status == "feasible" and unassigned:
    problems["status-consistent"].append("status feasible with unassigned orders")
if status == "partial" and not unassigned:
    problems["status-consistent"].append("status partial without unassigned orders")
if status in {"infeasible", "timeout", "unknown", "error"} and routes:
    problems["status-consistent"].append(f"status {status} must not carry routes")
checks = [{"id": k, "passed": not v, "detail": v[:10]} for k, v in problems.items()]
ok = all(c["passed"] for c in checks)
verdict = ("no-plan" if status in {"infeasible", "timeout", "unknown", "error"} else "feasible-plan" if status == "feasible" else "partial-plan") if ok else "rejected"
result = {"schema": "pai-logistics-verification-1", "verifier": "independent standard-library recomputation", "planStatus": status,
          "verdict": verdict, "checks": checks, "recomputedDistanceKm": round(total, 3), "served": len(served), "unassigned": sorted(unassigned),
          "scope": "synthetic instance; road model is the instance's matrix, not a real network", "physicalValidation": False,
          "usage": {"cpuSeconds": round(sum(resource.getrusage(resource.RUSAGE_SELF)[:2]), 3), "maxRssKb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}}
Path(a.output).write_text(json.dumps(result, indent=1) + "\n")
print(json.dumps({"verdict": verdict, "failed": [c["id"] for c in checks if not c["passed"]]}))
