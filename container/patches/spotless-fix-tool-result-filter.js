#!/usr/bin/env node
/**
 * Patch Spotless history.ts to fix tool_result content being incorrectly
 * filtered by isSystemReminder().
 *
 * Bug: The SDK injects <system-reminder> content into tool_result blocks
 * (e.g., "The user sent a new message while you were working"). The
 * isSystemReminder() filter in reconstructMessage() removes these rows
 * regardless of content_type, creating orphaned tool_use blocks without
 * matching tool_results. The Anthropic API rejects this with 400:
 * "tool_use ids were found without tool_result blocks immediately after".
 *
 * Fix: Only filter text-type rows with isSystemReminder(). tool_result
 * rows must always be preserved for tool pairing integrity.
 *
 * Additionally, strengthens validateToolPairing() to verify all tool_use
 * IDs have matching tool_results (not just boolean existence).
 */

const fs = require('fs');
const path = process.argv[2];

if (!path) {
  console.error('Usage: node spotless-fix-tool-result-filter.js <path-to-history.ts>');
  process.exit(1);
}

let src = fs.readFileSync(path, 'utf-8');

// Fix 1: isSystemReminder filter must skip tool_result rows.
// The original line filters ALL rows by content, including tool_result rows.
const oldFilter = `const contentRows = rows.filter((r) => !isSystemReminder(r.content));`;
const newFilter = `const contentRows = rows.filter((r) => r.content_type === "tool_result" || !isSystemReminder(r.content));`;

if (!src.includes(oldFilter)) {
  console.error('Could not find isSystemReminder filter line in', path);
  process.exit(1);
}

src = src.replace(oldFilter, newFilter);

// Fix 2: Strengthen validateToolPairing to check all tool_use IDs have matching tool_results.
// The original only checks boolean hasToolUse/hasToolResult, missing partial matches.
const oldPairingCheck = `if (!next || next.role !== "user" || !hasToolResult(next)) {
        // Broken pair — skip this assistant message (and continue scanning)
        continue;
      }`;

const newPairingCheck = `if (!next || next.role !== "user" || !hasToolResult(next)) {
        // Broken pair — skip this assistant message (and continue scanning)
        continue;
      }

      // Verify ALL tool_use IDs have matching tool_results (not just boolean existence)
      {
        const useIds = getToolUseIds(msg);
        const resultIds = new Set(getToolResultIds(next));
        const missingIds = useIds.filter(id => !resultIds.has(id));
        if (missingIds.length > 0) {
          // Partial match — some tool_results missing. Skip this pair.
          i++; // skip the user message too
          continue;
        }
      }`;

if (!src.includes(oldPairingCheck)) {
  // Try to find a version that might have different whitespace
  console.warn('[spotless-patch] Warning: Could not find exact validateToolPairing check, skipping Fix 2');
} else {
  src = src.replace(oldPairingCheck, newPairingCheck);
}

// Fix 2b: Need getToolResultIds function (may not exist in history.ts)
// Add it if not present
if (!src.includes('function getToolResultIds(')) {
  // Add after the getToolUseIds function or at end of file
  const toolResultIdsFn = `

/**
 * Extract tool_result tool_use_id values from a message.
 */
function getToolResultIds(msg: Message): string[] {
  if (typeof msg.content === "string") return [];
  return msg.content
    .filter((b): b is { type: "tool_result"; tool_use_id: string; content: unknown } => b.type === "tool_result")
    .map(b => b.tool_use_id);
}`;

  // Insert before the last function or at end
  src = src.trimEnd() + '\n' + toolResultIdsFn + '\n';
}

fs.writeFileSync(path, src);
console.log('[spotless-patch] Fixed tool_result filtering and tool pairing validation in', path);
