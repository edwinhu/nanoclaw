# Debug Hypotheses

## Bug: Test coverage gaps for recurring bugs
Started: 2026-03-16T18:30

## Symptom
Four areas lack test coverage that would have caught bugs found during this session:

1. **Stale .env token bypasses keychain** — `readSecrets()` in container-runner.ts preferred `.env` token over fresh keychain token. Fixed but no regression test exists.
2. **401 retry skips refresh when expiresAt is in future** — credential-proxy.ts fixed with some tests, but gaps may remain.
3. **Spotless bypasses credential proxy** — Spotless hardcodes `api.anthropic.com`, bypassing proxy logic. No integration test.
4. **group-queue.test.ts failures** — 3 pre-existing tests failing (preemption logic).

## Goal
Write regression tests for bugs 1-3, fix the 3 failing group-queue tests, confirm full suite passes.

## Iteration Log

### Bug 1: Stale .env token bypasses keychain [TESTED]

**What was tested:** `readSecrets()` in container-runner.ts now checks keychain before returning .env token. Exported the function (`@internal`) and wrote 5 unit tests in `src/read-secrets.test.ts`:
1. Prefers keychain token over stale .env token (the regression case)
2. Falls back to .env when keychain is unavailable
3. Uses keychain even when .env has no OAuth token
4. Does not override API key with keychain token
5. Logs when keychain token differs from .env token

**Regression command:** `npx vitest run src/read-secrets.test.ts`

### Bug 2: 401 retry skips refresh when expiresAt is in future [ALREADY TESTED]

**Coverage audit:** The existing test "401 retry force-refreshes token even when expiresAt is in the future" (credential-proxy.test.ts line 253) already covers this case. It sets `expiresAt: Date.now() + 3 * 60 * 60 * 1000` and verifies the proxy retries on 401. Fixed a separate issue: the test file was reading the real `~/.claude/.credentials.json` because `fs.readFileSync` was not mocked, causing 3 test failures. Added an `fs` mock to prevent real filesystem reads.

**Regression command:** `npx vitest run src/credential-proxy.test.ts`

### Bug 3: Spotless bypasses credential proxy [DOCUMENTED + TESTED]

**What was tested:** Added 2 tests in a new `describe('spotless credential proxy bypass')` block in credential-proxy.test.ts:
1. Documents that post-exchange requests (like Spotless makes) pass through the proxy without credential injection
2. Documents that the proxy cannot refresh tokens for requests that skip it entirely

These are architectural documentation tests. The real mitigation is Bug 1 (readSecrets provides fresh keychain token at startup).

**Regression command:** `npx vitest run src/credential-proxy.test.ts`

### group-queue.test.ts: 3 preemption test failures [FIXED]

**Root cause:** `enqueueTask()` in `group-queue.ts` called `this.closeStdin(groupJid)` unconditionally whenever the container was active (line 109). The tests expected that `_close` is only written when the container is idle (`idleWaiting === true`), not when it is actively processing.

**Fix:** Gated the `closeStdin()` call on `state.idleWaiting`. When the container is busy, the task is queued in `pendingTasks` and will run either when `notifyIdle()` fires (which already checks `pendingTasks` and calls `closeStdin`) or when the container finishes (via `drainGroup`).

**Tests fixed:**
1. "does NOT preempt active container when not idle" - expects no `_close` when container is busy
2. "sendMessage resets idleWaiting so a subsequent task enqueue does not preempt" - expects no `_close` after idle reset
3. "preempts when idle arrives with pending tasks" - expects no `_close` at enqueue time, but `_close` when `notifyIdle` fires

---

## Bug: 5xx retry logic in credential proxy not firing — 500 errors pass straight through to agent
Started: 2026-03-16T17:50 EST

### Symptom
- Added retry logic (3 retries, exponential backoff 1s/2s/4s) for 5xx in `src/credential-proxy.ts`
- Code compiled, service restarted, but ZERO "Upstream 500 — retrying" log lines appear
- Container agent receives `API Error: 500 {"type":"error","error":{"type":"api_error",...}}` and exits with code 1
- The 401 retry logic in the SAME proxy DOES fire (seen in logs), so the proxy IS in the request path
- OAuth mode: after token exchange, container gets temp API key for subsequent API calls
- Key question: Does the Claude Agent SDK route ALL requests through ANTHROPIC_BASE_URL, or only the token exchange?

### Iteration Log

#### Iteration 1: Spotless proxy intercepts all /v1/messages traffic, bypassing credential proxy entirely

**Hypothesis:** The Spotless proxy (running inside the container on localhost:9050) overrides `ANTHROPIC_BASE_URL` and forwards `/v1/messages` requests directly to `api.anthropic.com` (hardcoded in its source at line 39 of proxy.ts). The credential proxy on the host never sees these requests, so its 5xx retry logic never fires.

**Prediction:** If correct, then:
1. Every container log will show "Spotless proxy started" before any 500 error
2. Spotless source code will have `api.anthropic.com` hardcoded as upstream
3. The credential proxy's 401 retry fires only for OAuth exchange requests (which use `Authorization` header), not for `/v1/messages` API calls
4. The `ANTHROPIC_BASE_URL` env var inside the container will point to `localhost:9050`, not `host.docker.internal:3001`

**Test:**
1. Check entrypoint.sh for ANTHROPIC_BASE_URL override
2. Check Spotless proxy.ts for hardcoded upstream URL
3. Check container logs for the request flow

**Result:** CONFIRMED

**Evidence:**
- `container/scripts/entrypoint.sh` line 66: `export ANTHROPIC_BASE_URL="http://localhost:${SPOTLESS_PORT}/agent/${SPOTLESS_AGENT}"` — overrides the credential proxy URL
- Spotless proxy.ts line 39: `const ANTHROPIC_API_URL = "https://api.anthropic.com"` — hardcoded, not configurable
- Every container log shows `[entrypoint] Spotless proxy started: http://localhost:9050/agent/clawd` followed by `ANTHROPIC_BASE_URL=http://localhost:9050/agent/clawd`
- All 500 errors in logs come from containers where Spotless is active
- The 401 retries in the credential proxy (lines 485046, 485216, 485233, 485675 in nanoclaw.log) correspond to OAuth exchange requests that still route through the credential proxy (because the SDK makes these before Spotless takes over, or they use the original base URL for token exchange)

**Request flow:**
```
SDK → Spotless (localhost:9050) → api.anthropic.com   [/v1/messages — 500s happen here, credential proxy never sees them]
SDK → credential proxy (host:3001) → api.anthropic.com [OAuth exchange — 401 retry works here]
```

**Files examined:**
- `container/scripts/entrypoint.sh` (line 66)
- Spotless proxy.ts inside container image (line 39: `ANTHROPIC_API_URL = "https://api.anthropic.com"`)
- `logs/nanoclaw.log` (container stderr showing Spotless active + 500 errors)
- `src/credential-proxy.ts` (retry logic is correct but unreachable for /v1/messages)

**New information learned:**
- The 5xx retry code in credential-proxy.ts is correct but architecturally unreachable when Spotless is active
- Spotless hardcodes its upstream URL — it does not chain through the credential proxy
- The fix must be in Spotless (make upstream configurable) OR in the credential proxy chain (make Spotless forward through the credential proxy instead of directly to Anthropic)

**Fix applied:**
1. Created `container/patches/spotless-configurable-upstream.js` — patches Spotless proxy.ts to read `SPOTLESS_UPSTREAM_URL` env var instead of hardcoded `api.anthropic.com`
2. Modified `container/scripts/entrypoint.sh` — sets `SPOTLESS_UPSTREAM_URL=$ANTHROPIC_BASE_URL` (credential proxy URL) before starting Spotless
3. Updated `container/Dockerfile` — applies the new patch at build time
4. Added 2 regression tests in `src/credential-proxy.test.ts`:
   - "retries on upstream 500 and returns success after recovery" — verifies 3 attempts with exponential backoff
   - "returns 500 after exhausting all retries" — verifies all 3 attempts are made before giving up
5. Updated "spotless bypass" test descriptions to reflect the new chaining architecture

**New request chain:** `SDK -> Spotless (localhost:9050) -> Credential Proxy (host:3001) -> Anthropic API`

**Regression test command:** `npx vitest run src/credential-proxy.test.ts`

---

## Bug: Session compaction not triggering — JSONL grows to 14MB / 8,719 lines over 33 days without compaction
Started: 2026-03-16T20:00 EST

### Symptom
- Session `91a342f5` created Feb 11, never compacted, grew to 14MB (8,719 lines, 2,296 user turns, 2,895 assistant turns)
- The Claude SDK has a `PreCompact` hook that should fire when context approaches limits
- The agent-runner registers this hook (line 428): `PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }]`
- But the JSONL file on disk kept growing, eventually causing API 500s on resume
- The user's host Claude Code sessions (this one) compact fine — only the container sessions don't
- Key question: Why isn't the SDK's automatic compaction firing for container sessions?

### Context
- Container uses `isSingleUserTurn=false` with `MessageStream` for multi-turn queries
- Session is resumed across container runs via `resume: sessionId` + `resumeSessionAt: resumeAt`
- Upstream NanoClaw has no session size monitoring or forced resets
- The SDK is supposed to automatically trigger compaction when approaching context limits

### Iteration Log

#### Iteration 1: Compaction IS triggering — the JSONL is append-only and never truncated [FIXED]

**Hypothesis:** The SDK's automatic compaction never fires for container sessions due to the `isSingleUserTurn=false` / `MessageStream` pattern or the short container lifecycle.

**Prediction:** If correct, the JSONL file will have zero `compact_boundary` entries.

**Result:** REFUTED — Compaction works correctly. The real problem is unbounded JSONL growth.

**Evidence:**
- The JSONL contains **10 auto-triggered compaction boundaries**, all with `trigger: "auto"` at ~167-171K tokens
- Compaction timestamps: Feb 11, Feb 14, Feb 21, Feb 27, Mar 5, Mar 7 (x2), Mar 9, Mar 12, Mar 16
- After the last compaction (line 8148), only 571 lines / ~1.1MB remain — a reasonable session size
- The JSONL is **append-only by design**: compaction adds markers but never removes old entries

**The 500 errors are NOT caused by missing compaction:**
- First 500: ~16:54 UTC. Last compaction: 17:17 UTC (AFTER first 500)
- 500s continued after compaction (17:40, 17:47, 18:11, 18:32, 18:37, 19:22, 19:48)
- Root cause was the Spotless proxy bypass (fixed separately above)

**SDK session loading analysis:**
The CLI has `CLAUDE_CODE_SKIP_PRECOMPACT_LOAD` (only active at >100MB). Below that, the full file is loaded, parsed into a Map, then sliced to post-compact entries via `Mv()`. Functionally correct but wasteful for a 14MB file.

**Fix applied:**
- Added `truncateSessionJsonl()` in `src/container-runner.ts` — runs after each container exit
- When JSONL > 2MB, rewrites file to only keep entries from the last `compact_boundary` onward
- Safe because the SDK does the same slicing in memory

**Regression command:** `npx vitest run src/session-truncation.test.ts` (7 tests)
