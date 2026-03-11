---
name: add-spotless
description: Add Spotless persistent memory to NanoClaw. Spotless is a reverse proxy that intercepts Anthropic API calls, archives conversations, and consolidates them into memories and identity via digest passes. Use when user wants "persistent memory", "spotless", "memory across sessions", or "agent identity".
---

# Add Spotless Persistent Memory

This skill adds [Spotless](https://github.com/LabLeaks/spotless) to NanoClaw. Spotless runs as a local reverse proxy between Claude Code and the Anthropic API inside the agent container. It archives all conversations and periodically consolidates them into memories and identity facts that persist across sessions.

**What this adds:**
- Spotless proxy inside agent containers (intercepts API calls transparently)
- Persistent SQLite database shared across all groups (single agent identity)
- Automatic memory injection: `<your identity>`, `<relevant knowledge>` (digested memories)
- Scheduled digest via launchd every 15 minutes (consolidates raw events into memories)

**Architecture:**
```
Claude Agent SDK → ANTHROPIC_BASE_URL → Spotless proxy (localhost:9050)
    → augments system prompt with <spotless-orientation>
    → injects identity + selector-picked memories into user messages
    → forwards to Anthropic API
    → archives request/response to SQLite for future digests
```

**Important: Raw history replay is DISABLED.** NanoClaw's `MessageStream` handles in-session context (the SDK maintains full conversation state within a container session). Spotless's raw history reconstruction is redundant and wastes ~60% of context budget. Only digested memories and identity are injected. The patch is applied at Docker build time via `container/patches/spotless-no-history.js`.

## Prerequisites

Ask the user:

> Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key** for Spotless?
>
> Spotless's digest runs `claude -p` to consolidate memories, which needs authentication.
> Your `.env` should already have either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`.

Verify:

```bash
grep -E '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=' .env | head -1 | cut -d= -f1
```

If neither is present, tell the user to add one (refer to the `/setup` skill for how to get a token).

## Questions to Ask

1. **Agent name**: What should the agent call itself?
   - Default: "clawd"
   - This becomes the Spotless agent identifier and the "I am {name}" in identity

2. **Digest schedule**: How often should memories be consolidated?
   - Default: Every 15 minutes (via launchd `StartInterval`)
   - Less frequent (hourly) if the agent is lightly used

## 1. Install Spotless in Docker Image

Edit `container/Dockerfile`. Add after the `claude-code` global install line (`npm install -g ... @anthropic-ai/claude-code`):

```dockerfile
# Install spotless (persistent memory proxy for Claude Code)
RUN BUN_INSTALL=/usr/local bun add -g @lableaks/spotless

# Patch spotless: disable raw history replay.
# NanoClaw's MessageStream handles in-session context; Spotless digested
# memories + identity handle cross-session recall. Raw history replay
# duplicates both and wastes ~60% of context budget.
COPY patches/spotless-no-history.js /tmp/spotless-no-history.js
RUN node /tmp/spotless-no-history.js \
      "$(dirname $(readlink -f $(which spotless)))/history.ts" \
    && rm /tmp/spotless-no-history.js
```

**Important:**
- `BUN_INSTALL=/usr/local` is required. Without it, bun installs to `/home/node/.bun/bin` which isn't in the container's PATH.
- The patch script (`container/patches/spotless-no-history.js`) replaces `buildHistory()` with a stub that returns empty messages but preserves consolidation pressure calculation. This is critical — without it, Spotless replays the entire `raw_events` table as synthetic conversation turns, duplicating NanoClaw's in-session context and consuming ~60% of the context budget.

## 2. Update Entrypoint

Edit `container/scripts/entrypoint.sh`. Add these blocks **before** the final `node` command.

### 2a. Export Auth Tokens

Add after the input.json wait loop (after `fi` that checks for input.json existence):

```bash
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
```

**Why:** Spotless's digest spawns `claude -p` which needs authentication. The tokens are in `input.json` (written by the host), but the agent-runner deletes the file after reading. We must extract them into environment variables before the node process starts.

### 2b. Start Spotless Proxy

Add after the auth token block, before the final `node` command:

```bash
# Start spotless persistent memory proxy if installed
SPOTLESS_PORT=9050
SPOTLESS_AGENT="AGENT_NAME_HERE"
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
```

Replace `AGENT_NAME_HERE` with the user's chosen agent name (e.g., `clawd`).

**Key details:**
- `rm -f "$HOME/.spotless/spotless.pid"` — the PID file persists on the mounted volume across container runs. Without this, spotless refuses to start ("Already running").
- `nohup` — prevents spotless from dying when the shell hands off to `node`.
- `ANTHROPIC_BASE_URL` — the Claude Agent SDK reads this to route API calls through the proxy.
- The health check (`curl`) ensures we only set the env var if the proxy is actually running. If it fails, the agent falls back to direct API access.

## 3. Add "Primary working directory" Marker to Agent System Prompt

Edit `container/agent-runner/src/index.ts`. Find the `systemPrompt` configuration in the SDK query options and ensure it includes a `"Primary working directory:"` line.

If using the `append` field on the preset:

```typescript
systemPrompt: {
  type: 'preset' as const,
  preset: 'claude_code' as const,
  // "Primary working directory:" marker required by Spotless to classify
  // requests as main-session (not subagent). Without it, all events are
  // archived as is_subagent=1 and never digested.
  append: `\nPrimary working directory: /workspace/group\n${globalClaudeMd || ''}`,
},
```

**Why this is critical:** Spotless's classifier (`src/classifier.ts`) checks for the string `"Primary working directory:"` in the system prompt to distinguish main-session requests from subagent requests. Without it, ALL events are classified as `is_subagent=1` and the digest will never process them — resulting in 0 memories forever.

## 4. Add Shared Volume Mount

Edit `src/container-runner.ts`. Add a volume mount for the spotless SQLite database. Find where other mounts are assembled and add:

```typescript
// Mount spotless persistent memory (shared across all groups — single agent identity)
const spotlessDir = path.join(DATA_DIR, 'spotless');
fs.mkdirSync(spotlessDir, { recursive: true });
mounts.push({
  hostPath: spotlessDir,
  containerPath: '/home/node/.spotless',
  readonly: false,
});
```

**Important:** This mounts a single shared directory for all groups, giving the agent one unified identity and memory. Do NOT use per-group paths (e.g., `path.join(DATA_DIR, 'spotless', group.folder)`) — that would fragment memory across groups.

## 5. Build the Docker Image

**The entrypoint is COPY'd into the image at build time, NOT mounted from host.** Every change to `container/scripts/entrypoint.sh` requires rebuilding:

```bash
./container/build.sh
```

Verify spotless is installed:

```bash
docker run --rm --entrypoint which nanoclaw-agent:latest spotless
```

Should output `/usr/local/bin/spotless`.

## 6. Create Digest Script and Schedule

### 6a. Create the digest script

Create `scripts/spotless-digest.sh`:

```bash
#!/bin/bash
# Run spotless digest in an ephemeral container
# Called by launchd on schedule

set -e

SPOTLESS_DIR="PROJECT_ROOT/data/spotless"
ENV_FILE="PROJECT_ROOT/.env"
LOG="PROJECT_ROOT/logs/spotless-digest.log"
IMAGE="nanoclaw-agent:latest"

# Skip if no spotless data
[ -d "$SPOTLESS_DIR" ] || exit 0

# Read OAuth token from .env
OAUTH_TOKEN=""
if [ -f "$ENV_FILE" ]; then
  OAUTH_TOKEN=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d "\"'")
fi
API_KEY=""
if [ -z "$OAUTH_TOKEN" ] && [ -f "$ENV_FILE" ]; then
  API_KEY=$(grep '^ANTHROPIC_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d "\"'")
fi

if [ -z "$OAUTH_TOKEN" ] && [ -z "$API_KEY" ]; then
  echo "$(date -Iseconds) ERROR: No auth token in .env" >> "$LOG"
  exit 1
fi

AUTH_ENV=""
if [ -n "$OAUTH_TOKEN" ]; then
  AUTH_ENV="-e CLAUDE_CODE_OAUTH_TOKEN=$OAUTH_TOKEN"
else
  AUTH_ENV="-e ANTHROPIC_API_KEY=$API_KEY"
fi

echo "$(date -Iseconds) Starting digest..." >> "$LOG"

docker run --rm \
  --name spotless-digest \
  -v "$SPOTLESS_DIR:/home/node/.spotless" \
  $AUTH_ENV \
  --entrypoint bash \
  "$IMAGE" \
  -c 'rm -f $HOME/.spotless/spotless.pid; spotless digest 2>&1' \
  >> "$LOG" 2>&1

echo "$(date -Iseconds) Done" >> "$LOG"
```

Replace `PROJECT_ROOT` with the actual project path (e.g., `/Users/vwh7mb/projects/nanoclaw`).

```bash
chmod +x scripts/spotless-digest.sh
```

### 6b. Create launchd plist

Create `~/Library/LaunchAgents/com.nanoclaw.spotless-digest.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.spotless-digest</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>PROJECT_ROOT/scripts/spotless-digest.sh</string>
    </array>
    <key>StartInterval</key>
    <integer>900</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>HOME_DIR</string>
    </dict>
    <key>StandardOutPath</key>
    <string>PROJECT_ROOT/logs/spotless-digest.log</string>
    <key>StandardErrorPath</key>
    <string>PROJECT_ROOT/logs/spotless-digest.log</string>
</dict>
</plist>
```

Replace `PROJECT_ROOT` and `HOME_DIR` with actual paths.

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.spotless-digest.plist
```

## 7. Restart NanoClaw

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## 8. Verify

### 8a. Send a test message

Tell the user to send a message to the bot with some personal information (e.g., "My favorite color is blue").

### 8b. Check spotless proxy is running

```bash
CONTAINER=$(docker ps --filter "name=nanoclaw" --format '{{.Names}}' | head -1)
docker exec "$CONTAINER" cat /tmp/spotless.log
```

Expected output should include:
- `Proxy listening on http://localhost:9050`
- `Agent "AGENT_NAME" → /home/node/.spotless/agents/AGENT_NAME/spotless.db`
- `Memory suffix injected`

### 8c. Check the database

```bash
sqlite3 data/spotless/agents/AGENT_NAME/spotless.db "
  SELECT 'events: ' || count(*) FROM raw_events;
  SELECT 'main_session: ' || count(*) FROM raw_events WHERE is_subagent=0;
  SELECT 'memories: ' || count(*) FROM memories WHERE archived_at IS NULL;
"
```

Main-session events should be > 0. If all events show `is_subagent=1`, the "Primary working directory:" marker is missing from the system prompt (see Step 3).

### 8d. Run digest manually

```bash
source .env
docker run --rm \
  -v "$(pwd)/data/spotless:/home/node/.spotless" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
  --entrypoint bash \
  nanoclaw-agent:latest \
  -c 'rm -f $HOME/.spotless/spotless.pid; spotless digest 2>&1'
```

Expected: `memories: +N created` (where N > 0).

### 8e. Verify memory injection

Send another message in a new session. Check the spotless log:

```bash
CONTAINER=$(docker ps --filter "name=nanoclaw" --format '{{.Names}}' | head -1)
docker exec "$CONTAINER" cat /tmp/spotless.log
```

Should show `Memory suffix injected` and `History trace: 0 messages` (history replay is disabled by the patch — 0 is expected).

## What Spotless Injects

On every API request, spotless adds:

1. **System prompt**: `<spotless-orientation>` block explaining the memory system
2. **Memory suffix** (on user messages):
   ```xml
   <your identity>
   I am AGENT_NAME.
   - identity fact 1
   - identity fact 2
   </your identity>

   <relevant knowledge>
   memory content 1
   memory content 2
   </relevant knowledge>
   ```

**NOT injected** (disabled by patch):
- ~~History prefix~~ — raw conversation replay is disabled. NanoClaw's `MessageStream` handles in-session context; digested memories handle cross-session recall.

## Troubleshooting

### All events classified as is_subagent=1

The system prompt is missing `"Primary working directory:"`. See Step 3.

Check: `sqlite3 data/spotless/agents/AGENT_NAME/spotless.db "SELECT count(*) FROM raw_events WHERE is_subagent=0;"`

### Digest fails with "claude exited with code 1"

Auth token not reaching the `claude -p` subprocess. Check:
1. `.env` has `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
2. Entrypoint extracts it from input.json (Step 2a)
3. Image was rebuilt after entrypoint changes (Step 5)

### Spotless proxy crashes (ECONNREFUSED)

Check `/tmp/spotless.log` inside the container. Common causes:
- Stale PID file (ensure `rm -f` is in entrypoint)
- Port conflict (another process on 9050)

### 0 memories after digest

Events may be marked `consolidated=1` from a failed digest pass. Reset:
```bash
sqlite3 data/spotless/agents/AGENT_NAME/spotless.db "UPDATE raw_events SET consolidated=0 WHERE is_subagent=0;"
```
Then run digest again.

### Checking digest schedule

```bash
launchctl list | grep spotless
tail -20 logs/spotless-digest.log
```

## Removal

1. Remove spotless install from `container/Dockerfile`
2. Remove auth token extraction and spotless startup from `container/scripts/entrypoint.sh`
3. Remove `"Primary working directory:"` append from agent-runner system prompt (keep any other appended content)
4. Remove spotless volume mount from `src/container-runner.ts`
5. Unload digest schedule: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.spotless-digest.plist`
6. Delete digest plist: `rm ~/Library/LaunchAgents/com.nanoclaw.spotless-digest.plist`
7. Delete digest script: `rm scripts/spotless-digest.sh`
8. Optionally delete memory data: `rm -rf data/spotless/`
9. Rebuild image: `./container/build.sh`
10. Rebuild and restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
