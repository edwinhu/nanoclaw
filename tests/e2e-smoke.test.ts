/**
 * E2E Smoke Test: Verify container agent can call Anthropic API
 *
 * Spawns a real Docker container with the same env vars as container-runner.ts
 * and verifies the agent can make a successful API call without 400 errors.
 *
 * Prerequisites:
 *   - Docker/OrbStack running with nanoclaw-agent:latest built
 *   - Credential proxy running on port 3001
 *   - Valid OAuth credentials (keychain or .env)
 *
 * Run:  npx vitest run tests/e2e-smoke.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const CONTAINER_IMAGE = 'nanoclaw-agent:latest';
const CREDENTIAL_PROXY_PORT = 3001;
const CONTAINER_HOST_GATEWAY = 'host.docker.internal';
const PROMPT = 'Say hello in exactly 5 words. No other text.';

function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function isCredentialProxyRunning(): boolean {
  try {
    execSync(`curl -sf http://localhost:${CREDENTIAL_PROXY_PORT}/ -o /dev/null -w '%{http_code}'`, {
      stdio: 'pipe',
      timeout: 5000,
    });
    return true;
  } catch {
    // The proxy returns various codes; any TCP connection means it's running
    try {
      execSync(`lsof -i :${CREDENTIAL_PROXY_PORT} -sTCP:LISTEN`, {
        stdio: 'pipe',
        timeout: 3000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

function isImageBuilt(): boolean {
  try {
    execSync(`docker image inspect ${CONTAINER_IMAGE}`, {
      stdio: 'pipe',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a minimal temp directory structure that the container entrypoint expects.
 * Returns { tmpDir, claudeDir, ipcDir, groupDir } paths.
 */
function createTempDirs() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'nanoclaw-smoke-'));
  const claudeDir = path.join(tmpDir, '.claude');
  const ipcDir = path.join(tmpDir, 'ipc');
  const groupDir = path.join(tmpDir, 'group');

  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  mkdirSync(groupDir, { recursive: true });

  // Write minimal settings.json
  writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ env: {} }, null, 2),
  );

  // Write input.json (the container entrypoint reads this)
  writeFileSync(
    path.join(ipcDir, 'input.json'),
    JSON.stringify({
      prompt: PROMPT,
      groupFolder: 'smoke-test',
      chatJid: 'test:smoke',
      isMain: false,
      secrets: {},
    }),
  );

  return { tmpDir, claudeDir, ipcDir, groupDir };
}

function buildDockerArgs(opts: {
  claudeDir: string;
  ipcDir: string;
  groupDir: string;
  disableSpotless: boolean;
  containerName: string;
}): string[] {
  const args = [
    'run', '-i', '--rm',
    '--name', opts.containerName,
    '-e', `TZ=America/New_York`,
    '-e', `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
    '-e', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1',
    '-e', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1',
    '-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder',
  ];

  if (opts.disableSpotless) {
    args.push('-e', 'DISABLE_SPOTLESS=1');
  }

  // Volume mounts
  args.push(
    '-v', `${opts.claudeDir}:/home/node/.claude`,
    '-v', `${opts.ipcDir}:/workspace/ipc`,
    '-v', `${opts.groupDir}:/workspace/group`,
  );

  args.push(CONTAINER_IMAGE);

  return args;
}

const dockerOk = isDockerAvailable();
const proxyOk = isCredentialProxyRunning();
const imageOk = dockerOk && isImageBuilt();

describe.skipIf(!dockerOk)('Docker availability', () => {
  it('docker is running', () => {
    expect(dockerOk).toBe(true);
  });
});

describe.skipIf(!proxyOk)('Credential proxy availability', () => {
  it('credential proxy is listening on port 3001', () => {
    expect(proxyOk).toBe(true);
  });
});

describe.skipIf(!dockerOk || !proxyOk || !imageOk)(
  'Smoke test: container API call',
  () => {
    it('container exits 0 with DISABLE_SPOTLESS (direct proxy)', () => {
      const { tmpDir, claudeDir, ipcDir, groupDir } = createTempDirs();
      const containerName = `smoke-nospotless-${Date.now()}`;

      try {
        const dockerArgs = buildDockerArgs({
          claudeDir,
          ipcDir,
          groupDir,
          disableSpotless: true,
          containerName,
        });

        const result = execSync(
          `docker ${dockerArgs.map(a => `'${a}'`).join(' ')}`,
          {
            timeout: 90_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            input: JSON.stringify({
              prompt: PROMPT,
              groupFolder: 'smoke-test',
              chatJid: 'test:smoke',
              isMain: false,
              secrets: {},
            }),
          },
        );

        // Container exited 0 (execSync throws on non-zero)
        // Verify output contains actual agent response (not just error JSON)
        expect(result).toBeTruthy();
        expect(result).not.toContain('"type":"error"');
        expect(result).not.toContain('invalid_request_error');
        expect(result).not.toContain('API Error: 400');

        // Should contain the output markers from agent-runner
        expect(result).toContain('NANOCLAW_OUTPUT');

        console.log('PASS: Container with DISABLE_SPOTLESS exited 0');
        console.log('Output length:', result.length, 'chars');
      } finally {
        // Cleanup: kill container if still running, remove temp dir
        try { execSync(`docker kill ${containerName}`, { stdio: 'pipe' }); } catch { /* already stopped */ }
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 90_000);

    it('container exits 0 with Spotless enabled (full chain)', () => {
      const { tmpDir, claudeDir, ipcDir, groupDir } = createTempDirs();
      const containerName = `smoke-spotless-${Date.now()}`;

      // Create spotless data dir
      const spotlessDir = path.join(tmpDir, '.spotless');
      mkdirSync(spotlessDir, { recursive: true });

      try {
        const dockerArgs = buildDockerArgs({
          claudeDir,
          ipcDir,
          groupDir,
          disableSpotless: false,
          containerName,
        });

        // Add spotless mount
        const spotlessIdx = dockerArgs.indexOf(CONTAINER_IMAGE);
        dockerArgs.splice(
          spotlessIdx, 0,
          '-v', `${spotlessDir}:/home/node/.spotless`,
        );

        const result = execSync(
          `docker ${dockerArgs.map(a => `'${a}'`).join(' ')}`,
          {
            timeout: 90_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            input: JSON.stringify({
              prompt: PROMPT,
              groupFolder: 'smoke-test',
              chatJid: 'test:smoke',
              isMain: false,
              secrets: {},
            }),
          },
        );

        // Container exited 0
        expect(result).toBeTruthy();
        expect(result).not.toContain('invalid_request_error');
        expect(result).not.toContain('API Error: 400');

        console.log('PASS: Container with Spotless exited 0');
        console.log('Output length:', result.length, 'chars');
      } finally {
        try { execSync(`docker kill ${containerName}`, { stdio: 'pipe' }); } catch { /* already stopped */ }
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
