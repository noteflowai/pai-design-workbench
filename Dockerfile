# syntax=docker/dockerfile:1.7
# PAI Design Workbench — single image: workbench, NoteFlow bounded executor and the Kiro CLI it pins (tools/runtime-pins.json),
# Codex/Claude ACP adapters, Blender 5.2.2 LTS, CadQuery 2.8 / OCCT 7.9 and the pinned demo evidence.
# Every download is checked against tools/runtime-pins.json or a hash-locked requirements file.
# Credentials are never part of the image: mount them read-only at runtime (see docs/CONTAINER.md).
#
#   python3 tools/package_executor.py
#   docker build --build-context executor=.state/deploy --build-arg PAI_UID=$(id -u) -t pai-workbench:0.4.0 .
FROM ubuntu@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3 AS app
ARG TARGETARCH
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl git xz-utils python3 && rm -rf /var/lib/apt/lists/*
COPY tools/runtime-pins.json /tmp/pins.json
RUN set -eu; arch=$([ "$TARGETARCH" = "arm64" ] && echo linux-arm64 || echo linux-x64); \
    v=$(python3 -c "import json;print(json.load(open('/tmp/pins.json'))['node']['version'])"); \
    h=$(python3 -c "import json;print(json.load(open('/tmp/pins.json'))['node']['sha256']['$arch'])"); \
    curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v$v/node-v$v-$arch.tar.xz"; echo "$h  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /opt && ln -s /opt/node-v$v-$arch /opt/node
ENV PATH=/opt/node/bin:$PATH
WORKDIR /opt/pai/app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm run setup:demo && npm prune --omit=dev && rm -rf .state/deps/*/.git

FROM ubuntu@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3
ARG PAI_UID=1001
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates curl git xz-utils unzip python3 python3-venv bubblewrap \
      libx11-6 libxfixes3 libxrender1 libxi6 libxkbcommon0 libsm6 libgl1 libegl1 libdbus-1-3 libfontconfig1 libxxf86vm1 libxext6 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && (getent passwd ${PAI_UID} | cut -d: -f1 | xargs -r userdel -r 2>/dev/null || true) \
    && useradd --uid ${PAI_UID} --create-home --home-dir /home/pai --shell /usr/sbin/nologin pai
COPY tools/runtime-pins.json /opt/pai/pins.json

# Node.js LTS (official tarball, pinned SHA-256)
RUN set -eu; arch=$([ "$TARGETARCH" = "arm64" ] && echo linux-arm64 || echo linux-x64); \
    v=$(python3 -c "import json;print(json.load(open('/opt/pai/pins.json'))['node']['version'])"); \
    h=$(python3 -c "import json;print(json.load(open('/opt/pai/pins.json'))['node']['sha256']['$arch'])"); \
    curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v$v/node-v$v-$arch.tar.xz"; echo "$h  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /opt && ln -s /opt/node-v$v-$arch /opt/node && rm /tmp/node.tar.xz
ENV PATH=/opt/node/bin:$PATH

# Blender LTS (official tarball, pinned SHA-256; no official linux-arm64 build)
RUN set -eu; if [ "$TARGETARCH" != "arm64" ]; then \
      h=$(python3 -c "import json;print(json.load(open('/opt/pai/pins.json'))['blender']['sha256']['linux-x64'])"); \
      curl -fsSL -o /tmp/blender.tar.xz https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz; \
      echo "$h  /tmp/blender.tar.xz" | sha256sum -c -; tar -xJf /tmp/blender.tar.xz -C /opt && rm /tmp/blender.tar.xz; fi

# CadQuery 2.8 / OCCT 7.9 from the hash-locked lock file
COPY native/cadquery-requirements.txt /opt/pai/cadquery-requirements.txt
RUN python3 -m venv /opt/cadquery && /opt/cadquery/bin/python -m pip install -q --no-cache-dir --no-input --require-hashes --no-deps --only-binary :all: \
      -r /opt/pai/cadquery-requirements.txt && /opt/cadquery/bin/python -W ignore -c "import cadquery as cq; assert cq.__version__ == '2.8.0'" \
    && find /opt/cadquery -name __pycache__ -prune -exec rm -rf {} +

# AI runtime: Kiro CLI (pinned) + NoteFlow executor at the pinned commit (digest-checked git archive)
COPY tools/install_ai_runtime.py /opt/pai/tools/install_ai_runtime.py
COPY tools/runtime-pins.json /opt/pai/tools/runtime-pins.json
RUN --mount=type=bind,from=executor,target=/executor \
    python3 /opt/pai/tools/install_ai_runtime.py --prefix /opt/ai --executor-tar /executor/executor.tar --link-dir /usr/local/bin \
    && rm -rf /root/.npm /opt/ai/executor/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl /opt/ai/executor/node_modules/typescript

# Workbench: built in a throwaway stage so dev dependencies and caches never reach a layer.
COPY --from=app /opt/pai/app /opt/pai/app
WORKDIR /opt/pai/app
RUN chown -R pai:pai /opt/pai/app/.state
ENV PAI_STATE=/data/state PAI_BLENDER=/opt/blender-5.2.2-linux-x64/blender PAI_CADQUERY_PYTHON=/opt/cadquery/bin/python \
    PAI_CONTROL_ROOT=/opt/ai/executor PAI_CONTROLLER_ENTRYPOINT=/opt/ai/executor/.runtime/compiled/flows/execute.js \
    PORT=4317 HOME=/home/pai
RUN install -d -o pai -g pai -m 0700 /data /data/state
USER pai
VOLUME ["/data"]
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fsS http://127.0.0.1:4317/healthz || exit 1
CMD ["node", "--env-file-if-exists=.state/demo.env", "dist/src/server.js"]
