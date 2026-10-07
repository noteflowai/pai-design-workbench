import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as iam from "aws-cdk-lib/aws-iam";

/** tools/bedrock-engines.json: the one source for engine regions and allowed model families. */
export const BEDROCK_ENGINES = JSON.parse(readFileSync(resolve("../tools/bedrock-engines.json"), "utf8")) as
  { claude: { region: string; modelFamilies: string[] }; codex: { region: string; modelFamilies: string[]; provider: string } };

/**
 * Least privilege for the Claude (claude-agent-acp) and Codex (codex-acp) engines on Amazon Bedrock with a role:
 * invoke only the pinned model families, directly or through cross-region / global inference profiles, plus the
 * account's default Bedrock project, which Bedrock's OpenAI-compatible Responses API (Codex) authorises against
 * (observed 401 naming project/default). Read-only model discovery has no resource-level permissions.
 */
export function bedrockEngineStatements(account: string): iam.PolicyStatement[] {
  const families = [...new Set([...BEDROCK_ENGINES.claude.modelFamilies, ...BEDROCK_ENGINES.codex.modelFamilies])];
  return [
    new iam.PolicyStatement({ actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], resources: [
      ...families.flatMap(f => [`arn:aws:bedrock:*::foundation-model/${f}.*`, `arn:aws:bedrock:*:${account}:inference-profile/*${f}.*`]),
      `arn:aws:bedrock:${BEDROCK_ENGINES.codex.region}:${account}:project/default`] }),
    new iam.PolicyStatement({ actions: ["bedrock:GetInferenceProfile", "bedrock:ListInferenceProfiles", "bedrock:GetFoundationModel", "bedrock:ListFoundationModels"], resources: ["*"] }),
  ];
}
