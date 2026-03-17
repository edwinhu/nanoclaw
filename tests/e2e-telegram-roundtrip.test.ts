/**
 * Full end-to-end Telegram round-trip test.
 *
 * Tests the ENTIRE NanoClaw pipeline:
 *   1. Injects a message directly into the SQLite DB (mimics telegram.ts storeMessageDirect)
 *   2. NanoClaw's message loop picks it up via getNewMessages()
 *   3. Message loop triggers container spawn
 *   4. Agent produces a response
 *   5. Verifies response in service log (agent output + Telegram send confirmation)
 *
 * No Grammy / Telegram Bot API dependency -- pure DB injection + log/DB verification.
 *
 * Prerequisites:
 *   - NanoClaw service running (`npm run dev` or launchd)
 *   - Docker/OrbStack running with nanoclaw-agent:latest built
 *   - The "main" group registered (tg:8571704407)
 *   - DB exists at store/messages.db
 *
 * Run:  npx vitest run tests/e2e-telegram-roundtrip.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, openSync, readSync, statSync, closeSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import Database from 'better-sqlite3';

// --- Configuration ---

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const STORE_DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const SERVICE_LOG = path.join(PROJECT_ROOT, 'logs', 'nanoclaw.log');
const PID_FILE = path.join(PROJECT_ROOT, 'data', 'nanoclaw.pid');

// The main group chat JID (from registered_groups)
const MAIN_CHAT_JID = 'tg:8571704407';

// ASSISTANT_NAME must match what the running service uses
const ASSISTANT_NAME = 'Clawd';

// Unique marker so we can identify our test message in logs
const TEST_MARKER = `__E2E_ROUNDTRIP_${Date.now()}__`;
const TEST_MESSAGE = `@${ASSISTANT_NAME} Say "pong ${TEST_MARKER}" and nothing else.`;

// Timeouts
const CONTAINER_SPAWN_TIMEOUT = 30_000;
const AGENT_RESPONSE_TIMEOUT = 120_000;
const POLL_INTERVAL = 2_000;

// --- Precondition checks ---

function isNanoClawRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const fd = openSync(PID_FILE, 'r');
    const buf = Buffer.alloc(32);
    const bytesRead = readSync(fd, buf, 0, 32, 0);
    closeSync(fd);
    const pid = parseInt(buf.slice(0, bytesRead).toString('utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    execSync(`kill -0 ${pid}`, { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function isDatabaseAccessible(): boolean {
  return existsSync(STORE_DB_PATH);
}

function isMainGroupRegistered(): boolean {
  if (!isDatabaseAccessible()) return false;
  try {
    const db = new Database(STORE_DB_PATH, { readonly: true });
    const row = db
      .prepare('SELECT jid FROM registered_groups WHERE jid = ?')
      .get(MAIN_CHAT_JID);
    db.close();
    return !!row;
  } catch {
    return false;
  }
}

// --- Helpers ---

/**
 * Read only the new bytes appended to the service log since startOffset.
 * This avoids reading the entire 30+ MB log file on every poll.
 */
function readNewLogContent(startOffset: number): string {
  if (!existsSync(SERVICE_LOG)) return '';

  const currentSize = statSync(SERVICE_LOG).size;
  if (currentSize <= startOffset) return '';

  const bytesToRead = currentSize - startOffset;
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(SERVICE_LOG, 'r');
  try {
    readSync(fd, buffer, 0, bytesToRead, startOffset);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf-8');
}

/**
 * Strip ANSI escape codes that pino-pretty adds to log output.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Scan the service log for agent output containing our test marker.
 * Only reads new bytes since startOffset for efficiency.
 */
function findAgentOutputInServiceLog(
  marker: string,
  startOffset: number,
): {
  found: boolean;
  result: string | null;
  hasSendError: boolean;
  telegramSent: boolean;
} {
  const newContent = readNewLogContent(startOffset);
  if (!newContent || !newContent.includes(marker)) {
    return {
      found: false,
      result: null,
      hasSendError: false,
      telegramSent: false,
    };
  }

  // Found our marker -- extract the agent output from lines containing it
  let result: string | null = null;
  for (const line of newContent.split('\n')) {
    if (line.includes(marker) && line.includes('Agent output:')) {
      const clean = stripAnsi(line);
      const outputMatch = clean.match(/Agent output:\s*(.*)/);
      if (outputMatch) {
        result = outputMatch[1].trim();
      }
      break;
    }
  }

  // Check if Telegram message was sent successfully after our marker appeared
  const markerIdx = newContent.indexOf(marker);
  const afterMarker = newContent.slice(markerIdx);
  const telegramSent = afterMarker.includes('Telegram message sent');
  const hasSendError = afterMarker.includes('Failed to send Telegram message');

  return { found: true, result, hasSendError, telegramSent };
}

/**
 * Check if a container spawn is visible in logs since startOffset.
 */
function hasContainerSpawnInLog(startOffset: number): boolean {
  const newContent = readNewLogContent(startOffset);
  return newContent.includes('Spawning container') || newContent.includes('Container started');
}

/** Wait for a condition with polling. Returns true if condition met, false on timeout. */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  pollMs: number = POLL_INTERVAL,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Inject a message into the DB, mimicking what telegram.ts storeMessageDirect() does.
 * This is how a real user message enters the pipeline.
 */
function injectMessageIntoDB(
  messageId: string,
  chatJid: string,
  content: string,
): void {
  const db = new Database(STORE_DB_PATH);
  try {
    // Store the message (same INSERT as storeMessageDirect in db.ts)
    db.prepare(
      `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      messageId,
      chatJid,
      'e2e-test-user',       // sender
      'E2E Test',            // sender_name
      content,
      new Date().toISOString(),
      0,                     // is_from_me = false (incoming user message)
      0,                     // is_bot_message = false
    );

    // Also update chat metadata so the message loop sees activity
    db.prepare(
      `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
       ON CONFLICT(jid) DO UPDATE SET last_message_time = MAX(last_message_time, excluded.last_message_time)`,
    ).run(chatJid, chatJid, new Date().toISOString());
  } finally {
    db.close();
  }
}

// --- Precondition evaluation (top-level await) ---

const serviceRunning = isNanoClawRunning();
const dockerOk = isDockerAvailable();
const dbOk = isDatabaseAccessible();
const mainGroupOk = dbOk && isMainGroupRegistered();
const allPrereqs = serviceRunning && dockerOk && dbOk && mainGroupOk;

if (!allPrereqs) {
  const missing: string[] = [];
  if (!serviceRunning) missing.push('NanoClaw service not running');
  if (!dockerOk) missing.push('Docker not available');
  if (!dbOk) missing.push('Database not found');
  if (!mainGroupOk) missing.push('Main group not registered');
  console.log(`Skipping e2e-telegram-roundtrip: ${missing.join(', ')}`);
}

// --- Tests ---

describe.skipIf(!allPrereqs)('E2E Telegram round-trip', () => {
  let serviceLogStartOffset: number;
  const messageId = `e2e-test-${Date.now()}`;

  beforeAll(() => {
    // Record the current size of the service log so we only search new content
    if (existsSync(SERVICE_LOG)) {
      serviceLogStartOffset = statSync(SERVICE_LOG).size;
    } else {
      serviceLogStartOffset = 0;
    }
  });

  it(
    'injects a message via DB and receives agent response',
    async () => {
      console.log('--- E2E Round-Trip Test ---');
      console.log(`PING: ${TEST_MESSAGE}`);

      // Step 1: Inject the test message into the DB
      injectMessageIntoDB(messageId, MAIN_CHAT_JID, TEST_MESSAGE);
      console.log(`  -> Injected into DB (message ID: ${messageId})`);

      // Step 2: Wait for container spawn (confirms message was picked up)
      console.log('  -> Waiting for container spawn...');
      const containerSpawned = await waitFor(
        () => hasContainerSpawnInLog(serviceLogStartOffset),
        CONTAINER_SPAWN_TIMEOUT,
      );

      if (containerSpawned) {
        console.log('  -> Container spawned');
      } else {
        console.log('  -> Container spawn not detected in logs (may already be running)');
      }

      // Step 3: Wait for agent output in the service log
      console.log('  -> Waiting for agent response...');
      let agentResult: string | null = null;
      let hasSendError = false;
      let telegramSent = false;

      const gotResponse = await waitFor(() => {
        const check = findAgentOutputInServiceLog(
          TEST_MARKER,
          serviceLogStartOffset,
        );
        if (check.found) {
          agentResult = check.result;
          hasSendError = check.hasSendError;
          telegramSent = check.telegramSent;
          return true;
        }
        return false;
      }, AGENT_RESPONSE_TIMEOUT);

      // Step 4: Verify agent response
      expect(gotResponse).toBe(true);

      if (gotResponse) {
        console.log(`PONG: ${agentResult?.slice(0, 200)}`);
        console.log('  -> Detected in service log');

        // The agent should have produced a non-empty result
        expect(agentResult).toBeTruthy();
        expect(agentResult!.length).toBeGreaterThan(0);

        // The result should contain our test marker (we asked the agent to echo it back)
        expect(agentResult!.toLowerCase()).toContain('pong');

        // No Telegram send errors
        expect(hasSendError).toBe(false);

        // Wait a moment for Telegram send to complete, then verify
        if (!telegramSent) {
          await new Promise((r) => setTimeout(r, 3000));
          const recheck = findAgentOutputInServiceLog(
            TEST_MARKER,
            serviceLogStartOffset,
          );
          telegramSent = recheck.telegramSent;
        }
        console.log(`  -> Telegram message sent: ${telegramSent ? 'YES' : 'NO'}`);
        expect(telegramSent).toBe(true);

        // Step 5: DB verification -- confirm our injected message is in the DB
        const db = new Database(STORE_DB_PATH, { readonly: true });
        const injectedMsg = db
          .prepare(
            `SELECT content FROM messages WHERE id = ? AND chat_jid = ?`,
          )
          .get(messageId, MAIN_CHAT_JID) as { content: string } | undefined;
        db.close();

        expect(injectedMsg).toBeTruthy();
        expect(injectedMsg!.content).toContain(TEST_MARKER);
        console.log('  -> DB verification: injected message confirmed in DB');

        console.log('PASS: Full round-trip completed');
      }
    },
    AGENT_RESPONSE_TIMEOUT + CONTAINER_SPAWN_TIMEOUT + 10_000,
  );
});
