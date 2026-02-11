/**
 * CDP-based typing indicator test.
 *
 * Connects directly to Beeper Desktop via Chrome DevTools Protocol and
 * verifies typing indicator DOM elements appear/disappear during agent processing.
 *
 * Prerequisites:
 *   - Beeper Desktop running with --remote-debugging-port=9334
 *   - NanoClaw service running
 *   - Bot's Telegram chat ("Clawd") open in Beeper
 *
 * Run:  npx vitest run tests/typing-cdp.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CDPClient, connectCDP, evaluate, hasTypingIndicator, getTypingDetails, TYPING_SELECTORS } from './helpers/cdp.js';

const CHAT_NAME = 'Clawd';
// Use a prompt that forces real work so typing persists long enough to detect
const TRIGGER_MSG =
  'Write a detailed 3-paragraph essay about the history of mechanical keyboards. Be thorough and cite specific years.';

async function sendBeeperMessage(
  cdp: CDPClient,
  text: string,
): Promise<void> {
  // Focus the composer
  await evaluate(
    cdp,
    `(() => {
    const editor = document.querySelector('.tiptap.ProseMirror[contenteditable="true"]');
    if (editor) editor.focus();
    return !!editor;
  })()`,
  );

  // Type each character via CDP Input
  for (const char of text) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      key: char,
    });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: char,
    });
  }

  // Press Enter to send
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
  });
}

describe('Typing indicator CDP detection', () => {
  let cdp: CDPClient;

  beforeAll(async () => {
    cdp = await connectCDP();

    // Ensure the Clawd chat is selected
    await evaluate(
      cdp,
      `(() => {
      const items = document.querySelectorAll('[class*="ThreadListItem"], [class*="PinnedThread"]');
      for (const item of items) {
        if (item.textContent?.includes('${CHAT_NAME}')) {
          item.click();
          return true;
        }
      }
      return false;
    })()`,
    );
    await new Promise((r) => setTimeout(r, 2000));
  }, 15_000);

  afterAll(() => {
    if (cdp) cdp.close();
  });

  it('detects no typing indicator when agent is idle', async () => {
    const typing = await hasTypingIndicator(cdp);
    expect(typing).toBe(false);
  });

  it(
    'full lifecycle: typing appears during processing and disappears after response',
    async () => {
      // Send a message to trigger the agent
      await sendBeeperMessage(cdp, TRIGGER_MSG);
      console.log('Message sent, starting rapid polling...');

      // Phase 1: Poll rapidly for typing to appear (agent spawn + processing)
      let typingAppeared = false;
      let typingDetails: {
        chatView: boolean;
        sidebar: boolean;
        brandBubble: boolean;
      } | null = null;
      const typingSamples: { time: number; typing: boolean }[] = [];
      const startTime = Date.now();

      // Poll for up to 60s — container may need to spawn
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const typing = await hasTypingIndicator(cdp);
        typingSamples.push({ time: Date.now() - startTime, typing });

        if (typing && !typingAppeared) {
          typingAppeared = true;
          typingDetails = await getTypingDetails(cdp);
          console.log(
            `Typing appeared at ${Date.now() - startTime}ms:`,
            typingDetails,
          );
        }

        // Once typing appeared, check if it persists for a bit then disappears
        if (typingAppeared) {
          // Continue polling until typing disappears
          if (!typing) {
            console.log(
              `Typing disappeared at ${Date.now() - startTime}ms`,
            );
            break;
          }
        }
      }

      // Analyze results
      const activeSamples = typingSamples.filter((s) => s.typing);
      const totalTime = typingSamples.length > 0
        ? typingSamples[typingSamples.length - 1].time
        : 0;

      console.log(
        `Polling summary: ${typingSamples.length} samples over ${totalTime}ms, ` +
          `${activeSamples.length} showed typing active`,
      );

      // Assertion 1: Typing indicator must have appeared at some point
      expect(typingAppeared).toBe(true);

      // Assertion 2: Typing details show expected DOM elements
      expect(
        typingDetails!.chatView || typingDetails!.brandBubble,
      ).toBe(true);

      // Assertion 3: Typing persisted for multiple samples (not just a blip)
      expect(activeSamples.length).toBeGreaterThanOrEqual(3);

      // Assertion 4: After the loop, typing should be gone (agent responded)
      const finalTyping = await hasTypingIndicator(cdp);
      expect(finalTyping).toBe(false);
    },
    120_000,
  );
});
