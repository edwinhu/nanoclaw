import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ONLY,
  TRIGGER_PATTERN,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { TelegramChannel } from './channels/telegram.js';
import {
  AvailableGroup,
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeMessage,
} from './db.js';
import { startCompanionMonitor } from './companion-monitor.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound, routeOutbound, stripInternalTags } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { initMatrixTyping } from './matrix-typing.js';
import { TypingManager } from './typing.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let isShuttingDown = false;
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
let typingManager: TypingManager;

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && (c.jid.endsWith('@g.us') || c.jid.startsWith('tg:')))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing messages');

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      typingManager.stop(chatJid);
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  typingManager.start(chatJid);
  let hadError = false;
  let outputSent = false;

  try {
    await runAgent(group, prompt, chatJid, async (result) => {
      if (result.result) {
        typingManager.stop(chatJid);
        const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        const text = stripInternalTags(raw);
        logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
        if (text) {
          const formatted = formatOutbound(chatJid, text);
          await routeOutbound(channels, chatJid, formatted);
          outputSent = true;
        }
        resetIdleTimer();
      } else {
        typingManager.stop(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    });
  } finally {
    typingManager.stop(chatJid);
    if (idleTimer) clearTimeout(idleTimer);
  }

  if (hadError) {
    if (isShuttingDown) {
      logger.warn({ group: group.name }, 'Agent error during shutdown, cursor not rolled back');
      return false;
    }
    if (outputSent) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, cursor NOT rolled back');
      return false;
    }
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));

  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      { prompt, sessionId, groupFolder: group.folder, chatJid, isMain },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        lastTimestamp = newTimestamp;
        saveState();

        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) => TRIGGER_PATTERN.test(m.content.trim()));
            if (!hasTrigger) continue;
          }

          const allPending = getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);
          const messagesToSend = allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            typingManager.start(chatJid);
            logger.debug({ chatJid, count: messagesToSend.length }, 'Piped messages to active container');
            lastAgentTimestamp[chatJid] = messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
          } else {
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info({ group: group.name, pendingCount: pending.length }, 'Recovery: found unprocessed messages');
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureDockerRunning(): void {
  const maxRetries = 12;
  const retryInterval = 5000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 10000 });
      logger.debug('Docker daemon is running');
      break;
    } catch {
      if (attempt === 1) {
        logger.info('Docker not ready, launching Docker Desktop...');
        try {
          execSync('open -gja Docker', { stdio: 'pipe', timeout: 5000 });
        } catch (e) {
          logger.warn({ err: e }, 'Failed to launch Docker Desktop');
        }
      }
      if (attempt === maxRetries) {
        logger.error('Docker daemon failed to start after 60s');
        throw new Error('Docker is required but not running');
      }
      logger.info({ attempt, maxRetries }, 'Waiting for Docker daemon...');
      execSync(`sleep ${retryInterval / 1000}`);
    }
  }

  try {
    const output = execSync('docker ps --filter "name=nanoclaw-" --format "{{.Names}}"', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const orphans = output.trim().split('\n').filter((n) => n);
    for (const name of orphans) {
      try {
        execSync(`docker stop ${name}`, { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

function acquireLock(): void {
  const lockFile = path.join(DATA_DIR, 'nanoclaw.pid');
  if (fs.existsSync(lockFile)) {
    const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0);
      logger.error({ pid }, 'Another NanoClaw instance is already running');
      process.exit(1);
    } catch {
      logger.warn({ pid }, 'Removing stale lockfile');
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(lockFile, String(process.pid));
}

function releaseLock(): void {
  const lockFile = path.join(DATA_DIR, 'nanoclaw.pid');
  try {
    const pid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
    if (pid === process.pid) {
      fs.unlinkSync(lockFile);
    }
  } catch {
    // Ignore — lockfile may already be gone
  }
}

async function main(): Promise<void> {
  acquireLock();
  ensureDockerRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    isShuttingDown = true;
    // Disconnect all channels
    for (const ch of channels) {
      await ch.disconnect().catch(() => {});
    }
    // Advance cursors to now so restart doesn't reprocess old messages
    const now = new Date().toISOString();
    for (const chatJid of Object.keys(lastAgentTimestamp)) {
      lastAgentTimestamp[chatJid] = now;
    }
    saveState();
    await queue.shutdown(10000);
    for (const chatJid of Object.keys(lastAgentTimestamp)) {
      lastAgentTimestamp[chatJid] = now;
    }
    saveState();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Build channels based on configuration
  let telegramBotId: string | undefined;
  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, {
      queue,
      advanceCursor: (chatJid: string) => {
        lastAgentTimestamp[chatJid] = new Date().toISOString();
        saveState();
      },
    });
    await telegram.connect();
    channels.push(telegram);
    telegramBotId = telegram.getBotId();
  }

  // Create TypingManager that routes through channels
  typingManager = new TypingManager(
    (jid) => findChannel(channels, jid)?.setTyping(jid, true) ?? Promise.resolve(),
    4000,
    (jid) => findChannel(channels, jid)?.setTyping(jid, false) ?? Promise.resolve(),
  );

  // Initialize Matrix typing (non-blocking — falls back to Telegram-only on failure)
  initMatrixTyping(telegramBotId).catch((err) =>
    logger.warn({ err }, 'Matrix typing init failed'),
  );

  // Start companion session monitor
  startCompanionMonitor({
    sendMessage: (jid: string, text: string) => routeOutbound(channels, jid, text),
  });

  // Common service startup (called by WhatsApp on connect, or immediately in TG-only mode)
  let servicesStarted = false;
  const startServices = () => {
    if (servicesStarted) return;
    servicesStarted = true;

    startSchedulerLoop({
      registeredGroups: () => registeredGroups,
      getSessions: () => sessions,
      queue,
      onProcess: (groupJid, proc, containerName, groupFolder) =>
        queue.registerProcess(groupJid, proc, containerName, groupFolder),
      sendMessage: (jid: string, text: string) => routeOutbound(channels, jid, text),
      assistantName: ASSISTANT_NAME,
    });

    startIpcWatcher({
      channels,
      registeredGroups: () => registeredGroups,
      registerGroup,
      syncGroupMetadata: async (force: boolean) => {
        // Find WhatsApp channel and sync if available
        const wa = channels.find((ch) => ch.name === 'WhatsApp') as WhatsAppChannel | undefined;
        if (wa) await wa.syncGroupMetadata(force);
      },
      getAvailableGroups,
      typingManager,
    });

    queue.setProcessMessagesFn(processGroupMessages);
    recoverPendingMessages();
    startMessageLoop();
  };

  if (!TELEGRAM_ONLY) {
    const whatsapp = new WhatsAppChannel({
      onConnectionOpen: startServices,
      onMessage: (_chatJid, msg, isFromMe, pushName) => {
        storeMessage(msg, _chatJid, isFromMe, pushName);
      },
      registeredGroups: () => registeredGroups,
    });
    channels.push(whatsapp);
    await whatsapp.connect();
  } else {
    startServices();
    logger.info(`NanoClaw running (Telegram-only, trigger: @${ASSISTANT_NAME})`);
  }
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
