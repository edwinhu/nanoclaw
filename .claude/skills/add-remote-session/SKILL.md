---
name: add-remote-session
description: Add remote session control to NanoClaw. Lets the container agent spawn full interactive Claude Code sessions on the host in wezterm panes with remote control URLs. Use when user wants "remote session", "spawn claude on host", "wezterm session", "remote control", or "agent launches claude".
---

# Add Remote Session Control

This skill adds the ability for the container agent to launch and control full interactive Claude Code sessions on the host machine. Sessions run in wezterm panes with remote control enabled, giving the user a URL to control the session from their phone or browser.

**What this adds:**
- `launch_remote_session` MCP tool (container → host IPC → wezterm spawn)
- `send_session_command` MCP tool (send slash commands to running sessions)
- Shell scripts on the host for launching and controlling sessions
- Container-side skill teaching the agent when/how to use the tools

**Architecture:**
```
Container Agent → MCP tool → writes task JSON to /workspace/ipc/tasks/
    ↓
Host IPC watcher (src/ipc.ts) → reads task → executes shell script
    ↓
launch-remote.sh → wezterm cli spawn → polls for remote control URL
    ↓
Result JSON written to /workspace/ipc/results/ → MCP tool reads it
```

## Prerequisites

1. **wezterm** must be installed and running on the host (used as terminal multiplexer)
2. **Claude Code** must be installed globally on the host (`claude` CLI)
3. **Remote control** must be enabled in Claude Code config ("Enable Remote Control for all sessions" = true)

Verify:

```bash
wezterm cli list >/dev/null 2>&1 && echo "wezterm OK" || echo "wezterm not available"
which claude && echo "claude OK" || echo "claude not installed"
```

## 1. Create Host Shell Scripts

### 1a. Launch script

Create `~/.claude/skills/remote-session/scripts/launch-remote.sh`:

```bash
#!/usr/bin/env bash
# Launch a full interactive Claude Code session in a wezterm pane.
# Remote control auto-enables via user config.
# Returns JSON with pane ID and remote control URL.

set -euo pipefail

PROJECT_DIR=""
SESSION_NAME=""
MUX=""
POLL_TIMEOUT=45
RESUME=""
EXTRA_FLAGS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-dir) PROJECT_DIR="$2"; shift 2 ;;
    --name) SESSION_NAME="$2"; shift 2 ;;
    --mux) MUX="$2"; shift 2 ;;
    --timeout) POLL_TIMEOUT="$2"; shift 2 ;;
    --resume) RESUME="$2"; shift 2 ;;
    --extra) EXTRA_FLAGS="$2"; shift 2 ;;
    *) echo '{"status":"error","error":"Unknown argument: '"$1"'"}'; exit 1 ;;
  esac
done

if [[ -z "$PROJECT_DIR" ]]; then
  echo '{"status":"error","error":"--project-dir is required"}'
  exit 1
fi

# Skip directory validation when called from container (can't verify host paths)
# Uncomment for direct host usage:
# if [[ ! -d "$PROJECT_DIR" ]]; then
#   echo '{"status":"error","error":"Directory does not exist: '"$PROJECT_DIR"'"}'
#   exit 1
# fi

if [[ -z "$SESSION_NAME" ]]; then
  SESSION_NAME="$(basename "$PROJECT_DIR")"
fi

# Detect multiplexer
detect_mux() {
  if [[ -n "$MUX" ]]; then echo "$MUX"; return; fi
  if command -v wezterm &>/dev/null && wezterm cli list &>/dev/null 2>&1; then
    echo "wezterm"; return
  fi
  if command -v zellij &>/dev/null; then echo "zellij"; return; fi
  echo ""
}

DETECTED_MUX="$(detect_mux)"
if [[ -z "$DETECTED_MUX" ]]; then
  echo '{"status":"error","error":"No multiplexer available. Install wezterm or zellij."}'
  exit 1
fi

# Build claude command
CLAUDE_CMD="unset CLAUDECODE; claude --dangerously-skip-permissions"
if [[ -n "$RESUME" ]]; then CLAUDE_CMD="$CLAUDE_CMD --resume \"$RESUME\""; fi
if [[ -n "$EXTRA_FLAGS" ]]; then CLAUDE_CMD="$CLAUDE_CMD $EXTRA_FLAGS"; fi

# Spawn the session
PANE_ID=""
case "$DETECTED_MUX" in
  wezterm)
    PANE_ID="$(wezterm cli spawn --cwd "$PROJECT_DIR" -- bash -c "$CLAUDE_CMD")"
    ;;
  zellij)
    ZELLIJ_SESSION="claude-session-$$"
    zellij --session "$ZELLIJ_SESSION" run --close-on-exit -- bash -c "$CLAUDE_CMD" &
    PANE_ID="$ZELLIJ_SESSION"
    sleep 1
    ;;
esac

# Poll for remote control URL
URL=""
ELAPSED=0
URL_PATTERN='https://claude\.ai/code/[A-Za-z0-9_?=&-]+'

while [[ $ELAPSED -lt $POLL_TIMEOUT ]]; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  if [[ "$DETECTED_MUX" == "wezterm" && -n "$PANE_ID" ]]; then
    URL="$(wezterm cli get-text --pane-id "$PANE_ID" 2>/dev/null \
      | grep -oE "$URL_PATTERN" 2>/dev/null | head -1 || true)"
  fi
  if [[ -n "$URL" ]]; then break; fi
done

# Output result
if [[ -n "$URL" ]]; then
  echo "{\"status\":\"ok\",\"url\":\"$URL\",\"pane_id\":\"$PANE_ID\",\"multiplexer\":\"$DETECTED_MUX\",\"project_dir\":\"$PROJECT_DIR\"}"
else
  echo "{\"status\":\"ok\",\"url\":null,\"message\":\"Session started but URL not captured. Use /rc in the pane.\",\"pane_id\":\"$PANE_ID\",\"multiplexer\":\"$DETECTED_MUX\",\"project_dir\":\"$PROJECT_DIR\"}"
fi
```

### 1b. Send command script

Create `~/.claude/skills/remote-session/scripts/send-command.sh`:

```bash
#!/usr/bin/env bash
# Send a command to a Claude Code session running in a wezterm pane.
# If no pane ID given, auto-detects first Claude Code pane.

set -euo pipefail

PANE_ID=""
COMMAND=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pane-id) PANE_ID="$2"; shift 2 ;;
    *) COMMAND="$1"; shift ;;
  esac
done

if [[ -z "$COMMAND" ]]; then
  echo '{"status":"error","error":"No command provided"}'
  exit 1
fi

# Auto-detect pane if not specified
if [[ -z "$PANE_ID" ]]; then
  # Find first pane running claude
  PANE_ID="$(wezterm cli list --format json 2>/dev/null \
    | jq -r '.[] | select(.title | test("claude|Claude")) | .pane_id' \
    | head -1 || true)"
  if [[ -z "$PANE_ID" ]]; then
    echo '{"status":"error","error":"No Claude Code pane found. Specify --pane-id."}'
    exit 1
  fi
fi

# Send the command by writing text to the pane
# Add newline to submit
printf '%s\r' "$COMMAND" | wezterm cli send-text --pane-id "$PANE_ID" --no-paste

echo "{\"status\":\"ok\",\"pane_id\":\"$PANE_ID\",\"command\":\"$COMMAND\"}"
```

Make both executable:

```bash
chmod +x ~/.claude/skills/remote-session/scripts/launch-remote.sh
chmod +x ~/.claude/skills/remote-session/scripts/send-command.sh
```

## 2. Add MCP Tools to Container Agent

Edit `container/agent-runner/src/ipc-mcp-stdio.ts`. Add two new MCP tool registrations.

### 2a. launch_remote_session tool

Add after the existing `launch_companion` tool:

```typescript
server.tool(
  'launch_remote_session',
  `Launch a full interactive Claude Code session in a wezterm pane on the host machine. Remote control auto-enables, providing a URL the user can open on their phone or browser.

The session is fully interactive from both the wezterm TUI and the remote control URL.

IMPORTANT: project_dir must be the HOST filesystem path (e.g., "/Users/username/projects/myproject"), not the container path. Do NOT try to validate the path — it only exists on the host, not in the container. Just pass it directly.`,
  {
    project_dir: z.string().describe('Absolute host path to the project directory'),
    session_name: z.string().optional().describe('Human-readable name for the session'),
    resume: z.string().optional().describe('Session ID to resume'),
    extra: z.string().optional().describe('Additional claude CLI flags'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can launch remote sessions.' }],
        isError: true,
      };
    }

    const requestId = `rs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data: Record<string, unknown> = {
      type: 'launch_remote_session',
      requestId,
      projectDir: args.project_dir,
      timestamp: new Date().toISOString(),
    };
    if (args.session_name) data.sessionName = args.session_name;
    if (args.resume) data.resume = args.resume;
    if (args.extra) data.extra = args.extra;

    writeIpcFile(TASKS_DIR, data);

    // Poll for response (up to 2 min — session startup takes time)
    const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
    const pollInterval = 2000;
    const maxWait = 120_000;
    let elapsed = 0;

    while (elapsed < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval));
      elapsed += pollInterval;

      if (fs.existsSync(resultFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          fs.unlinkSync(resultFile);

          if (result.status === 'error') {
            return {
              content: [{ type: 'text' as const, text: `Failed: ${result.error}` }],
              isError: true,
            };
          }

          let msg = `Remote session started.\nProject: ${result.project_dir}\nPane: ${result.pane_id}`;
          if (result.url) msg += `\nURL: ${result.url}`;
          return { content: [{ type: 'text' as const, text: msg }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    }

    return {
      content: [{ type: 'text' as const, text: 'Timed out waiting for session launch.' }],
      isError: true,
    };
  },
);
```

### 2b. send_session_command tool

Add after `launch_remote_session`:

```typescript
server.tool(
  'send_session_command',
  `Send a slash command or text to a Claude Code session running in a wezterm pane on the host. Use this to control remote sessions (e.g., /reload-plugins, /clear, /cost, /compact).

If pane_id is omitted, the command is sent to the first Claude Code pane found.`,
  {
    command: z.string().describe('The command to send (e.g., "/reload-plugins", "/clear")'),
    pane_id: z.string().optional().describe('Wezterm pane ID to target'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can send session commands.' }],
        isError: true,
      };
    }

    const requestId = `sc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data: Record<string, unknown> = {
      type: 'send_session_command',
      requestId,
      command: args.command,
      timestamp: new Date().toISOString(),
    };
    if (args.pane_id) data.paneId = args.pane_id;

    writeIpcFile(TASKS_DIR, data);

    // Poll for response
    const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
    const pollInterval = 1000;
    const maxWait = 15_000;
    let elapsed = 0;

    while (elapsed < maxWait) {
      await new Promise((r) => setTimeout(r, pollInterval));
      elapsed += pollInterval;

      if (fs.existsSync(resultFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          fs.unlinkSync(resultFile);

          if (result.status === 'error') {
            return {
              content: [{ type: 'text' as const, text: `Failed: ${result.error}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: 'text' as const, text: `Sent "${args.command}" to pane ${result.pane_id}` }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    }

    return {
      content: [{ type: 'text' as const, text: 'Timed out waiting for send_session_command result.' }],
      isError: true,
    };
  },
);
```

## 3. Add Host-Side IPC Handlers

Edit `src/ipc.ts`. Add handlers for both task types in the `processTaskIpc` switch statement.

### 3a. launch_remote_session handler

```typescript
case 'launch_remote_session': {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized launch_remote_session attempt blocked');
    break;
  }
  if (!data.requestId || !data.projectDir) {
    logger.warn({ data }, 'Invalid launch_remote_session request');
    break;
  }

  const resultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultFile = path.join(resultsDir, `${data.requestId}.json`);

  try {
    const launchScript = path.join(
      process.env.HOME || '/Users/user',
      '.claude/skills/remote-session/scripts/launch-remote.sh',
    );
    const args = ['--project-dir', data.projectDir];
    if (data.sessionName) args.push('--name', data.sessionName);
    if (data.resume) args.push('--resume', data.resume);
    if (data.extra) args.push('--extra', data.extra);
    if (data.timeout) args.push('--timeout', String(data.timeout));

    const cmd = ['bash', launchScript, ...args]
      .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
      .join(' ');

    let output: string;
    try {
      output = execSync(cmd, {
        timeout: 120_000,
        encoding: 'utf-8',
        env: {
          ...process.env,
          CLAUDECODE: '',
          PATH: `${process.env.HOME}/.nix-profile/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
        },
      }).trim();
    } catch (execErr: any) {
      // Script may output JSON even on non-zero exit
      output = (execErr.stdout || '').toString().trim();
      if (!output) throw execErr;
    }

    const result = JSON.parse(output);
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
    logger.info({ requestId: data.requestId, result }, 'Remote session launched via IPC');
  } catch (err) {
    const errorResult = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
    fs.writeFileSync(resultFile, JSON.stringify(errorResult, null, 2));
    logger.error({ requestId: data.requestId, err }, 'Failed to launch remote session');
  }
  break;
}
```

### 3b. send_session_command handler

```typescript
case 'send_session_command': {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized send_session_command attempt blocked');
    break;
  }
  if (!data.requestId || !data.command) {
    logger.warn({ data }, 'Invalid send_session_command request');
    break;
  }

  const scResultsDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'results');
  fs.mkdirSync(scResultsDir, { recursive: true });
  const scResultFile = path.join(scResultsDir, `${data.requestId}.json`);

  try {
    const sendScript = path.join(
      process.env.HOME || '/Users/user',
      '.claude/skills/remote-session/scripts/send-command.sh',
    );
    const args = [data.command];
    if (data.paneId) args.unshift('--pane-id', data.paneId);

    const cmd = ['bash', sendScript, ...args]
      .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
      .join(' ');

    let output: string;
    try {
      output = execSync(cmd, {
        timeout: 15_000,
        encoding: 'utf-8',
        env: {
          ...process.env,
          PATH: `${process.env.HOME}/.nix-profile/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
        },
      }).trim();
    } catch (execErr: any) {
      output = (execErr.stdout || '').toString().trim();
      if (!output) throw execErr;
    }

    const result = JSON.parse(output);
    fs.writeFileSync(scResultFile, JSON.stringify(result, null, 2));
    logger.info({ requestId: data.requestId, result }, 'Session command sent via IPC');
  } catch (err) {
    const errorResult = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
    fs.writeFileSync(scResultFile, JSON.stringify(errorResult, null, 2));
    logger.error({ requestId: data.requestId, err }, 'Failed to send session command');
  }
  break;
}
```

Also add `command` and `paneId` to the `data` type definition in `processTaskIpc`:

```typescript
data: {
  type: string;
  // ... existing fields ...
  command?: string;
  paneId?: string;
},
```

## 4. Add Container-Side Skill

Create `container/skills/remote-session/SKILL.md` (this gets synced into the container so the agent knows how to use the tools):

```markdown
---
name: remote-session
description: Launch and control full interactive Claude Code sessions on the host via wezterm. Use when the user asks to "start remote session", "launch remote claude", "remote control session", or needs a long-running interactive session.
---

# Remote Session Launcher

Start a full interactive `claude --dangerously-skip-permissions` session in a wezterm pane on the host. Remote control auto-activates, providing a URL for phone/browser access.

## Prerequisites

Remote control must be enabled for all sessions via `/config` in Claude Code.

## Usage

### Launch a session

Use the `launch_remote_session` MCP tool:

- **project_dir** (required): HOST path (e.g., `/Users/username/projects/myproject`)
- **session_name** (optional): Human-readable name
- **resume** (optional): Session ID to resume
- **extra** (optional): Additional claude CLI flags

### Send commands to a session

Use the `send_session_command` MCP tool:

- **command** (required): The command to send (e.g., "/reload-plugins", "/clear")
- **pane_id** (optional): Wezterm pane ID (auto-detects if omitted)

## Red Flags

- **Using container path (`/workspace/`)** → STOP. Must be HOST path (`/Users/...`).
- **Validating path existence** → STOP. Path only exists on host, not in container.
```

## 5. Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

The container-side MCP tools are in agent-runner source (mounted from host), so they take effect immediately. The host-side IPC handlers require a rebuild of `src/ipc.ts`.

## 6. Verify

### 6a. Test launch

Send a message to the bot like: "Launch a remote session on nanoclaw"

The agent should call `launch_remote_session` with `project_dir: "/Users/username/projects/nanoclaw"` and return a remote control URL.

### 6b. Test send command

"Send /cost to the remote session"

The agent should call `send_session_command` with `command: "/cost"`.

### 6c. Check logs

```bash
rg "Remote session\|Session command" logs/nanoclaw.log | tail -5
```

## Troubleshooting

### "No multiplexer available"

wezterm is not running or `wezterm cli` can't connect. Ensure wezterm is open and the CLI is accessible:

```bash
wezterm cli list
```

### URL not captured

Remote control may not be enabled. In a Claude Code session, run `/config` and enable "Enable Remote Control for all sessions".

### Timeout waiting for session launch

The launch script polls for up to 45 seconds for the remote control URL. If Claude Code takes longer to start, increase `--timeout` in the launch script or the `maxWait` in the MCP tool.

### "Only the main group can launch remote sessions"

Remote session control is restricted to the main group for security. Non-main groups cannot spawn processes on the host.

## Removal

1. Remove `launch_remote_session` and `send_session_command` tool registrations from `container/agent-runner/src/ipc-mcp-stdio.ts`
2. Remove both case handlers from `src/ipc.ts`
3. Remove `command` and `paneId` from the data type in `processTaskIpc`
4. Delete `container/skills/remote-session/SKILL.md`
5. Optionally delete host scripts: `rm -rf ~/.claude/skills/remote-session/`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
