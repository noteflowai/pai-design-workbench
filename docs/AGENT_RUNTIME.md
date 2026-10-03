# Agent runtime: what is reused, and when AgentForge would be adopted

Date: 2026-10-03. Status: **decided — no AgentForge Host channel yet**. Re-evaluate when the gates below hold.

## Current path (unchanged)

The workbench calls the NoteFlow bounded text executor (`src/controller.ts`). Its parts:

- Engine transport: acpx `FlowRunner`, with Kiro primary → backup → backup2, Codex and Claude.
- Accounting: the one shared SQLite admission ledger.
- Dispatch: single-use dispatch claims.
- Recovery: a run with unknown effects returns `reconcile` instead of being retried.

The workbench owns everything after that: answer validation, citations, typed plans and human confirmation.

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

## What is reused now

- **acpx**, through the NoteFlow executor. Version currency is maintained at that layer. AgentForge's acpx moved from 0.15.1 to 0.19.4 in [PR #548](https://github.com/noteflowai/agentforge/pull/548), with its upstream guards re-measured. The NoteFlow executor pins 0.19.3, and that is its owner's upgrade to make.
- **Bedrock AgentCore** for remote isolation ([AGENTCORE.md](AGENTCORE.md)). This is the managed service that AgentForge's AgentCore backend also targets.

## Gates for an AgentForge Host channel

Adopt it only for a need the executor cannot meet, and only when every gate holds. Examples of such a need: autonomous multi-turn "propose → native check → revise" loops, or governed MCP for external agents.

1. Admission and settlement go through the NoteFlow ledger (reserve and claim before `POST /sessions/{id}/prompt`; settle from the turn receipt), and Host budgets are off. This needs an external-admission seam in the Host or an executor-side transport. It must not be done by running two ledgers.
2. `AUTOFORGE_TURN_RETRY_MAX=0`, and an uncertain turn returns `reconcile`. The idempotency key is the ledger attempt ID.
3. Engines run with deny-all, `fs`/`terminal` disabled and an empty MCP list. Before dispatch, the workbench requires `native_tool_policy_source=attested` from `/capabilities`, or the same tool-free profile that the executor uses today.
4. An x86_64 Host image is pinned by digest, its signature is verified, and it can be obtained without credentials embedded in public CI.
5. AgentForge Live conformance has passed for real at least once on the backend in use.
6. The answer stays an untrusted text answer. The same Zod contracts, citation checks and human confirmation apply; the Host gains no authority to approve, release or transition feedback.

Until then, the fake executor in browser tests and the bounded executor everywhere else remain the only engine paths.
