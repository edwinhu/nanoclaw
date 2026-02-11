/**
 * Diagnostic test: Matrix /sync + Telegram typing + CDP DOM correlation.
 *
 * Runs three concurrent data streams for 60 seconds to determine where
 * Beeper typing indicators drop off:
 *   1. Matrix /sync long-poll for m.typing ephemeral events
 *   2. Telegram sendChatAction('typing') every 4s
 *   3. CDP DOM probe for Beeper Desktop typing indicator (optional)
 *
 * Output is a correlated timeline showing when each layer sees typing
 * start/stop, plus a diagnostic finding.
 *
 * Prerequisites:
 *   - .env with TELEGRAM_BOT_TOKEN and MATRIX_ACCESS_TOKEN
 *   - Beeper Desktop on CDP port 9334 (optional, for Layer 3)
 *
 * Run:  npx vitest run tests/typing-matrix-sync.test.ts
 */
import { describe, it, expect } from 'vitest';
import { CDPClient, connectCDP, hasTypingIndicator } from './helpers/cdp.js';
import fs from 'fs';
import path from 'path';

// Load .env manually (dotenv is not a project dependency)
const envPath = path.join(import.meta.dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEST_DURATION = parseInt(process.env.TEST_DURATION ?? '60000', 10);
const TG_SEND_INTERVAL = 4_000;

const MATRIX_HOMESERVER = 'https://matrix.beeper.com';
const MATRIX_ROOM_ID = '!jGNIPbw02iYarwbMvDqc:beeper.local';
const MATRIX_GHOST_USER = '@telegram_8358920089:beeper.local';

const TG_CHAT_ID = '8571704407';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TimelineEvent {
  ts: number;
  layer: 'tg_send' | 'matrix_sync' | 'cdp_dom';
  detail: string;
}

// ---------------------------------------------------------------------------
// Layer 1: Matrix /sync monitor
// ---------------------------------------------------------------------------

async function matrixFetch(
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  const token = process.env.MATRIX_ACCESS_TOKEN;
  if (!token) throw new Error('MATRIX_ACCESS_TOKEN not set');
  return fetch(`${MATRIX_HOMESERVER}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
}

async function getMatrixUserId(): Promise<string> {
  const res = await matrixFetch('/_matrix/client/v3/account/whoami');
  if (!res.ok) throw new Error(`whoami failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { user_id: string };
  return data.user_id;
}

async function createSyncFilter(userId: string): Promise<string | null> {
  try {
    const res = await matrixFetch(
      `/_matrix/client/v3/user/${encodeURIComponent(userId)}/filter`,
      {
        method: 'POST',
        body: JSON.stringify({
          room: {
            rooms: [MATRIX_ROOM_ID],
            ephemeral: { types: ['m.typing'] },
            timeline: { limit: 0 },
            state: { types: [] },
          },
          presence: { types: [] },
          account_data: { types: [] },
        }),
      },
    );
    if (!res.ok) {
      console.warn(`Filter creation failed (${res.status}), will sync without filter`);
      return null;
    }
    const data = (await res.json()) as { filter_id: string };
    return data.filter_id;
  } catch (err) {
    console.warn('Filter creation error, will sync without filter:', err);
    return null;
  }
}

async function runMatrixSync(
  events: TimelineEvent[],
  signal: AbortSignal,
): Promise<void> {
  const userId = await getMatrixUserId();
  console.log(`Matrix user: ${userId}`);

  let filterId = await createSyncFilter(userId);
  let nextBatch: string | undefined;
  let noEventsSince = Date.now();
  let retriedWithoutFilter = false;

  while (!signal.aborted) {
    try {
      const params = new URLSearchParams({ timeout: '10000' });
      if (filterId) params.set('filter', filterId);
      if (nextBatch) params.set('since', nextBatch);

      const res = await matrixFetch(
        `/_matrix/client/v3/sync?${params.toString()}`,
        { signal },
      );

      if (!res.ok) {
        events.push({ ts: Date.now(), layer: 'matrix_sync', detail: `sync error ${res.status}` });
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      const data = (await res.json()) as {
        next_batch: string;
        rooms?: {
          join?: Record<
            string,
            {
              ephemeral?: {
                events?: Array<{
                  type: string;
                  content: { user_ids?: string[] };
                }>;
              };
            }
          >;
        };
      };

      nextBatch = data.next_batch;

      // Extract typing events from the target room
      const roomData = data.rooms?.join?.[MATRIX_ROOM_ID];
      const ephemeralEvents = roomData?.ephemeral?.events ?? [];

      for (const evt of ephemeralEvents) {
        if (evt.type === 'm.typing') {
          const userIds = evt.content.user_ids ?? [];
          const ghostTyping = userIds.includes(MATRIX_GHOST_USER);
          events.push({
            ts: Date.now(),
            layer: 'matrix_sync',
            detail: ghostTyping
              ? `ghost TYPING (users: ${userIds.join(', ')})`
              : `ghost STOPPED (users: ${userIds.length > 0 ? userIds.join(', ') : 'none'})`,
          });
          noEventsSince = Date.now();
        }
      }

      // Fallback: if no typing events for 15s with a room filter, retry without filter
      // Beeper's Hungryserv may suppress filtered ephemeral events
      if (
        filterId &&
        !retriedWithoutFilter &&
        Date.now() - noEventsSince > 15_000
      ) {
        console.warn('No typing events for 15s with filter, retrying without room filter');
        filterId = null;
        retriedWithoutFilter = true;
        events.push({
          ts: Date.now(),
          layer: 'matrix_sync',
          detail: 'FALLBACK: dropped room filter after 15s silence',
        });
      }
    } catch (err: unknown) {
      if (signal.aborted) break;
      const msg = err instanceof Error ? err.message : String(err);
      events.push({ ts: Date.now(), layer: 'matrix_sync', detail: `error: ${msg}` });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ---------------------------------------------------------------------------
// Layer 2: Telegram typing sender
// ---------------------------------------------------------------------------

async function runTelegramSender(
  events: TimelineEvent[],
  signal: AbortSignal,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

  const url = `https://api.telegram.org/bot${token}/sendChatAction`;

  async function sendOnce(): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, action: 'typing' }),
        signal,
      });
      const data = (await res.json()) as { ok: boolean; description?: string };
      events.push({
        ts: Date.now(),
        layer: 'tg_send',
        detail: data.ok
          ? 'sendChatAction OK'
          : `sendChatAction FAIL: ${data.description ?? res.status}`,
      });
    } catch (err: unknown) {
      if (signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      events.push({ ts: Date.now(), layer: 'tg_send', detail: `sendChatAction ERROR: ${msg}` });
    }
  }

  // Send immediately, then every TG_SEND_INTERVAL
  await sendOnce();

  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, TG_SEND_INTERVAL);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    if (signal.aborted) break;
    await sendOnce();
  }
}

// ---------------------------------------------------------------------------
// Layer 3: CDP DOM probe (optional)
// ---------------------------------------------------------------------------

async function runCdpProbe(
  events: TimelineEvent[],
  signal: AbortSignal,
): Promise<void> {
  let cdp: CDPClient | null = null;

  try {
    cdp = await connectCDP();
    console.log('CDP connected to Beeper Desktop');
  } catch {
    events.push({
      ts: Date.now(),
      layer: 'cdp_dom',
      detail: 'SKIPPED: Beeper Desktop not available on CDP port 9334',
    });
    return;
  }

  let lastState: boolean | null = null;

  try {
    while (!signal.aborted) {
      try {
        const visible = await hasTypingIndicator(cdp);

        // Log only transitions (appear/disappear)
        if (visible !== lastState) {
          events.push({
            ts: Date.now(),
            layer: 'cdp_dom',
            detail: visible ? 'indicator VISIBLE' : 'indicator HIDDEN',
          });
          lastState = visible;
        }
      } catch (err: unknown) {
        if (signal.aborted) break;
        const msg = err instanceof Error ? err.message : String(err);
        events.push({ ts: Date.now(), layer: 'cdp_dom', detail: `probe error: ${msg}` });
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  } finally {
    cdp.close();
  }
}

// ---------------------------------------------------------------------------
// Timeline report
// ---------------------------------------------------------------------------

function printTimeline(events: TimelineEvent[], startTs: number): void {
  events.sort((a, b) => a.ts - b.ts);

  console.log('\n' + '='.repeat(80));
  console.log('CORRELATED TYPING TIMELINE');
  console.log('='.repeat(80));

  const layerPad = 13;
  for (const evt of events) {
    const offset = ((evt.ts - startTs) / 1000).toFixed(1).padStart(6);
    const layer = evt.layer.padEnd(layerPad);
    console.log(`T+${offset}s | ${layer} | ${evt.detail}`);
  }

  console.log('='.repeat(80));
}

function printDiagnostic(events: TimelineEvent[], startTs: number): void {
  const tgSends = events.filter(
    (e) => e.layer === 'tg_send' && e.detail.includes('OK'),
  );
  const matrixTyping = events.filter(
    (e) => e.layer === 'matrix_sync' && e.detail.includes('ghost TYPING'),
  );
  const matrixStopped = events.filter(
    (e) => e.layer === 'matrix_sync' && e.detail.includes('ghost STOPPED'),
  );
  const cdpVisible = events.filter(
    (e) => e.layer === 'cdp_dom' && e.detail === 'indicator VISIBLE',
  );
  const cdpHidden = events.filter(
    (e) => e.layer === 'cdp_dom' && e.detail === 'indicator HIDDEN',
  );
  const cdpSkipped = events.some(
    (e) => e.layer === 'cdp_dom' && e.detail.includes('SKIPPED'),
  );

  console.log('\n' + '-'.repeat(80));
  console.log('DIAGNOSTIC SUMMARY');
  console.log('-'.repeat(80));
  console.log(`Telegram sends (OK):    ${tgSends.length}`);
  console.log(`Matrix ghost TYPING:    ${matrixTyping.length}`);
  console.log(`Matrix ghost STOPPED:   ${matrixStopped.length}`);
  console.log(`CDP indicator VISIBLE:  ${cdpSkipped ? 'N/A (CDP not connected)' : cdpVisible.length}`);
  console.log(`CDP indicator HIDDEN:   ${cdpSkipped ? 'N/A (CDP not connected)' : cdpHidden.length}`);

  // Determine when each layer last saw typing active
  const lastTgSend = tgSends.length > 0 ? tgSends[tgSends.length - 1].ts : null;
  const lastMatrixTyping = matrixTyping.length > 0 ? matrixTyping[matrixTyping.length - 1].ts : null;
  const firstMatrixStopped = matrixStopped.length > 0 ? matrixStopped[0].ts : null;
  const lastCdpVisible = cdpVisible.length > 0 ? cdpVisible[cdpVisible.length - 1].ts : null;
  const firstCdpHidden = cdpHidden.length > 0 ? cdpHidden[0].ts : null;

  console.log('\n' + '-'.repeat(80));
  console.log('FINDING');
  console.log('-'.repeat(80));

  if (tgSends.length === 0) {
    console.log('INCONCLUSIVE: No successful Telegram sends. Check TELEGRAM_BOT_TOKEN and chat ID.');
    return;
  }

  if (matrixTyping.length === 0) {
    console.log(
      'BRIDGE ISSUE: Telegram typing sends succeeded but Matrix /sync never showed ghost TYPING.',
    );
    console.log(
      'The mautrix-telegram bridge is not relaying typing events to Matrix at all.',
    );
    return;
  }

  // Check if bridge stopped relaying while TG sends continued
  if (
    firstMatrixStopped &&
    lastTgSend &&
    firstMatrixStopped < lastTgSend &&
    lastMatrixTyping &&
    lastMatrixTyping < lastTgSend - TG_SEND_INTERVAL * 2
  ) {
    const dropOffSec = ((lastMatrixTyping - startTs) / 1000).toFixed(1);
    console.log(
      `BRIDGE STOPPED RELAYING at T+${dropOffSec}s.`,
    );
    console.log(
      'Telegram sendChatAction continued successfully, but Matrix /sync stopped receiving ghost TYPING events.',
    );
    console.log(
      'The mautrix-telegram bridge is the bottleneck: it stops forwarding typing after ~' +
        dropOffSec +
        's.',
    );
    return;
  }

  // Check if client stopped rendering while Matrix still showed typing
  if (
    !cdpSkipped &&
    firstCdpHidden &&
    lastMatrixTyping &&
    firstCdpHidden < lastMatrixTyping
  ) {
    const clientDropSec = ((firstCdpHidden - startTs) / 1000).toFixed(1);
    console.log(
      `CLIENT STOPPED RENDERING at T+${clientDropSec}s, bridge works fine.`,
    );
    console.log(
      'Matrix /sync continued to show ghost TYPING, but the Beeper client DOM dropped the indicator.',
    );
    return;
  }

  // Check if both continued throughout
  const testEnd = startTs + TEST_DURATION;
  const matrixTypingLate = matrixTyping.some(
    (e) => e.ts > testEnd - 15_000,
  );

  if (matrixTypingLate) {
    if (cdpSkipped) {
      console.log(
        'BRIDGE WORKS: Matrix /sync showed ghost TYPING throughout the test.',
      );
      console.log(
        'Could not verify client rendering (CDP not connected). Connect Beeper on port 9334 to test client layer.',
      );
    } else {
      const cdpVisibleLate = cdpVisible.some(
        (e) => e.ts > testEnd - 15_000,
      );
      if (cdpVisibleLate) {
        console.log(
          'BOTH WORKING: Bridge relays typing throughout and client renders indicator.',
        );
        console.log(
          'Typing indicator should be visible. If it disappears in practice, the issue is intermittent.',
        );
      } else {
        const lastVisibleSec = lastCdpVisible
          ? ((lastCdpVisible - startTs) / 1000).toFixed(1)
          : 'never';
        console.log(
          `CLIENT DROPS INDICATOR: Bridge works but client last showed indicator at T+${lastVisibleSec}s.`,
        );
      }
    }
    return;
  }

  // Matrix typing events stopped at some point
  if (lastMatrixTyping) {
    const lastTypingSec = ((lastMatrixTyping - startTs) / 1000).toFixed(1);
    console.log(
      `BRIDGE STOPS at T+${lastTypingSec}s. Last ghost TYPING event at that offset.`,
    );
    console.log(
      'After that, Matrix /sync either showed STOPPED or returned no typing events.',
    );
  } else {
    console.log('INCONCLUSIVE: Unexpected state. Review the raw timeline above.');
  }

  console.log('-'.repeat(80));
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Typing indicator Matrix sync diagnostic', () => {
  it(
    'runs 60s diagnostic across Telegram, Matrix, and CDP layers',
    async () => {
      const events: TimelineEvent[] = [];
      const startTs = Date.now();
      const controller = new AbortController();

      // Stop everything after TEST_DURATION
      const durationTimer = setTimeout(
        () => controller.abort(),
        TEST_DURATION,
      );

      console.log(`\nStarting ${TEST_DURATION / 1000}s typing diagnostic...`);
      console.log(`  Telegram chat: ${TG_CHAT_ID}`);
      console.log(`  Matrix room:   ${MATRIX_ROOM_ID}`);
      console.log(`  Ghost user:    ${MATRIX_GHOST_USER}`);
      console.log(`  TG interval:   ${TG_SEND_INTERVAL}ms`);
      console.log('');

      // Run all three layers concurrently
      await Promise.allSettled([
        runMatrixSync(events, controller.signal),
        runTelegramSender(events, controller.signal),
        runCdpProbe(events, controller.signal),
      ]);

      clearTimeout(durationTimer);

      // Print correlated timeline
      printTimeline(events, startTs);
      printDiagnostic(events, startTs);

      // The only hard assertion: at least one TG send worked (proves connectivity)
      const tgSuccesses = events.filter(
        (e) => e.layer === 'tg_send' && e.detail.includes('OK'),
      );
      expect(tgSuccesses.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
