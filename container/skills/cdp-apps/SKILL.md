---
name: cdp-apps
description: Control Superhuman, Morgen, or Chrome running on the host machine via Chrome DevTools Protocol. Use this to read emails, manage calendar, or interact with web apps that are already logged in on the host. Triggers on "check email", "superhuman", "morgen", "calendar", "schedule meeting", or when you need to interact with desktop apps.
allowed-tools: Bash(cdp-browser:*)
---

# CDP App Control

Control desktop apps (Superhuman, Morgen, Chrome) running on the host machine via CDP.

## Quick Start

```bash
# 1. Check if app is available
cdp-browser superhuman check

# 2. Get WebSocket endpoint
WS=$(cdp-browser superhuman ws)

# 3. Connect with Playwright
node -e "
const playwright = require('playwright');
(async () => {
  const browser = await playwright.chromium.connectOverCDP('${WS}');
  const contexts = browser.contexts();
  const page = contexts[0].pages()[0];

  // Now you can control the actual app!
  console.log(await page.title());
  await page.screenshot({ path: '/tmp/screenshot.png' });
})();
"
```

## Available Apps

| App | Port | Use For |
|-----|------|---------|
| `superhuman` | 9333 | Email management |
| `morgen` | 9334 | Calendar, scheduling |
| `chrome` | 9222 | Web browsing (if started with CDP) |

## Commands

### Check Connectivity

```bash
cdp-browser superhuman check
# Output:
# ✓ superhuman CDP endpoint reachable at http://host.docker.internal:9333
# Browser: Chrome/130.0.0.0
# WebSocket: ws://host.docker.internal:9333/devtools/browser/...
```

### Get WebSocket URL

```bash
cdp-browser superhuman ws
# ws://host.docker.internal:9333/devtools/browser/abc-123
```

### List Pages/Tabs

```bash
cdp-browser morgen pages
# Pages in morgen:
# [0] Morgen - Calendar
#     URL: https://app.morgen.so/calendar
#     WS:  ws://host.docker.internal:9334/devtools/page/xyz-456
```

## Playwright Integration

### Basic Page Control

```javascript
const playwright = require('playwright');

async function controlApp(appName) {
  const { execSync } = require('child_process');

  // Get WebSocket endpoint
  const ws = execSync(`cdp-browser ${appName} ws`).toString().trim();

  // Connect to existing app
  const browser = await playwright.chromium.connectOverCDP(ws);
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  return { browser, context, page };
}

// Example: Read Superhuman inbox
const { page } = await controlApp('superhuman');
await page.waitForSelector('[data-test-id="inbox"]');
const emails = await page.$$eval('[data-test-id="email-item"]', els =>
  els.map(el => ({
    subject: el.querySelector('.subject').textContent,
    from: el.querySelector('.from').textContent,
  }))
);
console.log(emails);
```

### Calendar Example (Morgen)

```javascript
const { page } = await controlApp('morgen');

// Navigate to today
await page.click('[aria-label="Today"]');

// Get today's events
const events = await page.$$eval('.event', els =>
  els.map(el => ({
    title: el.querySelector('.title').textContent,
    time: el.querySelector('.time').textContent,
  }))
);

console.log('Today\'s events:', events);
```

## Common Patterns

### 1. Take Screenshot for Analysis

```bash
WS=$(cdp-browser superhuman ws)
node -e "
const playwright = require('playwright');
(async () => {
  const browser = await playwright.chromium.connectOverCDP('$WS');
  const page = browser.contexts()[0].pages()[0];
  await page.screenshot({ path: '/workspace/group/screenshot.png' });
  console.log('Screenshot saved');
})();
"
```

### 2. Extract Text Content

```bash
WS=$(cdp-browser superhuman ws)
node -e "
const playwright = require('playwright');
(async () => {
  const browser = await playwright.chromium.connectOverCDP('$WS');
  const page = browser.contexts()[0].pages()[0];
  const content = await page.textContent('body');
  console.log(content);
})();
"
```

### 3. Click and Type

```bash
WS=$(cdp-browser morgen ws)
node -e "
const playwright = require('playwright');
(async () => {
  const browser = await playwright.chromium.connectOverCDP('$WS');
  const page = browser.contexts()[0].pages()[0];

  // Click new event button
  await page.click('[aria-label=\"New event\"]');

  // Fill in details
  await page.fill('input[name=\"title\"]', 'Team Meeting');
  await page.fill('input[name=\"time\"]', '2pm');

  // Save
  await page.click('button[type=\"submit\"]');
})();
"
```

## Error Handling

If `cdp-browser` reports the app is not reachable:

1. **On host machine**, launch the app with CDP enabled:
   ```bash
   ~/projects/nanoclaw/scripts/launch-superhuman-cdp.sh
   # or
   ~/projects/nanoclaw/scripts/launch-morgen-cdp.sh
   ```

2. **Verify** the app is running:
   ```bash
   curl http://localhost:9333/json/version  # Superhuman
   curl http://localhost:9334/json/version  # Morgen
   ```

3. **From container**, check again:
   ```bash
   cdp-browser superhuman check
   ```

## Important Notes

- **No authentication needed** - apps are already logged in on the host
- **Persistent sessions** - changes persist (sent emails stay sent, events stay created)
- **Real-time** - you see what the app sees, including new emails/events
- **Read-only by default** - be careful with writes (sending emails, creating events)
- **One connection at a time** - CDP can have multiple clients, but coordinate carefully

## Security

- CDP ports (9333, 9334) are only accessible from localhost/Docker
- No external network access to these ports
- Apps run with your host user's full permissions
- Container can do anything you could do in the app

## Troubleshooting

**"Cannot reach CDP endpoint"**
- App not running with CDP flag
- Run launch script: `~/projects/nanoclaw/scripts/launch-superhuman-cdp.sh`

**"Browser closed" error**
- User quit the app
- Relaunch with CDP enabled

**Page not found**
- App may have multiple pages/tabs
- Use `cdp-browser superhuman pages` to list all pages
- Connect to specific page WebSocket URL

**Selector not found**
- App UI changed or still loading
- Use `page.waitForSelector()` before interacting
- Take screenshot to debug: `page.screenshot({ path: '/tmp/debug.png' })`
