import Fastify, { type FastifyReply } from "fastify";
import staticPlugin from "@fastify/static";
import { readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as yieldTick } from "node:timers/promises";
import { z, ZodError } from "zod";
import { NativeAdapters, type Adapters } from "./adapters.js";
import { configuration, type Config } from "./config.js";
import { Candidate, CreateProject, Id } from "./contracts.js";
import { DomainError, sha256 } from "./domain.js";
import { makeBundle, verifyBundle } from "./bundle.js";
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
import { CAD_FILES, CAD_TEMPLATE_FILE, checkCadCode, DEFAULT_CAD_REQUIREMENTS, precheckCad, reviewCad, type CadReview } from "./cad.js";
import { ISOLATION, sandboxStatus } from "./sandbox.js";
import { DEFAULT_SWEEP_GRID, MAX_SWEEP_POINTS, sweepCad, type CadSweep } from "./sweep.js";
import { admission, createRelease, decideRelease, supersedeForRevision, type Release } from "./release.js";
import { acquireRuntime } from "./runtime-lock.js";
import { authentication } from "./auth.js";

export async function createApp(config: Config, adapters: Adapters = new NativeAdapters(config)) {
  const app = Fastify({ logger: false, bodyLimit: 4_000_000, requestTimeout: 120_000 });
  const release = await acquireRuntime(config.state);
  let store: Store;
  try { store = new Store(join(config.state, "workbench.sqlite")); } catch (error) { await release(); throw error; }
  store.interruptPending();
  const live = new LiveBus();
  const workbench = new Workbench(store, adapters, config.state, live);
  const streams = new Set<() => void>();
  const authenticated = authentication(config);
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
    const snapshot: LifecycleSnapshot = { project, releases, reviews: mine<Review>("review"), scenes: mine<SceneReview>("scene-review"), cads: mine<CadReview>("cad-review"),
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
  app.get("/api/state", async () => ({
    releases: store.list("release"), projectVersions: store.list("project-version"),
    lifecycles: Object.fromEntries(store.list<Project>("project").map(p => [p.id, lifecycle(p)])),
    projects: store.list("project"), reviews: store.list("review"), feedback: store.list("feedback"),
    campaigns: store.list("campaign"), proposals: store.list("proposal"), scenes: store.list("scene-review"), cads: store.list("cad-review"), cadSweeps: store.list("cad-sweep"),
    factoryCriteria: store.list("factory-criteria"), factoryReviews: store.list("factory-review"),
    assistantPlans: store.list("assistant-plan"), metrics: workbench.metrics(),
    tools: toolCatalog, capabilities: { recordingVerification: true, physicalValidation: false, automaticPublication: false,
      modelProposal: Boolean(config.controllerEntrypoint && config.controllerDatabase),
      authenticatedWorkspace: Boolean(config.albAuth && config.authLogoutUrl),
      blender: Boolean(config.blender),
      cad: config.cadquery ? { engine: "CadQuery 2.8.0 / OCCT 7.9", defaultRequirements: DEFAULT_CAD_REQUIREMENTS,
        generatedCode: { ...sandbox, isolation: ISOLATION, template: cadTemplate }, sweep: { defaultGrid: DEFAULT_SWEEP_GRID, maxPoints: MAX_SWEEP_POINTS } } : false,
      factoryTwin: { mode: "read-only illustrative-simulation review", reviewedSample: REVIEWED_SAMPLE.id, defaultCriteria: DEFAULT_FACTORY_CRITERIA, productionToolUpgraded: false },
      assistant: { mode: "typed plans; confirmation required", modelInvocation: controllerConfigured(config), engines: controllerConfigured(config) ? enabledProfiles(config) : [],
        transport: controllerTransport(config) ?? null },
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
  app.get("/api/cad/:id", async (request, reply) => {
    const cad = store.get<CadReview>("cad-review", paramId(request.params));
    if (!cad) throw new DomainError("NOT_FOUND", "CAD review not found", 404);
    return nativeResponse(cad, reply, "cad");
  });
  app.get("/api/cad/:id/files/:which/:file", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), file: z.enum(CAD_FILES) }).parse(request.params);
    const cad = store.get<CadReview>("cad-review", p.id);
    if (!cad || cad.state !== "completed") throw new DomainError("NOT_FOUND", "Completed CAD evidence required", 404);
    const content = await readFile(join(config.state, "cad", p.id, p.which, p.file));
    if (sha256(content) !== cad.files[`${p.which}/${p.file}`]) throw new DomainError("CAD_FILE_CHANGED", "Native artifact differs from its verified digest", 422);
    const types: Record<string, string> = { "part.step": "application/step", "part.stl": "model/stl", "part.glb": "model/gltf-binary", "assembly.glb": "model/gltf-binary",
      "drawing.svg": "image/svg+xml", "checks.json": "application/json" };
    // Generated SVG is displayed as an image only; forbid any script or external fetch inside it.
    if (p.file === "drawing.svg") reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    else if (!p.file.endsWith(".glb")) reply.header("Content-Disposition", `attachment; filename="${p.which}-${p.file}"`);
    return reply.type(types[p.file]).send(content);
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
  app.post("/api/assistant/external-plans", async request => createExternalPlan(store, config, request.body, lifecycle));
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
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), file: z.enum(["scene.blend", "scene.glb", "preview.png", "inspection.png", "checks.json"]) }).parse(request.params);
    const scene = store.get<SceneReview>("scene-review", p.id), name = `${p.which}/${p.file}`;
    if (!scene || scene.state !== "completed" || !scene.files[name]) throw new DomainError("NOT_FOUND", "Completed scene evidence required", 404);
    const content = await readFile(join(config.state, "scenes", p.id, p.which, p.file));
    if (sha256(content) !== scene.files[name]) throw new DomainError("SCENE_FILE_CHANGED", "Native artifact differs from its verified digest", 422);
    const types = { "scene.blend": "application/octet-stream", "scene.glb": "model/gltf-binary", "preview.png": "image/png", "inspection.png": "image/png", "checks.json": "application/json" };
    if (!p.file.endsWith(".png")) reply.header("Content-Disposition", `attachment; filename="${p.which}-${p.file}"`);
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
