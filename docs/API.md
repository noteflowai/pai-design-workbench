# Workbench API

JSON requests; unknown command/path fields are rejected. Default origin is `http://127.0.0.1:4317`.

AWS deployment uses the exact origin `https://pai.oneai.host` and requires signed ALB/Cognito claims for every workspace route. Native review and scene POSTs may return `202`, `Location: /api/runs/:id` or `/api/scenes/:id`, and `Retry-After: 2`. Poll that location until the saved state is no longer running. Polling and duplicate POSTs retain the original identity and do not launch another command. A restarted running task becomes interrupted and requires reconciliation, never automatic replay.

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Minimal health status for the ALB; no workspace data |
| `GET /logout` | Expires ALB session cookies and uses the configured Cognito logout |
| `GET /api/state` | Projects, runs, feedback, proposal/campaign states, separated pilot metrics |
| `POST /api/projects` | `{title,intendedDecision,requirements}`; freezes revision 1 |
| `PATCH /api/projects/:id` | Same fields plus `expectedRevision`; compare-and-swap revision update |
| `POST /api/projects/:id/reviews` | `{requestId,projectRevision,candidate,feedbackId?}` |
| `POST /api/projects/:id/proposals` | `{requestId,projectRevision,profiles}`; native control only when configured |
| `POST /api/projects/:id/scenes` | `{requestId,projectRevision,variant,requirements,feedbackId?}`; native Blender |
| `GET /api/scenes/:id` | Saved native scene checks, receipts and artifact digests |
| `GET /api/scenes/:id/files/:which/:file` | Closed baseline/candidate artifact list; digest checked before download |
| `GET /api/tools` | Professional tool survey; integrated/planned/survey-only states |
| `GET /api/runs/:id` | Complete saved state and native receipts |
| `GET /api/runs/:id/media/:candidate/:seed/:view` | Hash-checked original MP4, supports byte ranges |
| `POST /api/feedback` | `{runId,evidenceKind?,kind,seed,checkId?,expected,observed,actorKind}` |
| `PATCH /api/feedback/:id` | `{expectedRevision,status,reason,recheckRunId?}` |
| `GET /api/runs/:id/bundle` | Download completed evidence packet |
| `POST /api/bundles/verify` | Packet integrity and semantic consistency; no provider call |
| `POST /api/campaigns` | `{runId,evidenceKind?,channel}`; creates a draft only |
| `POST /api/events` | `{eventId,campaignId,participantId,actorKind,kind}`; idempotent actual observations |

See Zod contracts in `src/contracts.ts` and `src/proposals.ts` for the complete enumerations and bounds. A native comparison exit 1 is a valid recorded regression; non-comparable native inputs fail the review.

To document a decision to retain a failing condition, move assigned → no-change-with-reason, supplying a substantive reason. Create a review with that feedback ID and selected candidate, then link it on rechecked → closed. This path records unresolved performance under a deliberate resolution; it never changes the native outcome to success.

The UI's quick recheck follows rollback-to-reference for recorded robotics and removal of the explicit obstruction for the Blender scene recipe. Scene constraints remain unchanged. More complex repairs require separately produced native artifacts and appropriate evaluators.

Manual `independent` events are participant declarations, not independently authenticated adoption. The service does not infer exposure, conversion, causal promotion effects or purchases.
