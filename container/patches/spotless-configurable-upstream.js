#!/usr/bin/env node
/**
 * Patch Spotless proxy.ts to read upstream URL from SPOTLESS_UPSTREAM_URL env var.
 *
 * By default, Spotless hardcodes `https://api.anthropic.com` as the upstream.
 * NanoClaw needs Spotless to forward through the credential proxy instead, so
 * that the proxy's 5xx retry and token refresh logic applies to all API calls.
 *
 * This patch replaces the hardcoded constant with a runtime env var lookup:
 *   const ANTHROPIC_API_URL = process.env.SPOTLESS_UPSTREAM_URL || "https://api.anthropic.com";
 */

const fs = require('fs');
const path = process.argv[2];

if (!path) {
  console.error('Usage: node spotless-configurable-upstream.js <path-to-proxy.ts>');
  process.exit(1);
}

let src = fs.readFileSync(path, 'utf-8');

const original = 'const ANTHROPIC_API_URL = "https://api.anthropic.com";';
const replacement = 'const ANTHROPIC_API_URL = process.env.SPOTLESS_UPSTREAM_URL || "https://api.anthropic.com";';

if (!src.includes(original)) {
  console.error('Could not find hardcoded ANTHROPIC_API_URL in', path);
  process.exit(1);
}

src = src.replace(original, replacement);
fs.writeFileSync(path, src);
console.log('[spotless-patch] Made upstream URL configurable via SPOTLESS_UPSTREAM_URL in', path);
