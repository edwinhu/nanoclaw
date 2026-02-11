/**
 * Shared CDP (Chrome DevTools Protocol) helpers for E2E tests.
 *
 * Provides a lightweight CDP client that connects to Beeper Desktop
 * (or any Electron app) via WebSocket and exposes helpers for
 * evaluating JS, detecting typing indicators, etc.
 */
import WebSocket from 'ws';

const CDP_PORT = 9334;

// CSS selectors for Beeper typing indicator elements
export const TYPING_SELECTORS = {
  chatView: '.typing-indicator',
  sidebar: '.TypingIndicator-module__wrapper',
  brandBubble: '.BrandTypingIndicator-module__container',
};

export interface CDPClient {
  ws: WebSocket;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  close: () => void;
}

export async function connectCDP(): Promise<CDPClient> {
  const response = await fetch(`http://localhost:${CDP_PORT}/json`);
  const targets = (await response.json()) as Array<{
    webSocketDebuggerUrl: string;
    type: string;
  }>;
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target found on Beeper CDP');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  let msgId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  ws.on('message', (raw: Buffer) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  function send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP call ${method} timed out`));
        }
      }, 10_000);
    });
  }

  return { ws, send, close: () => ws.close() };
}

export async function evaluate(
  cdp: CDPClient,
  expression: string,
): Promise<unknown> {
  const result = (await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  return result?.result?.value;
}

export async function hasTypingIndicator(cdp: CDPClient): Promise<boolean> {
  const result = await evaluate(
    cdp,
    `!!document.querySelector('${TYPING_SELECTORS.chatView}') || !!document.querySelector('${TYPING_SELECTORS.sidebar}')`,
  );
  return result === true;
}

export async function getTypingDetails(
  cdp: CDPClient,
): Promise<{ chatView: boolean; sidebar: boolean; brandBubble: boolean }> {
  const result = await evaluate(
    cdp,
    `JSON.stringify({
      chatView: !!document.querySelector('${TYPING_SELECTORS.chatView}'),
      sidebar: !!document.querySelector('${TYPING_SELECTORS.sidebar}'),
      brandBubble: !!document.querySelector('${TYPING_SELECTORS.brandBubble}'),
    })`,
  );
  return JSON.parse(result as string);
}
