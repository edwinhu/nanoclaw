export class TypingManager {
  private intervals = new Map<string, NodeJS.Timeout>();

  constructor(
    private sendTyping: (jid: string) => Promise<void>,
    private intervalMs: number = 4000,
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
  }

  stop(jid: string): void {
    const interval = this.intervals.get(jid);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(jid);
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
