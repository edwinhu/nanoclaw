#!/bin/bash
# Run spotless digest in an ephemeral container
# Called by launchd every 15 minutes

set -e

SPOTLESS_DIR="/Users/vwh7mb/projects/nanoclaw/data/spotless"
ENV_FILE="/Users/vwh7mb/projects/nanoclaw/.env"
LOG="/Users/vwh7mb/projects/nanoclaw/logs/spotless-digest.log"
IMAGE="nanoclaw-agent:latest"

# Skip if no spotless data
[ -d "$SPOTLESS_DIR" ] || exit 0

# Read OAuth token from .env
OAUTH_TOKEN=""
if [ -f "$ENV_FILE" ]; then
  OAUTH_TOKEN=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d "\"'")
fi
if [ -z "$OAUTH_TOKEN" ]; then
  echo "$(date -Iseconds) ERROR: No CLAUDE_CODE_OAUTH_TOKEN in .env" >> "$LOG"
  exit 1
fi

echo "$(date -Iseconds) Starting digest..." >> "$LOG"

docker run --rm \
  --name spotless-digest \
  -v "$SPOTLESS_DIR:/home/node/.spotless" \
  -e CLAUDE_CODE_OAUTH_TOKEN="$OAUTH_TOKEN" \
  --entrypoint bash \
  "$IMAGE" \
  -c 'rm -f $HOME/.spotless/spotless.pid; spotless digest 2>&1' \
  >> "$LOG" 2>&1

echo "$(date -Iseconds) Done" >> "$LOG"
