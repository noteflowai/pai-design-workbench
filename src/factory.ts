import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Id, type Feedback, type Project } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import type { LiveBus } from "./live.js";
import type { Store } from "./store.js";

/**
 * Read-only Factory Twin maintenance / energy decision review.
 *
 * Input is the byte-exact upstream `seeds.json` + `manifest.json` produced by
 * `robot-reel factory-twin`. The workbench never executes upstream tooling or writes
 * to an upstream workspace. Acceptance criteria must be frozen as a separate record
 * BEFORE evidence is imported; upstream summaries and self-verification never decide.
 * Every seed is evaluated and retained, including degraded ones.
 */
export const FACTORY_PROVENANCE = "illustrative-simulation" as const;
export const FACTORY_CHECKS = ["output-per-seed", "demand-intervals", "hall-comfort", "ev-service", "closed-failures"] as const;
export type FactoryCheckId = typeof FACTORY_CHECKS[number];

/** The reviewed upstream extract shipped with the workbench (see data/…/NOTICE.txt). */
export const REVIEWED_SAMPLE = {
  id: "robot-reel-v0.18.0-b3ee5c7",
  directory: "data/robot-reel-factory-twin-v0.18.0",
  sourceCommit: "b3ee5c7d2c5588ddc7e067869c049aad7e6951ce",
  sourceVersion: "0.18.0",
  manifestSha256: "9283923e03d18dd9fd35a5777b1d31a05aa3e644f53502730ad7549abe8dde42",
  seedsSha256: "5c5a2ca8abb52dbe25fe30c13727e97278721ed02bed7b5e5d19b9fa23ef28c4",
  review: "docs/evidence/robot-reel-factory-review.json",
} as const;

const n = z.number().finite();
const Mode = z.object({
  good_units: z.number().int().nonnegative(), scrap_units: z.number().int().nonnegative(),
  cnc2_failures: z.number().int().nonnegative(), cnc2_unplanned_down_min: n.nonnegative(),
  cnc2_planned_service_min: n.nonnegative(), peak_demand_kw: n.nonnegative(),
  intervals_over_limit: z.number().int().nonnegative(), grid_import_kwh: n,
  ev_kwh: n.nonnegative(), max_hall_c: n, import_kwh_per_good_unit: n,
  commands_actuated: z.number().int().nonnegative(),
}).strict();
const Seeds = z.object({
  seeds: z.array(z.object({ seed: z.number().int().min(0).max(1000), shadow: Mode, closed: Mode }).strict()).min(2).max(64),
  summary: z.object({
    pairs: z.number().int(),
    good_units_gain: z.object({ min: n, max: n, mean: n, pairs_improved: z.number().int(), pairs_worse: z.number().int() }).strict(),
    shadow_failures: z.number().int(), closed_failures: z.number().int(),
    shadow_intervals_over_limit: z.number().int(), closed_intervals_over_limit: z.number().int(),
    max_closed_hall_c: n,
  }).strict(),
}).strict();
const Manifest = z.object({
  schema: z.literal("robot-reel-factory-twin-1"),
  files: z.record(z.string(), z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive() }).strict()),
}).strict();

export const FactoryCriteriaValues = z.object({
  /** Largest tolerated per-seed loss of good units (closed vs shadow). */
  maxOutputLossPerSeed: z.number().int().min(0).max(1000),
  /** Closed-mode billing intervals allowed over the demand limit. */
  maxClosedIntervalsOverLimit: z.number().int().min(0).max(100),
  /** Comfort bound for the hall in closed mode. */
  maxHallC: z.number().min(10).max(40),
  /** Closed EV energy delivered as a fraction of the shadow schedule. */
  minEvServiceRatio: z.number().min(0).max(1),
  /** Unplanned CNC-2 failures allowed in closed mode. */
  maxClosedFailures: z.number().int().min(0).max(100),
  /** Panel-level good-unit gain must be positive; energy savings never substitute. */
  requireNetOutputGain: z.boolean(),
}).strict();
export type FactoryCriteriaValues = z.infer<typeof FactoryCriteriaValues>;
export const DEFAULT_FACTORY_CRITERIA: FactoryCriteriaValues = {
  maxOutputLossPerSeed: 0, maxClosedIntervalsOverLimit: 0, maxHallC: 25,
  minEvServiceRatio: 0.8, maxClosedFailures: 0, requireNetOutputGain: true,
};
export const FactoryCriteriaRequest = z.object({
  requestId: Id, projectRevision: z.number().int().positive(), criteria: FactoryCriteriaValues,
  rationale: z.string().trim().min(5).max(1000),
}).strict();
export interface FactoryCriteria {
  id: string; projectId: string; projectRevision: number; criteria: FactoryCriteriaValues;
  rationale: string; digest: string; createdAt: string; frozen: true;
}
export const FactoryReviewRequest = z.object({
  requestId: Id, projectRevision: z.number().int().positive(), criteriaId: Id,
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("reviewed-sample"), sampleId: z.literal(REVIEWED_SAMPLE.id) }).strict(),
    z.object({ kind: z.literal("upload"), seedsText: z.string().min(2).max(1_000_000),
      manifestText: z.string().min(2).max(200_000),
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  ]),
  feedbackId: Id.optional(),
}).strict();

export interface FactorySeedResult {
  seed: number; goodUnitsGain: number; evServiceRatio: number; closedHallC: number;
  closedIntervalsOverLimit: number; closedFailures: number; shadowFailures: number;
  importIntensityChange: number; commandsActuated: number;
  checks: Record<FactoryCheckId, boolean>;
}
export interface FactoryReview {
  id: string; projectId: string; projectRevision: number; request: z.infer<typeof FactoryReviewRequest>;
  criteriaId: string; criteria: FactoryCriteriaValues; criteriaDigest: string; criteriaFrozenAt: string;
  requirementDigest: string; state: "completed"; createdAt: string; finishedAt: string; feedbackId?: string;
  provenance: typeof FACTORY_PROVENANCE;
  source: { kind: "reviewed-sample" | "upload"; sourceCommit: string; seedsSha256: string; manifestSha256: string;
    reviewedByWorkbench: boolean; reviewRecord?: string };
  consistency: { id: string; passed: true; detail: string }[];
  seeds: FactorySeedResult[];
  aggregate: { pairs: number; netGoodUnitsGain: number; pairsImproved: number; pairsWorse: number;
    meanImportIntensityChange: number; failingSeeds: Record<FactoryCheckId, number[]> };
  checks: { id: string; passed: boolean; detail: string }[];
  verdict: "accepted-illustrative" | "rejected";
  upstreamSummary: unknown;
  realFactoryCalibrated: false; physicalValidation: false; productionToolUpgraded: false;
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Recompute upstream summary from its own seeds; any disagreement fails closed. */
export function consistency(seedsText: string, manifestText: string) {
  let seeds: z.infer<typeof Seeds>, manifest: z.infer<typeof Manifest>;
  try { seeds = Seeds.parse(JSON.parse(seedsText)); manifest = Manifest.parse(JSON.parse(manifestText)); }
  catch { throw new DomainError("FACTORY_SCHEMA", "seeds.json/manifest.json do not match the Robot Reel factory-twin-1 format", 422); }
  const entry = manifest.files["seeds.json"];
  const bytes = Buffer.byteLength(seedsText);
  if (!entry || entry.sha256 !== sha256(seedsText) || entry.bytes !== bytes) {
    throw new DomainError("FACTORY_DIGEST", "seeds.json differs from the digest and size in manifest.json", 422);
  }
  const ids = seeds.seeds.map(s => s.seed);
  if (new Set(ids).size !== ids.length) throw new DomainError("FACTORY_DUPLICATE_SEED", "Duplicated paired seed", 422);
  if (seeds.seeds.some(s => s.shadow.commands_actuated !== 0)) {
    throw new DomainError("FACTORY_SHADOW_ACTUATED", "Shadow mode must observe only; it reported actuated commands", 422);
  }
  const gains = seeds.seeds.map(s => s.closed.good_units - s.shadow.good_units);
  const sum = (f: (s: typeof seeds.seeds[number]) => number) => seeds.seeds.reduce((t, s) => t + f(s), 0);
  const expected = {
    pairs: seeds.seeds.length,
    good_units_gain: { min: Math.min(...gains), max: Math.max(...gains), mean: round(gains.reduce((a, b) => a + b, 0) / gains.length, 2),
      pairs_improved: gains.filter(g => g > 0).length, pairs_worse: gains.filter(g => g < 0).length },
    shadow_failures: sum(s => s.shadow.cnc2_failures), closed_failures: sum(s => s.closed.cnc2_failures),
    shadow_intervals_over_limit: sum(s => s.shadow.intervals_over_limit),
    closed_intervals_over_limit: sum(s => s.closed.intervals_over_limit),
    max_closed_hall_c: Math.max(...seeds.seeds.map(s => s.closed.max_hall_c)),
  };
  if (canonical(expected) !== canonical(seeds.summary)) {
    throw new DomainError("FACTORY_SUMMARY_INCONSISTENT", "Upstream summary disagrees with its own per-seed results", 422);
  }
  return {
    seeds, manifest,
    checks: [
      { id: "manifest-digest", passed: true as const, detail: `seeds.json ${bytes} bytes; SHA-256 matches manifest` },
      { id: "unique-seeds", passed: true as const, detail: `${ids.length} unique paired seeds` },
      { id: "shadow-observes-only", passed: true as const, detail: "Shadow mode actuated 0 commands in every seed" },
      { id: "summary-recomputed", passed: true as const, detail: "Pairs, gains, failures, over-limit intervals and hall maximum recomputed from seeds" },
    ],
  };
}

export function evaluateFactory(seeds: z.infer<typeof Seeds>, criteria: FactoryCriteriaValues) {
  const results: FactorySeedResult[] = seeds.seeds.map(s => {
    const gain = s.closed.good_units - s.shadow.good_units;
    const ev = s.shadow.ev_kwh > 0 ? s.closed.ev_kwh / s.shadow.ev_kwh : 1;
    return {
      seed: s.seed, goodUnitsGain: gain, evServiceRatio: round(ev, 4), closedHallC: s.closed.max_hall_c,
      closedIntervalsOverLimit: s.closed.intervals_over_limit, closedFailures: s.closed.cnc2_failures,
      shadowFailures: s.shadow.cnc2_failures, commandsActuated: s.closed.commands_actuated,
      importIntensityChange: round(s.closed.import_kwh_per_good_unit - s.shadow.import_kwh_per_good_unit, 3),
      checks: {
        "output-per-seed": gain >= -criteria.maxOutputLossPerSeed,
        "demand-intervals": s.closed.intervals_over_limit <= criteria.maxClosedIntervalsOverLimit,
        "hall-comfort": s.closed.max_hall_c <= criteria.maxHallC,
        "ev-service": ev + 1e-12 >= criteria.minEvServiceRatio,
        "closed-failures": s.closed.cnc2_failures <= criteria.maxClosedFailures,
      },
    };
  }).sort((a, b) => a.seed - b.seed);
  const failingSeeds = Object.fromEntries(FACTORY_CHECKS.map(id => [id, results.filter(r => !r.checks[id]).map(r => r.seed)])) as Record<FactoryCheckId, number[]>;
  const net = results.reduce((t, r) => t + r.goodUnitsGain, 0);
  const labels: Record<FactoryCheckId, string> = {
    "output-per-seed": `per-seed good-unit loss ≤ ${criteria.maxOutputLossPerSeed}`,
    "demand-intervals": `closed intervals over demand limit ≤ ${criteria.maxClosedIntervalsOverLimit}`,
    "hall-comfort": `closed hall maximum ≤ ${criteria.maxHallC} °C`,
    "ev-service": `closed EV energy ≥ ${Math.round(criteria.minEvServiceRatio * 100)}% of shadow schedule`,
    "closed-failures": `closed unplanned CNC-2 failures ≤ ${criteria.maxClosedFailures}`,
  };
  const checks = [
    ...FACTORY_CHECKS.map(id => ({ id, passed: failingSeeds[id].length === 0,
      detail: `${labels[id]}; failing seeds: ${failingSeeds[id].length ? failingSeeds[id].join(", ") : "none"}` })),
    { id: "net-output-gain", passed: !criteria.requireNetOutputGain || net > 0,
      detail: `panel net good-unit gain ${net}${criteria.requireNetOutputGain ? " (required > 0)" : " (not required)"}; energy intensity is reported separately and never offsets output` },
  ];
  return {
    seeds: results, checks, verdict: checks.every(c => c.passed) ? "accepted-illustrative" as const : "rejected" as const,
    aggregate: { pairs: results.length, netGoodUnitsGain: net, pairsImproved: results.filter(r => r.goodUnitsGain > 0).length,
      pairsWorse: results.filter(r => r.goodUnitsGain < 0).length,
      meanImportIntensityChange: round(results.reduce((t, r) => t + r.importIntensityChange, 0) / results.length, 3), failingSeeds },
  };
}

export function freezeFactoryCriteria(store: Store, project: Project, input: unknown): FactoryCriteria {
  const request = FactoryCriteriaRequest.parse(input);
  if (project.revision !== request.projectRevision) throw new DomainError("REVISION_CONFLICT", "Freeze the current requirement revision");
  const record: FactoryCriteria = { id: randomUUID(), projectId: project.id, projectRevision: request.projectRevision,
    criteria: request.criteria, rationale: request.rationale, digest: sha256(canonical(request.criteria)),
    createdAt: new Date().toISOString(), frozen: true };
  const claimed = store.claim(request.requestId, sha256(canonical({ kind: "factory-criteria", projectId: project.id, request })), record, "factory-criteria");
  return claimed === record.id ? record : store.get<FactoryCriteria>("factory-criteria", claimed)!;
}

async function loadSource(repository: string, source: z.infer<typeof FactoryReviewRequest>["source"]) {
  if (source.kind === "upload") return { seedsText: source.seedsText, manifestText: source.manifestText, sourceCommit: source.sourceCommit, reviewed: false };
  const directory = join(repository, REVIEWED_SAMPLE.directory);
  const [seedsText, manifestText] = await Promise.all([readFile(join(directory, "seeds.json"), "utf8"), readFile(join(directory, "manifest.json"), "utf8")]);
  if (sha256(seedsText) !== REVIEWED_SAMPLE.seedsSha256 || sha256(manifestText) !== REVIEWED_SAMPLE.manifestSha256) {
    throw new DomainError("SAMPLE_CHANGED", "Bundled reviewed sample differs from its pinned digests", 422);
  }
  return { seedsText, manifestText, sourceCommit: REVIEWED_SAMPLE.sourceCommit, reviewed: true };
}

export async function reviewFactory(store: Store, repository: string, project: Project, input: unknown, live?: LiveBus): Promise<FactoryReview> {
  const request = FactoryReviewRequest.parse(input);
  const step = (id: string, label: string, status: "running" | "done" | "failed", detail?: string) =>
    live?.publish(request.requestId, { kind: "step", id, label, status, detail });
  const existing = store.requestRun(request.requestId);
  if (existing) {
    const saved = store.get<FactoryReview>("factory-review", existing);
    if (saved) {
      if (canonical(saved.request) !== canonical(request)) throw new DomainError("REQUEST_CONFLICT", "Request identity cannot be reused for different inputs");
      return saved;
    }
  }
  try {
    if (project.revision !== request.projectRevision) throw new DomainError("REVISION_CONFLICT", "Freeze the current requirement revision");
    const criteria = store.get<FactoryCriteria>("factory-criteria", request.criteriaId);
    if (!criteria || criteria.projectId !== project.id || criteria.projectRevision !== project.revision) {
      throw new DomainError("CRITERIA_NOT_FROZEN", "Freeze factory acceptance criteria for this project revision before importing evidence");
    }
    if (request.feedbackId) {
      const feedback = store.get<Feedback>("feedback", request.feedbackId);
      const original = feedback ? store.get<FactoryReview>("factory-review", feedback.runId) : undefined;
      if (!feedback || feedback.evidenceKind !== "factory-twin" || feedback.projectId !== project.id || !original
          || !["fix-proposed", "no-change-with-reason"].includes(feedback.status) || original.criteriaId !== request.criteriaId) {
        throw new DomainError("INVALID_RECHECK", "Factory recheck must bind the same feedback and the originally frozen criteria");
      }
    }
    step("source", "读取上游 seeds.json / manifest.json", "running");
    const source = await loadSource(repository, request.source);
    step("source", "读取上游 seeds.json / manifest.json", "done", source.reviewed ? `已复核样本 ${REVIEWED_SAMPLE.id}` : "上传文件；未经本工作台复核");
    step("consistency", "摘要、哈希与影子模式一致性", "running");
    const checked = consistency(source.seedsText, source.manifestText);
    step("consistency", "摘要、哈希与影子模式一致性", "done", `${checked.checks.length} 项通过`);
    step("criteria", "按预先冻结的标准逐种子评估", "running");
    const evaluated = evaluateFactory(checked.seeds, criteria.criteria);
    step("criteria", "按预先冻结的标准逐种子评估", "done", evaluated.verdict);
    const now = new Date().toISOString();
    const record: FactoryReview = {
      id: randomUUID(), projectId: project.id, projectRevision: request.projectRevision, request,
      criteriaId: criteria.id, criteria: criteria.criteria, criteriaDigest: criteria.digest, criteriaFrozenAt: criteria.createdAt,
      requirementDigest: sha256(canonical({ projectRequirements: project.requirements, factoryCriteria: criteria.criteria })),
      state: "completed", createdAt: now, finishedAt: now, feedbackId: request.feedbackId, provenance: FACTORY_PROVENANCE,
      source: { kind: request.source.kind, sourceCommit: source.sourceCommit, seedsSha256: sha256(source.seedsText),
        manifestSha256: sha256(source.manifestText), reviewedByWorkbench: source.reviewed,
        ...(source.reviewed ? { reviewRecord: REVIEWED_SAMPLE.review } : {}) },
      consistency: checked.checks, seeds: evaluated.seeds, aggregate: evaluated.aggregate,
      checks: evaluated.checks, verdict: evaluated.verdict, upstreamSummary: checked.seeds.summary,
      realFactoryCalibrated: false, physicalValidation: false, productionToolUpgraded: false,
    };
    const claimed = store.claim(request.requestId, sha256(canonical({ kind: "factory-review", projectId: project.id, request })), record, "factory-review");
    live?.publish(request.requestId, { kind: "done", state: "completed", recordId: claimed, verdict: record.verdict });
    return claimed === record.id ? record : store.get<FactoryReview>("factory-review", claimed)!;
  } catch (error) {
    live?.publish(request.requestId, { kind: "done", state: "failed", detail: error instanceof DomainError ? error.code : "FACTORY_FAILED" });
    throw error;
  }
}

export function factoryCaseText(run: FactoryReview): string {
  const failing = Object.entries(run.aggregate.failingSeeds).filter(([, seeds]) => seeds.length)
    .map(([id, seeds]) => `${id}: ${seeds.join(", ")}`).join("; ") || "none";
  return "# Factory Twin maintenance / energy decision review\n\n"
    + `Decision: ${run.verdict} (${FACTORY_PROVENANCE}).\n`
    + `Source: Robot Reel ${run.source.sourceCommit.slice(0, 12)}; seeds.json SHA-256 ${run.source.seedsSha256}; `
    + `${run.source.reviewedByWorkbench ? "independently reviewed extract" : "uploaded, not reviewed by this workbench"}.\n`
    + `Criteria frozen ${run.criteriaFrozenAt} before import; digest ${run.criteriaDigest}.\n`
    + `Pairs: ${run.aggregate.pairs}; improved ${run.aggregate.pairsImproved}, worse ${run.aggregate.pairsWorse}; net good units ${run.aggregate.netGoodUnitsGain}.\n`
    + `Failing seeds by check: ${failing}.\n`
    + `Checks: ${run.checks.map(c => `${c.id}=${c.passed}`).join(", ")}.\n`
    + "Scope: illustrative simulation with uncalibrated demonstration parameters. Upstream summaries and self-verification do not grant acceptance; "
    + "energy intensity never offsets output, EV-service or comfort losses. No physical validation, measured factory twin, PLC control or production tool upgrade.\n";
}
