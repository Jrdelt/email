// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { inlineAttachmentsIn, linksIn } from '../adapters/extract';
import { rawLinkTarget, useLinks } from '../dom';
import { lockAttachments, unlockAttachments } from './attachmentLock';
import { lockLinks, unlockLinks } from './linkLock';

const $ = (id: string) => document.getElementById(id)!;
const clickPrevented = (el: Element) => {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
};

describe('link lock hardening', () => {
  it('stashes live attributes even when the email pre-seeds data-ped-* copies, and restores the real values', () => {
    document.body.innerHTML = `<div id="m">
      <a id="a" href="https://evil.example/login" data-ped-href="https://decoy.example/">Sign in</a>
      <a id="p" href="https://x.example/" ping="https://track.example/b" data-ped-ping="1">p</a>
      <form id="f" action="https://evil.example/f" data-ped-action="x"></form></div>`;
    lockLinks($('m'));
    expect($('a').hasAttribute('href')).toBe(false);
    expect($('p').hasAttribute('ping')).toBe(false);
    expect($('f').hasAttribute('action')).toBe(false);
    expect(linksIn($('m')).map((l) => l.href)).toContain('https://evil.example/login');
    // The page edits its visible copy; unlocking still restores what was really there.
    $('a').setAttribute('data-ped-href', 'https://tampered.example/');
    unlockLinks($('m'));
    expect($('a').getAttribute('href')).toBe('https://evil.example/login');
    expect($('p').getAttribute('ping')).toBe('https://track.example/b');
    expect($('f').getAttribute('action')).toBe('https://evil.example/f');
  });

  it('re-stashes an href the webmail sets after the email was locked', async () => {
    document.body.innerHTML = '<div id="m"><a id="a">later</a></div>';
    lockLinks($('m'));
    $('a').setAttribute('href', 'https://evil.example/late');
    await vi.waitFor(() => expect($('a').hasAttribute('href')).toBe(false));
    expect($('a').getAttribute('data-ped-href')).toBe('https://evil.example/late');
    unlockLinks($('m'));
    expect($('a').getAttribute('href')).toBe('https://evil.example/late');
  });

  it('neutralises SVG SMIL href animations while locked and scores their targets', () => {
    document.body.innerHTML = `<div id="m"><svg><a id="svg-a"><set id="set" attributeName="href" to="https://evil.example/smil"/>
      <rect id="r" width="10" height="10"/></a>
      <a id="svg-b" href="https://shop.example/"><animate id="anim" attributeName="href" values="https://evil.example/anim;https://shop.example/" dur="1000s"/></a></svg></div>`;
    expect(linksIn($('m')).map((l) => l.href)).toEqual(
      expect.arrayContaining(['https://evil.example/smil', 'https://evil.example/anim']),
    );
    lockLinks($('m'));
    expect($('set').hasAttribute('attributeName')).toBe(false);
    expect($('anim').hasAttribute('attributeName')).toBe(false);
    expect(clickPrevented($('r'))).toBe(true); // SVG <a> with no href is still a locked target
    expect(linksIn($('m')).map((l) => l.href)).toEqual(expect.arrayContaining(['https://evil.example/smil']));
    unlockLinks($('m'));
    expect($('set').getAttribute('attributeName')).toBe('href');
    expect($('anim').getAttribute('attributeName')).toBe('href');
  });

  it("restores the webmail's own aria-disabled instead of stripping it", () => {
    document.body.innerHTML = `<div id="m"><a id="on" href="https://a.example/" aria-disabled="true">a</a>
      <a id="off" href="https://b.example/" aria-disabled="false">b</a><a id="none" href="https://c.example/">c</a></div>`;
    lockLinks($('m'));
    expect(['on', 'off', 'none'].map((id) => $(id).getAttribute('aria-disabled'))).toEqual(['true', 'true', 'true']);
    unlockLinks($('m'));
    expect(['on', 'off', 'none'].map((id) => $(id).getAttribute('aria-disabled'))).toEqual(['true', 'false', null]);
  });
});

describe('attachment lock hardening', () => {
  it('removes live download/href even when data-ped-att-* copies are pre-seeded, and restores them', () => {
    document.body.innerHTML = `<div id="att"><a id="d" download="inv.html" href="data:text/html,x"
      data-ped-att-href="1" data-ped-att-download="1">inv</a></div>`;
    lockAttachments([$('att')]);
    expect($('d').hasAttribute('href')).toBe(false);
    expect($('d').hasAttribute('download')).toBe(false);
    unlockAttachments([$('att')]);
    expect($('d').getAttribute('href')).toBe('data:text/html,x');
    expect($('d').getAttribute('download')).toBe('inv.html');
  });

  it('keeps an element stashed while an enclosing attachment root is still locked', () => {
    document.body.innerHTML = '<div id="shelf"><span id="chip"><a id="a" href="https://mail.example/att/1" download="x.exe">x</a></span></div>';
    lockAttachments([$('chip')]);
    lockAttachments([$('shelf')]);
    unlockAttachments([$('chip')]);
    expect($('a').hasAttribute('href')).toBe(false);
    unlockAttachments([$('shelf')]);
    expect($('a').getAttribute('href')).toBe('https://mail.example/att/1');
    expect($('a').getAttribute('download')).toBe('x.exe');
  });

  it('stashes SVG xlink:href downloads', () => {
    document.body.innerHTML = '<div id="att"><svg><a id="s" xlink:href="data:text/html,x"><text>x</text></a></svg></div>';
    lockAttachments([$('att')]);
    expect($('s').getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? $('s').getAttribute('xlink:href')).toBeNull();
    unlockAttachments([$('att')]);
    expect($('s').getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? $('s').getAttribute('xlink:href')).toBe(
      'data:text/html,x',
    );
  });
});

describe('lock gaps found in review', () => {
  const XLINK = 'http://www.w3.org/1999/xlink';

  it('re-stashes a namespaced xlink:href set after locking (attributeFilter never reports namespaced attributes)', async () => {
    document.body.innerHTML = `<div id="m"><svg><a id="s"><text>x</text></a></svg></div>`;
    lockLinks($('m'));
    $('s').setAttributeNS(XLINK, 'xlink:href', 'https://evil.example/');
    await new Promise((r) => setTimeout(r, 0));
    expect($('s').getAttributeNS(XLINK, 'href')).toBeNull();
    unlockLinks($('m'));
    expect($('s').getAttributeNS(XLINK, 'href')).toBe('https://evil.example/');
  });

  it('blocks a click on an SVG <use> instance of a link inside a locked email', () => {
    document.body.innerHTML = `<div id="m"><svg><defs><a id="L" href="https://evil.example/"><rect/></a></defs>
      <use id="u" href="#L"/></svg></div><svg><use id="icon" href="#sprite"/><symbol id="sprite"><path/></symbol></svg>`;
    expect(useLinks($('u')).links.map((e) => e.id)).toEqual(['L']);
    expect(useLinks($('icon'))).toEqual({ links: [], truncated: false }); // webmail icon sprites are not links
    lockLinks($('m'));
    expect(clickPrevented($('u'))).toBe(true);
    unlockLinks($('m'));
    expect(clickPrevented($('u'))).toBe(false);
  });

  it('follows <use> chains without looping', () => {
    document.body.innerHTML = `<svg><g id="g1"><use id="u2" href="#g2"/></g><g id="g2"><use href="#g1"/><a id="a" href="https://x.example/"><rect/></a></g>
      <use id="u1" href="#g1"/></svg>`;
    expect(useLinks($('u1'))).toMatchObject({ truncated: false }); // a cycle renders nothing: not a cap
    expect(useLinks($('u1')).links.map((e) => e.id)).toEqual(['a']);
  });

  // The browser renders every link behind a <use>, however many or deeply nested. Past useLinks' own bounds the
  // clicked link cannot be identified, so the result says so (callers fail closed) instead of silently stopping.
  const EVIL = 'https://files.example/invoice.exe';
  const nested = (levels: number) =>
    `<svg><defs><a id="l0" href="${EVIL}"><rect/></a>` +
    Array.from({ length: levels - 1 }, (_, i) => `<g id="g${i + 1}"><use href="#${i ? `g${i}` : 'l0'}"/></g>`).join('') +
    `</defs><use id="t" href="#${levels > 1 ? `g${levels - 1}` : 'l0'}"/></svg>`;

  it('reports truncation when a <use> renders more links than it follows', () => {
    const filler = '<a href="https://shop.example/p"><rect/></a>'.repeat(20);
    document.body.innerHTML = `<svg><defs><g id="grp">${filler}<a id="x" href="${EVIL}"><rect/></a></g></defs><use id="t" href="#grp"/></svg>`;
    const r = useLinks($('t'));
    expect(r.truncated).toBe(true);
    expect(r.links.some((l) => l.id === 'x')).toBe(false);
  });

  it('reports truncation for a link behind more nested <use> levels than it follows', () => {
    document.body.innerHTML = nested(5);
    expect(useLinks($('t'))).toEqual({ links: [], truncated: true });
  });

  it('blocks a click on a <use> past the bounds inside a locked email', () => {
    document.body.innerHTML = `<div id="m">${nested(5)}</div>`;
    lockLinks($('m'));
    expect(clickPrevented($('t'))).toBe(true);
    unlockLinks($('m'));
    expect(clickPrevented($('t'))).toBe(false);
  });

  it('follows four nested <use> levels in full', () => {
    document.body.innerHTML = nested(4);
    const r = useLinks($('t'));
    expect(r.truncated).toBe(false);
    expect(r.links.map((e) => e.id)).toEqual(['l0']);
  });

  it('does not report truncation when the depth bound lands on a link-free icon sprite', () => {
    // Five nested <use>: the fifth references a symbol with no link or <use> in it, so nothing is unknown.
    document.body.innerHTML = `<svg><defs><symbol id="s0"><path/></symbol>${Array.from(
      { length: 4 },
      (_, i) => `<g id="s${i + 1}"><use href="#s${i}"/></g>`,
    ).join('')}</defs><use id="t" href="#s4"/></svg>`;
    expect(useLinks($('t'))).toEqual({ links: [], truncated: false });
  });

  it('reads an SVG link target from its SMIL-animated value before the #fragment href', () => {
    document.body.innerHTML = `<svg><a id="s" href="#top"><text>x</text></a></svg><a id="h" href="#top">t</a>`;
    expect(rawLinkTarget($('h'))).toBe('#top');
    Object.defineProperty($('s'), 'href', { value: { animVal: 'https://evil.example/' } });
    expect(rawLinkTarget($('s'))).toBe('https://evil.example/');
  });

  it('stashes SMIL href animations inside locked attachments and keeps them detected as downloads', () => {
    document.body.innerHTML = `<div id="m"><svg><a id="d"><set id="s" attributeName="href" to="data:text/html;base64,PHA+"/><text>f</text></a></svg></div>`;
    const found = inlineAttachmentsIn($('m'));
    expect(found.map((a) => a.element.id)).toEqual(['d']);
    lockAttachments([$('d')]);
    expect($('s').hasAttribute('attributeName')).toBe(false);
    expect(inlineAttachmentsIn($('m')).map((a) => a.element.id)).toEqual(['d']); // no lock/unlock flip-flop
    unlockAttachments([$('d')]);
    expect($('s').getAttribute('attributeName')).toBe('href');
  });

  it('locks the whole body for a download animation aimed at another element', () => {
    document.body.innerHTML = `<div id="m"><svg><a id="t"><text>f</text></a><set href="#t" attributeName="href" to="blob:https://x/1"/></svg></div>`;
    expect(inlineAttachmentsIn($('m')).map((a) => a.element.id)).toEqual(['m']);
  });

  it('re-installs its style when a rewritten document lost it (install is idempotent)', () => {
    document.body.innerHTML = '<div id="m"><a id="a" href="https://evil.example/">x</a></div>';
    lockLinks($('m'));
    document.getElementById('ped-lock-style')!.remove();
    unlockLinks($('m'));
    lockLinks($('m'));
    expect(document.querySelectorAll('#ped-lock-style').length).toBe(1);
    lockLinks($('m'));
    expect(document.querySelectorAll('#ped-lock-style').length).toBe(1);
    expect(clickPrevented($('a'))).toBe(true);
    unlockLinks($('m'));
  });

  it('forgets detached elements while a re-rendered container stays locked', async () => {
    document.body.innerHTML = '<div id="m"></div>';
    const m = $('m');
    lockLinks(m);
    for (let i = 0; i < 6; i++) {
      m.innerHTML = Array.from({ length: 100 }, (_, j) => `<a href="https://x.example/${i}/${j}">l</a>`).join('');
      await new Promise((r) => setTimeout(r, 0));
    }
    unlockLinks(m);
    // Only the current links are restored; earlier generations were pruned rather than held.
    expect(m.querySelectorAll('a[href]').length).toBe(100);
  });
});
