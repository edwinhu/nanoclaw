#!/usr/bin/env node
/**
 * Patch Spotless proxy.ts to insert the orientation block AFTER the
 * x-anthropic-billing-header instead of BEFORE it.
 *
 * The claude-code-20250219 beta requires the billing header to be the
 * FIRST system prompt block. Spotless's augmentSystemPrompt() prepends
 * the orientation block, pushing the billing header to index 1, which
 * causes a 400 "Error" from the Anthropic API.
 *
 * Fix: for array system prompts, find the billing header block and
 * insert orientation AFTER it (or at index 0 if no billing header).
 */

const fs = require('fs');
const path = process.argv[2];

if (!path) {
  console.error('Usage: node spotless-billing-header-order.js <path-to-proxy.ts>');
  process.exit(1);
}

let src = fs.readFileSync(path, 'utf-8');

// Replace the augmentSystemPrompt function's array handling
const target = `  // SystemBlock[] — prepend as first block
  return [{ type: "text", text: orientation } as SystemBlock, ...system];`;

const replacement = `  // SystemBlock[] — insert AFTER the billing header block.
  // The claude-code-20250219 beta requires x-anthropic-billing-header
  // to be the first system block. Inserting before it causes 400 errors.
  const billingIdx = system.findIndex(
    (b: SystemBlock) => typeof (b as any).text === "string" && (b as any).text.startsWith("x-anthropic-billing-header")
  );
  if (billingIdx >= 0) {
    // Insert orientation right after the billing header
    const result = [...system];
    result.splice(billingIdx + 1, 0, { type: "text", text: orientation } as SystemBlock);
    return result;
  }
  // No billing header found — prepend as before
  return [{ type: "text", text: orientation } as SystemBlock, ...system];`;

if (!src.includes(target)) {
  console.error('Could not find augmentSystemPrompt array handling in', path);
  console.error('Looking for:', target);
  process.exit(1);
}

src = src.replace(target, replacement);
fs.writeFileSync(path, src);
console.log('[spotless-patch] Fixed billing header ordering in augmentSystemPrompt in', path);
