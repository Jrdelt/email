import { MAX_BODY_CHARS, bodyText, linksIn } from './extract';
import type { Link } from '../features';
import type { ExtractedEmail, WebmailAdapter } from './types';

export type ICloudFrameRole = 'shell' | 'app' | 'sandbox' | null;

export interface ICloudHeader {
  id: string;
  senderName: string;
  senderAddress: string;
  subject: string;
  iframeCount: number;
  container: HTMLElement;
}

export interface ICloudSandboxPayload {
  body: string;
  links: Link[];
}

export interface ICloudThreadMessage {
  senderName: string;
  senderAddress: string;
  body: string;
  links: Link[];
  frameId?: number;
}

/** Identify which iCloud Mail frame a URL belongs to, or null if not iCloud Mail. */
export function icloudFrameRole(url: URL): ICloudFrameRole {
  const host = url.hostname.toLowerCase();
  if (host === 'www.icloud.com' && url.pathname.startsWith('/applications/mail2')) return 'app';
  if (host === 'www.icloud.com' && url.pathname.startsWith('/mail')) return 'shell';
  if (host.endsWith('.icloud-sandbox.com') && url.pathname.startsWith('/applications/mail2-message')) return 'sandbox';
  return null;
}

const isHidden = (el: HTMLElement): boolean =>
  el.hidden || el.getAttribute('aria-hidden') === 'true' || el.closest('[hidden], [aria-hidden="true"]') !== null;

function parseSender(raw: string, fallbackName = ''): { senderName: string; senderAddress: string } | null {
  const cleaned = raw.trim().replace(/^(?:from|sender)\s*:\s*/i, '').trim();
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

function isRecipientNode(el: Element): boolean {
  if (el.closest('[aria-label^="To" i], [aria-label^="Cc" i], [aria-label^="Bcc" i], [data-testid*="recipient" i]')) {
    return true;
  }
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur.matches('.conversation-list-item, .allow-select')) break;
    const label = cur.getAttribute('aria-label') ?? '';
    if (/^(to|cc|bcc|reply-to)\b/i.test(label)) return true;
    const text = (cur.textContent ?? '').trim();
    if (/^(to|cc|bcc|reply-to)\s*:/i.test(text) && !/\bfrom\s*:/i.test(text)) return true;
  }
  return false;
}

function extractFromEl(el: Element, fallbackName = ''): { senderName: string; senderAddress: string } | null {
  const text = (el.textContent ?? '').trim();
  const fb = (text.length <= 120 && !text.includes('@') ? text : '') || fallbackName;
  if (el.tagName === 'A') {
    const href = el.getAttribute('href') ?? '';
    if (href.toLowerCase().startsWith('mailto:')) {
      const addr = href.slice(7).split('?')[0].trim();
      if (addr) return { senderName: fb, senderAddress: addr };
    }
  }
  const dataEmail = el.getAttribute('data-email')?.trim() ?? '';
  if (dataEmail) {
    const parsed = parseSender(dataEmail, fb);
    if (parsed) return parsed;
  }
  return (
    parseSender(el.getAttribute('aria-label') ?? '', fb) ??
    parseSender(el.getAttribute('title') ?? '', fb) ??
    parseSender(text, fb)
  );
}

function extractHeaderSender(card: HTMLElement): { senderName: string; senderAddress: string } {
  const skip = (el: Element): boolean =>
    el.closest('iframe, h2') !== null || isRecipientNode(el);

  let fallbackName = '';

  // Pass 1: primary span.contact-token (always present in collapsed and expanded states)
  for (const token of card.querySelectorAll<HTMLElement>('span.contact-token')) {
    if (isHidden(token) || skip(token)) continue;
    const text = (token.textContent ?? '').trim();
    if (!fallbackName && text && !text.includes('@')) fallbackName = text;
    const hit = extractFromEl(token, fallbackName);
    if (hit) return hit;
    if (!fallbackName && text) fallbackName = text;
    break;
  }

  // Pass 2a: explicit From / sender nodes
  for (const el of card.querySelectorAll('[aria-label^="From" i], [data-testid*="sender" i], [data-testid*="from" i]')) {
    if (skip(el)) continue;
    const direct = extractFromEl(el, fallbackName);
    if (direct) return { senderName: direct.senderName || fallbackName, senderAddress: direct.senderAddress };
    for (const d of el.querySelectorAll('a[href^="mailto:"], [title*="@"], [aria-label*="@"]')) {
      if (skip(d)) continue;
      const hit = extractFromEl(d, fallbackName);
      if (hit) return { senderName: hit.senderName || fallbackName, senderAddress: hit.senderAddress };
    }
  }

  // Pass 2b: expanded "Details" header (.allow-select rows)
  for (const box of card.querySelectorAll<HTMLElement>('.allow-select')) {
    if (isHidden(box)) continue;
    const rows = box.children.length > 0 ? [...box.children] : [box];
    let inRecipients = false;
    for (const row of rows) {
      const rowText = (row.textContent ?? '').trim();
      const rowAria = row.getAttribute('aria-label') ?? '';
      const isFromRow = /^(?:from|sender)\s*:/i.test(rowText) || /^(?:from|sender)\b/i.test(rowAria);
      const isRecipRow = /^(?:to|cc|bcc|reply-to)\s*:/i.test(rowText) || /^(?:to|cc|bcc|reply-to)\b/i.test(rowAria);
      if (isRecipRow) {
        inRecipients = true;
        continue;
      }
      if (inRecipients && !isFromRow) continue;
      for (const node of row.querySelectorAll('a[href^="mailto:"], [title*="@"], [aria-label*="@"]')) {
        if (skip(node)) continue;
        const hit = extractFromEl(node, fallbackName);
        if (hit) return { senderName: hit.senderName || fallbackName, senderAddress: hit.senderAddress };
      }
      const hit = extractFromEl(row, fallbackName);
      if (hit) return { senderName: hit.senderName || fallbackName, senderAddress: hit.senderAddress };
    }
  }

  // Pass 2c: fallback header links/attributes outside h2 and iframe
  for (const el of card.querySelectorAll('a[href^="mailto:"], [title*="@"], [aria-label*="@"]')) {
    if (skip(el)) continue;
    const hit = extractFromEl(el, fallbackName);
    if (hit) return { senderName: hit.senderName || fallbackName, senderAddress: hit.senderAddress };
  }

  return { senderName: fallbackName, senderAddress: '' };
}

/** Extract header metadata for all visible message cards inside the iCloud mail2 frame. */
export function extractICloudHeaders(doc: Document): ICloudHeader[] {
  let wrappers = [...doc.querySelectorAll<HTMLElement>('div[id^="message-iframe-"]')].filter(
    (el) => !isHidden(el) && el.parentElement?.closest('div[id^="message-iframe-"]') === null,
  );
  if (wrappers.length === 0) {
    wrappers = [...doc.querySelectorAll<HTMLElement>('.pane.thread-detail-pane .conversation-list-item, .conversation-list .conversation-list-item')].filter(
      (el) => !isHidden(el) && el.parentElement?.closest('.conversation-list-item') === null,
    );
  }
  return wrappers.map((wrapper) => {
    const card = wrapper.matches('.conversation-list-item')
      ? wrapper
      : wrapper.querySelector<HTMLElement>('.conversation-list-item') ?? wrapper;
    const { senderName, senderAddress } = extractHeaderSender(card);
    const subject = (card.querySelector('h2')?.textContent ?? '').trim();
    const iframeCount = card.querySelectorAll('iframe').length;
    return { id: wrapper.id || '', senderName, senderAddress, subject, iframeCount, container: card };
  });
}

/** Extract body text and links from an iCloud sandboxed message-body iframe document. */
export function extractICloudSandbox(
  doc: Document,
  viewport?: { width: number; height: number },
): { active: boolean; body: string; links: Link[]; container: HTMLElement | null } {
  const bodyEl = doc.body;
  if (!bodyEl) return { active: false, body: '', links: [], container: null };

  const vp = viewport ?? (doc.defaultView ? { width: doc.defaultView.innerWidth, height: doc.defaultView.innerHeight } : undefined);
  if (vp && (vp.width <= 0 || vp.height <= 0)) {
    return { active: false, body: '', links: [], container: null };
  }

  const body = bodyText(bodyEl);
  const links = linksIn(bodyEl);
  const active = body.trim().length > 0 || links.length > 0 || bodyEl.querySelector('form') !== null;
  if (!active) return { active: false, body: '', links: [], container: null };
  return { active: true, body, links, container: bodyEl };
}

/** Pair header cards from mail2 with active sandboxed body payloads in DOM order. */
export function combineICloudThread(
  headers: ICloudHeader[],
  bodies: Map<number, ICloudSandboxPayload>,
): ICloudThreadMessage[] {
  if (headers.length === 0) return [];
  const entries = [...bodies.entries()];
  const count = Math.max(headers.length, entries.length);
  const out: ICloudThreadMessage[] = [];
  for (let i = 0; i < count; i++) {
    const h = headers[Math.min(i, headers.length - 1)];
    const entry = entries[i];
    const body = [h.subject, entry?.[1].body ?? ''].filter(Boolean).join('\n').slice(0, MAX_BODY_CHARS);
    out.push({
      senderName: h.senderName,
      senderAddress: h.senderAddress,
      body,
      links: entry?.[1].links ?? [],
      frameId: entry?.[0],
    });
  }
  return out;
}

function sameOriginBody(card: HTMLElement): HTMLElement | null {
  const iframe = card.querySelector<HTMLIFrameElement>('iframe');
  if (iframe) {
    try {
      const b = iframe.contentDocument?.body;
      if (b) return b;
    } catch { /* cross-origin iframe */ }
  }
  return card.querySelector<HTMLElement>('[data-message-body]');
}

export const icloud: WebmailAdapter = {
  name: 'icloud',
  matches: (url) => icloudFrameRole(url) !== null,
  extractAll(doc): ExtractedEmail[] {
    const headers = extractICloudHeaders(doc);
    if (headers.length > 0) {
      return headers.map((h) => {
        const bodyEl = sameOriginBody(h.container);
        const rawBody = bodyEl ? bodyText(bodyEl) : '';
        const body = [h.subject, rawBody].filter(Boolean).join('\n').slice(0, MAX_BODY_CHARS);
        const links = bodyEl ? linksIn(bodyEl) : [];
        return {
          senderName: h.senderName,
          senderAddress: h.senderAddress,
          body,
          links,
          container: bodyEl ?? h.container,
        };
      });
    }
    if (doc.querySelector('iframe#early-child')) return [];
    const sb = extractICloudSandbox(doc);
    if (sb.active && sb.container) {
      return [{ senderName: '', senderAddress: '', body: sb.body, links: sb.links, container: sb.container }];
    }
    return [];
  },
  extract(doc) {
    const all = icloud.extractAll!(doc);
    return all[all.length - 1] ?? null;
  },
};
