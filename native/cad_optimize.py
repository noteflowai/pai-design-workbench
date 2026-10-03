"""Physics-aware design optimisation of the NEMA 17 bracket. A surrogate ranks candidates; native solvers decide.

Run with the pinned physics interpreter. Each *measured* point is the trusted recipe built by CadQuery
(native/cad_point.py, B-Rep checks) and solved by Gmsh + CalculiX (native/fea_bracket.py, fine mesh).

1. Initial design: scrambled Sobol points (Optuna QMC) plus up to four seeds proposed by an AI planner. A seed's
   own physics estimate is kept, so the planner's physical intuition can be scored against the solver.
2. Each round:
   - Fit Gaussian-process surrogates (scikit-learn, Matérn 5/2 + noise) on the measured points for log
     deflection, log stress, mass, minimum wall and hole-edge distance.
   - Search the surrogate with Optuna NSGA-II (mass ↓, feasibility margin ↑).
   - Pick the lightest candidates whose deflection is feasible at mean + 1σ (exploit), plus the most uncertain
     near-feasible candidate (explore), and measure them natively.
   - Before each measurement, record the surrogate's prediction, so calibration is reported honestly.
   Strategy "botorch-qlognehvi" replaces the NSGA-II step with BoTorch: independent SingleTaskGPs (ModelListGP) on
   the same targets, and a batch of `perRound` candidates that maximises qLogNoisyExpectedHypervolumeImprovement
   (mass ↓, log deflection ↓) with the stress / wall / hole-edge / deflection limits as outcome constraints and the
   envelope as linear input constraints (Daulton et al. 2021; Ament et al. 2023). Screening, measurement and
   calibration are identical, so the two strategies are directly comparable.
3. The recommendation is the lightest *measured* feasible point. Predictions are never evidence; a chosen point
   becomes an ordinary parametric review, which solves both meshes and runs EvalArc.
"""
import argparse
import json
import math
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import optuna
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import ConstantKernel, Matern, WhiteKernel

optuna.logging.set_verbosity(optuna.logging.WARNING)
HERE = Path(__file__).resolve().parent
BOUNDS = {"thickness": (2.0, 8.0), "width": (46.0, 80.0), "plateHeight": (40.0, 60.0)}
AXES = list(BOUNDS)
PILOT_BORE = 22.5

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
spec = json.loads(Path(args.input).read_text())
out = Path(args.output)
(out / "points").mkdir(parents=True, exist_ok=True)
req, budget = spec["requirements"], spec["budget"]
structural = req["structural"]
allowable = 276.0 / structural["safetyFactor"]
limit = {"deflection": structural["maxDeflectionMm"], "stress": allowable, "mass": req["maxMassG"], "wall": req["minWallMm"]}
rng_seed = int(spec.get("seed", 7))
STRATEGY = spec.get("strategy", "gp-nsga2")
if STRATEGY not in ("gp-nsga2", "botorch-qlognehvi"):
    raise SystemExit(f"unknown strategy {STRATEGY}")


def event(payload):
    print("PAI_EVENT " + json.dumps(payload, sort_keys=True), flush=True)


def snap(p):
    return {k: round(min(max(float(p[k]), BOUNDS[k][0]), BOUNDS[k][1]), 2) for k in AXES}


points = []


def geometry(folder, params):
    (folder / "geometry-input.json").write_text(json.dumps({"parameters": params, "requirements": {k: v for k, v in req.items() if k != "structural"}}))
    g = subprocess.run([spec["cadquery"], "-I", "-W", "ignore", str(HERE / "cad_point.py"), "--input", str(folder / "geometry-input.json"), "--output", str(folder)],
                       capture_output=True, text=True, timeout=300)
    if g.returncode != 0:
        raise RuntimeError(f"geometry: {g.stderr.strip().splitlines()[-1][:200] if g.stderr.strip() else g.returncode}")
    return json.loads((folder / "point.json").read_text())


def measure(index, params, origin, prediction=None, estimate=None, geometry_only=False, folder=None):
    folder = folder or out / "points" / f"{index:02d}"
    folder.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    params = {**snap(params), "pilotBore": PILOT_BORE}
    point = {"index": index, "origin": origin, "parameters": params, **({"prediction": prediction} if prediction else {}),
             **({"estimate": estimate} if estimate else {})}
    try:
        geo = geometry(folder, params)
        geo_failed = [c["id"] for c in geo["checks"] if not c["passed"]]
        if geometry_only or geo_failed and origin == "screen":
            # Multi-fidelity: a candidate that already fails a cheap B-Rep check is not worth a solver run.
            point.update({"mass": geo["mass"], "checks": geo["checks"], "failed": geo_failed, "fidelity": "geometry",
                          "minWallMm": next(c["observed"] for c in geo["checks"] if c["id"] == "min-wall"),
                          "holeEdgeMm": next(c["observed"] for c in geo["checks"] if c["id"] == "hole-edge-distance")})
            point["feasible"] = False if geo_failed else None
            point["seconds"] = round(time.monotonic() - started, 1)
            event({"type": "point", "index": index, "origin": origin, "parameters": params, "mass": point["mass"], "failed": geo_failed, "fidelity": "geometry"})
            return point
        (folder / "fea-input.json").write_text(json.dumps({"step": str(folder / "part.step"), "parameters": geo["parameters"], "ccx": spec["ccx"],
            "meshes": "fine-only", "requirements": structural, "load": {"forceN": structural["forceN"], "leverMm": structural["leverMm"]}}))
        f = subprocess.run([sys.executable, "-I", str(HERE / "fea_bracket.py"), "--input", str(folder / "fea-input.json"), "--output", str(folder)],
                           capture_output=True, text=True, timeout=1200)
        if f.returncode != 0:
            raise RuntimeError(f"fea: {f.stderr.strip().splitlines()[-1][:200] if f.stderr.strip() else f.returncode}")
        fea = json.loads((folder / "fea.json").read_text())
        checks = geo["checks"] + [{k: c[k] for k in ("id", "passed", "observed", "required")} for c in fea["checks"]]
        get = lambda cid: next(c["observed"] for c in checks if c["id"] == cid)
        point.update({"mass": geo["mass"], "checks": checks, "failed": [c["id"] for c in checks if not c["passed"]], "fidelity": "fea",
                      "deflectionMm": get("max-deflection"), "stressMPa": get("max-stress"), "minWallMm": get("min-wall"),
                      "holeEdgeMm": get("hole-edge-distance"), "elements": fea["meshes"]["fine"]["elements"]})
    except Exception as e:  # noqa: BLE001 — a degenerate point is a measured outcome, not an optimiser failure
        point.update({"error": f"{type(e).__name__}: {str(e)[:240]}", "failed": ["build"]})
    point["feasible"] = not point["failed"]
    if "error" in point:
        point["fidelity"] = "failed"
    point["seconds"] = round(time.monotonic() - started, 1)
    event({"type": "point", "index": index, "origin": origin, "parameters": params, "mass": point.get("mass"),
           "deflectionMm": point.get("deflectionMm"), "failed": point["failed"]})
    return point


def run_batch(batch):
    with ThreadPoolExecutor(max_workers=int(spec.get("parallel", 2))) as pool:
        return list(pool.map(lambda b: measure(*b), batch))


# ---------------------------------------------------------------- initial design
initial = []
# The frozen reference design is always measured first: every search starts from the known baseline.
if spec.get("includeReference", True):
    initial.append(({"thickness": 4.0, "width": 60.0, "plateHeight": 46.0}, "reference", None, None))
for seed in spec.get("seeds", [])[:4]:
    initial.append(({k: seed["parameters"][k] for k in AXES}, "ai-seed", None, {k: seed[k] for k in ("expectedDeflectionMm", "expectedMassG", "rationale") if k in seed}))
qmc = optuna.samplers.QMCSampler(qmc_type="sobol", scramble=True, seed=rng_seed)
study = optuna.create_study(sampler=qmc)
while len(initial) < budget["initial"]:
    trial = study.ask({k: optuna.distributions.FloatDistribution(*BOUNDS[k]) for k in AXES})
    initial.append((trial.params, "initial", None, None))
    study.tell(trial, 0.0)
event({"type": "phase", "phase": "initial", "points": len(initial)})
points += run_batch([(i + 1, *x) for i, x in enumerate(initial)])

# Multi-fidelity prior for the BoTorch strategy: B-Rep checks cost seconds, a CalculiX solve minutes. A Sobol layer of
# geometry-only screens teaches the wall / hole-edge / mass GPs the recipe's feasible region before any acquisition.
if STRATEGY == "botorch-qlognehvi":
    cheap = []
    for _ in range(int(spec.get("geometryPrior", 12))):
        trial = study.ask({k: optuna.distributions.FloatDistribution(*BOUNDS[k]) for k in AXES})
        cheap.append(trial.params); study.tell(trial, 0.0)
    base = len(points)
    with ThreadPoolExecutor(max_workers=int(spec.get("parallel", 2))) as pool:
        prior = list(pool.map(lambda ix: measure(base + ix[0] + 1, ix[1], "screen", geometry_only=True, folder=out / "screen" / f"prior-{ix[0] + 1}"), enumerate(cheap)))
    points += prior
    event({"type": "phase", "phase": "geometry-prior", "points": len(prior)})

# ---------------------------------------------------------------- surrogate rounds
lo, hi = np.array([BOUNDS[k][0] for k in AXES]), np.array([BOUNDS[k][1] for k in AXES])
norm = lambda p: (np.array([p[k] for k in AXES]) - lo) / (hi - lo)
TARGETS = {"logDeflection": lambda p: math.log(p["deflectionMm"]), "logStress": lambda p: math.log(p["stressMPa"]),
           "mass": lambda p: p["mass"], "minWall": lambda p: p["minWallMm"], "holeEdge": lambda p: p["holeEdgeMm"]}


GEOMETRY_TARGETS = {"mass", "minWall", "holeEdge"}


def fit():
    models, loo = {}, {}
    for name, f in TARGETS.items():
        ok = [p for p in points if ("minWallMm" in p if name in GEOMETRY_TARGETS else "deflectionMm" in p)]
        X = np.array([norm(p["parameters"]) for p in ok])
        y = np.array([f(p) for p in ok])
        kernel = ConstantKernel(1.0, (1e-3, 1e3)) * Matern(length_scale=[0.5] * len(AXES), length_scale_bounds=(0.05, 20), nu=2.5) + WhiteKernel(1e-4, (1e-8, 1e-1))
        gp = GaussianProcessRegressor(kernel=kernel, normalize_y=True, n_restarts_optimizer=3, random_state=rng_seed).fit(X, y)
        models[name] = gp
        # Leave-one-out error with the fitted kernel: how far to trust the ranking this round.
        errs = []
        for i in range(len(ok)):
            m = np.ones(len(ok), bool); m[i] = False
            g = GaussianProcessRegressor(kernel=gp.kernel_, optimizer=None, normalize_y=True).fit(X[m], y[m])
            errs.append(abs(g.predict(X[i:i + 1])[0] - y[i]))
        loo[name] = round(float(np.mean(errs)), 4)
    return models, loo, sum(1 for p in points if "deflectionMm" in p)


def predict(models, params):
    x = norm(params).reshape(1, -1)
    out = {}
    for name, gp in models.items():
        mu, sd = gp.predict(x, return_std=True)
        out[name] = (float(mu[0]), float(sd[0]))
    return out


def envelope_ok(p):
    w, h = p["width"], p["thickness"] + p["plateHeight"]
    e = req["maxEnvelopeMm"]
    return w <= e[0] and 30.0 <= e[1] and h <= e[2]


def bo_candidates(r, q, pending=()):
    """One BoTorch batch on the measured points; returns [(params, prediction)] in the unit cube's original units."""
    import torch
    from botorch.acquisition.multi_objective.logei import qLogNoisyExpectedHypervolumeImprovement
    from botorch.acquisition.multi_objective.objective import WeightedMCMultiOutputObjective
    from botorch.fit import fit_gpytorch_mll
    from botorch.models import ModelListGP, SingleTaskGP
    from botorch.models.transforms.outcome import Standardize
    from botorch.optim import optimize_acqf
    from botorch.sampling import SobolQMCNormalSampler
    from gpytorch.mlls import SumMarginalLogLikelihood
    torch.manual_seed(rng_seed + r)
    dt = torch.double
    names = ["mass", "logDeflection", "logStress", "minWall", "holeEdge"]
    models = []
    for name in names:
        ok = [p for p in points if ("minWallMm" in p if name in GEOMETRY_TARGETS else "deflectionMm" in p)]
        X = [norm(p["parameters"]) for p in ok]
        Y = [[TARGETS[name](p)] for p in ok]
        # A recipe build failure is an infeasible observation: zero wall and zero hole-edge distance, so the
        # acquisition learns to leave that region (ranking only; the failure itself is the recorded evidence).
        if name in ("minWall", "holeEdge"):
            for p in points:
                if p.get("fidelity") == "failed":
                    X.append(norm(p["parameters"])); Y.append([0.0])
        X = torch.tensor(np.array(X), dtype=dt)
        Y = torch.tensor(Y, dtype=dt)
        models.append(SingleTaskGP(X, Y, outcome_transform=Standardize(m=1)))
    model = ModelListGP(*models)
    fit_gpytorch_mll(SumMarginalLogLikelihood(model.likelihood, model))
    solved = [p for p in points if "deflectionMm" in p]
    X_base = torch.tensor(np.array([norm(p["parameters"]) for p in solved]), dtype=dt)
    edge_min = req["edgeDistanceFactor"] * 5.5
    # Outcome constraints, feasible when ≤ 0 (sample tensors are ... × q × m in the order of `names`).
    constraints = [lambda Y: Y[..., 1] - math.log(limit["deflection"]), lambda Y: Y[..., 2] - math.log(limit["stress"]),
                   lambda Y: limit["wall"] - Y[..., 3], lambda Y: edge_min - Y[..., 4], lambda Y: Y[..., 0] - limit["mass"]]
    acqf = qLogNoisyExpectedHypervolumeImprovement(
        model=model, ref_point=[-limit["mass"], -math.log(limit["deflection"])], X_baseline=X_base, prune_baseline=True,
        objective=WeightedMCMultiOutputObjective(weights=torch.tensor([-1.0, -1.0], dtype=dt), outcomes=[0, 1]),
        constraints=constraints, sampler=SobolQMCNormalSampler(sample_shape=torch.Size([128]), seed=rng_seed + r),
        X_pending=torch.tensor(np.array([norm(p) for p in pending]), dtype=dt) if pending else None)
    # Envelope as linear constraints on normalised inputs: width ≤ e0 and thickness + plateHeight ≤ e2.
    e = req["maxEnvelopeMm"]; span = hi - lo
    ineq = [(torch.tensor([1]), torch.tensor([-span[1]], dtype=dt), float(lo[1] - e[0])),
            (torch.tensor([0, 2]), torch.tensor([-span[0], -span[2]], dtype=dt), float(lo[0] + lo[2] - e[2]))]
    bounds = torch.stack([torch.zeros(3, dtype=dt), torch.ones(3, dtype=dt)])
    cand, _ = optimize_acqf(acqf, bounds=bounds, q=q, num_restarts=8, raw_samples=256, sequential=True, inequality_constraints=ineq,
                            options={"batch_limit": 8, "maxiter": 200})
    with torch.no_grad():
        post = model.posterior(cand)
        mu, sd = post.mean.numpy(), post.variance.clamp_min(0).sqrt().numpy()
    out = []
    for x, m, v in zip(cand.numpy(), mu, sd):
        params = {k: float(lo[i] + x[i] * span[i]) for i, k in enumerate(AXES)}
        out.append((params, {"deflectionMm": round(math.exp(m[1]), 4), "deflectionSigmaLog": round(float(v[1]), 4),
                             "stressMPa": round(math.exp(m[2]), 1), "massG": round(float(m[0]), 2)}))
    return out, len(solved)


rounds = []
next_index = len(points) + 1
for r in range(1, budget["rounds"] + 1):
    models, loo, n = fit()  # scikit-learn GPs: leave-one-out error is reported for both strategies
    if STRATEGY == "botorch-qlognehvi":
        # Acquire, screen the B-Rep cheaply, and re-acquire after each geometry failure: the failed screen is a
        # measured point, so the geometry GPs learn from it before the next proposal (same screen budget as NSGA-II).
        batch, screened, n, proposals = [], 0, 0, 0
        while len(batch) < budget["perRound"] and screened < int(spec.get("screenPerRound", 6)):
            cands, n = bo_candidates(r + 100 * proposals, budget["perRound"] - len(batch), pending=[b[1] for b in batch])
            proposals += 1
            progressed = False
            for params, prediction in cands:
                if screened >= int(spec.get("screenPerRound", 6)):
                    break
                if min(np.linalg.norm(norm(params) - norm(p["parameters"])) for p in points) <= 0.02 or any(np.linalg.norm(norm(params) - norm(b[1])) <= 0.02 for b in batch):
                    continue  # already measured or chosen: the acquisition is not paid twice for one design
                screened += 1; progressed = True
                screen = measure(next_index, params, "screen", geometry_only=True, folder=out / "screen" / f"r{r}-{screened}")
                if screen["feasible"] is None:
                    batch.append((next_index, params, "bo", prediction, None))
                else:
                    points.append(screen)
                    next_index += 1
                    break  # refit on the new geometry evidence before proposing again
                next_index += 1
            if not progressed:
                break
        event({"type": "phase", "phase": f"round-{r}", "points": len(batch), "trainedOn": n})
        new = run_batch(batch)
        points += new
        rounds.append({"round": r, "trainedOn": n, "looMeanAbsError": loo, "surrogateTrials": len(cands),
                       "screenedGeometry": screened, "proposed": [p["index"] for p in new]})
        continue
    edge_min = req["edgeDistanceFactor"] * 5.5

    def objective(trial):
        p = {k: trial.suggest_float(k, *BOUNDS[k]) for k in AXES}
        pr = predict(models, p)
        # Constraint margins at mean + 1σ (conservative for "≤" limits, mean − 1σ for "≥" limits).
        c = [pr["logDeflection"][0] + pr["logDeflection"][1] - math.log(limit["deflection"]),
             pr["logStress"][0] + pr["logStress"][1] - math.log(limit["stress"]),
             limit["wall"] - (pr["minWall"][0] - pr["minWall"][1]), edge_min - (pr["holeEdge"][0] - pr["holeEdge"][1]),
             pr["mass"][0] - limit["mass"], 0.0 if envelope_ok(p) else 1.0]
        trial.set_user_attr("constraints", c)
        trial.set_user_attr("prediction", pr)
        return pr["mass"][0], pr["logDeflection"][0]

    search = optuna.create_study(directions=["minimize", "minimize"],
                                 sampler=optuna.samplers.NSGAIISampler(population_size=40, seed=rng_seed + r, constraints_func=lambda t: t.user_attrs["constraints"]))
    search.optimize(objective, n_trials=int(spec.get("surrogateTrials", 600)))
    measured = [norm(p["parameters"]) for p in points]
    broken = [norm(p["parameters"]) for p in points if p.get("fidelity") == "failed"]
    distinct = lambda p: (min(np.linalg.norm(norm(p) - m) for m in measured + chosen_x) > 0.04
                          and all(np.linalg.norm(norm(p) - b) > 0.08 for b in broken))  # keep clear of recipe build failures
    feasible = sorted((t for t in search.trials if all(v <= 0 for v in t.user_attrs["constraints"])), key=lambda t: t.values[0])
    chosen, chosen_x, screened = [], [], 0
    for t in feasible:
        if len(chosen) >= budget["perRound"] - 1 or screened >= int(spec.get("screenPerRound", 6)):
            break
        if not distinct(t.params):
            continue
        # Cheap native B-Rep screen first; only geometry-feasible candidates are solved.
        screened += 1
        screen = measure(next_index, t.params, "screen", geometry_only=True, folder=out / "screen" / f"r{r}-{screened}")
        measured.append(norm(t.params))
        if screen["feasible"] is None:  # geometry passes: solve it below as a full point
            chosen.append((t.params, "exploit", t)); chosen_x.append(norm(t.params))
        else:  # a geometry failure (or a build failure) is a measured, recorded outcome
            points.append(screen); next_index += 1
            if screen.get("fidelity") == "failed":
                broken.append(norm(t.params))
    near = sorted((t for t in search.trials if t.user_attrs["constraints"][0] <= 0.3 and envelope_ok(t.params) and distinct(t.params)),
                  key=lambda t: -t.user_attrs["prediction"]["logDeflection"][1])
    if near:
        chosen.append((near[0].params, "explore", near[0]))
    batch = []
    for params, origin, t in chosen:
        pr = t.user_attrs["prediction"]
        batch.append((next_index, params, origin, {"deflectionMm": round(math.exp(pr["logDeflection"][0]), 4), "deflectionSigmaLog": round(pr["logDeflection"][1], 4),
                                                   "stressMPa": round(math.exp(pr["logStress"][0]), 1), "massG": round(pr["mass"][0], 2)}, None))
        next_index += 1
    event({"type": "phase", "phase": f"round-{r}", "points": len(batch), "trainedOn": n})
    new = run_batch(batch)
    points += new
    rounds.append({"round": r, "trainedOn": n, "looMeanAbsError": loo, "surrogateTrials": len(search.trials),
                   "screenedGeometry": screened, "proposed": [p["index"] for p in new]})

# ---------------------------------------------------------------- results (measured points only)
feasible = sorted((p for p in points if p["feasible"]), key=lambda p: (p["mass"], p["index"]))
front = [p["index"] for p in feasible if not any(q is not p and q["mass"] <= p["mass"] and q["deflectionMm"] <= p["deflectionMm"]
                                                  and (q["mass"] < p["mass"] or q["deflectionMm"] < p["deflectionMm"]) for q in feasible)]
calibration = [{"index": p["index"], "predicted": p["prediction"]["deflectionMm"], "measured": p["deflectionMm"],
                "relativeError": round(abs(p["prediction"]["deflectionMm"] - p["deflectionMm"]) / p["deflectionMm"], 4)}
               for p in points if p.get("prediction") and "deflectionMm" in p]
ai = [{"index": p["index"], "expected": p["estimate"].get("expectedDeflectionMm"), "measured": p.get("deflectionMm"),
       "relativeError": round(abs(p["estimate"]["expectedDeflectionMm"] - p["deflectionMm"]) / p["deflectionMm"], 4)
       if p["estimate"].get("expectedDeflectionMm") and "deflectionMm" in p else None} for p in points if p.get("estimate")]
if STRATEGY == "botorch-qlognehvi":
    import botorch
    surrogate_text = f"BoTorch {botorch.__version__} ModelListGP (SingleTaskGP per target, standardised)"
    search_text = "qLogNoisyExpectedHypervolumeImprovement (mass, log deflection) with outcome and linear envelope constraints"
else:
    surrogate_text, search_text = "GaussianProcessRegressor (Matérn 5/2 + white noise), scikit-learn", "NSGA-II on the surrogate, constraints at mean ± 1σ"
result = {"schema": "pai-cad-optimize-1", "optuna": optuna.__version__, "strategy": STRATEGY, "surrogate": surrogate_text,
          "search": search_text, "requirements": req, "budget": budget, "axes": AXES, "bounds": BOUNDS,
          "points": points, "rounds": rounds, "feasibleCount": len(feasible), "lightestFeasible": feasible[0]["index"] if feasible else None,
          "pareto": front, "calibration": calibration, "aiSeeds": ai,
          "scope": "parametric-part-geometry-and-linear-static-fea", "physicalValidation": False,
          "limits": "Measured points are evidence; surrogate predictions only rank candidates. Fine-mesh screening; the chosen point is re-verified by a formal review (two meshes, EvalArc)."}
(out / "optimize.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({"points": len(points), "feasible": len(feasible), "lightest": result["lightestFeasible"], "pareto": front}), file=sys.stderr)
