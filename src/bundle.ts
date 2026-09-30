import { z } from "zod";
import { Candidate, CreateProject, Hash, Id, NativeDiff, NativeStress, RadarDocument, ReviewRequest, type Project, type Review } from "./contracts.js";
import { canonical, caseText, decide, DomainError, junit, sha256, validatePanel, validateDiff } from "./domain.js";

const names = ["review.json", "robot-reel.json", "evalarc.json", "radar.json", "baseline.xml", "current.xml", "case.md", "source-digests.json"] as const;
const File = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), content: z.string().max(2_000_000) }).strict();
const Bundle = z.object({
  schema: z.literal("pai-workbench-bundle-1"),
  scope: z.literal("retrospective-recorded-simulation"),
  files: z.record(z.string(), File),
}).strict();
export function makeBundle(run: Review) {
  if (run.state !== "completed" || !run.stress || !run.diff || !run.decision) {
    throw new DomainError("UNVERIFIED_RUN", "A complete native review is required for handoff");
  }
  const clean = { ...run, artifacts: {} };
  const files: Record<string, string> = { ...run.artifacts, "review.json": JSON.stringify(clean, null, 2),
    "source-digests.json": JSON.stringify(run.sourceDigests, null, 2) };
  return { schema: "pai-workbench-bundle-1", scope: "retrospective-recorded-simulation",
    files: Object.fromEntries(names.map(name => [name, { content: files[name], sha256: sha256(files[name]) }])) };
}
/** Integrity and semantic consistency, not source authentication or physics verification. */
export function verifyBundle(input: unknown) {
  const bundle = Bundle.parse(input);
  if (Object.keys(bundle.files).sort().join(",") !== [...names].sort().join(",")) throw new DomainError("BUNDLE_FILES", "The complete closed file set is required", 422);
  const total = Object.values(bundle.files).reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (total > 4_000_000) throw new DomainError("BUNDLE_SIZE", "Bundle exceeds the handoff limit", 413);
  for (const [name, file] of Object.entries(bundle.files)) {
    if (sha256(file.content) !== file.sha256) throw new DomainError("BUNDLE_HASH", `Modified bundle file: ${name}`, 422);
  }
  const stress = NativeStress.parse(JSON.parse(bundle.files["robot-reel.json"].content));
  const diff = NativeDiff.parse(JSON.parse(bundle.files["evalarc.json"].content));
  const radar = RadarDocument.parse(JSON.parse(bundle.files["radar.json"].content));
  validatePanel(stress);
  const run = JSON.parse(bundle.files["review.json"].content) as Review;
  z.object({
    id: Id, projectId: Id, projectRevision: z.number().int().positive(), candidate: Candidate,
    request: ReviewRequest, requestDigest: Hash, requirementDigest: Hash,
    project: CreateProject.extend({ id: Id, revision: z.number().int().positive(), createdAt: z.string() }),
    sourceDigests: z.record(z.string(), Hash),
    receipts: z.array(z.object({ adapter: z.string(), stdoutSha256: Hash, exitCode: z.number().int() }).passthrough()),
  }).passthrough().parse(run);
  validateDiff(stress, run.candidate, diff);
  if (run.state !== "completed" || !run.project || !run.decision || run.decision.physicalValidation !== false
      || run.decision.scope !== bundle.scope || run.projectId !== run.project.id
      || run.projectRevision !== run.project.revision
      || run.request.candidate !== run.candidate || run.request.projectRevision !== run.projectRevision
      || run.requestDigest !== sha256(canonical({ projectId: run.projectId, request: run.request }))
      || run.requirementDigest !== sha256(canonical(run.project.requirements))
      || canonical(run.sourceDigests) !== canonical(JSON.parse(bundle.files["source-digests.json"].content))
      || run.sourceDigests["radar/latest.json"] !== sha256(bundle.files["radar.json"].content)
      || canonical(run.radar) !== canonical(radar)
      || canonical(run.stress) !== canonical(stress) || canonical(run.diff) !== canonical(diff)
      || canonical(decide(run.project as Project, run.candidate, stress, diff)) !== canonical(run.decision)) {
    throw new DomainError("BUNDLE_CONTEXT", "Requirement, source or decision identity mismatch", 422);
  }
  for (const [name, candidate] of [["baseline.xml", "reference"], ["current.xml", run.candidate]] as const) {
    if (bundle.files[name].content !== junit(stress, candidate)) throw new DomainError("BUNDLE_MAPPING", "JUnit no longer matches the recorded outcomes", 422);
  }
  if (bundle.files["case.md"].content !== caseText(run)) throw new DomainError("BUNDLE_CASE", "Case claims no longer match the native decision", 422);
  for (const [adapter, file] of [["robot-reel-native", "robot-reel.json"], ["evalarc-native", "evalarc.json"]]) {
    const receipt = run.receipts.find(r => r.adapter === adapter);
    if (!receipt || receipt.stdoutSha256 !== bundle.files[file].sha256
        || receipt.exitCode !== (adapter === "evalarc-native" && !diff.gate_passed ? 1 : 0)) throw new DomainError("BUNDLE_RECEIPT", "Native receipt does not match its saved output", 422);
  }
  return { valid: true as const, reviewId: run.id, files: names.length, sourceAuthenticated: false as const,
    physicalValidated: false as const, scope: bundle.scope, bundle };
}
