#!/usr/bin/env node
/**
 * Patch Spotless history.ts to fix trimTobudget() destroying the preamble.
 *
 * Bug: buildHistory() prepends a 2-message preamble (user + assistant) to
 * orient the agent about its memory system. trimTobudget() then trims from
 * index 0, removing the preamble when the history exceeds the token budget.
 * This causes:
 * 1. First message is assistant (not user) — API requires user first
 * 2. First assistant message may have tool_use without preceding context
 * 3. API rejects with 400: "tool_use ids without tool_result blocks"
 *
 * Fix: Replace trimTobudget() to:
 * - Protect the first 2 messages (preamble) from trimming
 * - Skip orphaned assistant tool_use messages at the trim boundary
 *   (not just orphaned user tool_result messages)
 * - Ensure the first kept message after preamble starts a clean context
 */

const fs = require('fs');
const path = process.argv[2];

if (!path) {
  console.error('Usage: node spotless-fix-trim-preamble.js <path-to-history.ts>');
  process.exit(1);
}

let src = fs.readFileSync(path, 'utf-8');

// Find the trimTobudget function and replace it entirely.
// Match from "function trimTobudget" to the closing brace before the next function.
const oldTrimStart = `function trimTobudget(messages: Message[], budget: number): { messages: Message[]; trimmedCount: number } {`;
const idx = src.indexOf(oldTrimStart);
if (idx === -1) {
  console.error('Could not find trimTobudget function in', path);
  process.exit(1);
}

// Find the end of the function — look for the closing brace at the same indent level
// The function ends with "  return { messages: messages.slice(start), trimmedCount: start };\n}"
const returnPattern = `return { messages: messages.slice(start), trimmedCount: start };`;
const returnIdx = src.indexOf(returnPattern, idx);
if (returnIdx === -1) {
  console.error('Could not find trimTobudget return statement in', path);
  process.exit(1);
}
// Find the closing brace after the return
const closingBrace = src.indexOf('\n}', returnIdx);
if (closingBrace === -1) {
  console.error('Could not find trimTobudget closing brace in', path);
  process.exit(1);
}

const oldFunction = src.slice(idx, closingBrace + 2); // include \n}

const newFunction = `function trimTobudget(messages: Message[], budget: number): { messages: Message[]; trimmedCount: number } {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }

  // Protect the first 2 messages (preamble: user orientation + assistant ack).
  // Without them, the first message would be assistant, which the API rejects.
  const protectedCount = Math.min(2, messages.length);

  // Trim from front, but AFTER the protected preamble
  let start = protectedCount;
  while (total > budget && start < messages.length - 1) {
    total -= estimateMessageTokens(messages[start]!);
    start++;
  }

  // After trimming, the first remaining message might be an orphaned tool_result
  // (its preceding assistant tool_use was trimmed). Skip past any such orphans.
  while (start < messages.length - 1 && hasToolResult(messages[start]!) &&
         messages[start]!.role === "user") {
    total -= estimateMessageTokens(messages[start]!);
    start++;
  }

  // Also skip orphaned assistant messages with tool_use at the trim boundary.
  // If the first kept message is an assistant with tool_use, the API expects
  // the next message to have matching tool_results — but the context is broken
  // (previous user message was trimmed). Skip until we find a clean start.
  while (start < messages.length - 1 && messages[start]!.role === "assistant" &&
         hasToolUse(messages[start]!)) {
    total -= estimateMessageTokens(messages[start]!);
    start++;
    // Also skip the following user tool_result if present
    while (start < messages.length - 1 && hasToolResult(messages[start]!) &&
           messages[start]!.role === "user") {
      total -= estimateMessageTokens(messages[start]!);
      start++;
    }
  }

  // Combine: protected preamble + trimmed history
  const kept = [...messages.slice(0, protectedCount), ...messages.slice(start)];
  return { messages: kept, trimmedCount: start - protectedCount };
}`;

src = src.replace(oldFunction, newFunction);

fs.writeFileSync(path, src);
console.log('[spotless-patch] Fixed trimTobudget to protect preamble and handle orphaned tool_use in', path);
