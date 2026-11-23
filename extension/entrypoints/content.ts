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
import { isTrusted, trustSender } from '../src/allowlist';
import type { DomainIntel } from '../src/domainIntel';
import { type Link, type Verdict, scoreEmail } from '../src/features';
import { recordFalsePositive } from '../src/feedback';
import { WEBMAIL_MATCHES } from '../src/hosts';
import { analyzeSender } from '../src/sender';
import { decideBanner, removeBanner, showBanner } from '../src/ui/banner';
import type { IntelState } from '../src/ui/details';
import { lockLinks, unlockLinks } from '../src/ui/linkLock';

const DEBOUNCE_MS = 400;
const MAX_THREAD_MESSAGES = 20;
const FALLBACK_SELECTORS = ['div.a3s', '[aria-label="Message body"]', '[role="document"]'];

interface ScannableMsg {
  senderName: string;
  senderAddress: string;
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

const msgKey = (e: ScannableMsg) => `${e.senderAddress}\n${e.body}`;

function createScheduler(runScan: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const run = () => void runScan();
      'requestIdleCallback' in window ? requestIdleCallback(run) : run();
    }, DEBOUNCE_MS);
  };
}

async function evaluateAndRender<T extends ScannableMsg>(opts: {
  kv: typeof browser.storage.local;
  messages: T[];
  trustKey: string;
  trustedThisSession: Set<string>;
  dismissed: Set<string>;
  isStale: () => boolean;
  applyLocks: (items: { email: T; trusted: boolean }[], anyLinksLocked: boolean) => void;
  unlockAll: (emails: T[]) => void;
  unlockMatching: (emails: T[]) => void;
}) {
  const { kv, messages, trustKey, trustedThisSession, dismissed, isStale, applyLocks, unlockAll, unlockMatching } = opts;
  const threadUnlocked = trustedThisSession.has(trustKey);
  const items = await Promise.all(
    messages.map(async (email) => {
      const k = msgKey(email);
      const sender = analyzeSender(email.senderName, email.senderAddress, email.links);
      const trusted =
        threadUnlocked || trustedThisSession.has(k) || (sender.valid && (await isTrusted(kv, sender.address)));
      const verdict: Verdict = trusted
        ? { score: 0, level: 'safe', reasons: [] }
        : scoreEmail(sender.address, email.body, email.links);
      return { email, key: k, sender, trusted, verdict };
    }),
  );
  if (isStale()) return;

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
        onUnlock: () => {
          trustedThisSession.add(trustKey);
          unlockAll(evaluated.map((e) => e.item.email));
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
            unlockMatching(matched);
            browser.runtime
              .sendMessage({
                type: 'verdict',
                payload: { verdict: { score: 0, level: 'safe', reasons: [] }, sender: primaryEntry.item.sender, intel: undefined },
              })
              .catch(() => {});
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
    await Promise.all(
      [...intelByDomain.keys()].map(async (domain) => {
        try {
          const res = (await browser.runtime.sendMessage({ type: 'domainIntel', domain })) as DomainIntel | undefined;
          intelByDomain.set(domain, res ?? 'unavailable');
        } catch {
          intelByDomain.set(domain, 'unavailable');
        }
      }),
    );
    if (!isStale()) render();
  }
}

function runStandardWebmail(kv: typeof browser.storage.local, adapter: WebmailAdapter | undefined) {
  const trustedThisSession = new Set<string>();
  const dismissed = new Set<string>();
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

  const schedule = createScheduler(scan);
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
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

  const schedule = createScheduler(async () => report(false));

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
  if (target) new MutationObserver(schedule).observe(target, { childList: true, subtree: true });
  if (typeof ResizeObserver !== 'undefined' && document.documentElement) {
    new ResizeObserver(schedule).observe(document.documentElement);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule();
  });
  window.addEventListener('pagehide', () => {
    void browser.runtime.sendMessage({ type: 'icloudBody', active: false, body: '', links: [] }).catch(() => {});
  });
  schedule();
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

  const schedule = createScheduler(scan);

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; frameId?: unknown; active?: unknown; body?: unknown; links?: unknown } | undefined;
    if (m?.type !== 'icloudBody' || typeof m.frameId !== 'number') return;
    if (m.active) {
      sandboxBodies.set(m.frameId, {
        body: typeof m.body === 'string' ? m.body : '',
        links: Array.isArray(m.links) ? (m.links as Link[]) : [],
      });
      schedule();
    } else if (sandboxBodies.delete(m.frameId)) {
      schedule();
    }
  });

  if (document.body) new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) schedule();
  });
  void browser.runtime.sendMessage({ type: 'icloudPing' }).catch(() => {});
  schedule();
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
