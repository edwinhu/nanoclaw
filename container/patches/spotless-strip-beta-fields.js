#!/usr/bin/env node
/**
 * Patch Spotless proxy.ts to strip experimental beta body fields from API requests.
 *
 * Claude Code SDK v2.1.77+ sends experimental beta features (context_management,
 * output_config) in the request body. These require matching anthropic-beta headers.
 * When Spotless modifies the request body (augments system prompt, replaces messages,
 * strips cache_control), the combination can cause intermittent 400 errors from the
 * Anthropic API. The error message is just "Error" — extremely vague.
 *
 * This patch strips these experimental fields from the body before forwarding,
 * which is safe because:
 * 1. context_management enables automatic compaction — Spotless already handles
 *    context management via its own history/memory system
 * 2. output_config enables structured output format — not needed for NanoClaw's
 *    agent workflows
 *
 * See: https://github.com/anthropics/claude-code/issues/21612
 */

const fs = require('fs');
const path = process.argv[2];

if (!path) {
  console.error('Usage: node spotless-strip-beta-fields.js <path-to-proxy.ts>');
  process.exit(1);
}

let src = fs.readFileSync(path, 'utf-8');

// Find the line where forwardBody is created and add field stripping after it
const target = 'const forwardBody = { ...body, stream: true };';
const replacement = `const forwardBody = { ...body, stream: true };

        // Strip experimental beta body fields that cause 400 errors when Spotless
        // modifies the request (system prompt augmentation, message rewriting,
        // cache_control stripping). These features require matching beta headers
        // and specific body structure that Spotless's rewrites can disrupt.
        // See: https://github.com/anthropics/claude-code/issues/21612
        delete (forwardBody as Record<string, unknown>).context_management;
        delete (forwardBody as Record<string, unknown>).output_config;

        // Downgrade adaptive thinking to standard thinking. Adaptive thinking
        // (type: "adaptive") is an experimental beta that is incompatible with
        // Spotless's request modifications. Standard thinking (type: "enabled")
        // works correctly with Spotless.
        if ((forwardBody as Record<string, any>).thinking?.type === "adaptive") {
          (forwardBody as Record<string, any>).thinking = { type: "enabled", budget_tokens: 10000 };
        }`;

if (!src.includes(target)) {
  console.error('Could not find forwardBody creation in', path);
  process.exit(1);
}

src = src.replace(target, replacement);
fs.writeFileSync(path, src);
console.log('[spotless-patch] Added beta field stripping to forwardBody in', path);
