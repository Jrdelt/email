// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// Undo restores the trust that "I trust this email" changed, nothing more. In this thread the first message was
// trusted earlier (its fingerprint is stored); a second message raises a warning. Trusting the thread and then
// pressing Undo must keep the first message's stored trust (and leave it unlocked), and lock only the second again.
import { beforeAll, describe, expect, it } from 'vitest';
import { gmail } from '../adapters/gmail';
import { hashEmail } from '../allowlist';
import { $, type Msg, bootContent, captureBanner, fakeBrowser, lastVerdict, quietly, settled, tick, until } from './harness';

const message = (o: { id: string; name: string; email: string; body: string; unverified?: boolean }) =>
  `<div class="adn"><span class="gD" email="${o.email}" name="${o.name}">${o.name}</span>
    ${o.unverified ? `<span data-tooltip="Gmail couldn't verify that northwind.example sent this message">?</span>` : ''}
    <div class="a3s" id="${o.id}">${o.body}</div></div>`;

const PAGE = `<h2 class="hP">Quarterly review</h2>
  ${message({
    id: 'earlier',
    name: 'Alex Kim',
    email: 'alex@corp.example',
    body: 'Your PayPal account is locked. Verify your password now. <a id="l0" href="https://corp.example/review">review</a>',
  })}
  ${message({
    id: 'reply',
    name: 'Jordan Lee',
    email: 'jordan@northwind.example',
    unverified: true,
    body: 'Hi team, the <a id="l1" href="https://northwind.example/agenda">agenda</a> is on the wiki. Thanks!',
  })}`;

const banner = captureBanner();
let sent: Msg[];
let earlier: string;

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: async () => {
      const [first] = gmail.extractAll!(document);
      earlier = await hashEmail(first!.senderAddress, first!.body, first!.links, [], { attachmentCount: 0 });
      await fakeBrowser.storage.local.set({ trustedEmails: [earlier] });
    },
  }));
  await quietly(settled(sent));
});

const local = async (key: string): Promise<unknown> => (await fakeBrowser.storage.local.get(key))[key];
const locked = (id: string) => $(id).hasAttribute('data-ped-locked');

describe('content.ts: Undo on a thread with an earlier trusted message', () => {
  it('starts with the earlier message trusted and the reply locked', () => {
    expect(lastVerdict(sent)).toMatchObject({ sender: { address: 'jordan@northwind.example' }, trusted: false });
    expect(locked('earlier')).toBe(false);
    expect(locked('reply')).toBe(true);
  });

  it('"I trust this email" opens the reply and stores its fingerprint next to the earlier one', async () => {
    banner.button('I trust this email').click();
    await until(() => expect(banner.text()).toContain('Email trusted'));
    expect(locked('reply')).toBe(false);
    await until(async () => expect(await local('trustedEmails')).toHaveLength(2));
    expect(await local('trustedEmails')).toContain(earlier);
  });

  it('Undo keeps the earlier message trusted and unlocked, and locks the reply again', async () => {
    banner.button('Undo').click();
    for (let i = 0; i < 5 && !locked('reply'); i++) await tick();
    expect(locked('reply'), 'reply locked').toBe(true);
    expect(locked('earlier'), 'earlier message locked').toBe(false);
    await until(async () => expect(await local('trustedEmails')).toEqual([earlier]));
    // And so it stays on the rescan that the storage change brings.
    const mark = sent.length;
    await until(() => expect(sent.slice(mark).some((m) => m.type === 'verdict')).toBe(true));
    await tick();
    expect(locked('earlier'), 'earlier message after the rescan').toBe(false);
    expect(locked('reply'), 'reply after the rescan').toBe(true);
  });
});
