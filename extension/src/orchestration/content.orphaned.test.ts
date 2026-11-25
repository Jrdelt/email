// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C18: an orphaned content script. After an extension update or reload, the content script of an open tab keeps
// running but its extension is gone: runtime.id is undefined and its runtime APIs throw synchronously. The background
// can no longer check or open links for it (entrypoints/content.ts extensionAlive()), so a click on a risky link of an
// unlocked email stays paused with the usual notice instead of being handed to a background that cannot answer, and a
// click with no local finding goes through natively.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  $,
  type Msg,
  bootContent,
  click,
  fakeBrowser,
  gmailMessage,
  lastVerdict,
  quietly,
  settled,
  tick,
} from './harness';

const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Notes',
  body: `Hi team, my <a id="docs" href="https://docs.contoso.example/notes">notes</a> from Tuesday and the
    <a id="share" href="https://northwind.example/share">shared folder</a>. Thanks!`,
});

let sent: Msg[];
/** Runtime messages the orphaned script still tried to send (each one threw). */
const attempts: Msg[] = [];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await quietly(settled(sent));
});

const toast = () => document.getElementById('ped-toast-host');

describe('content.ts: content script orphaned by an extension update', () => {
  it('scanned the email while the extension was alive: safe and unlocked', () => {
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, trusted: false });
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(false);
  });

  it('lets a click on an external link with no local finding go through natively', () => {
    const runtime = fakeBrowser.runtime as unknown as { id?: string; sendMessage: (m: Msg) => unknown };
    runtime.id = undefined;
    runtime.sendMessage = (m: Msg) => {
      attempts.push(m);
      throw new Error('Extension context invalidated.');
    };
    expect(click($('docs')), 'click cancelled').toBe(false);
    expect(attempts, 'runtime messages attempted').toEqual([]);
    expect(toast()).toBeNull();
  });

  it('keeps a click on a risky link paused with the notice, without asking the gone background', async () => {
    // Gmail rewrites a link's href when it is clicked; this one now points at a numeric address.
    $('share').setAttribute('href', 'http://192.0.2.10/login');
    expect(click($('share')), 'click cancelled').toBe(true);
    expect(toast(), '"link paused" notice').not.toBeNull();
    await tick(); // let any asynchronous click handling run
    expect(attempts.filter((m) => m.type === 'openWarning' || m.type === 'openSafeLink'), 'navigations').toEqual([]);
  });
});
