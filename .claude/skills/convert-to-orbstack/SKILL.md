---
name: convert-to-orbstack
description: Switch from Docker Desktop to OrbStack for macOS container runtime. Use when user mentions "orbstack", "switch to orbstack", "use orbstack", "replace docker desktop", "docker desktop slow", "docker desktop disk", or "TCC permission" issues. OrbStack is a drop-in Docker replacement — same CLI, same images, no code changes to container logic.
---

# Convert to OrbStack

OrbStack is a Docker-compatible macOS runtime that replaces Docker Desktop. It uses the same `docker` CLI and image format, so NanoClaw's container logic works unchanged. The main benefits: no TCC permission popups, faster disk I/O, lower resource usage.

There are three compatibility issues to address — all related to networking and filesystem differences between Docker Desktop and OrbStack.

## Prerequisites

Check if OrbStack is already installed:

```bash
orbctl version 2>/dev/null && echo "OrbStack ready" || echo "Not installed"
```

If not installed: `brew install orbstack` or download from https://orbstack.dev

## Phase 1: Pre-flight

### Check current runtime

```bash
docker info 2>/dev/null | grep -i "operating system\|server version\|context"
```

If this shows "OrbStack", you're already on OrbStack. Skip to Phase 3 (Verify).

### Stop Docker Desktop

Docker Desktop and OrbStack conflict on the `/usr/local/bin/docker` symlink. Quit Docker Desktop first:

```bash
osascript -e 'quit app "Docker Desktop"' 2>/dev/null
osascript -e 'quit app "Docker"' 2>/dev/null
# Kill any remaining Docker Desktop processes
pkill -f "Docker Desktop" 2>/dev/null || true
```

After quitting, OrbStack automatically takes over the `docker` CLI symlink. Verify:

```bash
which docker && docker info 2>/dev/null | head -5
```

## Phase 2: Apply Compatibility Fixes

OrbStack differs from Docker Desktop in three ways that affect NanoClaw:

### Fix 1: Proxy bind address

Docker Desktop routes `host.docker.internal` to `127.0.0.1` (loopback). OrbStack routes it to `0.250.250.254`. The credential proxy must bind to `0.0.0.0` to be reachable from both runtimes.

Check current state:

```bash
grep "detectProxyBindHost" src/container-runtime.ts
grep "darwin.*return" src/container-runtime.ts
```

If it returns `'127.0.0.1'` for darwin, change it to `'0.0.0.0'`:

```typescript
function detectProxyBindHost(): string {
  // OrbStack uses 0.250.250.254 for host.docker.internal (not loopback),
  // so we must bind to 0.0.0.0 on macOS to support both Docker Desktop and OrbStack.
  if (os.platform() === 'darwin') return '0.0.0.0';
  // ... rest unchanged
}
```

If it already returns `'0.0.0.0'`, this fix is already applied.

### Fix 2: Container home directory permissions

OrbStack containers run with the host user's UID (via `--user` flag), but `/home/node` is owned by UID 1000 (`node`). The Claude CLI needs to write `.claude.json` to the home directory. Without write access, the CLI exits silently with 0 messages.

Check the Dockerfile:

```bash
grep "chmod.*home/node" container/Dockerfile
```

If not present, add `chmod 777 /home/node` to the ownership setup block in `container/Dockerfile`:

```dockerfile
RUN chown -R node:node /workspace \
    && mkdir -p /home/node/.config \
    && chown -R node:node /home/node/.config \
    && chmod 777 /home/node
```

### Fix 3: Claude CLI config file

The Claude CLI requires `$HOME/.claude.json` to exist. This file lives at `/home/node/.claude.json` (outside the mounted `.claude/` directory), so it's lost between container runs. The entrypoint must restore or create it.

Check the entrypoint:

```bash
grep "claude.json" container/scripts/entrypoint.sh
```

If not present, add before the final `node` command in `container/scripts/entrypoint.sh`:

```bash
# Ensure $HOME/.claude.json exists (CLI exits silently without it).
if [ ! -f "$HOME/.claude.json" ]; then
  BACKUP=$(ls -t "$HOME/.claude/backups/.claude.json.backup."* 2>/dev/null | head -1)
  if [ -n "$BACKUP" ]; then
    cp "$BACKUP" "$HOME/.claude.json"
    echo "[entrypoint] Restored .claude.json from backup: $BACKUP" >&2
  else
    echo '{}' > "$HOME/.claude.json"
    echo "[entrypoint] Created minimal .claude.json" >&2
  fi
fi
```

## Phase 3: Build and Verify

### Rebuild

```bash
npm run build
docker builder prune -f
./container/build.sh
```

### Clear stale agent-runner cache

NanoClaw caches agent-runner source per group. After code changes, delete the cache:

```bash
rm -rf data/sessions/*/agent-runner-src/
```

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Verify proxy binding

```bash
sleep 3 && lsof -i :3001 | grep LISTEN
```

Expected: `TCP *:redwood-broker (LISTEN)` — the `*` means bound to all interfaces.

### Verify container networking

```bash
docker run --rm --entrypoint bash nanoclaw-agent:latest -c \
  'curl -sf -o /dev/null -w "HTTP %{http_code}\n" http://host.docker.internal:3001/ || echo "UNREACHABLE"'
```

Expected: `HTTP 404` (proxy responds but no route for `/`). If `UNREACHABLE`, the proxy bind fix didn't take — check that the service restarted.

### Verify end-to-end

Trigger a scheduled task or send a message via Telegram and confirm the agent responds. Check logs:

```bash
tail -20 logs/nanoclaw.log
```

Look for `Container completed` with a duration > 30s and a non-zero message length.

## Troubleshooting

**Docker Desktop keeps taking over:**
```bash
# Fully remove Docker Desktop
osascript -e 'quit app "Docker Desktop"'
# Optionally: drag Docker Desktop to Trash from /Applications
# OrbStack will reclaim the docker symlink
```

**Container can't reach host.docker.internal:**
- Verify OrbStack is running: `orbctl status`
- Verify proxy bind: `lsof -i :3001 | grep LISTEN` should show `*:redwood-broker`
- If bound to `localhost` instead of `*`, the proxy bind fix wasn't applied

**Messages: 0 in container logs:**
- Check `.claude.json` fix is in entrypoint
- Delete stale cache: `rm -rf data/sessions/*/agent-runner-src/`
- Rebuild: `./container/build.sh`

**OrbStack not in nix-darwin:**
OrbStack is installed via its own installer or Homebrew, not nix. A nix-darwin rebuild won't remove it, but it also won't manage it. This is fine — OrbStack auto-updates independently.
