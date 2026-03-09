---
name: e2e-test
description: "This skill should be used when 'run e2e test', 'test the pipeline', 'verify messages work', 'check if bot responds', 'test after changes', 'run integration test', 'does it work', or after modifying container, mounts, CLIs, or message handling code."
---

# NanoClaw E2E Test

## Red Flags - STOP If You Catch Yourself:

| Action | Why Wrong | Do Instead |
|--------|-----------|------------|
| About to run the test without checking Docker | Docker freezes are the #1 failure cause | Run prerequisites first |
| About to run with stuck containers from a previous run | Old containers block new spawns | Clean up first: `docker rm -f $(docker ps -aq --filter name=nanoclaw)` |
| About to skip service restart after code changes | Service runs the old compiled code | `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` |
| Test fails and about to re-run immediately | Same state = same failure | Diagnose first, fix root cause |

## Prerequisites (Run ALL Before Testing)

```bash
# All four must pass. If any fails, fix it before running the test.
docker info >/dev/null 2>&1 && echo "1. Docker: OK" || echo "1. Docker: FAILED - start Docker Desktop"
docker images nanoclaw-agent:latest --format "{{.Size}}" | grep -q . && echo "2. Image: OK" || echo "2. Image: MISSING - run ./container/build.sh"
launchctl print gui/$(id -u)/com.nanoclaw 2>&1 | grep -q "state = running" && echo "3. Service: OK" || echo "3. Service: NOT RUNNING - launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist"
docker ps -a --filter "name=nanoclaw" --filter "status=created" -q | grep -q . && echo "4. Stuck containers: CLEAN FIRST" || echo "4. No stuck containers: OK"
```

## Run

```bash
npx vitest run tests/e2e.test.ts
```

Takes ~50-60s. Expected output:
```
Injected test message: e2e-test-TIMESTAMP
Container spawn confirmed
Response sent confirmed
✓ processes a message and sends a response (51044ms)
```

## Failure Diagnosis

| Failure Point | Log to Check | Likely Cause |
|---------------|-------------|--------------|
| Container spawn timeout (30s) | `logs/nanoclaw.error.log` | Docker frozen or service not running |
| Response sent timeout (120s) | `docker ps -a` | Container stuck in "Created" state |
| DB error | `store/messages.db` | DB path wrong or schema missing |
| No trigger match | `src/config.ts` ASSISTANT_NAME | Test uses wrong assistant name |

**If Docker is frozen** (containers stuck in "Created"):
```bash
pkill -9 -f "docker run"
killall -9 com.docker.backend
sleep 5 && open -a Docker && sleep 20
docker rm -f $(docker ps -aq --filter "name=nanoclaw") 2>/dev/null
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 5
npx vitest run tests/e2e.test.ts  # retry
```

## What It Tests

```
DB inject (@Claude message)
    │
    ▼
NanoClaw poll loop (2s interval)
    │
    ▼
processGroupMessages()
    │
    ▼
docker run nanoclaw-agent:latest (with all mounts)
    │
    ▼
Claude Agent SDK processes message
    │
    ▼
bot.api.sendMessage() → Telegram
    │
    ▼
Log: "Telegram message sent" ← test assertion
```

## After Code Changes

Always rebuild before testing:
```bash
npm run build                    # if host code changed
./container/build.sh             # if container/Dockerfile changed
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
docker rm -f $(docker ps -aq --filter "name=nanoclaw") 2>/dev/null
npx vitest run tests/e2e.test.ts
```
