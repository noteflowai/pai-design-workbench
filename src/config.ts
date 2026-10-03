import { validRuntimeArn } from "./agentcore.js";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  workspace: string; state: string; web: string;
  robotRoot: string; stressSource: string; evalarcRoot: string; controlRoot: string; radarFile: string;
  port: number; controllerEntrypoint?: string; controllerDatabase?: string; blender?: string; cadquery?: string; repository: string;
  /** Pinned physics toolchain (npm run setup:physics): Python with Gmsh/Optuna/scikit-learn/MuJoCo, and CalculiX ccx. */
  physicsPython?: string; ccx?: string;
  /** bubblewrap binary for generated CAD code; generated code is refused when it cannot isolate. */
  bwrap?: string;
  /** Amazon Bedrock AgentCore runtimes (infra/agentcore.ts): remote executor and remote CAD sandbox. */
  agentcoreAgentArn?: string; agentcoreSandboxArn?: string;
  /** Engines this deployment may use, in fallback order; a subset of the executor's reviewed profiles. */
  aiProfiles?: string[];
  listenHost?: string; publicOrigin?: string;
  albAuth?: { albArn: string; issuer: string; clientId: string };
  /** Machine agents (OAuth client credentials) for `/api/agent/*`; see src/agent-api.ts. */
  agentAuth?: { userPoolId: string; clientIds: string[]; /** Pre-loaded JWKS (tests, air-gapped hosts); otherwise fetched from the pool. */ jwks?: unknown };
  authLogoutUrl?: string;
}
const ALL_PROFILES = ["kiro-primary", "kiro-backup", "kiro-backup2", "codex", "claude"];
function aiProfiles(value?: string): string[] | undefined {
  if (!value) return undefined;
  const list = value.split(",").map(x => x.trim()).filter(Boolean);
  if (!list.length || list.some(x => !ALL_PROFILES.includes(x)) || new Set(list).size !== list.length) throw new Error("PAI_AI_PROFILES must list distinct executor profiles");
  // Keep the executor's reviewed order (Kiro primary → backup → backup2 → Codex → Claude).
  return ALL_PROFILES.filter(x => list.includes(x));
}
export function configuration(): Config {
  const moduleRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const repository = basename(moduleRoot) === "dist" ? resolve(moduleRoot, "..") : moduleRoot;
  const workspace = resolve(process.env.PAI_WORKSPACE ?? resolve(repository, ".."));
  const publicOrigin = process.env.PAI_PUBLIC_ORIGIN;
  if (publicOrigin && (new URL(publicOrigin).protocol !== "https:" || new URL(publicOrigin).origin !== publicOrigin)) {
    throw new Error("PAI_PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
  const albValues = [process.env.PAI_AUTH_ALB_ARN, process.env.PAI_AUTH_ISSUER, process.env.PAI_AUTH_CLIENT_ID];
  if (albValues.some(Boolean) && !albValues.every(Boolean)) throw new Error("All ALB authentication settings are required");
  const albAuth = albValues.every(Boolean) ? { albArn: albValues[0]!, issuer: albValues[1]!, clientId: albValues[2]! } : undefined;
  const agentPool = process.env.PAI_AGENT_USER_POOL_ID, agentClients = process.env.PAI_AGENT_CLIENT_IDS?.split(",").map(x => x.trim()).filter(Boolean);
  if (Boolean(agentPool) !== Boolean(agentClients?.length)) throw new Error("PAI_AGENT_USER_POOL_ID and PAI_AGENT_CLIENT_IDS are required together");
  if (agentPool && !/^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{1,64}$/.test(agentPool)) throw new Error("PAI_AGENT_USER_POOL_ID must be a Cognito user pool id");
  if (agentClients?.some(c => !/^[a-z0-9]{1,128}$/.test(c))) throw new Error("PAI_AGENT_CLIENT_IDS must list Cognito app client ids");
  const agentAuth = agentPool ? { userPoolId: agentPool, clientIds: agentClients! } : undefined;
  const listenHost = process.env.PAI_LISTEN_HOST ?? "127.0.0.1";
  if (listenHost !== "127.0.0.1" && (!publicOrigin || !albAuth)) throw new Error("Network binding requires HTTPS origin and ALB authentication");
  return {
    repository, workspace, state: resolve(process.env.PAI_STATE ?? resolve(repository, ".state")),
    web: resolve(process.env.PAI_WEB ?? resolve(repository, "web-dist")),
    robotRoot: resolve(process.env.PAI_ROBOT_ROOT ?? resolve(workspace, "robot-reel")),
    stressSource: resolve(process.env.PAI_STRESS_SOURCE ?? resolve(workspace, "robot-reel/docs/stress")),
    evalarcRoot: resolve(process.env.PAI_EVALARC_ROOT ?? resolve(workspace, "evalarc")),
    controlRoot: resolve(process.env.PAI_CONTROL_ROOT ?? resolve(workspace, "noteflow-agent-control")),
    radarFile: resolve(process.env.PAI_RADAR_FILE ?? resolve(workspace, "physical-ai-radar/radar/latest.json")),
    port: Number(process.env.PORT ?? "4317"),
    controllerEntrypoint: process.env.PAI_CONTROLLER_ENTRYPOINT,
    controllerDatabase: process.env.PAI_CONTROLLER_DATABASE,
    blender: process.env.PAI_BLENDER,
    cadquery: process.env.PAI_CADQUERY_PYTHON,
    physicsPython: process.env.PAI_PHYSICS_PYTHON, ccx: process.env.PAI_CCX,
    bwrap: process.env.PAI_BWRAP,
    agentcoreAgentArn: validRuntimeArn(process.env.PAI_AGENTCORE_AGENT_ARN),
    agentcoreSandboxArn: validRuntimeArn(process.env.PAI_AGENTCORE_SANDBOX_ARN),
    aiProfiles: aiProfiles(process.env.PAI_AI_PROFILES),
    listenHost, publicOrigin, albAuth, agentAuth,
    authLogoutUrl: process.env.PAI_AUTH_LOGOUT_URL,
  };
}
