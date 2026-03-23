#!/bin/bash
set -e

# CLI binaries (superhuman, morgen, readwise, obsidian) are pre-compiled
# and baked into the image at /usr/local/bin/ — no runtime compilation needed

# Secrets are passed via input.json and handled in Node.js — no env files on disk

# --- Persistent logging setup ---
# Write detailed logs to /workspace/group/logs/ (mounted from host, survives container death)
LOG_DIR="/workspace/group/logs"
LOG_TS=$(date -u +"%Y-%m-%dT%H-%M-%S")
SPOTLESS_LOG="${LOG_DIR}/spotless-${LOG_TS}.log"
AGENT_LOG="${LOG_DIR}/agent-${LOG_TS}.log"
mkdir -p "$LOG_DIR"

log() {
  echo "[entrypoint] $(date -u +%H:%M:%S) $*" | tee -a "$AGENT_LOG" >&2
}

# Refresh CLI tokens via CDP (headless Chrome running on host)
# Chrome 146+ rejects Host: host.docker.internal on CDP HTTP endpoints.
# Resolve to IP so the Host header is an IP address (which Chrome allows).
if [ -z "$CDP_HOST" ]; then
  _RESOLVED_IP=$(getent hosts host.docker.internal 2>/dev/null | awk '{print $1}')
  export CDP_HOST="${_RESOLVED_IP:-host.docker.internal}"
fi
export CDP_PORT="${CDP_PORT:-9222}"
if command -v superhuman >/dev/null 2>&1; then
  log "Refreshing Superhuman tokens via CDP..."
  timeout 30 superhuman account auth >> "$AGENT_LOG" 2>&1 || log "WARNING: Superhuman auth failed"
fi
if command -v morgen >/dev/null 2>&1; then
  log "Refreshing Morgen tokens via CDP..."
  timeout 30 morgen auth >> "$AGENT_LOG" 2>&1 || log "WARNING: Morgen auth failed"
fi

# Set Obsidian proxy env vars (server runs on host)
export OBSIDIAN_HOST="${OBSIDIAN_HOST:-host.docker.internal}"
export OBSIDIAN_PORT="${OBSIDIAN_PORT:-9444}"

# Compile and run agent
log "Compiling agent-runner TypeScript..."
cd /app && npx tsc --outDir /tmp/dist >> "$AGENT_LOG" 2>&1
ln -s /app/node_modules /tmp/dist/node_modules
log "Compilation complete"
# Wait for input.json (host writes it just before docker run, but mount propagation may lag)
for i in 1 2 3 4 5; do
  [ -f /workspace/ipc/input.json ] && break
  sleep 1
done

if [ ! -f /workspace/ipc/input.json ]; then
  log "ERROR: /workspace/ipc/input.json not found after 5s — is /workspace/ipc mounted?"
  ls -la /workspace/ipc/ >> "$AGENT_LOG" 2>&1 || log "/workspace/ipc does not exist"
  exit 1
fi

# Export auth tokens for spotless digest (spawns `claude -p` which needs auth)
# Extract from input.json before agent-runner deletes it
_OAUTH=$(jq -r '.secrets.CLAUDE_CODE_OAUTH_TOKEN // empty' /workspace/ipc/input.json 2>/dev/null || true)
_APIKEY=$(jq -r '.secrets.ANTHROPIC_API_KEY // empty' /workspace/ipc/input.json 2>/dev/null || true)
if [ -n "$_OAUTH" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$_OAUTH"
  log "OAuth token loaded (${#_OAUTH} chars)"
elif [ -n "$_APIKEY" ]; then
  export ANTHROPIC_API_KEY="$_APIKEY"
  log "API key loaded (${#_APIKEY} chars)"
else
  log "WARNING: No auth tokens found in input.json"
fi
unset _OAUTH _APIKEY

# Start spotless persistent memory proxy if installed
SPOTLESS_PORT=9050
SPOTLESS_AGENT="clawd"
# Route Spotless through the credential proxy so its 5xx retry and token
# refresh logic applies to all API calls. ANTHROPIC_BASE_URL points to
# the host credential proxy (set by container-runner.ts).
export SPOTLESS_UPSTREAM_URL="${ANTHROPIC_BASE_URL:-https://api.anthropic.com}"
# Cap Spotless context budget at 200K tokens (upstream default is 500K).
# 200K keeps history replay useful while staying within Claude Max rate limits.
export SPOTLESS_CONTEXT_BUDGET="${SPOTLESS_CONTEXT_BUDGET:-200000}"
if [ "${DISABLE_SPOTLESS:-}" = "1" ]; then
  log "Spotless DISABLED via DISABLE_SPOTLESS=1"
elif command -v spotless >/dev/null 2>&1; then
  # Ensure spotless data dir exists (mounted from host for persistence)
  mkdir -p "$HOME/.spotless"
  # Remove stale PID file from previous container (mounted volume persists across runs)
  rm -f "$HOME/.spotless/spotless.pid"
  log "Starting Spotless proxy (port=$SPOTLESS_PORT, upstream=$SPOTLESS_UPSTREAM_URL, budget=$SPOTLESS_CONTEXT_BUDGET)..."
  # Start proxy in background — log to persistent volume, not ephemeral /tmp
  nohup spotless start --port "$SPOTLESS_PORT" >> "$SPOTLESS_LOG" 2>&1 &
  SPOTLESS_PID=$!
  sleep 2
  if kill -0 "$SPOTLESS_PID" 2>/dev/null && curl -s "http://localhost:${SPOTLESS_PORT}/" >/dev/null 2>&1; then
    export ANTHROPIC_BASE_URL="http://localhost:${SPOTLESS_PORT}/agent/${SPOTLESS_AGENT}"
    log "Spotless proxy started (PID=$SPOTLESS_PID): $ANTHROPIC_BASE_URL"
    log "Spotless log: $SPOTLESS_LOG"
  else
    log "WARNING: Spotless failed to start (PID=$SPOTLESS_PID), using direct API"
    cat "$SPOTLESS_LOG" >> "$AGENT_LOG" 2>/dev/null || true
  fi
fi

# Ensure $HOME/.claude.json exists (CLI exits silently without it).
# The file lives at $HOME/.claude.json (outside the mounted .claude/ dir),
# so it's lost between container runs. Restore from backup or create minimal.
if [ ! -f "$HOME/.claude.json" ]; then
  BACKUP=$(ls -t "$HOME/.claude/backups/.claude.json.backup."* 2>/dev/null | head -1)
  if [ -n "$BACKUP" ]; then
    cp "$BACKUP" "$HOME/.claude.json"
    log "Restored .claude.json from backup: $BACKUP"
  else
    echo '{}' > "$HOME/.claude.json"
    log "Created minimal .claude.json"
  fi
fi

log "Starting agent-runner (agent log: $AGENT_LOG, spotless log: $SPOTLESS_LOG)"
# Tee agent-runner stderr to persistent log file AND to container stderr (for docker logs)
node /tmp/dist/index.js < /workspace/ipc/input.json 2> >(tee -a "$AGENT_LOG" >&2)
