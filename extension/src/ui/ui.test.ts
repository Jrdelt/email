// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { gmail } from '../adapters/gmail';
import { inlineAttachmentsIn, linksIn } from '../adapters/extract';
import { analyzeAttachments } from '../attachments';
import { analyzeSender } from '../sender';
import { isAttachmentLocked, lockAttachments, setAttachmentBlockedHandler, unlockAttachments } from './attachmentLock';
import { decideBanner, deriveStatusSummary, removeBanner, showBanner } from './banner';
import { formatAge, formatITReport, renderITDetails, renderSimpleDetails } from './details';
import { createCloseIcon, createLockIcon, createLogoSvg, createStatusIcon } from './icons';
import { isLocked, lockLinks, setLinkBlockedHandler, unlockLinks } from './linkLock';

const actions = () => ({
  onUnlock: vi.fn(),
  onUndoUnlock: vi.fn(async () => {}),
  onTrustSender: vi.fn(async () => true),
  onReport: vi.fn(async () => {}),
  onDismiss: vi.fn(),
});

describe('linkLock', () => {
  it('stashes and restores href, blocks links only while locked, and leaves outside links alone', () => {
    document.body.innerHTML = '<div id="m"><a id="l" href="https://evil.example/a?x=1">x</a></div><a id="o" href="https://ok.example">o</a>';
    const m = document.getElementById('m')!;
    const l = document.getElementById('l')!;
    const click = (target: Node) => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    lockLinks(m);
    expect(isLocked(m)).toBe(true);
    expect(l.hasAttribute('href')).toBe(false);
    expect(l.getAttribute('data-ped-href')).toBe('https://evil.example/a?x=1');
    expect(l.getAttribute('aria-disabled')).toBe('true');
    expect(click(l)).toBe(true);
    expect(document.getElementById('ped-toast-host')).not.toBeNull();
    expect(click(l.firstChild!)).toBe(true); // Text node inside locked link
    expect(click(document.getElementById('o')!)).toBe(false);
    expect(linksIn(m)).toEqual([{ text: 'x', href: 'https://evil.example/a?x=1' }]);

    unlockLinks(m);
    expect(document.getElementById('ped-toast-host')).toBeNull();
    expect(isLocked(m)).toBe(false);
    expect(l.getAttribute('href')).toBe('https://evil.example/a?x=1');
    expect(l.hasAttribute('data-ped-href')).toBe(false);
    expect(l.hasAttribute('aria-disabled')).toBe(false);
    expect(click(l)).toBe(false);
  });

  it('blocks embedded image links, image maps, and form submissions while locked', () => {
    document.body.innerHTML = `
      <div id="m">
        <a id="img-link" href="https://evil.example/img"><img id="img" src="x.png" alt="banner"></a>
        <map name="m"><area id="area" shape="rect" coords="0,0,10,10" href="https://evil.example/area"></map>
        <form id="f" action="https://evil.example/steal"><button id="sub" type="submit">Go</button></form>
      </div>`;
    const m = document.getElementById('m')!;
    const f = document.getElementById('f')!;
    const area = document.getElementById('area')!;

    lockLinks(m);
    expect(area.hasAttribute('href')).toBe(false);
    expect(f.hasAttribute('action')).toBe(false);

    const imgClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('img')!.dispatchEvent(imgClick);
    expect(imgClick.defaultPrevented).toBe(true);

    const areaClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    area.dispatchEvent(areaClick);
    expect(areaClick.defaultPrevented).toBe(true);

    const subClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('sub')!.dispatchEvent(subClick);
    expect(subClick.defaultPrevented).toBe(true);

    const submit = new Event('submit', { bubbles: true, cancelable: true });
    f.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);

    unlockLinks(m);
    expect(area.getAttribute('href')).toBe('https://evil.example/area');
    expect(f.getAttribute('action')).toBe('https://evil.example/steal');
    const afterUnlock = new Event('submit', { bubbles: true, cancelable: true });
    f.dispatchEvent(afterUnlock);
    expect(afterUnlock.defaultPrevented).toBe(false);
  });

  it('stashes formaction, SVG xlink:href, ping, blocks Enter/Space keydown, and auto-locks dynamic nodes', async () => {
    document.body.innerHTML = `
      <div id="m">
        <form id="f"><button id="fa" formaction="https://evil.example/steal">Submit</button>
          <input id="fi" type="submit" formaction="https://evil.example/steal2" value="Go">
        </form>
        <svg viewBox="0 0 100 20"><a id="svg-a" xlink:href="https://evil.example/svg"><text id="svg-txt" x="0" y="15">Click</text></a></svg>
        <a id="ping-a" href="https://evil.example/p" ping="https://track.evil.example/beacon">Ping</a>
        <p id="plain" tabindex="0">Plain paragraph</p>
      </div>`;
    const m = document.getElementById('m')!;
    const fa = document.getElementById('fa')!;
    const fi = document.getElementById('fi')!;
    const svgA = document.getElementById('svg-a')!;
    const pingA = document.getElementById('ping-a')!;

    expect(linksIn(m).map((l) => l.href)).toEqual([
      'https://evil.example/steal',
      'https://evil.example/steal2',
      'https://evil.example/svg',
      'https://evil.example/p',
    ]);

    lockLinks(m);
    expect(fa.hasAttribute('formaction')).toBe(false);
    expect(fa.getAttribute('data-ped-formaction')).toBe('https://evil.example/steal');
    expect(fi.hasAttribute('formaction')).toBe(false);
    expect(fi.getAttribute('data-ped-formaction')).toBe('https://evil.example/steal2');
    expect(svgA.getAttribute('xlink:href')).toBeNull();
    expect(svgA.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBeNull();
    expect(svgA.getAttribute('data-ped-xlink-href')).toBe('https://evil.example/svg');
    expect(pingA.hasAttribute('ping')).toBe(false);
    expect(pingA.getAttribute('data-ped-ping')).toBe('https://track.evil.example/beacon');

    expect(linksIn(m).map((l) => l.href)).toEqual([
      'https://evil.example/steal',
      'https://evil.example/steal2',
      'https://evil.example/svg',
      'https://evil.example/p',
    ]);

    const enterLocked = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    pingA.dispatchEvent(enterLocked);
    expect(enterLocked.defaultPrevented).toBe(true);

    const spaceBtn = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    fa.dispatchEvent(spaceBtn);
    expect(spaceBtn.defaultPrevented).toBe(true);

    const enterPlain = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    document.getElementById('plain')!.dispatchEvent(enterPlain);
    expect(enterPlain.defaultPrevented).toBe(false);

    const dyn = document.createElement('a');
    dyn.id = 'dyn';
    dyn.href = 'https://evil.example/dynamic';
    dyn.textContent = 'Dynamic';
    m.appendChild(dyn);
    await vi.waitFor(() => expect(dyn.hasAttribute('href')).toBe(false));
    expect(dyn.getAttribute('data-ped-href')).toBe('https://evil.example/dynamic');

    unlockLinks(m);
    expect(fa.getAttribute('formaction')).toBe('https://evil.example/steal');
    expect(fi.getAttribute('formaction')).toBe('https://evil.example/steal2');
    expect(
      svgA.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? svgA.getAttribute('xlink:href'),
    ).toBe('https://evil.example/svg');
    expect(pingA.getAttribute('ping')).toBe('https://track.evil.example/beacon');
    expect(dyn.getAttribute('href')).toBe('https://evil.example/dynamic');
  });

  it('resists <form> DOM clobbering of getAttribute/hasAttribute/setAttribute/removeAttribute', () => {
    document.body.innerHTML = `
      <div id="m">
        <form id="clobbered" action="https://evil.example/form-steal">
          <input name="getAttribute">
          <input name="hasAttribute">
          <input name="setAttribute">
          <input name="removeAttribute">
          <button type="submit">Send</button>
        </form>
      </div>`;
    const m = document.getElementById('m')!;
    const form = document.getElementById('clobbered')!;
    expect(linksIn(m)).toEqual([{ text: '', href: 'https://evil.example/form-steal' }]);
    lockLinks(m);
    expect(Element.prototype.hasAttribute.call(form, 'action')).toBe(false);
    expect(Element.prototype.getAttribute.call(form, 'data-ped-action')).toBe('https://evil.example/form-steal');
    expect(linksIn(m)).toEqual([{ text: '', href: 'https://evil.example/form-steal' }]);
    unlockLinks(m);
    expect(Element.prototype.getAttribute.call(form, 'action')).toBe('https://evil.example/form-steal');
  });
});

describe('attachmentLock', () => {
  it('blocks clicks, mousedown, pointerdown, and Enter/Space on untrusted attachments, keeps body readable, and restores on unlock', async () => {
    document.body.innerHTML = `
      <div id="body">Email text <a id="inline" download="smuggle.html" href="data:text/html,hi">Download</a></div>
      <div id="shelf" class="aQH">
        <span id="chip" class="aZo" download_url="text/html:invoice.pdf.html:https://mail.google.com/att/1">
          <a id="chip-a" href="https://mail.google.com/att/1" download="invoice.pdf.html">invoice.pdf.html</a>
        </span>
      </div>`;
    const body = document.getElementById('body')!;
    const inline = document.getElementById('inline')!;
    const shelf = document.getElementById('shelf')!;
    const chip = document.getElementById('chip')!;
    const chipA = document.getElementById('chip-a')!;
    const onBlocked = vi.fn();
    setAttachmentBlockedHandler(document, onBlocked);

    const names = new Map<HTMLElement, string>([
      [inline, 'smuggle.html'],
      [chip, 'invoice.pdf.html'],
    ]);
    lockAttachments([shelf, chip, inline], names);

    expect(isAttachmentLocked(shelf)).toBe(true);
    expect(isAttachmentLocked(chip)).toBe(true);
    expect(isAttachmentLocked(inline)).toBe(true);
    expect(isAttachmentLocked(body)).toBe(false);
    expect(inline.hasAttribute('href')).toBe(false);
    expect(inline.hasAttribute('download')).toBe(false);
    expect(inline.getAttribute('data-ped-att-href')).toBe('data:text/html,hi');
    expect(chip.hasAttribute('download_url')).toBe(false);
    expect(chip.getAttribute('data-ped-att-download-url')).toBe('text/html:invoice.pdf.html:https://mail.google.com/att/1');
    expect(linksIn(body)).toEqual([{ text: 'Download', href: 'data:text/html,hi' }]);

    for (const type of ['mousedown', 'pointerdown', 'click', 'dblclick']) {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
      chipA.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    const enterEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    inline.dispatchEvent(enterEv);
    expect(enterEv.defaultPrevented).toBe(true);
    expect(onBlocked).toHaveBeenCalled();
    expect(document.getElementById('ped-toast-host')).not.toBeNull();

    const dynBtn = document.createElement('a');
    dynBtn.href = 'https://mail.google.com/att/2';
    dynBtn.setAttribute('download', 'extra.exe');
    shelf.appendChild(dynBtn);
    await vi.waitFor(() => expect(dynBtn.hasAttribute('href')).toBe(false));
    expect(dynBtn.getAttribute('data-ped-att-download')).toBe('extra.exe');

    unlockAttachments([shelf, chip, inline]);
    setAttachmentBlockedHandler(document, null);
    expect(isAttachmentLocked(shelf)).toBe(false);
    expect(inline.getAttribute('href')).toBe('data:text/html,hi');
    expect(inline.getAttribute('download')).toBe('smuggle.html');
    expect(chip.getAttribute('download_url')).toBe('text/html:invoice.pdf.html:https://mail.google.com/att/1');
    expect(dynBtn.getAttribute('href')).toBe('https://mail.google.com/att/2');

    const postClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    chipA.dispatchEvent(postClick);
    expect(postClick.defaultPrevented).toBe(false);
  });

  it('invokes setLinkBlockedHandler when clicking a locked link', () => {
    document.body.innerHTML = '<div id="m"><a id="l" href="https://evil.example">Go</a></div>';
    const m = document.getElementById('m')!;
    const onLinkBlocked = vi.fn();
    setLinkBlockedHandler(document, onLinkBlocked);
    lockLinks(m);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('l')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onLinkBlocked).toHaveBeenCalledTimes(1);
    unlockLinks(m);
    setLinkBlockedHandler(document, null);
  });
});

describe('banner', () => {
  it('renders once and is removable', () => {
    document.body.innerHTML = '';
    const sender = analyzeSender('PayPal Support', 'help@gmail.com', []);
    showBanner({ level: 'warning', title: 'Check this sender.', tag: 'SENDER WARNING', reasons: sender.warnings, linksLocked: false, sender, intel: 'loading' }, actions());
    showBanner({ level: 'warning', title: 'Check this sender.', tag: 'SENDER WARNING', reasons: ['<img src=x onerror=alert(1)>'], linksLocked: false, sender }, actions());
    expect(document.querySelectorAll('#ped-banner-host')).toHaveLength(1);
    expect(document.querySelector('img')).toBeNull();
    removeBanner();
    expect(document.getElementById('ped-banner-host')).toBeNull();
  });

  it('says reports are off instead of "saved" when IT policy disables local reports', async () => {
    document.body.innerHTML = '';
    const sender = analyzeSender('PayPal Support', 'help@gmail.com', []);
    const roots: ShadowRoot[] = [];
    const origAttach = HTMLElement.prototype.attachShadow;
    const spy = vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) {
      const r = origAttach.call(this, init);
      roots.push(r);
      return r;
    });
    try {
      for (const [result, label] of [[false, 'Reports turned off by IT'], [true, 'Reported (saved)']] as const) {
        const act = { ...actions(), onReport: vi.fn(async () => result) };
        showBanner({ level: 'warning', title: 'Check this sender.', reasons: sender.warnings, linksLocked: false, sender }, act);
        const root = roots[roots.length - 1]!;
        const btn = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Not phishing')!;
        btn.click();
        await vi.waitFor(() => expect(btn.textContent).toBe(label));
      }
    } finally {
      spy.mockRestore();
      removeBanner();
    }
  });

  it('calls onTrustSender without calling onUnlock, collapses warning unlock to Undo pill, and requires 2-step confirmation for danger', async () => {
    document.body.innerHTML = '';
    const sender = analyzeSender('PayPal Support', 'help@gmail.com', [{ text: 'Verify', href: 'https://evil.example/login' }]);
    const roots: ShadowRoot[] = [];
    const origAttach = HTMLElement.prototype.attachShadow;
    const spy = vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) {
      const r = origAttach.call(this, init);
      roots.push(r);
      return r;
    });
    try {
      const act1 = actions();
      showBanner({ level: 'warning', title: 'Check this sender.', tag: 'SENDER WARNING', reasons: sender.warnings, linksLocked: true, sender }, act1);
      const root1 = roots[roots.length - 1]!;
      expect(root1.querySelector('.compare')?.textContent).toContain('From: help@gmail.com');
      expect(root1.querySelector('.compare')?.textContent).toContain('Links go to: evil.example');
      const trustSenderBtn = [...root1.querySelectorAll('button')].find((b) => b.textContent === 'Always trust sender')!;
      trustSenderBtn.click();
      await vi.waitFor(() => expect(act1.onTrustSender).toHaveBeenCalledTimes(1));
      expect(act1.onUnlock).not.toHaveBeenCalled();
      expect(document.getElementById('ped-banner-host')).toBeNull();

      const act2 = actions();
      showBanner({ level: 'warning', title: 'Check this sender.', tag: 'SENDER WARNING', reasons: sender.warnings, linksLocked: true, sender }, act2);
      const root2 = roots[roots.length - 1]!;
      const trustEmailBtn = [...root2.querySelectorAll('button')].find((b) => b.textContent === 'I trust this email')!;
      trustEmailBtn.click();
      await vi.waitFor(() => expect(root2.textContent).toContain('Email trusted — links enabled'));
      expect(act2.onUnlock).toHaveBeenCalledTimes(1);
      const undoBtn = [...root2.querySelectorAll('button')].find((b) => b.textContent === 'Undo')!;
      undoBtn.click();
      await vi.waitFor(() => expect(act2.onUndoUnlock).toHaveBeenCalledTimes(1));

      const act3 = actions();
      showBanner({ level: 'danger', title: 'Possible phishing.', tag: 'PHISHING WARNING', reasons: ['A link says paypal.com'], linksLocked: true, sender }, act3);
      const root3 = roots[roots.length - 1]!;
      const dangerTrigger = [...root3.querySelectorAll('button')].find((b) => b.textContent === 'I trust this email')!;
      dangerTrigger.click();
      expect(act3.onUnlock).not.toHaveBeenCalled();
      const confirmBar = root3.querySelector('.confirm-bar') as HTMLElement;
      expect(confirmBar.hidden).toBe(false);

      const keepSafeBtn = [...root3.querySelectorAll('button')].find((b) => b.textContent === 'Keep links paused')!;
      keepSafeBtn.click();
      expect(confirmBar.hidden).toBe(true);
      expect(act3.onUnlock).not.toHaveBeenCalled();

      dangerTrigger.click();
      const confirmUnlockBtn = [...root3.querySelectorAll('button')].find((b) => b.textContent === 'Yes, unlock links anyway')!;
      confirmUnlockBtn.click();
      await vi.waitFor(() => expect(act3.onUnlock).toHaveBeenCalledTimes(1));
      expect(root3.textContent).toContain('Email trusted — links enabled');

      const act4 = actions();
      showBanner({
        level: 'warning',
        title: 'Attachments blocked.',
        tag: 'ATTACHMENT LOCK',
        reasons: ['Attachments from untrusted emails are blocked (statement.pdf)'],
        linksLocked: false,
        attachmentsLocked: true,
        attachmentNames: ['statement.pdf'],
        sender,
      }, act4);
      const root4 = roots[roots.length - 1]!;
      expect(root4.querySelector('.compare')?.textContent).toContain('Attachments: statement.pdf');
      expect(root4.querySelector('.sticker-side')?.textContent).toContain('FILES BLOCKED!');
      const trustAttBtn = [...root4.querySelectorAll('button')].find((b) => b.textContent === 'I trust this email')!;
      trustAttBtn.click();
      await vi.waitFor(() => expect(act4.onUnlock).toHaveBeenCalledTimes(1));
      expect(root4.textContent).toContain('Email trusted — attachments enabled');
    } finally {
      spy.mockRestore();
      removeBanner();
    }
  });

  it('isolates host styles with all:initial and mounts on documentElement instead of body', () => {
    document.body.innerHTML = '';
    removeBanner();
    const sender = analyzeSender('PayPal Support', 'help@gmail.com', []);
    let capturedRoot: ShadowRoot | undefined;
    const origAttach = HTMLElement.prototype.attachShadow;
    const spy = vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) {
      capturedRoot = origAttach.call(this, init);
      return capturedRoot;
    });
    try {
      showBanner({ level: 'warning', title: 'Check this sender.', tag: 'SENDER WARNING', reasons: sender.warnings, linksLocked: true, sender }, actions());
      const host = document.getElementById('ped-banner-host')!;
      expect(host.parentElement).toBe(document.documentElement);
      expect(document.body.querySelector('#ped-banner-host')).toBeNull();
      expect(capturedRoot!.querySelector('style')!.textContent).toContain('all:initial!important');
    } finally {
      spy.mockRestore();
      removeBanner();
    }
  });

  it('disables Always trust sender when sender failed authentication or used a suspicious relay', () => {
    document.body.innerHTML = '';
    const unauthSender = analyzeSender('Bank', 'alerts@bank.com', [], { unauthenticated: true });
    let capturedRoot: ShadowRoot | undefined;
    const origAttach = HTMLElement.prototype.attachShadow;
    const spy = vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) {
      capturedRoot = origAttach.call(this, init);
      return capturedRoot;
    });
    try {
      const act = actions();
      showBanner(
        {
          level: 'warning',
          title: 'Check this sender.',
          tag: 'SENDER WARNING',
          reasons: unauthSender.warnings,
          linksLocked: true,
          sender: unauthSender,
        },
        act,
      );
      const trustBtn = [...capturedRoot!.querySelectorAll('button')].find(
        (b) => b.textContent === 'Always trust sender',
      )!;
      expect(trustBtn.disabled).toBe(true);
      trustBtn.click();
      expect(act.onTrustSender).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      removeBanner();
    }
  });
});

describe('deriveStatusSummary', () => {
  it('returns TRUSTED safe summary when trusted is true', () => {
    const sender = analyzeSender('PayPal', 'help@gmail.com', []);
    const s = deriveStatusSummary(
      { score: 0.9, level: 'likely-phishing', reasons: ['bad'] },
      sender,
      undefined,
      undefined,
      true,
    );
    expect(s).toMatchObject({ kind: 'safe', title: 'Email trusted.', tag: 'TRUSTED', reasons: [] });
  });
});

describe('decideBanner', () => {
  const cleanIntel = {
    domain: 'mongodb.com', checkedAt: '2026-11-22T00:00:00Z',
    rdap: { status: 'ok' as const, registered: '2008-07-08T00:00:00Z' },
    dns: { status: 'ok' as const, mx: ['aspmx.l.google.com'] },
    reputation: { status: 'ok' as const, source: 'URIBL' as const, listed: [] },
  };

  it('returns null for safe email with urgency wording and clean sender/intel', () => {
    const sender = analyzeSender('MongoDB Cloud', 'cloud-manager-support@mongodb.com', []);
    const banner = decideBanner({ score: 0.2, level: 'safe', reasons: ['Uses urgent wording about passwords or your account'] }, sender, cleanIntel, false);
    expect(banner).toBeNull();
  });

  it('shows warning banner and locks links when safe verdict has sender warning', () => {
    const sender = analyzeSender('PayPal Support', 'help@gmail.com', []);
    const locked = decideBanner({ score: 0.2, level: 'safe', reasons: ['Uses urgent wording about passwords or your account'] }, sender, undefined, false)!;
    expect(locked.level).toBe('warning');
    expect(locked.title).toBe('Check this sender.');
    expect(locked.tag).toBe('SENDER WARNING');
    expect(locked.linksLocked).toBe(true);
    expect(locked.reasons[0]).toMatch(/Claims to be PayPal/);
    expect(locked.reasons[1]).toBe('Uses urgent wording about passwords or your account');

    const unlocked = decideBanner({ score: 0.2, level: 'safe', reasons: ['Uses urgent wording about passwords or your account'] }, sender, undefined, true)!;
    expect(unlocked.linksLocked).toBe(false);
  });

  it('shows warning banner and locks links on async spam-listed domain intel', () => {
    const sender = analyzeSender('Someone', 'a@evil.example', []);
    const spamIntel = {
      domain: 'evil.example', checkedAt: '2026-11-22T00:00:00Z',
      rdap: { status: 'ok' as const, registered: '2015-01-01T00:00:00Z' },
      dns: { status: 'ok' as const, mx: ['mx.evil.example'] },
      reputation: { status: 'ok' as const, source: 'URIBL' as const, listed: ['black'] },
    };
    const banner = decideBanner({ score: 0, level: 'safe', reasons: [] }, sender, spamIntel, false)!;
    expect(banner.level).toBe('warning');
    expect(banner.tag).toBe('DOMAIN WARNING');
    expect(banner.linksLocked).toBe(true);
    expect(banner.reasons[0]).toMatch(/reported for spam online/);
  });

  it('shows danger banner and unlocks only when unlockedThisSession is true', () => {
    const sender = analyzeSender('Someone', 'a@evil.example', []);
    const verdict = { score: 0.6, level: 'likely-phishing' as const, reasons: ['A link says paypal.com but actually goes to evil.example'] };
    const locked = decideBanner(verdict, sender, undefined, false)!;
    expect(locked.level).toBe('danger');
    expect(locked.title).toBe('Possible phishing.');
    expect(locked.tag).toBe('PHISHING WARNING');
    expect(locked.linksLocked).toBe(true);
    const unlocked = decideBanner(verdict, sender, undefined, true)!;
    expect(unlocked.level).toBe('danger');
    expect(unlocked.linksLocked).toBe(false);
  });

  it('locks attachments on safe untrusted emails without locking regular links, and escalates danger attachments', () => {
    const sender = analyzeSender('Vendor', 'billing@vendor.com', [{ text: 'Docs', href: 'https://vendor.com/docs' }]);
    const benignAtt = analyzeAttachments(['statement.pdf']);
    const lockedBanner = decideBanner({ score: 0, level: 'safe', reasons: [] }, sender, cleanIntel, false, benignAtt)!;
    expect(lockedBanner.level).toBe('warning');
    expect(lockedBanner.title).toBe('Attachments blocked.');
    expect(lockedBanner.tag).toBe('ATTACHMENT LOCK');
    expect(lockedBanner.linksLocked).toBe(false);
    expect(lockedBanner.attachmentsLocked).toBe(true);
    expect(lockedBanner.attachmentNames).toEqual(['statement.pdf']);

    const dangerAtt = analyzeAttachments(['invoice.html']);
    const dangerBanner = decideBanner({ score: 0, level: 'safe', reasons: [] }, sender, cleanIntel, false, dangerAtt)!;
    expect(dangerBanner.level).toBe('danger');
    expect(dangerBanner.title).toBe('Dangerous attachment.');
    expect(dangerBanner.tag).toBe('ATTACHMENT WARNING');
    expect(dangerBanner.linksLocked).toBe(true);
    expect(dangerBanner.attachmentsLocked).toBe(true);
  });
});

describe('formatAge', () => {
  it.each([
    [undefined, ''],
    [0, 'created today'],
    [1, '1 day old'],
    [12, '12 days old'],
    [40, '40 days old'],
    [90, '3 months old'],
    [365, '1 year old'],
    [8585, '23 years old'],
  ])('%s -> %s', (days, expected) => expect(formatAge(days)).toBe(expected));
});

describe('details', () => {
  const sampleIntel = {
    domain: 'bank.com', checkedAt: new Date().toISOString(),
    rdap: { status: 'ok' as const, registered: '2001-01-01T00:00:00Z', registrar: 'Example Registrar', expires: '2030-01-01T00:00:00Z' },
    dns: { status: 'ok' as const, mx: ['mx.bank.com'], spf: 'v=spf1 -all', dmarcPolicy: 'reject' },
    reputation: { status: 'ok' as const, source: 'URIBL' as const, listed: [] },
  };

  it('renderSimpleDetails shows plain-English rows without technical jargon and escapes HTML', () => {
    const sender = analyzeSender('Bank <script>', 'alerts@mail.bank.com', []);
    const dl = renderSimpleDetails(document, sender, sampleIntel);
    const text = dl.textContent!;
    expect(text).toContain('Sent by');
    expect(text).toContain('Bank <script> (alerts@mail.bank.com)');
    expect(text).toContain('Website');
    expect(text).toContain('bank.com — ');
    expect(text).toContain('Spam check');
    expect(text).toContain('No spam reports found');
    expect(text).toContain('Links go to');
    expect(text).not.toMatch(/\b(MX|SPF|DMARC|URIBL|Registrar)\b/);
    expect(dl.querySelector('script')).toBeNull();
  });

  it('renderITDetails puts technical diagnostics inside a collapsed More options for IT section', () => {
    const sender = analyzeSender('Bank', 'alerts@mail.bank.com', []);
    const verdict = { score: 0.4, level: 'suspicious' as const, reasons: ['r1'] };
    const details = renderITDetails(document, sender, sampleIntel, verdict, ['r1']);
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('More options for IT');
    const text = details.textContent!;
    expect(text).toContain('suspicious (score 0.40)');
    expect(text).toContain('Example Registrar');
    expect(text).toContain('mx.bank.com');
    expect(text).toContain('policy reject');
    expect(text).toContain('not listed');
    expect(details.querySelector('button.copy-it')?.textContent).toBe('Copy details for IT');
  });

  it('formatITReport includes technical fields and excludes email body', () => {
    const sender = analyzeSender('Bank', 'alerts@mail.bank.com', []);
    const report = formatITReport(sender, sampleIntel, { score: 0.4, level: 'suspicious', reasons: ['sig1'] }, ['sig1']);
    expect(report).toContain('Verdict: suspicious (score 0.40)');
    expect(report).toContain('Registrar: Example Registrar');
    expect(report).toContain('Mail servers (MX): mx.bank.com');
    expect(report).toContain('DMARC: policy reject');
    expect(report).toContain('- sig1');
  });

  // An RLO at the end of a display name reverses everything after it in the row, including the real address the
  // extension appends: "PayPal ‮(moc.lapyap@ecivres) (security@…)" rendered as "PayPal (service@paypal.com) …".
  const REORDER = /[‪-‮⁦-⁩]/;
  it('neutralises bidi controls in the Sent by / From / Domain rows and the IT report', () => {
    const s = analyzeSender('PayPal ‮(moc.lapyap@ecivres)', 'security@paypa1-alerts.com', []);
    const sentBy = renderSimpleDetails(document, s, 'unavailable').querySelector('dd')!.textContent!;
    expect(sentBy).not.toMatch(REORDER);
    expect(sentBy).toContain('(security@paypa1-alerts.com)');
    const it = renderITDetails(document, s, 'unavailable');
    expect(it.querySelector('dd')!.textContent).not.toMatch(REORDER);
    expect(it.textContent).not.toMatch(REORDER);
    expect(formatITReport(s, 'unavailable')).not.toMatch(REORDER);
    expect(formatITReport(s, 'unavailable')).toContain('<security@paypa1-alerts.com>');
    for (const bad of [
      analyzeSender('Bob', 'bob@‮moc.lapyap', []),
      analyzeSender('Bob', 'bob⁧@paypal.com', []),
    ]) {
      expect(renderSimpleDetails(document, bad, undefined).textContent).not.toMatch(REORDER);
      expect(renderITDetails(document, bad, undefined).textContent).not.toMatch(REORDER);
      expect(formatITReport(bad, undefined)).not.toMatch(REORDER);
    }
  });

  it('keeps a long display name from pushing the real address out of the Sent by row', () => {
    const s = analyzeSender(`PayPal Security ${'x'.repeat(500)}`, 'security@paypa1-alerts.com', []);
    const sentBy = renderSimpleDetails(document, s, 'unavailable').querySelector('dd')!.textContent!;
    expect(sentBy.length).toBeLessThan(300);
    expect(sentBy).toContain('(security@paypa1-alerts.com)');
  });
});

describe('gmail adapter', () => {
  it('extracts sender, body and links from fixture HTML', () => {
    document.body.innerHTML = `<div class="adn"><span class="gD" email="Help@Gmail.com" name="PayPal Support">PayPal Support</span>
      <div class="a3s">Your account is locked. <a href="https://evil.example/login">www.paypal.com</a></div></div>`;
    const e = gmail.extract(document)!;
    expect(e.senderName).toBe('PayPal Support');
    expect(e.senderAddress).toBe('Help@Gmail.com');
    expect(e.body).toContain('account is locked');
    expect(e.links).toEqual([{ text: 'www.paypal.com', href: 'https://evil.example/login' }]);
  });
  it('extracts all expanded messages in a multi-message thread top to bottom', () => {
    document.body.innerHTML = `
      <div class="adn">
        <span class="gD" email="top@evil.example" name="Top Sender">Top Sender</span>
        <div class="a3s" id="top">Top message <a href="https://evil.example/1">Link 1</a></div>
      </div>
      <div class="adn">
        <span class="gD" email="bottom@bank.com" name="Bottom Sender">Bottom Sender</span>
        <div class="a3s" id="bottom">Bottom message <a href="https://bank.com/2">Link 2</a></div>
      </div>`;
    const all = gmail.extractAll!(document);
    expect(all).toHaveLength(2);
    expect(all[0].senderAddress).toBe('top@evil.example');
    expect(all[0].container.id).toBe('top');
    expect(all[0].links).toEqual([{ text: 'Link 1', href: 'https://evil.example/1' }]);
    expect(all[1].senderAddress).toBe('bottom@bank.com');
    expect(all[1].container.id).toBe('bottom');
    expect(all[1].links).toEqual([{ text: 'Link 2', href: 'https://bank.com/2' }]);
  });
  it('extracts sender from Gmail Spam/via headers without email attribute and prepends h2.hP subject', () => {
    document.body.innerHTML = `
      <h2 class="hP">We've Blocked Your Account! Your photos and videos will be deleted</h2>
      <div class="adn ads">
        <div class="gs">
          <div class="gE iv gt">
            <h3 class="iw gFxsud">
              <span class="qu yKyxu">
                <span class="gD"><span>GmailSupportTeam</span></span>
                <span class="go gD">alert-442-320397@nozfr.itl</span>
                <span class="go">via 442.320397.jnc7.one.bss0019.narodaro.my.id</span>
              </span>
            </h3>
          </div>
          <div><div class="ii gt"><div class="a3s">
            Please update your billing details.
            <a href="https://storage.googleapis.com/hmdbox/hmd_v2.html#?act=cl">Review billing</a>
          </div></div></div>
        </div>
      </div>`;
    const e = gmail.extract(document)!;
    expect(e.senderName).toBe('GmailSupportTeam');
    expect(e.senderAddress).toBe('alert-442-320397@nozfr.itl');
    expect(e.viaDomain).toBe('442.320397.jnc7.one.bss0019.narodaro.my.id');
    expect(e.body).toContain("We've Blocked Your Account!");
    expect(e.body).toContain('Please update your billing details.');
    expect(e.links).toEqual([{ text: 'Review billing', href: 'https://storage.googleapis.com/hmdbox/hmd_v2.html#?act=cl' }]);
  });

  it('extracts a.acP viaDomain, unauthenticated warning badge, and ignores spoofed header markup inside div.a3s', () => {
    document.body.innerHTML = `
      <div class="adn ads">
        <div class="gE iv gt">
          <h3 class="iw gFxsud">
            <span class="gD" email="alerts@bank.com" name="Bank">Bank</span>
            <span class="go"><a class="acP" href="https://support.google.com/mail/answer/1311182?hl=en">via</a></span>
            <span class="go"> 12.relay.evil.example </span>
          </h3>
          <img alt="Gmail couldn't verify that bank.com actually sent this message" src="x.png">
        </div>
        <div class="a3s">
          <span class="gD" email="spoofed@body.example" name="Fake">Fake</span>
          <span class="go">via ignored.body.example</span>
          Hello <a href="https://evil.example/x">Click</a>
        </div>
      </div>`;
    const e = gmail.extract(document)!;
    expect(e.senderName).toBe('Bank');
    expect(e.senderAddress).toBe('alerts@bank.com');
    expect(e.viaDomain).toBe('12.relay.evil.example');
    expect(e.unauthenticated).toBe(true);
  });

  it('returns null with no open email', () => {
    document.body.innerHTML = '<div>inbox</div>';
    expect(gmail.extract(document)).toBeNull();
  });

  it('extracts Gmail attachment shelves, chips, bulk actions, and inline download links while ignoring compose', () => {
    document.body.innerHTML = `
      <div class="M9"><span class="aZo" download_url="text/plain:draft.txt:https://mail.google.com/draft">draft.txt</span></div>
      <div class="adn">
        <span class="gD" email="news@vendor.com" name="Vendor">Vendor</span>
        <div class="a3s" id="msg-body">Hello <a id="inline-dl" download="notice.html" href="blob:https://mail.google.com/1">Get file</a></div>
        <div class="aQH" id="shelf">
          <span class="aZo" id="chip1" download_url="application/pdf:statement.pdf:https://mail.google.com/att/1">
            <span class="aV3">statement.pdf</span>
          </span>
          <a aria-label="Download all attachments" id="dl-all" href="#all">Download all</a>
        </div>
      </div>`;
    const e = gmail.extract(document)!;
    expect(e.attachments?.map((a) => a.name)).toEqual(['notice.html', 'statement.pdf']);
    expect(e.attachments?.map((a) => a.element.id)).toEqual(['inline-dl', 'chip1']);
    expect(e.attachmentContainers?.map((el) => el.id)).toEqual(['shelf']);
    expect(inlineAttachmentsIn(document.getElementById('msg-body')!).map((a) => a.name)).toEqual(['notice.html']);
  });
});

describe('icons', () => {
  it('renders logo and semantic status SVGs cleanly via createElementNS', () => {
    const logo = createLogoSvg(document, 28);
    expect(logo.tagName.toLowerCase()).toBe('svg');
    expect(logo.getAttribute('aria-hidden')).toBe('true');
    expect(logo.getAttribute('width')).toBe('28');
    expect(logo.querySelectorAll('path, rect, circle').length).toBeGreaterThanOrEqual(4);

    for (const kind of ['safe', 'warning', 'danger'] as const) {
      const icon = createStatusIcon(document, kind, 20);
      expect(icon.tagName.toLowerCase()).toBe('svg');
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.children.length).toBeGreaterThanOrEqual(2);
    }

    expect(createLockIcon(document).getAttribute('aria-hidden')).toBe('true');
    expect(createCloseIcon(document).getAttribute('aria-hidden')).toBe('true');
  });
});

describe('unchecked (fail-closed) verdicts', () => {
  it('pause links with a neutral notice instead of a phishing alert', () => {
    const sender = analyzeSender('Friend', 'friend@example.org', []);
    const v = { score: 0.3, level: 'suspicious' as const, unchecked: true, reasons: ['too many links to check'] };
    const s = deriveStatusSummary(v, sender, undefined, undefined, false);
    expect(s.kind).toBe('warning');
    expect(s.title).toBe('Not fully checked.');
    expect(s.tag).toBe('CHECK LIMIT');
    expect(decideBanner(v, sender, undefined, false)?.linksLocked).toBe(true);
  });
});
