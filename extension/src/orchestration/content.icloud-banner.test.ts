// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.icloud.com/applications/mail2/current/en-us/index.html"}
// C23: banner actions in the iCloud app frame while the card/frame pairing is still uncertain (two cards, bodies
// matched by position only). "Always trust sender" must not trust a body that may belong to the other card, and a
// paused click in a message frame (relayed by the background as icloudBlocked) reopens a dismissed banner.
import { beforeAll, describe, expect, it } from 'vitest';
import { type Msg, bootContent, captureBanner, deliver, fakeBrowser, lastVerdict, quietly, settled, tick } from './harness';

const ADDRESS = 'alex@corp.example';
const card = (n: number) => `<div id="message-iframe-INBOX/${n}"><div class="conversation-list-item">
    <span class="contact-token" role="button" title="${ADDRESS}">Alex Kim</span>
    <h2>Expenses</h2>
    <div><iframe id="frame${n}" srcdoc="" title="Message body"></iframe></div>
  </div></div>`;
const PAGE = `<div class="pane thread-detail-pane"><div class="conversation-list">${card(1)}${card(2)}</div></div>`;
const body = (frameId: number, text: string, href: string) => ({
  type: 'icloudBody',
  frameId,
  active: true,
  body: text,
  links: [{ text: 'open', href }],
  linksTruncated: false,
  attachmentNames: [],
  sig: `${frameId}0a0b0c`,
});

const banner = captureBanner();
let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () => fakeBrowser.storage.local.set({ trustedSenders: [ADDRESS] }),
  }));
  await deliver(body(11, 'Hi, the expense report is ready.', 'https://corp.example/expenses'));
  await deliver(body(12, 'Your account is locked. Verify your password now or it will be suspended.', 'https://evil.example/login'));
  await quietly(settled(sent));
});

const unlocksAfter = (mark: number) =>
  sent.slice(mark).filter((m) => m.type === 'icloudLock' && m.locked === false);

describe('content.ts: iCloud banner actions with an uncertain pairing', () => {
  it('"Always trust sender" does not trust bodies whose card is uncertain', async () => {
    expect(banner.root(), 'banner shown').not.toBeNull();
    const mark = sent.length;
    banner.button('Always trust sender').click();
    // A danger banner asks first (the safe choice is focused); confirm, so the pairing guard is what is tested.
    banner.button('Yes, always trust this sender').click();
    for (let i = 0; i < 5; i++) await tick();
    expect(unlocksAfter(mark), 'no frame unlocked').toEqual([]);
    expect(lastVerdict(sent), 'still untrusted').toMatchObject({ trusted: false });
    expect(banner.root(), 'banner still shown').not.toBeNull();
  });

  it('a paused click in a message frame reopens the dismissed banner', async () => {
    banner.button('Dismiss warning (links stay paused)').click();
    await tick();
    expect(banner.root(), 'banner dismissed').toBeNull();
    await deliver({ type: 'icloudBlocked' });
    await tick();
    expect(banner.root(), 'banner reopened by icloudBlocked').not.toBeNull();
  });
});
