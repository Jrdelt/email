import { adapterFor } from '../src/adapters';
import { bodyText, linksIn } from '../src/adapters/extract';
import {
  type ICloudSandboxPayload,
  combineICloudThread,
  extractICloudHeaders,
  extractICloudSandbox,
  icloudFrameRole,
} from '../src/adapters/icloud';
import type { ExtractedEmail, WebmailAdapter } from '../src/adapters/types';
import { hashEmail, listTrusted, listTrustedEmails, trustEmails, trustSender } from '../src/allowlist';
import type { DomainIntel } from '../src/domainIntel';
import { type Link, type Verdict, scoreEmail } from '../src/features';
import { recordFalsePositive } from '../src/feedback';
import { WEBMAIL_MATCHES } from '../src/hosts';
import { analyzeLinkDestination, isSafeHttpUrl, mergeLinkIntel } from '../src/linkGuard';
import { analyzeSender, canTrustByAllowlist } from '../src/sender';
import { decideBanner, removeBanner, showBanner } from '../src/ui/banner';
import type { IntelState } from '../src/ui/details';
import { isLocked, lockLinks, unlockLinks } from '../src/ui/linkLock';

const DEBOUNCE_MS = 400;
const MAX_THREAD_MESSAGES = 20;
const CLICK_INTEL_TIMEOUT_MS = 700;
const FALLBACK_SELECTORS = ['div.a3s', '[aria-label="Message body"]', '[role="document"]'];

interface ScannableMsg {
  senderName: string;
  senderAddress: string;
  viaDomain?: string;
  unauthenticated?: boolean;
  body: string;
  links: Link[];
}

function fallbackExtract(doc: Document): ExtractedEmail | null {
  const container = FALLBACK_SELECTORS.map((s) => doc.querySelector<HTMLElement>(s)).find(Boolean);
  return container ? { senderName: '', senderAddress: '', body: bodyText(container), links: linksIn(container), container } : null;
}

function extractAll(adapter: WebmailAdapter | undefined, doc: Document): ExtractedEmail[] {
  if (adapter?.extractAll) return adapter.extractAll(doc);
  const one = adapter ? adapter.extract(doc) : fallbackExtract(doc);
  return one ? [one] : [];
}

const msgKey = (e: ScannableMsg) =>
  `${e.senderAddress}\n${e.viaDomain ?? ''}\n${e.unauthenticated ? '1' : '0'}\n${e.body}`;

function createScheduler(runScan: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let inflight: Promise<void> | null = null;
  const exec = () => {
    clearTimeout(timer);
    timer = undefined;
    if (inflight) return inflight;
    pending = false;
    inflight = runScan().finally(() => {
      inflight = null;
    });
    return inflight;
  };
  const schedule = () => {
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const run = () => void exec();
      'requestIdleCallback' in window ? requestIdleCallback(run) : run();
    }, DEBOUNCE_MS);
  };
  return { schedule, flush: exec, isPending: () => pending || inflight !== null };
}

function installClickGuard(opts: {
  findTarget: (el: Element) => { container: HTMLElement; senderAddress: string; senderRegistrable: string } | null;
  isPending: () => boolean;
  flushScan: () => Promise<void>;
}) {
  const onLinkClick = (e: Event) => {
    const me = e as MouseEvent;
    if (e.type === 'auxclick' && me.button !== 1) return;
    if (e.type === 'click' && me.button !== 0) return;

    const node = e.target as Node | null;
    const el = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
    if (!el) return;
    const a = el.closest('a[href], area[href]');
    if (!a) return;

    const hit = opts.findTarget(a);
    if (!hit || isLocked(hit.container)) return;

    const rawHref =
      typeof (a as HTMLAnchorElement).href === 'string'
        ? (a as HTMLAnchorElement).href
        : (a.getAttribute('href') ?? '');
    if (!isSafeHttpUrl(rawHref)) return;

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
        const intel = await Promise.race([
          (browser.runtime.sendMessage({ type: 'domainIntel', domain: risk.registrable }) as Promise<
            DomainIntel | undefined
          >).catch(() => undefined),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), CLICK_INTEL_TIMEOUT_MS)),
        ]);
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

      void browser.runtime.sendMessage({ type: 'openSafeLink', href: rawHref, active: activeTab }).catch(() => {});
    })();
  };

  document.addEventListener('click', onLinkClick, true);
  document.addEventListener('auxclick', onLinkClick, true);
}

async function evaluateAndRender<T extends ScannableMsg>(opts: {
  kv: typeof browser.storage.local;
  messages: T[];
  trustKey: string;
  trustedThisSession: Set<string>;
  dismissed: Set<string>;
  isStale: () => boolean;
  onEvaluated?: (items: { email: T; sender: ReturnType<typeof analyzeSender> }[]) => void;
  applyLocks: (items: { email: T; trusted: boolean }[], anyLinksLocked: boolean) => void;
  unlockAll: (emails: T[]) => void;
  unlockMatching: (emails: T[]) => void;
}) {
  const { kv, messages, trustKey, trustedThisSession, dismissed, isStale, onEvaluated, applyLocks, unlockAll, unlockMatching } = opts;
  const threadUnlocked = trustedThisSession.has(trustKey);
  const [trustedSendersList, trustedEmailsList] = await Promise.all([listTrusted(kv), listTrustedEmails(kv)]);
  const trustedSenders = new Set(trustedSendersList);
  const trustedEmails = new Set(trustedEmailsList);
  const items = await Promise.all(
    messages.map(async (email) => {
      const k = msgKey(email);
      const hash = await hashEmail(email.senderAddress, email.body, email.links);
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
      return { email, key: k, hash, sender, trusted, verdict };
    }),
  );
  if (isStale()) return;
  onEvaluated?.(items);

  const intelByDomain = new Map<string, IntelState>();
  for (const item of items) {
    if (!item.trusted && item.sender.registrable && !intelByDomain.has(item.sender.registrable)) {
      intelByDomain.set(item.sender.registrable, 'loading');
    }
  }

  const render = () => {
    const unlockedThread = trustedThisSession.has(trustKey);
    const evaluated = items.map((item) => {
      const intel = item.sender.registrable ? intelByDomain.get(item.sender.registrable) : undefined;
      const banner = item.trusted
        ? null
        : decideBanner(item.verdict, item.sender, intel, unlockedThread || trustedThisSession.has(item.key));
      return { item, intel, banner };
    });

    let primaryEntry = evaluated[evaluated.length - 1];
    let bestRank = -1;
    for (const entry of evaluated) {
      if (!entry.banner) continue;
      const rank = (entry.banner.level === 'danger' ? 10 : 0) + entry.item.verdict.score;
      if (rank >= bestRank) {
        bestRank = rank;
        primaryEntry = entry;
      }
    }

    const anyLinksLocked = evaluated.some((e) => e.banner?.linksLocked);
    applyLocks(
      evaluated.map(({ item }) => ({ email: item.email, trusted: item.trusted })),
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
        },
      })
      .catch(() => {});

    if (!primaryBanner || dismissed.has(trustKey)) {
      removeBanner();
      return;
    }
    showBanner(
      { ...primaryBanner, linksLocked: anyLinksLocked },
      {
        onUnlock: async () => {
          trustedThisSession.add(trustKey);
          for (const { item } of evaluated) {
            trustedThisSession.add(item.hash);
            item.trusted = true;
            item.verdict = { score: 0, level: 'safe', reasons: [] };
          }
          unlockAll(evaluated.map((e) => e.item.email));
          browser.runtime
            .sendMessage({
              type: 'verdict',
              payload: {
                verdict: { score: 0, level: 'safe', reasons: [] },
                sender: primaryEntry.item.sender,
                intel: primaryEntry.intel,
              },
            })
            .catch(() => {});
          await trustEmails(kv, evaluated.map((e) => e.item.hash));
        },
        onTrustSender: async () => {
          const addr = primaryEntry.item.sender.address;
          const ok = await trustSender(kv, addr);
          if (ok) {
            const matched: T[] = [];
            for (const { item } of evaluated) {
              if (item.sender.address === addr) {
                item.trusted = true;
                item.verdict = { score: 0, level: 'safe', reasons: [] };
                matched.push(item.email);
              }
            }
            const anyRemainingBanner = evaluated.some(({ item }) => {
              if (item.trusted) return false;
              const intel = item.sender.registrable ? intelByDomain.get(item.sender.registrable) : undefined;
              return decideBanner(item.verdict, item.sender, intel, false) !== null;
            });
            if (!anyRemainingBanner) {
              unlockAll(evaluated.map((e) => e.item.email));
              browser.runtime
                .sendMessage({
                  type: 'verdict',
                  payload: { verdict: { score: 0, level: 'safe', reasons: [] }, sender: primaryEntry.item.sender, intel: undefined },
                })
                .catch(() => {});
            } else {
              unlockMatching(matched);
            }
          }
          return ok;
        },
        onReport: () => recordFalsePositive(kv, { ...primaryEntry.item.verdict, reasons: primaryBanner.reasons }),
        onDismiss: () => dismissed.add(trustKey),
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
  let token = 0;

  const scan = async () => {
    if (document.hidden) return; // never work in background tabs
    const emails = extractAll(adapter, document);
    if (emails.length === 0) {
      for (const c of activeContainers) unlockLinks(c);
      activeContainers = [];
      lastKey = '';
      ++token;
      removeBanner();
      browser.runtime.sendMessage({ type: 'verdict', payload: null }).catch(() => {});
      return;
    }

    const messages = emails.slice(-MAX_THREAD_MESSAGES);
    const threadKey = messages.map(msgKey).join('\n---\n');
    if (
      threadKey === lastKey &&
      messages.length === activeContainers.length &&
      messages.every((m, i) => m.container === activeContainers[i])
    ) {
      return; // unchanged thread => no work
    }

    const newContainers = new Set(messages.map((m) => m.container));
    for (const c of activeContainers) {
      if (!newContainers.has(c)) unlockLinks(c);
    }
    activeContainers = messages.map((m) => m.container);
    lastKey = threadKey;
    const my = ++token;
    removeBanner();

    await evaluateAndRender({
      kv,
      messages,
      trustKey: threadKey,
      trustedThisSession,
      dismissed,
      isStale: () => my !== token,
      onEvaluated: (items) => {
        for (const { email, sender } of items) {
          containerSender.set(email.container, { address: sender.address, registrable: sender.registrable });
        }
      },
      applyLocks: (items, anyLocked) => {
        for (const { email, trusted } of items) {
          if (anyLocked && !trusted) lockLinks(email.container);
          else unlockLinks(email.container);
        }
      },
      unlockAll: (all) => {
        for (const m of all) unlockLinks(m.container);
      },
      unlockMatching: (matched) => {
        for (const m of matched) unlockLinks(m.container);
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
    isPending: () => scheduler.isPending(),
    flushScan: () => scheduler.flush(),
  });

  new MutationObserver(scheduler.schedule).observe(document.body, { childList: true, subtree: true });
  scheduler.schedule();
}

function runICloudSandbox() {
  let lastSig = '';
  let desiredLocked = false;

  const report = (force = false) => {
    if (document.hidden) return;
    const { active, body, links, container } = extractICloudSandbox(document);
    if (!active || !container) {
      if (document.body) unlockLinks(document.body);
      desiredLocked = false;
      if (force || lastSig !== 'inactive') {
        lastSig = 'inactive';
        void browser.runtime.sendMessage({ type: 'icloudBody', active: false, body: '', links: [] }).catch(() => {});
      }
      return;
    }
    const sig = JSON.stringify({ active, body, links });
    if (force || sig !== lastSig) {
      lastSig = sig;
      void browser.runtime.sendMessage({ type: 'icloudBody', active: true, body, links }).catch(() => {});
    }
    if (desiredLocked) lockLinks(container);
  };

  const scheduler = createScheduler(async () => report(false));

  installClickGuard({
    findTarget: (a) =>
      document.body && document.body.contains(a)
        ? { container: document.body, senderAddress: '', senderRegistrable: '' }
        : null,
    isPending: () => scheduler.isPending(),
    flushScan: () => scheduler.flush(),
  });

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; locked?: unknown } | undefined;
    if (m?.type === 'icloudLock') {
      desiredLocked = Boolean(m.locked);
      if (document.body) {
        if (desiredLocked) lockLinks(document.body);
        else unlockLinks(document.body);
      }
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
    void browser.runtime.sendMessage({ type: 'icloudBody', active: false, body: '', links: [] }).catch(() => {});
  });
  scheduler.schedule();
}

function runICloudApp(kv: typeof browser.storage.local) {
  const sandboxBodies = new Map<number, ICloudSandboxPayload>();
  const trustedThisSession = new Set<string>();
  const dismissed = new Set<string>();
  let lastKey = '';
  let lastHeaderIds = '';
  let token = 0;

  const setFramesLocked = (frameIds: number[], locked: boolean) => {
    if (frameIds.length > 0) {
      void browser.runtime.sendMessage({ type: 'icloudLock', locked, frameIds }).catch(() => {});
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
      setFramesLocked([...sandboxBodies.keys()], false);
      lastKey = '';
      ++token;
      removeBanner();
      browser.runtime.sendMessage({ type: 'verdict', payload: null }).catch(() => {});
      return;
    }

    const trustKey = messages.map((m) => `${m.senderAddress}\n${m.body}\n${m.links.length}`).join('\n---\n');
    const frameKey = messages.map((m) => m.frameId ?? '').join(',');
    const fullKey = `${trustKey}\n@@\n${frameKey}`;
    if (fullKey === lastKey) return;

    lastKey = fullKey;
    const my = ++token;
    removeBanner();

    await evaluateAndRender({
      kv,
      messages,
      trustKey,
      trustedThisSession,
      dismissed,
      isStale: () => my !== token,
      applyLocks: (items, anyLocked) => {
        const lockedIds: number[] = [];
        const unlockedIds: number[] = [];
        for (const { email, trusted } of items) {
          if (typeof email.frameId !== 'number') continue;
          if (anyLocked && !trusted) lockedIds.push(email.frameId);
          else unlockedIds.push(email.frameId);
        }
        setFramesLocked(lockedIds, true);
        setFramesLocked(unlockedIds, false);
      },
      unlockAll: (all) => setFramesLocked(frameIdsOf(all), false),
      unlockMatching: (matched) => setFramesLocked(frameIdsOf(matched), false),
    });
  };

  const scheduler = createScheduler(scan);

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; frameId?: unknown; active?: unknown; body?: unknown; links?: unknown } | undefined;
    if (m?.type !== 'icloudBody' || typeof m.frameId !== 'number') return;
    if (m.active) {
      sandboxBodies.set(m.frameId, {
        body: typeof m.body === 'string' ? m.body : '',
        links: Array.isArray(m.links) ? (m.links as Link[]) : [],
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
