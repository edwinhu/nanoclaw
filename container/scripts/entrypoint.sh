#!/bin/bash
set -e

# Compile CLI tools from mounted source (host is macOS, need Linux binaries)
mkdir -p /home/node/.local/bin
export PATH="/home/node/.local/bin:$PATH"
if [ -d /mnt/projects/superhuman-cli ]; then
  cd /mnt/projects/superhuman-cli
  bun install --silent >/dev/null 2>&1 || true
  bun build --compile --outfile /home/node/.local/bin/superhuman src/cli.ts >/dev/null 2>&1 || true
fi
if [ -d /mnt/projects/morgen-cli ]; then
  cd /mnt/projects/morgen-cli
  bun install --silent >/dev/null 2>&1 || true
  bun build --compile --outfile /home/node/.local/bin/morgen src/cli.ts >/dev/null 2>&1 || true
fi

# Load environment
[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)

# Refresh Superhuman tokens via CDP (if Superhuman is running on host)
if command -v superhuman >/dev/null 2>&1; then
  export CDP_HOST="${CDP_HOST:-host.docker.internal}"
  superhuman account auth 2>/dev/null || true
fi

# Compile and run agent
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
node /tmp/dist/index.js < /workspace/ipc/input.json
