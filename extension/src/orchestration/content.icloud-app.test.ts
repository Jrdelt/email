// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.icloud.com/applications/mail2/current/en-us/index.html"}
// C11: the iCloud mail2 app frame (entrypoints/content.ts runICloudApp). Message bodies live in cross-origin sandbox
// frames, whose content script reports each body; the background relays it here as an icloudBody message carrying
// the browser-verified frame id. The app frame pairs it with the message card (src/adapters/icloud.ts), scores it
// with the card's sender, and sends its lock decision back for that frame id (icloudLock, relayed by the background).
// The sandbox half (applying the decision) is in content.icloud-sandbox.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { type Msg, bootContent, deliver, lastVerdict, lookups, settled, until } from './harness';

const FRAME_ID = 9;
const SIG = '1a2b3c4d';
const BODY = {
  type: 'icloudBody',
  frameId: FRAME_ID,
  active: true,
  body: 'Your Apple ID is locked. Verify your password now or it will be suspended. www.apple.com',
  links: [{ text: 'www.apple.com', href: 'https://evil.example/login' }],
  linksTruncated: false,
  attachmentNames: [],
  sig: SIG,
};

// The card's iframe stands in for the cross-origin sandbox frame (srcdoc: happy-dom loads no page for it).
const PAGE = `<div class="pane thread-detail-pane"><div class="conversation-list">
  <div id="message-iframe-INBOX/7"><div class="conversation-list-item">
    <span class="contact-token" role="button" title="support@appleid-verify.example">Apple Support</span>
    <h2>Your Apple ID</h2>
    <div><iframe srcdoc="" title="Message body"></iframe></div>
  </div></div></div></div>`;

let sent: Msg[];

const locks = (from = 0) => sent.slice(from).filter((m) => m.type === 'icloudLock');

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
});

describe('content.ts: iCloud app frame', () => {
  it('asks the sandbox frames to report their bodies when it starts', () => {
    expect(sent.some((m) => m.type === 'icloudPing')).toBe(true);
  });

  it('scores a relayed phishing body with its card sender and locks that frame', async () => {
    await deliver(BODY);
    await settled(sent);
    expect(lastVerdict(sent)).toMatchObject({
      verdict: { level: 'likely-phishing' },
      sender: { address: 'support@appleid-verify.example' },
      trusted: false,
    });
    expect(lookups(sent)).toEqual(['appleid-verify.example']);
    expect(locks()).toContainEqual({
      type: 'icloudLock',
      locked: true,
      attachmentsLocked: false,
      frameIds: [FRAME_ID],
      sig: SIG,
    });
    // Every decision sent for this frame (first render and after the lookup) keeps it locked.
    const forFrame = locks().filter((m) => (m.frameIds as number[]).includes(FRAME_ID));
    expect(forFrame.every((m) => m.locked === true)).toBe(true);
    expect(document.getElementById('ped-banner-host')).not.toBeNull();
  });

  it('re-sends the decision at once when the frame reports the same body again (e.g. after reloading)', async () => {
    const mark = sent.length;
    await deliver(BODY);
    expect(locks(mark)).toEqual([
      { type: 'icloudLock', locked: true, attachmentsLocked: false, frameIds: [FRAME_ID], sig: SIG },
    ]);
  });

  it('decides for a changed body under its new signature', async () => {
    const mark = sent.length;
    await deliver({ ...BODY, body: `${BODY.body} Act within 24 hours.`, sig: 'beef0042' });
    await until(() =>
      expect(locks(mark)).toContainEqual({
        type: 'icloudLock',
        locked: true,
        attachmentsLocked: false,
        frameIds: [FRAME_ID],
        sig: 'beef0042',
      }),
    );
  });
});
