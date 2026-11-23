import { adapterFor } from '../src/adapters';
import { bodyText, inlineAttachmentsIn, linksIn } from '../src/adapters/extract';
import {
  type ICloudSandboxPayload,
  combineICloudThread,
  extractICloudHeaders,
  extractICloudSandbox,
} from '../src/adapters/icloud';
import type { AttachmentRef, ExtractedEmail, WebmailAdapter } from '../src/adapters/types';
import { hashEmail, listTrusted, listTrustedEmails, trustEmails, trustSender, untrustEmails } from '../src/allowlist';
import { type AttachmentAnalysis, analyzeAttachments } from '../src/attachments';
import { eventElement, getAttr, getAttrNS, resolveAnchorHref, XLINK_NS } from '../src/dom';
import type { DomainIntel } from '../src/domainIntel';
import { type Link, type Verdict, scoreEmail } from '../src/features';
import { recordFalsePositive } from '../src/feedback';
import { icloudFrameRole, WEBMAIL_MATCHES } from '../src/hosts';
import { analyzeLinkDestination, isSafeHttpUrl, mergeLinkIntel } from '../src/linkGuard';
import { analyzeSender, canTrustByAllowlist } from '../src/sender';
import {
  isAttachmentLocked,
  lockAttachments,
  setAttachmentBlockedHandler,
  unlockAttachments,
} from '../src/ui/attachmentLock';
import { decideBanner, removeBanner, showBanner } from '../src/ui/banner';
import type { IntelState } from '../src/ui/details';
import { isLocked, lockLinks, setLinkBlockedHandler, unlockLinks } from '../src/ui/linkLock';
import { showPausedAttachmentToast } from '../src/ui/linkToast';

const DEBOUNCE_MS = 400;
const MAX_THREAD_MESSAGES = 20;
const MAX_SESSION_SET = 200;
const CLICK_INTEL_TIMEOUT_MS = 700;
const FALLBACK_SELECTORS = ['div.a3s', '[aria-label="Message body"]', '[role="document"]'];

interface ScannableMsg {
  senderName: string;
  senderAddress: string;
  viaDomain?: string;
  unauthenticated?: boolean;
  body: string;
  links: Link[];
  attachments?: AttachmentRef[];
  attachmentContainers?: HTMLElement[];
  attachmentNames?: string[];
}

function addBounded(set: Set<string>, key: string): void {
  if (set.has(key)) return;
  if (set.size >= MAX_SESSION_SET) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(key);
}

function fallbackExtract(doc: Document): ExtractedEmail | null {
  const container = FALLBACK_SELECTORS.map((s) => doc.querySelector<HTMLElement>(s)).find(Boolean);
  if (!container) return null;
  const attachments = inlineAttachmentsIn(container);
  return {
    senderName: '',
    senderAddress: '',
    body: bodyText(container),
    links: linksIn(container),
    ...(attachments.length ? { attachments } : {}),
    container,
  };
}

function extractAll(adapter: WebmailAdapter | undefined, doc: Document): ExtractedEmail[] {
  if (adapter?.extractAll) return adapter.extractAll(doc);
  const one = adapter ? adapter.extract(doc) : fallbackExtract(doc);
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

const msgKey = (e: ScannableMsg) => {
  const names = attachmentNamesOf(e);
  return `${e.senderAddress}\n${e.viaDomain ?? ''}\n${e.unauthenticated ? '1' : '0'}\n${e.body}\natt:${names.join('|')}:${names.length}:${e.attachments?.length ?? 0}:${e.attachmentContainers?.length ?? 0}`;
};

function createScheduler(runScan: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let inflight: Promise<void> | null = null;
  const exec = () => {
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
          // Keep scheduler loop alive on unexpected DOM mutations
        }
      } while (pending);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
  const schedule = () => {
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const run = () => void exec();
      'requestIdleCallback' in window ? requestIdleCallback(run, { timeout: 250 }) : run();
    }, DEBOUNCE_MS);
  };
  return { schedule, flush: exec, isPending: () => pending || inflight !== null };
}

function matchAttachmentInMessages(
  messages: readonly ScannableMsg[],
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

function installClickGuard(opts: {
  findTarget: (el: Element) => { container: HTMLElement; senderAddress: string; senderRegistrable: string } | null;
  findAttachment?: (el: Element) => { element: HTMLElement; name: string } | null;
  isPending: () => boolean;
  flushScan: () => Promise<void>;
}) {
  const onEvent = (e: Event) => {
    const el = eventElement(e);
    if (!el) return;

    if (e.type === 'submit') {
      const form = el.closest('form');
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
        if (isAttachmentLocked(post.element) || post.element.closest('[data-ped-att-locked]')) {
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

    const a = el.closest('a, area');
    if (!a) return;
    const rawAttr = (getAttr(a, 'href') ?? getAttrNS(a, XLINK_NS, 'href') ?? getAttr(a, 'xlink:href') ?? '').trim();
    if (!rawAttr || rawAttr.startsWith('#')) return;

    const hit = opts.findTarget(a);
    if (!hit || isLocked(hit.container)) return;

    const rawHref = resolveAnchorHref(a);
    if (!isSafeHttpUrl(rawHref)) return;

    const me = e as MouseEvent;
    const pending = opts.isPending();
    const initialRisk = analyzeLinkDestination(rawHref, hit.senderRegistrable, location.origin);
    if (!pending && initialRisk.level === 'safe' && !initialRisk.needsDomainCheck) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    const activeTab = !(me.metaKey || me.ctrlKey || (e.type === 'auxclick' && me.button === 1));

    void (async () => {
      if (opts.isPending()) {
        await opts.flushScan();
        const refreshed = opts.findTarget(a);
        if (isLocked(hit.container) || (refreshed && isLocked(refreshed.container))) return;
      }

      const latest = opts.findTarget(a) ?? hit;
      const risk = analyzeLinkDestination(rawHref, latest.senderRegistrable, location.origin);
      if (risk.level !== 'safe') {
        void browser.runtime
          .sendMessage({
            type: 'openWarning',
            href: risk.href,
            host: risk.host,
            registrable: risk.registrable,
            level: risk.level,
            reasons: risk.reasons,
            senderAddress: latest.senderAddress,
          })
          .catch(() => {});
        return;
      }

      if (risk.needsDomainCheck) {
        let timerId: ReturnType<typeof setTimeout> | undefined;
        const intel = await Promise.race([
          (browser.runtime.sendMessage({ type: 'domainIntel', domain: risk.registrable }) as Promise<
            DomainIntel | undefined
          >).catch(() => undefined),
          new Promise<undefined>((resolve) => {
            timerId = setTimeout(() => resolve(undefined), CLICK_INTEL_TIMEOUT_MS);
          }),
        ]).finally(() => clearTimeout(timerId));
        const finalRisk = mergeLinkIntel(risk, intel);
        if (finalRisk.level !== 'safe') {
          void browser.runtime
            .sendMessage({
              type: 'openWarning',
              href: finalRisk.href,
              host: finalRisk.host,
              registrable: finalRisk.registrable,
              level: finalRisk.level,
              reasons: finalRisk.reasons,
              senderAddress: latest.senderAddress,
              intel,
            })
            .catch(() => {});
          return;
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
      void browser.runtime.sendMessage({ type: 'openSafeLink', href: rawHref, active: activeTab }).catch(() => {});
    })();
  };

  for (const type of ['click', 'auxclick', 'mousedown', 'pointerdown', 'keydown', 'submit']) {
    document.addEventListener(type, onEvent, true);
  }
}

async function evaluateAndRender<T extends ScannableMsg>(opts: {
  kv: typeof browser.storage.local;
  messages: T[];
  trustedThisSession: Set<string>;
  dismissed: Set<string>;
  isStale: () => boolean;
  onEvaluated?: (items: { email: T; sender: ReturnType<typeof analyzeSender> }[]) => void;
  applyLocks: (items: { email: T; trusted: boolean; hasAttachments: boolean }[], anyLinksLocked: boolean) => void;
  unlockAll: (emails: T[]) => void;
  unlockMatching: (emails: T[]) => void;
}) {
  const { kv, messages, trustedThisSession, dismissed, isStale, onEvaluated, applyLocks, unlockAll, unlockMatching } = opts;
  const [trustedSendersList, trustedEmailsList, prelim] = await Promise.all([
    listTrusted(kv),
    listTrustedEmails(kv),
    Promise.all(
      messages.map(async (email) => {
        const attNames = attachmentNamesOf(email);
        const attCount = Math.max(attNames.length, email.attachments?.length ?? 0);
        const hash = await hashEmail(email.senderAddress, email.body, email.links, attNames);
        return { email, attNames, attCount, hash };
      }),
    ),
  ]);
  const trustedSenders = new Set(trustedSendersList);
  const trustedEmails = new Set(trustedEmailsList);
  const threadHashKey = prelim.map((p) => p.hash).join(',');
  const threadUnlocked = trustedThisSession.has(threadHashKey);

  const items = prelim.map(({ email, attNames, attCount, hash }) => {
    const sender = analyzeSender(email.senderName, email.senderAddress, email.links, {
      viaDomain: email.viaDomain,
      unauthenticated: email.unauthenticated,
    });
    const allowlisted = sender.valid && trustedSenders.has(sender.address);
    const allowlistTrusted = allowlisted && canTrustByAllowlist(sender);
    if (allowlisted && !allowlistTrusted) {
      sender.warnings.unshift(
        `Claims to be a trusted sender (${sender.address}), but failed authentication or used an unexpected relay`,
      );
    }
    const trusted = threadUnlocked || trustedThisSession.has(hash) || trustedEmails.has(hash) || allowlistTrusted;
    const verdict: Verdict = trusted
      ? { score: 0, level: 'safe', reasons: [] }
      : scoreEmail(sender.address, email.body, email.links);
    const attAnalysis: AttachmentAnalysis | undefined = trusted ? undefined : analyzeAttachments(attNames, attCount);
    return { email, attNames, attCount, hash, sender, allowlistTrusted, trusted, verdict, attAnalysis };
  });
  if (isStale()) return;
  onEvaluated?.(items);

  const intelByDomain = new Map<string, IntelState>();
  for (const item of items) {
    if (!item.trusted && item.sender.registrable && !intelByDomain.has(item.sender.registrable)) {
      intelByDomain.set(item.sender.registrable, 'loading');
    }
  }

  let showingUndoPill = false;

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
      const rank = (entry.banner.level === 'danger' ? 10 : 0) + entry.item.verdict.score + attBoost;
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
    browser.runtime
      .sendMessage({
        type: 'verdict',
        payload: {
          verdict: primaryEntry.item.verdict,
          sender: primaryEntry.item.sender,
          intel: primaryEntry.intel,
          attachments: primaryEntry.item.trusted ? undefined : primaryEntry.item.attAnalysis,
          trusted: primaryEntry.item.trusted,
        },
      })
      .catch(() => {});

    if (!primaryBanner) {
      setAttachmentBlockedHandler(document, null);
      setLinkBlockedHandler(document, null);
      if (!showingUndoPill) removeBanner();
      return;
    }

    const reopenBanner = () => {
      if (!dismissed.delete(threadHashKey)) return;
      render();
    };
    setAttachmentBlockedHandler(document, reopenBanner);
    setLinkBlockedHandler(document, reopenBanner);

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
            item.verdict = { score: 0, level: 'safe', reasons: [] };
            item.attAnalysis = undefined;
          }
          setAttachmentBlockedHandler(document, null);
          setLinkBlockedHandler(document, null);
          unlockAll(evaluated.map((e) => e.item.email));
          browser.runtime
            .sendMessage({
              type: 'verdict',
              payload: {
                verdict: { score: 0, level: 'safe', reasons: [] },
                sender: primaryEntry.item.sender,
                intel: primaryEntry.intel,
                trusted: true,
              },
            })
            .catch(() => {});
          await trustEmails(kv, evaluated.map((e) => e.item.hash));
        },
        onUndoUnlock: async () => {
          showingUndoPill = false;
          trustedThisSession.delete(threadHashKey);
          const hashes = evaluated.map((e) => e.item.hash);
          for (const { item } of evaluated) {
            trustedThisSession.delete(item.hash);
            item.trusted = item.allowlistTrusted;
            item.verdict = item.trusted
              ? { score: 0, level: 'safe', reasons: [] }
              : scoreEmail(item.sender.address, item.email.body, item.email.links);
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
                item.verdict = { score: 0, level: 'safe', reasons: [] };
                item.attAnalysis = undefined;
                matched.push(item.email);
              }
            }
            unlockMatching(matched);
            render();
          }
          return ok;
        },
        onReport: () => recordFalsePositive(kv, { ...primaryEntry.item.verdict, reasons: primaryBanner.reasons }),
        onDismiss: () => {
          showingUndoPill = false;
          addBounded(dismissed, threadHashKey);
        },
      },
    );
  };
  render();

  if (intelByDomain.size > 0) {
    void Promise.all(
      [...intelByDomain.keys()].map(async (domain) => {
        try {
          const res = (await browser.runtime.sendMessage({ type: 'domainIntel', domain })) as DomainIntel | undefined;
          intelByDomain.set(domain, res ?? 'unavailable');
        } catch {
          intelByDomain.set(domain, 'unavailable');
        }
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
  let lastKey = '';
  let activeContainers: HTMLElement[] = [];
  let activeMessages: ExtractedEmail[] = [];
  let activeAttachmentEls: HTMLElement[] = [];
  let token = 0;

  const scan = async () => {
    if (document.hidden) return; // never work in background tabs
    const emails = extractAll(adapter, document);
    if (emails.length === 0) {
      for (const c of activeContainers) unlockLinks(c);
      if (activeAttachmentEls.length) unlockAttachments(activeAttachmentEls);
      setAttachmentBlockedHandler(document, null);
      setLinkBlockedHandler(document, null);
      activeContainers = [];
      activeMessages = [];
      activeAttachmentEls = [];
      lastKey = '';
      ++token;
      removeBanner();
      browser.runtime.sendMessage({ type: 'verdict', payload: null }).catch(() => {});
      return;
    }

    const messages = emails.slice(-MAX_THREAD_MESSAGES);
    const threadKey = messages.map(msgKey).join('\n---\n');
    const nextContainers = messages.map((m) => m.container);
    const nextAttachmentEls = [...new Set(messages.flatMap(attachmentElementsOf))];

    if (
      threadKey === lastKey &&
      arraysEqual(nextContainers, activeContainers) &&
      arraysEqual(nextAttachmentEls, activeAttachmentEls)
    ) {
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

  installClickGuard({
    findTarget: (a) => {
      for (const c of activeContainers) {
        if (c.contains(a)) {
          const meta = containerSender.get(c);
          return { container: c, senderAddress: meta?.address ?? '', senderRegistrable: meta?.registrable ?? '' };
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

  const rootTarget = document.body ?? document.documentElement;
  if (rootTarget) new MutationObserver(scheduler.schedule).observe(rootTarget, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduler.schedule();
  });
  scheduler.schedule();
}

function runICloudSandbox() {
  let lastSig = '';
  let desiredLocked = false;
  let desiredAttachmentsLocked = false;
  let activeInlineAtts: HTMLElement[] = [];

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

  const report = (force = false) => {
    if (document.hidden) return;
    const { active, body, links, attachments, container } = extractICloudSandbox(document);
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
        void browser.runtime
          .sendMessage({ type: 'icloudBody', active: false, body: '', links: [], attachmentNames: [] })
          .catch(() => {});
      }
      return;
    }
    const attachmentNames = attachments.map((a) => a.name);
    const sig = JSON.stringify({ active, body, links, attachmentNames });
    if (force || sig !== lastSig) {
      lastSig = sig;
      void browser.runtime
        .sendMessage({ type: 'icloudBody', active: true, body, links, attachmentNames })
        .catch(() => {});
    }
    if (desiredLocked) lockLinks(container);
    syncInlineAttachmentLocks(attachments, desiredAttachmentsLocked);
  };

  const scheduler = createScheduler(async () => report(false));

  installClickGuard({
    findTarget: (a) =>
      document.body && document.body.contains(a)
        ? { container: document.body, senderAddress: '', senderRegistrable: '' }
        : null,
    findAttachment: (el) => {
      for (const a of extractICloudSandbox(document).attachments) {
        if (a.element === el || a.element.contains(el)) return { element: a.element, name: a.name };
      }
      return null;
    },
    isPending: () => scheduler.isPending(),
    flushScan: () => scheduler.flush(),
  });

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; locked?: unknown; attachmentsLocked?: unknown } | undefined;
    if (m?.type === 'icloudLock') {
      desiredLocked = Boolean(m.locked);
      desiredAttachmentsLocked = Boolean(m.attachmentsLocked);
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
  if (typeof ResizeObserver !== 'undefined' && document.documentElement) {
    new ResizeObserver(scheduler.schedule).observe(document.documentElement);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduler.schedule();
  });
  window.addEventListener('pagehide', () => {
    void browser.runtime
      .sendMessage({ type: 'icloudBody', active: false, body: '', links: [], attachmentNames: [] })
      .catch(() => {});
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

  const setFramesLocked = (frameIds: number[], locked: boolean, attachmentsLocked: boolean) => {
    if (frameIds.length > 0) {
      void browser.runtime.sendMessage({ type: 'icloudLock', locked, attachmentsLocked, frameIds }).catch(() => {});
    }
  };
  const frameIdsOf = (list: { frameId?: number }[]) =>
    list.map((m) => m.frameId).filter((id): id is number => typeof id === 'number');

  const scan = async () => {
    if (document.hidden) return;
    const headers = extractICloudHeaders(document);
    const headerIds = headers.map((h) => h.id).join('|');
    if (headerIds !== lastHeaderIds) {
      lastHeaderIds = headerIds;
      if (headers.length > 0) void browser.runtime.sendMessage({ type: 'icloudPing' }).catch(() => {});
    }

    const messages = combineICloudThread(headers, sandboxBodies).slice(-MAX_THREAD_MESSAGES);
    if (messages.length === 0) {
      setFramesLocked([...sandboxBodies.keys()], false, false);
      if (activeAttachmentEls.length) unlockAttachments(activeAttachmentEls);
      setAttachmentBlockedHandler(document, null);
      setLinkBlockedHandler(document, null);
      activeMessages = [];
      activeAttachmentEls = [];
      lastKey = '';
      ++token;
      removeBanner();
      browser.runtime.sendMessage({ type: 'verdict', payload: null }).catch(() => {});
      return;
    }

    const nextAttEls = [...new Set(messages.flatMap(attachmentElementsOf))];
    const trustKey = messages.map(msgKey).join('\n---\n');
    const frameKey = messages.map((m) => m.frameId ?? '').join(',');
    const fullKey = `${trustKey}\n@@\n${frameKey}`;
    if (fullKey === lastKey && arraysEqual(nextAttEls, activeAttachmentEls)) return;

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
      trustedThisSession,
      dismissed,
      isStale: () => my !== token,
      applyLocks: (items, anyLinksLocked) => {
        const frameLockMap = new Map<number, { links: boolean; atts: boolean }>();
        for (const { email, trusted, hasAttachments } of items) {
          const lockAtts = !trusted && hasAttachments;
          if (lockAtts) lockMessageAttachments(email);
          else unlockMessageAttachments(email);

          if (typeof email.frameId !== 'number') continue;
          const prev = frameLockMap.get(email.frameId);
          frameLockMap.set(email.frameId, {
            links: (prev?.links ?? false) || (anyLinksLocked && !trusted),
            atts: (prev?.atts ?? false) || lockAtts,
          });
        }
        for (const [frameId, state] of frameLockMap) {
          setFramesLocked([frameId], state.links, state.atts);
        }
      },
      unlockAll: (all) => {
        for (const m of all) unlockMessageAttachments(m);
        if (activeAttachmentEls.length) unlockAttachments(activeAttachmentEls);
        setFramesLocked(frameIdsOf(all), false, false);
      },
      unlockMatching: (matched) => {
        for (const m of matched) unlockMessageAttachments(m);
        setFramesLocked(frameIdsOf(matched), false, false);
      },
    });
  };

  const scheduler = createScheduler(scan);

  installClickGuard({
    findTarget: () => null,
    findAttachment: (el) => {
      const activeHit = matchAttachmentInMessages(activeMessages, el);
      if (activeHit) return activeHit;
      if (scheduler.isPending()) {
        const headers = extractICloudHeaders(document);
        for (const h of headers) {
          for (const att of h.attachments) {
            if (att.element === el || att.element.contains(el)) return { element: att.element, name: att.name };
          }
          for (const box of h.attachmentContainers) {
            if (box === el || box.contains(el)) return { element: box, name: '' };
          }
        }
      }
      return null;
    },
    isPending: () => scheduler.isPending(),
    flushScan: () => scheduler.flush(),
  });

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as
      | { type?: string; frameId?: unknown; active?: unknown; body?: unknown; links?: unknown; attachmentNames?: unknown }
      | undefined;
    if (m?.type !== 'icloudBody' || typeof m.frameId !== 'number') return;
    if (m.active) {
      const attachmentNames = Array.isArray(m.attachmentNames)
        ? m.attachmentNames.filter((n): n is string => typeof n === 'string')
        : [];
      sandboxBodies.set(m.frameId, {
        body: typeof m.body === 'string' ? m.body : '',
        links: Array.isArray(m.links) ? (m.links as Link[]) : [],
        ...(attachmentNames.length ? { attachmentNames } : {}),
      });
      scheduler.schedule();
    } else if (sandboxBodies.delete(m.frameId)) {
      scheduler.schedule();
    }
  });

  if (document.body) new MutationObserver(scheduler.schedule).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduler.schedule();
  });
  void browser.runtime.sendMessage({ type: 'icloudPing' }).catch(() => {});
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
