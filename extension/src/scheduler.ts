// Debounced, single-flight scan scheduler used by the content script.

/** Quiet period before a scan runs after the last DOM change. */
export const DEBOUNCE_MS = 400;
/**
 * Longest a scan may be postponed by continuous changes. A pure trailing debounce never fires while the page keeps
 * mutating or resizing (e.g. an animated SVG in an iCloud message frame), which would leave the email unscanned.
 */
export const MAX_DEBOUNCE_WAIT_MS = 1200;

export interface Scheduler {
  /** Request a scan (debounced, with a maximum wait). */
  schedule: () => void;
  /** Run any pending scan now and resolve when scanning is idle. */
  flush: () => Promise<void>;
  /** True while a scan is requested or running (the race-to-click gate). */
  isPending: () => boolean;
}

export function createScheduler(
  runScan: () => Promise<void>,
  opts: { now?: () => number; idle?: (run: () => void) => void } = {},
): Scheduler {
  const now = opts.now ?? (() => Date.now());
  const idle =
    opts.idle ??
    ((run: () => void) => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 250 });
      else run();
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstRequestAt = 0;
  let pending = false;
  let inflight: Promise<void> | null = null;

  const exec = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    if (inflight) return inflight;
    inflight = (async () => {
      do {
        pending = false;
        clearTimeout(timer);
        timer = undefined;
        try {
          await runScan();
        } catch {
          // Keep the scheduler loop alive on unexpected DOM states.
        }
      } while (pending);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const schedule = () => {
    pending = true;
    const t = now();
    if (timer !== undefined) {
      if (t - firstRequestAt >= MAX_DEBOUNCE_WAIT_MS) return; // let the armed timer fire despite ongoing changes
      clearTimeout(timer);
    } else {
      firstRequestAt = t;
    }
    timer = setTimeout(() => idle(() => void exec()), DEBOUNCE_MS);
  };

  return { schedule, flush: exec, isPending: () => pending || inflight !== null };
}
