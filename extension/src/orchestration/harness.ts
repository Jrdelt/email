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
  /** The sender-domain lookup state shown with the verdict ('loading', 'offline', 'unavailable' or a DomainIntel). */
  intel?: unknown;
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
 * `@vitest-environment-options` docblock; the UI language (<html lang>) is English unless the test set one before.
 * `beforeMain` runs after the page HTML is in place and before main().
 * The background is simulated: every runtime message is recorded; domain lookups answer `intel` (default
 * undefined, i.e. "lookup unavailable"; null is the background's Strict Local Mode answer). A function `intel` is
 * called with the looked-up domain and may return a promise, so a test can answer each lookup when it chooses.
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
    if (msg?.type !== 'domainIntel') return undefined;
    return typeof opts.intel === 'function' ? (opts.intel as (domain: unknown) => unknown)(msg.domain) : opts.intel;
  });
  (fakeBrowser.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;
  // Webmail UIs set <html lang> to their UI language; English unless the test chose another one.
  if (!document.documentElement.hasAttribute('lang')) document.documentElement.setAttribute('lang', 'en');
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
  await tick();
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

/** Any other mouse-type event (mousedown, auxclick, dragstart, ...); true when the extension cancelled it. */
export const fire = (el: Element, type: string, init: MouseEventInit = {}): boolean =>
  dispatch(el, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));

/** A keydown (Enter / Space activate links and buttons); true when the extension cancelled it. */
export const press = (el: Element, key = 'Enter'): boolean =>
  dispatch(el, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

/** Form submission event (from `submitter`, a submit button, if given); true when the extension cancelled it. */
export const submit = (form: Element, submitter: HTMLElement | null = null): boolean =>
  dispatch(form, new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }));

/** Deliver a runtime message to the content script as the background (or its iCloud relay) would. */
export const deliver = (msg: unknown): Promise<unknown> => {
  const onMessage = fakeBrowser.runtime.onMessage as unknown as { trigger: (m: unknown, s: unknown) => Promise<unknown> };
  return onMessage.trigger(msg, { id: fakeBrowser.runtime.id });
};

/** Domain lookups (type 'domainIntel') among `sent`, from index `from` on. */
export const lookups = (sent: readonly Msg[], from = 0): unknown[] =>
  sent.slice(from).filter((m) => m.type === 'domainIntel').map((m) => m.domain);

/** Navigations the content script asked the background for (openSafeLink / openWarning), from index `from` on. */
export const navigations = (sent: readonly Msg[], from = 0): Msg[] =>
  sent.slice(from).filter((m) => m.type === 'openSafeLink' || m.type === 'openWarning');

/** Let pending microtasks, MutationObserver callbacks and zero-delay timers run (far shorter than a scan debounce). */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * For beforeAll: wait as `wait` does, but never fail the hook. A failed hook skips every test of the file and
 * reports only the wait's own message; the tests assert what they need, so a broken run names what broke.
 */
export async function quietly(wait: Promise<unknown>): Promise<void> {
  await wait.catch(() => undefined);
}

/**
 * The warning banner (src/ui/banner.ts) lives in a closed shadow root that page scripts cannot reach. Call this
 * before bootContent: it records every shadow root the page creates, so a test can press the banner's own buttons
 * the way a user does (as src/ui/ui.test.ts does for the banner alone).
 */
export function captureBanner(): {
  /** The banner's shadow root, or null when no banner is shown. */
  root: () => ShadowRoot | null;
  /** The shown banner's button with exactly this text or aria-label (throws when there is none). */
  button: (label: string) => HTMLButtonElement;
  /** All of the banner's text (empty when no banner is shown). */
  text: () => string;
} {
  const roots = new WeakMap<Element, ShadowRoot>();
  const attach = HTMLElement.prototype.attachShadow;
  vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) {
    const shadow = attach.call(this, init);
    roots.set(this, shadow);
    return shadow;
  });
  const root = () => {
    const host = document.getElementById('ped-banner-host');
    return host ? (roots.get(host) ?? null) : null;
  };
  return {
    root,
    button: (label) => {
      const shown = root();
      if (!shown) throw new Error(`no banner is shown (looking for its "${label}" button)`);
      const buttons = [...shown.querySelectorAll('button')];
      const found = buttons.find((b) => b.textContent === label || b.getAttribute('aria-label') === label);
      if (!found) {
        const labels = buttons.map((b) => b.textContent || b.getAttribute('aria-label'));
        throw new Error(`the banner has no "${label}" button (it has: ${labels.join(', ')})`);
      }
      return found;
    },
    text: () =>
      [...(root()?.children ?? [])]
        .filter((el) => el.localName !== 'style')
        .map((el) => el.textContent)
        .join(''),
  };
}

export const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
};
