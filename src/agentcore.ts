import { randomUUID } from "node:crypto";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { DomainError } from "./domain.js";

/**
 * Remote transports on Amazon Bedrock AgentCore Runtime (infra/agentcore.ts, agentcore/server.py).
 *
 * - The agent runtime runs the same pinned NoteFlow executor with Kiro x3; its attempt ledger lives on a shared,
 *   retained EFS volume. The run_id is the idempotency key on the remote side.
 * - The sandbox runtime runs untrusted CadQuery code with no credentials and no network route. Every job uses a
 *   fresh runtimeSessionId, i.e. a fresh microVM; a session that has run code refuses further jobs.
 * Calls use the default AWS credential chain and IAM (SigV4) authorization. Nothing is retried automatically:
 * an unanswered call is uncertain and is surfaced for reconciliation.
 */
const ARN = /^arn:aws:bedrock-agentcore:([a-z0-9-]+):\d{12}:runtime\/[A-Za-z][A-Za-z0-9_]{0,47}-[A-Za-z0-9]{10}$/;
const clients = new Map<string, BedrockAgentCoreClient>();

export function validRuntimeArn(arn: string | undefined): string | undefined {
  if (!arn) return undefined;
  if (!ARN.test(arn)) throw new Error("AgentCore runtime ARN has an unexpected format");
  return arn;
}

export async function invokeRuntime<T>(arn: string, payload: Record<string, unknown>, options: { session?: string; timeoutMs?: number } = {}): Promise<T> {
  const region = ARN.exec(arn)![1];
  const key = `${region}|${process.env.AWS_ENDPOINT_URL_BEDROCK_AGENTCORE ?? ""}`;
  let client = clients.get(key);
  if (!client) {
    // maxAttempts 1: the SDK must not retry an invocation whose effect may already have happened.
    client = new BedrockAgentCoreClient({ region, maxAttempts: 1 });
    clients.set(key, client);
  }
  // Session IDs must be at least 33 characters.
  const session = options.session ?? `pai-${randomUUID()}-${Date.now().toString(36)}`;
  const abort = AbortSignal.timeout(options.timeoutMs ?? 840_000);
  let body: string;
  try {
    const r = await client.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: arn, runtimeSessionId: session, contentType: "application/json", accept: "application/json",
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    }), { abortSignal: abort });
    body = r.response ? await r.response.transformToString() : "";
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    // The runtime's own refusal (4xx from the container) is surfaced as RuntimeClientError; keep the status.
    throw new DomainError("AGENTCORE_CALL_FAILED", `AgentCore 调用未完成（${name}${status ? ` ${status}` : ""}）；结果未知，不会自动重试`, 502);
  }
  try { return JSON.parse(body) as T; }
  catch { throw new DomainError("AGENTCORE_BAD_RESPONSE", "AgentCore 返回的内容无法解析", 502); }
}
