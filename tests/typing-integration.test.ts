import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Integration tests that verify TypingManager is correctly wired into index.ts.
 *
 * Since processGroupMessages is deeply coupled to WhatsApp, SQLite, and Docker,
 * we verify the wiring statically by inspecting the source code. This ensures:
 * - TypingManager is imported and instantiated
 * - Inline typing interval logic is replaced with typingManager.start/stop
 * - Piped messages path uses typingManager.start
 */

const indexSource = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'index.ts'),
  'utf-8',
);

describe('TypingManager integration in index.ts', () => {
  it('imports TypingManager from typing module', () => {
    expect(indexSource).toMatch(
      /import\s+\{[^}]*TypingManager[^}]*\}\s+from\s+['"]\.\/typing\.js['"]/,
    );
  });

  it('creates a typingManager instance', () => {
    expect(indexSource).toMatch(/(const|let)\s+typingManager\s*(:\s*TypingManager\s*)?=?\s*(new\s+TypingManager)?/);
  });

  it('uses typingManager.start in processGroupMessages instead of inline setInterval', () => {
    // The old pattern: setInterval(() => setTyping(...), 4000)
    expect(indexSource).not.toMatch(/setInterval\(\s*\(\)\s*=>\s*setTyping/);
    // The old pattern: let typingInterval
    expect(indexSource).not.toMatch(/let\s+typingInterval/);
    // The new pattern: typingManager.start should appear in processGroupMessages
    expect(indexSource).toMatch(/typingManager\.start\(chatJid\)/);
  });

  it('uses typingManager.stop in the finally block', () => {
    // The finally block should call typingManager.stop, not clearTyping
    expect(indexSource).not.toMatch(/clearTyping\(\)/);
    expect(indexSource).toMatch(/typingManager\.stop\(chatJid\)/);
  });

  it('does not define a clearTyping function', () => {
    // The old clearTyping helper should be removed
    expect(indexSource).not.toMatch(/const\s+clearTyping\s*=/);
  });

  it('uses typingManager.start for piped messages in startMessageLoop', () => {
    // In the piped messages path, should use typingManager.start not bare setTyping
    // Look for the pattern: queue.sendMessage followed by typingManager.start
    const pipedSection = indexSource.match(
      /queue\.sendMessage\(chatJid,\s*formatted\)[\s\S]{0,300}typingManager\.start/,
    );
    expect(pipedSection).not.toBeNull();
  });

  it('does NOT restart typing after sending agent output', () => {
    // With isSingleUserTurn=false, the SDK query stays open. After type=result,
    // the agent is idle waiting for piped messages. Typing should NOT restart.
    // Typing only restarts when new messages are piped in (startMessageLoop).
    const outputSection = indexSource.match(
      /await\s+routeOutbound\(channels,\s*chatJid,\s*formatted\)[\s\S]{0,300}resetIdleTimer/,
    );
    expect(outputSection).not.toBeNull();
    // Ensure no typingManager.start between routeOutbound and resetIdleTimer
    expect(outputSection![0]).not.toMatch(/typingManager\.start/);
  });
});
