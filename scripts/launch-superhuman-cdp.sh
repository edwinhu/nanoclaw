#!/bin/bash
# Launch Superhuman with Chrome DevTools Protocol enabled
# This allows NanoClaw agents to control Superhuman via CDP

CDP_PORT=9333

# Kill existing instance if running
pkill -f "Superhuman.*remote-debugging-port" || true
sleep 1

echo "Starting Superhuman with CDP on port ${CDP_PORT}..."
/Applications/Superhuman.app/Contents/MacOS/Superhuman \
  --remote-debugging-port=${CDP_PORT} \
  > /tmp/superhuman-cdp.log 2>&1 &

echo "Superhuman CDP endpoint: http://localhost:${CDP_PORT}"
echo "Logs: /tmp/superhuman-cdp.log"
