#!/usr/bin/env node
/**
 * Patch Spotless archiver.ts to store "{}" instead of "" for tool_use blocks
 * with no input arguments (zero-argument MCP tools like list_tasks).
 *
 * Bug: When Claude calls a zero-argument tool (e.g. mcp__nanoclaw__list_tasks),
 * the SSE stream emits content_block_start and content_block_stop but NO
 * content_block_delta with partial_json — because the input is {} (empty).
 * The StreamTap accumulates no chunks, so content = chunks.join("") = "".
 * Spotless then stores content="" in raw_events for this tool_use row.
 *
 * On history replay, rowToContentBlock() calls tryParseJson("") which throws
 * (empty string is invalid JSON), logs a warning, and falls back to input={}.
 * The tool_use IS correctly replayed, but the warning fires on every replay.
 *
 * Fix: In content_block_stop, for tool_use blocks, default empty content to
 * "{}" so the stored value is valid JSON and tryParseJson succeeds silently.
 */

const fs = require('fs');
const path = process.argv[2];

if (!path) {
  console.error('Usage: node spotless-fix-empty-tool-input.js <path-to-archiver.ts>');
  process.exit(1);
}

let src = fs.readFileSync(path, 'utf-8');

// In content_block_stop handler, after computing content = chunks.join(""),
// for tool_use blocks default empty content to "{}" (valid JSON empty object).
const oldContentLine = `        const content = this.currentBlock.chunks.join("");
        const captured: CapturedBlock = {
          type: this.currentBlock.type,
          content,
        };`;

const newContentLine = `        const rawContent = this.currentBlock.chunks.join("");
        // For tool_use blocks, store "{}" instead of "" when input is empty.
        // Zero-argument tools (e.g. mcp__nanoclaw__list_tasks) produce no
        // partial_json deltas, leaving chunks empty. Storing "" causes a
        // tryParseJson warning on every history replay.
        const content = (this.currentBlock.type === "tool_use" && rawContent === "")
          ? "{}"
          : rawContent;
        const captured: CapturedBlock = {
          type: this.currentBlock.type,
          content,
        };`;

if (!src.includes(oldContentLine)) {
  console.error('Could not find content_block_stop content join in', path);
  process.exit(1);
}

src = src.replace(oldContentLine, newContentLine);

fs.writeFileSync(path, src);
console.log('[spotless-patch] Fixed empty tool_use input storage in', path);
