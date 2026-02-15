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
if [ -d /mnt/projects/readwise-cli ]; then
  cd /mnt/projects/readwise-cli
  bun install --silent >/dev/null 2>&1 || true
  bun build --compile --outfile /home/node/.local/bin/readwise src/main.ts >/dev/null 2>&1 || true
fi
if [ -d /mnt/projects/obsidian-cli ]; then
  cd /mnt/projects/obsidian-cli
  bun install --silent >/dev/null 2>&1 || true
  bun build --compile --outfile /home/node/.local/bin/obsidian src/cli.ts >/dev/null 2>&1 || true
fi

# Load environment
[ -f /workspace/env-dir/env ] && export $(cat /workspace/env-dir/env | xargs)

# Refresh CLI tokens via CDP (headless Chrome running on host)
export CDP_HOST="${CDP_HOST:-host.docker.internal}"
export CDP_PORT="${CDP_PORT:-9400}"
if command -v superhuman >/dev/null 2>&1; then
  timeout 30 superhuman account auth 2>/dev/null || true
fi
if command -v morgen >/dev/null 2>&1; then
  timeout 30 morgen auth 2>/dev/null || true
fi

# Set Obsidian proxy env vars (server runs on host)
export OBSIDIAN_HOST="${OBSIDIAN_HOST:-host.docker.internal}"
export OBSIDIAN_PORT="${OBSIDIAN_PORT:-9444}"

# Compile and run agent
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
# Wait for input.json (host writes it just before docker run, but mount propagation may lag)
for i in 1 2 3 4 5; do
  [ -f /workspace/ipc/input.json ] && break
  sleep 1
done

if [ ! -f /workspace/ipc/input.json ]; then
  echo "ERROR: /workspace/ipc/input.json not found after 5s — is /workspace/ipc mounted?" >&2
  ls -la /workspace/ipc/ >&2 2>/dev/null || echo "/workspace/ipc does not exist" >&2
  exit 1
fi

node /tmp/dist/index.js < /workspace/ipc/input.json
