import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Bot } from 'grammy';
import { TypingManager } from '../src/typing.js';

/**
 * HTTP-level integration tests for Telegram typing indicators.
 *
 * These tests verify that TypingManager + Grammy's sendChatAction
 * produce correct API calls with correct parameters and timing.
 * We intercept at Grammy's API transformer boundary, which is the
 * last point before the HTTP POST to api.telegram.org.
 */

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

describe('Typing indicator API calls', () => {
  let bot: Bot;
  let manager: TypingManager;
  let apiCalls: ApiCall[];
  const CHAT_ID = '8571704407';
  const FAKE_TOKEN = '0000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  beforeEach(() => {
    vi.useFakeTimers();
    apiCalls = [];

    bot = new Bot(FAKE_TOKEN);
    // Install Grammy API transformer to intercept all outgoing API calls
    bot.api.config.use((prev, method, payload) => {
      apiCalls.push({ method, payload: { ...payload } as Record<string, unknown>, timestamp: Date.now() });
      return { ok: true as const, result: true as unknown };
    });

    manager = new TypingManager(
      async (jid) => {
        const numericId = jid.replace(/^tg:/, '');
        await bot.api.sendChatAction(numericId, 'typing');
      },
      4000,
    );
  });

  afterEach(() => {
    manager.stopAll();
    vi.useRealTimers();
  });

  it('calls sendChatAction with correct chat_id and action', async () => {
    manager.start(`tg:${CHAT_ID}`);
    await vi.advanceTimersByTimeAsync(100);

    expect(apiCalls.length).toBeGreaterThanOrEqual(1);
    const call = apiCalls[0];
    expect(call.method).toBe('sendChatAction');
    expect(call.payload.chat_id).toBe(CHAT_ID);
    expect(call.payload.action).toBe('typing');
  });

  it('sends typing at ~4s intervals', async () => {
    manager.start(`tg:${CHAT_ID}`);
    await vi.advanceTimersByTimeAsync(100); // immediate call
    expect(apiCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4000); // first interval
    expect(apiCalls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(4000); // second interval
    expect(apiCalls).toHaveLength(3);

    // Verify all calls are sendChatAction with typing
    for (const call of apiCalls) {
      expect(call.method).toBe('sendChatAction');
      expect(call.payload.action).toBe('typing');
    }
  });

  it('stops making API calls after stop()', async () => {
    manager.start(`tg:${CHAT_ID}`);
    await vi.advanceTimersByTimeAsync(100);
    expect(apiCalls).toHaveLength(1);

    manager.stop(`tg:${CHAT_ID}`);
    await vi.advanceTimersByTimeAsync(12000); // 3 would-be intervals
    expect(apiCalls).toHaveLength(1); // no new calls
  });

  it('restarts API calls after stop+start (output cycle)', async () => {
    manager.start(`tg:${CHAT_ID}`);
    await vi.advanceTimersByTimeAsync(100);
    expect(apiCalls).toHaveLength(1);

    // Simulate agent output: stop typing, send message, restart typing
    manager.stop(`tg:${CHAT_ID}`);
    manager.start(`tg:${CHAT_ID}`);
    await vi.advanceTimersByTimeAsync(100);
    expect(apiCalls).toHaveLength(2); // restart fires immediately

    // Verify interval continues after restart
    await vi.advanceTimersByTimeAsync(4000);
    expect(apiCalls).toHaveLength(3);
  });

  it('handles full lifecycle: start → intervals → stop on output → restart on new message → final stop', async () => {
    // Phase 1: Agent starts processing (message received)
    manager.start(`tg:${CHAT_ID}`);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(apiCalls).toHaveLength(3); // immediate + 2 intervals

    // Phase 2: Agent sends output — typing stops, does NOT restart
    manager.stop(`tg:${CHAT_ID}`);
    await vi.advanceTimersByTimeAsync(8000);
    expect(apiCalls).toHaveLength(3); // no new calls while idle

    // Phase 3: New user message piped to container — typing restarts
    manager.start(`tg:${CHAT_ID}`);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(4000);
    expect(apiCalls).toHaveLength(5); // +immediate +1 interval

    // Phase 4: Agent responds again — typing stops permanently
    manager.stop(`tg:${CHAT_ID}`);
    await vi.advanceTimersByTimeAsync(8000);
    expect(apiCalls).toHaveLength(5); // no new calls

    // All calls were sendChatAction with correct params
    for (const call of apiCalls) {
      expect(call.method).toBe('sendChatAction');
      expect(call.payload.chat_id).toBe(CHAT_ID);
      expect(call.payload.action).toBe('typing');
    }
  });
});
