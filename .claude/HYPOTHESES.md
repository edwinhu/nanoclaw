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
