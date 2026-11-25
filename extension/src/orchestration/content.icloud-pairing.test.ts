// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://www.icloud.com/applications/mail2/current/en-us/index.html"}
// C19: iCloud app frame, a conversation with two expanded cards from an allowlisted address and two relayed bodies
// (icloudBody from two sandbox frames). Until the card/frame pairing completes, the bodies can only be matched to the
// cards by position (src/adapters/icloud.ts combineICloudThread: pairingUncertain), so a body could be shown with
// another card's sender: the allowlist is not applied to either. That is not an authentication failure, so there is
// no "claims to be a trusted sender" warning: the bodies are simply checked like any other email, and the phishing one
// locks the thread's frames. Once each card's frame reports its pairing token (icloudPair), the allowlist applies.
import { beforeAll, describe, expect, it } from 'vitest';
import { type Msg, bootContent, deliver, fakeBrowser, lastVerdict, lookups, quietly, settled, until } from './harness';

const ADDRESS = 'alex@corp.example';
const card = (n: number) => `<div id="message-iframe-INBOX/${n}"><div class="conversation-list-item">
    <span class="contact-token" role="button" title="${ADDRESS}">Alex Kim</span>
    <h2>Expenses</h2>
    <div><iframe id="frame${n}" srcdoc="" title="Message body"></iframe></div>
  </div></div>`;
const PAGE = `<div class="pane thread-detail-pane"><div class="conversation-list">${card(1)}${card(2)}</div></div>`;

const body = (frameId: number, text: string, link: { text: string; href: string }) => ({
  type: 'icloudBody',
  frameId,
  active: true,
  body: text,
  links: [link],
  linksTruncated: false,
  attachmentNames: [],
  sig: `${frameId}0a0b0c`,
});
const BENIGN = body(11, 'Hi, the expense report is ready.', { text: 'report', href: 'https://corp.example/expenses' });
const PHISHING = body(12, 'Your account is locked. Verify your password now or it will be suspended.', {
  text: 'Sign in',
  href: 'https://evil.example/login',
});

let sent: Msg[];
/** Pairing tokens the app frame posted to each card's iframe, by iframe id. */
const nonces = new Map<string, string>();

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: async () => {
      for (const iframe of document.querySelectorAll('iframe')) {
        iframe.contentWindow!.addEventListener('message', (e) => {
          const nonce = (e.data as { __pedPair?: unknown } | null)?.__pedPair;
          if (typeof nonce === 'string') nonces.set(iframe.id, nonce);
        });
      }
      await fakeBrowser.storage.local.set({ trustedSenders: [ADDRESS] });
    },
  }));
  await deliver(BENIGN);
  await deliver(PHISHING);
  await quietly(settled(sent));
});

const locks = (from = 0) => sent.slice(from).filter((m) => m.type === 'icloudLock');
const lastLockFor = (frameId: number, from = 0) =>
  locks(from).filter((m) => (m.frameIds as number[]).includes(frameId)).at(-1);

describe('content.ts: iCloud cards and bodies paired only by position', () => {
  it('does not trust the allowlisted address for either body, and does not call it an authentication failure', () => {
    expect(lastVerdict(sent)).toMatchObject({ trusted: false, sender: { address: ADDRESS, warnings: [] } });
    expect(lastVerdict(sent)!.verdict.level, 'the phishing body is scored').not.toBe('safe');
    expect(lookups(sent), 'the sender is checked like any untrusted one').toEqual(['corp.example']);
  });

  it('locks both message frames', () => {
    expect(lastLockFor(11), 'frame 11').toMatchObject({ locked: true, sig: BENIGN.sig });
    expect(lastLockFor(12), 'frame 12').toMatchObject({ locked: true, sig: PHISHING.sig });
    expect(document.getElementById('ped-banner-host')).not.toBeNull();
  });

  it('applies the allowlist once both frames are paired with their cards', async () => {
    await until(() => expect([...nonces.keys()].sort()).toEqual(['frame1', 'frame2']));
    const mark = sent.length;
    await deliver({ type: 'icloudPair', nonce: nonces.get('frame1'), frameId: 11 });
    await deliver({ type: 'icloudPair', nonce: nonces.get('frame2'), frameId: 12 });
    await until(() =>
      expect(lastVerdict(sent.slice(mark))).toMatchObject({ trusted: true, sender: { address: ADDRESS } }),
    );
    expect(lastLockFor(11, mark)).toMatchObject({ locked: false });
    expect(lastLockFor(12, mark)).toMatchObject({ locked: false });
    expect(lookups(sent, mark)).toEqual([]);
  });
});
