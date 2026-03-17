/**
 * E2E test: Full message pipeline
 *
 * Verifies the complete NanoClaw pipeline:
 * 1. Inject a message directly into the DB (simulating Telegram receipt)
 * 2. Verify a Docker container spawns
 * 3. Verify a response message is sent back via Telegram
 *
 * Prerequisites:
 *   - NanoClaw service running (launchctl)
 *   - Docker Desktop running with nanoclaw-agent:latest built
 *   - TELEGRAM_BOT_TOKEN set in .env
 *   - Test chat registered (tg:8571704407)
 *
 * Run:  npx vitest run tests/e2e.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync, statSync } from 'fs';
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.resolve(__dirname, '..', 'store', 'messages.db');
const LOG_FILE = path.resolve(__dirname, '..', 'logs', 'nanoclaw.log');
const TEST_CHAT_JID = 'tg:8571704407';
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';

function getLogSize(): number {
  try {
    return statSync(LOG_FILE).size;
  } catch {
    return 0;
  }
}

function getLogTail(sinceBytes: number): string {
  try {
    const stat = statSync(LOG_FILE);
    if (stat.size <= sinceBytes) return '';
    const fd = require('fs').openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(stat.size - sinceBytes);
    require('fs').readSync(fd, buf, 0, buf.length, sinceBytes);
    require('fs').closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

function getRunningContainers(): string[] {
  try {
    const output = execSync(
      'docker ps --filter "name=nanoclaw-main" --format "{{.Names}}"',
      { timeout: 5000 },
    ).toString().trim();
    return output ? output.split('\n') : [];
  } catch {
    return [];
  }
}

async function poll(
  fn: () => boolean,
  timeoutMs: number,
  intervalMs: number,
  label?: string,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (label) console.log(`Poll timeout: ${label} after ${timeoutMs}ms`);
  return false;
}

describe('NanoClaw E2E Pipeline', () => {
  it('processes a message and sends a response', async () => {
    const logOffset = getLogSize();
    const uniqueMarker = `e2e-test-${Date.now()}`;

    // Inject a message directly into the DB, simulating what Grammy's handler does.
    // The NanoClaw message loop polls the DB for new messages every 2s.
    const db = new Database(DB_PATH);
    const now = new Date().toISOString();
    const msgId = `test-${Date.now()}`;

    db.prepare(`
      INSERT OR IGNORE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0)
    `).run(msgId, TEST_CHAT_JID, '12345', 'E2E Test', `@${ASSISTANT_NAME} Reply with exactly: ${uniqueMarker}`, now);
    db.close();

    console.log(`Injected test message: ${uniqueMarker}`);

    // Poll for container spawn (up to 30s)
    const containerSpawned = await poll(
      () => {
        const logs = getLogTail(logOffset);
        return logs.includes('Spawning container agent') || getRunningContainers().length > 0;
      },
      30_000,
      2_000,
      'container spawn',
    );
    expect(containerSpawned).toBe(true);
    console.log('Container spawn confirmed');

    // Poll for response sent (up to 120s)
    const responseSent = await poll(
      () => {
        const logs = getLogTail(logOffset);
        return logs.includes('Telegram message sent');
      },
      120_000,
      3_000,
      'response sent',
    );
    expect(responseSent).toBe(true);
    console.log('Response sent confirmed');

    // Verify logs show the full lifecycle
    const fullLogs = getLogTail(logOffset);
    expect(fullLogs).toContain('New messages');
    // Agent may spawn a new container ("Processing messages") or pipe to an existing one
    const agentProcessed =
      fullLogs.includes('Processing messages') || fullLogs.includes('Agent output');
    expect(agentProcessed).toBe(true);
    expect(fullLogs).toContain('Telegram message sent');
  }, 180_000);
});
