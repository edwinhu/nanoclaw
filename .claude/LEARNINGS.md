# Learnings

## Task 1: Write typing-api.test.ts [COMPLETE]

### What was done
- Created `tests/typing-api.test.ts` with 5 tests using Grammy's API transformer (`bot.api.config.use()`)
- Tests cover: correct params, 4s intervals, stop behavior, restart after output, full lifecycle

### Key discoveries
- Grammy does NOT use `globalThis.fetch` — it captures fetch at import time, so `vi.stubGlobal('fetch')` doesn't work
- Grammy's `bot.api.config.use()` transformer is the correct interception point — it intercepts all outgoing API calls before HTTP POST
- The transformer approach is higher-fidelity than fetch mocking: you get method name + payload directly

### Spec reviewer: COMPLIANT
### Quality reviewer: APPROVED (2 minor style notes, non-blocking)

## Task 2: Run full suite [COMPLETE]

### What was done
- Ran full Vitest suite: 5 files, 25 tests, 0 failures, 0 skipped
- Fast tests (22): typing.test.ts (9), typing-integration.test.ts (8), typing-api.test.ts (5)
- Live service tests (3): typing-cdp.test.ts (2), typing-e2e.test.ts (1)
- No regressions from new typing-api.test.ts
---
Last updated: 2026-02-09 23:05
---

[Compaction at 23:10] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-11 12:13
---

[Compaction at 12:14] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-11 12:43
---

[Compaction at 12:48] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-12 23:59
---

[Compaction at 00:06] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-13 00:46
---

[Compaction at 00:50] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-15 09:21
---

[Compaction at 09:48] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-15 11:10
---

[Compaction at 11:15] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-15 11:19
---

[Compaction at 11:40] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-15 13:01
---

[Compaction at 13:38] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-16 08:08
---

[Compaction at 08:22] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-16 10:54
---

[Compaction at 10:58] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-17 01:17
---

[Compaction at 09:26] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-19 21:20
---

[Compaction at 21:22] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-19 21:30
---

[Compaction at 21:32] (workflow: /dev) - Context was summarized
---
Last updated: 2026-02-21 19:14
---

[Compaction at 19:18] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-09 00:55
---

[Compaction at 01:02] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-10 08:29
---

[Compaction at 08:29] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-13 21:30
---

[Compaction at 21:36] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-14 19:07
---

[Compaction at 19:08] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-15 14:29
---

[Compaction at 14:47] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-15 14:51
---

[Compaction at 16:07] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-15 23:04
---

## Task: Fix `<internal>` tag leaking into Telegram [COMPLETE]

### What was done
- Root cause: `routeOutbound()` in `src/router.ts` sent text to `channel.sendMessage()` without calling `formatOutbound()`/`stripInternalTags()`. The task scheduler and IPC message paths both used `routeOutbound` directly, bypassing tag stripping.
- Fix: Made `routeOutbound()` always call `formatOutbound()` before sending, making tag stripping a guarantee at the single egress point.

### Key discovery
- The regular message path (`processGroupMessages`) manually stripped tags before calling `routeOutbound`, but the task scheduler and IPC paths did not. Defense-in-depth at the egress point prevents this class of bug.
---
Last updated: 2026-03-16 14:12
---

## Task: Regression tests for credential bugs [COMPLETE]

### What was done
- Added fs mock to credential-proxy.test.ts to prevent reading real `~/.claude/.credentials.json` (fixed 3 test failures)
- Exported `readSecrets()` from container-runner.ts (`@internal`) for direct testing
- Created `src/read-secrets.test.ts` with 5 tests covering keychain-over-.env preference
- Added 2 architectural documentation tests for Spotless proxy bypass in credential-proxy.test.ts
- Total: 7 new tests, 3 existing tests fixed

### Key discoveries
- credential-proxy.test.ts was reading real filesystem: `readFullOAuthCredentials()` reads `~/.claude/.credentials.json` with `readFileSync` from 'fs', which was not mocked. Tests passed on CI (no credentials file) but failed locally. Always mock fs in credential tests.
- Spotless bypass is an architectural limitation, not a bug to fix: Spotless hardcodes `api.anthropic.com`, so the proxy never sees its requests. The mitigation is ensuring `readSecrets()` provides the freshest token at startup.
- When mocking fs for credential-proxy tests, only mock `readFileSync` and `writeFileSync` (used by `readFullOAuthCredentials` and `saveOAuthCredentials`). Don't mock the whole module or http server creation breaks.
---
Last updated: 2026-03-16 17:20
---

[Compaction at 17:26] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-16 17:45
---

## Task: Fix 5xx retry logic not firing in credential proxy [COMPLETE]

### Root cause
Spotless (persistent memory proxy) hardcodes `const ANTHROPIC_API_URL = "https://api.anthropic.com"` in its proxy.ts. When Spotless runs inside the container, it overrides `ANTHROPIC_BASE_URL` to point to itself (`localhost:9050`), then forwards all `/v1/messages` requests directly to `api.anthropic.com`, completely bypassing the credential proxy on the host. The credential proxy's 5xx retry logic was correct but never executed because it never saw the API traffic.

### Why 401 retry DID work
The 401 retry fires for OAuth token exchange requests (`/api/oauth/claude_cli/create_api_key`), which are NOT intercepted by Spotless's `/v1/messages` handler. These go through Spotless's `forwardSimple()` path, but the credential proxy still handles them because they carry `Authorization` headers. The key insight: only `/v1/messages` calls (the ones that get 500s) were bypassing the credential proxy.

### Fix
1. `container/patches/spotless-configurable-upstream.js` — patches Spotless to read `SPOTLESS_UPSTREAM_URL` env var
2. `container/scripts/entrypoint.sh` — sets `SPOTLESS_UPSTREAM_URL=$ANTHROPIC_BASE_URL` before Spotless starts
3. `container/Dockerfile` — applies the patch at build time
4. New request chain: `SDK -> Spotless -> Credential Proxy -> Anthropic API`

### Key discovery
- Spotless hardcodes its upstream URL and has no configuration option for it
- The entrypoint.sh override of `ANTHROPIC_BASE_URL` happens AFTER `SPOTLESS_UPSTREAM_URL` is captured, so the ordering is: capture original -> start Spotless -> override
- Requires container rebuild: `docker builder prune && ./container/build.sh`

### Regression tests
- `npx vitest run src/credential-proxy.test.ts` — includes 2 new 5xx retry tests
---
Last updated: 2026-03-16 20:31
---

[Compaction at 20:36] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-17 00:33
---

[Compaction at 00:47] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-18 12:15
---

[Compaction at 12:17] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-21 17:45
---

[Compaction at 17:49] (workflow: /dev) - Context was summarized
---
Last updated: 2026-03-23 11:12
---
