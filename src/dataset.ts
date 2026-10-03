/**
 * Solver dataset: every native solver measurement in the workspace as one row, derived from the stored records
 * (nothing is re-run or interpolated). This is the training source the roadmap names for a physics-AI surrogate
 * (PhysicsNeMo or the in-tree GP): inputs are design parameters, outputs are solver results, and each row cites the
 * record, the requirement digest and the solver versions it came from. Surrogates trained on it rank only.
 */
import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import type { CadOptimization } from "./optimize.js";
import type { CadReview } from "./cad.js";
import type { AeroReview } from "./aero.js";

export interface DatasetRow {
  domain: "structural-fea" | "aero-rans"; source: string; recordId: string; projectId: string; createdAt: string;
  inputs: Record<string, number>; outputs: Record<string, number>; solver: string; fidelity: string;
}
export function solverDataset(store: Store) {
  const rows: DatasetRow[] = [];
  for (const o of store.list<CadOptimization>("cad-optimize")) {
    for (const p of o.result?.points ?? []) {
      if (p.fidelity !== "fea" || p.deflectionMm === undefined || p.mass === undefined) continue;
      rows.push({ domain: "structural-fea", source: "cad-optimize", recordId: o.id, projectId: o.projectId, createdAt: o.createdAt,
        inputs: { thickness: p.parameters.thickness, width: p.parameters.width, plateHeight: p.parameters.plateHeight, pilotBore: p.parameters.pilotBore,
          forceN: o.request.requirements.structural!.forceN, leverMm: o.request.requirements.structural!.leverMm },
        outputs: { deflectionMm: p.deflectionMm, stressMPa: p.stressMPa ?? NaN, massG: p.mass }, solver: "Gmsh 4.15.2 C3D10 fine + CalculiX 2.21",
        fidelity: p.remote ? "fea-fine (AWS Batch)" : "fea-fine" });
    }
  }
  for (const c of store.list<CadReview>("cad-review")) {
    for (const which of ["baseline", "candidate"] as const) {
      const fea = c.fea?.[which]; const chk = c[which]; const params = (chk as { parameters?: Record<string, number> } | undefined)?.parameters;
      if (!fea || !chk || !params?.thickness) continue;
      const v = (id: string) => Number((chk.checks.find(k => k.id === id) as { observed?: number } | undefined)?.observed);
      rows.push({ domain: "structural-fea", source: "cad-review", recordId: c.id, projectId: c.projectId, createdAt: c.createdAt,
        inputs: { thickness: params.thickness, width: params.width, plateHeight: params.plateHeight, pilotBore: params.pilotBore,
          forceN: c.request.requirements.structural!.forceN, leverMm: c.request.requirements.structural!.leverMm },
        outputs: { deflectionMm: v("max-deflection"), stressMPa: v("max-stress"), massG: chk.mass }, solver: "Gmsh 4.15.2 C3D10 two-mesh + CalculiX 2.21", fidelity: "fea-two-mesh" });
    }
  }
  for (const a of store.list<AeroReview>("aero-review")) {
    for (const which of ["baseline", "candidate"] as const) {
      const chk = a[which], cfd = a.cfd?.[which];
      if (!chk || !cfd) continue;
      for (const l of cfd.levels) rows.push({ domain: "aero-rans", source: "aero-review", recordId: a.id, projectId: a.projectId, createdAt: a.createdAt,
        inputs: { ...chk.parameters, meshLevel: l.level, cells: l.cells, speedMs: 40 }, outputs: { cd: l.cd, cl: l.cl, frontalAreaM2: cfd.frontalAreaM2 },
        solver: `${chk.engine} simpleFoam k-ω SST`, fidelity: `rans-level-${l.level}${cfd.runner === "batch" ? " (AWS Batch)" : ""}` });
    }
  }
  rows.sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.recordId.localeCompare(y.recordId));
  const body = JSON.stringify(rows);
  return { schema: "pai-solver-dataset-1", rows: rows.length, byDomain: { "structural-fea": rows.filter(r => r.domain === "structural-fea").length, "aero-rans": rows.filter(r => r.domain === "aero-rans").length },
    sha256: createHash("sha256").update(body).digest("hex"), data: rows,
    note: "Native solver measurements only, derived from stored records. Use for surrogate training and calibration; surrogates rank, solvers decide." };
}
