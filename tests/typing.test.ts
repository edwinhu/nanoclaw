import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TypingManager } from '../src/typing.js';

describe('TypingManager', () => {
  let sendTyping: ReturnType<typeof vi.fn>;
  let manager: TypingManager;

  beforeEach(() => {
    vi.useFakeTimers();
    sendTyping = vi.fn().mockResolvedValue(undefined);
    manager = new TypingManager(sendTyping, 4000);
  });

  afterEach(() => {
    manager.stopAll();
    vi.restoreAllTimers();
  });

  it('calls sendTyping immediately on start', async () => {
    manager.start('tg:123');
    // Allow microtask (the async sendTyping call) to resolve
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTyping).toHaveBeenCalledWith('tg:123');
    expect(sendTyping).toHaveBeenCalledTimes(1);
  });

  it('calls sendTyping repeatedly at interval', async () => {
    manager.start('tg:123');
    await vi.advanceTimersByTimeAsync(0); // initial call
    await vi.advanceTimersByTimeAsync(4000); // first interval
    await vi.advanceTimersByTimeAsync(4000); // second interval
    expect(sendTyping).toHaveBeenCalledTimes(3); // 1 immediate + 2 intervals
  });

  it('stop clears the interval', async () => {
    manager.start('tg:123');
    await vi.advanceTimersByTimeAsync(0);
    manager.stop('tg:123');
    await vi.advanceTimersByTimeAsync(8000);
    expect(sendTyping).toHaveBeenCalledTimes(1); // only the initial call
  });

  it('start is idempotent - restarts if already active', async () => {
    manager.start('tg:123');
    await vi.advanceTimersByTimeAsync(0);
    manager.start('tg:123'); // restart
    await vi.advanceTimersByTimeAsync(0);
    // Should have 2 immediate calls (one from each start), no double intervals
    expect(sendTyping).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sendTyping).toHaveBeenCalledTimes(3); // only 1 interval fires, not 2
  });

  it('handles multiple chats independently', async () => {
    manager.start('tg:123');
    manager.start('tg:456');
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTyping).toHaveBeenCalledTimes(2);
    manager.stop('tg:123');
    await vi.advanceTimersByTimeAsync(4000);
    // tg:123 stopped, tg:456 still going: 2 initial + 1 interval for 456
    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(sendTyping).toHaveBeenLastCalledWith('tg:456');
  });

  it('isActive returns correct state', () => {
    expect(manager.isActive('tg:123')).toBe(false);
    manager.start('tg:123');
    expect(manager.isActive('tg:123')).toBe(true);
    manager.stop('tg:123');
    expect(manager.isActive('tg:123')).toBe(false);
  });

  it('stopAll clears all intervals', async () => {
    manager.start('tg:123');
    manager.start('tg:456');
    await vi.advanceTimersByTimeAsync(0);
    manager.stopAll();
    await vi.advanceTimersByTimeAsync(8000);
    expect(sendTyping).toHaveBeenCalledTimes(2); // only initial calls
  });

  it('handles sendTyping errors gracefully', async () => {
    sendTyping.mockRejectedValue(new Error('network error'));
    manager.start('tg:123');
    // Should not throw
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000);
    // Interval should still be active despite errors
    expect(manager.isActive('tg:123')).toBe(true);
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });

  it('stop on non-active chat is a no-op', () => {
    // Should not throw
    manager.stop('tg:nonexistent');
    expect(manager.isActive('tg:nonexistent')).toBe(false);
  });

  describe('stopTyping callback', () => {
    let stopTyping: ReturnType<typeof vi.fn>;
    let managerWithStop: TypingManager;

    beforeEach(() => {
      stopTyping = vi.fn().mockResolvedValue(undefined);
      managerWithStop = new TypingManager(sendTyping, 4000, stopTyping, 8000, 500);
    });

    afterEach(() => {
      managerWithStop.stopAll();
    });

    it('stop() calls the stopTyping callback to send protocol-level stop signal', async () => {
      managerWithStop.start('tg:123');
      await vi.advanceTimersByTimeAsync(0);
      expect(sendTyping).toHaveBeenCalledTimes(1);

      managerWithStop.stop('tg:123');
      await vi.advanceTimersByTimeAsync(0);

      // stopTyping MUST be called when stop() is invoked
      expect(stopTyping).toHaveBeenCalledWith('tg:123');
    });

    it('stop() does not call stopTyping for non-active chats', async () => {
      managerWithStop.stop('tg:nonexistent');
      await vi.advanceTimersByTimeAsync(0);
      expect(stopTyping).not.toHaveBeenCalled();
    });

    it('stopAll() calls stopTyping for every active chat', async () => {
      managerWithStop.start('tg:123');
      managerWithStop.start('tg:456');
      await vi.advanceTimersByTimeAsync(0);

      managerWithStop.stopAll();
      await vi.advanceTimersByTimeAsync(0);

      expect(stopTyping).toHaveBeenCalledWith('tg:123');
      expect(stopTyping).toHaveBeenCalledWith('tg:456');
    });

    it('stop() clears the orphaned gap timer from scheduleReset', async () => {
      managerWithStop.start('tg:123');
      // Advance into the reset cycle: resetMs (8000ms) fires, stopTyping called,
      // then a 500ms gap timer is scheduled
      await vi.advanceTimersByTimeAsync(8000);
      expect(stopTyping).toHaveBeenCalledTimes(1); // reset cycle called stopTyping

      // Now stop() while the 500ms gap timer is pending
      stopTyping.mockClear();
      sendTyping.mockClear();
      managerWithStop.stop('tg:123');
      await vi.advanceTimersByTimeAsync(0);
      expect(stopTyping).toHaveBeenCalledWith('tg:123'); // stop() calls stopTyping

      // The orphaned 500ms gap timer should NOT fire
      sendTyping.mockClear();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sendTyping).not.toHaveBeenCalled();
    });
  });
});
