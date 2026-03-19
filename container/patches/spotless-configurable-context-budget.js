#!/usr/bin/env node
/**
 * Patch Spotless tokens.ts to read context budget from SPOTLESS_CONTEXT_BUDGET env var.
 *
 * By default, Spotless hardcodes DEFAULT_CONTEXT_BUDGET = 500_000, which sends
 * ~430K tokens of history per request. This easily exceeds Claude Max per-minute
 * rate limits, especially with back-to-back container runs.
 *
 * This patch replaces the hardcoded constant with a runtime env var lookup:
 *   export const DEFAULT_CONTEXT_BUDGET = parseInt(process.env.SPOTLESS_CONTEXT_BUDGET || "500000", 10);
 */

const fs = require('fs');
const path = process.argv[2];

if (!path) {
  console.error('Usage: node spotless-configurable-context-budget.js <path-to-tokens.ts>');
  process.exit(1);
}

let src = fs.readFileSync(path, 'utf-8');

const original = 'export const DEFAULT_CONTEXT_BUDGET = 500_000;';
const replacement = 'export const DEFAULT_CONTEXT_BUDGET = parseInt(process.env.SPOTLESS_CONTEXT_BUDGET || "500000", 10);';

if (!src.includes(original)) {
  console.error('Could not find DEFAULT_CONTEXT_BUDGET in', path);
  process.exit(1);
}

src = src.replace(original, replacement);
fs.writeFileSync(path, src);
console.log('[spotless-patch] Made context budget configurable via SPOTLESS_CONTEXT_BUDGET in', path);
