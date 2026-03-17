#!/usr/bin/env node
/**
 * Patch Spotless digest-prompt.ts to filter out self-referential identity fluff.
 *
 * The digest and reflection passes tend to create memories like "I trace bugs
 * systematically", "I am autonomous", "I steward infrastructure" — these waste
 * retrieval slots without providing actionable recall. This patch appends
 * guidance to the digest system prompt and reflection system prompt to skip
 * such self-referential statements.
 */

const fs = require('fs');
const path = process.argv[2];

if (!path) {
  console.error('Usage: node spotless-digest-filter.js <path-to-digest-prompt.ts>');
  process.exit(1);
}

let src = fs.readFileSync(path, 'utf-8');

// --- Patch 1: Digest system prompt ---
// Find the consolidation guidelines section and append filter guidance
const digestMarker = '## CONSOLIDATION GUIDELINES';
const digestIdx = src.indexOf(digestMarker);
if (digestIdx === -1) {
  console.error('Could not find "## CONSOLIDATION GUIDELINES" in', path);
  process.exit(1);
}

const filterGuidance = `

**Self-referential filter**: Do NOT create memories about the agent's own nature, identity, capabilities, or work style. Skip any self-referential statements like "I trace bugs systematically", "I am autonomous", "I steward infrastructure", "I value rigor", "I approach problems carefully". These are not useful memories — they waste retrieval slots and get recreated every digest cycle. Focus ONLY on: concrete facts about the user, their projects, decisions made, preferences expressed, specific bugs/issues discovered, and operational knowledge (API quirks, tool limitations, config details).`;

// Insert after the CONSOLIDATION GUIDELINES header line
const guidelinesEndOfLine = src.indexOf('\n', digestIdx);
const afterHeader = src.indexOf('\n', guidelinesEndOfLine + 1); // skip the blank line after header
src = src.slice(0, afterHeader) + filterGuidance + src.slice(afterHeader);

// --- Patch 2: Reflection system prompt ---
// The reflection pass is where most self-referential identity bloat comes from.
// Find the reflection guidelines section and add filter.
const reflectionMarker = '## GUIDELINES';
// Find the one inside buildReflectionSystemPrompt (there's only one ## GUIDELINES)
const reflectionIdx = src.indexOf(reflectionMarker);
if (reflectionIdx === -1) {
  console.error('Could not find "## GUIDELINES" in', path);
  process.exit(1);
}

const reflectionFilter = `
- **Self-referential filter**: Do NOT create self-concept facts about generic agent traits like "I trace bugs systematically", "I am autonomous", "I steward infrastructure", "I value rigor". These are vacuous — every competent agent could say them. Only create self-concept facts that are SPECIFIC to this agent's unique experiences, the user's specific preferences, or concrete lessons learned from particular incidents. Ask: "Would a fresh agent need this to serve the user better?" If no, skip it.`;

// Insert after the GUIDELINES header
const guidelinesEndOfLine2 = src.indexOf('\n', reflectionIdx);
src = src.slice(0, guidelinesEndOfLine2) + reflectionFilter + src.slice(guidelinesEndOfLine2);

fs.writeFileSync(path, src);
console.log('[spotless-patch] Added self-referential memory filter to digest and reflection prompts in', path);
