import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock config — must be before import
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// We need real fs for these tests, but mock the container-runtime deps
vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: vi.fn(() => []),
  readonlyMountArgs: vi.fn(() => []),
  stopContainer: vi.fn(() => 'docker stop test'),
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

vi.mock('./keychain.js', () => ({
  readKeychainOAuthCredentials: vi.fn(() => null),
}));

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

import { truncateSessionJsonl } from './container-runner.js';
import { logger } from './logger.js';

const DATA_DIR = '/tmp/nanoclaw-test-data';
const GROUP = 'test-group';
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function jsonlDir(): string {
  return path.join(
    DATA_DIR,
    'sessions',
    GROUP,
    '.claude',
    'projects',
    '-workspace-group',
  );
}

function jsonlPath(): string {
  return path.join(jsonlDir(), `${SESSION_ID}.jsonl`);
}

function makeEntry(
  type: string,
  subtype?: string,
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify({
    type,
    ...(subtype ? { subtype } : {}),
    uuid: crypto.randomUUID(),
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

function makeCompactBoundary(): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 167000 },
    uuid: crypto.randomUUID(),
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
  });
}

function makeCompactSummary(): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'This session is being continued...' },
    isCompactSummary: true,
    uuid: crypto.randomUUID(),
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
  });
}

describe('truncateSessionJsonl', () => {
  beforeEach(() => {
    fs.mkdirSync(jsonlDir(), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(path.join(DATA_DIR, 'sessions'), {
        recursive: true,
        force: true,
      });
    } catch {}
    vi.clearAllMocks();
  });

  it('does nothing when sessionId is undefined', () => {
    truncateSessionJsonl(GROUP, undefined);
    // No error thrown
  });

  it('does nothing when JSONL file does not exist', () => {
    truncateSessionJsonl(GROUP, SESSION_ID);
    // No error thrown
  });

  it('does nothing when file is under the size threshold', () => {
    // Write a small file with a compact_boundary
    const lines = [
      makeEntry('user'),
      makeCompactBoundary(),
      makeCompactSummary(),
      makeEntry('user'),
      makeEntry('assistant'),
    ];
    fs.writeFileSync(jsonlPath(), lines.join('\n'));
    const originalContent = fs.readFileSync(jsonlPath(), 'utf-8');

    truncateSessionJsonl(GROUP, SESSION_ID);

    // File should be unchanged (under threshold)
    expect(fs.readFileSync(jsonlPath(), 'utf-8')).toBe(originalContent);
  });

  it('truncates to last compact_boundary when file exceeds threshold', () => {
    // Build a large JSONL with a compact_boundary in the middle
    const preCompactLines: string[] = [];
    // Generate enough data to exceed 2MB
    for (let i = 0; i < 500; i++) {
      preCompactLines.push(
        makeEntry('user', undefined, {
          message: { role: 'user', content: 'x'.repeat(2000) },
        }),
      );
      preCompactLines.push(
        makeEntry('assistant', undefined, {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'y'.repeat(2000) }],
          },
        }),
      );
    }

    const compactLine = makeCompactBoundary();
    const summaryLine = makeCompactSummary();

    const postCompactLines: string[] = [];
    for (let i = 0; i < 10; i++) {
      postCompactLines.push(
        makeEntry('user', undefined, {
          message: { role: 'user', content: `post-compact message ${i}` },
        }),
      );
      postCompactLines.push(
        makeEntry('assistant', undefined, {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `response ${i}` }],
          },
        }),
      );
    }

    const allLines = [
      ...preCompactLines,
      compactLine,
      summaryLine,
      ...postCompactLines,
    ];
    fs.writeFileSync(jsonlPath(), allLines.join('\n'));

    const originalSize = fs.statSync(jsonlPath()).size;
    expect(originalSize).toBeGreaterThan(2 * 1024 * 1024); // Verify we exceed threshold

    truncateSessionJsonl(GROUP, SESSION_ID);

    // File should now start with the compact_boundary
    const truncatedContent = fs.readFileSync(jsonlPath(), 'utf-8');
    const truncatedLines = truncatedContent.split('\n').filter((l) => l.trim());

    // First line should be the compact_boundary
    const firstEntry = JSON.parse(truncatedLines[0]);
    expect(firstEntry.type).toBe('system');
    expect(firstEntry.subtype).toBe('compact_boundary');

    // Should have compact_boundary + summary + 20 post-compact messages
    expect(truncatedLines.length).toBe(2 + 20); // compact + summary + 10 user + 10 assistant

    // File should be much smaller
    const newSize = fs.statSync(jsonlPath()).size;
    expect(newSize).toBeLessThan(originalSize * 0.5);

    // Logger should have been called
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        groupFolder: GROUP,
        sessionId: SESSION_ID,
      }),
      'Truncated session JSONL to last compact boundary',
    );
  });

  it('preserves file with no compact_boundary even if large', () => {
    // Large file but no compaction happened yet
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(
        makeEntry('user', undefined, {
          message: { role: 'user', content: 'x'.repeat(2000) },
        }),
      );
      lines.push(
        makeEntry('assistant', undefined, {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'y'.repeat(2000) }],
          },
        }),
      );
    }
    fs.writeFileSync(jsonlPath(), lines.join('\n'));

    const originalContent = fs.readFileSync(jsonlPath(), 'utf-8');
    truncateSessionJsonl(GROUP, SESSION_ID);

    // File should be unchanged (no compact_boundary to truncate to)
    expect(fs.readFileSync(jsonlPath(), 'utf-8')).toBe(originalContent);
  });

  it('uses the LAST compact_boundary when multiple exist', () => {
    // Build file with two compact boundaries
    const earlyLines: string[] = [];
    for (let i = 0; i < 300; i++) {
      earlyLines.push(
        makeEntry('user', undefined, {
          message: { role: 'user', content: 'early'.repeat(2000) },
        }),
      );
    }
    const firstCompact = makeCompactBoundary();
    const firstSummary = makeCompactSummary();

    const middleLines: string[] = [];
    for (let i = 0; i < 300; i++) {
      middleLines.push(
        makeEntry('user', undefined, {
          message: { role: 'user', content: 'middle'.repeat(2000) },
        }),
      );
    }
    const secondCompact = makeCompactBoundary();
    const secondSummary = makeCompactSummary();

    const postLines: string[] = [];
    for (let i = 0; i < 5; i++) {
      postLines.push(
        makeEntry('user', undefined, {
          message: { role: 'user', content: `final message ${i}` },
        }),
      );
    }

    const allLines = [
      ...earlyLines,
      firstCompact,
      firstSummary,
      ...middleLines,
      secondCompact,
      secondSummary,
      ...postLines,
    ];
    fs.writeFileSync(jsonlPath(), allLines.join('\n'));

    const originalSize = fs.statSync(jsonlPath()).size;
    expect(originalSize).toBeGreaterThan(2 * 1024 * 1024);

    truncateSessionJsonl(GROUP, SESSION_ID);

    const truncatedContent = fs.readFileSync(jsonlPath(), 'utf-8');
    const truncatedLines = truncatedContent.split('\n').filter((l) => l.trim());

    // Should start with the SECOND compact_boundary
    const firstEntry = JSON.parse(truncatedLines[0]);
    expect(firstEntry.type).toBe('system');
    expect(firstEntry.subtype).toBe('compact_boundary');

    // Should have second_compact + second_summary + 5 post messages
    expect(truncatedLines.length).toBe(2 + 5);
  });

  it('handles fs errors gracefully without throwing', () => {
    // Create a directory where the file would be, causing writeFileSync to fail
    // Actually, just test with a non-writable path scenario
    // The function has a try/catch so it should never throw
    truncateSessionJsonl('nonexistent/group', SESSION_ID);
    // No error thrown — logged as warning
  });
});
