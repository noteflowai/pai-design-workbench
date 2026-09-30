import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { command } from "../src/adapters.js";
const root = resolve(".state/deps");
const pins = [
  ["robot-reel", "6124cee3cba53000eb46080422ed913b4439fb5f"],
  ["evalarc", "6af26bf0184d1e4f3c5496615eda594603cc68c3"],
  ["physical-ai-radar", "c7cd75d3cca62c822d7f5711110aefdf12159103"],
] as const;
await mkdir(root, { recursive: true, mode: 0o700 });
for (const [repo, pin] of pins) {
  const directory = join(root, `${repo}-${pin.slice(0, 12)}`);
  let exists = false;
  try { await access(directory); exists = true; } catch { /* Fresh owned dependency folder. */ }
  if (!exists) {
    const clone = await command("git", ["clone", "--filter=blob:none", "--no-checkout",
      `https://github.com/noteflowai/${repo}.git`, directory], root, undefined, 180_000);
    if (clone.exitCode !== 0) throw new Error(`Dependency clone failed: ${repo}`);
    if (repo === "robot-reel") {
      const sparse = await command("git", ["sparse-checkout", "set", "robot_reel", "docs/stress"], directory);
      if (sparse.exitCode !== 0) throw new Error("Sparse checkout failed");
    }
    const checkout = await command("git", ["checkout", "--detach", pin], directory, undefined, 180_000);
    if (checkout.exitCode !== 0) throw new Error(`Pinned dependency unavailable: ${repo}`);
  }
  const head = await command("git", ["rev-parse", "HEAD"], directory);
  const dirty = await command("git", ["status", "--porcelain"], directory);
  if (head.stdout.trim() !== pin || dirty.stdout.trim()) throw new Error(`Existing dependency changed: ${repo}; inspect it rather than resetting`);
  console.log(`Verified ${repo}@${pin}`);
}
let previous = "";
try { previous = await readFile(resolve(".state/demo.env"), "utf8"); } catch { /* New local configuration. */ }
const managed = ["PAI_ROBOT_ROOT", "PAI_STRESS_SOURCE", "PAI_EVALARC_ROOT", "PAI_RADAR_FILE"];
const preserved = previous.split("\n").filter(line => line && !managed.some(key => line.startsWith(`${key}=`)));
const location = (repo: string) => join(root, `${repo}-${pins.find(([name]) => name === repo)![1].slice(0, 12)}`);
await writeFile(resolve(".state/demo.env"), [
  `PAI_ROBOT_ROOT=${location("robot-reel")}`,
  `PAI_STRESS_SOURCE=${join(location("robot-reel"), "docs/stress")}`,
  `PAI_EVALARC_ROOT=${location("evalarc")}`,
  `PAI_RADAR_FILE=${join(location("physical-ai-radar"), "radar/latest.json")}`,
  // Native private control requires its own existing reviewed configuration.
  ...preserved,
].join("\n") + "\n", { mode: 0o600 });
console.log("Pinned public recording dependencies ready. No controller budget policy was created.");
