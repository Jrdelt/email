// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C10: per-email trust. The user unlocked this (suspicious) email earlier, so its one-way SHA-256 fingerprint
// (src/allowlist.ts hashEmail) is in storage.local "trustedEmails": it is shown unlocked and its sender domain is not
// looked up. When the fingerprint is removed elsewhere (popup "Clear", another tab), storage.onChanged triggers a
// rescan that locks it. The fingerprint is computed here from the Gmail adapter's own extraction, the same inputs
// entrypoints/content.ts hashes (no attachments, no auth flags in this email).
import { beforeAll, describe, expect, it } from 'vitest';
import { gmail } from '../adapters/gmail';
import { hashEmail } from '../allowlist';
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
  settled,
  tick,
  until,
} from './harness';

const PAGE = gmailMessage({
  name: 'PayPal Support',
  email: 'help@paypa1-secure.example',
  subject: 'Account notice',
  body: `Your PayPal account is locked. Verify your password now or it will be suspended.
    <a id="link" href="https://evil.example/login">www.paypal.com</a>`,
});

let sent: Msg[];
let fingerprint: string;

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: async () => {
      const [email] = gmail.extractAll!(document);
      fingerprint = await hashEmail(email!.senderAddress, email!.body, email!.links, [], { attachmentCount: 0 });
      await fakeBrowser.storage.local.set({ trustedEmails: [fingerprint] });
    },
  }));
});

const body = () => document.querySelector<HTMLElement>('div.a3s')!;

describe('content.ts: per-email trust, then trust removed', () => {
  it('stores a fingerprint only (64 hex characters)', () => {
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not lock an email whose fingerprint is trusted, nor look up its sender', async () => {
    await until(() => expect(lastVerdict(sent)).toMatchObject({ trusted: true, verdict: { level: 'safe' } }));
    await tick();
    expect(body().hasAttribute('data-ped-locked')).toBe(false);
    expect($('link').getAttribute('href')).toBe('https://evil.example/login');
    expect(document.getElementById('ped-banner-host')).toBeNull();
    expect(lookups(sent)).toEqual([]);
  });

  it('locks the email on the rescan after its fingerprint is removed from storage', async () => {
    const mark = sent.length;
    await fakeBrowser.storage.local.set({ trustedEmails: [] });
    await settled(sent, mark);
    expect(lastVerdict(sent)).toMatchObject({ trusted: false, verdict: { level: 'likely-phishing' } });
    expect(lookups(sent, mark)).toEqual(['paypa1-secure.example']);
    expect(body().hasAttribute('data-ped-locked')).toBe(true);
    expect($('link').hasAttribute('href')).toBe(false);
    expect(click($('link'))).toBe(true);
    expect(navigations(sent)).toEqual([]);
  });
});
