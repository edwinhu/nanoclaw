# Debug Hypotheses

## Bug: NanoClaw agent containers produce "Messages: 0" — query() returns empty iterable
Started: 2026-03-15T19:00

## Context
- Worked yesterday (March 14) with Docker Desktop
- Today switched to OrbStack
- OAuth token in .env was replaced with fresh token during debugging
- Proxy bind address fixed from 127.0.0.1 to 0.0.0.0 for OrbStack compatibility
- Proxy IS reachable from containers (confirmed via curl)
- OAuth token exchange returns 403: "OAuth token does not meet scope requirement org:create_api_key"
- BUT: Claude Code itself uses OAuth and works fine (this very session)
- SDK version ^0.2.34 resolves to 0.2.68 (same either way)
- Key question: why does the same OAuth mechanism work for Claude Code but not NanoClaw containers?

## What We Know
- The credential proxy is in OAuth mode (no ANTHROPIC_API_KEY in .env)
- The proxy replaces placeholder Bearer tokens with the real OAuth token
- The Agent SDK calls /api/oauth/claude_cli/create_api_key to exchange OAuth for temp API key
- That endpoint now returns 403 for this token
- Claude Code on the host works fine with OAuth (running right now)
- User insists this worked yesterday — and they're right that Claude Code uses the same SDK

## Iteration Log

### Iteration 1: Deep Auth Path Analysis (2026-03-15T21:00)

**Hypothesis:** The Agent SDK calls create_api_key because the OAuth token lacks the org:create_api_key scope, causing "Messages: 0".

**Investigation:**

1. **SDK Auth Logic (v2.1.68 bundled in SDK, v2.1.76 global CLI):**
   - When `CLAUDE_CODE_OAUTH_TOKEN` env var is set, the SDK's `z4()` function HARDCODES scopes to `["user:inference"]`
   - The `zB(scopes)` check returns TRUE (user:inference present)
   - This means the SDK uses DIRECT Bearer auth for /v1/messages, NOT the create_api_key exchange
   - The create_api_key endpoint is ONLY called during OAuth login flow (installOAuthTokens), not at runtime

2. **Host Claude Code Auth:**
   - Uses macOS keychain (`Claude Code-credentials`)
   - Token: same `sk-ant-oat01-oBqM...` token as in .env
   - Keychain scopes: `["user:inference", "user:mcp_servers", "user:profile", "user:sessions:claude_code"]`
   - Direct inference works (user:inference scope present)

3. **Container Auth Chain:**
   - Docker env: `CLAUDE_CODE_OAUTH_TOKEN=placeholder`, `ANTHROPIC_BASE_URL=http://host-gateway:3001`
   - Entrypoint extracts REAL token from input.json secrets -> exports `CLAUDE_CODE_OAUTH_TOKEN=$REAL_TOKEN`
   - Spotless starts -> overrides `ANTHROPIC_BASE_URL=http://localhost:9050/agent/clawd`
   - SDK/CLI sees real token with hardcoded `user:inference` scope
   - API calls: SDK -> Spotless (localhost:9050) -> api.anthropic.com (HARDCODED in Spotless)
   - Spotless passes Bearer headers unchanged

4. **Key Finding: Spotless bypasses credential proxy!**
   - Spotless has `const ANTHROPIC_API_URL = "https://api.anthropic.com"` HARDCODED
   - When Spotless is running, ALL API calls go directly to api.anthropic.com, NOT through the credential proxy
   - This is fine for the real token (direct Bearer works) but means the credential proxy is irrelevant when Spotless is active

5. **create_api_key 403 is a RED HERRING:**
   - The endpoint returns 403 because the token has `user:inference` scopes (not `org:create_api_key`)
   - But the SDK NEVER calls this endpoint at runtime when CLAUDE_CODE_OAUTH_TOKEN is set
   - The 403 only matters if something explicitly hits that endpoint (e.g., manual curl test)

6. **Reproduction Test:**
   - Ran a FULL entrypoint flow in a fresh container with real secrets
   - Result: **Messages: 4**, successful response, exit code 0
   - The "Messages: 0" issue could NOT be reproduced

**Result: REFUTED** - The create_api_key scope issue is NOT the cause of "Messages: 0". The SDK never calls create_api_key when CLAUDE_CODE_OAUTH_TOKEN is set. The auth chain works end-to-end.

**Possible Real Causes (to investigate next):**
- The "Messages: 0" may have been a transient issue during the Docker Desktop -> OrbStack switch (proxy unreachable briefly)
- The proxy bind address fix (127.0.0.1 -> 0.0.0.0) may have already resolved the issue
- All 20+ container logs from today (March 15) show exit code 0 and successful completion
- The issue may be resolved and no longer reproducible

### Iteration 2: Missing .claude.json (2026-03-15T20:00)

**Hypothesis:** The Claude Code CLI requires `$HOME/.claude.json` to exist. Without it, the CLI subprocess exits immediately with code 0 and zero stdout, causing the SDK's `query()` to yield 0 messages.

**Investigation:**

1. **CLI stderr capture (via manual subprocess spawn test in agent-runner):**
   ```
   Claude configuration file not found at: /home/node/.claude.json
   A backup file exists at: /home/node/.claude/backups/.claude.json.backup.1773604659280
   You can manually restore it by running: cp "..." "/home/node/.claude.json"
   ```

2. **Why .claude.json is missing every run:**
   - Container mounts `data/sessions/main/.claude` -> `/home/node/.claude` (a subdirectory)
   - CLI expects `.claude.json` at `/home/node/.claude.json` (a file at HOME root)
   - `/home/node/.claude.json` is on the ephemeral container filesystem, lost between runs
   - The CLI creates the file on first run, but it's gone next time

3. **Why writing the file fails (first fix attempt):**
   - Container runs with `--user ${hostUid}:${hostGid}` for bind-mount compatibility
   - `/home/node/` is owned by UID 1000 (`node` user inside the image)
   - Host UID is different -> `Permission denied` when writing to `/home/node/.claude.json`

4. **Fix (two-part):**
   - **Dockerfile:** Added `chmod 777 /home/node` to make home directory writable by any UID
   - **entrypoint.sh:** Added pre-flight check that restores `.claude.json` from backup or creates `{}` minimal file

5. **Verification:**
   - Retriggered wrapup task with new image
   - Container ran for 103 seconds (vs ~52s failures), sent 1404-char message to Telegram
   - New session ID assigned, exit code 0, streaming mode completed successfully

**Result: CONFIRMED AND FIXED** - Missing `.claude.json` was the root cause. The CLI exits silently (code 0, no stdout) when the config file is absent.

**Root Cause Chain:**
1. Container image rebuilt (14:55 ET) without `.claude.json` baked in
2. Every subsequent container: CLI can't find config -> exits silently -> SDK yields 0 messages -> "Messages: 0"
3. The ~52s duration pattern = 40s entrypoint overhead + instant CLI failure + 10s task close delay

**Files Changed:**
- `container/Dockerfile` — `chmod 777 /home/node` for host-UID writability
- `container/scripts/entrypoint.sh` — restore `.claude.json` from backup before running agent
- `container/agent-runner/src/index.ts` — removed debug logging added during investigation
