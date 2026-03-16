import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Mock keychain — controlled per test
let mockKeychainCreds: Record<string, unknown> | null = null;
vi.mock('./keychain.js', () => ({
  readKeychainOAuthToken: vi.fn(() => null),
  readKeychainOAuthCredentials: vi.fn(() => mockKeychainCreds),
}));

// Mock credential-proxy (imported by container-runner but not needed here)
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'oauth'),
}));

// Mock container-runtime (imported by container-runner but not needed here)
vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: vi.fn(() => []),
  readonlyMountArgs: vi.fn(() => []),
  stopContainer: vi.fn(() => 'docker stop'),
}));

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((f: string) => `/tmp/nanoclaw-test-groups/${f}`),
  resolveGroupIpcPath: vi.fn((f: string) => `/tmp/nanoclaw-test-data/ipc/${f}`),
}));

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock fs — we control readFileSync to simulate .env content
let mockEnvContent = '';
let mockReadwiseToken = '';
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: string) => {
        if (typeof p === 'string' && p.endsWith('.env')) return !!mockEnvContent;
        if (typeof p === 'string' && p.includes('readwise')) return !!mockReadwiseToken;
        return false;
      }),
      readFileSync: vi.fn((p: string) => {
        if (typeof p === 'string' && p.endsWith('.env')) return mockEnvContent;
        if (typeof p === 'string' && p.includes('readwise')) return mockReadwiseToken;
        throw new Error('ENOENT');
      }),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

import { readSecrets } from './container-runner.js';

describe('readSecrets', () => {
  beforeEach(() => {
    mockEnvContent = '';
    mockReadwiseToken = '';
    mockKeychainCreds = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers keychain OAuth token over stale .env token (regression: stale .env bypass)', () => {
    // REGRESSION TEST for bug: readSecrets() previously read .env first and returned
    // the stale token, never checking the keychain. This caused containers to receive
    // an expired token that Spotless would forward directly to api.anthropic.com.
    mockEnvContent = 'CLAUDE_CODE_OAUTH_TOKEN=stale-env-token\n';
    mockKeychainCreds = { accessToken: 'fresh-keychain-token' };

    const secrets = readSecrets();

    // The keychain token must win over the .env token
    expect(secrets['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fresh-keychain-token');
  });

  it('falls back to .env token when keychain is unavailable', () => {
    mockEnvContent = 'CLAUDE_CODE_OAUTH_TOKEN=env-token-only\n';
    mockKeychainCreds = null;

    const secrets = readSecrets();

    expect(secrets['CLAUDE_CODE_OAUTH_TOKEN']).toBe('env-token-only');
  });

  it('uses keychain token even when .env has no OAuth token', () => {
    mockEnvContent = '';
    mockKeychainCreds = { accessToken: 'keychain-only-token' };

    const secrets = readSecrets();

    expect(secrets['CLAUDE_CODE_OAUTH_TOKEN']).toBe('keychain-only-token');
  });

  it('does not override API key with keychain token', () => {
    // When ANTHROPIC_API_KEY is set, keychain should NOT be consulted
    mockEnvContent = 'ANTHROPIC_API_KEY=sk-ant-real-key\n';
    mockKeychainCreds = { accessToken: 'should-not-appear' };

    const secrets = readSecrets();

    expect(secrets['ANTHROPIC_API_KEY']).toBe('sk-ant-real-key');
    // In API key mode, CLAUDE_CODE_OAUTH_TOKEN should not be set from keychain
    expect(secrets['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  it('logs when keychain token differs from .env token', async () => {
    const { logger } = await import('./logger.js');
    mockEnvContent = 'CLAUDE_CODE_OAUTH_TOKEN=old-token\n';
    mockKeychainCreds = { accessToken: 'new-keychain-token' };

    readSecrets();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('keychain OAuth token'),
    );
  });
});
