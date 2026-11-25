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
  ownerDocOf,
  queryAll,
  rawLinkTarget,
  resolveAnchorHref,
  tagOf,
  useLinks,
} from '../src/dom';
import { isLookupDomain } from '../src/domain';
import type { DomainIntel } from '../src/domainIntel';
import { type Link, type Verdict, scoreEmail } from '../src/features';
import { recordFalsePositive } from '../src/feedback';
import { icloudFrameRole, WEBMAIL_MATCHES } from '../src/hosts';
import { analyzeLinkDestination, isSafeHttpUrl, mergeLinkIntel } from '../src/linkGuard';
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
import { showPausedAttachmentToast, showPausedLinkToast } from '../src/ui/linkToast';

const MAX_THREAD_MESSAGES = 20; // newest messages that get full scoring and domain lookups
const MAX_SESSION_SET = 200;
const CLICK_INTEL_TIMEOUT_MS = 700;
// While the sender's own domain lookup is still running, a click on a same-domain link waits a little longer
// for it: a brand-new or non-existent sender domain is the classic phishing shape.
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

/** Short, stable hash (FNV-1a) used to tie iCloud lock decisions to the body they were made for. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
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
 * Additions do not rescan: they come from this tab's own trust buttons, which already re-render.
 */
function storageChangeAffectsVerdicts(
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
  trustedThisSession: Set<string>,
): boolean {
  if (areaName === 'managed') return true;
  if (areaName !== 'local') return false;
  let affected = 'privacySettings' in changes;
  for (const key of ['trustedEmails', 'trustedSenders'] as const) {
    const change = changes[key];
    if (!change) continue;
    const next = new Set(stringsOf(change.newValue));
    const prev = new Set(stringsOf(change.oldValue));
    // A revocation removes entries without adding any; adding at the list cap also evicts the oldest entries,
    // which must not tear down this tab's just-shown Undo pill.
    const removed = [...prev].some((v) => !next.has(v));
    const added = [...next].some((v) => !prev.has(v));
    if (!removed || added) continue;
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
 * renders several different links and the clicked one cannot be told apart.
 */
function clickedLink(el: Element): { anchor: Element; at: Element } | 'ambiguous' | null {
  const a = closestEl(el, 'a, area');
  if (a) return { anchor: a, at: a };
  const use = closestEl(el, 'use');
  const links = use ? useLinks(use) : [];
  if (!use || links.length === 0) return null;
  const targets = new Set(links.map((l) => resolveAnchorHref(l)).filter(Boolean));
  return targets.size > 1 ? 'ambiguous' : { anchor: links[0]!, at: use };
}

/** Navigate as the click itself would have (used once a held click is cleared by a local-only check). */
function replayNavigation(anchor: Element, href: string, activeTab: boolean): void {
  const win = ownerDocOf(anchor).defaultView ?? window;
  const target = (getAttr(anchor, 'target') ?? '').trim().toLowerCase();
  if (!activeTab || (target && target !== '_self')) win.open(href, '_blank', 'noopener,noreferrer');
  else win.location.assign(href);
}

function installClickGuard(opts: {
  findTarget: (
    el: Element,
  ) => { container: HTMLElement; senderAddress: string; senderRegistrable: string; senderIntelPending?: boolean } | null;
  findAttachment?: (el: Element) => { element: HTMLElement; name: string } | null;
  isPending: () => boolean;
  flushScan: () => Promise<void>;
}) {
  const onEvent = (e: Event) => {
    const el = eventElement(e);
    if (!el) return;

    if (e.type === 'submit') {
      const form = closestEl(el, 'form');
      if (!form) return;
      const hit = opts.findTarget(form);
      if (!hit || isLocked(hit.container) || !opts.isPending()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void opts.flushScan();
      return;
    }

    if (e.type === 'keydown') {
      const key = (e as KeyboardEvent).key;
      if (key !== 'Enter' && key !== ' ') return;
    } else if (e.type === 'auxclick') {
      if ((e as MouseEvent).button !== 1) return;
    } else if (e.type === 'click') {
      if ((e as MouseEvent).button !== 0) return;
    }

    const attHit = opts.findAttachment?.(el);
    if (attHit && !isAttachmentLocked(attHit.element) && opts.isPending()) {
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
    if (clicked === 'ambiguous') {
      // Several links behind one <use>: which one was clicked is unknowable, so pause rather than guess.
      if (!opts.findTarget(el)) return;
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
    // Clicks held for a scan that then locks the message get the same notice as a click on a locked link.
    const lockedAfterScan = () => {
      const refreshed = opts.findTarget(at);
      if (!isLocked(hit.container) && !(refreshed && isLocked(refreshed.container))) return false;
      showPausedLinkToast(ownerDocOf(a), initialRisk.host, a instanceof HTMLElement ? a : null);
      return true;
    };
    if (!extensionAlive()) {
      // Orphaned by an extension update: the background can no longer check or open links for us. Risky links
      // stay paused until the tab is reloaded; safe ones still wait for a pending scan (which runs locally) and
      // then navigate natively.
      if (initialRisk.level === 'safe' && !pending) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (initialRisk.level !== 'safe') {
        showPausedLinkToast(ownerDocOf(a), initialRisk.host, a instanceof HTMLElement ? a : null);
        return;
      }
      void (async () => {
        await opts.flushScan();
        if (!lockedAfterScan()) replayNavigation(a, rawHref, activeTab);
      })();
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();

    void (async () => {
      if (opts.isPending()) {
        await opts.flushScan();
        if (lockedAfterScan()) return;
      }

      const latest = opts.findTarget(a) ?? hit;
      const risk = analyzeLinkDestination(rawHref, latest.senderRegistrable, location.origin);
      if (risk.level !== 'safe') {
        void sendRuntime({
          type: 'openWarning',
          href: risk.href,
          host: risk.host,
          registrable: risk.registrable,
          level: risk.level,
          reasons: risk.reasons,
        });
        return;
      }

      if (risk.needsDomainCheck) {
        const settings = await getSettings(browser.storage.local, managedStorage());
        if (!settings.strictLocalMode) {
          let timerId: ReturnType<typeof setTimeout> | undefined;
          const waitMs = latest.senderIntelPending ? SENDER_INTEL_WAIT_MS : CLICK_INTEL_TIMEOUT_MS;
          const intel = await Promise.race([
            sendRuntime<DomainIntel>({ type: 'domainIntel', domain: risk.registrable }),
            new Promise<undefined>((resolve) => {
              timerId = setTimeout(() => resolve(undefined), waitMs);
            }),
          ]).finally(() => clearTimeout(timerId));
          const finalRisk = mergeLinkIntel(risk, intel);
          if (finalRisk.level !== 'safe') {
            void sendRuntime({
              type: 'openWarning',
              href: finalRisk.href,
              host: finalRisk.host,
              registrable: finalRisk.registrable,
              level: finalRisk.level,
              reasons: finalRisk.reasons,
              intel,
            });
            return;
          }
        }
      }

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
  /** Sender domains whose online lookup is still running (shared with the click guard). */
  intelPending?: Set<string>;
  /** Leading messages (oldest) that exceed MAX_THREAD_MESSAGES: locked unless trusted, never scored or looked up. */
  overflowCount?: number;
  trustedThisSession: Set<string>;
  dismissed: Set<string>;
  isStale: () => boolean;
  onEvaluated?: (items: { email: T; sender: ReturnType<typeof analyzeSender> }[]) => void;
  applyLocks: (items: { email: T; trusted: boolean; hasAttachments: boolean }[], anyLinksLocked: boolean) => void;
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
    if (allowlisted && !allowlistTrusted) {
      sender.warnings.unshift(
        `Claims to be a trusted sender (${sender.address}), but failed authentication or used an unexpected relay`,
      );
    }
    const trusted = threadUnlocked || trustedThisSession.has(hash) || trustedEmails.has(hash) || allowlistTrusted;
    const verdict: Verdict = trusted || skipped ? SAFE_VERDICT : untrustedVerdict(overflow, sender, email);
    const attAnalysis: AttachmentAnalysis | undefined = trusted ? undefined : analyzeAttachments(attNames, attCount);
    return { email, attNames, attCount, hash, sender, allowlistTrusted, trusted, overflow, skipped, verdict, attAnalysis };
  });
  if (isStale()) return;
  onEvaluated?.(items);

  const intelByDomain = new Map<string, IntelState>();
  for (const item of items) {
    if (
      !item.trusted &&
      !item.overflow &&
      !item.skipped &&
      isLookupDomain(item.sender.registrable) &&
      !intelByDomain.has(item.sender.registrable)
    ) {
      intelByDomain.set(item.sender.registrable, settings.strictLocalMode ? 'offline' : 'loading');
    }
  }

  let showingUndoPill = false;
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
      const attBoost = entry.item.attAnalysis?.level === 'warning' ? 0.2 : entry.item.attAnalysis?.count ? 0.1 : 0;
      // Fail-closed "unchecked" items rank below every real finding so they never hide one.
      const evidence = entry.item.verdict.unchecked ? -0.5 : entry.item.verdict.score;
      const rank = (entry.banner.level === 'danger' ? 10 : 0) + evidence + attBoost;
      if (rank >= bestRank) {
        bestRank = rank;
        primaryEntry = entry;
      }
    }

    const anyLinksLocked = evaluated.some((e) => e.banner?.linksLocked);
    const anyAttachmentsLocked = evaluated.some((e) => e.banner?.attachmentsLocked);
    applyLocks(
      evaluated.map(({ item }) => ({ email: item.email, trusted: item.trusted, hasAttachments: item.attCount > 0 })),
      anyLinksLocked,
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
      if (!dismissed.delete(threadHashKey)) return;
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
          addBounded(trustedThisSession, threadHashKey);
          for (const { item } of evaluated) {
            addBounded(trustedThisSession, item.hash);
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
          await trustEmails(kv, evaluated.map((e) => e.item.hash));
        },
        onUndoUnlock: async () => {
          showingUndoPill = false;
          trustedThisSession.delete(threadHashKey);
          const hashes = evaluated.map((e) => e.item.hash);
          for (const { item } of evaluated) {
            trustedThisSession.delete(item.hash);
            item.trusted = item.allowlistTrusted;
            item.verdict =
              item.trusted || item.skipped ? SAFE_VERDICT : untrustedVerdict(item.overflow, item.sender, item.email);
            item.attAnalysis = item.trusted ? undefined : analyzeAttachments(item.attNames, item.attCount);
          }
          await untrustEmails(kv, hashes);
          render();
        },
        onTrustSender: async () => {
          if (!canTrustByAllowlist(primaryEntry.item.sender)) return false;
          const addr = primaryEntry.item.sender.address;
          const ok = await trustSender(kv, addr);
          if (ok) {
            const matched: T[] = [];
            for (const { item } of evaluated) {
              if (item.sender.address === addr && canTrustByAllowlist(item.sender)) {
                item.allowlistTrusted = true;
                item.trusted = true;
                item.verdict = SAFE_VERDICT;
                item.attAnalysis = undefined;
                matched.push(item.email);
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
    void Promise.all(
      [...intelByDomain.keys()].map(async (domain) => {
        opts.intelPending?.add(domain);
        const res = await sendRuntime<DomainIntel | null>({ type: 'domainIntel', domain });
        opts.intelPending?.delete(domain);
        intelByDomain.set(domain, res === null ? 'offline' : (res ?? 'unavailable'));
      }),
    ).then(() => {
      if (!isStale()) render();
    });
  }
}

function runStandardWebmail(kv: typeof browser.storage.local, adapter: WebmailAdapter | undefined) {
  const trustedThisSession = new Set<string>();
  const dismissed = new Set<string>();
  const containerSender = new WeakMap<HTMLElement, { address: string; registrable: string }>();
  const intelPending = new Set<string>();
  let lastKey = '';
  let activeContainers: HTMLElement[] = [];
  let activeMessages: ExtractedEmail[] = [];
  let activeAttachmentEls: HTMLElement[] = [];
  let token = 0;

  let watchFrames = () => {};

  const scan = async () => {
    if (document.hidden) return; // never work in background tabs
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
      dismissed,
      isStale: () => my !== token,
      onEvaluated: (items) => {
        for (const { email, sender } of items) {
          containerSender.set(email.container, { address: sender.address, registrable: sender.registrable });
        }
      },
      applyLocks: (items, anyLinksLocked) => {
        for (const { email, trusted, hasAttachments } of items) {
          if (anyLinksLocked && !trusted) lockLinks(email.container);
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
          };
        }
      }
      if (scheduler.isPending()) {
        const fresh = extractAll(adapter, document).find((m) => m.container.contains(a));
        if (fresh) {
          const s = analyzeSender(fresh.senderName, fresh.senderAddress, []);
          return { container: fresh.container, senderAddress: s.address, senderRegistrable: s.registrable };
        }
      }
      return null;
    },
    findAttachment: (el) =>
      matchAttachmentInMessages(activeMessages, el) ??
      (scheduler.isPending() ? matchAttachmentInMessages(extractAll(adapter, document), el) : null),
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
        scheduler.schedule();
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
      scheduler.schedule();
    }).observe(rootTarget, { childList: true, subtree: true });
  }
  // An iframe that (re)loads gets a new document without any top-level DOM change.
  document.addEventListener('load', (e) => {
    if (e.target instanceof HTMLIFrameElement) {
      watchFrames();
      scheduler.schedule();
    }
  }, true);
  watchFrames();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduler.schedule();
  });
  browser.storage?.onChanged?.addListener((changes, areaName) => {
    if (storageChangeAffectsVerdicts(changes, areaName, trustedThisSession)) {
      lastKey = '';
      scheduler.schedule();
    }
  });
  scheduler.schedule();
}

function runICloudSandbox() {
  let lastSig = '';
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
      if (sig !== lastSig) awaitingVerdict = true;
      lastSig = sig;
      lastSigHash = shortHash(sig);
      void sendRuntime({
        type: 'icloudBody',
        active: true,
        body,
        links,
        linksTruncated,
        attachmentNames,
        sig: lastSigHash,
      });
    }
    if (desiredLocked) lockLinks(container);
    syncInlineAttachmentLocks(attachments, desiredAttachmentsLocked);
  };

  const scheduler = createScheduler(async () => report(false));
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
    findAttachment: (el) => matchAttachmentInMessages([extractICloudSandbox(document)], el),
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
      desiredLocked = Boolean(m.locked);
      desiredAttachmentsLocked = Boolean(m.attachmentsLocked);
      releaseVerdictWaiters();
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
  if (target) new MutationObserver(scheduler.schedule).observe(target, { childList: true, subtree: true });
  // Only visibility matters (a pooled frame shown or hidden): animated content resizes the document every frame.
  if (typeof ResizeObserver !== 'undefined' && document.documentElement) {
    let lastVisible: boolean | null = null;
    new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      const visible = Boolean(rect && rect.width > 0 && rect.height > 0);
      if (visible === lastVisible) return;
      lastVisible = visible;
      scheduler.schedule();
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
    const frameKey = messages.map((m) => m.frameId ?? '').join(',');
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
      dismissed,
      isStale: () => my !== token,
      applyLocks: (items, anyLinksLocked) => {
        const frameLockMap = new Map<number, { links: boolean; atts: boolean; sig?: string }>();
        for (const { email, trusted, hasAttachments } of items) {
          const lockAtts = !trusted && hasAttachments;
          if (lockAtts) lockMessageAttachments(email);
          else unlockMessageAttachments(email);

          if (typeof email.frameId !== 'number') continue;
          const prev = frameLockMap.get(email.frameId);
          frameLockMap.set(email.frameId, {
            links: (prev?.links ?? false) || (anyLinksLocked && !trusted),
            atts: (prev?.atts ?? false) || lockAtts,
            sig: email.sig,
          });
        }
        for (const [frameId, state] of frameLockMap) setFrameLocked(frameId, state.links, state.atts, state.sig);
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

  installClickGuard({
    findTarget: () => null,
    findAttachment: (el) =>
      matchAttachmentInMessages(activeMessages, el) ??
      (scheduler.isPending() ? matchAttachmentInMessages(extractICloudHeaders(document), el) : null),
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
        ...(typeof m.sig === 'string' ? { sig: m.sig.slice(0, 16) } : {}),
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

  if (document.body) new MutationObserver(scheduler.schedule).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduler.schedule();
  });
  browser.storage?.onChanged?.addListener((changes, areaName) => {
    if (storageChangeAffectsVerdicts(changes, areaName, trustedThisSession)) {
      lastKey = '';
      scheduler.schedule();
    }
  });
  void sendRuntime({ type: 'icloudPing' });
  scheduler.schedule();
}

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
