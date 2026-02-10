/**
 * E2E test: Persistent typing indicator
 *
 * Verifies the typing indicator persists by:
 * 1. Sending a message to the bot via Beeper (CDP)
 * 2. Monitoring nanoclaw logs for repeated "Telegram typing indicator sent" entries
 * 3. Asserting the indicator fires every ~4s for the duration of agent processing
 *
 * Prerequisites:
 *   - Beeper Desktop running with --remote-debugging-port=9334
 *   - NanoClaw service running with typing log enabled in telegram.ts
 *   - Bot's Telegram chat ("Clawd") accessible in Beeper
 *
 * Run:  npx vitest run tests/typing-e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync } from 'fs';

const CDP_URL = 'http://localhost:9334';
const CHAT_NAME = 'Clawd';
const LOG_FILE = `${process.env.HOME}/projects/nanoclaw/logs/nanoclaw.log`;
const TRIGGER_MSG =
  'Write me a detailed 5-paragraph essay about the history of typewriters and how they influenced modern computing. Be thorough.';

/**
 * Count typing indicator log entries within a time window.
 * Checks for lines with timestamps between startTs and endTs (HH:MM:SS format).
 */
function countTypingLogsInWindow(
  startTs: string,
  endTs: string,
): { count: number; timestamps: string[] } {
  const log = readFileSync(LOG_FILE, 'utf-8');
  const lines = log.split('\n');
  const timestamps: string[] = [];
  for (const line of lines) {
    if (!line.includes('Telegram typing indicator sent')) continue;
    const match = line.match(/\[(\d{2}:\d{2}:\d{2}\.\d{3})\]/);
    if (!match) continue;
    const ts = match[1];
    if (ts >= startTs && ts <= endTs) {
      timestamps.push(ts);
    }
  }
  return { count: timestamps.length, timestamps };
}

function logTimestamp(): string {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => n.toString().padStart(2, '0'))
    .join(':');
}

function tsToMs(ts: string): number {
  const [h, m, rest] = ts.split(':');
  const [s, ms] = rest.split('.');
  return (+h * 3600 + +m * 60 + +s) * 1000 + +ms;
}

describe('Persistent Typing Indicator E2E', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.connectOverCDP(CDP_URL);
    page = browser.contexts()[0].pages()[0];
    expect(page).toBeDefined();

    // Ensure the Clawd chat is open (click it if found)
    await page.evaluate((chatName) => {
      const sections = document.querySelectorAll(
        'section, [class*="ThreadListItem"], [class*="PinnedThreadListItem"]',
      );
      for (const section of sections) {
        if (section.textContent?.includes(chatName)) {
          (section as HTMLElement).click();
          return;
        }
      }
    }, CHAT_NAME);
    await page.waitForTimeout(2000);
  }, 30_000);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  it('should send repeated typing indicators while agent processes', async () => {
    // Ensure composer is available
    const composer = await page.$('[role="textbox"], .ProseMirror');
    expect(composer).not.toBeNull();

    const startTs = logTimestamp();
    await composer!.click();
    await composer!.type(TRIGGER_MSG);
    await page.keyboard.press('Enter');
    console.log(`Message sent at ${startTs}`);

    // Wait for bot to process (poll interval + container spawn + agent work)
    await page.waitForTimeout(40_000);

    const endTs = logTimestamp();
    const { count, timestamps } = countTypingLogsInWindow(startTs, endTs);
    console.log(`Typing indicator sent ${count} times since ${startTs}`);

    // Expect at least 5 typing API calls (4s interval over ~30s of processing)
    expect(count).toBeGreaterThanOrEqual(5);

    // Verify they span a significant duration (not just a brief burst)
    if (timestamps.length >= 2) {
      const span = tsToMs(timestamps.at(-1)!) - tsToMs(timestamps[0]);
      console.log(
        `Typing span: ${(span / 1000).toFixed(1)}s (${timestamps.length} calls, ${timestamps[0]} to ${timestamps.at(-1)})`,
      );
      expect(span).toBeGreaterThanOrEqual(15_000);
    }
  }, 90_000);
});
