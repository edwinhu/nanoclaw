export class TypingManager {
  private intervals = new Map<string, NodeJS.Timeout>();
  private resetTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private sendTyping: (jid: string) => Promise<void>,
    private intervalMs: number = 4000,
    private stopTyping?: (jid: string) => Promise<void>,
    private resetMs: number = 8000,
    private resetGapMs: number = 500,
  ) {}

  start(jid: string): void {
    this.stop(jid);
    this.sendTyping(jid).catch(() => {});
    this.intervals.set(
      jid,
      setInterval(() => {
        this.sendTyping(jid).catch(() => {});
      }, this.intervalMs),
    );
    // Cycle off→on every resetMs to reset client-side typing timers
    if (this.stopTyping) {
      this.scheduleReset(jid);
    }
  }

  private scheduleReset(jid: string): void {
    this.resetTimers.set(
      jid,
      setTimeout(() => {
        if (!this.intervals.has(jid)) return;
        // Briefly stop typing, then restart after a short gap
        this.stopTyping!(jid).catch(() => {});
        setTimeout(() => {
          if (!this.intervals.has(jid)) return;
          this.sendTyping(jid).catch(() => {});
          this.scheduleReset(jid);
        }, this.resetGapMs);
      }, this.resetMs),
    );
  }

  stop(jid: string): void {
    const interval = this.intervals.get(jid);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(jid);
    }
    const resetTimer = this.resetTimers.get(jid);
    if (resetTimer) {
      clearTimeout(resetTimer);
      this.resetTimers.delete(jid);
    }
  }

  isActive(jid: string): boolean {
    return this.intervals.has(jid);
  }

  stopAll(): void {
    for (const [jid] of this.intervals) {
      this.stop(jid);
    }
  }
}
