/**
 * Companion session monitor — tracks overnight tasks launched as
 * the-companion Claude Code sessions. Connects via WebSocket to detect
 * when each task completes, then sends Telegram notifications.
 *
 * Architecture:
 * - Polls DB for new 'running' sessions every 30s
 * - Opens a WebSocket to each new session for real-time events
 * - Detects completion via 'result' message → kills session → notifies
 * - Detects failure via error results or session disconnects → notifies
 * - Falls back to REST polling for sessions where WebSocket fails
 */

import {
  getRunningCompanionSessions,
  getRecentTerminalCompanionSessions,
  updateCompanionSession,
  type CompanionSession,
} from './db.js';
import { logger } from './logger.js';

const COMPANION_URL =
  process.env.COMPANION_URL || 'http://localhost:3456';
const COMPANION_WS_URL =
  COMPANION_URL.replace('http://', 'ws://').replace('https://', 'wss://');
const POLL_INTERVAL = 30_000;
const STUCK_THRESHOLD = 2 * 60 * 60_000; // 2 hours
const MONITOR_URL = 'http://100.91.182.78:3456';

// Track which sessions have active WebSocket connections
const activeConnections = new Map<string, WebSocket>();

export function startCompanionMonitor(deps: {
  sendMessage: (jid: string, text: string) => Promise<void>;
}): void {
  logger.info('Companion session monitor started');

  const poll = async () => {
    try {
      const sessions = getRunningCompanionSessions();

      for (const session of sessions) {
        // Skip sessions that already have a WebSocket connection
        if (activeConnections.has(session.session_id)) continue;

        // Open WebSocket connection to monitor this session
        connectToSession(session, deps);
      }
    } catch (err) {
      logger.error({ err }, 'Companion monitor poll error');
    }

    setTimeout(poll, POLL_INTERVAL);
  };

  setTimeout(poll, 5000);
}

function connectToSession(
  session: CompanionSession,
  deps: { sendMessage: (jid: string, text: string) => Promise<void> },
): void {
  const wsUrl = `${COMPANION_WS_URL}/ws/browser/${session.session_id}`;
  let ws: WebSocket;

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    logger.error(
      { sessionId: session.session_id, err },
      'Failed to create WebSocket',
    );
    // Fall back to REST polling for this session
    fallbackRestCheck(session, deps);
    return;
  }

  activeConnections.set(session.session_id, ws);

  ws.onmessage = async (event) => {
    try {
      const msg = JSON.parse(
        typeof event.data === 'string'
          ? event.data
          : event.data.toString(),
      ) as {
        type: string;
        data?: {
          is_error?: boolean;
          subtype?: string;
          total_cost_usd?: number;
          num_turns?: number;
          duration_ms?: number;
          total_lines_added?: number;
          total_lines_removed?: number;
        };
      };

      if (msg.type === 'result' && msg.data) {
        // Agent completed a turn — task is done
        const isError = msg.data.is_error === true;
        const cost = msg.data.total_cost_usd ?? 0;
        const numTurns = msg.data.num_turns ?? 0;
        const durationMs = msg.data.duration_ms ?? 0;
        const linesAdded = msg.data.total_lines_added ?? 0;
        const linesRemoved = msg.data.total_lines_removed ?? 0;
        const durationStr = formatDuration(durationMs);

        // Kill the session (it stays alive otherwise)
        try {
          await fetch(
            `${COMPANION_URL}/api/sessions/${session.session_id}/kill`,
            { method: 'POST', signal: AbortSignal.timeout(5000) },
          );
        } catch {
          // Best effort — session may already be gone
        }

        const status = isError ? 'failed' : 'completed';
        updateCompanionSession(session.session_id, {
          status,
          last_check_at: new Date().toISOString(),
          last_status: 'exited',
          last_num_turns: numTurns,
          total_cost_usd: cost,
          total_lines_added: linesAdded,
          total_lines_removed: linesRemoved,
          error: isError
            ? `${msg.data.subtype ?? 'error'}`
            : null,
        });

        if (isError) {
          await deps.sendMessage(
            session.chat_jid,
            `## Task Failed: ${session.task_title}\n\n` +
              `**Error**: ${msg.data.subtype ?? 'unknown'}\n` +
              `**Cost**: $${cost.toFixed(2)} | **Duration**: ${durationStr} | **Turns**: ${numTurns}\n\n` +
              `Check: ${MONITOR_URL}`,
          );
        } else {
          await deps.sendMessage(
            session.chat_jid,
            `## Task Complete: ${session.task_title}\n\n` +
              `**Cost**: $${cost.toFixed(2)} | **Duration**: ${durationStr} | **Turns**: ${numTurns}\n` +
              `**Lines**: +${linesAdded} / -${linesRemoved}\n\n` +
              `Review: ${MONITOR_URL}`,
          );
        }

        logger.info(
          {
            sessionId: session.session_id,
            status,
            cost,
            numTurns,
            durationMs,
          },
          'Companion session finished',
        );

        // Cleanup
        cleanup(session.session_id);
        await maybeSendSummary(deps);
      }
    } catch (err) {
      logger.error(
        { sessionId: session.session_id, err },
        'Error processing WebSocket message',
      );
    }
  };

  ws.onclose = async () => {
    // WebSocket closed — check if session is still supposed to be running
    const current = getRunningCompanionSessions().find(
      (s) => s.session_id === session.session_id,
    );
    if (current) {
      // Session still marked as running in DB but WS closed
      // Could be companion restart or network issue — try reconnecting after delay
      cleanup(session.session_id);
      setTimeout(() => {
        const stillRunning = getRunningCompanionSessions().find(
          (s) => s.session_id === session.session_id,
        );
        if (stillRunning) {
          logger.debug(
            { sessionId: session.session_id },
            'Reconnecting WebSocket to companion session',
          );
          connectToSession(stillRunning, deps);
        }
      }, 10_000);
    } else {
      cleanup(session.session_id);
    }
  };

  ws.onerror = (err) => {
    logger.error(
      { sessionId: session.session_id, err },
      'WebSocket error for companion session',
    );
  };

  // Stuck detection — if the WebSocket is connected but no result after 2 hours
  const stuckTimer = setTimeout(async () => {
    const current = getRunningCompanionSessions().find(
      (s) => s.session_id === session.session_id,
    );
    if (current) {
      updateCompanionSession(session.session_id, {
        status: 'stuck',
        last_check_at: new Date().toISOString(),
      });
      await deps.sendMessage(
        session.chat_jid,
        `## Task Might Be Stuck: ${session.task_title}\n\n` +
          `Running for over 2 hours with no completion.\n\n` +
          `Check: ${MONITOR_URL}`,
      );
      logger.warn(
        { sessionId: session.session_id },
        'Companion session appears stuck',
      );
      cleanup(session.session_id);
    }
  }, STUCK_THRESHOLD);

  // Store timer reference for cleanup
  (ws as WebSocket & { _stuckTimer?: ReturnType<typeof setTimeout> })._stuckTimer = stuckTimer;

  logger.debug(
    { sessionId: session.session_id },
    'WebSocket connected to companion session',
  );
}

function cleanup(sessionId: string): void {
  const ws = activeConnections.get(sessionId);
  if (ws) {
    const timer = (ws as WebSocket & { _stuckTimer?: ReturnType<typeof setTimeout> })._stuckTimer;
    if (timer) clearTimeout(timer);
    try {
      ws.close();
    } catch {
      // ignore
    }
    activeConnections.delete(sessionId);
  }
}

/**
 * REST fallback for sessions where WebSocket connection fails.
 */
async function fallbackRestCheck(
  session: CompanionSession,
  deps: { sendMessage: (jid: string, text: string) => Promise<void> },
): Promise<void> {
  try {
    const res = await fetch(
      `${COMPANION_URL}/api/sessions/${session.session_id}`,
      { signal: AbortSignal.timeout(10_000) },
    );

    if (!res.ok) {
      if (res.status === 404) {
        updateCompanionSession(session.session_id, {
          status: 'failed',
          last_check_at: new Date().toISOString(),
          error: 'Session not found in companion',
        });
        await deps.sendMessage(
          session.chat_jid,
          `## Task Failed: ${session.task_title}\n\nSession not found.\n\nCheck: ${MONITOR_URL}`,
        );
      }
      return;
    }

    const state = (await res.json()) as { state: string; exitCode?: number | null; createdAt?: number };

    if (state.state === 'exited') {
      const isSuccess = state.exitCode === 0 || state.exitCode === null;
      const durationMs = state.createdAt ? Date.now() - state.createdAt : 0;

      updateCompanionSession(session.session_id, {
        status: isSuccess ? 'completed' : 'failed',
        last_check_at: new Date().toISOString(),
        last_status: 'exited',
        error: isSuccess ? null : `Exit code: ${state.exitCode}`,
      });

      await deps.sendMessage(
        session.chat_jid,
        isSuccess
          ? `## Task Complete: ${session.task_title}\n\n**Duration**: ${formatDuration(durationMs)}\n\nReview: ${MONITOR_URL}`
          : `## Task Failed: ${session.task_title}\n\nExit code: ${state.exitCode}\n\nCheck: ${MONITOR_URL}`,
      );
    }
  } catch (err) {
    logger.error(
      { sessionId: session.session_id, err },
      'REST fallback check failed',
    );
  }
}

let lastSummaryAt = 0;

async function maybeSendSummary(deps: {
  sendMessage: (jid: string, text: string) => Promise<void>;
}): Promise<void> {
  const running = getRunningCompanionSessions();
  if (running.length > 0) return;

  const now = Date.now();
  if (now - lastSummaryAt < 60_000) return;
  lastSummaryAt = now;

  const recentSessions = getRecentTerminalCompanionSessions();
  if (recentSessions.length === 0) return;

  const byChatJid = new Map<string, typeof recentSessions>();
  for (const s of recentSessions) {
    const arr = byChatJid.get(s.chat_jid) || [];
    arr.push(s);
    byChatJid.set(s.chat_jid, arr);
  }

  for (const [chatJid, sessions] of byChatJid) {
    if (sessions.length < 2) continue;

    const totalCost = sessions.reduce(
      (sum, s) => sum + (s.total_cost_usd ?? 0),
      0,
    );
    const lines = sessions.map((s, i) => {
      const icon =
        s.status === 'completed'
          ? 'done'
          : s.status === 'failed'
            ? 'FAILED'
            : 'stuck';
      const cost = s.total_cost_usd
        ? ` ($${s.total_cost_usd.toFixed(2)})`
        : '';
      return `${i + 1}. **${s.task_title}** — ${icon}${cost}`;
    });

    await deps.sendMessage(
      chatJid,
      `## All Overnight Tasks Finished\n\n` +
        lines.join('\n') +
        `\n\n**Total cost**: $${totalCost.toFixed(2)}\n` +
        `Review: ${MONITOR_URL}`,
    );
  }
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
