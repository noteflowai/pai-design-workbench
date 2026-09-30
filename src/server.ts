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
import { toolCatalog } from "./tool-catalog.js";
import { acquireRuntime } from "./runtime-lock.js";
import { authentication } from "./auth.js";

export async function createApp(config: Config, adapters: Adapters = new NativeAdapters(config)) {
  const app = Fastify({ logger: false, bodyLimit: 4_000_000, requestTimeout: 120_000 });
  const release = await acquireRuntime(config.state);
  let store: Store;
  try { store = new Store(join(config.state, "workbench.sqlite")); } catch (error) { await release(); throw error; }
  store.interruptPending();
  const workbench = new Workbench(store, adapters, config.state);
  const authenticated = authentication(config);
  const activeJobs = new Set<Promise<unknown>>();
  app.addHook("preClose", async () => { await Promise.allSettled([...activeJobs]); });
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
  app.get("/api/state", async () => ({
    projects: store.list("project"), reviews: store.list("review"), feedback: store.list("feedback"),
    campaigns: store.list("campaign"), proposals: store.list("proposal"), scenes: store.list("scene-review"), metrics: workbench.metrics(),
    tools: toolCatalog, capabilities: { recordingVerification: true, physicalValidation: false, automaticPublication: false,
      modelProposal: Boolean(config.controllerEntrypoint && config.controllerDatabase),
      authenticatedWorkspace: Boolean(config.albAuth && config.authLogoutUrl),
      blender: Boolean(config.blender),
      controllerMode: "native text proposal only when configured; otherwise read-only accounting" },
  }));
  app.get("/api/tools", async () => toolCatalog);
  app.post("/api/projects", async request => workbench.createProject(request.body));
  app.patch("/api/projects/:id", async request => {
    const input = CreateProject.extend({ expectedRevision: z.number().int().positive() }).strict().parse(request.body);
    const { expectedRevision, ...project } = input;
    return workbench.updateProject(paramId(request.params), expectedRevision, project);
  });
  app.post("/api/projects/:id/reviews", async (request, reply) =>
    executeNative(reply, request.body, "review", "runs", () => workbench.runReview(paramId(request.params), request.body)));
  app.post("/api/projects/:id/proposals", async request => propose(store, config, workbench.project(paramId(request.params)), request.body));
  app.post("/api/projects/:id/scenes", async (request, reply) =>
    executeNative(reply, request.body, "scene-review", "scenes", () => reviewScene(store, config, workbench.project(paramId(request.params)), request.body)));
  app.get("/api/scenes/:id", async (request, reply) => {
    const scene = store.get<SceneReview>("scene-review", paramId(request.params));
    if (!scene) throw new DomainError("NOT_FOUND", "Scene not found", 404);
    return nativeResponse(scene, reply, "scenes");
  });
  app.get("/api/scenes/:id/files/:which/:file", async (request, reply) => {
    const p = z.object({ id: Id, which: z.enum(["baseline", "candidate"]), file: z.enum(["scene.blend", "scene.glb", "preview.png", "checks.json"]) }).parse(request.params);
    const scene = store.get<SceneReview>("scene-review", p.id), name = `${p.which}/${p.file}`;
    if (!scene || scene.state !== "completed") throw new DomainError("NOT_FOUND", "Completed scene evidence required", 404);
    const content = await readFile(join(config.state, "scenes", p.id, p.which, p.file));
    if (sha256(content) !== scene.files[name]) throw new DomainError("SCENE_FILE_CHANGED", "Native artifact differs from its verified digest", 422);
    const types = { "scene.blend": "application/octet-stream", "scene.glb": "model/gltf-binary", "preview.png": "image/png", "checks.json": "application/json" };
    if (p.file !== "preview.png") reply.header("Content-Disposition", `attachment; filename="${p.which}-${p.file}"`);
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
