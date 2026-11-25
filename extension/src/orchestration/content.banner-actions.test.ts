// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C22: the banner's own buttons, pressed as a user would (src/ui/banner.ts, closed shadow root captured by the
// harness). The email scores safe, but Gmail could not verify its sender, so its links and its inline download are
// paused behind a sender warning. "Always trust sender" is refused for such a sender (AGENTS.md: never auto-trust
// an unauthenticated sender), Dismiss hides the banner until a paused link is clicked, "I trust this email" opens
// links and download and remembers the email's SHA-256 fingerprint only, and Undo locks them again.
import { beforeAll, describe, expect, it } from 'vitest';
import { gmail } from '../adapters/gmail';
import { hashEmail } from '../allowlist';
import {
  $,
  type Msg,
  bootContent,
  captureBanner,
  click,
  fakeBrowser,
  lastVerdict,
  quietly,
  settled,
  tick,
  until,
} from './harness';

const ADDRESS = 'jordan@northwind.example';
const DATA_PDF = 'data:application/pdf;base64,JVBERi0xLjQK';
const PAGE = `<h2 class="hP">Meeting minutes</h2>
  <div class="adn"><span class="gD" email="${ADDRESS}" name="Jordan Lee">Jordan Lee</span>
    <span data-tooltip="Gmail couldn't verify that northwind.example sent this message">?</span>
    <div class="a3s">Hi team, the minutes from Tuesday's meeting are attached. The
      <a id="agenda" href="https://northwind.example/agenda">agenda</a> is on the wiki. Thanks!
      <a id="dl" download="minutes.pdf" href="${DATA_PDF}">minutes.pdf</a></div></div>`;

const banner = captureBanner();
let sent: Msg[];
let fingerprint: string;

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: async () => {
      // The same inputs entrypoints/content.ts hashes: the Gmail adapter's extraction, auth flag and attachments.
      const [email] = gmail.extractAll!(document);
      const names = email!.attachments!.map((a) => a.name);
      fingerprint = await hashEmail(email!.senderAddress, email!.body, email!.links, names, {
        unauthenticated: email!.unauthenticated,
        viaDomain: email!.viaDomain,
        attachmentCount: names.length,
      });
    },
  }));
  await quietly(settled(sent));
});

const local = async (key: string): Promise<unknown> => (await fakeBrowser.storage.local.get(key))[key];
const linksLocked = () => document.querySelector('div.a3s')!.hasAttribute('data-ped-locked');
const downloadLocked = () => $('dl').hasAttribute('data-ped-att-locked');

describe('content.ts: the banner buttons on an email from a sender Gmail could not verify', () => {
  it('shows the sender warning with the links and the download paused', () => {
    expect(lastVerdict(sent)).toMatchObject({
      verdict: { level: 'safe' },
      sender: { address: ADDRESS, unauthenticated: true },
      trusted: false,
    });
    expect(banner.text()).toContain('Check this sender.');
    expect(linksLocked(), 'links locked').toBe(true);
    expect(downloadLocked(), 'download locked').toBe(true);
  });

  it('refuses "Always trust sender": the button is disabled and pressing it anyway trusts nobody', async () => {
    const shown = banner.root();
    const trust = banner.button('Always trust sender');
    expect(trust.disabled).toBe(true);
    expect(trust.title).toBe('Sender failed authentication or used an unexpected relay');
    // Page scripts cannot reach the closed shadow root; enabling the button here stands in for any slip in the
    // banner's own check, so the content script's refusal is what is tested.
    trust.disabled = false;
    trust.click();
    await tick();
    await tick();
    expect(await local('trustedSenders'), 'trustedSenders in storage').toBeUndefined();
    expect(banner.root(), 'the same banner is still shown').toBe(shown);
    expect(linksLocked(), 'links locked').toBe(true);
    expect(downloadLocked(), 'download locked').toBe(true);
  });

  it('Dismiss hides the banner; clicking a paused link brings it back', () => {
    banner.button('Dismiss warning (links and attachments stay paused)').click();
    expect(banner.root(), 'banner after Dismiss').toBeNull();
    expect(linksLocked(), 'links stay locked').toBe(true);
    expect(click($('agenda')), 'click cancelled').toBe(true);
    expect(banner.root(), 'banner after clicking a paused link').not.toBeNull();
    expect(banner.text()).toContain('Check this sender.');
  });

  it('"I trust this email" opens the links and the download and stores only the fingerprint', async () => {
    banner.button('I trust this email').click();
    await until(() => expect(banner.text()).toContain('Email trusted — links & attachments enabled'));
    expect(linksLocked(), 'links locked').toBe(false);
    expect($('agenda').getAttribute('href')).toBe('https://northwind.example/agenda');
    expect(downloadLocked(), 'download locked').toBe(false);
    expect($('dl').getAttribute('href')).toBe(DATA_PDF);
    expect(click($('agenda')), 'same-site link click cancelled').toBe(false);
    expect(lastVerdict(sent)).toMatchObject({ trusted: true });
    await until(async () => expect(await local('trustedEmails')).toEqual([fingerprint]));
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('Undo locks the links and the download again and forgets the fingerprint', async () => {
    banner.button('Undo').click();
    // Undo itself must re-lock: check before the 400 ms rescan that the storage change also triggers could do it.
    for (let i = 0; i < 5 && !linksLocked(); i++) await tick();
    expect(linksLocked(), 'links locked by Undo itself (before any rescan)').toBe(true);
    expect(downloadLocked(), 'download locked').toBe(true);
    expect($('agenda').hasAttribute('href')).toBe(false);
    expect(await local('trustedEmails')).toEqual([]);
    expect(lastVerdict(sent)).toMatchObject({ trusted: false, sender: { address: ADDRESS } });
    expect(banner.button('I trust this email').disabled).toBe(false);
  });
});
