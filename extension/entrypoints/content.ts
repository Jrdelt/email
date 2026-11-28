import { adapterFor } from '../src/adapters';
import {
  type ICloudSandboxPayload,
  combineICloudThread,
  extractICloudHeaders,
  extractICloudSandbox,
} from '../src/adapters/icloud';
import type { AttachmentRef, ExtractedEmail, WebmailAdapter } from '../src/adapters/types';
import { hashEmail, listTrusted, listTrustedEmails, trustEmails, trustSender, untrustEmails } from '../src/allowlist';
import { type AttachmentAnalysis, analyzeAttachments } from '../src/attachments';
import {
  closestEl,
  eventElement,
  getAttr,
  hasAttr,
  isTextEntry,
  ownerDocOf,
  queryAll,
  rawLinkTarget,
  resolveAgainstBase,
  resolveAnchorHref,
  tagOf,
  textOf,
  useLinks,
} from '../src/dom';
import { isLookupDomain } from '../src/domain';
import type { DomainIntel } from '../src/domainIntel';
import { type Link, type Verdict, scoreEmail } from '../src/features';
import { recordFalsePositive } from '../src/feedback';
import { icloudFrameRole, WEBMAIL_MATCHES } from '../src/hosts';
import { analyzeLinkDestination, isSafeHttpUrl, type LinkRisk, mergeLinkIntel } from '../src/linkGuard';
import { analyzeSender, canTrustByAllowlist, type SenderInfo } from '../src/sender';
import { createScheduler } from '../src/scheduler';
import { getSettings } from '../src/settings';
import {
  isAttachmentLocked,
  lockAttachments,
  setAttachmentBlockedHandler,
  unlockAttachments,
} from '../src/ui/attachmentLock';
import { decideBanner, removeBanner, showBanner } from '../src/ui/banner';
import type { IntelState } from '../src/ui/details';
import { isLocked, lockLinks, setLinkBlockedHandler, unlockLinks } from '../src/ui/linkLock';
import { showListAttachmentToast, showPausedAttachmentToast, showPausedLinkToast } from '../src/ui/linkToast';
import { ellipsizeMiddle, showable } from '../src/text';

const MAX_THREAD_MESSAGES = 20; // newest messages that get full scoring and domain lookups
const MAX_SESSION_SET = 200;
const CLICK_INTEL_TIMEOUT_MS = 700;
// While the sender's own domain lookup is still running, a held click waits a little longer, for the sender's
// verdict as well as its destination's: a brand-new or non-existent sender domain is the classic phishing shape, and
// the warning it brings locks every link of the email.
const SENDER_INTEL_WAIT_MS = 2500;
// Longest a click in an iCloud message frame waits for the app frame's lock decision before going through.
const ICLOUD_VERDICT_WAIT_MS = 2500;

/** True while this content script still talks to a live extension (false after an update or reload orphans it). */
function extensionAlive(): boolean {
  try {
    return typeof browser?.runtime?.id === 'string' && browser.runtime.id.length > 0;
  } catch {
    return false;
  }
}

/**
 * Signature that ties iCloud lock decisions to the body they were made for: the first 128 bits of SHA-256 (32 hex
 * characters). It must resist collisions: email content could be padded to give a phishing body the signature of an
 * earlier benign one (trivial with a 32-bit FNV-1a), whose unlock would then apply to it. undefined if unavailable.
 */
async function bodySignature(s: string): Promise<string | undefined> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(digest, 0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

const PAIR_NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** runtime.sendMessage that never throws: an orphaned content script's APIs throw synchronously. */
function sendRuntime<T = unknown>(message: unknown): Promise<T | undefined> {
  try {
    return (browser.runtime.sendMessage(message) as Promise<T>).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

// The background drops a tab's stored verdict whenever the tab starts loading, which also happens on
// same-document navigations (hash/pushState). Remember the last verdict to re-send it when only the URL changed.
let lastVerdict: { payload: unknown; href: string } | null = null;
const tabHref = (): string => {
  try {
    return window.top?.location.href ?? location.href;
  } catch {
    return location.href;
  }
};
function sendVerdict(payload: unknown): void {
  lastVerdict = { payload, href: tabHref() };
  void sendRuntime({ type: 'verdict', payload });
}
function resendVerdictIfNavigated(): void {
  if (lastVerdict && lastVerdict.href !== tabHref()) sendVerdict(lastVerdict.payload);
}

function managedStorage(): typeof browser.storage.managed | undefined {
  try {
    return browser.storage?.managed;
  } catch {
    return undefined;
  }
}

interface ScannableMsg {
  senderName: string;
  senderAddress: string;
  viaDomain?: string;
  unauthenticated?: boolean;
  body: string;
  links: Link[];
  linksTruncated?: boolean;
  /** iCloud: body not tied to its card for certain, so the card's sender is not trusted for it. */
  pairingUncertain?: boolean;
  attachments?: AttachmentRef[];
  attachmentContainers?: HTMLElement[];
  attachmentNames?: string[];
}

const SAFE_VERDICT: Verdict = { score: 0, level: 'safe', reasons: [] };
const TRUSTED_SENDER_NOTE = "You trust this sender, but this webmail can't show the extension that the email really came from them.";

/**
 * Verdict for open messages beyond MAX_THREAD_MESSAGES. They are not scored, so fail closed:
 * treat them as suspicious, which pauses links and attachments until the user trusts the thread.
 */
function overflowVerdict(overflowCount: number): Verdict {
  return {
    score: 0.3,
    level: 'suspicious',
    unchecked: true,
    reasons: [
      `This conversation has too many open messages to check; links and attachments in the oldest ${overflowCount} are paused`,
    ],
  };
}

/** Not every link could be checked (padding past MAX_LINKS): never let such an email score safe. */
function withTooManyLinks(v: Verdict): Verdict {
  const reason = 'This email has too many links to check them all, so its links are paused';
  // Keep a real finding as is; otherwise this is an "unchecked" notice, not a phishing verdict.
  if (v.level !== 'safe') return { ...v, reasons: [...v.reasons, reason] };
  return { score: 0.3, level: 'suspicious', unchecked: true, reasons: [...v.reasons, reason] };
}

const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * True when a storage change should trigger a rescan. Trust the user removed elsewhere (popup "Clear", another
 * tab's Undo) is also dropped from this tab's in-memory session trust, so a cleared email re-locks here too.
 * Trust added elsewhere (another tab with the same email or sender open) rescans too. Only the fingerprints this
 * tab's own "I trust this email" stored (`ownWrites`, consumed here) do not: that action already applied them, and
 * a rescan would tear down its Undo pill. ("Always trust sender" does rescan: its banner is gone anyway.)
 */
function storageChangeAffectsVerdicts(
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
  trustedThisSession: Set<string>,
  ownWrites: Set<string>,
): boolean {
  if (areaName === 'managed') return true;
  if (areaName !== 'local') return false;
  let affected = 'privacySettings' in changes;
  for (const key of ['trustedEmails', 'trustedSenders'] as const) {
    const change = changes[key];
    if (!change) continue;
    const next = new Set(stringsOf(change.newValue));
    const prev = new Set(stringsOf(change.oldValue));
    const removed = [...prev].some((v) => !next.has(v));
    const added = [...next].filter((v) => !prev.has(v));
    if (added.length > 0) {
      // Adding at the list cap also evicts the oldest entries: that is no revocation.
      const own = added.every((v) => ownWrites.has(v));
      for (const v of added) ownWrites.delete(v);
      if (!own) affected = true;
      continue;
    }
    if (!removed) continue;
    affected = true;
    if (key === 'trustedEmails') {
      for (const entry of [...trustedThisSession]) {
        if (!entry.split(',').every((h) => next.has(h))) {
          trustedThisSession.delete(entry);
          affected = true;
        }
      }
    }
  }
  return affected;
}

// Documents (top page plus same-origin message iframes) whose paused-click handler reopens the banner.
const blockedHandlerDocs = new Set<Document>();
let currentReopen: (() => void) | null = null;

/** Point every document that hosts a locked message at `handler` (or clear them all with null). */
function setBlockedHandlers(handler: (() => void) | null, docs: Iterable<Document> = []): void {
  for (const doc of blockedHandlerDocs) {
    setLinkBlockedHandler(doc, null);
    setAttachmentBlockedHandler(doc, null);
  }
  blockedHandlerDocs.clear();
  currentReopen = handler;
  if (!handler) return;
  for (const doc of new Set([document, ...docs])) {
    setLinkBlockedHandler(doc, handler);
    setAttachmentBlockedHandler(doc, handler);
    blockedHandlerDocs.add(doc);
  }
}

function addBounded(set: Set<string>, key: string): void {
  if (set.has(key)) return;
  if (set.size >= MAX_SESSION_SET) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(key);
}

// Every supported host has an adapter (adapters.test.ts checks this); webmail selectors live only in adapters/.
function extractAll(adapter: WebmailAdapter | undefined, doc: Document): ExtractedEmail[] {
  if (!adapter) return [];
  if (adapter.extractAll) return adapter.extractAll(doc);
  const one = adapter.extract(doc);
  return one ? [one] : [];
}

const attachmentNamesOf = (e: ScannableMsg): string[] =>
  e.attachmentNames ?? e.attachments?.map((a) => a.name) ?? [];

function attachmentElementsOf(e: ScannableMsg): HTMLElement[] {
  return [...new Set([...(e.attachmentContainers ?? []), ...(e.attachments?.map((a) => a.element) ?? [])])];
}

function attachmentNameMapOf(e: ScannableMsg): Map<HTMLElement, string> {
  const map = new Map<HTMLElement, string>();
  for (const a of e.attachments ?? []) {
    if (a.name) map.set(a.element, a.name);
  }
  return map;
}

function lockMessageAttachments(e: ScannableMsg): void {
  const els = attachmentElementsOf(e);
  if (els.length > 0) lockAttachments(els, attachmentNameMapOf(e));
}

function unlockMessageAttachments(e: ScannableMsg): void {
  const els = attachmentElementsOf(e);
  if (els.length > 0) unlockAttachments(els);
}

const arraysEqual = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// Everything that can change a verdict or a trust hash: a reused reading-pane element with the same text
// but different link targets must still trigger a rescan.
const msgKey = (e: ScannableMsg) => {
  const names = attachmentNamesOf(e);
  const links = e.links.map((l) => `${l.href}\t${l.text}`).join('\n');
  return `${e.senderName}\n${e.senderAddress}\n${e.viaDomain ?? ''}\n${e.unauthenticated ? '1' : '0'}\n${e.body}\nlinks${e.linksTruncated ? '+' : ''}:${links}\natt:${names.join('|')}:${names.length}:${e.attachments?.length ?? 0}:${e.attachmentContainers?.length ?? 0}`;
};


function matchAttachmentInMessages(
  messages: readonly { attachments?: AttachmentRef[]; attachmentContainers?: HTMLElement[] }[],
  el: Element,
): { element: HTMLElement; name: string } | null {
  for (const m of messages) {
    for (const att of m.attachments ?? []) {
      if (att.element === el || att.element.contains(el)) return { element: att.element, name: att.name };
    }
    for (const box of m.attachmentContainers ?? []) {
      if (box === el || box.contains(el)) return { element: box, name: '' };
    }
  }
  return null;
}

/**
 * The link a click activates: the closest <a>/<area>, or the link an SVG <use> instance renders (the click is
 * retargeted to the <use>). `at` is where the click landed, for finding its message. 'ambiguous' when a <use>
 * renders several different links and the clicked one cannot be told apart; `uncheckable` when it renders more
 * than useLinks follows, so the clicked link may not be among `ambiguous` at all.
 */
function clickedLink(
  el: Element,
): { anchor: Element; at: Element } | { ambiguous: string[]; uncheckable?: boolean } | null {
  const a = closestEl(el, 'a, area');
  if (a) return { anchor: a, at: a };
  const use = closestEl(el, 'use');
  if (!use) return null;
  const { links, truncated } = useLinks(use);
  const hrefs = links.map((l) => resolveAnchorHref(l));
  const targets = [...new Set(hrefs.filter(Boolean))];
  if (truncated) return { ambiguous: targets, uncheckable: true };
  if (targets.length > 1) return { ambiguous: targets };
  // Check the link that navigates, never a target-less one rendered beside it.
  const index = hrefs.findIndex(Boolean);
  return index < 0 ? null : { anchor: links[index]!, at: use };
}

/** Navigate as the click itself would have (used once a held click is cleared by a local-only check). */
function replayNavigation(anchor: Element, href: string, activeTab: boolean): void {
  const win = ownerDocOf(anchor).defaultView ?? window;
  const target = (getAttr(anchor, 'target') ?? '').trim().toLowerCase();
  if (!activeTab || (target && target !== '_self')) win.open(href, '_blank', 'noopener,noreferrer');
  else win.location.assign(href);
}

/**
 * Where submitting `form` from `submitter` (a submit button, or null) navigates: the submitter's formaction, else
 * the form's action, else the page itself, resolved as the browser does. Read through the prototype-bound attribute
 * helpers: `<input name="action">` shadows `form.action`. null for method "dialog", which navigates nowhere. A GET
 * submission replaces the query with the form's fields; its site and path are those of the action.
 */
function submissionTarget(form: Element, submitter: Element | null): string | null {
  const attr = (own: string, formAttr: string): string =>
    (submitter && hasAttr(submitter, own) ? getAttr(submitter, own) : getAttr(form, formAttr)) ?? '';
  if (attr('formmethod', 'method').trim().toLowerCase() === 'dialog') return null;
  const doc = ownerDocOf(form);
  const raw = attr('formaction', 'action');
  return raw.trim() ? resolveAgainstBase(raw, doc.baseURI || doc.URL) : doc.URL;
}

interface GuardTarget {
  container: HTMLElement;
  senderAddress: string;
  senderRegistrable: string;
  senderIntelPending?: boolean;
  /** Settles once the pending sender lookup's verdict (and any lock it brings) has been rendered. */
  senderSettled?: Promise<unknown>;
}

/** A navigation (link click or form submission) the click guard has cancelled and decides at click time. */
interface HeldNavigation {
  /** Absolute http(s) destination. */
  href: string;
  /** The message it started in, as found when it was held. */
  hit: GuardTarget;
  /** Where in that message it started (looked up again to see whether the message is locked now). */
  at: Element;
  /**
   * The link or form whose destination it is (for a form outside the email, the email's submit button); looked up
   * again for the sender's latest state.
   */
  source: Element;
  /** The element the paused notice points at. */
  trigger: Element;
  /** Destination host named in the paused notice. */
  host: string;
}

function installClickGuard(opts: {
  findTarget: (el: Element) => GuardTarget | null;
  findAttachment?: (el: Element) => { element: HTMLElement; name: string } | null;
  isPending: () => boolean;
  flushScan: () => Promise<void>;
}) {
  const lockedNow = (h: HeldNavigation): boolean => {
    if (isLocked(h.hit.container)) return true;
    const refreshed = opts.findTarget(h.at);
    return Boolean(refreshed && isLocked(refreshed.container));
  };
  const pausedNotice = (h: HeldNavigation): void =>
    showPausedLinkToast(ownerDocOf(h.trigger), h.host, h.trigger instanceof HTMLElement ? h.trigger : null);
  // A navigation held for a scan or lookup that then locks the message gets the same notice as a click on a locked
  // link. Checked after every wait of a held navigation and right before it goes ahead.
  const pausedByLock = (h: HeldNavigation): boolean => {
    if (!lockedNow(h)) return false;
    pausedNotice(h);
    return true;
  };
  // Settles once the sender's pending lookup has been rendered or the message is locked. A rescan of the thread
  // replaces the pending lookup (the stale scan renders nothing), so follow it to the one that renders.
  const senderVerdict = async (h: HeldNavigation, first: Promise<unknown> | undefined): Promise<void> => {
    for (let settled = first; settled; ) {
      await settled.catch(() => undefined);
      if (lockedNow(h)) return;
      if (opts.isPending()) await opts.flushScan();
      const now = opts.findTarget(h.source);
      const next = now?.senderIntelPending ? now.senderSettled : undefined;
      settled = next === settled ? undefined : next;
    }
  };
  // The warning page gets the destination only: never a form's fields.
  const openWarning = (risk: LinkRisk, extra: { intel?: DomainIntel } = {}) =>
    void sendRuntime({
      type: 'openWarning',
      href: risk.href,
      host: risk.host,
      registrable: risk.registrable,
      level: risk.level,
      reasons: risk.reasons,
      ...extra,
    });

  /**
   * Decide a held navigation: wait for a pending scan, check the destination locally and then (outside Strict
   * Local Mode) its registrable domain online, re-checking the message's lock after every wait. True when it may go
   * ahead; otherwise it was paused (notice) or sent to the warning page.
   */
  const decideHeld = async (h: HeldNavigation): Promise<boolean> => {
    if (opts.isPending()) {
      await opts.flushScan();
      if (pausedByLock(h)) return false;
    }

    const latest = opts.findTarget(h.source) ?? h.hit;
    const risk = analyzeLinkDestination(h.href, latest.senderRegistrable, location.origin);
    if (risk.level !== 'safe') {
      openWarning(risk);
      return false;
    }

    if (risk.needsDomainCheck) {
      const settings = await getSettings(browser.storage.local, managedStorage());
      if (pausedByLock(h)) return false;
      if (!settings.strictLocalMode) {
        let timerId: ReturnType<typeof setTimeout> | undefined;
        const waitMs = latest.senderIntelPending ? SENDER_INTEL_WAIT_MS : CLICK_INTEL_TIMEOUT_MS;
        let intel: DomainIntel | undefined;
        const destination = sendRuntime<DomainIntel>({ type: 'domainIntel', domain: risk.registrable }).then((r) => {
          intel = r;
        });
        // While the sender's own lookup runs, wait (within the same bound) for its verdict too: a domain warning
        // it brings locks the email, which pauses this navigation as well. Stop waiting as soon as such a lock lands.
        const sender = latest.senderIntelPending ? senderVerdict(h, latest.senderSettled) : undefined;
        const timeout = new Promise<void>((resolve) => {
          timerId = setTimeout(resolve, waitMs);
        });
        await Promise.race(
          sender
            ? [
                Promise.all([destination, sender]),
                sender.then(() => (lockedNow(h) ? undefined : new Promise<never>(() => {}))),
                timeout,
              ]
            : [destination, timeout],
        ).finally(() => clearTimeout(timerId));
        if (pausedByLock(h)) return false;
        const finalRisk = mergeLinkIntel(risk, intel);
        if (finalRisk.level !== 'safe') {
          openWarning(finalRisk, { intel });
          return false;
        }
      }
    }

    return !pausedByLock(h);
  };

  // A form whose held submission is being replayed, with the destination it was cleared for. requestSubmit fires its
  // submit event synchronously, so the entry only lives for that call.
  const replaying = new WeakMap<Element, string>();
  const replaySubmit = (form: Element, submitter: HTMLElement | null, href: string): void => {
    replaying.set(form, href);
    try {
      // The prototype's method: a control named "requestSubmit" shadows the form's own.
      HTMLFormElement.prototype.requestSubmit.call(form as HTMLFormElement, submitter ?? undefined);
    } catch {
      // The submitter no longer submits this form: drop the submission rather than send it anywhere unchecked.
    } finally {
      replaying.delete(form);
    }
  };

  const onSubmit = (e: Event, el: Element) => {
    const form = closestEl(el, 'form');
    if (!form) return;
    const submitter = (e as SubmitEvent).submitter ?? null;
    const href = submissionTarget(form, submitter);
    if (href !== null && replaying.get(form) === href) return; // our own replay of a cleared submission
    // A submit button inside an email can submit a form outside it (form="id"): that is the email's submission too.
    const formHit = opts.findTarget(form);
    const at = formHit ? form : submitter;
    const hit = formHit ?? (submitter ? opts.findTarget(submitter) : null);
    if (!at || !hit || isLocked(hit.container)) return; // a locked message's forms are the lock's job

    const pending = opts.isPending();
    // As for links, only http(s) destinations are checked here (inline data:/blob: downloads are the attachment
    // lock's job). Others are held only while a scan is pending, then dropped: submit again once it is checked.
    if (href === null || !isSafeHttpUrl(href)) {
      if (!pending) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void opts.flushScan();
      return;
    }
    const initialRisk = analyzeLinkDestination(href, hit.senderRegistrable, location.origin);
    if (!pending && initialRisk.level === 'safe' && !initialRisk.needsDomainCheck) return;
    const held: HeldNavigation = { href, hit, at, source: at, trigger: submitter ?? form, host: initialRisk.host };
    if (!extensionAlive()) {
      // Orphaned (see the link case below): risky submissions stay paused; safe ones wait for a pending scan.
      if (initialRisk.level === 'safe' && !pending) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (initialRisk.level !== 'safe') {
        pausedNotice(held);
        return;
      }
      void (async () => {
        await opts.flushScan();
        if (!pausedByLock(held)) replaySubmit(form, submitter, href);
      })();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    void (async () => {
      if (await decideHeld(held)) replaySubmit(form, submitter, href);
    })();
  };

  const onEvent = (e: Event) => {
    const el = eventElement(e);
    if (!el) return;

    if (e.type === 'submit') {
      onSubmit(e, el);
      return;
    }

    if (e.type === 'keydown') {
      const key = (e as KeyboardEvent).key;
      if (key !== 'Enter' && key !== ' ') return;
      // Typed into a text field or a reply: activates no attachment control (only those act on keydown here).
      if (isTextEntry(el)) return;
    } else if (e.type === 'auxclick') {
      if ((e as MouseEvent).button !== 1) return;
    } else if (e.type === 'click') {
      if ((e as MouseEvent).button !== 0) return;
    }

    // Only while a scan is pending: findAttachment may then have to extract the page (once per DOM change).
    const attHit = opts.isPending() ? opts.findAttachment?.(el) : null;
    if (attHit && !isAttachmentLocked(attHit.element)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'mousedown' || e.type === 'pointerdown') return;
      void (async () => {
        await opts.flushScan();
        const post = opts.findAttachment?.(el) ?? attHit;
        if (isAttachmentLocked(post.element) || closestEl(post.element, '[data-ped-att-locked]')) {
          showPausedAttachmentToast(
            document,
            getAttr(post.element, 'data-ped-att-name') ?? post.name,
            el instanceof HTMLElement ? el : post.element,
          );
        }
      })();
      return;
    }

    if (e.type !== 'click' && e.type !== 'auxclick') return;

    const clicked = clickedLink(el);
    if (!clicked) return;
    if ('ambiguous' in clicked) {
      // Several links behind one <use>: which one was clicked is unknowable. Let it through only when every one of
      // them would pass unchecked anyway; otherwise pause rather than guess (a locked message is the lock's job).
      // A <use> with more links than were followed is always paused: the clicked one may never have been seen.
      const amb = opts.findTarget(el);
      if (!amb || isLocked(amb.container)) return;
      const allSafe = !clicked.uncheckable && clicked.ambiguous.every((href) => {
        if (!isSafeHttpUrl(href)) return true;
        const r = analyzeLinkDestination(href, amb.senderRegistrable, location.origin);
        return r.level === 'safe' && !r.needsDomainCheck;
      });
      if (allSafe && !opts.isPending()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      showPausedLinkToast(ownerDocOf(el), '', el instanceof HTMLElement ? el : null);
      return;
    }
    const { anchor: a, at } = clicked;
    // Same-page anchors (#section) do not leave the email. Uses the SMIL-animated value of an SVG <a>, so
    // <a href="#"> retargeted by <set attributeName="href" to="https://..."> is still checked.
    if (rawLinkTarget(a).startsWith('#')) return;

    const hit = opts.findTarget(at) ?? (at === a ? null : opts.findTarget(a));
    if (!hit || isLocked(hit.container)) return;

    // Includes the SMIL-animated target of an SVG <a>, which can navigate with no href attribute at all.
    const rawHref = resolveAnchorHref(a);
    if (!rawHref || !isSafeHttpUrl(rawHref)) return;

    const me = e as MouseEvent;
    const pending = opts.isPending();
    const activeTab = !(me.metaKey || me.ctrlKey || (e.type === 'auxclick' && me.button === 1));
    const initialRisk = analyzeLinkDestination(rawHref, hit.senderRegistrable, location.origin);
    if (!pending && initialRisk.level === 'safe' && !initialRisk.needsDomainCheck) return;
    const held: HeldNavigation = { href: rawHref, hit, at, source: a, trigger: a, host: initialRisk.host };
    if (!extensionAlive()) {
      // Orphaned by an extension update: the background can no longer check or open links for us. Risky links
      // stay paused until the tab is reloaded; safe ones still wait for a pending scan (which runs locally) and
      // then navigate natively.
      if (initialRisk.level === 'safe' && !pending) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (initialRisk.level !== 'safe') {
        pausedNotice(held);
        return;
      }
      void (async () => {
        await opts.flushScan();
        if (!pausedByLock(held)) replayNavigation(a, rawHref, activeTab);
      })();
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();

    void (async () => {
      if (!(await decideHeld(held))) return;
      let sameOrigin = false;
      try {
        sameOrigin = new URL(rawHref).origin === location.origin;
      } catch {
        sameOrigin = false;
      }
      if (sameOrigin && activeTab && (getAttr(a, 'target') ?? '').toLowerCase() !== '_blank' && window === window.top) {
        location.assign(rawHref);
        return;
      }
      void sendRuntime({ type: 'openSafeLink', href: rawHref, active: activeTab });
    })();
  };

  // Idempotent (re-adding is a no-op): document.open() erases a document's listeners but keeps the Document object,
  // so callers re-attach whenever a frame document may have been rewritten.
  const attachDoc = (doc: Document) => {
    for (const type of ['click', 'auxclick', 'mousedown', 'pointerdown', 'keydown', 'submit']) {
      doc.addEventListener(type, onEvent, true);
    }
  };

  attachDoc(document);
  return attachDoc;
}

async function evaluateAndRender<T extends ScannableMsg>(opts: {
  kv: typeof browser.storage.local;
  messages: T[];
  /**
   * Sender domains whose online lookup is still running (shared with the click guard), each with a promise that
   * settles once the verdict including its result has been rendered.
   */
  intelPending?: Map<string, Promise<void>>;
  /** Leading messages (oldest) that exceed MAX_THREAD_MESSAGES: locked unless trusted, never scored or looked up. */
  overflowCount?: number;
  trustedThisSession: Set<string>;
  /** Fingerprints this tab's "I trust this email" is storing, which storage.onChanged then need not rescan for. */
  ownWrites: Set<string>;
  dismissed: Set<string>;
  /** The webmail's sender-verification signals are visible to the adapter (only Gmail today). */
  authSignals: boolean;
  isStale: () => boolean;
  onEvaluated?: (items: { email: T; sender: ReturnType<typeof analyzeSender> }[]) => void;
  /** Per message: lock its links (`linksLocked`), and its attachments when untrusted and it has any. */
  applyLocks: (items: { email: T; trusted: boolean; hasAttachments: boolean; linksLocked: boolean }[]) => void;
  unlockAll: (emails: T[]) => void;
  unlockMatching: (emails: T[]) => void;
}) {
  const { kv, messages, trustedThisSession, dismissed, isStale, onEvaluated, applyLocks, unlockAll, unlockMatching } = opts;
  const overflowCount = Math.min(opts.overflowCount ?? 0, messages.length);
  // Overflow messages with nothing to click (no links, attachments or message frame) need no lock at all.
  const lockable = (email: T, attCount: number): boolean =>
    email.links.length > 0 ||
    attCount > 0 ||
    Boolean(email.linksTruncated) ||
    typeof (email as { frameId?: unknown }).frameId === 'number';
  let lockedOverflow = 0;
  const untrustedVerdict = (overflow: boolean, sender: SenderInfo, email: T): Verdict => {
    if (overflow) return overflowVerdict(lockedOverflow);
    const v = scoreEmail(sender.address, email.body, email.links);
    return email.linksTruncated ? withTooManyLinks(v) : v;
  };
  /**
   * What an email's trust means for scoring and locks. Where the adapter cannot see the webmail's sender
   * verification, a forged copy of an allowlisted address looks identical, so sender trust alone leaves the email
   * `attachmentsOnly`: no warning banner and links open, but its attachments stay locked behind an attachment
   * notice (risky attachment types also pause links, as for any unverified email). Trusting the email opens them.
   * Shared by the scan, Undo and "Always trust sender" so they can never disagree.
   */
  const trustState = (
    base: { email: T; attNames: string[]; attCount: number; rawSender: SenderInfo; overflow: boolean; skipped: boolean },
    emailTrusted: boolean,
    allowlistTrusted: boolean,
  ) => {
    const attachmentsOnly = allowlistTrusted && !opts.authSignals && !emailTrusted && base.attCount > 0;
    const trusted = emailTrusted || (allowlistTrusted && !attachmentsOnly);
    const verdict: Verdict =
      trusted || base.skipped || attachmentsOnly ? SAFE_VERDICT : untrustedVerdict(base.overflow, base.rawSender, base.email);
    const sender: SenderInfo = attachmentsOnly ? { ...base.rawSender, warnings: [], allowlisted: true } : base.rawSender;
    const analysis = trusted ? undefined : analyzeAttachments(base.attNames, base.attCount);
    // Appended, so a real attachment finding (a disguised or risky file) stays the first reason shown.
    const attAnalysis: AttachmentAnalysis | undefined =
      analysis && attachmentsOnly ? { ...analysis, reasons: [...analysis.reasons, TRUSTED_SENDER_NOTE] } : analysis;
    return { attachmentsOnly, trusted, verdict, sender, attAnalysis };
  };

  const [settings, trustedSendersList, trustedEmailsList, prelim] = await Promise.all([
    getSettings(kv, managedStorage()),
    // Storage reads fail after an extension update orphans this script: fail closed (no trust) and keep scanning.
    listTrusted(kv).catch((): string[] => []),
    listTrustedEmails(kv).catch((): string[] => []),
    Promise.all(
      messages.map(async (email) => {
        const attNames = attachmentNamesOf(email);
        const attCount = Math.max(attNames.length, email.attachments?.length ?? 0);
        const hash = await hashEmail(email.senderAddress, email.body, email.links, attNames, {
          unauthenticated: email.unauthenticated,
          viaDomain: email.viaDomain,
          attachmentCount: attCount,
        });
        return { email, attNames, attCount, hash };
      }),
    ),
  ]);
  const trustedSenders = new Set(trustedSendersList);
  const trustedEmails = new Set(trustedEmailsList);
  const threadHashKey = prelim.map((p) => p.hash).join(',');
  const threadUnlocked = trustedThisSession.has(threadHashKey);

  lockedOverflow = prelim.slice(0, overflowCount).filter((p) => lockable(p.email, p.attCount)).length;
  const items = prelim.map(({ email, attNames, attCount, hash }, index) => {
    const inOverflow = index < overflowCount;
    const overflow = inOverflow && lockable(email, attCount);
    const skipped = inOverflow && !overflow; // beyond the cap and nothing to lock: not scored
    const sender = analyzeSender(email.senderName, email.senderAddress, email.links, {
      viaDomain: email.viaDomain,
      unauthenticated: email.unauthenticated,
    });
    const allowlisted = sender.valid && trustedSenders.has(sender.address);
    const allowlistTrusted = allowlisted && canTrustByAllowlist(sender) && !email.pairingUncertain;
    // An uncertain iCloud pairing is not an authentication failure: the email is simply checked like any other.
    if (allowlisted && !canTrustByAllowlist(sender)) {
      sender.warnings.unshift(
        `Claims to be a trusted sender (${sender.address}), but failed authentication or used an unexpected relay`,
      );
    }
    const emailTrusted = threadUnlocked || trustedThisSession.has(hash) || trustedEmails.has(hash);
    const base = { email, attNames, attCount, hash, rawSender: sender, overflow, skipped };
    return { ...base, emailTrusted, allowlistTrusted, ...trustState(base, emailTrusted, allowlistTrusted) };
  });
  if (isStale()) return;
  onEvaluated?.(items);

  const intelByDomain = new Map<string, IntelState>();
  for (const item of items) {
    if (
      !item.trusted &&
      !item.attachmentsOnly &&
      !item.overflow &&
      !item.skipped &&
      isLookupDomain(item.sender.registrable) &&
      !intelByDomain.has(item.sender.registrable)
    ) {
      intelByDomain.set(item.sender.registrable, settings.strictLocalMode ? 'offline' : 'loading');
    }
  }

  let showingUndoPill = false;
  // What "I trust this email" changed, so that Undo restores exactly the earlier trust: messages of the thread that
  // were already trusted (stored fingerprint or this session) stay trusted.
  let undoState: { item: (typeof items)[number]; emailTrusted: boolean; inSession: boolean }[] | null = null;
  const containerDocs = messages.flatMap((m) => {
    const c = (m as { container?: HTMLElement }).container;
    return c ? [ownerDocOf(c)] : [];
  });

  const render = () => {
    const unlockedThread = trustedThisSession.has(threadHashKey);
    const evaluated = items.map((item) => {
      const intel = item.sender.registrable ? intelByDomain.get(item.sender.registrable) : undefined;
      const banner = item.trusted
        ? null
        : decideBanner(
            item.verdict,
            item.sender,
            intel,
            unlockedThread || trustedThisSession.has(item.hash),
            item.attAnalysis,
          );
      return { item, intel, banner };
    });

    let primaryEntry = evaluated[evaluated.length - 1];
    let bestRank = -1;
    for (const entry of evaluated) {
      if (!entry.banner) continue;
      const attBoost = entry.item.attachmentsOnly
        ? 0
        : entry.item.attAnalysis?.level === 'warning'
          ? 0.2
          : entry.item.attAnalysis?.count
            ? 0.1
            : 0;
      // Fail-closed "unchecked" items rank below every real finding so they never hide one, and a trusted sender's
      // attachment notice ranks below everything (it must never hide another message's warning).
      const evidence = entry.item.attachmentsOnly ? -1 : entry.item.verdict.unchecked ? -0.5 : entry.item.verdict.score;
      const rank = (entry.banner.level === 'danger' ? 10 : 0) + evidence + attBoost;
      if (rank >= bestRank) {
        bestRank = rank;
        primaryEntry = entry;
      }
    }

    const anyLinksLocked = evaluated.some((e) => e.banner?.linksLocked);
    const anyAttachmentsLocked = evaluated.some((e) => e.banner?.attachmentsLocked);
    applyLocks(
      evaluated.map(({ item, banner }) => ({
        email: item.email,
        trusted: item.trusted,
        hasAttachments: item.attCount > 0,
        // A trusted sender's message pauses links only for its own reason (a risky attachment), not the thread's.
        linksLocked: !item.trusted && (item.attachmentsOnly ? Boolean(banner?.linksLocked) : anyLinksLocked),
      })),
    );


    const primaryBanner = primaryEntry.banner;
    sendVerdict({
      verdict: primaryEntry.item.verdict,
      sender: primaryEntry.item.sender,
      intel: primaryEntry.intel,
      attachments: primaryEntry.item.trusted ? undefined : primaryEntry.item.attAnalysis,
      trusted: primaryEntry.item.trusted,
    });

    if (!primaryBanner) {
      setBlockedHandlers(null);
      if (!showingUndoPill) removeBanner();
      return;
    }

    const reopenBanner = () => {
      // A newer scan owns the page (its own render replaces this handler): never reapply this scan's state.
      if (isStale() || !dismissed.delete(threadHashKey)) return;
      render();
    };
    setBlockedHandlers(reopenBanner, containerDocs);

    if (dismissed.has(threadHashKey)) {
      removeBanner();
      return;
    }

    showBanner(
      {
        ...primaryBanner,
        linksLocked: anyLinksLocked,
        ...(anyAttachmentsLocked ? { attachmentsLocked: true } : {}),
      },
      {
        onUnlock: async () => {
          showingUndoPill = true;
          undoState = evaluated.map(({ item }) => ({
            item,
            emailTrusted: item.emailTrusted,
            inSession: trustedThisSession.has(item.hash),
          }));
          addBounded(trustedThisSession, threadHashKey);
          for (const { item } of evaluated) {
            addBounded(trustedThisSession, item.hash);
            item.emailTrusted = true;
            item.attachmentsOnly = false;
            item.trusted = true;
            item.verdict = SAFE_VERDICT;
            item.attAnalysis = undefined;
          }
          setBlockedHandlers(null);
          unlockAll(evaluated.map((e) => e.item.email));
          sendVerdict({
            verdict: SAFE_VERDICT,
            sender: primaryEntry.item.sender,
            intel: primaryEntry.intel,
            trusted: true,
          });
          // Only the newly trusted messages: Undo removes exactly these again. The trust above already applies for
          // this session; a failed write (e.g. storage of a script orphaned by an update) must not undo it or keep
          // the warning card up while the links are open.
          const added = undoState.filter((u) => !u.emailTrusted).map((u) => u.item.hash);
          for (const hash of added) addBounded(opts.ownWrites, hash);
          await trustEmails(kv, added).catch(() => undefined);
        },
        onUndoUnlock: async () => {
          showingUndoPill = false;
          trustedThisSession.delete(threadHashKey);
          const prior = undoState ?? evaluated.map(({ item }) => ({ item, emailTrusted: false, inSession: false }));
          undoState = null;
          for (const { item, emailTrusted, inSession } of prior) {
            if (!inSession) trustedThisSession.delete(item.hash);
            item.emailTrusted = emailTrusted;
            Object.assign(item, trustState(item, emailTrusted, item.allowlistTrusted));
          }
          // Re-lock first: the lock must never depend on the storage write, which can fail.
          if (!isStale()) render();
          await untrustEmails(kv, prior.filter((u) => !u.emailTrusted).map((u) => u.item.hash)).catch(() => undefined);
        },
        onTrustSender: async () => {
          if (!canTrustByAllowlist(primaryEntry.item.rawSender)) return false;
          const addr = primaryEntry.item.rawSender.address;
          const ok = await trustSender(kv, addr);
          // If a newer scan rendered meanwhile, this scan's render would reapply its old locks, verdict and banner
          // over it. The stored trust reaches the current scan through the storage change's rescan instead.
          if (ok && !isStale()) {
            const matched: T[] = [];
            for (const { item } of evaluated) {
              if (item.rawSender.address === addr && canTrustByAllowlist(item.rawSender) && !item.email.pairingUncertain) {
                item.allowlistTrusted = true;
                Object.assign(item, trustState(item, item.emailTrusted, true));
                if (item.trusted) matched.push(item.email);
              }
            }
            unlockMatching(matched);
            render();
          }
          return ok;
        },
        onReport: async () => {
          if (settings.disableLocalReports) return false;
          await recordFalsePositive(kv, { ...primaryEntry.item.verdict, reasons: primaryBanner.reasons });
          return true;
        },
        onDismiss: () => {
          showingUndoPill = false;
          addBounded(dismissed, threadHashKey);
        },
      },
    );
  };
  render();

  if (!settings.strictLocalMode && intelByDomain.size > 0) {
    const domains = [...intelByDomain.keys()];
    const pending = opts.intelPending;
    // A sender stays pending until the render with its result is done (the render waits for every sender of the
    // thread), so the click guard never treats a sender as checked before its warning, if any, has locked links.
    const rendered: Promise<void> = Promise.all(
      domains.map(async (domain) => {
        const res = await sendRuntime<DomainIntel | null>({ type: 'domainIntel', domain });
        intelByDomain.set(domain, res === null ? 'offline' : (res ?? 'unavailable'));
      }),
    )
      .then(() => {
        if (!isStale()) render();
      })
      .finally(() => {
        for (const domain of domains) if (pending?.get(domain) === rendered) pending.delete(domain);
      });
    for (const domain of domains) pending?.set(domain, rendered);
  }
}

function runStandardWebmail(kv: typeof browser.storage.local, adapter: WebmailAdapter | undefined) {
  const trustedThisSession = new Set<string>();
  const ownWrites = new Set<string>();
  const dismissed = new Set<string>();
  const containerSender = new WeakMap<HTMLElement, { address: string; registrable: string }>();
  const intelPending = new Map<string, Promise<void>>();
  let lastKey = '';
  let activeContainers: HTMLElement[] = [];
  let activeMessages: ExtractedEmail[] = [];
  let activeAttachmentEls: HTMLElement[] = [];
  let token = 0;

  let watchFrames = () => {};

  const scan = async () => {
    if (document.hidden) return; // never work in background tabs
    pendingExtraction = null;
    watchFrames();
    const emails = extractAll(adapter, document);
    if (emails.length === 0) {
      for (const c of activeContainers) unlockLinks(c);
      if (activeAttachmentEls.length) unlockAttachments(activeAttachmentEls);
      setBlockedHandlers(null);
      activeContainers = [];
      activeMessages = [];
      activeAttachmentEls = [];
      lastKey = '';
      ++token;
      removeBanner();
      sendVerdict(null);
      return;
    }

    const messages = emails;
    for (const m of messages) guardDoc(ownerDocOf(m.container));
    const threadKey = messages.map(msgKey).join('\n---\n');
    const nextContainers = messages.map((m) => m.container);
    const nextAttachmentEls = [...new Set(messages.flatMap(attachmentElementsOf))];

    if (
      threadKey === lastKey &&
      arraysEqual(nextContainers, activeContainers) &&
      arraysEqual(nextAttachmentEls, activeAttachmentEls)
    ) {
      resendVerdictIfNavigated();
      return; // unchanged thread and attachment DOM => no work
    }

    const newContainers = new Set(nextContainers);
    for (const c of activeContainers) {
      if (!newContainers.has(c)) unlockLinks(c);
    }
    const newAttSet = new Set(nextAttachmentEls);
    const staleAtts = activeAttachmentEls.filter((el) => !newAttSet.has(el));
    if (staleAtts.length) unlockAttachments(staleAtts);

    activeContainers = nextContainers;
    activeMessages = messages;
    activeAttachmentEls = nextAttachmentEls;
    lastKey = threadKey;
    const my = ++token;
    removeBanner();

    await evaluateAndRender({
      kv,
      messages,
      overflowCount: Math.max(0, messages.length - MAX_THREAD_MESSAGES),
      intelPending,
      trustedThisSession,
      ownWrites,
      authSignals: adapter?.authSignals === true,
      dismissed,
      isStale: () => my !== token,
      onEvaluated: (items) => {
        for (const { email, sender } of items) {
          containerSender.set(email.container, { address: sender.address, registrable: sender.registrable });
        }
      },
      applyLocks: (items) => {
        for (const { email, trusted, hasAttachments, linksLocked } of items) {
          if (linksLocked) lockLinks(email.container);
          else unlockLinks(email.container);
          if (!trusted && hasAttachments) lockMessageAttachments(email);
          else unlockMessageAttachments(email);
        }
      },
      unlockAll: (all) => {
        for (const m of all) {
          unlockLinks(m.container);
          unlockMessageAttachments(m);
        }
        if (activeAttachmentEls.length) unlockAttachments(activeAttachmentEls);
      },
      unlockMatching: (matched) => {
        for (const m of matched) {
          unlockLinks(m.container);
          unlockMessageAttachments(m);
        }
      },
    });
  };

  const scheduler = createScheduler(scan);
  // While a scan is pending, click-time lookups of elements the last scan did not see use a fresh extraction, made
  // at most once per DOM change (not once per press: a press dispatches pointerdown, mousedown and click).
  let pendingExtraction: ExtractedEmail[] | null = null;
  const freshEmails = () => (pendingExtraction ??= extractAll(adapter, document));
  const domChanged = () => {
    pendingExtraction = null;
    scheduler.schedule();
  };

  // Gmail's inbox list shows file buttons for emails that were never opened, so never scanned: refuse to open those
  // files there (for every sender: the list shows no sender verification) and point the user to the email itself.
  // Click-time only, so no idle cost.
  const listAttachmentAt = adapter?.listAttachmentAt?.bind(adapter);
  if (listAttachmentAt) {
    const TOAST_EVENTS = new Set(['click', 'keydown', 'contextmenu']);
    const onListEvent = (e: Event) => {
      if (e.type === 'keydown' || e.type === 'keyup') {
        const key = (e as KeyboardEvent).key;
        if (key !== 'Enter' && key !== ' ') return;
      }
      const el = eventElement(e);
      const chip = el ? listAttachmentAt(el) : null;
      if (!chip) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const middle = e.type === 'auxclick' && (e as MouseEvent).button === 1;
      if ((TOAST_EVENTS.has(e.type) || middle) && !(e as KeyboardEvent).repeat) {
        const name = getAttr(chip, 'aria-label') || getAttr(chip, 'title') || textOf(chip);
        showListAttachmentToast(document, showable(ellipsizeMiddle(name.trim(), 80)), chip);
      }
    };
    // Gmail's own controls decide which event opens a file, so every activation path is refused on a file button
    // (the context menu too: "Open link in new tab" / "Save link as" would open the unscanned file).
    for (const type of [
      'click', 'auxclick', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
      'dragstart', 'keydown', 'keyup',
    ]) {
      document.addEventListener(type, onListEvent, true);
    }
    // Touch: keep the page's touch handlers away from the button but do not cancel the tap (that would also block
    // scrolls that start on it); the tap's click then reaches the handler above and is refused with the notice.
    const onListTouch = (e: Event) => {
      const el = eventElement(e);
      if (el && listAttachmentAt(el)) e.stopImmediatePropagation();
    };
    for (const type of ['touchstart', 'touchend']) {
      document.addEventListener(type, onListTouch, { capture: true, passive: true });
    }
  }

  const guardDoc = installClickGuard({
    findTarget: (a) => {
      for (const c of activeContainers) {
        if (c.contains(a)) {
          const meta = containerSender.get(c);
          const registrable = meta?.registrable ?? '';
          // Until the sender's domain is checked, treat same-domain links as external so they get a click-time check.
          const senderIntelPending = intelPending.has(registrable);
          return {
            container: c,
            senderAddress: meta?.address ?? '',
            senderRegistrable: senderIntelPending ? '' : registrable,
            senderIntelPending,
            senderSettled: intelPending.get(registrable),
          };
        }
      }
      if (scheduler.isPending()) {
        const fresh = freshEmails().find((m) => m.container.contains(a));
        if (fresh) {
          const s = analyzeSender(fresh.senderName, fresh.senderAddress, []);
          return { container: fresh.container, senderAddress: s.address, senderRegistrable: s.registrable };
        }
      }
      return null;
    },
    findAttachment: (el) =>
      matchAttachmentInMessages(activeMessages, el) ??
      (scheduler.isPending() ? matchAttachmentInMessages(freshEmails(), el) : null),
    isPending: () => scheduler.isPending(),
    flushScan: () => scheduler.flush(),
  });

  // Message bodies rendered in same-origin iframes (Proton, Outlook/Yahoo fallbacks): guard their clicks from
  // the moment they appear and rescan when they change, since iframe mutations never reach the top observer.
  // The observer sits on the Document node itself and re-guards on every change: a document.open() rewrite keeps
  // the Document object but drops its listeners and root element.
  const watchedFrameDocs = new WeakSet<Document>();
  watchFrames = () => {
    for (const frameDoc of adapter?.frameDocs?.(document) ?? []) {
      guardDoc(frameDoc);
      if (watchedFrameDocs.has(frameDoc)) continue;
      watchedFrameDocs.add(frameDoc);
      new MutationObserver(() => {
        guardDoc(frameDoc);
        domChanged();
      }).observe(frameDoc, { childList: true, subtree: true });
    }
  };
  // Look for new frames only when a mutation adds one (or on an iframe load below); scans also re-check.
  const addsFrame = (records: MutationRecord[]) =>
    records.some((r) =>
      Array.from(r.addedNodes).some(
        (n) => n.nodeType === 1 && (tagOf(n as Element) === 'iframe' || queryAll(n as Element, 'iframe').length > 0),
      ),
    );
  const rootTarget = document.body ?? document.documentElement;
  if (rootTarget) {
    new MutationObserver((records) => {
      if (adapter?.frameDocs && addsFrame(records)) watchFrames();
      domChanged();
    }).observe(rootTarget, { childList: true, subtree: true });
  }
  // An iframe that (re)loads gets a new document without any top-level DOM change.
  document.addEventListener('load', (e) => {
    if (e.target instanceof HTMLIFrameElement) {
      watchFrames();
      domChanged();
    }
  }, true);
  watchFrames();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduler.schedule();
  });
  browser.storage?.onChanged?.addListener((changes, areaName) => {
    if (storageChangeAffectsVerdicts(changes, areaName, trustedThisSession, ownWrites)) {
      lastKey = '';
      scheduler.schedule();
    }
  });
  scheduler.schedule();
}

function runICloudSandbox() {
  let lastSig = '';
  // Signature of the reported body: '' before any body, SIG_PENDING while it is being computed (or if it cannot be).
  // Decisions carrying a signature apply only when it equals this one.
  const SIG_PENDING = 'pending';
  let lastSigHash = '';
  let desiredLocked = false;
  let desiredAttachmentsLocked = false;
  let activeInlineAtts: HTMLElement[] = [];
  // The lock decision comes from the app frame after it scores this body. Until it arrives (first render,
  // changed body, or a reloaded frame), clicks are held like a pending scan instead of going straight through.
  let awaitingVerdict = true;
  const verdictWaiters: (() => void)[] = [];
  const waitForVerdict = () =>
    awaitingVerdict
      ? new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ICLOUD_VERDICT_WAIT_MS);
          verdictWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        })
      : Promise.resolve();

  const syncInlineAttachmentLocks = (attachments: AttachmentRef[], locked: boolean) => {
    const els = attachments.map((a) => a.element);
    const nextSet = new Set(els);
    const stale = activeInlineAtts.filter((el) => !nextSet.has(el));
    if (stale.length) unlockAttachments(stale);
    activeInlineAtts = els;
    if (els.length === 0) return;
    if (locked) {
      const names = new Map<HTMLElement, string>();
      for (const a of attachments) {
        if (a.name) names.set(a.element, a.name);
      }
      lockAttachments(els, names);
    } else {
      unlockAttachments(els);
    }
  };

  const releaseVerdictWaiters = () => {
    awaitingVerdict = false;
    for (const release of verdictWaiters.splice(0)) release();
  };

  const report = (force = false) => {
    if (document.hidden) return;
    if (!extensionAlive()) {
      // Orphaned by an extension update or reload: no verdict can arrive from the app frame any more, so lock
      // links and inline downloads (fail closed) until the page is reloaded.
      desiredLocked = true;
      desiredAttachmentsLocked = true;
      releaseVerdictWaiters();
      if (document.body) lockLinks(document.body);
      syncInlineAttachmentLocks(extractICloudSandbox(document).attachments, true);
      return;
    }
    const { active, body, links, linksTruncated = false, attachments, container } = extractICloudSandbox(document);
    if (!active || !container) {
      if (document.body) unlockLinks(document.body);
      if (activeInlineAtts.length) {
        unlockAttachments(activeInlineAtts);
        activeInlineAtts = [];
      }
      desiredLocked = false;
      desiredAttachmentsLocked = false;
      if (force || lastSig !== 'inactive') {
        lastSig = 'inactive';
        lastSigHash = '';
        void sendRuntime({ type: 'icloudBody', active: false, body: '', links: [], attachmentNames: [] });
      }
      return;
    }
    const attachmentNames = attachments.map((a) => a.name);
    const sig = JSON.stringify({ active, body, links, linksTruncated, attachmentNames });
    if (force || sig !== lastSig) {
      if (sig !== lastSig) {
        awaitingVerdict = true;
        lastSigHash = SIG_PENDING; // no decision applies to this body before its signature is known
      }
      lastSig = sig;
      const send = (hash: string | undefined) =>
        void sendRuntime({
          type: 'icloudBody',
          active: true,
          body,
          links,
          linksTruncated,
          attachmentNames,
          ...(hash ? { sig: hash } : {}),
        });
      if (lastSigHash !== SIG_PENDING) send(lastSigHash);
      else {
        void bodySignature(sig).then((hash) => {
          if (lastSig !== sig) return; // a newer body was reported meanwhile
          if (hash) lastSigHash = hash;
          send(hash); // without a signature the app frame's decisions for this body can only lock it
        });
      }
    }
    if (desiredLocked) lockLinks(container);
    syncInlineAttachmentLocks(attachments, desiredAttachmentsLocked);
  };

  const scheduler = createScheduler(async () => report(false));
  // Extraction for click-time attachment lookups while a decision is pending, made at most once per DOM change.
  let pressExtraction: ReturnType<typeof extractICloudSandbox> | null = null;
  const domChanged = () => {
    pressExtraction = null;
    scheduler.schedule();
  };
  // Pairing: the app frame posts a random token to this frame's window; reporting it back through the background
  // (which adds the verified frame id) lets the app tie this body to its card in every browser.
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const nonce = (e.data as { __pedPair?: unknown } | null)?.__pedPair;
    if (typeof nonce === 'string' && PAIR_NONCE_RE.test(nonce)) void sendRuntime({ type: 'icloudPair', nonce });
  });
  // The banner lives in the app frame: a paused click here asks it (via the background relay) to reopen it.
  const askAppToReopen = () => void sendRuntime({ type: 'icloudBlocked' });
  setLinkBlockedHandler(document, askAppToReopen);
  setAttachmentBlockedHandler(document, askAppToReopen);

  installClickGuard({
    findTarget: (a) =>
      document.body && document.body.contains(a)
        ? { container: document.body, senderAddress: '', senderRegistrable: '' }
        : null,
    findAttachment: (el) => matchAttachmentInMessages([(pressExtraction ??= extractICloudSandbox(document))], el),
    isPending: () => scheduler.isPending() || awaitingVerdict,
    flushScan: async () => {
      await scheduler.flush();
      if (!extensionAlive()) report(); // fail closed now rather than wait out a verdict that cannot come
      await waitForVerdict();
    },
  });

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; locked?: unknown; attachmentsLocked?: unknown; sig?: unknown } | undefined;
    if (m?.type === 'icloudLock') {
      // A decision made for an earlier body of this (pooled) frame must not unlock or release the current one.
      if (typeof m.sig === 'string' && m.sig !== lastSigHash) return;
      const locked = Boolean(m.locked);
      const attachmentsLocked = Boolean(m.attachmentsLocked);
      if (typeof m.sig !== 'string' && lastSigHash !== '') {
        // No signature: the app frame decided before it saw this body. Such a decision may only tighten; it never
        // releases held clicks or unlocks, because this body's own decision is still to come.
        if (!locked && !attachmentsLocked) return;
        desiredLocked ||= locked;
        desiredAttachmentsLocked ||= attachmentsLocked;
      } else {
        desiredLocked = locked;
        desiredAttachmentsLocked = attachmentsLocked;
        releaseVerdictWaiters();
      }
      if (document.body) {
        if (desiredLocked) lockLinks(document.body);
        else unlockLinks(document.body);
      }
      syncInlineAttachmentLocks(extractICloudSandbox(document).attachments, desiredAttachmentsLocked);
    } else if (m?.type === 'icloudPing') {
      report(true);
    }
  });

  const target = document.body ?? document.documentElement;
  if (target) new MutationObserver(domChanged).observe(target, { childList: true, subtree: true });
  // Only visibility matters (a pooled frame shown or hidden): animated content resizes the document every frame.
  if (typeof ResizeObserver !== 'undefined' && document.documentElement) {
    let lastVisible: boolean | null = null;
    new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      const visible = Boolean(rect && rect.width > 0 && rect.height > 0);
      if (visible === lastVisible) return;
      lastVisible = visible;
      domChanged(); // a hidden frame extracts as inactive
    }).observe(document.documentElement);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduler.schedule();
  });
  window.addEventListener('pagehide', () => {
    void sendRuntime({ type: 'icloudBody', active: false, body: '', links: [], attachmentNames: [] });
  });
  scheduler.schedule();
}

function runICloudApp(kv: typeof browser.storage.local) {
  const sandboxBodies = new Map<number, ICloudSandboxPayload>();
  const trustedThisSession = new Set<string>();
  const ownWrites = new Set<string>();
  const dismissed = new Set<string>();
  let lastKey = '';
  let lastHeaderIds = '';
  let activeMessages: ScannableMsg[] = [];
  let activeAttachmentEls: HTMLElement[] = [];
  let token = 0;

  // Last decision sent to each sandbox frame, keyed by the body signature it was made for. When a frame re-reports
  // that same body (e.g. after reloading) the thread key is unchanged and nothing is re-evaluated, so re-send it.
  const MAX_FRAME_LOCKS = 100;
  const frameLocks = new Map<number, { locked: boolean; attachmentsLocked: boolean; sig?: string }>();
  const setFrameLocked = (frameId: number, locked: boolean, attachmentsLocked: boolean, sig?: string) => {
    frameLocks.delete(frameId);
    frameLocks.set(frameId, { locked, attachmentsLocked, sig });
    while (frameLocks.size > MAX_FRAME_LOCKS) frameLocks.delete(frameLocks.keys().next().value!);
    void sendRuntime({ type: 'icloudLock', locked, attachmentsLocked, frameIds: [frameId], ...(sig ? { sig } : {}) });
  };
  const unlockFrames = (list: { frameId?: number; sig?: string }[]) => {
    for (const m of list) if (typeof m.frameId === 'number') setFrameLocked(m.frameId, false, false, m.sig);
  };

  // Card <-> frame pairing. Firefox has runtime.getFrameId; elsewhere each card's iframe is sent a random token
  // (postMessage) that its sandbox reports back with the browser-verified frame id.
  const pairedFrameIds = new WeakMap<HTMLIFrameElement, number>();
  const pendingPairs = new Map<string, WeakRef<HTMLIFrameElement>>();
  const nativeFrameIdOf = (iframe: HTMLIFrameElement): number | undefined => {
    try {
      const getFrameId = (browser.runtime as { getFrameId?: (target: Element) => number }).getFrameId;
      const id = getFrameId?.(iframe);
      return typeof id === 'number' && id >= 0 ? id : undefined;
    } catch {
      return undefined;
    }
  };
  const frameIdOf = (iframe: HTMLIFrameElement): number | undefined => nativeFrameIdOf(iframe) ?? pairedFrameIds.get(iframe);
  const requestPairing = (headers: { iframes?: HTMLIFrameElement[] }[]) => {
    for (const iframe of headers.flatMap((h) => h.iframes ?? [])) {
      if (frameIdOf(iframe) !== undefined) continue;
      const nonce = crypto.randomUUID();
      pendingPairs.set(nonce, new WeakRef(iframe));
      while (pendingPairs.size > 200) pendingPairs.delete(pendingPairs.keys().next().value!);
      try {
        iframe.contentWindow?.postMessage({ __pedPair: nonce }, '*');
      } catch {
        /* frame not ready */
      }
    }
  };

  const scan = async () => {
    if (document.hidden) return;
    pendingHeaders = null;
    const headers = extractICloudHeaders(document);
    const headerIds = headers.map((h) => h.id).join('|');
    if (headerIds !== lastHeaderIds) {
      lastHeaderIds = headerIds;
      if (headers.length > 0) void sendRuntime({ type: 'icloudPing' });
    }
    requestPairing(headers);

    const messages = combineICloudThread(headers, sandboxBodies, frameIdOf);
    if (messages.length === 0) {
      for (const [frameId, payload] of sandboxBodies) setFrameLocked(frameId, false, false, payload.sig);
      if (activeAttachmentEls.length) unlockAttachments(activeAttachmentEls);
      setBlockedHandlers(null);
      activeMessages = [];
      activeAttachmentEls = [];
      lastKey = '';
      ++token;
      removeBanner();
      sendVerdict(null);
      return;
    }

    const nextAttEls = [...new Set(messages.flatMap(attachmentElementsOf))];
    const trustKey = messages.map(msgKey).join('\n---\n');
    // Pairing certainty is part of the key: when nonce pairing completes, trust must be re-evaluated.
    const frameKey = messages.map((m) => `${m.frameId ?? ''}${m.pairingUncertain ? '?' : ''}`).join(',');
    const fullKey = `${trustKey}\n@@\n${frameKey}`;
    if (fullKey === lastKey && arraysEqual(nextAttEls, activeAttachmentEls)) {
      resendVerdictIfNavigated();
      return;
    }

    const newAttSet = new Set(nextAttEls);
    const staleAtts = activeAttachmentEls.filter((el) => !newAttSet.has(el));
    if (staleAtts.length) unlockAttachments(staleAtts);

    activeMessages = messages;
    activeAttachmentEls = nextAttEls;
    lastKey = fullKey;
    const my = ++token;
    removeBanner();

    await evaluateAndRender({
      kv,
      messages,
      overflowCount: Math.max(0, messages.length - MAX_THREAD_MESSAGES),
      trustedThisSession,
      ownWrites,
      authSignals: false, // iCloud shows no per-message sender verification the adapter can read
      dismissed,
      isStale: () => my !== token,
      applyLocks: (items) => {
        const frameLockMap = new Map<number, { links: boolean; atts: boolean; sig?: string }>();
        for (const { email, trusted, hasAttachments, linksLocked } of items) {
          const lockAtts = !trusted && hasAttachments;
          if (lockAtts) lockMessageAttachments(email);
          else unlockMessageAttachments(email);

          if (typeof email.frameId !== 'number') continue;
          const prev = frameLockMap.get(email.frameId);
          frameLockMap.set(email.frameId, {
            links: (prev?.links ?? false) || linksLocked,
            atts: (prev?.atts ?? false) || lockAtts,
            sig: email.sig,
          });
        }
        for (const [frameId, state] of frameLockMap) {
          // No signature: this frame's body (if it has one yet) was not part of the decision, so it may only lock.
          if (!state.sig && !state.links && !state.atts) continue;
          setFrameLocked(frameId, state.links, state.atts, state.sig);
        }
      },
      unlockAll: (all) => {
        for (const m of all) unlockMessageAttachments(m);
        if (activeAttachmentEls.length) unlockAttachments(activeAttachmentEls);
        unlockFrames(all);
      },
      unlockMatching: (matched) => {
        for (const m of matched) unlockMessageAttachments(m);
        unlockFrames(matched);
      },
    });
  };

  const scheduler = createScheduler(scan);
  // As on standard webmail: a fresh extraction for click-time lookups while a scan is pending, once per DOM change.
  let pendingHeaders: ReturnType<typeof extractICloudHeaders> | null = null;
  const domChanged = () => {
    pendingHeaders = null;
    scheduler.schedule();
  };

  installClickGuard({
    findTarget: () => null,
    findAttachment: (el) =>
      matchAttachmentInMessages(activeMessages, el) ??
      (scheduler.isPending() ? matchAttachmentInMessages((pendingHeaders ??= extractICloudHeaders(document)), el) : null),
    isPending: () => scheduler.isPending(),
    flushScan: () => scheduler.flush(),
  });

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as
      | {
          type?: string;
          frameId?: unknown;
          active?: unknown;
          body?: unknown;
          links?: unknown;
          linksTruncated?: unknown;
          attachmentNames?: unknown;
          sig?: unknown;
          nonce?: unknown;
        }
      | undefined;
    if (m?.type === 'icloudBlocked') {
      currentReopen?.();
      return;
    }
    if (m?.type === 'icloudPair' && typeof m.nonce === 'string' && typeof m.frameId === 'number') {
      const iframe = pendingPairs.get(m.nonce)?.deref();
      pendingPairs.delete(m.nonce);
      if (iframe) {
        pairedFrameIds.set(iframe, m.frameId);
        scheduler.schedule();
      }
      return;
    }
    if (m?.type !== 'icloudBody' || typeof m.frameId !== 'number') return;
    if (m.active) {
      const attachmentNames = Array.isArray(m.attachmentNames)
        ? m.attachmentNames.filter((n): n is string => typeof n === 'string')
        : [];
      const payload: ICloudSandboxPayload = {
        body: typeof m.body === 'string' ? m.body : '',
        links: Array.isArray(m.links) ? (m.links as Link[]) : [],
        ...(m.linksTruncated === true ? { linksTruncated: true } : {}),
        ...(attachmentNames.length ? { attachmentNames } : {}),
        ...(typeof m.sig === 'string' ? { sig: m.sig.slice(0, 32) } : {}),
      };
      sandboxBodies.set(m.frameId, payload);
      const last = frameLocks.get(m.frameId);
      if (last && payload.sig && last.sig === payload.sig) {
        setFrameLocked(m.frameId, last.locked, last.attachmentsLocked, last.sig);
      }
      scheduler.schedule();
    } else if (sandboxBodies.delete(m.frameId)) {
      scheduler.schedule();
    }
  });

  if (document.body) new MutationObserver(domChanged).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduler.schedule();
  });
  browser.storage?.onChanged?.addListener((changes, areaName) => {
    if (storageChangeAffectsVerdicts(changes, areaName, trustedThisSession, ownWrites)) {
      lastKey = '';
      scheduler.schedule();
    }
  });
  void sendRuntime({ type: 'icloudPing' });
  scheduler.schedule();
}

// The production manifest splits this entry by frame (wxt.config.ts build hook): top frame only on standard webmail,
// all frames on iCloud's app/message frames. The early returns below keep any other injection a no-op.
export default defineContentScript({
  matches: WEBMAIL_MATCHES,
  allFrames: true,
  main() {
    const url = new URL(location.href);
    const icloudRole = icloudFrameRole(url);
    if (icloudRole === 'shell') return;
    if (icloudRole === 'sandbox') {
      runICloudSandbox();
      return;
    }
    const kv = browser.storage.local;
    if (icloudRole === 'app') {
      runICloudApp(kv);
      return;
    }
    if (window !== window.top) return; // Keep Gmail/Outlook/Yahoo/Proton strictly in top frame
    runStandardWebmail(kv, adapterFor(url));
  },
});
