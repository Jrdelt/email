// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.icloud.com/applications/mail2/current/en-us/index.html"}
// Firefox pairs a card with its frame at once (runtime.getFrameId), so the first scan can decide for a frame that has
// not reported its body yet. That decision has no signature and must never unlock: when the sender lookup of that
// bodyless scan answers after the body arrived, its re-render must not open the (phishing) body.
import { beforeAll, describe, expect, it } from 'vitest';
import { type Msg, bootContent, deliver, fakeBrowser, lookups, until } from './harness';

const FRAME_ID = 31;
const PAGE = `<div class="pane thread-detail-pane"><div class="conversation-list">
  <div id="message-iframe-INBOX/7"><div class="conversation-list-item">
    <span class="contact-token" role="button" title="alex@corp.example">Alex Kim</span>
    <h2>Expenses</h2>
    <div><iframe srcdoc="" title="Message body"></iframe></div>
  </div></div></div></div>`;
const BODY = {
  type: 'icloudBody', frameId: FRAME_ID, active: true,
  body: 'Your account is locked. Verify your password now or it will be suspended.',
  links: [{ text: 'Sign in', href: 'https://evil.example/login' }],
  linksTruncated: false, attachmentNames: [], sig: 'abcd1234',
};

let sent: Msg[];
let answerLookup: (v: unknown) => void = () => {};
const locks = (from = 0) => sent.slice(from).filter((m) => m.type === 'icloudLock');

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () => {
      (fakeBrowser.runtime as unknown as { getFrameId: (el: Element) => number }).getFrameId = (el) =>
        el.localName === 'iframe' ? FRAME_ID : -1;
    },
    intel: () => new Promise((resolve) => (answerLookup = resolve)),
  }));
});

describe('content.ts: iCloud app frame, decisions for a frame with no body yet', () => {
  it('never sends an unlock without a signature', async () => {
    await until(() => expect(lookups(sent)).toEqual(['corp.example']));
    await deliver(BODY);
    answerLookup(undefined); // answers inside the body's 400 ms rescan debounce
    await until(() => expect(locks().some((m) => m.locked === true && m.sig === BODY.sig)).toBe(true));
    const sigless = locks().filter((m) => !('sig' in m));
    expect(sigless.every((m) => m.locked === true || m.attachmentsLocked === true)).toBe(true);
  });
});
