# Agent runtime: what is reused, and when AgentForge would be adopted

Date: 2026-10-03. Status: **decided — no AgentForge Host channel yet**. Re-evaluate when the gates below hold.

## Current path (unchanged)

The workbench calls the NoteFlow bounded text executor (`src/controller.ts`). Its parts:

- Engine transport: acpx `FlowRunner`, with Kiro primary → backup → backup2, Codex and Claude.
- Accounting: the one shared SQLite admission ledger.
- Dispatch: single-use dispatch claims.
- Recovery: a run with unknown effects returns `reconcile` instead of being retried.

The workbench owns everything after that: answer validation, citations, typed plans and human confirmation.

## What the planner sees, and how it learns

- **Workspace.** Each turn the planner gets the frozen requirements, every native check with observed and required values, FEA convergence, DFM/CAM numbers, design studies (lightest feasible point and the three lightest near misses), first-article inspections (the only physical measurements) and the last autopilot rounds. Every item has a handle the answer must cite.
- **Track record.** `aiTrackRecord` (`src/track-record.ts`) lists, per AI, how its executed proposals fared with the solvers: accepted or rejected, edited by a person before running, run under a grant, relaxations proposed, and the signed bias of its deflection estimates. It is derived from confirmed plan steps and the lanes' own verdicts, never from the model. The same record goes back to the model, so the next proposal can avoid a check it already failed and correct its estimate bias. The overview card "AI 战绩" shows it to people.
- **Autonomy in the product.** The overview card "AI 自主迭代" lets a maintainer issue a grant (tools, number of runs, hours), give autopilot a goal, follow each round and its native verdict, and revoke the grant. An external agent can use the same grant through MCP (`pai_run_plan`). Steps that would relax a requirement always need a person. When the executor cannot verify an engine's effects (always the case for Codex), the round stops as `needs-human`; the card shows the paused proposal, the maintainer records why it is safe, and runs it under the same grant. The ledger is never touched.
- **Focus.** Autopilot offers only the granted tools and the template of the part family in hand. For the pillow-block scenario this cut the prompt from 26.3 KB to 10.9 KB.
- **Request class.** Long planning turns (code, studies) use the executor's extended `domain-data-proposal` class (180 s per attempt) when the engines are exactly the three ordered Kiro keys and there are no images; otherwise the short `text-proposal` class (60 s). Live on the hosted site: the pillow-block autopilot that failed at 60 s on 2026-10-06 met its goal in one round (Kiro, `effects: none`, 1.3 min).
- **Attempt bound.** The workbench reads the per-attempt limit from the pinned executor's request contract (`contracts/text-proposal.schema.json`), so it is never hardcoded here. #96 records an acpx timeout as `timeout` and keeps the partial answer. The executor is now at e77ee43: Codex sessions are pinned to the reviewed model (#120). Its owner kept `text-proposal` at 60 s and added a separate 180 s `development-proposal` class for the development writer only (#118), so the workbench stays on `text-proposal`. Short parametric plans fit in it: on 2026-10-06 Codex answered within the bound and the housing it proposed was accepted by the native checks (VERIFICATION.md).

## What AgentForge offers, and how it relates

AgentForge (the `autoforge` base; private repository `noteflowai/agentforge`) is built on the same acpx. On top it adds:

- A Rust Host (HTTP+SSE, multiple sessions, replay).
- Coding flows, an MCP gateway with per-session allow/deny and audit, tenancy and auth, and OTel GenAI telemetry.
- AgentCore and K8s backends.

The engine layer is the same component in both systems. Moving the PAI planner onto the Host would add a second orchestrator and a second budget around the same acpx. Neither the planner nor the native lanes need either of them.

## Evidence (read 2026-10-03, at the latest commits)

| Requirement here | AgentForge Host, measured | Source |
|---|---|---|
| One shared admission ledger. No second budget and no reset ([NoteFlow ADR 005](https://github.com/noteflowai/noteflow-agent-control/blob/main/docs/decisions/005-shared-admission-accounting.md)) | It has its own per-session/per-tenant `BudgetLedger` and no external admission hook | `host/src/budget.rs`, `budget_store.rs` |
| No automatic replay of uncertain work ([NoteFlow ADR 002](https://github.com/noteflowai/noteflow-agent-control/blob/main/docs/decisions/002-engines-and-acpx.md)) | Retries a turn by default (`AUTOFORGE_TURN_RETRY_MAX=2`) when an error looks transient and no output has been seen | `host/src/retry.rs`, `session.rs` |
| A text-only planner with no tools | Designed for coding agents that use the filesystem and terminal. The tool posture is `operator-declared`, not attested | README, `SECURITY.md` |
| Reproducible from a public repository and public CI | Private repository; GHCR image needs a classic PAT; no GitHub releases | `docs/CONSUMING.md` |
| Runs on the x86_64 host and workstation | The published Host image is arm64 only | `docs/CONSUMING.md` |
| Live evidence for the remote backends | Live runtime conformance fails on every recent main commit because its configuration is missing | Actions: Live runtime conformance |
| Portfolio direction | "Adopt a mature distributed workflow owner only when cross-host durability or availability requires one … Reuse acpx, SQLite, cron/systemd … instead of rebuilding them. Introduce Rust only for a measured native/performance need." | [NoteFlow ROADMAP](https://github.com/noteflowai/noteflow-agent-control/blob/main/ROADMAP.md) |

## Adopted: AgentForge sessions use PAI through the governed MCP gateway

AgentForge agents work *on* PAI without PAI handing them its planner or ledger. An operator installs
[`integrations/agentforge/mcp-profile.json`](../integrations/agentforge/mcp-profile.json) as the `pai-workbench` MCP profile, and a session selects it by name. Every pai-mcp call then passes through AgentForge's existing gateway:
- tools are allowed per session from an exact allowlist, and everything else is denied by default;
- every call is audited and rate-limited;
- the gateway session id reaches the workbench as `AF_SESSION_ID` and is shown on the proposal.

The agent's own model calls are AgentForge's to budget. PAI calls no model for these proposals.

A hosted workbench is reached through `/api/agent/*`, a read-and-propose allowlist. The client authenticates with an OAuth 2.0 client-credentials token (Cognito resource server `pai-agent`). The ALB checks the token with `jwt-validation`, and the workbench checks it again with the route's scope. Plans then carry the verified client id.

A contract test (`tests/agentforge-contract.test.ts`) keeps the profile and the MCP tool set identical.

The AgentForge side of this integration is merged ([PR #549](https://github.com/noteflowai/agentforge/pull/549), `9594430`). It lives in `examples/pai-workbench`:
- a profile installer, validated with the base `mcp-gateway` policy;
- the digest-pinned Agent Skill, provisioned through `skills-config.mjs`;
- the physical-reasoning golden task on the base `eval/` harness.


- **acpx**, through the NoteFlow executor. Version currency is maintained at that layer. AgentForge's acpx moved from 0.15.1 to 0.19.4 in [PR #548](https://github.com/noteflowai/agentforge/pull/548), merged as `d6cc5c8` after its upstream guards were re-measured and its rust, js, delivery and base-image CodeBuild runs passed. The arm64 base image was built only to a validation tag; promoting it to `:full` waits for review of its scan. The NoteFlow executor moves to acpx 0.19.4 and Kiro CLI 2.27.1 in [PR #53](https://github.com/noteflowai/noteflow-agent-control/pull/53). Its pins have one source (`config/engine-pins.json` and the lockfile), and the workbench pins only the executor commit.
- **Bedrock AgentCore** for remote isolation ([AGENTCORE.md](AGENTCORE.md)). This is the managed service that AgentForge's AgentCore backend also targets.

## Gates for an AgentForge Host channel

Adopt it only for a need the executor cannot meet, and only when every gate holds.

The multi-turn "propose → native check → revise" loop no longer depends on the Host. It runs in the workbench as the autopilot: each round is one bounded executor call on the shared ledger. The loop is bounded by a maintainer's autonomy grant. External AgentForge sessions reach the same grant through `pai_run_plan` via the governed gateway. See [INDUSTRY_BENCHMARK.md](INDUSTRY_BENCHMARK.md#5-已落地有边界的自主).

1. Admission and settlement go through the NoteFlow ledger (reserve and claim before `POST /sessions/{id}/prompt`; settle from the turn receipt), and Host budgets are off. This needs an external-admission seam in the Host or an executor-side transport. It must not be done by running two ledgers.
2. `AUTOFORGE_TURN_RETRY_MAX=0`, and an uncertain turn returns `reconcile`. The idempotency key is the ledger attempt ID.
3. Engines run with deny-all, `fs`/`terminal` disabled and an empty MCP list. Before dispatch, the workbench requires `native_tool_policy_source=attested` from `/capabilities`, or the same tool-free profile that the executor uses today.
4. An x86_64 Host image is pinned by digest, its signature is verified, and it can be obtained without credentials embedded in public CI.
5. AgentForge Live conformance has passed for real at least once on the backend in use.
6. The answer stays an untrusted text answer. The same Zod contracts, citation checks and human confirmation apply; the Host gains no authority to approve, release or transition feedback.

Until then, the fake executor in browser tests and the bounded executor everywhere else remain the only engine paths.
