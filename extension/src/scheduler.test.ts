import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEBOUNCE_MS, MAX_DEBOUNCE_WAIT_MS, createScheduler } from './scheduler';

describe('createScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const runScan = vi.fn(async () => {});
    const s = createScheduler(runScan, { now: () => Date.now(), idle: (run) => run() });
    return { runScan, s };
  };

  it('debounces bursts into one scan and reports pending until it finishes', async () => {
    const { runScan, s } = make();
    s.schedule();
    s.schedule();
    expect(s.isPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(runScan).toHaveBeenCalledTimes(1);
    expect(s.isPending()).toBe(false);
  });

  it('still scans while changes never stop (no starvation)', async () => {
    const { runScan, s } = make();
    for (let t = 0; t < MAX_DEBOUNCE_WAIT_MS + DEBOUNCE_MS + 100; t += 16) {
      s.schedule(); // e.g. an animation resizing the document every frame
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(runScan).toHaveBeenCalled();
  });

  it('runs no later than the maximum wait after the first request', async () => {
    const { runScan, s } = make();
    for (let t = 0; t < MAX_DEBOUNCE_WAIT_MS - 50; t += 16) {
      s.schedule();
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(runScan).not.toHaveBeenCalled(); // now ~50 ms before the maximum wait
    await vi.advanceTimersByTimeAsync(60);
    expect(runScan).toHaveBeenCalledTimes(1);
  });

  it('flush runs a pending scan immediately', async () => {
    const { runScan, s } = make();
    s.schedule();
    await s.flush();
    expect(runScan).toHaveBeenCalledTimes(1);
    expect(s.isPending()).toBe(false);
  });

  it('keeps working after a scan throws', async () => {
    const runScan = vi.fn(async () => {
      throw new Error('boom');
    });
    const s = createScheduler(runScan, { idle: (run) => run() });
    s.schedule();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    s.schedule();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    expect(runScan).toHaveBeenCalledTimes(2);
  });
});
