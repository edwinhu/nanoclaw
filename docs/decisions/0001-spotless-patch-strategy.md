# 0001 — Spotless Persistent Memory: Patch Strategy

## Status

Accepted

## Context

NanoClaw added Spotless (v0.1.x, https://github.com/LabLeaks/spotless) for persistent agent memory across container sessions. Spotless is a 12-day-old solo project with no external contributors, 0 forks, and 5 stars.

NanoClaw runs Spotless inside Docker containers behind a credential proxy — a use case nobody else has. This setup exposed 5 SDK compatibility issues requiring runtime patches:

1. **Hardcoded upstream URL (`api.anthropic.com`)** — prevents proxy chaining through NanoClaw's credential proxy
2. **Billing header ordering** — Spotless prepends before Claude Code's required billing header at `system[0]`
3. **Beta field incompatibility** — Spotless doesn't strip `context_management`, `output_config` fields, causing 400 errors
4. **History building** — NanoClaw uses MessageStream for multi-turn; Spotless's history tracking is redundant
5. **Digest identity filter** — prevents self-referential orientation in memory digests

Two debug sessions (2026-03-16) consumed hours diagnosing 400/500 errors caused by Spotless SDK interactions.

## Decision

Maintain local patches in `container/patches/spotless-*.js`, applied at Docker build time. Do NOT fork. File upstream issues for general-interest fixes (proxy chaining, billing header ordering).

## Rationale

- Forking adds maintenance burden (merging upstream changes) for a fast-moving early project
- Patches are small, targeted, and independent — easy to drop individually if upstream fixes land
- The project may stabilize and gain contributors, making upstream fixes more likely
- If patch count grows beyond 5-6 or upstream breaks patches repeatedly, reconsider forking

## Consequences

- Must verify patches still apply after any `npm update` / Spotless version bump
- Container rebuild required after patch changes
- `spotless-debug-400.js` was removed 2026-03-17 (400 errors confirmed resolved)
- Consider adding a CI check that verifies patches apply cleanly to the installed Spotless version

## Alternatives Considered

1. **Fork Spotless** — more control but more maintenance; premature given project age
2. **Remove Spotless** — loses persistent memory capability; too valuable to drop
3. **Contribute upstream** — worth doing but can't depend on acceptance timeline
