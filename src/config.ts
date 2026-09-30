import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  workspace: string; state: string; web: string;
  robotRoot: string; stressSource: string; evalarcRoot: string; controlRoot: string; radarFile: string;
  port: number; controllerEntrypoint?: string; controllerDatabase?: string; blender?: string; repository: string;
}
export function configuration(): Config {
  const moduleRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const repository = basename(moduleRoot) === "dist" ? resolve(moduleRoot, "..") : moduleRoot;
  const workspace = resolve(process.env.PAI_WORKSPACE ?? resolve(repository, ".."));
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
  };
}
