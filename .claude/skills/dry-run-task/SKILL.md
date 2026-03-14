---
name: dry-run-task
description: "This skill should be used when 'dry run task', 'test scheduled task', 'test wrapup', 'test briefing', 'test prefetch', 'validate task output', 'why is the wrapup broken', 'task output is wrong', or when debugging any scheduled task that produces incorrect output. Runs the task's prefetch script in a live container, validates each DATA_STATUS section, diagnoses failures, fixes the script, and loops until all sections pass."
---

# Dry Run Scheduled Task

Run a scheduled task's prefetch script in a container, validate output, and fix issues in an autonomous loop.

## When to Use

- Scheduled task output is wrong, empty, or missing sections
- After modifying a prefetch script (e.g., wrapup-prefetch.sh)
- Before deploying a new scheduled task
- User says "test the wrapup", "dry run the briefing", etc.

## Step 1: Identify the Task

Find the scheduled task to test:

```bash
sqlite3 /Users/vwh7mb/projects/nanoclaw/store/messages.db \
  "SELECT id, substr(prompt, 1, 80), schedule_type, schedule_value, status FROM scheduled_tasks WHERE status = 'active';"
```

If the user specified a task (e.g., "wrapup", "briefing"), match by keyword in the prompt.

## Step 2: Find the Prefetch Script

Search the task's prompt for script paths:

```bash
sqlite3 /Users/vwh7mb/projects/nanoclaw/store/messages.db \
  "SELECT prompt FROM scheduled_tasks WHERE id = '<TASK_ID>';" | grep -oE '/workspace/project/[^ ]+\.sh'
```

Map container path to host: `/workspace/project/` → `/Users/vwh7mb/projects/nanoclaw/`

## Step 3: Run in Container (Audit-Fix Loop)

### 3a. Find or wait for a running container

```bash
docker ps --filter "name=nanoclaw-main" --format "{{.Names}}"
```

If no container is running, trigger the task:

```bash
sqlite3 /Users/vwh7mb/projects/nanoclaw/store/messages.db \
  "UPDATE scheduled_tasks SET next_run = datetime('now') WHERE id = '<TASK_ID>';"
```

Wait for a container to appear (scheduler polls every 30s):

```bash
while ! docker ps --filter "name=nanoclaw-main" --format "{{.Names}}" | grep -q nanoclaw; do sleep 5; done
```

### 3b. Execute prefetch in the container

```bash
CONTAINER=$(docker ps --filter "name=nanoclaw-main" --format "{{.Names}}" | head -1)
docker exec "$CONTAINER" bash -c '
  WRAPUP_DATE=$(TZ=America/New_York date +"%Y-%m-%d") \
  bash /workspace/project/container/scripts/<SCRIPT_NAME> 2>&1
'
```

### 3c. Validate all DATA_STATUS headers

```bash
docker exec "$CONTAINER" bash -c '
  for f in /tmp/wrapup/*.json /tmp/wrapup/*.txt; do
    [ -f "$f" ] || continue
    STATUS=$(head -1 "$f" | grep -o "DATA_STATUS: [A-Z]*" || echo "NO_HEADER")
    SIZE=$(wc -c < "$f")
    echo "$(basename "$f"): $STATUS (${SIZE} bytes)"
  done
'
```

### 3d. Diagnose failures

For each file with `DATA_STATUS: ERROR` or unexpected `DATA_STATUS: EMPTY`:

```bash
# Read the error details
docker exec "$CONTAINER" cat /tmp/wrapup/<FILE>

# Check stderr logs
docker exec "$CONTAINER" cat /tmp/wrapup/<FILE>_err.txt 2>/dev/null
```

**Common failure patterns:**

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `DATA_STATUS: ERROR` with "exit 3" | jq syntax error (jq 1.6 in container vs 1.7 on host) | Use explicit field syntax `{title: .title}` not shorthand `{title, ...}` |
| `DATA_STATUS: EMPTY` but data exists | Bash variable capture broke JSON (control chars in HTML descriptions) | Write jq output to file, not variable |
| `morgen` commands fail | CDP auth not ready | Add auth retry: `morgen tasks --json \|\| morgen auth` |
| `[: : integer expression expected` | `jq length` returned empty string | Check jq filter output, write to file first |
| Calendar shows wrong events | Missing calendar filter | Filter by calendarId using allowed calendar list |
| `date -d` fails | macOS vs GNU date | Script runs in Linux container, `-d` works there |

### 3e. Fix and re-test

1. Edit the script on the host (it's mounted at `/workspace/project/` in the container)
2. Re-run step 3b in the **same container** (the mount is live)
3. Re-validate with step 3c
4. Repeat until all sections show `DATA_STATUS: OK` or legitimately `DATA_STATUS: EMPTY`

## Step 4: Validate Output Quality

After all DATA_STATUS checks pass, inspect the actual data:

```bash
docker exec "$CONTAINER" bash -c '
  for f in /tmp/wrapup/*.json /tmp/wrapup/*.txt; do
    [ -f "$f" ] || continue
    echo "=== $(basename "$f") ==="
    head -20 "$f"
    echo ""
  done
'
```

Check:
- Calendar events are from allowed calendars only (Calendar/ehu + Gmail/eddyhu)
- Morgen routine frames (#morgen-routine) are filtered out
- Unchecked tasks show dates and content
- No control characters or broken JSON

## Step 5: Report Results

Format a summary:

```
## Dry Run Results: <task name>

| Section | Status | Details |
|---------|--------|---------|
| Calendar | ✓ OK (N events) | Filtered to Calendar+Gmail only |
| Unchecked Tasks | ✓ OK (N items) | From last 14 days of daily notes |
| Morgen Tasks | ✓ OK (N tasks) | Incomplete tasks only |
| Task Runs | ✓ OK | N runs today |
| Issues | ✗ EMPTY | No open issues found |

Fixes applied: <list any script changes made>
```

## IRON LAW: Container jq Compatibility

The container runs **jq 1.6**. The host runs **jq 1.7**.

**jq 1.6 does NOT support** mixing shorthand and explicit fields in object construction:
```
# BREAKS in 1.6:
{title, start, end, location: (.location // "")}

# WORKS in 1.6:
{title: .title, start: .start, end: .end, location: (.location // "")}
```

**Always use explicit field syntax** in scripts that run in containers.

## IRON LAW: Never Capture HTML in Bash Variables

Calendar event descriptions often contain raw HTML with control characters (U+0000-U+001F). Capturing jq output containing these in a bash variable (`VAR=$(jq ...)`) corrupts the JSON.

**Always write jq output to a file:**
```bash
# WRONG:
EVENTS=$(jq '...' input.json)
echo "$EVENTS" | jq 'length'

# RIGHT:
jq '...' input.json > output.json
jq 'length' output.json
```
