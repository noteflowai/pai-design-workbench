# AgentForge integration

Agents in [AgentForge](https://github.com/noteflowai/agentforge) sessions (Kiro, Claude Code, Codex and others) use the workbench through AgentForge's **governed MCP gateway**. The gateway allows the tools below per session, audits every call, rate-limits, and denies everything else. The workbench stays the only writer: proposals land in the AI assistant and run only after a maintainer confirms them.

| File | Use |
|---|---|
| `mcp-profile.json` | One entry of `AUTOFORGE_MCP_PROFILES_JSON`. Sessions select it with `mcp_profile: "pai-workbench"` |
| `skills/pai-industrial-design/` | Agent Skill: the propose → native check → revise loop and the physical-reasoning standard |
| `eval/tasks/` | Physical-reasoning golden tasks for the base `eval/` harness. Held-out CalculiX results sit in an oracle outside the agent's workspace. |
| `bundle.json` | The SHA-256 of every file above (`node scripts/agentforge-bundle.mjs`). AgentForge pins one value: this file's digest at a commit. |

This directory is the only source. AgentForge's `examples/pai-workbench` is the installer. It runs one command (`install.mjs --commit <sha> --sha256 <bundle digest>`) that checks every file against `bundle.json`, then:
- merges the profile into `AUTOFORGE_MCP_PROFILES_JSON`;
- pins the skill with the base `computeSkillDigest` into `AUTOFORGE_SKILLS_CONFIG_JSON`;
- places the eval tasks for `eval/run.mjs`.

It keeps no copy of these files, apart from a snapshot used only by its tests.

Two deployment modes:

- **Local**: Host and workbench on the same machine. `PAI_URL=http://127.0.0.1:4317`, no credential, and proposals are marked "local, self-declared name".
- **Hosted** (pai.oneai.host):
  - Set `PAI_URL=https://pai.oneai.host`, plus `PAI_AGENT_TOKEN_URL` and `PAI_AGENT_CLIENT_ID` from the stack outputs.
  - Set `PAI_AGENT_CLIENT_SECRET_FILE` to an owner-only file holding the `AgentClientSecret` value.
  - pai-mcp uses OAuth 2.0 client credentials with the `pai-agent/read` and `pai-agent/propose` scopes.
  - The ALB verifies the access token (`jwt-validation`) and the workbench verifies it again, so proposals show the verified client id.

The gateway passes its session id to pai-mcp as `AF_SESSION_ID`. The workbench shows it on the proposal, so the plan can be matched against the gateway audit log.

`npm test` (tests/agentforge-contract.test.ts) fails when the workbench adds or renames an MCP tool without classifying it in this profile.
