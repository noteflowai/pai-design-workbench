import Fastify, { type FastifyReply } from "fastify";
import staticPlugin from "@fastify/static";
import { readFile, access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as yieldTick } from "node:timers/promises";
import { z, ZodError } from "zod";
import { NativeAdapters, type Adapters } from "./adapters.js";
import { configuration, type Config } from "./config.js";
import { Candidate, CreateProject, Id } from "./contracts.js";
import { DomainError, sha256 } from "./domain.js";
import { makeBundle, verifyBundle } from "./bundle.js";
import { buildPackage, MAX_PACKAGE_BYTES, ReleasePackage, signer, verifySealedPackage } from "./signing.js";
import { archive, timestamp, type Archive } from "./seal.js";
import { solverDataset } from "./dataset.js";
import { createGrant, revokeGrant, runUnderGrant } from "./autonomy.js";
import { runAutopilot, type Autopilot } from "./autopilot.js";
import { AERO_FILES, AERO_REFERENCE, DEFAULT_AERO_REQUIREMENTS, aeroConfigured, aeroRunner, reviewAero, type AeroReview } from "./aero.js";
import { propose } from "./proposals.js";
import { Workbench } from "./service.js";
import { Store } from "./store.js";
import { reviewScene, type SceneReview } from "./scenes.js";
import { freezeFactoryCriteria, reviewFactory, REVIEWED_SAMPLE, DEFAULT_FACTORY_CRITERIA, type FactoryReview } from "./factory.js";
import { LiveBus, type Stamped } from "./live.js";
import { confirmPlan, createPlan, type AssistantPlan, preflightPlan } from "./assistant.js";
import { contextView, createAiPlan, createExternalPlan, reconcileAi, resolveHandle } from "./ai.js";
import { controllerConfigured, controllerTransport, enabledProfiles } from "./controller.js";
import { computeLifecycle, type LifecycleSnapshot } from "./lifecycle.js";
import type { Campaign, Feedback, Project, Review } from "./contracts.js";
import type { Proposal } from "./proposals.js";
import type { FactoryCriteria } from "./factory.js";
import { toolCatalog } from "./tool-catalog.js";
import { CAM_FILE, FAMILY_DEFAULTS, camConfigured, camRunner, DEFAULT_STRUCTURAL, FEA_FILES, CAD_FILES, CAD_TEMPLATE_FILE, checkCadCode, DEFAULT_CAD_REQUIREMENTS, precheckCad, reviewCad, type CadReview } from "./cad.js";
import { ISOLATION, sandboxStatus } from "./sandbox.js";
import { DEFAULT_SWEEP_GRID, MAX_SWEEP_POINTS, sweepCad, type CadSweep } from "./sweep.js";
import { DEFAULT_OPTIMIZE_BUDGET, MAX_OPTIMIZE_EVALUATIONS, botorchVersion, optimizeCad, type CadOptimization } from "./optimize.js";
import { KIND_STORE, admission, createRelease, decideRelease, supersedeForRevision, type Release } from "./release.js";
import { acquireRuntime } from "./runtime-lock.js";
import { authentication } from "./auth.js";
import { agentAuthentication, agentRoute, rewriteAgentUrl, type AgentPrincipal } from "./agent-api.js";

export async function createApp(config: Config, adapters: Adapters = new NativeAdapters(config)) {
  const app = Fastify({ logger: false, bodyLimit: 4_000_000, requestTimeout: 120_000, rewriteUrl: rewriteAgentUrl });
  const release = await acquireRuntime(config.state);
  let store: Store;
  try { store = new Store(join(config.state, "workbench.sqlite")); } catch (error) { await release(); throw error; }
  store.interruptPending();
  const live = new LiveBus();
  const workbench = new Workbench(store, adapters, config.state, live);
  const streams = new Set<() => void>();
  const authenticated = authentication(config), agentAuthenticated = agentAuthentication(config);
  const principals = new WeakMap<object, AgentPrincipal>();
  const activeJobs = new Set<Promise<unknown>>();
  app.addHook("preClose", async () => { for (const end of [...streams]) end(); await Promise.allSettled([...activeJobs]); });
  app.addHook("onClose", async () => { store.close(); await release(); });
  app.addHook("onRequest", async (request, reply) => {
    const healthCheck = request.method === "GET" && request.url === "/healthz";
    const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
    if (config.publicOrigin) allowedHosts.add(new URL(config.publicOrigin).host);
    if (!healthCheck && !allowedHosts.has(request.headers.host ?? "")) return reply.code(403).send({ error: "LOCAL_HOST_REQUIRED" });
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    if (config.publicOrigin) reply.header("Strict-Transport-Security", "max-age=31536000");
    if (request.url === "/api/agent-not-found") return reply.code(404).send({ error: "NOT_FOUND" });
    const agent = agentRoute(request.raw);
    if (agent) {
      // Agent routes: bearer token (hosted) or loopback; never the browser session, never a cross-origin browser.
      if (request.headers.origin || request.headers.cookie) return reply.code(403).send({ error: "AGENT_ROUTE_BROWSER" });
      const principal = await agentAuthenticated(request.headers, agent.scope);
      if (!principal) return reply.code(401).send({ error: "AGENT_AUTHENTICATION_REQUIRED" });
      principals.set(request.raw, principal);
      return;
    }
    if (!healthCheck && !await authenticated(request.headers)) return reply.code(401).send({ error: "AUTHENTICATION_REQUIRED" });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin
        && ![`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, ...(config.publicOrigin ? [config.publicOrigin] : [])].includes(request.headers.origin)) {
      return reply.code(403).send({ error: "CROSS_ORIGIN_WRITE" });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.code, message: error.message });
    if (error instanceof ZodError || error instanceof SyntaxError) return reply.code(400).send({ error: "INVALID_INPUT", message: "Input does not match the documented schema" });
    const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: "REQUEST_REJECTED" });
    return reply.code(500).send({ error: "LOCAL_TOOL_UNAVAILABLE", message: "Check local configuration and retained receipts" });
  });
  const sandbox = config.cadquery ? await sandboxStatus(config) : { available: false, reason: "CadQuery 未配置" };
  const cadTemplate = await readFile(join(config.repository, CAD_TEMPLATE_FILE), "utf8");
  const paramId = (p: unknown, field = "id") => Id.parse((p as Record<string, unknown>)[field]);
  const nativeResponse = <T extends { id: string; state: string }>(record: T, reply: FastifyReply, route: string) => {
    if (record.state === "running" && config.publicOrigin) reply.code(202).header("Location", `/api/${route}/${record.id}`).header("Retry-After", "2");
    return record;
  };
  const executeNative = async <T extends { id: string; state: string }>(
    reply: FastifyReply, input: unknown, kind: string, route: string, execute: () => Promise<T>,
  ) => {
    const requestId = Id.parse((input as Record<string, unknown>)?.requestId);
    const operation = execute();
    if (!config.publicOrigin) return await operation;
    const early = await Promise.race([
      operation.then(record => ({ done: true as const, record })),
      yieldTick().then(() => ({ done: false as const })),
    ]);
    if (early.done) return nativeResponse(early.record, reply, route);
    // Both native services atomically claim their request before their first await.
    const id = store.requestRun(requestId);
    if (!id) return await operation; // Validation failed before any side effect.
    const tracked = operation.catch(() => {
      const record = store.get<T & { error?: string }>(kind, id);
      if (record?.state === "running") {
        record.state = "interrupted";
        record.error = "Background operation stopped; retain identity and reconcile without automatic replay.";
        store.put(kind, record);
      }
    });
    activeJobs.add(tracked);
    void tracked.finally(() => activeJobs.delete(tracked));
    return nativeResponse(store.get<T>(kind, id)!, reply, route);
  };
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/logout", async (_request, reply) => {
    if (!config.authLogoutUrl) return reply.code(404).send({ error: "NOT_FOUND" });
    const names = ["PAIAuthSession", ...Array.from({ length: 4 }, (_, i) => `PAIAuthSession-${i}`)];
    reply.header("Set-Cookie", names.map(name => `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`));
    return reply.redirect(config.authLogoutUrl);
  });
  const lifecycle = (project: Project) => {
    const mine = <T extends { projectId?: string }>(kind: string) => store.list<T>(kind).filter(x => x.projectId === project.id);
    const campaigns = mine<Campaign>("campaign"), ids = new Set(campaigns.map(c => c.id));
    const releases = mine<Release>("release");
    const snapshot: LifecycleSnapshot = { project, releases, reviews: mine<Review>("review"), scenes: mine<SceneReview>("scene-review"), cads: mine<CadReview>("cad-review"), aeros: mine<AeroReview>("aero-review"),
      factoryCriteria: mine<FactoryCriteria>("factory-criteria"), factoryReviews: mine<FactoryReview>("factory-review"),
      feedback: mine<Feedback>("feedback"), campaigns,
      events: store.list<LifecycleSnapshot["events"][number]>("event").filter(e => ids.has(e.campaignId)),
      plans: mine<AssistantPlan>("assistant-plan"), proposals: mine<Proposal>("proposal") };
    return computeLifecycle(snapshot);
  };
  app.get("/api/projects/:id/lifecycle", async request => lifecycle(workbench.project(paramId(request.params))));
  // The auth hook has already verified the ALB-signed token and that its subject equals this header.
  const actor = (headers: Record<string, unknown>) => config.albAuth && typeof headers["x-amzn-oidc-identity"] === "string"
    ? `cognito:${String(headers["x-amzn-oidc-identity"]).slice(0, 64)}` : "local-maintainer";
  app.get("/api/projects/:id/versions", async request => workbench.versions(paramId(request.params)));
  app.get("/api/projects/:id/admission", async request => {
    const q = z.object({ kind: z.enum(["robot-review", "blender-scene", "cad-part", "factory-twin"]), runId: Id }).strict().parse(request.query);
    const p = workbench.project(paramId(request.params));
    return admission(store, p, lifecycle(p), q.kind, q.runId);
  });
  app.post("/api/projects/:id/releases", async request => {
    const p = workbench.project(paramId(request.params));
    return createRelease(store, p, lifecycle(p), request.body, actor(request.headers));
  });
  app.patch("/api/projects/:id/releases/:releaseId", async request => {
    const p = workbench.project(paramId(request.params));
    return decideRelease(store, p, lifecycle(p), paramId(request.params, "releaseId"), request.body, actor(request.headers));
  });
  // Signed, self-contained release package: record + digest-checked native files + release decision.
  const DIRS: Record<string, string> = { "scene-review": "scenes", "cad-review": "cad", "aero-review": "aero" };
  // A release is sealed once: signed, optionally time-stamped (RFC 3161) and archived write-once (S3 Object Lock).
  // Later downloads return the same bytes, so the archived copy, the time-stamp and every download agree.
  const sealing = new Map<string, Promise<Buffer>>();
  const sealed = (release: Release) => {
    const existing = sealing.get(release.id);
    if (existing) return existing;
    const file = join(config.state, "packages", `${release.id}.json`);
    const job = (async () => {
      const stored = await readFile(file).catch(() => undefined);
      if (stored) return stored;
      let pkg = await packageOf(release);
      if (config.tsaUrl) pkg = { ...pkg, timestamp: await timestamp(config, Buffer.from(pkg.signature.value, "base64")) };
      const bytes = Buffer.from(JSON.stringify(pkg));
      let archived: Archive | undefined;
      if (config.packageArchiveBucket) archived = await archive(config, `releases/${release.projectId}/${release.number}-${release.id}.json`, bytes);
      await mkdir(join(config.state, "packages"), { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
      const seal = { id: release.id, releaseId: release.id, projectId: release.projectId, number: release.number, sealedAt: new Date().toISOString(),
        packageSha256: sha256(bytes), manifestSha256: pkg.manifestSha256, signer: { keyId: pkg.signature.keyId, algorithm: pkg.signature.algorithm },
        timestamp: pkg.timestamp ? { tsa: pkg.timestamp.tsa, genTime: pkg.timestamp.genTime, serial: pkg.timestamp.serial } : null, archive: archived ?? null };
      store.insert("release-seal", seal); // append-only: one seal per release
      return bytes;
    })().finally(() => sealing.delete(release.id));
    sealing.set(release.id, job);
    return job;
  };
  app.get("/api/releases/:id/package", async (request, reply) => {
    const release = store.get<Release>("release", paramId(request.params));
    if (!release) throw new DomainError("NOT_FOUND", "Release not found", 404);
    if (release.maturity !== "released") throw new DomainError("NOT_RELEASED", "Only an approved release can be packaged", 409);
    const bytes = await sealed(release);
    reply.header("Content-Disposition", `attachment; filename="pai-release-${release.number}.json"`);
    return reply.type("application/json").send(bytes);
  });
  async function packageOf(release: Release): Promise<ReleasePackage> {
    const kind = KIND_STORE[release.evidenceKind];
    const record = store.get<{ id: string; verdict?: string; decision?: { verdict: string }; requirementDigest: string; files?: Record<string, string>; artifacts?: Record<string, string> }>(kind, release.runId);
    if (!record) throw new DomainError("NOT_FOUND", "Release evidence not found", 404);
    const files: Record<string, Buffer> = {};
    for (const [name, digest] of Object.entries(record.files ?? {})) {
      const dir = DIRS[kind]; if (!dir) continue;
      const content = await readFile(join(config.state, dir, record.id, name));
      if (sha256(content) !== digest) throw new DomainError("NATIVE_FILE_CHANGED", `Native artifact differs from its verified digest: ${name}`, 422);
      files[name] = content;
    }
    for (const [name, content] of Object.entries(record.artifacts ?? {})) files[`artifacts/${name}`] = Buffer.from(content);
    return buildPackage(config, { ...release }, { ...record, verdict: record.verdict ?? record.decision?.verdict ?? null }, files);
  }
  app.get("/api/signing/public-key", async () => { const s = await signer(config); return { keyId: s.keyId, algorithm: s.algorithm, publicKeyPem: s.publicKeyPem }; });
  // Packages carry base64 native files (FEA results are several MB): this route alone accepts up to the package cap.
  app.post("/api/packages/verify", { bodyLimit: Math.ceil(MAX_PACKAGE_BYTES * 1.4) + 1_000_000 }, async request => {
    const body = z.object({ package: z.unknown(), trustedPublicKeyPem: z.string().max(4000).optional() }).parse(request.body);
    return verifySealedPackage(body.package, body.trustedPublicKeyPem, config.tsaCaFile);
  });
  app.get("/api/dataset/solver", async request => {
    const { domain } = z.object({ domain: z.enum(["structural-fea", "aero-rans"]).optional() }).parse(request.query);
    const d = solverDataset(store);
    if (!domain) return d;
    const data = d.data.filter(r => r.domain === domain);
    return { ...d, rows: data.length, data, sha256: sha256(JSON.stringify(data)), domain };
  });
  app.get("/api/state", async () => ({
    releases: store.list("release"), autonomyGrants: store.list("autonomy-grant"), autopilots: store.list("autopilot"), releaseSeals: store.list("release-seal"), projectVersions: store.list("project-version"),
    lifecycles: Object.fromEntries(store.list<Project>("project").map(p => [p.id, lifecycle(p)])),
    projects: store.list("project"), reviews: store.list("review"), feedback: store.list("feedback"),
    campaigns: store.list("campaign"), proposals: store.list("proposal"), scenes: store.list("scene-review"), cads: store.list("cad-review"), aeros: store.list("aero-review"), cadSweeps: store.list("cad-sweep"), cadOptimizations: store.list("cad-optimize"),
    factoryCriteria: store.list("factory-criteria"), factoryReviews: store.list("factory-review"),
    assistantPlans: store.list("assistant-plan"), metrics: workbench.metrics(),
    tools: toolCatalog, capabilities: { recordingVerification: true, physicalValidation: false, automaticPublication: false,
      modelProposal: Boolean(config.controllerEntrypoint && config.controllerDatabase),
      authenticatedWorkspace: Boolean(config.albAuth && config.authLogoutUrl),
      blender: Boolean(config.blender),
      signing: { kms: Boolean(config.signingKmsKeyId), keyId: (await signer(config)).keyId, algorithm: (await signer(config)).algorithm },
      physics: config.physicsPython && config.ccx ? { fea: "Gmsh 4.15 + CalculiX 2.21 (C3D10, linear static)", defaultStructural: DEFAULT_STRUCTURAL,
        optimize: { engine: "Optuna 5 NSGA-II + scikit-learn GP surrogate (ranking only)", defaultBudget: DEFAULT_OPTIMIZE_BUDGET, maxEvaluations: MAX_OPTIMIZE_EVALUATIONS,
          strategies: (await botorchVersion(config)) ? ["gp-nsga2", "botorch-qlognehvi"] : ["gp-nsga2"], botorch: await botorchVersion(config) } } : false,
      aero: aeroConfigured(config) ? { engine: `OpenFOAM v2512 (OpenCFD image${aeroRunner(config) === "batch" ? ", AWS Batch 16 vCPU" : ""}) · snappyHexMesh + simpleFoam k-ω SST · two mesh levels`, reference: AERO_REFERENCE,
        defaultRequirements: DEFAULT_AERO_REQUIREMENTS } : false,
      cad: config.cadquery ? { engine: "CadQuery 2.8.0 / OCCT 7.9", defaultRequirements: DEFAULT_CAD_REQUIREMENTS, families: FAMILY_DEFAULTS,
        cam: camConfigured(config) ? { engine: `FreeCAD 1.1.4 CAM (ocp-freecad-cam) + OpenCAMLib${camRunner(config) === "batch" ? " on AWS Batch" : ""} · independent dexel simulation` } : false,
        generatedCode: { ...sandbox, isolation: ISOLATION, template: cadTemplate }, sweep: { defaultGrid: DEFAULT_SWEEP_GRID, maxPoints: MAX_SWEEP_POINTS } } : false,
      factoryTwin: { mode: "read-only illustrative-simulation review", reviewedSample: REVIEWED_SAMPLE.id, defaultCriteria: DEFAULT_FACTORY_CRITERIA, productionToolUpgraded: false },
      assistant: { mode: "typed plans; confirmation required", modelInvocation: controllerConfigured(config), engines: controllerConfigured(config) ? enabledProfiles(config) : [],
        transport: controllerTransport(config) ?? null,
        // Visual review: recorded images go to the model only through an executor that pins them by digest.
        images: controllerConfigured(config) && process.env.PAI_EXECUTOR_IMAGES === "1" },
      liveStream: "server-sent events; presentation only",
      controllerMode: "native text proposal only when configured; otherwise read-only accounting" },
  }));
  app.get("/api/tools", async () => toolCatalog);
  app.post("/api/projects", async request => workbench.createProject(request.body));
  app.patch("/api/projects/:id", async request => {
    const input = CreateProject.extend({ expectedRevision: z.number().int().positive() }).strict().parse(request.body);
    const { expectedRevision, ...project } = input;
    const updated = workbench.updateProject(paramId(request.params), expectedRevision, project);
    supersedeForRevision(store, updated, actor(request.headers));
    return updated;
  });
  app.post("/api/projects/:id/reviews", async (request, reply) =>
    executeNative(reply, request.body, "review", "runs", () => workbench.runReview(paramId(request.params), request.body)));
  app.post("/api/projects/:id/proposals", async request => propose(store, config, workbench.project(paramId(request.params)), request.body));
  app.post("/api/projects/:id/scenes", async (request, reply) =>
    executeNative(reply, request.body, "scene-review", "scenes", () => reviewScene(store, config, workbench.project(paramId(request.params)), request.body, live)));
  app.get("/api/scenes/:id/stages/:which/:index", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), index: z.coerce.number().int().min(1).max(16) }).parse(request.params);
    const scene = store.get<SceneReview>("scene-review", p.id);
    const stage = scene?.stages?.[p.which]?.find(s => s.index === p.index);
    if (!scene || !stage || !/^stages\/\d{2}-[a-z-]{1,24}\.glb$/.test(stage.file)) throw new DomainError("NOT_FOUND", "Stage not recorded", 404);
    const content = await readFile(join(config.state, "scenes", p.id, p.which, stage.file));
    if (sha256(content) !== stage.sha256) throw new DomainError("SCENE_FILE_CHANGED", "Stage geometry differs from its recorded digest", 422);
    return reply.type("model/gltf-binary").header("X-PAI-Evidence", "presentation-stage").send(content);
  });
  app.post("/api/projects/:id/cad", async (request, reply) => {
    await precheckCad(store, config, request.body);
    return executeNative(reply, request.body, "cad-review", "cad", () => reviewCad(store, config, workbench.project(paramId(request.params)), request.body, live));
  });
  app.post("/api/projects/:id/cad-sweeps", async (request, reply) =>
    executeNative(reply, request.body, "cad-sweep", "cad-sweeps", () => sweepCad(store, config, workbench.project(paramId(request.params)), request.body, live)));
  app.post("/api/projects/:id/cad-optimizations", async (request, reply) =>
    executeNative(reply, request.body, "cad-optimize", "cad-optimizations", () => optimizeCad(store, config, workbench.project(paramId(request.params)), request.body, live)));
  app.get("/api/cad-optimizations/:id", async (request, reply) => {
    const run = store.get<CadOptimization>("cad-optimize", paramId(request.params));
    if (!run) throw new DomainError("NOT_FOUND", "Optimisation not found", 404);
    return nativeResponse(run, reply, "cad-optimizations");
  });
  app.get("/api/cad-sweeps/:id", async (request, reply) => {
    const sweep = store.get<CadSweep>("cad-sweep", paramId(request.params));
    if (!sweep) throw new DomainError("NOT_FOUND", "CAD sweep not found", 404);
    return nativeResponse(sweep, reply, "cad-sweeps");
  });
  // Static policy check for the code editor; parses only, never executes.
  app.post("/api/cad/code-check", async request => {
    const { code } = z.object({ code: z.string().min(1).max(20_000) }).strict().parse(request.body);
    if (!config.cadquery) throw new DomainError("CAD_NOT_CONFIGURED", "CadQuery 未配置", 503);
    const violations = await checkCadCode(config, code);
    return { ok: violations.length === 0, violations };
  });
  app.get("/api/aero/:id", async (request, reply) => {
    const run = store.get<AeroReview>("aero-review", paramId(request.params));
    if (!run) throw new DomainError("NOT_FOUND", "Aerodynamics review not found", 404);
    return nativeResponse(run, reply, "aero");
  });
  app.get("/api/cad/:id", async (request, reply) => {
    const cad = store.get<CadReview>("cad-review", paramId(request.params));
    if (!cad) throw new DomainError("NOT_FOUND", "CAD review not found", 404);
    return nativeResponse(cad, reply, "cad");
  });
  app.get("/api/cad/:id/files/:which/:file", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), file: z.union([z.enum([...CAD_FILES, ...FEA_FILES, "dfm.json", "fea.png"]), z.string().regex(CAM_FILE)]) }).parse(request.params);
    const cad = store.get<CadReview>("cad-review", p.id);
    if (!cad || cad.state !== "completed" || !cad.files[`${p.which}/${p.file}`]) throw new DomainError("NOT_FOUND", "Completed CAD evidence required", 404);
    const content = await readFile(join(config.state, "cad", p.id, p.which, p.file));
    if (sha256(content) !== cad.files[`${p.which}/${p.file}`]) throw new DomainError("CAD_FILE_CHANGED", "Native artifact differs from its verified digest", 422);
    const types: Record<string, string> = { "part.step": "application/step", "part.stl": "model/stl", "part.glb": "model/gltf-binary", "assembly.glb": "model/gltf-binary",
      "drawing.svg": "image/svg+xml", "checks.json": "application/json", "fea.json": "application/json", "fea.glb": "model/gltf-binary",
      "bracket-fine.inp": "text/plain", "bracket-fine.frd": "text/plain", "dfm.json": "application/json", "fea.png": "image/png", "cam.json": "application/json", "cam-verify.json": "application/json", "cam-job.json": "application/json", "cam-sim.png": "image/png" };
    // Generated SVG is displayed as an image only; forbid any script or external fetch inside it.
    if (p.file === "drawing.svg") reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    else if (!p.file.endsWith(".glb") && !p.file.endsWith(".png")) reply.header("Content-Disposition", `attachment; filename="${p.which}-${p.file}"`);
    return reply.type(types[p.file] ?? "text/plain").send(content);
  });
  app.post("/api/projects/:id/aero", async (request, reply) =>
    executeNative(reply, request.body, "aero-review", "aero", () => reviewAero(store, config, workbench.project(paramId(request.params)), request.body, live)));
  app.get("/api/aero/:id/files/:which/:file", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), file: z.enum(AERO_FILES) }).parse(request.params);
    const run = store.get<AeroReview>("aero-review", p.id);
    if (!run || run.state !== "completed" || !run.files[`${p.which}/${p.file}`]) throw new DomainError("NOT_FOUND", "Completed aerodynamics evidence required", 404);
    const content = await readFile(join(config.state, "aero", p.id, p.which, p.file));
    if (sha256(content) !== run.files[`${p.which}/${p.file}`]) throw new DomainError("AERO_FILE_CHANGED", "Native artifact differs from its verified digest", 422);
    if (!p.file.endsWith(".glb")) reply.header("Content-Disposition", `attachment; filename="${p.which}-${p.file}"`);
    const type = p.file.endsWith(".glb") ? "model/gltf-binary" : p.file.endsWith(".json") ? "application/json" : p.file.endsWith(".step") ? "application/step" : p.file.endsWith(".stl") ? "model/stl" : "text/plain";
    return reply.type(type).send(content);
  });
  app.get("/api/aero/:id/stages/:which/:index", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), index: z.coerce.number().int().min(1).max(16) }).parse(request.params);
    const run = store.get<AeroReview>("aero-review", p.id);
    const stage = run?.stages?.[p.which]?.find(s => s.index === p.index);
    if (!run || !stage || !/^stages\/\d{2}-[a-z-]{1,24}\.glb$/.test(stage.file)) throw new DomainError("NOT_FOUND", "Stage not recorded", 404);
    const content = await readFile(join(config.state, "aero", p.id, p.which, stage.file));
    if (sha256(content) !== stage.sha256) throw new DomainError("AERO_FILE_CHANGED", "Stage geometry differs from its recorded digest", 422);
    return reply.type("model/gltf-binary").header("X-PAI-Evidence", "presentation-stage").send(content);
  });
  app.get("/api/cad/:id/stages/:which/:index", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), index: z.coerce.number().int().min(1).max(16) }).parse(request.params);
    const cad = store.get<CadReview>("cad-review", p.id);
    const stage = cad?.stages?.[p.which]?.find(s => s.index === p.index);
    if (!cad || !stage || !/^stages\/\d{2}-[a-z-]{1,24}\.glb$/.test(stage.file)) throw new DomainError("NOT_FOUND", "Stage not recorded", 404);
    const content = await readFile(join(config.state, "cad", p.id, p.which, stage.file));
    if (sha256(content) !== stage.sha256) throw new DomainError("CAD_FILE_CHANGED", "Stage geometry differs from its recorded digest", 422);
    return reply.type("model/gltf-binary").header("X-PAI-Evidence", "presentation-stage").send(content);
  });
  app.get("/api/live/:requestId", async (request, reply) => {
    const key = paramId(request.params, "requestId");
    const headers = { ...reply.getHeaders(), "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" };
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, headers as Record<string, string>);
    let ended = false;
    const write = (event: Stamped) => { if (!ended) raw.write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`); };
    const end = () => { if (ended) return; ended = true; clearInterval(heartbeat); subscription.close(); streams.delete(end); raw.end(); };
    const subscription = live.subscribe(key, event => { write(event); if (event.kind === "done") end(); });
    raw.write("retry: 3000\n: presentation-only progress; durable records remain authoritative\n\n");
    for (const event of subscription.replay) write(event);
    // Shared ALB idle timeout is 60 s; comment heartbeats keep the stream open without data.
    const heartbeat = setInterval(() => { if (!ended) raw.write(": heartbeat\n\n"); }, 15_000);
    streams.add(end);
    request.raw.on("close", end);
    if (subscription.done) end();
  });
  app.post("/api/projects/:id/factory-criteria", async request =>
    freezeFactoryCriteria(store, workbench.project(paramId(request.params)), request.body));
  app.post("/api/projects/:id/factory-reviews", async request =>
    reviewFactory(store, config.repository, workbench.project(paramId(request.params)), request.body, live));
  app.get("/api/factory-reviews/:id", async request => {
    const review = store.get<FactoryReview>("factory-review", paramId(request.params));
    if (!review) throw new DomainError("NOT_FOUND", "Factory review not found", 404);
    return review;
  });
  app.post("/api/assistant/plans", async request => createPlan(store, request.body, Boolean(config.controllerEntrypoint && config.controllerDatabase)));
  app.post("/api/assistant/ai", async (request, reply) =>
    executeNative(reply, request.body, "assistant-plan", "assistant/plans", async () => { const r = await createAiPlan(store, config, request.body, lifecycle, live); return { ...r, state: r.state ?? "done" }; }));
  app.get("/api/assistant/plans/:id", async (request, reply) => {
    const plan = store.get<AssistantPlan & { state?: string }>("assistant-plan", paramId(request.params));
    if (!plan) throw new DomainError("NOT_FOUND", "Assistant plan not found", 404);
    return nativeResponse({ ...plan, state: plan.state ?? "done" }, reply, "assistant/plans");
  });
  // Grounded planner context and external-agent proposals (used by the MCP server). Proposals carry no authority.
  app.get("/api/assistant/context", async request => {
    const q = z.object({ projectId: Id.optional() }).strict().parse(request.query);
    const p = q.projectId ? workbench.project(q.projectId) : undefined;
    return contextView(store, config, p, p ? lifecycle(p) : undefined);
  });
  app.get("/api/projects/:id/records/:handle", async request => {
    const p = workbench.project(paramId(request.params));
    const handle = z.string().regex(/^(project|[a-z]+-[0-9]{1,3})$/).parse((request.params as { handle?: string }).handle);
    return resolveHandle(store, p, handle, lifecycle(p));
  });
  // Bounded autonomy: a maintainer grants native runs (never approval/release/feedback); plans then run without a click.
  const autonomyDeps = { store, config, live, project: (id: string) => workbench.project(id), lifecycle };
  app.post("/api/projects/:id/autonomy-grants", async request => createGrant(store, workbench.project(paramId(request.params)), request.body, actor(request.headers)));
  app.get("/api/autonomy-grants", async request => {
    const q = z.object({ projectId: Id }).strict().parse(request.query);
    return store.list<{ projectId: string }>("autonomy-grant").filter(g => g.projectId === q.projectId);
  });
  app.post("/api/autonomy-grants/:id/revoke", async request => revokeGrant(store, paramId(request.params), actor(request.headers)));
  app.post("/api/assistant/plans/:id/autonomous-runs", async request => {
    const principal = principals.get(request.raw);
    return runUnderGrant(autonomyDeps, paramId(request.params), request.body, principal ? `agent:${principal.clientId}${principal.session ? `:${principal.session}` : ""}` : actor(request.headers));
  });
  app.post("/api/projects/:id/autopilot", async (request, reply) =>
    executeNative(reply, request.body, "autopilot", "autopilots", () => runAutopilot(autonomyDeps, workbench.project(paramId(request.params)), request.body, actor(request.headers))));
  app.get("/api/autopilots/:id", async (request, reply) => {
    const a = store.get<Autopilot>("autopilot", paramId(request.params));
    if (!a) throw new DomainError("NOT_FOUND", "Autopilot not found", 404);
    return nativeResponse(a, reply, "autopilots");
  });
  app.post("/api/assistant/external-plans", async request => createExternalPlan(store, config, request.body, lifecycle, principals.get(request.raw)));
  app.post("/api/assistant/plans/:id/reconciliation", async request => reconcileAi(store, paramId(request.params), request.body, actor(request.headers)));
  app.post("/api/assistant/plans/:id/preflight", async request =>
    preflightPlan(store, paramId(request.params), z.object({ planId: z.string().regex(/^p[0-9]{1,2}$/) }).strict().parse(request.body).planId));
  app.post("/api/assistant/plans/:id/confirmations", async request => confirmPlan(store, paramId(request.params), request.body));
  app.get("/api/scenes/:id", async (request, reply) => {
    const scene = store.get<SceneReview>("scene-review", paramId(request.params));
    if (!scene) throw new DomainError("NOT_FOUND", "Scene not found", 404);
    return nativeResponse(scene, reply, "scenes");
  });
  app.get("/api/scenes/:id/files/:which/:file", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), file: z.enum(["scene.blend", "scene.glb", "preview.png", "inspection.png", "checks.json", "robot.json", "scene.xml", "scene.usda", "tool.stl", "robot.glb", "newton.json"]) }).parse(request.params);
    const scene = store.get<SceneReview>("scene-review", p.id), name = `${p.which}/${p.file}`;
    if (!scene || scene.state !== "completed" || !scene.files[name]) throw new DomainError("NOT_FOUND", "Completed scene evidence required", 404);
    const content = await readFile(join(config.state, "scenes", p.id, p.which, p.file));
    if (sha256(content) !== scene.files[name]) throw new DomainError("SCENE_FILE_CHANGED", "Native artifact differs from its verified digest", 422);
    const types = { "scene.blend": "application/octet-stream", "scene.glb": "model/gltf-binary", "preview.png": "image/png", "inspection.png": "image/png", "checks.json": "application/json", "robot.json": "application/json", "scene.xml": "application/xml", "scene.usda": "model/vnd.usda", "tool.stl": "model/stl", "robot.glb": "model/gltf-binary", "newton.json": "application/json" };
    if (!p.file.endsWith(".png") && !p.file.endsWith(".glb")) reply.header("Content-Disposition", `attachment; filename="${p.which}-${p.file}"`);
    return reply.type(types[p.file]).send(content);
  });
  app.get("/api/runs/:id", async (request, reply) => nativeResponse(workbench.review(paramId(request.params)), reply, "runs"));
  app.post("/api/feedback", async request => workbench.createFeedback(request.body));
  app.patch("/api/feedback/:id", async request => workbench.transitionFeedback(paramId(request.params), request.body));
  app.post("/api/campaigns", async request => workbench.createCampaign(request.body));
  app.post("/api/events", async request => workbench.trackEvent(request.body));
  app.get("/api/runs/:id/bundle", async (request, reply) => {
    const id = paramId(request.params);
    reply.header("Content-Disposition", `attachment; filename="pai-review-${id}.json"`);
    return makeBundle(workbench.review(id));
  });
  app.post("/api/bundles/verify", async request => {
    const { bundle: _, ...result } = verifyBundle(request.body); return result;
  });
  app.get("/api/runs/:id/media/:candidate/:seed/:view", async (request, reply) => {
    const p = z.object({ id: Id, candidate: Candidate, seed: z.coerce.number().int().min(0).max(9), view: z.enum(["main", "wrist"]) }).parse(request.params);
    const run = workbench.review(p.id);
    if (run.state !== "completed") throw new DomainError("UNVERIFIED_RUN", "Complete verification before replay");
    const manifestRaw = await readFile(join(config.stressSource, "manifest.json"));
    if (sha256(manifestRaw) !== run.sourceDigests["stress/manifest.json"]) throw new DomainError("SOURCE_CHANGED", "Recording manifest differs from the verified run", 422);
    const name = `runs/seed-${String(p.seed).padStart(2, "0")}-${p.candidate}/attempt-001/${p.view}.mp4`;
    const content = await readFile(join(config.stressSource, name));
    if (sha256(content) !== JSON.parse(manifestRaw.toString()).files[name]) throw new DomainError("MEDIA_CHANGED", "Recording content differs from the verified manifest", 422);
    reply.type("video/mp4").header("Accept-Ranges", "bytes");
    const range = request.headers.range;
    if (!range) return reply.send(content);
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return reply.code(416).header("Content-Range", `bytes */${content.length}`).send();
    const start = match[1] ? Number(match[1]) : Math.max(0, content.length - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), content.length - 1) : content.length - 1;
    if (start >= content.length || end < start) return reply.code(416).header("Content-Range", `bytes */${content.length}`).send();
    return reply.code(206).header("Content-Range", `bytes ${start}-${end}/${content.length}`).send(content.subarray(start, end + 1));
  });
  try {
    await access(config.web);
    await app.register(staticPlugin, { root: resolve(config.web), prefix: "/" });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "NOT_FOUND" }) : reply.sendFile("index.html"));
  } catch { /* API-only mode supports CLI and tests before the web build. */ }
  return { app, workbench, store };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = configuration();
  const { app } = await createApp(config);
  await app.listen({ port: config.port, host: config.listenHost ?? "127.0.0.1" });
  console.log(`PAI Design Workbench: ${config.publicOrigin ?? `http://127.0.0.1:${config.port}`}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void app.close().then(() => process.exit(0)));
}
