// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C4: sender trust and its revocation. The sender's exact address is in the allowlist (storage.local
// "trustedSenders", src/allowlist.ts), so an otherwise suspicious email is shown unlocked. When the address is
// removed from storage elsewhere (popup, another tab), storage.onChanged triggers a rescan that locks the email.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, fakeBrowser, gmailMessage, lastVerdict, settled, until } from './harness';

const ADDRESS = 'it-help@northwind.example';
const PAGE = gmailMessage({
  name: 'IT Helpdesk',
  email: ADDRESS,
  subject: 'Password expiry',
  body: `Your mailbox password expires today. Verify your account immediately or it will be suspended.
    <a id="link" href="https://login-verify.example/reset">Sign in here</a>`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () => fakeBrowser.storage.local.set({ trustedSenders: [ADDRESS] }),
  }));
});

const body = () => document.querySelector<HTMLElement>('div.a3s')!;

describe('content.ts: trusted sender, then trust revoked', () => {
  it('does not lock an allowlisted sender', async () => {
    await until(() => expect(lastVerdict(sent)).toMatchObject({ trusted: true, verdict: { level: 'safe' } }));
    expect(body().hasAttribute('data-ped-locked')).toBe(false);
    expect($('link').getAttribute('href')).toBe('https://login-verify.example/reset');
    expect(document.getElementById('ped-banner-host')).toBeNull();
  });

  it('locks the email on the next scan after the address is removed from storage', async () => {
    const mark = sent.length;
    await fakeBrowser.storage.local.set({ trustedSenders: [] });
    await settled(sent, mark);
    expect(lastVerdict(sent)).toMatchObject({
      trusted: false,
      verdict: { level: 'suspicious' },
      sender: { address: ADDRESS },
    });
    expect(body().hasAttribute('data-ped-locked')).toBe(true);
    expect($('link').hasAttribute('href')).toBe(false);
    expect(click($('link'))).toBe(true);
    expect(sent.some((m) => m.type === 'openSafeLink' || m.type === 'openWarning')).toBe(false);
  });
});
