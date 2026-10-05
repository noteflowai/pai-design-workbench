/**
 * First-article inspection (FAI): the bridge from simulation to the physical part.
 *
 * The plan is derived from the frozen requirements and the reviewed nominal geometry of an accepted CAD review: one
 * row per critical characteristic, with its tolerance and the instrument class it needs. A maintainer enters the values
 * measured on a real part (CMM, bore gauge, calipers, scale); each value is judged against the same tolerance. The
 * inspection is the only record in the workbench that carries `physicalMeasurement: true`; it never changes the CAD
 * review it refers to, and the review itself stays `physicalValidation: false`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { familyOf, type CadReview } from "./cad.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import { Id } from "./contracts.js";
import type { Store } from "./store.js";

export interface Characteristic {
  id: string; label: string; nominal: number; lower?: number; upper?: number; unit: "mm" | "g";
  instrument: string; source: string;
}
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Characteristics of an accepted review, from its own frozen requirements and measured nominal model. */
export function inspectionPlan(cad: CadReview): Characteristic[] {
  if (cad.state !== "completed" || cad.verdict !== "accepted-cad-part" || !cad.candidate) {
    throw new DomainError("NOT_INSPECTABLE", "Only an accepted CAD review has an inspection plan", 409);
  }
  const req = cad.request.requirements, c = (id: string) => cad.candidate!.checks.find(x => x.id === id) as { observed?: unknown; required?: unknown } | undefined;
  const env = num((c("envelope")?.observed as number[] | undefined)?.[0]) !== undefined ? c("envelope")!.observed as number[] : undefined;
  const common: Characteristic[] = [
    { id: "mass", label: "质量", nominal: cad.candidate.mass, upper: req.maxMassG, unit: "g", instrument: "电子秤（0.01 g）", source: "requirements.maxMassG" },
    ...(env ? ["X", "Y", "Z"].map((axis, i) => ({ id: `envelope-${axis.toLowerCase()}`, label: `外形 ${axis}`, nominal: env[i], upper: req.maxEnvelopeMm[i], unit: "mm" as const,
      instrument: "卡尺（0.02 mm）", source: `requirements.maxEnvelopeMm[${i}]` })) : []),
    { id: "min-wall", label: "最薄壁厚", nominal: num(c("min-wall")?.observed) ?? req.minWallMm, lower: req.minWallMm, unit: "mm", instrument: "壁厚千分尺或 CMM", source: "requirements.minWallMm" },
  ];
  if (familyOf(cad.request) === "pillow-block") {
    const seat = c("bearing-seat")!, so = seat.observed as { seatDiameter: number; seatLength: number }, sr = seat.required as { seatDiameter: [number, number]; seatLengthMin: number };
    const sh = c("shoulder")!, shr = sh.required as [number, number];
    return [
      { id: "bearing-seat-diameter", label: "轴承孔 Ø（H7）", nominal: so.seatDiameter, lower: sr.seatDiameter[0], upper: sr.seatDiameter[1], unit: "mm", instrument: "内径千分尺 / 气动量仪（0.001 mm）", source: "ISO 286 H7 for the 6202 outer ring" },
      { id: "bearing-seat-depth", label: "轴承孔深", nominal: so.seatLength, lower: sr.seatLengthMin, unit: "mm", instrument: "深度尺 / CMM", source: "bearing width B" },
      { id: "shoulder-diameter", label: "止口 / 轴孔 Ø", nominal: num(sh.observed)!, lower: shr[0], upper: shr[1], unit: "mm", instrument: "内径千分尺", source: "shaft clearance and ring land (ISO 355)" },
      ...common,
    ];
  }
  const nema = c("nema17-interface")!, no = nema.observed as { pilotBore: number; pitch: number[] };
  return [
    { id: "pilot-bore", label: "止口孔 Ø", nominal: no.pilotBore, lower: 22.2, unit: "mm", instrument: "内径千分尺", source: "NEMA 17 pilot Ø22" },
    { id: "bolt-pitch", label: "M3 孔距", nominal: no.pitch[0] ?? 31, lower: 30.9, upper: 31.1, unit: "mm", instrument: "CMM / 带销卡尺", source: "NEMA 17 bolt square 31 ± 0.1" },
    ...common,
  ];
}

export const InspectionInput = z.object({
  requestId: Id, measuredBy: z.string().trim().min(2).max(80), instrument: z.string().trim().min(2).max(120),
  partSerial: z.string().trim().min(1).max(60), values: z.record(z.string(), z.number().finite()),
  note: z.string().trim().max(500).optional(),
}).strict();
export interface Inspection {
  id: string; cadReviewId: string; projectId: string; createdAt: string; actor: string; requirementDigest: string;
  measuredBy: string; instrument: string; partSerial: string; note?: string; planSha256: string;
  results: (Characteristic & { measured: number; passed: boolean; deviation: number })[];
  verdict: "conforming" | "nonconforming"; physicalMeasurement: true;
  scope: "first-article dimensional and mass inspection of one part";
}

export function recordInspection(store: Store, cadId: string, input: unknown, actor: string): Inspection {
  const req = InspectionInput.parse(input);
  const cad = store.get<CadReview>("cad-review", cadId);
  if (!cad) throw new DomainError("NOT_FOUND", "CAD review not found", 404);
  const plan = inspectionPlan(cad);
  const missing = plan.filter(p => req.values[p.id] === undefined).map(p => p.id);
  const extra = Object.keys(req.values).filter(k => !plan.some(p => p.id === k));
  if (missing.length || extra.length) throw new DomainError("INSPECTION_INCOMPLETE", `Every planned characteristic needs one value (missing: ${missing.join(", ") || "none"}; unknown: ${extra.join(", ") || "none"})`, 422);
  const results = plan.map(p => {
    const m = req.values[p.id]!;
    const passed = (p.lower === undefined || m >= p.lower - 1e-9) && (p.upper === undefined || m <= p.upper + 1e-9);
    return { ...p, measured: m, passed, deviation: Math.round((m - p.nominal) * 1e4) / 1e4 };
  });
  const record: Inspection = { id: randomUUID(), cadReviewId: cad.id, projectId: cad.projectId, createdAt: new Date().toISOString(), actor,
    requirementDigest: cad.requirementDigest, measuredBy: req.measuredBy, instrument: req.instrument, partSerial: req.partSerial, note: req.note,
    planSha256: sha256(canonical(plan)), results, verdict: results.every(r => r.passed) ? "conforming" : "nonconforming",
    physicalMeasurement: true, scope: "first-article dimensional and mass inspection of one part" };
  const claimed = store.claim(req.requestId, sha256(canonical({ kind: "cad-inspection", cadId, req })), record, "cad-inspection");
  return claimed === record.id ? record : store.get<Inspection>("cad-inspection", claimed)!;
}
