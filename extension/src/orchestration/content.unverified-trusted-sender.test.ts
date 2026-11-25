// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C15: the AGENTS.md allowlist rule. The sender's exact address is in storage.local "trustedSenders", but Gmail shows
// that it could not verify the sender (a "couldn't verify" label outside the body, src/adapters/gmail.ts
// isUnauthenticated), or, in the next conversation, that the email came "via" another organisation's relay that is
// not a known email service (Gmail's span.go label). Auto-trust is refused (src/sender.ts canTrustByAllowlist): the
// email is scored like any other, the banner says why the trusted address is not trusted, and its links are paused.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  $,
  type Msg,
  bootContent,
  click,
  fakeBrowser,
  lastVerdict,
  lookups,
  navigations,
  quietly,
  settled,
  until,
} from './harness';

const ADDRESS = 'alex@corp.example';
const CLAIM = `Claims to be a trusted sender (${ADDRESS}), but failed authentication or used an unexpected relay`;

// A Gmail conversation with one open message. `header` is Gmail's own markup next to the sender chip, outside the
// message body (div.a3s), where the adapter reads sender verification.
const page = (o: { header: string; body: string }) => `<h2 class="hP">Expense report</h2>
  <div class="adn"><span class="gD" email="${ADDRESS}" name="Alex Kim">Alex Kim</span>${o.header}
    <div class="a3s">${o.body}</div></div>`;

const UNVERIFIED = page({
  header: `<span class="unverified" data-tooltip="Gmail couldn't verify that corp.example sent this message"
    aria-label="Gmail couldn't verify that corp.example sent this message">?</span>`,
  body: `Your expense account is locked. Verify your password now or it will be suspended.
    <a id="link" href="https://corp-expenses.example/login">Sign in</a>`,
});
const VIA_RELAY = page({
  header: '<span class="go">via mailer.relay-hub.example</span>',
  body: 'Hi, the <a id="link2" href="https://corp.example/expenses">expense report</a> is ready. Thanks!',
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(UNVERIFIED, {
    beforeMain: () => fakeBrowser.storage.local.set({ trustedSenders: [ADDRESS] }),
  }));
  await quietly(settled(sent));
});

const body = () => document.querySelector<HTMLElement>('div.a3s')!;

describe('content.ts: an allowlisted address Gmail could not verify', () => {
  it('is not trusted: it is scored and says why the trusted address is not trusted', () => {
    const v = lastVerdict(sent);
    expect(v, 'verdict').toMatchObject({
      trusted: false,
      sender: { address: ADDRESS, unauthenticated: true },
    });
    expect(v!.verdict.level, 'the body is scored, not waved through as SAFE').toBe('suspicious');
    expect(v!.sender.warnings).toEqual([CLAIM, 'Webmail could not verify that this sender is genuine']);
    expect(lookups(sent), 'an untrusted sender domain is looked up').toEqual(['corp.example']);
  });

  it('pauses its links behind the warning banner', () => {
    expect(document.getElementById('ped-banner-host')).not.toBeNull();
    expect(body().hasAttribute('data-ped-locked')).toBe(true);
    expect($('link').hasAttribute('href')).toBe(false);
    expect(click($('link'))).toBe(true);
    expect(navigations(sent)).toEqual([]);
  });
});

describe('content.ts: an allowlisted address sent through an unexpected relay', () => {
  it('is not trusted either: a safe-scoring body is still locked by the sender warning', async () => {
    const mark = sent.length;
    document.body.innerHTML = VIA_RELAY; // the webmail shows the next conversation
    await until(() => expect(lastVerdict(sent), 'verdict for the relayed email').toMatchObject({
      trusted: false,
      sender: { address: ADDRESS, viaDomain: 'mailer.relay-hub.example' },
    }));
    await settled(sent, mark);
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, sender: { warnings: [CLAIM] } });
    expect(lookups(sent, mark)).toEqual(['corp.example']);
    expect(body().hasAttribute('data-ped-locked')).toBe(true);
    expect($('link2').hasAttribute('href')).toBe(false);
    expect(click($('link2'))).toBe(true);
    expect(navigations(sent)).toEqual([]);
  });
});
