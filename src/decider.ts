/**
 * Strands Decider (AWS Strands Labs, Apache-2.0): a "system one" decision model behind its own `serve` endpoint
 * (`POST /v1/systemone`). It picks among typed options with a calibrated confidence and never generates text.
 *
 * Here it only *suggests*: which tool lane a request the rules could not parse probably belongs to, and whether the
 * request loosens a requirement. A suggestion is shown only at confidence >= SUGGEST_AT (the upstream evaluation puts
 * answers at >= 0.9 right about 95% of the time on unseen short tasks); it never runs, confirms or accepts anything.
 * Verdicts stay with native solvers. Unreachable, slow or malformed answers mean "no suggestion" (fail closed).
 */
import { z } from "zod";
import type { Config } from "./config.js";

export const SUGGEST_AT = 0.9;
export const DECIDER_TIMEOUT_MS = 4_000;

/** Lanes a request can be routed to, described for the model (option name = plan tool). */
export const LANES = {
  "cad-review": "Check a parametric part (NEMA 17 bracket or 6202 pillow block) with native CAD checks: wall thickness, mass, hole edge distance, FEA load",
  "cad-code": "Write or change CadQuery code for a part, then check it",
  "cad-sweep": "Sweep a grid of part parameters to find the lightest feasible design",
  "cad-optimize": "Physics optimisation of a part under a load with FEA (surrogate-ranked, every point solved)",
  "scene-review": "Blender work cell scene: footprint, envelope, camera visibility, occlusion",
  "plant-layout": "Factory production line layout in Blender: stations, aisle, guard, AGV, hall area",
  "robot-cell": "MuJoCo robot work cell: joint speed, cycle time, collisions, seeds",
  "factory": "Factory maintenance and energy review: EV charging, output loss, hall temperature",
  "aero-body": "Aerodynamics of a car body with OpenFOAM: slant angle, drag",
  "robot-review": "Review a recorded robot simulation (SmolVLA, Robot Reel): success rate of a candidate",
  "create-project": "Create a new design task",
  "update-requirements": "Change the acceptance requirements of the current task",
  "out-of-scope": "Not an engineering design request for this workbench",
} as const;
export type Lane = keyof typeof LANES;

const Answer = z.object({
  model: z.string().max(200),
  answers: z.object({
    lane: z.object({ type: z.literal("choice"), choice: z.string(), confidence: z.number().min(0).max(1), probabilities: z.record(z.string(), z.number()) }),
    relaxes: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  }),
  latency_ms: z.number().optional(),
});

export interface Suggestion {
  engine: "strands-decider"; model: string; lane: Lane | null; confidence: number; threshold: number;
  /** Why no lane: below the threshold, or an answer outside the offered options. */ withheld?: "below-threshold" | "unknown-option";
  /** P(request loosens an acceptance requirement); informational, the plan diff remains the authority. */
  relaxesProbability: number; latencyMs: number; authority: "none";
}

export const deciderConfigured = (config: Config) => Boolean(config.deciderUrl);

/** Ask the Decider; `undefined` when unconfigured, unreachable, late or malformed. */
export async function suggestLane(config: Config, message: string, fetcher: typeof fetch = fetch): Promise<Suggestion | undefined> {
  if (!config.deciderUrl) return undefined;
  const started = performance.now();
  try {
    const response = await fetcher(config.deciderUrl, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(DECIDER_TIMEOUT_MS), redirect: "error",
      body: JSON.stringify({ state: message.slice(0, 2000), ...(config.deciderModel ? { model: config.deciderModel } : {}), questions: {
        lane: { type: "choice", instructions: "Which workbench tool should handle this request?", criteria: LANES },
        relaxes: { type: "noul", instructions: "Does this request loosen (relax) an acceptance requirement?" } } }),
    });
    if (!response.ok) return undefined;
    const parsed = Answer.safeParse(await response.json());
    if (!parsed.success) return undefined;
    const { lane, relaxes } = parsed.data.answers;
    const known = Object.hasOwn(LANES, lane.choice) ? lane.choice as Lane : null;
    const withheld = !known ? "unknown-option" as const : lane.confidence < SUGGEST_AT ? "below-threshold" as const : undefined;
    return { engine: "strands-decider", model: parsed.data.model, lane: withheld ? null : known, ...(withheld ? { withheld } : {}),
      confidence: Math.round(lane.confidence * 1000) / 1000, threshold: SUGGEST_AT, relaxesProbability: Math.round(relaxes.noul * 1000) / 1000,
      latencyMs: Math.round(performance.now() - started), authority: "none" };
  } catch { return undefined; }
}
