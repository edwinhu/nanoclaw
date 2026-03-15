#!/bin/bash
set -e

# CLI binaries (superhuman, morgen, readwise, obsidian) are pre-compiled
# and baked into the image at /usr/local/bin/ — no runtime compilation needed

# Secrets are passed via input.json and handled in Node.js — no env files on disk

# Refresh CLI tokens via CDP (headless Chrome running on host)
export CDP_HOST="${CDP_HOST:-host.docker.internal}"
export CDP_PORT="${CDP_PORT:-9222}"
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

# Export auth tokens for spotless digest (spawns `claude -p` which needs auth)
# Extract from input.json before agent-runner deletes it
_OAUTH=$(jq -r '.secrets.CLAUDE_CODE_OAUTH_TOKEN // empty' /workspace/ipc/input.json 2>/dev/null || true)
_APIKEY=$(jq -r '.secrets.ANTHROPIC_API_KEY // empty' /workspace/ipc/input.json 2>/dev/null || true)
if [ -n "$_OAUTH" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$_OAUTH"
  echo "[entrypoint] OAuth token loaded (${#_OAUTH} chars)" >&2
elif [ -n "$_APIKEY" ]; then
  export ANTHROPIC_API_KEY="$_APIKEY"
  echo "[entrypoint] API key loaded (${#_APIKEY} chars)" >&2
else
  echo "[entrypoint] WARNING: No auth tokens found in input.json" >&2
fi
unset _OAUTH _APIKEY

# Start spotless persistent memory proxy if installed
SPOTLESS_PORT=9050
SPOTLESS_AGENT="clawd"
if command -v spotless >/dev/null 2>&1; then
  # Ensure spotless data dir exists (mounted from host for persistence)
  mkdir -p "$HOME/.spotless"
  # Remove stale PID file from previous container (mounted volume persists across runs)
  rm -f "$HOME/.spotless/spotless.pid"
  # Start proxy in background (digest loop consolidates memories every 5min)
  nohup spotless start --port "$SPOTLESS_PORT" >> /tmp/spotless.log 2>&1 &
  SPOTLESS_PID=$!
  sleep 2
  if kill -0 "$SPOTLESS_PID" 2>/dev/null && curl -s "http://localhost:${SPOTLESS_PORT}/" >/dev/null 2>&1; then
    export ANTHROPIC_BASE_URL="http://localhost:${SPOTLESS_PORT}/agent/${SPOTLESS_AGENT}"
    echo "[entrypoint] Spotless proxy started: $ANTHROPIC_BASE_URL" >&2
  else
    echo "[entrypoint] WARNING: Spotless failed to start, using direct API" >&2
  fi
fi

# Ensure $HOME/.claude.json exists (CLI exits silently without it).
# The file lives at $HOME/.claude.json (outside the mounted .claude/ dir),
# so it's lost between container runs. Restore from backup or create minimal.
if [ ! -f "$HOME/.claude.json" ]; then
  BACKUP=$(ls -t "$HOME/.claude/backups/.claude.json.backup."* 2>/dev/null | head -1)
  if [ -n "$BACKUP" ]; then
    cp "$BACKUP" "$HOME/.claude.json"
    echo "[entrypoint] Restored .claude.json from backup: $BACKUP" >&2
  else
    echo '{}' > "$HOME/.claude.json"
    echo "[entrypoint] Created minimal .claude.json" >&2
  fi
fi

node /tmp/dist/index.js < /workspace/ipc/input.json
