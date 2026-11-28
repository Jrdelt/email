// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://outlook.live.com/mail/0/"}
// An attachment's file name is attacker-chosen: "Boss <boss@corp.example>.pdf" must never become the sender. Here
// OWA's From node has a class the adapter does not know (span.OZZZK renamed after a deploy), so the sender comes
// from the adapter's scope-wide passes, which skip attachments and the subject. The email is from an unlisted
// sender: it is not treated as the trusted boss@corp.example, and its attachment stays locked as untrusted.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, fakeBrowser, lastVerdict, quietly, tick, until } from './harness';

const TRUSTED = 'boss@corp.example';
const PAGE = `<div data-app-section="ConversationContainer">
  <div aria-label="Email message">
    <div><span class="Xk2Pq">Mallory Ops<span>&lt;mallory@evil.example&gt;</span></span></div>
    <div aria-label="Message body" id="body">Hi, please pay the attached invoice today.
      <a id="pay" href="https://evil.example/pay">Pay now</a></div>
    <div role="listitem" aria-label="Attached file" id="att"><button id="attbtn"><span>Boss &lt;${TRUSTED}&gt;.pdf</span></button></div>
  </div></div>`;

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () => fakeBrowser.storage.local.set({ trustedSenders: [TRUSTED] }),
  }));
  await quietly(until(() => expect(lastVerdict(sent)).toBeTruthy()));
  await tick();
});

describe('content.ts: Outlook attachment named after a trusted sender', () => {
  it('reports the header address, not the trusted address in the file name', () => {
    const v = lastVerdict(sent)!;
    expect(v.sender.address).toBe('mallory@evil.example');
    expect(v).not.toMatchObject({ sender: { allowlisted: true } });
    expect(v.trusted).toBe(false);
  });

  it('locks the attachment as an untrusted one (no trusted-sender notice)', () => {
    const v = lastVerdict(sent)!;
    expect(v.attachments).toMatchObject({ count: 1, level: 'locked' });
    expect((v.attachments as unknown as { reasons: string[] }).reasons.join(' ')).not.toMatch(/You trust this sender/);
    expect($('att').hasAttribute('data-ped-att-locked')).toBe(true);
    expect(click($('attbtn'))).toBe(true);
  });
});
