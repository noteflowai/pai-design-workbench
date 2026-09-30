# PAI Design Workbench

- This repo owns the local domain workbench; native tool repos and control runtime retain their responsibilities.
- Do not write to existing Robot Reel, Radar, EvalArc or NoteFlow production workspaces as a side effect.
- Keep private runtime state, prompt/answer content, credentials, SQLite, videos and browser profiles out of Git.
- Preserve request identity, requirement versions, raw native checks and failing cases. Never manufacture passing evidence, observed users or new experiments.
- Unknown native/model effects require reconciliation without automatic replay. Never create/reset a budget ledger to bypass a limit.
- `npm run check`, `npm run test:native`, and `npm run test:browser` are required for changes that affect the full workflow. Verify product layout at 390px.
- Ordinary reversible local changes are authorized. Deployment, outside messages and publication follow the user's actual authorization; no extra confirmation is required for implied local implementation.
- Domain expansion requires native executable artifacts and appropriate evaluators. Recorded simulation is not physical validation.
- Network binding requires an exact HTTPS origin and verified ALB/Cognito authentication. Cloud deployment must preserve existing WordPress listener rules and its default behavior. Never publish credentials or automatically replay interrupted native work.
