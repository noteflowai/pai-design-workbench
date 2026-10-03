import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { type ProjectVersion, CreateProject, ReviewRequest, CreateFeedback, TransitionFeedback, CreateCampaign, TrackEvent,
  type Campaign, type Feedback, type Project, type Review } from "./contracts.js";
import { canonical, caseText, decide, DomainError, junit, outcomes, sha256, validatePanel, validateDiff } from "./domain.js";
import { Store } from "./store.js";
import type { Adapters } from "./adapters.js";
import { sceneCaseText, type SceneReview } from "./scenes.js";
import { factoryCaseText, FACTORY_CHECKS, type FactoryReview, type FactoryCheckId } from "./factory.js";
import type { LiveBus } from "./live.js";
import { CAD_CHECKS, cadCaseText, type CadReview } from "./cad.js";
import { AERO_CHECKS, aeroCaseText, type AeroReview } from "./aero.js";

const SCENE_CHECKS = ["footprint-area", "declared-target-envelope", "camera-visibility", "aisle-clearance", "guard-clearance", "camera-coverage", "egress-travel", "reach", "collision-free", "cycle-time", "success-rate"];

export class Workbench {
  constructor(public store: Store, public adapters: Adapters, public stateDirectory: string, public live?: LiveBus) {}
  project(id: string): Project {
    const project = this.store.get<Project>("project", id);
    if (!project) throw new DomainError("NOT_FOUND", "Project not found", 404);
    return project;
  }
  createProject(input: unknown): Project {
    const project = { ...CreateProject.parse(input), id: randomUUID(), revision: 1, createdAt: new Date().toISOString() };
    this.store.insert("project", project); this.snapshot(project); return project;
  }
  updateProject(id: string, revision: number, input: unknown): Project {
    const old = this.project(id);
    if (old.revision !== revision) throw new DomainError("REVISION_CONFLICT", "Requirements have changed");
    // Projects created before version snapshots existed get their prior revision captured once, from the record itself.
    if (!this.store.get("project-version", `${id}@${old.revision}`)) this.snapshot(old, old.createdAt);
    const project = { ...old, ...CreateProject.parse(input), revision: old.revision + 1 };
    this.store.put("project", project, revision); this.snapshot(project); return project;
  }
  /** Immutable copy of each frozen requirement version, like a CAD version: never edited, only appended. */
  private snapshot(p: Project, at = new Date().toISOString()) {
    const version: ProjectVersion = { id: `${p.id}@${p.revision}`, projectId: p.id, revision: p.revision, title: p.title,
      intendedDecision: p.intendedDecision, requirements: p.requirements, requirementDigest: sha256(canonical(p.requirements)), frozenAt: at };
    this.store.insert("project-version", version);
  }
  versions(projectId: string) {
    this.project(projectId);
    return this.store.list<ProjectVersion>("project-version").filter(v => v.projectId === projectId).sort((a, b) => a.revision - b.revision);
  }
  review(id: string): Review {
    const review = this.store.get<Review>("review", id);
    if (!review) throw new DomainError("NOT_FOUND", "Review not found", 404);
    return review;
  }
  async runReview(projectId: string, input: unknown): Promise<Review> {
    const request = ReviewRequest.parse(input);
    const project = this.project(projectId);
    const digest = sha256(canonical({ projectId, request }));
    const record: Review = {
      id: randomUUID(), projectId, projectRevision: request.projectRevision, request,
      requestDigest: digest, requirementDigest: sha256(canonical(project.requirements)),
      project, state: "running", createdAt: new Date().toISOString(), candidate: request.candidate,
      feedbackId: request.feedbackId, receipts: [], artifacts: {}, sourceDigests: {},
    };
    // Claim and durable running record share one transaction. Same identity never launches twice.
    const claimed = this.store.claim(request.requestId, digest, record);
    if (claimed !== record.id) return this.review(claimed);
    const step = (id: string, label: string, status: "running" | "done" | "failed", detail?: string) =>
      this.live?.publish(request.requestId, { kind: "step", id, label, status, detail });
    this.live?.publish(request.requestId, { kind: "record", recordKind: "review", recordId: record.id });
    try {
      if (project.revision !== request.projectRevision) throw new DomainError("REVISION_CONFLICT", "Freeze the current requirement revision");
      if (request.feedbackId) {
        const feedback = this.feedback(request.feedbackId);
        if (feedback.evidenceKind !== "robot-review" || feedback.projectId !== projectId || !["fix-proposed", "no-change-with-reason"].includes(feedback.status)) {
          throw new DomainError("INVALID_RECHECK", "Recheck requires the same project's documented resolution");
        }
      }
      const directory = join(this.stateDirectory, "runs", record.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      step("context", "Radar 来源快照、控制器只读状态与原生输入指纹", "running");
      const [radar, controller, before] = await Promise.all([
        this.adapters.radar(), this.adapters.controller(), this.adapters.sourceDigests(),
      ]);
      record.radar = radar.value; record.controller = controller; record.sourceDigests = before;
      record.sourceDigests["radar/latest.json"] = radar.digest;
      record.artifacts["radar.json"] = radar.raw;
      this.store.put("review", record);
      step("context", "Radar 来源快照、控制器只读状态与原生输入指纹", "done", `${Object.keys(before).length} 个指纹`);
      step("robot-reel", "Robot Reel 原生记录核验（30 条配对记录）", "running");
      const stress = await this.adapters.stress();
      record.stress = stress.value; record.receipts.push(stress.receipt);
      record.artifacts["robot-reel.json"] = stress.raw;
      this.store.put("review", record);
      validatePanel(stress.value);
      step("robot-reel", "Robot Reel 原生记录核验（30 条配对记录）", "done", "配对统计与总数一致");
      const after = await this.adapters.sourceDigests();
      const expected = { ...before }; delete expected["radar/latest.json"];
      if (canonical(expected) !== canonical(after)) throw new DomainError("SOURCE_CHANGED", "Native input or verifier changed during the review");
      record.artifacts["baseline.xml"] = junit(stress.value, "reference");
      record.artifacts["current.xml"] = junit(stress.value, request.candidate);
      await Promise.all(["baseline.xml", "current.xml"].map(name =>
        writeFile(join(directory, name), record.artifacts[name], { mode: 0o600, flag: "wx" })));
      step("evalarc", "EvalArc 以稳定种子 JUnit 独立对照", "running");
      const diff = await this.adapters.diff(directory);
      // A forged adapter cannot turn a known loss into a green native comparison.
      validateDiff(stress.value, request.candidate, diff.value);
      if (canonical(expected) !== canonical(await this.adapters.sourceDigests())) throw new DomainError("SOURCE_CHANGED", "Verifier changed during native comparison");
      record.diff = diff.value; record.receipts.push(diff.receipt); record.artifacts["evalarc.json"] = diff.raw;
      step("evalarc", "EvalArc 以稳定种子 JUnit 独立对照", "done", `blocking ${diff.value.blocking_changes}`);
      record.decision = decide(project, request.candidate, stress.value, diff.value);
      record.artifacts["case.md"] = this.caseText(record);
      record.state = "completed";
    } catch (error) {
      record.state = "failed";
      record.error = error instanceof DomainError ? `${error.code}: ${error.message}` : "ADAPTER_FAILED: Native input or tool unavailable; inspect local receipts";
    }
    record.finishedAt = new Date().toISOString();
    this.store.put("review", record);
    this.live?.publish(request.requestId, { kind: "done", state: record.state, recordId: record.id, verdict: record.decision?.verdict, detail: record.error });
    await mkdir(join(this.stateDirectory, "runs", record.id), { recursive: true, mode: 0o700 });
    await writeFile(join(this.stateDirectory, "runs", record.id, "review.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
    return record;
  }
  feedback(id: string): Feedback {
    const result = this.store.get<Feedback>("feedback", id);
    if (!result) throw new DomainError("NOT_FOUND", "Feedback not found", 404);
    // Records from the pre-scene schema were exclusively robot reviews.
    return { ...result, evidenceKind: result.evidenceKind ?? "robot-review" };
  }
  createFeedback(input: unknown): Feedback {
    const parsed = CreateFeedback.parse(input), run = this.evidence(parsed.runId, parsed.evidenceKind);
    if (run.state !== "completed") throw new DomainError("UNVERIFIED_RUN", "Feedback must reference a completed review");
    if (parsed.evidenceKind === "factory-twin") {
      if (parsed.kind === "regression") throw new DomainError("NOT_A_FACTORY_FEEDBACK", "Factory feedback binds a failed per-seed check (design-check), not a recorded robot regression", 422);
      if (parsed.kind === "design-check") {
        const factory = run as FactoryReview, result = factory.seeds.find(s => s.seed === parsed.seed);
        if (!parsed.checkId || !(FACTORY_CHECKS as readonly string[]).includes(parsed.checkId) || !result
            || result.checks[parsed.checkId as FactoryCheckId] !== false) {
          throw new DomainError("NOT_A_FACTORY_FAILURE", "Factory feedback must bind a seed that fails the named frozen check", 422);
        }
      }
    } else if (parsed.checkId && !(parsed.evidenceKind === "blender-scene" ? SCENE_CHECKS : parsed.evidenceKind === "cad-part" ? CAD_CHECKS as readonly string[]
        : parsed.evidenceKind === "aero-body" ? AERO_CHECKS as readonly string[] : []).includes(parsed.checkId)) {
      throw new DomainError("CHECK_KIND_MISMATCH", "Check ID does not belong to this evidence kind", 422);
    }
    if (parsed.kind === "regression" && parsed.seed === null) throw new DomainError("MISSING_CASE", "A regression needs a paired seed");
    if (parsed.kind === "regression" && (!("stress" in run) || !run.stress
        || !outcomes(run.stress, "reference").get(parsed.seed!) || typeof run.candidate !== "string"
        || outcomes(run.stress, run.candidate).get(parsed.seed!) !== false)) {
      throw new DomainError("NOT_A_RECORDED_REGRESSION", "The reported seed must lose a recorded baseline success");
    }
    const native = run as SceneReview | CadReview;
    // Aerodynamics: the candidate's failed check is the case (the reference body is a starting point, not a target).
    if (parsed.kind === "design-check" && parsed.evidenceKind === "aero-body"
        && (!parsed.checkId || (run as AeroReview).candidate?.checks.find(c => c.id === parsed.checkId)?.passed !== false)) {
      throw new DomainError("NOT_A_NATIVE_DESIGN_FAILURE", "Aerodynamics feedback must bind a check the candidate failed");
    }
    if (parsed.kind === "design-check" && !["factory-twin", "aero-body"].includes(parsed.evidenceKind) && (!parsed.checkId || !["blender-scene", "cad-part"].includes(parsed.evidenceKind)
        || !native.baseline?.checks.find(c => c.id === parsed.checkId)?.passed
        || native.candidate?.checks.find(c => c.id === parsed.checkId)?.passed !== false)) {
      throw new DomainError("NOT_A_NATIVE_DESIGN_FAILURE", "Design feedback must bind a native check losing its baseline pass");
    }
    const feedback: Feedback = {
      ...parsed, id: randomUUID(), projectId: run.projectId, revision: 1, status: "received",
      history: [{ status: "received", reason: "已绑定原始证据的反馈已记录", at: new Date().toISOString() }],
    };
    this.store.insert("feedback", feedback); return feedback;
  }
  transitionFeedback(id: string, input: unknown): Feedback {
    const change = TransitionFeedback.parse(input), old = this.feedback(id);
    const allowed: Record<Feedback["status"], Feedback["status"][]> = {
      received: ["needs-context", "reproducible"],
      "needs-context": ["reproducible"],
      reproducible: ["assigned"], assigned: ["fix-proposed", "no-change-with-reason"],
      "fix-proposed": ["rechecked"], "no-change-with-reason": ["rechecked"],
      rechecked: ["closed", "assigned"], closed: [],
    };
    if (!allowed[old.status].includes(change.status)) throw new DomainError("INVALID_TRANSITION", "Feedback requires reproduction, ownership, resolution and recheck");
    if (old.revision !== change.expectedRevision) throw new DomainError("REVISION_CONFLICT", "Feedback changed; reload it");
    if (change.status === "closed") {
      const linked = [...old.history].reverse().find(h => h.status === "rechecked")?.recheckRunId;
      const run = linked ? this.evidence(linked, old.evidenceKind) : undefined;
      if (!run || run.projectRevision !== this.project(old.projectId).revision) {
        throw new DomainError("STALE_RECHECK", "Requirements changed after the recheck; leave this feedback open");
      }
    }
    if (change.status === "rechecked") {
      if (!change.recheckRunId) throw new DomainError("MISSING_RECHECK", "A new completed review is required");
      const run = this.evidence(change.recheckRunId, old.evidenceKind);
      if (run.id === old.runId || run.projectId !== old.projectId || run.feedbackId !== old.id
          || run.state !== "completed" || run.projectRevision !== this.project(old.projectId).revision) {
        throw new DomainError("INVALID_RECHECK", "Recheck must bind this feedback and current project revision");
      }
      if (old.kind === "regression" && old.status === "fix-proposed"
          && (old.seed === null || !("stress" in run) || !run.stress || typeof run.candidate !== "string"
            || outcomes(run.stress, run.candidate).get(old.seed) !== true)) {
        throw new DomainError("ISSUE_NOT_FIXED", "The reported seed still fails; retain the unresolved feedback");
      }
      if (old.kind === "design-check" && ["blender-scene", "cad-part", "aero-body"].includes(old.evidenceKind) && old.status === "fix-proposed"
          && (run as SceneReview | CadReview).candidate?.checks.find(c => c.id === old.checkId)?.passed !== true) {
        throw new DomainError("ISSUE_NOT_FIXED", "The native design check still fails; retain the unresolved feedback");
      }
      if (old.evidenceKind === "factory-twin") {
        const original = this.evidence(old.runId, "factory-twin") as FactoryReview, recheck = run as FactoryReview;
        if (recheck.criteriaId !== original.criteriaId) throw new DomainError("INVALID_RECHECK", "Factory recheck must reuse the originally frozen criteria");
        if (old.status === "fix-proposed" && old.kind === "design-check"
            && recheck.seeds.find(s => s.seed === old.seed)?.checks[old.checkId as FactoryCheckId] !== true) {
          throw new DomainError("ISSUE_NOT_FIXED", "The reported seed still fails the frozen factory check; retain the unresolved feedback");
        }
      }
    }
    const next: Feedback = { ...old, revision: old.revision + 1, status: change.status,
      history: [...old.history, { status: change.status, reason: change.reason, at: new Date().toISOString(), recheckRunId: change.recheckRunId }] };
    this.store.put("feedback", next, change.expectedRevision); return next;
  }
  evidence(id: string, kind: Feedback["evidenceKind"]): Review | SceneReview | FactoryReview | CadReview | AeroReview {
    if (kind === "robot-review") return this.review(id);
    if (kind === "aero-body") {
      const aero = this.store.get<AeroReview>("aero-review", id);
      if (!aero) throw new DomainError("NOT_FOUND", "Aerodynamics review not found", 404);
      return aero;
    }
    if (kind === "cad-part") {
      const cad = this.store.get<CadReview>("cad-review", id);
      if (!cad) throw new DomainError("NOT_FOUND", "CAD review not found", 404);
      return cad;
    }
    if (kind === "factory-twin") {
      const factory = this.store.get<FactoryReview>("factory-review", id);
      if (!factory) throw new DomainError("NOT_FOUND", "Factory Twin review not found", 404);
      return factory;
    }
    const scene = this.store.get<SceneReview>("scene-review", id);
    if (!scene) throw new DomainError("NOT_FOUND", "Native scene review not found", 404);
    return scene;
  }
  createCampaign(input: unknown): Campaign {
    const parsed = CreateCampaign.parse(input), run = this.evidence(parsed.runId, parsed.evidenceKind);
    if (run.state !== "completed") throw new DomainError("UNVERIFIED_RUN", "Only completed evidence can form a case draft");
    const campaign: Campaign = { ...parsed, id: randomUUID(), projectId: run.projectId, state: "draft",
      createdAt: new Date().toISOString(),
      text: (parsed.evidenceKind === "blender-scene" ? sceneCaseText(run as SceneReview)
        : parsed.evidenceKind === "factory-twin" ? factoryCaseText(run as FactoryReview)
        : parsed.evidenceKind === "cad-part" ? cadCaseText(run as CadReview)
        : parsed.evidenceKind === "aero-body" ? aeroCaseText(run as AeroReview)
        : this.caseText(run as Review))
        + "\nInvitation: Try permitted evidence of your own. Report setup failures, unclear evidence or an existing workflow that works better.\nNot sent or published by this workbench.\n" };
    this.store.insert("campaign", campaign); return campaign;
  }
  trackEvent(input: unknown) {
    const event = TrackEvent.parse(input);
    if (!this.store.get("campaign", event.campaignId)) throw new DomainError("NOT_FOUND", "Campaign not found", 404);
    const digest = sha256(canonical(event));
    const previous = this.store.get<{ inputDigest: string }>("event", event.eventId);
    if (previous) {
      if (previous.inputDigest !== digest) throw new DomainError("EVENT_CONFLICT", "Event identity cannot change its meaning");
      return previous;
    }
    const record = { ...event, id: event.eventId, inputDigest: digest, at: new Date().toISOString() };
    this.store.insert("event", record); return record;
  }
  metrics() {
    const events = this.store.list<z.infer<typeof TrackEvent>>("event");
    const external = events.filter(e => e.actorKind === "independent");
    return {
      independentParticipants: new Set(external.map(e => e.participantId)).size,
      independentEvents: external.length,
      independentRepeatUsers: new Set(external.filter(e => e.kind === "repeat-use").map(e => e.participantId)).size,
      maintainerEvents: events.filter(e => e.actorKind === "maintainer").length,
      fixtureEvents: events.filter(e => e.actorKind === "fixture").length,
      conversionRate: null,
      scope: "Manually recorded, self-declared participant observations. No exposure denominator or automatic independence verification.",
    };
  }
  caseText(run: Review): string {
    return caseText(run);
  }
}
