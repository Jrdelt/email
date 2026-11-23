import { cleanAttachmentName } from '../attachments';
import { isValidDomain } from '../domain';
import { MAX_ATTACHMENTS, MAX_BODY_CHARS, bodyText, inlineAttachmentsIn, isHidden, linksIn } from './extract';
import type { AttachmentRef, ExtractedEmail, WebmailAdapter } from './types';

const extractEmailText = (raw: string): string =>
  raw.match(/([^\s<>"'(),;]+@[^\s<>"'(),;]+\.[^\s<>"'(),;]+)/)?.[1]?.trim() ?? '';

const cleanHost = (raw: string): string =>
  raw.trim().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').toLowerCase();

function extractViaDomain(scope: Document | HTMLElement, container: HTMLElement): string | undefined {
  for (const anchor of scope.querySelectorAll<HTMLElement>('a.acP, a[href*="support.google.com/mail/answer/1311182"]')) {
    if (container.contains(anchor)) continue;
    const sib = cleanHost(anchor.parentElement?.nextElementSibling?.textContent ?? '');
    if (sib && isValidDomain(sib)) return sib;
    const afterVia = (anchor.parentElement?.textContent ?? '').match(/\bvia\s+([^\s,;()]+)/i)?.[1] ?? '';
    const candidate = cleanHost(afterVia);
    if (candidate && isValidDomain(candidate)) return candidate;
  }
  for (const el of scope.querySelectorAll<HTMLElement>('span.go, h3.iw')) {
    if (container.contains(el)) continue;
    const m = (el.textContent ?? '').match(
      /\bvia\s+([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/i,
    );
    const candidate = cleanHost(m?.[1] ?? '');
    if (candidate && isValidDomain(candidate)) return candidate;
  }
  return undefined;
}

function isUnauthenticated(scope: Document | HTMLElement, container: HTMLElement): boolean {
  const unauthRe = /couldn['’]t verify|could not verify/i;
  for (const el of scope.querySelectorAll<HTMLElement>('[aria-label], [data-tooltip], [title], img[alt]')) {
    if (container.contains(el)) continue;
    const text = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('data-tooltip') ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('alt') ?? ''}`;
    if (unauthRe.test(text)) return true;
  }
  for (const el of scope.querySelectorAll<HTMLElement>('.gE')) {
    if (!container.contains(el) && /gmail couldn['’]t verify/i.test(el.textContent ?? '')) return true;
  }
  return false;
}

function nameFromDownloadUrl(raw: string): string {
  if (!raw) return '';
  const firstColon = raw.indexOf(':');
  if (firstColon === -1) return '';
  const urlStart = raw.search(/:https?:\/\//i);
  const encoded = urlStart > firstColon ? raw.slice(firstColon + 1, urlStart) : raw.slice(firstColon + 1).split(':')[0];
  try {
    return cleanAttachmentName(decodeURIComponent(encoded));
  } catch {
    return cleanAttachmentName(encoded);
  }
}

function isGmailBulkAction(el: Element): boolean {
  const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('data-tooltip') ?? ''} ${el.getAttribute('title') ?? ''}`;
  return /\b(?:download\s+all|save\s+all\s+to\s+drive|add\s+all\s+to\s+drive)\b/i.test(label);
}

function gmailChipName(chip: HTMLElement): string {
  const dlUrl = chip.getAttribute('download_url') ?? chip.getAttribute('data-ped-att-download-url') ?? '';
  const fromUrl = nameFromDownloadUrl(dlUrl);
  if (fromUrl) return fromUrl;

  const v3 = cleanAttachmentName(chip.querySelector('.aV3')?.textContent ?? '');
  if (v3) return v3;

  const dl = cleanAttachmentName(chip.getAttribute('download') ?? chip.getAttribute('data-ped-att-download') ?? '');
  if (dl) return dl;

  for (const attr of ['aria-label', 'title', 'data-tooltip'] as const) {
    const candidate = cleanAttachmentName(chip.getAttribute(attr) ?? '');
    if (candidate) return candidate;
  }

  const text = (chip.textContent ?? '').trim();
  return text.length <= 180 ? cleanAttachmentName(text) : '';
}

function extractGmailAttachments(
  scope: Document | HTMLElement | null,
  container: HTMLElement,
): { attachments: AttachmentRef[]; attachmentContainers: HTMLElement[] } {
  const attachments: AttachmentRef[] = [...inlineAttachmentsIn(container)];
  const shelves: HTMLElement[] = [];
  const attachmentContainers: HTMLElement[] = [];

  if (!scope) return { attachments, attachmentContainers };

  const shouldSkip = (el: Element): boolean =>
    el === container ||
    el.contains(container) ||
    (el instanceof HTMLElement && isHidden(el)) ||
    el.closest('div.M9, [role="dialog"], [contenteditable="true"]') !== null;

  for (const shelf of scope.querySelectorAll<HTMLElement>('div.aQH, .hq')) {
    if (shouldSkip(shelf) || shelves.some((prev) => prev.contains(shelf))) continue;
    shelves.push(shelf);
    attachmentContainers.push(shelf);
  }

  const chipSel = [
    'span.aZo',
    '[download_url]',
    '[data-ped-att-download-url]',
    'a[download]',
    'a[data-ped-att-download]',
    'a[href*="mail-attachment.googleusercontent.com"]',
    'a[data-ped-att-href*="mail-attachment.googleusercontent.com"]',
    'a[href*="view=att"]',
    'a[data-ped-att-href*="view=att"]',
  ].join(', ');

  for (const chip of scope.querySelectorAll<HTMLElement>(chipSel)) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    if (shouldSkip(chip) || isGmailBulkAction(chip)) continue;
    if (attachments.some((prev) => prev.element === chip || prev.element.contains(chip))) continue;
    attachments.push({ name: gmailChipName(chip), element: chip });
  }

  const bulkSel =
    '[aria-label*="Download all" i], [data-tooltip*="Download all" i], [aria-label*="Save all to Drive" i], [data-tooltip*="Add all to Drive" i]';
  for (const btn of scope.querySelectorAll<HTMLElement>(bulkSel)) {
    if (shouldSkip(btn) || attachmentContainers.some((c) => c === btn || c.contains(btn))) continue;
    attachmentContainers.push(btn);
  }

  for (const shelf of shelves) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    if (!attachments.some((a) => shelf.contains(a.element) || a.element === shelf)) {
      attachments.push({ name: '', element: shelf });
    }
  }

  return { attachments, attachmentContainers };
}

// Best-effort Gmail selectors (T7: verify against saved fixtures and live Gmail).
// div.a3s = message body; span.gD[email] = standard sender chip; span.go.gD = Spam/via bare address; h2.hP = subject.
export const gmail: WebmailAdapter = {
  name: 'gmail',
  matches: (url) => url.hostname === 'mail.google.com',
  extractAll(doc): ExtractedEmail[] {
    const containers = [...doc.querySelectorAll<HTMLElement>('div.a3s')].filter(
      (el) => !isHidden(el) && el.parentElement?.closest('div.a3s') === null,
    );
    const subject = (doc.querySelector<HTMLElement>('h2.hP')?.textContent ?? '').trim();
    return containers.map((container) => {
      const msg = container.closest<HTMLElement>('.adn, [role="listitem"]');
      const scope = msg ?? (containers.length === 1 ? doc : null);
      const emailChip =
        msg?.querySelector<HTMLElement>('span.gD[email]') ??
        (containers.length === 1 ? [...doc.querySelectorAll<HTMLElement>('span.gD[email]')].pop() : undefined);

      let senderAddress = emailChip?.getAttribute('email')?.trim() ?? '';
      if (!senderAddress && scope) {
        for (const el of scope.querySelectorAll<HTMLElement>('span.go.gD, span.go, span.gD, h3.iw')) {
          if (container.contains(el)) continue;
          const found = extractEmailText(el.textContent ?? '');
          if (found) {
            senderAddress = found;
            break;
          }
        }
      }

      let senderName = emailChip?.getAttribute('name')?.trim() ?? '';
      if (!senderName && emailChip) {
        const t = (emailChip.textContent ?? '').trim();
        if (t && !t.includes('@')) senderName = t;
      }
      if (!senderName && scope) {
        for (const el of scope.querySelectorAll<HTMLElement>('span.gD')) {
          if (container.contains(el)) continue;
          const t = (el.textContent ?? '').trim();
          if (t && !t.includes('@')) {
            senderName = t;
            break;
          }
        }
      }

      const viaDomain = scope ? extractViaDomain(scope, container) : undefined;
      const unauthenticated = scope ? isUnauthenticated(scope, container) : false;
      const { attachments, attachmentContainers } = extractGmailAttachments(scope, container);
      const body = [subject, bodyText(container)].filter(Boolean).join('\n').slice(0, MAX_BODY_CHARS);
      return {
        senderName,
        senderAddress,
        ...(viaDomain ? { viaDomain } : {}),
        ...(unauthenticated ? { unauthenticated: true } : {}),
        body,
        links: linksIn(container),
        ...(attachments.length ? { attachments } : {}),
        ...(attachmentContainers.length ? { attachmentContainers } : {}),
        container,
      };
    });
  },
  extract(doc) {
    const all = gmail.extractAll!(doc);
    return all[all.length - 1] ?? null;
  },
};
