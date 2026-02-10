import { vi } from 'vitest';

// Polyfill vi.restoreAllTimers (alias for vi.useRealTimers)
if (typeof vi.restoreAllTimers !== 'function') {
  vi.restoreAllTimers = vi.useRealTimers;
}
