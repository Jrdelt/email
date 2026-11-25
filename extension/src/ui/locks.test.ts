// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { linksIn } from '../adapters/extract';
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
