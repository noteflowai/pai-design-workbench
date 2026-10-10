/** Read API over the ontology: model export (JSON / Turtle), engine catalogue and object reads with links. */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import { DomainError } from "../domain.js";
import type { Store } from "../store.js";
import { aeroConfigured, aeroRunner } from "../aero.js";
import { camConfigured, camRunner } from "../cad.js";
import { deciderConfigured } from "../decider.js";
import { agentReadable, describeOntology, LINK_TYPES, OBJECT_TYPES, objectReadable, objectType, ontologyTurtle, type LinkType, type ObjectType } from "./model.js";

export interface Engine {
  id: string; name: string; version: string; role: string; available: boolean; runsOn: "local" | "aws-batch" | "service";
  /** What its output may decide: a native verdict, a conformance record, or only a suggestion. */
  authority: "verdict" | "conformance" | "suggestion"; license: string;
}

export function engines(config: Config, pins: Record<string, any>): Engine[] {
  const batch = (r: string | undefined) => r === "batch" ? "aws-batch" as const : "local" as const;
  return [
    { id: "cadquery", name: "CadQuery / OCCT", version: "2.8.0 / 7.9", role: "Parametric B-Rep geometry, DFM checks", available: Boolean(config.cadquery), runsOn: "local", authority: "verdict", license: "Apache-2.0 / LGPL-2.1" },
    { id: "calculix", name: "Gmsh + CalculiX", version: "4.15 / 2.21", role: "Linear static FEA, two mesh levels", available: Boolean(config.physicsPython && config.ccx), runsOn: config.solverBatch ? "aws-batch" : "local", authority: "verdict", license: "GPL-2.0 (separate process)" },
    { id: "openfoam", name: "OpenFOAM", version: "v2512", role: "RANS aerodynamics, two mesh levels", available: aeroConfigured(config), runsOn: aeroConfigured(config) ? batch(aeroRunner(config)) : "local", authority: "verdict", license: "GPL-3.0 (container)" },
    { id: "mujoco", name: "MuJoCo", version: "3.x", role: "Rigid-body dynamics, collisions, cycle time", available: Boolean(config.physicsPython), runsOn: "local", authority: "verdict", license: "Apache-2.0" },
    { id: "blender", name: "Blender", version: pins.blender?.version ?? "5.2", role: "Scenes, factory lines, ray measurement", available: Boolean(config.blender), runsOn: "local", authority: "verdict", license: "GPL-3.0 (separate process)" },
    { id: "freecad-cam", name: "FreeCAD CAM + OpenCAMLib", version: pins.freecad?.version ?? "1.1", role: "G-code per setup, independent cutting simulation", available: camConfigured(config), runsOn: camConfigured(config) ? batch(camRunner(config)) : "local", authority: "verdict", license: "LGPL-2.1 (separate process)" },
    { id: "ortools", name: "OR-Tools", version: "9.15", role: "Vehicle routing (logistics artifact), independent verifier", available: Boolean(config.logisticsPython), runsOn: "local", authority: "verdict", license: "Apache-2.0" },
    { id: "newton", name: "Newton", version: pins.newton?.version ?? "1.6", role: "OpenUSD import conformance", available: Boolean(config.newtonPython), runsOn: "local", authority: "conformance", license: "Apache-2.0" },
    { id: "strands-robots", name: "Strands Robots", version: pins.strandsRobots?.version ?? "0.5.3", role: "Robot registry and official MuJoCo models (simulation only)", available: Boolean(config.robotsPython && config.robotsAssets), runsOn: "local", authority: "conformance", license: "Apache-2.0" },
    { id: "strands-decider", name: "Strands Decider 2B", version: pins.strandsDecider?.model ?? "strands-decider-2B", role: "Routing suggestions with calibrated confidence", available: deciderConfigured(config), runsOn: "service", authority: "suggestion", license: "Apache-2.0" },
  ];
}

const TypeParam = z.object({ type: z.string().regex(/^[A-Z][A-Za-z]{1,40}$/) });
const ObjectParam = TypeParam.extend({ id: z.string().min(1).max(160).regex(/^[A-Za-z0-9@._-]+$/) });
const Page = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), after: z.string().max(160).optional() });

const targetOf = (link: LinkType, record: Record<string, unknown>) =>
  typeof link.to === "string" ? link.to : link.to.map[String(record[link.to.field])];

/** `isAgent` tells whether the request came through /api/agent (machine principal); agents see a narrower set. */
export function ontologyRoutes(app: FastifyInstance, store: Store, config: Config, pins: Record<string, any>, isAgent: (raw: unknown) => boolean) {
  const model = describeOntology();
  const json = JSON.stringify(model);
  const digest = createHash("sha256").update(json).digest("hex");
  const turtle = ontologyTurtle();
  const visible = (raw: unknown) => (t: ObjectType) => isAgent(raw) ? agentReadable(t) : objectReadable(t);
  const stored = (type: string, raw: unknown) => {
    const t = objectType(type);
    if (!t) throw new DomainError("UNKNOWN_OBJECT_TYPE", `No object type ${type}`, 404);
    if (!t.kind) throw new DomainError("RUNTIME_OBJECT_TYPE", `${type} is computed, not stored; see /api/v1/engines`, 400);
    if (!visible(raw)(t)) throw new DomainError("UNKNOWN_OBJECT_TYPE", `No readable object type ${type}`, 404);
    return t;
  };
  const summary = (title: string) => (r: Record<string, unknown>) => ({ id: r.id, title: r[title] ?? null, createdAt: r.createdAt ?? null,
    state: r.state ?? r.status ?? r.maturity ?? null, verdict: r.verdict ?? null });

  app.get("/api/v1/ontology", async (_req, reply) => { reply.header("ETag", `"${digest}"`); return { ...model, digest }; });
  app.get("/api/v1/ontology.ttl", async (_req, reply) => reply.type("text/turtle; charset=utf-8").header("ETag", `"${digest}"`).send(turtle));
  app.get("/api/v1/engines", async () => ({ engines: engines(config, pins) }));
  app.get("/api/v1/objects", async request => ({ types: OBJECT_TYPES.filter(visible(request.raw)).map(t => ({ id: t.id, label: t.label, count: store.count(t.kind!) })) }));
  app.get("/api/v1/objects/:type", async request => {
    const t = stored(TypeParam.parse(request.params).type, request.raw), page = Page.parse(request.query);
    const all = store.list<Record<string, unknown>>(t.kind!);
    const start = page.after ? all.findIndex(r => r.id === page.after) + 1 : 0;
    if (page.after && start === 0) throw new DomainError("CURSOR", "Unknown cursor", 400);
    const items = all.slice(start, start + page.limit);
    return { type: t.id, total: all.length, items: items.map(summary(t.title)), next: start + page.limit < all.length ? items.at(-1)?.id : null };
  });
  app.get("/api/v1/objects/:type/:id", async request => {
    const { type, id } = ObjectParam.parse(request.params);
    const t = stored(type, request.raw);
    const record = store.get<Record<string, unknown>>(t.kind!, id);
    if (!record) throw new DomainError("NOT_FOUND", `${type} ${id} not found`, 404);
    const canSee = visible(request.raw);
    const outgoing = LINK_TYPES.filter(l => l.from === t.id && record[l.via]).map(l => ({ link: l.id, type: targetOf(l, record) ?? null, id: record[l.via] }))
      .filter(l => { const target = l.type ? objectType(l.type) : undefined; return !target || canSee(target); });
    const incoming = LINK_TYPES.flatMap(l => {
      const source = objectType(l.from);
      if (!source?.kind || !canSee(source)) return [];
      return store.list<Record<string, unknown>>(source.kind).filter(r => r[l.via] === id && targetOf(l, r) === t.id).map(r => ({ link: l.id, type: l.from, id: r.id }));
    });
    return { type: t.id, object: record, links: { outgoing, incoming } };
  });
}
