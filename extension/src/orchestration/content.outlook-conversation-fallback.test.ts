// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://outlook.live.com/mail/0/"}
// An Outlook conversation whose messages have no per-message wrapper the adapter knows (a localized OWA: the
// wrapper's aria-label is "E-Mail-Nachricht", not "Email message"). The adapter falls back to the whole
// conversation, whose first From node is the allowlisted boss@corp.example, so the attacker's reply in the same
// thread used to be attributed to the trusted sender and auto-trusted: no banner, links open. The sender found
// there is now pairingUncertain, so it is never allowlist-trusted and the reply is scored and locked.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, fakeBrowser, navigations, quietly, tick, until, verdictsOf } from './harness';

const TRUSTED = 'boss@corp.example';
const PAGE = `<div data-app-section="ConversationContainer">
  <div aria-label="E-Mail-Nachricht"><span class="OZZZK">Boss&lt;${TRUSTED}&gt;</span>
    <div id="UniqueMessageBody_1">Lunch on Friday? <a id="l1" href="https://corp.example/menu">menu</a></div></div>
  <div aria-label="E-Mail-Nachricht"><span class="OZZZK">Mallory&lt;mallory@evil.example&gt;</span>
    <div id="UniqueMessageBody_2">Urgent: your password expired. Verify immediately or your account will be suspended.
      <a id="l2" href="http://192.168.4.20/login">https://www.paypal.com/signin</a></div></div>
</div>`;

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () =>
      fakeBrowser.storage.local.set({ trustedSenders: [TRUSTED], privacySettings: { strictLocalMode: true } }),
  }));
  await quietly(until(() => expect(verdictsOf(sent).length).toBeGreaterThan(0)));
  await tick();
});

describe('content.ts: Outlook conversation without per-message wrappers and a trusted first sender', () => {
  it('does not trust the thread: the phishing reply is scored', () => {
    const v = verdictsOf(sent).at(-1);
    expect(v).toMatchObject({ trusted: false });
    expect(v!.verdict.level).not.toBe('safe');
  });

  it("shows the banner and pauses the reply's links", () => {
    expect(document.getElementById('ped-banner-host')).not.toBeNull();
    expect($('UniqueMessageBody_2').hasAttribute('data-ped-locked')).toBe(true);
    expect($('l2').hasAttribute('href')).toBe(false);
    expect(click($('l2'))).toBe(true);
    expect(navigations(sent)).toEqual([]);
  });
});
