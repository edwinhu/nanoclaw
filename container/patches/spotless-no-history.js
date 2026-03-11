#!/usr/bin/env node
/**
 * Patch Spotless history.ts to disable raw history replay.
 *
 * Replaces the buildHistory() export with a stub that returns empty messages
 * but preserves consolidation pressure calculation (needed for digest scheduling).
 *
 * The original function is renamed to _buildHistoryOriginal for reference.
 */

const fs = require('fs');
const path = process.argv[2];

if (!path) {
  console.error('Usage: node spotless-no-history.js <path-to-history.ts>');
  process.exit(1);
}

let src = fs.readFileSync(path, 'utf-8');

// Find the export function buildHistory signature
const marker = 'export function buildHistory(';
const idx = src.indexOf(marker);
if (idx === -1) {
  console.error('Could not find "export function buildHistory(" in', path);
  process.exit(1);
}

// Insert the stub before the original, rename original
const stub = `export function buildHistory(
  db: Database,
  budget: number = HISTORY_BUDGET,
  agentName: string | null = null,
): HistoryResult {
  // Patched by NanoClaw: skip raw history replay.
  // NanoClaw's MessageStream handles in-session context.
  // Spotless digested memories + identity handle cross-session recall.
  let pressure = 0;
  let unconsolidatedTokens = 0;
  try {
    const pr = getConsolidationPressure(db, budget);
    pressure = pr.pressure;
    unconsolidatedTokens = pr.unconsolidatedTokens;
  } catch {}
  return { messages: [], trimmedCount: 0, pressure, unconsolidatedTokens };
}

// Original preserved for reference/debugging
`;

src = src.slice(0, idx) + stub + src.slice(idx).replace(marker, 'function _buildHistoryOriginal(');

fs.writeFileSync(path, src);
console.log('[spotless-patch] Disabled raw history replay in', path);
