import { bodyText, linksIn } from './extract';
import type { WebmailAdapter } from './types';

const HOSTS = new Set(['outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft']);

const BODY_SELECTORS = [
  'div[aria-label="Message body"]',
  'div[id^="UniqueMessageBody"]',
  '[data-testid="message-body"]',
  '[data-app-section="ConversationContainer"] [role="document"]',
  '[aria-label*="Reading Pane" i] [role="document"]',
  '[aria-label="Email message"] [role="document"]',
];

const isEditable = (el: HTMLElement): boolean =>
  el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.closest('[contenteditable="true"]') !== null;

const isHidden = (el: HTMLElement): boolean =>
  el.hidden || el.getAttribute('aria-hidden') === 'true' || el.closest('[hidden], [aria-hidden="true"]') !== null;

const hasContent = (el: HTMLElement): boolean =>
  (el.textContent ?? '').trim().length > 0 || el.querySelector('a[href]') !== null;

/** Unwrap Microsoft Defender Safe Links (?url=...) when pointing to http(s). */
export function unwrapSafeLink(href: string): string {
  try {
    const u = new URL(href);
    if (u.hostname.toLowerCase().endsWith('.safelinks.protection.outlook.com')) {
      const target = u.searchParams.get('url');
      if (target && /^https?:\/\//i.test(target)) return target;
    }
  } catch { /* keep original href */ }
  return href;
}

function findBody(doc: Document): { container: HTMLElement; hostEl: HTMLElement } | null {
  for (const sel of BODY_SELECTORS) {
    const matches = doc.querySelectorAll<HTMLElement>(sel);
    for (let i = matches.length - 1; i >= 0; i--) {
      const el = matches[i];
      if (!isEditable(el) && !isHidden(el) && hasContent(el)) return { container: el, hostEl: el };
    }
  }
  const iframes = doc.querySelectorAll<HTMLIFrameElement>('[aria-label*="Reading Pane" i] iframe, iframe[title*="Message" i]');
  for (let i = iframes.length - 1; i >= 0; i--) {
    const iframe = iframes[i];
    if (isHidden(iframe)) continue;
    try {
      const body = iframe.contentDocument?.body;
      if (body && !isEditable(body) && hasContent(body)) return { container: body, hostEl: iframe };
    } catch { /* cross-origin iframe */ }
  }
  return null;
}

function parseSender(raw: string, fallbackName = ''): { senderName: string; senderAddress: string } | null {
  const cleaned = raw.trim().replace(/^(?:from|sender)\s*:\s*/i, '').replace(/^opens card for\s+/i, '').trim();
  if (!cleaned) return null;
  const fb = fallbackName.trim();
  const fallback = fb && !fb.includes('@') ? fb : '';

  const angle = cleaned.match(/^(.*?)<([^<>@\s]+@[^<>@\s]+)>\s*$/);
  if (angle) {
    return { senderName: angle[1].trim().replace(/^["']|["']$/g, '') || fallback, senderAddress: angle[2].trim() };
  }
  const paren = cleaned.match(/^(.*?)\(([^()@\s]+@[^()@\s]+)\)\s*$/);
  if (paren) {
    return { senderName: paren[1].trim().replace(/^["']|["']$/g, '') || fallback, senderAddress: paren[2].trim() };
  }
  const bare = cleaned.match(/([^\s<>"'(),;]+@[^\s<>"'(),;]+\.[^\s<>"'(),;]+)/);
  if (bare && bare.index !== undefined) {
    const before = cleaned.slice(0, bare.index).replace(/^[\s,:;\-"']+|[\s,:;\-"'<]+$/g, '').trim();
    return { senderName: before || fallback, senderAddress: bare[1].trim() };
  }
  return null;
}

function findSender(doc: Document, container: HTMLElement, hostEl: HTMLElement): { senderName: string; senderAddress: string } {
  const scope =
    hostEl.closest<HTMLElement>('[aria-label="Email message"], [role="listitem"]') ??
    hostEl.closest<HTMLElement>('[data-app-section="ConversationContainer"], [aria-label*="Reading Pane" i], [role="main"]') ??
    doc.querySelector<HTMLElement>('[data-app-section="ConversationContainer"], [aria-label*="Reading Pane" i], [role="main"]') ??
    doc.body;
  if (!scope) return { senderName: '', senderAddress: '' };

  const skip = (el: Element): boolean =>
    container === el ||
    container.contains(el) ||
    el.closest('[role="banner"], nav, [aria-label^="To" i], [aria-label^="Cc" i], [aria-label^="Bcc" i], [data-testid*="recipient" i]') !== null ||
    /^(to|cc|bcc)\b/i.test(el.getAttribute('aria-label') ?? '');

  const extractFromEl = (el: Element): { senderName: string; senderAddress: string } | null => {
    const text = (el.textContent ?? '').trim();
    const fallback = text.length <= 120 && !text.includes('@') ? text : '';
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (href.toLowerCase().startsWith('mailto:')) {
        const addr = href.slice(7).split('?')[0].trim();
        if (addr) return { senderName: fallback, senderAddress: addr };
      }
    }
    return (
      parseSender(el.getAttribute('aria-label') ?? '', fallback) ??
      parseSender(el.getAttribute('title') ?? '', fallback) ??
      parseSender(text, fallback)
    );
  };

  // Pass 1: explicit From / sender nodes inside scope
  for (const el of scope.querySelectorAll('[aria-label^="From" i], [data-testid*="sender" i], [data-testid*="from" i], span.OZZZK')) {
    if (skip(el)) continue;
    const direct = extractFromEl(el);
    if (direct) return direct;
    for (const d of el.querySelectorAll('[title*="@"], [aria-label*="@"], a[href^="mailto:"]')) {
      if (skip(d)) continue;
      const hit = extractFromEl(d);
      if (hit) return hit;
    }
  }

  // Pass 2: header attribute nodes in DOM order inside scope
  for (const el of scope.querySelectorAll('[title*="@"], [aria-label*="@"], a[href^="mailto:"]')) {
    if (skip(el)) continue;
    const hit = extractFromEl(el);
    if (hit) return hit;
  }

  // Pass 3: plain-text Name<addr@domain> or addr@domain inside header span/button in scope
  let nonLeafHit: { senderName: string; senderAddress: string } | null = null;
  let bareLeafHit: { senderName: string; senderAddress: string } | null = null;
  for (const el of scope.querySelectorAll('span, button')) {
    if (skip(el)) continue;
    const text = (el.textContent ?? '').trim();
    if (!text.includes('@') || text.length > 200) continue;
    const hit = extractFromEl(el);
    if (!hit) continue;
    const hasChildAt = [...el.children].some((c) => (c.textContent ?? '').includes('@'));
    if (!hasChildAt) {
      if (hit.senderName) return hit;
      bareLeafHit ??= hit;
    } else {
      nonLeafHit ??= hit;
    }
  }
  return (nonLeafHit?.senderName ? nonLeafHit : bareLeafHit) ?? nonLeafHit ?? { senderName: '', senderAddress: '' };
}

export const outlook: WebmailAdapter = {
  name: 'outlook',
  matches: (url) => HOSTS.has(url.hostname),
  extract(doc) {
    const found = findBody(doc);
    if (!found) return null;
    const { container, hostEl } = found;
    const { senderName, senderAddress } = findSender(doc, container, hostEl);
    const links = linksIn(container).map((l) => ({ text: l.text, href: unwrapSafeLink(l.href) }));
    return { senderName, senderAddress, body: bodyText(container), links, container };
  },
};
