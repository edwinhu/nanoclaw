#!/bin/bash
# briefing-prefetch.sh — Fetches all daily briefing data in parallel
# Output: /tmp/briefing/*.txt files, one per section
set -euo pipefail

OUT="/tmp/briefing"
rm -rf "$OUT"
mkdir -p "$OUT"

TODAY=$(date +"%Y-%m-%d")
TOMORROW=$(date -d tomorrow +"%Y-%m-%d" 2>/dev/null || date -v+1d +"%Y-%m-%d")

# UTC window for overnight (11pm ET = 04:00 UTC, 8am ET = 13:00 UTC)
OVERNIGHT_START="${TODAY}T04:00:00"
OVERNIGHT_END="${TODAY}T13:00:00"

# --- Warm up Superhuman auth (tokens cached by entrypoint, but verify both accounts) ---
# Without this, parallel superhuman calls race on token refresh and one may fail silently
superhuman inbox --account eddyhu@gmail.com --limit 1 --json > /dev/null 2>&1 || true
superhuman inbox --account ehu@law.virginia.edu --limit 1 --json > /dev/null 2>&1 || true

# --- Launch all fetches in parallel ---
# Email: --split important (focused inbox) + --ai-label Respond (Superhuman AI "needs response")
# Together these give the intersection: important emails that need a reply.

# 1. Weather
(
  # Try wttr.in, fall back to Open-Meteo (no API key needed)
  WEATHER=$(curl -s --max-time 3 "wttr.in/Charlottesville?format=%l:+%C+%t+%w&u" 2>/dev/null || true)
  if [ -z "$WEATHER" ] || echo "$WEATHER" | grep -qi "error\|sorry\|unknown"; then
    WEATHER=$(curl -s --max-time 10 "https://api.open-meteo.com/v1/forecast?latitude=38.03&longitude=-78.48&current=temperature_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America/New_York" 2>/dev/null | jq -r '"Charlottesville: \(.current.temperature_2m)°F, wind \(.current.wind_speed_10m) mph"' 2>/dev/null || echo "Weather unavailable")
  fi
  echo "$WEATHER" > "$OUT/weather.txt"
) &

# 2. Gmail inbox (eddyhu@gmail.com) — focused inbox, exclude already-replied
(
  timeout 60 superhuman inbox --account eddyhu@gmail.com \
    --split important --needs-reply --limit 30 --json 2>/dev/null \
    > "$OUT/gmail_raw.json" || true
  if [ -s "$OUT/gmail_raw.json" ]; then
    jq '[.[] | {id: .id, subject: .subject, from: .from.name, email: .from.email, date: .date, snippet: .snippet[:200]}]' \
      "$OUT/gmail_raw.json" > "$OUT/gmail.txt" 2>/dev/null || cp "$OUT/gmail_raw.json" "$OUT/gmail.txt"
  else
    echo "[]" > "$OUT/gmail.txt"
  fi
  rm -f "$OUT/gmail_raw.json"
) &

# 3. UVA inbox (ehu@law.virginia.edu) — focused inbox, exclude already-replied
(
  timeout 60 superhuman inbox --account ehu@law.virginia.edu \
    --split important --needs-reply --limit 30 --json 2>/dev/null \
    > "$OUT/uva_raw.json" || true
  if [ -s "$OUT/uva_raw.json" ]; then
    jq '[.[] | {id: .id, subject: .subject, from: .from.name, email: .from.email, date: .date, snippet: .snippet[:200]}]' \
      "$OUT/uva_raw.json" > "$OUT/uva.txt" 2>/dev/null || cp "$OUT/uva_raw.json" "$OUT/uva.txt"
  else
    echo "[]" > "$OUT/uva.txt"
  fi
  rm -f "$OUT/uva_raw.json"
) &

# 4+5. Morgen AI: curated calendar + tasks
(
  PROMPT='For today and tomorrow: (1) What calendar events are actually important or worth preparing for? Skip routine scheduling blocks like "Eat the Frog", "Shallow Work", personal logistics, and trivial items. Also exclude any events from the rjj6@nyu.edu calendar (that is a shared NYU calendar, not mine). For important events, note what to prepare and include Zoom links if present. (2) What tasks from my task list should I consider working on today? Be concise and selective — I do not need to see everything, just what actually matters.'
  timeout 60 morgen chat "$PROMPT" 2>/dev/null > "$OUT/morgen_ai.txt" || echo "" > "$OUT/morgen_ai.txt"
) &

# 6. Obsidian tasks from last 7 days (both checked and unchecked for cross-referencing)
(
  {
    for d in $(seq 0 6); do
      f="/workspace/extra/Notes/Vault/3. Resources/Daily Notes/$(date -d "-${d} days" +"%Y-%m-%d").md"
      [ -f "$f" ] && echo "=== $(basename "$f") ===" && rg "^- \[" "$f" 2>/dev/null
    done
  } > "$OUT/obsidian_tasks.txt" 2>/dev/null || echo "" > "$OUT/obsidian_tasks.txt"
) &

# 7a. Overnight scheduled task runs
(
  sqlite3 /workspace/project/store/messages.db "SELECT substr(t.prompt, 1, 60), r.run_at, r.status, substr(r.result, 1, 200) FROM task_run_logs r JOIN scheduled_tasks t ON r.task_id = t.id WHERE r.run_at >= '$OVERNIGHT_START' AND r.run_at < '$OVERNIGHT_END' ORDER BY r.run_at;" 2>/dev/null > "$OUT/overnight_tasks.txt" || echo "" > "$OUT/overnight_tasks.txt"
) &

# 7b. Overnight messages
(
  sqlite3 /workspace/project/store/messages.db "SELECT timestamp, substr(content, 1, 200) FROM messages WHERE is_from_me = 0 AND timestamp >= '$OVERNIGHT_START' AND timestamp < '$OVERNIGHT_END' ORDER BY timestamp;" 2>/dev/null > "$OUT/overnight_messages.txt" || echo "" > "$OUT/overnight_messages.txt"
) &

# --- Wait for all ---
wait

# Summary
echo "Prefetch complete. Files:"
ls -la "$OUT"/
