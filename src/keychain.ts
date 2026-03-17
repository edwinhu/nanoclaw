import { execFileSync } from 'child_process';
import { logger } from './logger.js';

export interface KeychainOAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
}

// Cache keychain reads for 5 minutes — avoids spawning `security` on every API request
// while ensuring we pick up refreshed tokens before they expire.
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedToken: string | null = null;
let cachedCredentials: KeychainOAuthCredentials | null = null;
let cacheTimestamp = 0;

function readRawKeychainData(): Record<string, unknown> | null {
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read the Claude Code OAuth token from the macOS keychain.
 * Returns null if not on macOS, keychain entry doesn't exist, or parse fails.
 */
export function readKeychainOAuthToken(): string | null {
  const now = Date.now();
  if (cachedToken && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedToken;
  }

  const parsed = readRawKeychainData();
  if (!parsed) return cachedToken;

  // The keychain stores credentials under claudeAiOauth (newer) or oauthAccount (older)
  const oauth = (parsed?.claudeAiOauth ?? parsed?.oauthAccount) as
    | Record<string, unknown>
    | undefined;
  const token = (oauth?.accessToken as string) ?? null;

  if (token && typeof token === 'string') {
    cachedToken = token;
    cacheTimestamp = now;
    logger.debug('Keychain OAuth token refreshed');
  }
  return cachedToken;
}

/**
 * Read the full OAuth credential object from the macOS keychain.
 * Returns null if not on macOS, keychain entry doesn't exist, or parse fails.
 * Includes refreshToken and expiresAt needed for token refresh.
 */
export function readKeychainOAuthCredentials(): KeychainOAuthCredentials | null {
  const now = Date.now();
  if (cachedCredentials && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedCredentials;
  }

  const parsed = readRawKeychainData();
  if (!parsed) return cachedCredentials;

  const oauth =
    (parsed?.claudeAiOauth as KeychainOAuthCredentials) ??
    (parsed?.oauthAccount as KeychainOAuthCredentials) ??
    null;

  if (oauth?.accessToken) {
    cachedCredentials = oauth;
    cachedToken = oauth.accessToken;
    cacheTimestamp = now;
    logger.debug('Keychain OAuth credentials refreshed');
  }
  return cachedCredentials;
}

/** @internal — for tests */
export function _resetKeychainCacheForTests(): void {
  cachedToken = null;
  cachedCredentials = null;
  cacheTimestamp = 0;
}
