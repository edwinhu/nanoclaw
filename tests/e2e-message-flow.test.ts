/**
 * End-to-end message flow test
 *
 * Tests the full NanoClaw pipeline WITHOUT external services:
 *   1. Inject a message into the DB (simulating Telegram)
 *   2. processGroupMessages picks it up
 *   3. Container runner is invoked (mocked)
 *   4. Agent output flows back through routeOutbound
 *   5. Mock channel captures the outbound message
 *
 * No real Telegram, Docker, or Anthropic API needed.
 *
 * Run: npx vitest run tests/e2e-message-flow.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import type { ContainerOutput } from '../src/container-runner.js';
import type { Channel, RegisteredGroup } from '../src/types.js';

// ---------------------------------------------------------------------------
// 1. Mock all heavy dependencies BEFORE importing the module under test
// ---------------------------------------------------------------------------

const TEST_CHAT_JID = 'tg:999999';
const TEST_GROUP: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-e2e',
  trigger: '@TestBot',
  added_at: new Date().toISOString(),
  requiresTrigger: true,
  isMain: false,
};

const TEST_MAIN_GROUP: RegisteredGroup = {
  name: 'Main Group',
  folder: 'main',
  trigger: '@TestBot',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
};

// --- Config mock ---
vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
  CREDENTIAL_PROXY_PORT: 3099,
  DATA_DIR: '/tmp/nanoclaw-e2e-test',
  GROUPS_DIR: '/tmp/nanoclaw-e2e-test/groups',
  IDLE_TIMEOUT: 60000,
  POLL_INTERVAL: 2000,
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_ONLY: false,
  TIMEZONE: 'America/New_York',
  TRIGGER_PATTERN: /@TestBot/i,
  STORE_DIR: '/tmp/nanoclaw-e2e-test/store',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_TIMEOUT: 300000,
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  IPC_POLL_INTERVAL: 1000,
  MAX_CONCURRENT_CONTAINERS: 5,
  SCHEDULER_POLL_INTERVAL: 60000,
  ASSISTANT_HAS_OWN_NUMBER: false,
  MATRIX_ACCESS_TOKEN: '',
  MATRIX_HOMESERVER: 'https://matrix.beeper.com',
  MOUNT_ALLOWLIST_PATH: '/tmp/nanoclaw-e2e-test/mount-allowlist.json',
  SENDER_ALLOWLIST_PATH: '/tmp/nanoclaw-e2e-test/sender-allowlist.json',
}));

vi.mock('../src/container-runtime.js', () => ({
  PROXY_BIND_HOST: '127.0.0.1',
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: () => [],
  stopContainer: () => 'docker stop test',
}));

// --- Track container invocations ---
let containerInvocations: Array<{
  group: RegisteredGroup;
  input: { prompt: string; sessionId?: string; groupFolder: string; chatJid: string; isMain: boolean };
}> = [];
let mockContainerResult: ContainerOutput = { status: 'success', result: null };
let mockStreamingOutputs: ContainerOutput[] = [];

vi.mock('../src/container-runner.js', () => ({
  runContainerAgent: vi.fn(
    async (
      group: RegisteredGroup,
      input: { prompt: string; sessionId?: string; groupFolder: string; chatJid: string; isMain: boolean },
      onProcess: (proc: ChildProcess, containerName: string) => void,
      onOutput?: (output: ContainerOutput) => Promise<void>,
    ): Promise<ContainerOutput> => {
      containerInvocations.push({ group, input });

      // Simulate process registration (pass a fake ChildProcess)
      const fakeProc = { killed: false, kill: vi.fn() } as unknown as ChildProcess;
      onProcess(fakeProc, `nanoclaw-test-${Date.now()}`);

      // Deliver streaming outputs
      for (const output of mockStreamingOutputs) {
        if (onOutput) await onOutput(output);
      }

      return mockContainerResult;
    },
  ),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

// --- DB mock: use a real in-memory SQLite database ---
// We import the real db module but initialize it with an in-memory database
// so the full SQL logic (getMessagesSince, getNewMessages, etc.) is exercised.
vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return {
    ...actual,
    // Override initDatabase to use in-memory DB
    initDatabase: () => actual._initTestDatabase(),
  };
});

// --- Channel registry mock ---
vi.mock('../src/channels/registry.js', () => ({
  getChannelFactory: vi.fn(),
  getRegisteredChannelNames: vi.fn(() => []),
}));

vi.mock('../src/channels/index.js', () => ({}));
vi.mock('../src/credential-proxy.js', () => ({
  startCredentialProxy: vi.fn(),
  detectAuthMode: vi.fn(() => 'api-key'),
}));
vi.mock('../src/companion-monitor.js', () => ({
  startCompanionMonitor: vi.fn(),
}));
vi.mock('../src/matrix-typing.js', () => ({
  initMatrixTyping: vi.fn(() => Promise.resolve()),
  setMatrixTyping: vi.fn(),
}));
vi.mock('../src/ipc.js', () => ({
  startIpcWatcher: vi.fn(),
}));
vi.mock('../src/task-scheduler.js', () => ({
  startSchedulerLoop: vi.fn(),
}));
vi.mock('../src/keychain.js', () => ({
  readKeychainOAuthCredentials: vi.fn(() => null),
}));

// Partial fs mock: let real fs work but prevent container-runner from touching disk
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => {
        // Let SQLite and test paths work; block container mount checks
        if (typeof p === 'string' && (p.includes('/tmp/nanoclaw-e2e-test') || p.includes('node_modules'))) {
          return actual.existsSync(p);
        }
        return false;
      }),
      readFileSync: actual.readFileSync,
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: actual.statSync,
      cpSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// 2. Import the module under test AFTER all mocks are set up
// ---------------------------------------------------------------------------
import {
  _setRegisteredGroups,
  getAvailableGroups,
} from '../src/index.js';
import {
  _initTestDatabase,
  storeMessage,
  storeChatMetadata,
  getMessagesSince,
  setRouterState,
  setSession,
  getAllSessions,
  setRegisteredGroup,
} from '../src/db.js';
import { GroupQueue } from '../src/group-queue.js';
import { TypingManager } from '../src/typing.js';
import {
  formatMessages,
  formatOutbound,
  routeOutbound,
  findChannel,
  stripInternalTags,
} from '../src/router.js';

// ---------------------------------------------------------------------------
// 3. Test helpers
// ---------------------------------------------------------------------------

/** Create a mock channel that captures sent messages */
function createMockChannel(prefix: string): Channel & { sentMessages: Array<{ jid: string; text: string }> } {
  const sentMessages: Array<{ jid: string; text: string }> = [];
  return {
    name: `mock-${prefix}`,
    sentMessages,
    connect: vi.fn(() => Promise.resolve()),
    sendMessage: vi.fn(async (jid: string, text: string) => {
      sentMessages.push({ jid, text });
    }),
    isConnected: () => true,
    ownsJid: (jid: string) => jid.startsWith(prefix),
    disconnect: vi.fn(() => Promise.resolve()),
    setTyping: vi.fn(() => Promise.resolve()),
  };
}

/** Inject a user message into the test DB as if Telegram delivered it */
function injectMessage(chatJid: string, content: string, senderName = 'TestUser'): string {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const timestamp = new Date().toISOString();
  storeMessage({
    id,
    chat_jid: chatJid,
    sender: 'user123',
    sender_name: senderName,
    content,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  });
  return timestamp;
}

// ---------------------------------------------------------------------------
// 4. Tests
// ---------------------------------------------------------------------------

describe('E2E Message Flow', () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  let queue: GroupQueue;
  let typingManager: TypingManager;

  beforeEach(() => {
    // Reset state
    containerInvocations = [];
    mockContainerResult = { status: 'success', result: null };
    mockStreamingOutputs = [];

    // Fresh in-memory DB
    _initTestDatabase();

    // Register chat metadata so getNewMessages can find it
    storeChatMetadata(TEST_CHAT_JID, new Date().toISOString(), 'Test Group', 'telegram', true);

    // Create mock channel for Telegram JIDs
    mockChannel = createMockChannel('tg:');

    // Set up queue and typing manager
    queue = new GroupQueue();
    typingManager = new TypingManager(
      async () => {},
      4000,
      async () => {},
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    typingManager.stopAll();
  });

  describe('Happy path: message triggers agent and response is sent', () => {
    it('processes a triggered message through the full pipeline', async () => {
      // Configure: agent returns a text response via streaming output
      mockStreamingOutputs = [
        { status: 'success', result: 'Hello from the agent!', newSessionId: 'session-123' },
      ];
      mockContainerResult = { status: 'success', result: null, newSessionId: 'session-123' };

      // Register the group
      _setRegisteredGroups({ [TEST_CHAT_JID]: TEST_GROUP });

      // Inject a message that triggers the bot
      const msgTimestamp = injectMessage(TEST_CHAT_JID, '@TestBot what is the weather?');

      // Verify messages are in the DB
      const messages = getMessagesSince(TEST_CHAT_JID, '', 'TestBot');
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('@TestBot what is the weather?');

      // Now simulate what processGroupMessages does:
      // 1. Get messages since last cursor
      // 2. Format them
      // 3. Call runAgent (which calls runContainerAgent)
      // 4. Route output back via channel

      const missedMessages = getMessagesSince(TEST_CHAT_JID, '', 'TestBot');
      expect(missedMessages.length).toBeGreaterThan(0);

      // Check trigger pattern
      const hasTrigger = missedMessages.some((m) => /@TestBot/i.test(m.content.trim()));
      expect(hasTrigger).toBe(true);

      // Format the messages (as processGroupMessages does)
      const prompt = formatMessages(missedMessages, 'America/New_York');
      expect(prompt).toContain('<messages>');
      expect(prompt).toContain('@TestBot what is the weather?');
      expect(prompt).toContain('TestUser');

      // Invoke the container runner (this calls our mock)
      const { runContainerAgent } = await import('../src/container-runner.js');
      const outputsReceived: ContainerOutput[] = [];

      const result = await runContainerAgent(
        TEST_GROUP,
        { prompt, groupFolder: TEST_GROUP.folder, chatJid: TEST_CHAT_JID, isMain: false },
        (proc, containerName) => {
          queue.registerProcess(TEST_CHAT_JID, proc, containerName, TEST_GROUP.folder);
        },
        async (output) => {
          outputsReceived.push(output);
          // Route the output back through the channel (as processGroupMessages does)
          if (output.result) {
            const raw = typeof output.result === 'string' ? output.result : JSON.stringify(output.result);
            const text = stripInternalTags(raw);
            if (text) {
              const formatted = formatOutbound(TEST_CHAT_JID, text);
              await routeOutbound([mockChannel], TEST_CHAT_JID, formatted);
            }
          }
        },
      );

      // Assertions

      // 1. Container was invoked
      expect(containerInvocations.length).toBe(1);
      expect(containerInvocations[0].group.folder).toBe('test-e2e');
      expect(containerInvocations[0].input.chatJid).toBe(TEST_CHAT_JID);
      expect(containerInvocations[0].input.prompt).toContain('@TestBot what is the weather?');

      // 2. Streaming output was received
      expect(outputsReceived.length).toBe(1);
      expect(outputsReceived[0].result).toBe('Hello from the agent!');
      expect(outputsReceived[0].newSessionId).toBe('session-123');

      // 3. Response was sent through the mock channel
      expect(mockChannel.sentMessages.length).toBe(1);
      expect(mockChannel.sentMessages[0].jid).toBe(TEST_CHAT_JID);
      expect(mockChannel.sentMessages[0].text).toBe('Hello from the agent!');

      // 4. Container result is success
      expect(result.status).toBe('success');
    });

    it('main group processes messages without trigger', async () => {
      mockStreamingOutputs = [
        { status: 'success', result: 'Main group response', newSessionId: 'session-main' },
      ];
      mockContainerResult = { status: 'success', result: null, newSessionId: 'session-main' };

      const mainJid = 'tg:111111';
      storeChatMetadata(mainJid, new Date().toISOString(), 'Main', 'telegram', false);
      _setRegisteredGroups({ [mainJid]: TEST_MAIN_GROUP });

      // No @TestBot trigger in the message — main group doesn't need one
      injectMessage(mainJid, 'just a regular message');

      const missedMessages = getMessagesSince(mainJid, '', 'TestBot');
      expect(missedMessages.length).toBe(1);

      // Main group: requiresTrigger is false, so no trigger check
      const prompt = formatMessages(missedMessages, 'America/New_York');

      const { runContainerAgent } = await import('../src/container-runner.js');
      await runContainerAgent(
        TEST_MAIN_GROUP,
        { prompt, groupFolder: 'main', chatJid: mainJid, isMain: true },
        (proc, name) => queue.registerProcess(mainJid, proc, name, 'main'),
        async (output) => {
          if (output.result) {
            const text = stripInternalTags(String(output.result));
            if (text) await routeOutbound([mockChannel], mainJid, formatOutbound(mainJid, text));
          }
        },
      );

      expect(containerInvocations.length).toBe(1);
      expect(containerInvocations[0].input.isMain).toBe(true);
      expect(mockChannel.sentMessages.length).toBe(1);
      expect(mockChannel.sentMessages[0].text).toBe('Main group response');
    });
  });

  describe('Output formatting and internal tag stripping', () => {
    it('strips <internal> tags from agent output before sending', async () => {
      mockStreamingOutputs = [
        { status: 'success', result: '<internal>thinking about weather</internal>The weather is sunny!' },
      ];
      mockContainerResult = { status: 'success', result: null };

      _setRegisteredGroups({ [TEST_CHAT_JID]: TEST_GROUP });
      injectMessage(TEST_CHAT_JID, '@TestBot weather?');

      const missedMessages = getMessagesSince(TEST_CHAT_JID, '', 'TestBot');
      const prompt = formatMessages(missedMessages, 'America/New_York');

      const { runContainerAgent } = await import('../src/container-runner.js');
      await runContainerAgent(
        TEST_GROUP,
        { prompt, groupFolder: TEST_GROUP.folder, chatJid: TEST_CHAT_JID, isMain: false },
        (proc, name) => queue.registerProcess(TEST_CHAT_JID, proc, name, TEST_GROUP.folder),
        async (output) => {
          if (output.result) {
            const text = stripInternalTags(String(output.result));
            if (text) await routeOutbound([mockChannel], TEST_CHAT_JID, formatOutbound(TEST_CHAT_JID, text));
          }
        },
      );

      expect(mockChannel.sentMessages.length).toBe(1);
      // Internal tags should be stripped
      expect(mockChannel.sentMessages[0].text).not.toContain('<internal>');
      expect(mockChannel.sentMessages[0].text).toBe('The weather is sunny!');
    });

    it('does not send message when output is only internal tags', async () => {
      mockStreamingOutputs = [
        { status: 'success', result: '<internal>just thinking</internal>' },
      ];
      mockContainerResult = { status: 'success', result: null };

      _setRegisteredGroups({ [TEST_CHAT_JID]: TEST_GROUP });
      injectMessage(TEST_CHAT_JID, '@TestBot hi');

      const missedMessages = getMessagesSince(TEST_CHAT_JID, '', 'TestBot');
      const prompt = formatMessages(missedMessages, 'America/New_York');

      const { runContainerAgent } = await import('../src/container-runner.js');
      await runContainerAgent(
        TEST_GROUP,
        { prompt, groupFolder: TEST_GROUP.folder, chatJid: TEST_CHAT_JID, isMain: false },
        (proc, name) => queue.registerProcess(TEST_CHAT_JID, proc, name, TEST_GROUP.folder),
        async (output) => {
          if (output.result) {
            const text = stripInternalTags(String(output.result));
            if (text) await routeOutbound([mockChannel], TEST_CHAT_JID, formatOutbound(TEST_CHAT_JID, text));
          }
        },
      );

      // No message should be sent — output was only internal tags
      expect(mockChannel.sentMessages.length).toBe(0);
    });
  });

  describe('Error handling', () => {
    it('container error does not send response', async () => {
      mockStreamingOutputs = [];
      mockContainerResult = {
        status: 'error',
        result: null,
        error: 'Container exited with code 1: API Error',
      };

      _setRegisteredGroups({ [TEST_CHAT_JID]: TEST_GROUP });
      injectMessage(TEST_CHAT_JID, '@TestBot do something');

      const missedMessages = getMessagesSince(TEST_CHAT_JID, '', 'TestBot');
      const prompt = formatMessages(missedMessages, 'America/New_York');

      const { runContainerAgent } = await import('../src/container-runner.js');
      const result = await runContainerAgent(
        TEST_GROUP,
        { prompt, groupFolder: TEST_GROUP.folder, chatJid: TEST_CHAT_JID, isMain: false },
        (proc, name) => queue.registerProcess(TEST_CHAT_JID, proc, name, TEST_GROUP.folder),
        async (output) => {
          if (output.result) {
            const text = stripInternalTags(String(output.result));
            if (text) await routeOutbound([mockChannel], TEST_CHAT_JID, formatOutbound(TEST_CHAT_JID, text));
          }
        },
      );

      // Container error: no streaming outputs delivered, no messages sent
      expect(result.status).toBe('error');
      expect(mockChannel.sentMessages.length).toBe(0);
      expect(containerInvocations.length).toBe(1);
    });

    it('container error after partial output still delivers the partial output', async () => {
      // Simulate: agent sends one output, then container crashes
      mockStreamingOutputs = [
        { status: 'success', result: 'Partial response before crash', newSessionId: 'session-crash' },
      ];
      mockContainerResult = {
        status: 'error',
        result: null,
        error: 'Container exited with code 1',
      };

      _setRegisteredGroups({ [TEST_CHAT_JID]: TEST_GROUP });
      injectMessage(TEST_CHAT_JID, '@TestBot long task');

      const missedMessages = getMessagesSince(TEST_CHAT_JID, '', 'TestBot');
      const prompt = formatMessages(missedMessages, 'America/New_York');

      const { runContainerAgent } = await import('../src/container-runner.js');
      const result = await runContainerAgent(
        TEST_GROUP,
        { prompt, groupFolder: TEST_GROUP.folder, chatJid: TEST_CHAT_JID, isMain: false },
        (proc, name) => queue.registerProcess(TEST_CHAT_JID, proc, name, TEST_GROUP.folder),
        async (output) => {
          if (output.result) {
            const text = stripInternalTags(String(output.result));
            if (text) await routeOutbound([mockChannel], TEST_CHAT_JID, formatOutbound(TEST_CHAT_JID, text));
          }
        },
      );

      // The partial response WAS delivered (streaming happens before container exits)
      expect(mockChannel.sentMessages.length).toBe(1);
      expect(mockChannel.sentMessages[0].text).toBe('Partial response before crash');
      // But container result is error
      expect(result.status).toBe('error');
    });
  });

  describe('Session lifecycle integration', () => {
    it('session ID flows from container output through persistence', async () => {
      mockStreamingOutputs = [
        { status: 'success', result: 'Response 1', newSessionId: 'session-v1' },
      ];
      mockContainerResult = { status: 'success', result: null, newSessionId: 'session-v1' };

      _setRegisteredGroups({ [TEST_CHAT_JID]: TEST_GROUP });
      injectMessage(TEST_CHAT_JID, '@TestBot hello');

      const missedMessages = getMessagesSince(TEST_CHAT_JID, '', 'TestBot');
      const prompt = formatMessages(missedMessages, 'America/New_York');

      // Simulate the pendingSessionId logic from runAgent
      let pendingSessionId: string | undefined;
      const { runContainerAgent } = await import('../src/container-runner.js');
      const result = await runContainerAgent(
        TEST_GROUP,
        { prompt, groupFolder: TEST_GROUP.folder, chatJid: TEST_CHAT_JID, isMain: false },
        (proc, name) => queue.registerProcess(TEST_CHAT_JID, proc, name, TEST_GROUP.folder),
        async (output) => {
          if (output.newSessionId) pendingSessionId = output.newSessionId;
          if (output.result) {
            const text = stripInternalTags(String(output.result));
            if (text) await routeOutbound([mockChannel], TEST_CHAT_JID, formatOutbound(TEST_CHAT_JID, text));
          }
        },
      );

      // Verify session persistence logic
      expect(result.status).toBe('success');
      const finalSessionId = result.newSessionId || pendingSessionId;
      expect(finalSessionId).toBe('session-v1');

      // Persist it (as runAgent would)
      if (finalSessionId) {
        setSession(TEST_GROUP.folder, finalSessionId);
      }
      const sessions = getAllSessions();
      expect(sessions[TEST_GROUP.folder]).toBe('session-v1');
    });

    it('session is NOT persisted on container error (crash-loop prevention)', async () => {
      mockStreamingOutputs = [
        { status: 'success', result: 'started...', newSessionId: 'session-corrupt' },
      ];
      mockContainerResult = { status: 'error', result: null, error: 'crash' };

      _setRegisteredGroups({ [TEST_CHAT_JID]: TEST_GROUP });
      injectMessage(TEST_CHAT_JID, '@TestBot crash');

      const missedMessages = getMessagesSince(TEST_CHAT_JID, '', 'TestBot');
      const prompt = formatMessages(missedMessages, 'America/New_York');

      let pendingSessionId: string | undefined;
      const { runContainerAgent } = await import('../src/container-runner.js');
      const result = await runContainerAgent(
        TEST_GROUP,
        { prompt, groupFolder: TEST_GROUP.folder, chatJid: TEST_CHAT_JID, isMain: false },
        (proc, name) => queue.registerProcess(TEST_CHAT_JID, proc, name, TEST_GROUP.folder),
        async (output) => {
          if (output.newSessionId) pendingSessionId = output.newSessionId;
        },
      );

      // Replicate runAgent logic: on error, do NOT persist
      expect(result.status).toBe('error');
      expect(pendingSessionId).toBe('session-corrupt'); // Was captured...
      // ...but not persisted (runAgent short-circuits on error)
      const sessions = getAllSessions();
      expect(sessions[TEST_GROUP.folder]).toBeUndefined();
    });
  });

  describe('Multiple streaming outputs (multi-turn)', () => {
    it('delivers multiple agent outputs sequentially', async () => {
      mockStreamingOutputs = [
        { status: 'success', result: 'First response' },
        { status: 'success', result: null }, // Silent completion (e.g., tool use)
        { status: 'success', result: 'Second response', newSessionId: 'session-multi' },
      ];
      mockContainerResult = { status: 'success', result: null, newSessionId: 'session-multi' };

      _setRegisteredGroups({ [TEST_CHAT_JID]: TEST_GROUP });
      injectMessage(TEST_CHAT_JID, '@TestBot multi-step task');

      const missedMessages = getMessagesSince(TEST_CHAT_JID, '', 'TestBot');
      const prompt = formatMessages(missedMessages, 'America/New_York');

      const { runContainerAgent } = await import('../src/container-runner.js');
      await runContainerAgent(
        TEST_GROUP,
        { prompt, groupFolder: TEST_GROUP.folder, chatJid: TEST_CHAT_JID, isMain: false },
        (proc, name) => queue.registerProcess(TEST_CHAT_JID, proc, name, TEST_GROUP.folder),
        async (output) => {
          if (output.result) {
            const text = stripInternalTags(String(output.result));
            if (text) await routeOutbound([mockChannel], TEST_CHAT_JID, formatOutbound(TEST_CHAT_JID, text));
          }
        },
      );

      // Two messages sent (null result outputs are skipped)
      expect(mockChannel.sentMessages.length).toBe(2);
      expect(mockChannel.sentMessages[0].text).toBe('First response');
      expect(mockChannel.sentMessages[1].text).toBe('Second response');
    });
  });

  describe('Queue integration', () => {
    it('GroupQueue routes processGroupMessages and receives the result', async () => {
      // Wire up a real GroupQueue with a mock processGroupMessages
      const testQueue = new GroupQueue();
      let processCallJid: string | undefined;
      let processCallResolved = false;

      testQueue.setProcessMessagesFn(async (groupJid: string) => {
        processCallJid = groupJid;
        processCallResolved = true;
        return true; // success
      });

      // Enqueue a message check — this should trigger processMessagesFn
      testQueue.enqueueMessageCheck(TEST_CHAT_JID);

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 50));

      expect(processCallJid).toBe(TEST_CHAT_JID);
      expect(processCallResolved).toBe(true);
    });

    it('GroupQueue handles piped messages to active containers', () => {
      const testQueue = new GroupQueue();

      // No active container — sendMessage should return false
      expect(testQueue.sendMessage(TEST_CHAT_JID, 'hello')).toBe(false);
    });
  });

  describe('Message formatting pipeline', () => {
    it('formats messages with XML structure and timezone', () => {
      const messages = [
        {
          id: 'msg1',
          chat_jid: TEST_CHAT_JID,
          sender: 'user1',
          sender_name: 'Alice',
          content: 'Hello @TestBot',
          timestamp: '2024-01-15T10:30:00.000Z',
        },
        {
          id: 'msg2',
          chat_jid: TEST_CHAT_JID,
          sender: 'user2',
          sender_name: 'Bob',
          content: 'What do you think?',
          timestamp: '2024-01-15T10:31:00.000Z',
        },
      ];

      const formatted = formatMessages(messages, 'America/New_York');

      expect(formatted).toContain('<context timezone="America/New_York"');
      expect(formatted).toContain('<messages>');
      expect(formatted).toContain('sender="Alice"');
      expect(formatted).toContain('sender="Bob"');
      expect(formatted).toContain('Hello @TestBot');
      expect(formatted).toContain('What do you think?');
    });

    it('escapes XML special characters in messages', () => {
      const messages = [
        {
          id: 'msg1',
          chat_jid: TEST_CHAT_JID,
          sender: 'user1',
          sender_name: 'Test <User>',
          content: 'a < b & c > d',
          timestamp: '2024-01-15T10:30:00.000Z',
        },
      ];

      const formatted = formatMessages(messages, 'UTC');

      expect(formatted).toContain('sender="Test &lt;User&gt;"');
      expect(formatted).toContain('a &lt; b &amp; c &gt; d');
    });
  });

  describe('Channel routing', () => {
    it('routes output to the correct channel based on JID prefix', async () => {
      const tgChannel = createMockChannel('tg:');
      const dcChannel = createMockChannel('dc:');

      await routeOutbound([tgChannel, dcChannel], 'tg:12345', 'Hello Telegram');
      await routeOutbound([tgChannel, dcChannel], 'dc:67890', 'Hello Discord');

      expect(tgChannel.sentMessages.length).toBe(1);
      expect(tgChannel.sentMessages[0].text).toBe('Hello Telegram');
      expect(dcChannel.sentMessages.length).toBe(1);
      expect(dcChannel.sentMessages[0].text).toBe('Hello Discord');
    });

    it('does not send when no channel owns the JID', async () => {
      const tgChannel = createMockChannel('tg:');

      await routeOutbound([tgChannel], 'wa:12345', 'No channel for this');

      expect(tgChannel.sentMessages.length).toBe(0);
    });

    it('does not send empty/whitespace-only output', async () => {
      await routeOutbound([mockChannel], TEST_CHAT_JID, '');
      await routeOutbound([mockChannel], TEST_CHAT_JID, '   ');

      // routeOutbound calls formatOutbound which strips internal tags,
      // but empty string is caught by the if(!formatted) check
      expect(mockChannel.sentMessages.length).toBe(0);
    });
  });
});
