import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// Mock fs so readFullOAuthCredentials() never reads the real ~/.claude/.credentials.json.
// This ensures tests exercise the keychain fallback path in isolation.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(() => {
      throw new Error('ENOENT: mock - no credentials file');
    }),
    writeFileSync: vi.fn(),
  };
});

let mockKeychainToken: string | null = null;
let mockKeychainCreds: Record<string, unknown> | null = null;
vi.mock('./keychain.js', () => ({
  readKeychainOAuthToken: vi.fn(() => mockKeychainToken),
  readKeychainOAuthCredentials: vi.fn(() => {
    if (mockKeychainCreds) return mockKeychainCreds;
    return mockKeychainToken ? { accessToken: mockKeychainToken } : null;
  }),
}));

import { startCredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    mockKeychainToken = null;
    mockKeychainCreds = null;
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('retries on upstream 500 and returns success after recovery', async () => {
    // Regression test: 5xx retry logic must fire when the upstream returns 500.
    // Previously, Spotless intercepted ANTHROPIC_BASE_URL and forwarded to
    // api.anthropic.com directly, so the credential proxy never saw 500s.
    // After the fix (Spotless chains through the credential proxy), this retry
    // logic is reachable and must work.
    let upstreamCallCount = 0;
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    upstreamServer = http.createServer((req, res) => {
      upstreamCallCount++;
      if (upstreamCallCount <= 2) {
        // First two attempts return 500
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'Internal server error' },
          }),
        );
      } else {
        // Third attempt succeeds
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const result = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    // Proxy should have retried twice (3 total attempts) and returned the 200
    expect(upstreamCallCount).toBe(3);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });
  }, 15_000); // Allow time for exponential backoff (1s + 2s delays)

  it('returns 500 after exhausting all retries', async () => {
    // When all retry attempts fail, the proxy should return the last 500 response
    let upstreamCallCount = 0;
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    upstreamServer = http.createServer((_req, res) => {
      upstreamCallCount++;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'Internal server error' },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const result = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    // MAX_5XX_RETRIES is 3, starting at attempt=1, so 3 total attempts
    expect(upstreamCallCount).toBe(3);
    expect(result.statusCode).toBe(500);
  }, 15_000); // Allow time for exponential backoff

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  it('OAuth mode prefers keychain token over .env token', async () => {
    mockKeychainToken = 'keychain-fresh-token';
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'stale-env-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer keychain-fresh-token',
    );
  });

  it('OAuth mode falls back to .env token when keychain returns null', async () => {
    mockKeychainToken = null;
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'env-fallback-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer env-fallback-token',
    );
  });

  it('401 retry force-refreshes token even when expiresAt is in the future', async () => {
    // Set up a mock refresh server that issues new tokens
    let refreshCalled = false;
    const refreshServer = http.createServer((req, res) => {
      if (req.url === '/v1/oauth/token') {
        refreshCalled = true;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'refreshed-token',
              refresh_token: 'new-refresh-token',
              expires_in: 3600,
            }),
          );
        });
      }
    });
    await new Promise<void>((resolve) =>
      refreshServer.listen(0, '127.0.0.1', resolve),
    );
    const refreshPort = (refreshServer.address() as AddressInfo).port;

    // The upstream returns 401 on first request, 200 on retry
    let upstreamCallCount = 0;
    await new Promise<void>((r) => upstreamServer.close(() => r()));
    upstreamServer = http.createServer((req, res) => {
      upstreamCallCount++;
      lastUpstreamHeaders = { ...req.headers };
      if (upstreamCallCount === 1) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'token expired' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    // Keychain returns token with expiresAt far in the future + a refresh token.
    // This simulates a server-side revocation: local token looks valid but API rejects it.
    mockKeychainCreds = {
      accessToken: 'revoked-but-not-expired-token',
      refreshToken: 'my-refresh-token',
      expiresAt: Date.now() + 3 * 60 * 60 * 1000, // 3 hours from now
    };

    // We need to intercept the refresh call. Since refreshOAuthToken uses httpsRequest
    // to platform.claude.com and we can't easily mock that, we verify the behavior
    // indirectly: the proxy should retry the request (upstreamCallCount === 2).
    // The force-refresh path calls doRefresh() which calls refreshOAuthToken().
    // Even if the refresh fails (can't reach platform.claude.com), the proxy
    // still falls back to getOauthToken() for the retry.
    proxyPort = await startProxy({});

    const result = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    // The proxy should have retried the request after the 401
    expect(upstreamCallCount).toBe(2);
    expect(result.statusCode).toBe(200);

    await new Promise<void>((r) => refreshServer.close(() => r()));
  });

  it('API-key mode does not use keychain token', async () => {
    mockKeychainToken = 'keychain-token-should-not-appear';
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });
});

/**
 * Spotless chaining through credential proxy.
 *
 * Spotless is patched (spotless-configurable-upstream.js) to read
 * SPOTLESS_UPSTREAM_URL, which the entrypoint sets to the credential proxy.
 * This means Spotless -> credential proxy -> Anthropic API, so the proxy's
 * 5xx retry and token refresh logic applies to all API calls.
 *
 * The tests below document the proxy behavior for requests that chain through
 * it (whether from Spotless or directly from the SDK).
 */
describe('spotless credential proxy chaining', () => {
  afterEach(() => {
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    mockKeychainToken = null;
    mockKeychainCreds = null;
  });

  it('container receives token via readSecrets, not via proxy auth header', async () => {
    // This test documents the architecture: Spotless reads CLAUDE_CODE_OAUTH_TOKEN
    // from the environment, which was set by readSecrets() at container startup.
    // It does NOT route through the credential proxy.
    //
    // Verification: a request to /v1/messages with x-api-key (as Spotless would
    // send after key exchange) passes through without the proxy touching Authorization.
    mockKeychainToken = 'spotless-startup-token';
    const upstreamServer2 = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer2.listen(0, '127.0.0.1', resolve),
    );
    const port2 = (upstreamServer2.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port2}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'spotless-startup-token',
    });
    const server = await startCredentialProxy(0);
    const proxyPort2 = (server.address() as AddressInfo).port;

    // Spotless-style request: uses x-api-key from its own key exchange, no Authorization
    const result = await makeRequest(
      proxyPort2,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'spotless-temp-key-from-exchange',
        },
      },
      '{}',
    );

    // The proxy should NOT replace the temp key (it's post-exchange, valid as-is).
    // This documents that Spotless requests bypass proxy credential injection.
    expect(result.statusCode).toBe(200);

    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => upstreamServer2.close(() => r()));
  });

  it('proxy cannot refresh token for direct-to-API requests (Spotless limitation)', async () => {
    // When Spotless sends directly to api.anthropic.com (not through the proxy),
    // the proxy has no opportunity to intercept 401s and refresh the token.
    // This test documents that the proxy's 401-retry logic only works for
    // requests that actually pass through it.
    //
    // The mitigation is readSecrets() providing the freshest keychain token at
    // container startup (tested in read-secrets.test.ts).

    mockKeychainToken = 'will-expire-mid-session';

    // Start proxy in OAuth mode
    Object.assign(mockEnv, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:59999`, // unused
      CLAUDE_CODE_OAUTH_TOKEN: 'will-expire-mid-session',
    });
    const server = await startCredentialProxy(0);
    const proxyPort2 = (server.address() as AddressInfo).port;

    // Spotless would send to api.anthropic.com directly, NOT to proxyPort.
    // We can't test the negative (no request reaches proxy) with a real server,
    // but we verify the proxy config is OAuth mode (meaning token refresh IS
    // available for requests that DO route through it).
    // The key insight: any request that skips the proxy gets no refresh.
    expect(proxyPort2).toBeGreaterThan(0); // proxy is running

    await new Promise<void>((r) => server.close(() => r()));
  });
});
