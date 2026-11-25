// Test-only helpers that boot the real entrypoints (entrypoints/content.ts, entrypoints/background.ts) against
// WXT's in-memory fake browser. Nothing in the extension imports this file, so it is never bundled.
//
// main() of an entrypoint cannot be torn down (it adds document listeners and observers), so each content test
// file boots exactly one page; vitest runs every test file in its own isolated environment.
import { expect, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

export { fakeBrowser };

export interface Msg {
  type?: string;
  [key: string]: unknown;
}

export interface VerdictPayload {
  verdict: { level: string; score: number; reasons: string[]; unchecked?: boolean };
  sender: { address: string; registrable: string; warnings: string[] };
  attachments?: { count: number; level: string; names: string[] };
  trusted: boolean;
}

export const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox';

/** A Gmail conversation view with one open message (selectors from src/adapters/gmail.ts). */
export const gmailMessage = (o: { name: string; email: string; body: string; subject?: string }): string =>
  `<h2 class="hP">${o.subject ?? 'Message'}</h2>
  <div class="adn"><span class="gD" email="${o.email}" name="${o.name}">${o.name}</span>
    <div class="a3s">${o.body}</div></div>`;

let contentBooted = false;

/**
 * Boot entrypoints/content.ts on the current happy-dom page. The page URL comes from the test file's
 * `@vitest-environment-options` docblock. `beforeMain` runs after the page HTML is in place and before main().
 * The background is simulated: every runtime message is recorded; domain lookups answer `intel` (default
 * undefined, i.e. "lookup unavailable"; null is the background's Strict Local Mode answer).
 */
export async function bootContent(
  html: string,
  opts: { beforeMain?: () => void | Promise<void>; intel?: unknown } = {},
): Promise<{ sent: Msg[] }> {
  if (contentBooted) throw new Error('bootContent: one page per test file (content main() cannot be torn down)');
  contentBooted = true;
  fakeBrowser.reset();
  vi.stubGlobal('browser', fakeBrowser);
  vi.stubGlobal('defineContentScript', (definition: unknown) => definition);
  const sent: Msg[] = [];
  const sendMessage = vi.fn(async (msg: Msg) => {
    sent.push(msg);
    return msg?.type === 'domainIntel' ? opts.intel : undefined;
  });
  (fakeBrowser.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;
  document.body.innerHTML = html;
  await opts.beforeMain?.();
  const { default: script } = await import('../../entrypoints/content');
  (script as unknown as { main: () => void }).main();
  return { sent };
}

export const verdictsOf = (sent: readonly Msg[]): (VerdictPayload | null)[] =>
  sent.filter((m) => m.type === 'verdict').map((m) => m.payload as VerdictPayload | null);

export const lastVerdict = (sent: readonly Msg[]): VerdictPayload | null | undefined => verdictsOf(sent).at(-1);

/** Poll until `check` stops throwing (no fixed sleeps). The first scan runs after a 400 ms debounce. */
export const until = <T>(check: () => T, timeout = 2500): Promise<T> => vi.waitFor(check, { timeout, interval: 20 });

/**
 * Wait until a scan that started after message index `from` finished and its sender-domain lookups were answered
 * and rendered: the scan's first domainIntel request at or after `from`, followed by a verdict (the re-render once
 * every sender lookup of the thread is back; click-time lookups come later and are not waited for). Afterwards the
 * race-to-click gate is idle again. Only for emails whose sender domain is looked up (untrusted, not strict).
 */
export async function settled(sent: readonly Msg[], from = 0): Promise<void> {
  await until(() => {
    const lookup = sent.findIndex((m, i) => i >= from && m.type === 'domainIntel');
    expect(lookup, 'sender domain lookup').toBeGreaterThanOrEqual(0);
    expect(sent.slice(lookup + 1).some((m) => m.type === 'verdict'), 'verdict after the lookup').toBe(true);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Dispatch a user-like event and report whether the extension cancelled it. A last bubbling listener on window
 * records the outcome and then cancels the event, so happy-dom never performs a real navigation or form
 * submission for an event the extension let through.
 */
function dispatch(el: Element, ev: Event): boolean {
  const win = el.ownerDocument.defaultView ?? window;
  let cancelledByExtension: boolean | null = null;
  const last = (e: Event) => {
    cancelledByExtension = e.defaultPrevented;
    e.preventDefault();
  };
  win.addEventListener(ev.type, last);
  try {
    el.dispatchEvent(ev);
  } finally {
    win.removeEventListener(ev.type, last);
  }
  // Not reached when an extension listener stopped propagation, which it only does when cancelling.
  return cancelledByExtension ?? ev.defaultPrevented;
}

/** Primary-button click; true when the extension cancelled it. */
export const click = (el: Element, init: MouseEventInit = {}): boolean =>
  dispatch(el, new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));

/** Keyboard activation (Enter / Space); true when the extension cancelled it. */
export const press = (el: Element, key: 'Enter' | ' ' = 'Enter'): boolean =>
  dispatch(el, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

/** Form submission event; true when the extension cancelled it. */
export const submit = (form: Element): boolean => dispatch(form, new Event('submit', { bubbles: true, cancelable: true }));

export const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
};
