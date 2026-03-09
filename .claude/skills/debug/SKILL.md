---
name: debug
description: "This skill should be used when 'container fails', 'agent not responding', 'Docker stuck', 'container stuck in Created', 'authentication error', 'mount not working', 'check logs', 'why isn't it working', 'debug nanoclaw', 'service not starting', or when diagnosing any NanoClaw runtime issue."
---

# NanoClaw Container Debugging

## Red Flags - STOP If You Catch Yourself:

| Action | Why Wrong | Do Instead |
|--------|-----------|------------|
| About to use `container run` | Apple Containers was replaced by Docker | Use `docker run` |
| About to check `data/env/env` | Env file mount was replaced by secrets-in-JSON | Check `.env` in project root |
| About to restart service without checking Docker | Docker Desktop freezes are the #1 cause | Check `docker info` first |
| About to read code before checking logs | Logs tell you what actually happened | Read `logs/nanoclaw.log` first |

## Diagnostic Flowchart

```
Problem reported
    │
    ▼
docker info >/dev/null 2>&1
    │
    ├── FAILS → Docker Desktop frozen → See "Docker Frozen" below
    │
    ▼ OK
docker ps -a --filter "name=nanoclaw"
    │
    ├── Container "Created" (never started) → Docker can't start image → See "Docker Frozen"
    ├── Container "Up" but no response → Check container logs
    ├── No containers → Service didn't spawn one → Check nanoclaw.log
    │
    ▼
Check logs/nanoclaw.log (filter out typing noise):
    rg -v 'typing|isTyping|chatJid|roomId' logs/nanoclaw.log | tail -30
    │
    ├── "Docker is not running" → Start Docker Desktop
    ├── "Spawning container agent" but no response → Container issue
    ├── No "New messages" → Message not reaching service
    └── "Telegram message sent" → Pipeline working fine
```

## Architecture

```
Host (macOS)                          Container (Docker, Linux arm64)
──────────────────────────────────────────────────────────────────
src/index.ts                          container/agent-runner/
    │                                      │
    │ spawns Docker container              │ runs Claude Agent SDK
    │ with -v bind mounts                  │
    │                                      │
    ├── groups/{folder} ──────────> /workspace/group
    ├── data/sessions/{folder}/.claude/ ──> /home/node/.claude/
    ├── data/ipc/{folder} ─────────> /workspace/ipc
    ├── ~/Downloads ───────────────> /home/node/Downloads
    ├── (main) project root ───────> /workspace/project
    ├── (main) ~/projects ─────────> /mnt/projects (ro)
    └── (main) CLI configs ────────> /home/node/.config/* (superhuman, morgen, gh)
```

Container runs as user `node` with `HOME=/home/node`. Image: `nanoclaw-agent:latest`.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| Main app | `logs/nanoclaw.log` | Message routing, container spawning, responses |
| Main app errors | `logs/nanoclaw.error.log` | Fatal errors (Docker not running, etc.) |
| Container runs | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |

**Filter typing noise from main log:**
```bash
rg -v 'typing|isTyping|chatJid|roomId' logs/nanoclaw.log | tail -30
```

## Docker Desktop Frozen (Most Common Issue)

Docker Desktop on macOS freezes periodically — containers get stuck in "Created" state, `docker run` hangs.

```bash
# Diagnosis
docker info >/dev/null 2>&1 || echo "Docker frozen"
docker ps -a --filter "name=nanoclaw" --format '{{.Names}}\t{{.Status}}'

# Fix: kill everything and restart
pkill -9 -f "docker run"
killall -9 com.docker.backend
sleep 5
open -a Docker
sleep 20

# Verify
docker run --rm alpine echo "OK"
docker run --rm --entrypoint /bin/echo nanoclaw-agent:latest "image OK"

# Clean up and restart service
docker rm -f $(docker ps -aq --filter "name=nanoclaw") 2>/dev/null
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Nuclear option** (if above doesn't work):
```bash
killall -9 com.docker.backend
rm -rf ~/Library/Containers/com.docker.docker/Data
open -a Docker
# Wait 60s, then rebuild: ./container/build.sh
```

## Common Issues

### 1. Authentication Error

```
Invalid API key · Please run /login
```

Check `.env` has a valid token:
```bash
grep -E "CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY" .env
```

Secrets are passed via input JSON (not mounted as files). See `src/container-runner.ts:readSecrets()`.

### 2. Container Exits with Code 1

Check the container run log:
```bash
ls -t groups/*/logs/container-*.log | head -1 | xargs tail -50
```

Common causes:
- Missing auth token (see above)
- Session corruption: `rm -rf data/sessions/{group}/.claude/`
- Image stale: `./container/build.sh`

### 3. Service Not Starting

```bash
# Check service status
launchctl print gui/$(id -u)/com.nanoclaw 2>&1 | head -10

# Check error log
tail -20 logs/nanoclaw.error.log

# Restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 4. Message Not Triggering Agent

```bash
# Check message is in DB
sqlite3 store/messages.db "SELECT content, timestamp FROM messages WHERE chat_jid='tg:8571704407' ORDER BY timestamp DESC LIMIT 3"

# Check trigger pattern
grep TRIGGER_PATTERN src/config.ts
# Default: @Claude (case-sensitive)
```

### 5. Mount Issues

Verify mounts inside a running container:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/ /home/node/'
```

Check mount count in logs:
```bash
rg "mountCount" logs/nanoclaw.log | tail -3
```

## Manual Container Testing

```bash
# Interactive shell
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest

# Test Claude Code
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  claude -p "Say hello" --dangerously-skip-permissions --allowedTools ""
'

# Check CLI tools
docker run --rm nanoclaw-agent:latest superhuman --version
docker run --rm nanoclaw-agent:latest morgen --version
```

## Rebuilding

```bash
npm run build                    # Host TypeScript
./container/build.sh             # Container image
docker builder prune -f          # Clear build cache (if stale)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # Restart service
```

## Quick Diagnostic

```bash
echo "=== NanoClaw Diagnostics ==="
echo "1. Docker:"; docker info >/dev/null 2>&1 && echo "  OK" || echo "  NOT RUNNING"
echo "2. Image:"; docker images nanoclaw-agent:latest --format "  {{.Repository}}:{{.Tag}} ({{.Size}})" 2>/dev/null || echo "  MISSING"
echo "3. Service:"; launchctl print gui/$(id -u)/com.nanoclaw 2>&1 | grep "state =" | sed 's/^/  /'
echo "4. Stuck containers:"; docker ps -a --filter "name=nanoclaw" --filter "status=created" --format "  {{.Names}}" 2>/dev/null || echo "  none"
echo "5. Auth:"; grep -qE "CLAUDE_CODE_OAUTH_TOKEN=sk-|ANTHROPIC_API_KEY=sk-" .env 2>/dev/null && echo "  OK" || echo "  MISSING"
echo "6. Last log:"; rg -v 'typing|isTyping|chatJid|roomId' logs/nanoclaw.log 2>/dev/null | tail -3 | sed 's/^/  /'
```
