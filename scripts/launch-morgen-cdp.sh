#!/bin/bash
# Launch Morgen with Chrome DevTools Protocol enabled
# This allows NanoClaw agents to control Morgen via CDP

CDP_PORT=9223

# Kill existing instance if running
pkill -f "Morgen.*remote-debugging-port" || true
sleep 1

echo "Starting Morgen with CDP on port ${CDP_PORT}..."
/Applications/Morgen.app/Contents/MacOS/Morgen \
  --remote-debugging-port=${CDP_PORT} \
  > /tmp/morgen-cdp.log 2>&1 &

echo "Morgen CDP endpoint: http://localhost:${CDP_PORT}"
echo "Logs: /tmp/morgen-cdp.log"
