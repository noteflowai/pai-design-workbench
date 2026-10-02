# Local CPU verification

`bash scripts/check_cpu.sh all` runs the same core and infrastructure checks used
by hosted CI. Install the root and infra lockfiles with `npm ci` first. The
`core` and `infra` modes retain CI's separate jobs and Node compatibility matrix.
Core includes the existing type checks, unit tests, Linux desktop contract and
web build. Infrastructure includes TypeScript and shell syntax checks.

The private Actions allowance is shared by the repository owner's account.
An explicit GitHub "job was not started" billing annotation is an admission
failure, not a completed code check. Repeated reruns do not restore that allowance.

Agent Control's `workbench-cpu` profile uses the existing Radar Docker sandbox:
an immutable source commit, pre-provisioned image, one CPU, 2 GiB memory, a
1 GiB temporary workspace, no network, no GPU or host credentials, and retained
source/toolchain-bound results. This profile explicitly allows execution inside
that bounded workspace for npm tools. The root remains read-only and `/tmp`
remains noexec. Dependency provisioning is explicit:

```bash
bash scripts/prepare_cpu_dependencies.sh /absolute/new-dependency-directory
```

The installer reuses `tools/setup_node.py` and verifies the domain's pinned
Node 24.21.0 SHA-256. The two npm lock hashes and Node identity travel in a
dependency receipt. The check stops before copying or running if a lock changed,
Node differs or dependencies already exist. Periodic checks never download tools.

This CPU profile does not run original native recording, Blender, CadQuery,
browser decoding, cloud live tests or Windows/macOS packaging. Those original
gates remain in their owning workflows. A CPU pass supplies no publication,
deployment or merge approval. Existing artifacts and unknown effects retain
their original identities.
