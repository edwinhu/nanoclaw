# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to Telegram (via Beeper/Matrix bridge), routes messages to Claude Agent SDK running in Docker containers. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: WhatsApp connection, message routing, IPC |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## CDP Authentication (Superhuman, Morgen)

A **headless Chrome** instance runs on the host (port 9400, profile `~/.config/nanoclaw-chrome`) with Superhuman and Morgen web apps loaded and logged in. At container startup, the entrypoint runs `superhuman account auth` and `morgen auth`, which connect to this Chrome via CDP (`host.docker.internal:9400`), evaluate JS in the app tabs to extract OAuth tokens, and cache them locally. Tokens are short-lived (~1 hour) but containers typically finish in minutes.

Key files:
- `container/scripts/entrypoint.sh` — runs auth at startup (lines 30-38)
- `superhuman-cli/src/token-api.ts` — extracts tokens from `window.GoogleAccount.credential._authData`
- Host Chrome: `Google Chrome --headless=new --user-data-dir=~/.config/nanoclaw-chrome --remote-debugging-port=9400`

This is **not** the Superhuman/Morgen Electron desktop apps — it's a separate headless Chrome with the web versions.

## Container Build Cache

Docker buildkit caches the build context aggressively. To force a clean rebuild:

```bash
docker builder prune
./container/build.sh
```

Always verify after rebuild: `docker run --rm --entrypoint wc nanoclaw-agent:latest -l /app/src/index.ts`
