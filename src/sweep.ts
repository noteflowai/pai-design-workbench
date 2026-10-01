import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { command, writePrivate } from "./adapters.js";
import type { Config } from "./config.js";
import { Id, type Project, type Receipt } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import type { Store } from "./store.js";
import type { LiveBus } from "./live.js";
import { CadParameters, CadRequirements, type CadRequirements as CadReq } from "./cad.js";

/**
 * Native design-space sweep: every grid point of the trusted bracket recipe is built and measured on its own B-Rep
 * with the same checks as a review. The sweep ranks measured points; it accepts nothing. A chosen point becomes a
 * normal "parametric" CAD review (baseline, EvalArc, feedback, release gate) with provenance to this sweep.
 */
export const MAX_SWEEP_POINTS = 36;
const axis = (schema: z.ZodNumber) => z.array(schema).min(1).max(8);
const P = CadParameters.shape;
export const SweepGrid = z.object({
  thickness: axis(P.thickness), width: axis(P.width), plateHeight: axis(P.plateHeight), pilotBore: axis(P.pilotBore),
}).strict().refine(g => Object.values(g).reduce((n, v) => n * new Set(v).size, 1) <= MAX_SWEEP_POINTS, { message: `grid must have at most ${MAX_SWEEP_POINTS} points` });
export type SweepGrid = z.infer<typeof SweepGrid>;
export const SweepRequest = z.object({ requestId: Id, projectRevision: z.number().int().positive(), requirements: CadRequirements, grid: SweepGrid }).strict();
export const DEFAULT_SWEEP_GRID: SweepGrid = { thickness: [2.5, 3, 3.5, 4], width: [50, 55, 60], plateHeight: [43.5, 46], pilotBore: [22.5] };

const Point = z.object({
  index: z.number().int(), parameters: CadParameters, feasible: z.boolean(), failed: z.array(z.string()), seconds: z.number(),
  mass: z.number().optional(), volume: z.number().optional(), boundingBox: z.array(z.number()).length(3).optional(), error: z.string().optional(),
  checks: z.array(z.object({ id: z.string(), passed: z.boolean(), observed: z.unknown(), required: z.unknown() })).optional(),
}).strict();
export const SweepResult = z.object({
  schema: z.literal("pai-cad-sweep-1"), cadquery: z.string(), ocp: z.string(), units: z.literal("mm"), material: z.string(), axes: z.array(z.string()),
  grid: z.record(z.string(), z.array(z.number())), requirements: CadRequirements, points: z.array(Point).min(1).max(MAX_SWEEP_POINTS),
  feasibleCount: z.number().int(), lightestFeasible: z.number().int().nullable(), scope: z.literal("parametric-part-geometry"), physicalValidation: z.literal(false), limits: z.string(),
}).strict();
export type SweepPoint = z.infer<typeof Point>;
export interface CadSweep {
  id: string; projectId: string; projectRevision: number; request: z.infer<typeof SweepRequest>; requirementDigest: string;
  state: "running" | "completed" | "failed" | "interrupted"; error?: string; createdAt: string; finishedAt?: string;
  total: number; result?: z.infer<typeof SweepResult>; receipts: Receipt[]; sourceDigests: Record<string, string>; files: Record<string, string>;
  /** Pareto set over (mass ↓, min-wall margin ↑) among feasible points; exploration aid only. */
  pareto?: number[];
  scope: "parametric-part-geometry"; physicalValidation: false;
}

export function paretoFront(points: SweepPoint[], minWall: number): number[] {
  const feasible = points.filter(p => p.feasible && typeof p.mass === "number");
  const margin = (p: SweepPoint) => Number(p.checks?.find(c => c.id === "min-wall")?.observed ?? 0) - minWall;
  return feasible.filter(a => !feasible.some(b => b !== a && b.mass! <= a.mass! && margin(b) >= margin(a) && (b.mass! < a.mass! || margin(b) > margin(a))))
    .sort((a, b) => a.mass! - b.mass!).map(p => p.index);
}

export async function sweepCad(store: Store, config: Config, project: Project, input: unknown, live?: LiveBus): Promise<CadSweep> {
  const request = SweepRequest.parse(input);
  if (!config.cadquery) throw new DomainError("CAD_NOT_CONFIGURED", "Set PAI_CADQUERY_PYTHON to a pinned CadQuery interpreter (npm run setup:cad)", 503);
  const total = Object.values(request.grid).reduce((n, v) => n * new Set(v).size, 1);
  const record: CadSweep = { id: randomUUID(), projectId: project.id, projectRevision: request.projectRevision, request,
    requirementDigest: sha256(canonical({ projectRequirements: project.requirements, cadRequirements: request.requirements })),
    state: "running", createdAt: new Date().toISOString(), total, receipts: [], sourceDigests: {}, files: {}, scope: "parametric-part-geometry", physicalValidation: false };
  const claimed = store.claim(request.requestId, sha256(canonical({ kind: "cad-sweep", projectId: project.id, request })), record, "cad-sweep");
  if (claimed !== record.id) return store.get<CadSweep>("cad-sweep", claimed)!;
  const publish = (event: Parameters<LiveBus["publish"]>[1]) => live?.publish(request.requestId, event);
  publish({ kind: "record", recordKind: "cad-sweep", recordId: record.id });
  const directory = join(config.state, "cad-sweep", record.id);
  try {
    if (project.revision !== request.projectRevision) throw new DomainError("REVISION_CONFLICT", "Freeze the current requirement revision");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const native = (f: string) => join(config.repository, "native", f);
    const scripts = ["cad_sweep.py", "cad_recipe.py", "cad_checks.py"];
    const digests = async () => Object.fromEntries(await Promise.all(scripts.map(async f => [f.replace(/_/g, "-"), sha256(await readFile(native(f)))])));
    record.sourceDigests = { ...(await digests()), "cadquery-lock": sha256(await readFile(native("cadquery-requirements.txt"))), "cadquery-python": sha256(await readFile(config.cadquery)) };
    const input = join(directory, "input.json");
    await writePrivate(input, JSON.stringify({ requirements: request.requirements, grid: request.grid }));
    publish({ kind: "step", id: "sweep", label: `CadQuery 设计空间扫描（${total} 个点）`, status: "running" });
    let done = 0;
    const observe = (line: string) => {
      if (!line.startsWith("PAI_EVENT ")) return;
      try {
        const e = JSON.parse(line.slice(10)) as { type?: string; index?: number; total?: number; mass?: number; failed?: string[]; parameters?: CadParameters };
        if (e.type !== "point") return;
        done = Math.max(done, Number(e.index));
        const p = e.parameters!;
        publish({ kind: "step", id: `point-${e.index}`, label: `t=${p.thickness} · W=${p.width} · H=${p.plateHeight}`, status: e.failed?.length ? "failed" : "done",
          detail: `${e.mass ?? "—"} g${e.failed?.length ? ` · ${e.failed.join(", ")}` : " · 全部通过"}` });
      } catch { /* Presentation only. */ }
    };
    const args = ["-I", "-W", "ignore", native("cad_sweep.py"), "--input", input, "--output", directory];
    // ~6 s per point measured on t3.medium-class CPUs; bounded wall time with headroom.
    const r = await command(config.cadquery, args, config.repository, undefined, Math.max(120_000, total * 20_000), observe);
    await writePrivate(join(directory, "stdout.log"), r.stdout); await writePrivate(join(directory, "stderr.log"), r.stderr);
    record.receipts.push({ adapter: "cadquery-sweep", command: ["python", ...args], startedAt: r.startedAt, finishedAt: r.finishedAt,
      exitCode: r.exitCode, stdoutSha256: sha256(r.stdout), sourceDigests: { script: record.sourceDigests["cad-sweep.py"] } });
    if (r.exitCode !== 0) throw new DomainError("CAD_SWEEP_FAILED", "Native sweep failed; retain receipts and inspect local artifacts", 422);
    const text = await readFile(join(directory, "sweep.json"), "utf8");
    const result = SweepResult.parse(JSON.parse(text));
    if (result.points.length !== total || canonical(result.requirements) !== canonical(request.requirements)) throw new DomainError("CAD_SWEEP_CONTEXT", "Sweep output does not match the request");
    const recomputed = result.points.filter(p => p.feasible).sort((a, b) => a.mass! - b.mass! || a.index - b.index)[0]?.index ?? null;
    if (recomputed !== result.lightestFeasible || result.points.some(p => p.feasible !== (p.failed.length === 0))) throw new DomainError("CAD_SWEEP_INCONSISTENT", "Sweep summary disagrees with its points");
    if (canonical(await digests()) !== canonical(Object.fromEntries(scripts.map(f => [f.replace(/_/g, "-"), record.sourceDigests[f.replace(/_/g, "-")]])))) {
      throw new DomainError("SOURCE_CHANGED", "Native sweep scripts changed during the sweep");
    }
    record.files["sweep.json"] = sha256(text);
    record.result = result;
    record.pareto = paretoFront(result.points, request.requirements.minWallMm);
    record.state = "completed";
    publish({ kind: "step", id: "sweep", label: `CadQuery 设计空间扫描（${total} 个点）`, status: "done", detail: `${result.feasibleCount} 个点满足全部检查` });
  } catch (e) {
    record.state = "failed";
    record.error = e instanceof DomainError ? `${e.code}: ${e.message}` : "CAD_SWEEP_FAILED: check native configuration and retained local receipts";
  }
  record.finishedAt = new Date().toISOString();
  store.put("cad-sweep", record);
  publish({ kind: "done", state: record.state, recordId: record.id, detail: record.error });
  return record;
}

/** A parametric review request for one measured sweep point, with provenance. Requirements are the sweep's. */
export function pointRequest(sweep: CadSweep, index: number, requestId: string, revision: number) {
  const point = sweep.result?.points.find(p => p.index === index);
  if (!point) throw new DomainError("NOT_FOUND", "Sweep point not found", 404);
  return { requestId, projectRevision: revision, variant: "parametric" as const, requirements: sweep.request.requirements as CadReq,
    parameters: point.parameters, fromSweep: { sweepId: sweep.id, point: index } };
}
