// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C7: Strict Local Mode (storage.local privacySettings, src/settings.ts) set before the content script starts. The
// content script must send no domain lookup at all: none for the sender after a scan, none for a clicked external
// link (which still opens), and none when the next email turns out to be phishing. Scoring and locking are local, so
// a phishing email is still flagged and locked.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  $,
  type Msg,
  bootContent,
  click,
  fakeBrowser,
  gmailMessage,
  lastVerdict,
  lookups,
  navigations,
  tick,
  until,
} from './harness';

const SAFE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Notes',
  body: `Hi team, my <a id="docs" href="https://docs.contoso.example/notes">notes</a> from Tuesday. Thanks!`,
});
const PHISHING = gmailMessage({
  name: 'PayPal Support',
  email: 'help@paypa1-secure.example',
  subject: 'Account notice',
  body: `Your PayPal account is locked. Verify your password now or it will be suspended.
    <a id="link" href="https://evil.example/login">www.paypal.com</a>`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(SAFE, {
    beforeMain: () => fakeBrowser.storage.local.set({ privacySettings: { strictLocalMode: true } }),
  }));
});

const body = () => document.querySelector<HTMLElement>('div.a3s')!;

describe('content.ts: Strict Local Mode', () => {
  it('scores the email without looking up the sender domain', async () => {
    await until(() =>
      expect(lastVerdict(sent)).toMatchObject({
        verdict: { level: 'safe' },
        sender: { address: 'jordan@northwind.example' },
        intel: 'offline',
        trusted: false,
      }),
    );
    await tick();
    expect(lookups(sent)).toEqual([]);
    expect(body().hasAttribute('data-ped-locked')).toBe(false);
  });

  it('opens a clicked external link without looking up its domain', async () => {
    const mark = sent.length;
    expect(click($('docs'))).toBe(true);
    await until(() =>
      expect(navigations(sent, mark)).toEqual([
        { type: 'openSafeLink', href: 'https://docs.contoso.example/notes', active: true },
      ]),
    );
    expect(lookups(sent)).toEqual([]);
  });

  it('still flags and locks a phishing email opened next, still without lookups', async () => {
    const mark = sent.length;
    document.body.innerHTML = PHISHING; // the webmail shows another conversation
    await until(() => expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'likely-phishing' } }));
    expect(lastVerdict(sent)).toMatchObject({ sender: { address: 'help@paypa1-secure.example' }, intel: 'offline' });
    expect(body().hasAttribute('data-ped-locked')).toBe(true);
    expect($('link').hasAttribute('href')).toBe(false);
    expect(click($('link'))).toBe(true);
    await tick();
    expect(lookups(sent)).toEqual([]);
    expect(navigations(sent, mark)).toEqual([]);
  });
});
