// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { removeBanner, showBanner } from './banner';
import { isLocked, lockLinks, unlockLinks } from './linkLock';

describe('linkLock', () => {
  it('blocks clicks on links only while locked', () => {
    document.body.innerHTML = '<div id="m"><a id="l" href="https://evil.example">x</a></div><a id="o" href="https://ok.example">o</a>';
    const m = document.getElementById('m')!;
    const click = (id: string) => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true });
      document.getElementById(id)!.dispatchEvent(e);
      return e.defaultPrevented;
    };
    lockLinks(m);
    expect(isLocked(m)).toBe(true);
    expect(click('l')).toBe(true);
    expect(click('o')).toBe(false); // links outside the email are untouched
    unlockLinks(m);
    expect(click('l')).toBe(false);
  });
});

describe('banner', () => {
  it('renders once and can be removed', () => {
    const actions = { onUnlock: vi.fn(), onTrustSender: vi.fn(async () => true), onReport: vi.fn(async () => {}) };
    showBanner({ score: 0.7, level: 'likely-phishing', reasons: ['<img src=x onerror=alert(1)>'] }, false, actions);
    showBanner({ score: 0.7, level: 'likely-phishing', reasons: ['r'] }, false, actions);
    expect(document.querySelectorAll('#ped-banner-host')).toHaveLength(1);
    expect(document.querySelector('img')).toBeNull(); // email-derived text is never parsed as HTML
    removeBanner();
    expect(document.getElementById('ped-banner-host')).toBeNull();
  });
});
