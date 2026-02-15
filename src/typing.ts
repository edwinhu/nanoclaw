export class TypingManager {
  private intervals = new Map<string, NodeJS.Timeout>();
  private resetTimers = new Map<string, NodeJS.Timeout>();
  private gapTimers = new Map<string, NodeJS.Timeout>();

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
        this.gapTimers.set(
          jid,
          setTimeout(() => {
            this.gapTimers.delete(jid);
            if (!this.intervals.has(jid)) return;
            this.sendTyping(jid).catch(() => {});
            this.scheduleReset(jid);
          }, this.resetGapMs),
        );
      }, this.resetMs),
    );
  }

  stop(jid: string): void {
    const wasActive = this.intervals.has(jid);
    this.clearTimer(this.intervals, jid, clearInterval);
    this.clearTimer(this.resetTimers, jid, clearTimeout);
    this.clearTimer(this.gapTimers, jid, clearTimeout);
    // Send the protocol-level "stop typing" signal
    if (wasActive && this.stopTyping) {
      this.stopTyping(jid).catch(() => {});
    }
  }

  private clearTimer(
    map: Map<string, NodeJS.Timeout>,
    jid: string,
    clear: (id: NodeJS.Timeout) => void,
  ): void {
    const timer = map.get(jid);
    if (timer) {
      clear(timer);
      map.delete(jid);
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
