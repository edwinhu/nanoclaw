#!/usr/bin/env node
/**
 * Temporary diagnostic patch: dump the full request body on 400 errors.
 * This helps identify what Spotless sends that Anthropic rejects.
 */

const fs = require('fs');
const path = process.argv[2];

if (!path) {
  console.error('Usage: node spotless-debug-400.js <path-to-proxy.ts>');
  process.exit(1);
}

let src = fs.readFileSync(path, 'utf-8');

// Replace the 400 error handler to dump the full request body
const original = `    // Diagnostic: log details on 400 errors to help debug
    if (resp.status === 400) {
      try {
        const errorBody = await resp.clone().text();
        logError(\`[spotless] API 400: \${errorBody.slice(0, 500)}\`);`;

const replacement = `    // Diagnostic: log details on 400 errors to help debug
    if (resp.status === 400) {
      try {
        const errorBody = await resp.clone().text();
        logError(\`[spotless] API 400: \${errorBody.slice(0, 500)}\`);
        // DEBUG: dump request body keys and message structure
        const bodyKeys = Object.keys(body).join(', ');
        const msgCount = body.messages?.length ?? 0;
        const msgRoles = body.messages?.map((m: any) => m.role).join(', ') ?? 'none';
        const model = body.model ?? 'unknown';
        const hasThinking = 'thinking' in body;
        const thinkingVal = hasThinking ? JSON.stringify((body as any).thinking) : 'absent';
        const hasBetas = 'betas' in body;
        const betasVal = hasBetas ? JSON.stringify((body as any).betas) : 'absent';
        const systemType = typeof body.system;
        const systemLen = typeof body.system === 'string' ? body.system.length : Array.isArray(body.system) ? body.system.length : 0;
        logDiagnostic(\`[400-debug] model=\${model} keys=[\${bodyKeys}] msgs=\${msgCount} roles=[\${msgRoles}] thinking=\${thinkingVal} betas=\${betasVal} system_type=\${systemType} system_len=\${systemLen}\`);
        // Dump first and last message content types
        for (let mi = 0; mi < Math.min(3, msgCount); mi++) {
          const msg = body.messages[mi];
          if (typeof msg.content === 'string') {
            logDiagnostic(\`[400-debug] msg[\${mi}] role=\${msg.role} type=string len=\${msg.content.length}\`);
          } else if (Array.isArray(msg.content)) {
            const blockTypes = msg.content.map((b: any) => b.type).join(', ');
            logDiagnostic(\`[400-debug] msg[\${mi}] role=\${msg.role} blocks=[\${blockTypes}]\`);
            // Check for thinking blocks
            for (let bi = 0; bi < msg.content.length; bi++) {
              const block = msg.content[bi] as any;
              if (block.type === 'thinking') {
                logDiagnostic(\`[400-debug] msg[\${mi}].content[\${bi}] thinking len=\${block.thinking?.length ?? 0} has_signature=\${!!block.signature}\`);
              }
            }
          }
        }`;

if (!src.includes(original)) {
  console.error('Could not find 400 error handler in', path);
  // Try a simpler match
  const simpleOriginal = 'logError(`[spotless] API 400: ${errorBody.slice(0, 500)}`);';
  if (!src.includes(simpleOriginal)) {
    console.error('Could not find simple match either');
    process.exit(1);
  }

  const simpleReplacement = `logError(\`[spotless] API 400: \${errorBody.slice(0, 500)}\`);
        // DEBUG: dump request body keys and message structure
        const bodyKeys = Object.keys(body).join(', ');
        const msgCount = body.messages?.length ?? 0;
        const msgRoles = body.messages?.map((m: any) => m.role).join(', ') ?? 'none';
        const model = body.model ?? 'unknown';
        const hasThinking = 'thinking' in body;
        const thinkingVal = hasThinking ? JSON.stringify((body as any).thinking) : 'absent';
        const hasBetas = 'betas' in body;
        const betasVal = hasBetas ? JSON.stringify((body as any).betas) : 'absent';
        logDiagnostic(\`[400-debug] model=\${model} keys=[\${bodyKeys}] msgs=\${msgCount} roles=[\${msgRoles}] thinking=\${thinkingVal} betas=\${betasVal}\`);
        for (let mi = 0; mi < Math.min(3, msgCount); mi++) {
          const msg = body.messages[mi];
          if (typeof msg.content === 'string') {
            logDiagnostic(\`[400-debug] msg[\${mi}] role=\${msg.role} type=string len=\${msg.content.length}\`);
          } else if (Array.isArray(msg.content)) {
            const blockTypes = msg.content.map((b: any) => b.type).join(', ');
            logDiagnostic(\`[400-debug] msg[\${mi}] role=\${msg.role} blocks=[\${blockTypes}]\`);
          }
        }`;

  src = src.replace(simpleOriginal, simpleReplacement);
  fs.writeFileSync(path, src);
  console.log('[spotless-debug-400] Added diagnostic logging (simple match) in', path);
  process.exit(0);
}

src = src.replace(original, replacement);
fs.writeFileSync(path, src);
console.log('[spotless-debug-400] Added diagnostic logging in', path);
