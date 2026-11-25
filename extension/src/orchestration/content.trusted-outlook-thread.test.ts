// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://outlook.live.com/mail/0/"}
// C14: a mixed Outlook thread. A trusted sender (attachments kept locked, since Outlook shows no sender verification
// the adapter can read) next to an impersonator whose only problem is a sender warning. The trusted sender's
// attachment notice must never become the thread's banner and hide the impersonator's warning, and the impersonator
// must not pause the trusted sender's links.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, fakeBrowser, lastVerdict, quietly, tick, until, verdictsOf } from './harness';

const TRUSTED = 'anna@smallfirm.example';
const PAGE = `<div data-app-section="ConversationContainer">
  <div aria-label="Email message"><span class="OZZZK">Anna &lt;${TRUSTED}&gt;</span>
    <div aria-label="Message body" id="b1">Invoice attached. <a id="l1" href="https://smallfirm.example/x">portal</a></div>
    <div role="listitem" aria-label="Attached file invoice.pdf" id="att"><button>invoice.pdf</button></div></div>
  <div aria-label="Email message"><span class="OZZZK">PayPal Support &lt;service@paypa1-alerts.example&gt;</span>
    <div aria-label="Message body" id="b2">Hello, here is your monthly statement.
      <a id="l2" href="https://paypa1-alerts.example/s">statement</a></div></div>
</div>`;

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () =>
      fakeBrowser.storage.local.set({ trustedSenders: [TRUSTED], privacySettings: { strictLocalMode: true } }),
  }));
  // Strict Local Mode: no lookups, so the first verdict is the only one. Which message it reports is tested below.
  await quietly(until(() => expect(verdictsOf(sent).length).toBeGreaterThan(0)));
  await tick();
});

describe('content.ts: trusted sender and impersonator in one Outlook thread', () => {
  it("reports the impersonator's warning, not the trusted sender's attachment notice", () => {
    const v = lastVerdict(sent);
    expect(v, 'thread verdict').toMatchObject({ sender: { address: 'service@paypa1-alerts.example' } });
    expect(v!.sender.warnings.join(' ')).toMatch(/Claims to be PayPal/);
  });

  it("pauses the impersonator's links only, and keeps the trusted sender's attachment locked", () => {
    expect($('b2').hasAttribute('data-ped-locked'), "impersonator's links locked").toBe(true);
    expect($('b1').hasAttribute('data-ped-locked'), "trusted sender's links locked").toBe(false);
    expect($('l1').getAttribute('href')).toBe('https://smallfirm.example/x');
    expect($('att').hasAttribute('data-ped-att-locked'), "trusted sender's attachment locked").toBe(true);
  });
});
