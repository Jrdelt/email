// @vitest-environment happy-dom
// The banner and the toast live in hosts the extension appends to <html>, after <body>. Email markup inside <body>
// can carry the same ids, and comes first in document order: a lookup by id then finds the email's element, so
// each re-render deleted a decoy from the email instead of the previous banner, and banners piled up (X removed an
// older, hidden one). Only the extension's own hosts may be removed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeAttachments } from '../attachments';
import { analyzeSender } from '../sender';
import { decideBanner, removeBanner, showBanner } from './banner';
import { removePausedLinkToast, showPausedLinkToast } from './linkToast';

const actions = () => ({
  onUnlock: vi.fn(),
  onTrustSender: vi.fn(async () => true),
  onReport: vi.fn(async () => {}),
  onDismiss: vi.fn(),
});
const model = () => {
  const sender = analyzeSender('PayPal Support', 'help@gmail.com', []);
  return { level: 'warning' as const, title: 'Check this sender.', reasons: sender.warnings, linksLocked: true, sender };
};
const topLevel = (id: string) => [...document.documentElement.children].filter((c) => c.id === id);
const decoys = () => document.body.querySelectorAll('.decoy').length;

afterEach(() => {
  removeBanner();
  removePausedLinkToast();
  for (const el of [...topLevel('ped-banner-host'), ...topLevel('ped-toast-host')]) el.remove();
  document.body.innerHTML = '';
});

describe('banner host', () => {
  it('replaces only its own banner, never an email element with the same id', () => {
    document.body.innerHTML = '<div id="ped-banner-host" class="decoy">a</div>'.repeat(3);
    for (let i = 0; i < 3; i++) showBanner(model(), actions());
    expect(decoys()).toBe(3);
    expect(topLevel('ped-banner-host')).toHaveLength(1);
    removeBanner();
    expect(topLevel('ped-banner-host')).toHaveLength(0);
    expect(decoys()).toBe(3);
  });

  it('still removes a banner left by an earlier copy of the content script', () => {
    const stale = document.createElement('div');
    stale.id = 'ped-banner-host';
    document.documentElement.append(stale);
    showBanner(model(), actions());
    expect(stale.isConnected).toBe(false);
    expect(topLevel('ped-banner-host')).toHaveLength(1);
  });
});

describe('toast host', () => {
  it('never removes an email element with the toast id', () => {
    document.body.innerHTML = '<div id="ped-toast-host" class="decoy">a</div>';
    showPausedLinkToast(document, 'evil.example');
    expect(decoys()).toBe(1);
    expect(topLevel('ped-toast-host')).toHaveLength(1);
    removePausedLinkToast();
    expect(topLevel('ped-toast-host')).toHaveLength(0);
    removePausedLinkToast(); // nothing of ours left: the email's element stays
    expect(decoys()).toBe(1);
  });
});

describe('banner announcements', () => {
  // Every insertion of a role=alert element is announced in full, every button label included. The content script
  // renders a flagged email at least twice (sender lookup loading, then its result): a re-render that says the same
  // thing must not interrupt the user with the whole banner again.
  const roots: ShadowRoot[] = [];
  const attach = HTMLElement.prototype.attachShadow;
  const card = () => roots.at(-1)!.querySelector('.card')!;

  function capture() {
    roots.length = 0;
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) {
      const r = attach.call(this, init);
      roots.push(r);
      return r;
    });
  }
  afterEach(() => vi.restoreAllMocks());

  it('announces the first banner, and not again when a re-render says the same thing', () => {
    capture();
    showBanner({ ...model(), intel: 'loading' }, actions());
    expect(card().getAttribute('role')).toBe('alert');
    showBanner(model(), actions());
    expect(card().getAttribute('role')).not.toBe('alert');
    // Still reachable as a landmark, named by its title.
    expect(card().getAttribute('role')).toBe('region');
    const labelId = card().getAttribute('aria-labelledby')!;
    expect(roots.at(-1)!.getElementById(labelId)?.textContent).toBe('Check this sender.');
  });

  it('announces again when the level or title changes', () => {
    capture();
    showBanner(model(), actions());
    showBanner({ ...model(), level: 'danger', title: 'Possible phishing.' }, actions());
    expect(card().getAttribute('role')).toBe('alert');
  });

  it('announces again after the banner was removed (a new email, or a dismissed banner brought back)', () => {
    capture();
    showBanner(model(), actions());
    removeBanner();
    showBanner(model(), actions());
    expect(card().getAttribute('role')).toBe('alert');
  });
});

describe('banner wording follows what was found', () => {
  // A colleague's otherwise normal email with invoice.html attached: no link was flagged, but the banner said the
  // email's links "look dangerous" under a PHISHING ALERT sticker. A check-limit notice said SENDER CHECK although
  // the sender was not the issue.
  const roots: ShadowRoot[] = [];
  const attach = HTMLElement.prototype.attachShadow;
  afterEach(() => vi.restoreAllMocks());
  function render(m: Parameters<typeof showBanner>[0]) {
    vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) {
      const r = attach.call(this, init);
      roots.push(r);
      return r;
    });
    showBanner(m, actions());
    const root = roots.at(-1)!;
    return {
      sticker: root.querySelector('.sticker-top')!.textContent,
      confirm: root.querySelector('#ped-confirm .confirm-msg')?.textContent ?? '',
    };
  }
  const colleague = analyzeSender('Jordan Lee', 'jordan@northwind.example', []);
  const SAFE = { score: 0, level: 'safe' as const, reasons: [] };

  it('an attachment-only danger banner says so, not that links look dangerous', () => {
    const m = decideBanner(SAFE, colleague, undefined, false, analyzeAttachments(['invoice.html']))!;
    expect(m).toMatchObject({ level: 'danger', tag: 'ATTACHMENT WARNING', linksLocked: true, attachmentsLocked: true });
    const shown = render(m);
    expect(shown.sticker).toBe('ATTACHMENT ALERT');
    expect(shown.confirm).not.toMatch(/links .*look dangerous/i);
    expect(shown.confirm).toBe(
      'An attachment in this email uses a high-risk file type, so its links are paused too. Only unlock if you verified the sender.',
    );
  });

  it('a phishing banner keeps its wording', () => {
    const v = { score: 0.9, level: 'likely-phishing' as const, reasons: ['Asks you to verify your account'] };
    const shown = render(decideBanner(v, colleague, undefined, false)!);
    expect(shown.sticker).toBe('PHISHING ALERT');
    expect(shown.confirm).toBe('Links in this email look dangerous. Only unlock if you verified the sender.');
  });

  it('a check-limit notice is not labelled a sender check', () => {
    const v = { score: 0.3, level: 'suspicious' as const, unchecked: true, reasons: ['too many links to check'] };
    expect(render(decideBanner(v, colleague, undefined, false)!).sticker).toBe('CHECK LIMIT');
  });

  it('a sender warning is still a sender check, and an attachment notice an attachment check', () => {
    const lookalike = analyzeSender('PayPal Support', 'help@gmail.com', []);
    expect(render(decideBanner(SAFE, lookalike, undefined, false)!).sticker).toBe('SENDER CHECK');
    expect(render(decideBanner(SAFE, colleague, undefined, false, analyzeAttachments(['minutes.pdf']))!).sticker).toBe(
      'ATTACHMENT CHECK',
    );
  });
});
