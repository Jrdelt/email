// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://outlook.live.com/mail/0/"}
// C13: a trusted sender (storage.local "trustedSenders") on a webmail whose sender verification the adapter cannot
// read (Outlook: no authSignals). A forged copy of the address would look identical, so sender trust opens the
// links but keeps the email's attachments locked (entrypoints/content.ts evaluateAndRender "attachmentsOnly").
// The Gmail counterpart, where sender trust also opens attachments, is content.trusted-gmail-download.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  $,
  type Msg,
  bootContent,
  click,
  fakeBrowser,
  lastVerdict,
  navigations,
  press,
  quietly,
  tick,
  until,
} from './harness';

const ADDRESS = 'bob@corp.example';
// Outlook conversation markup as in src/adapters/extract.test.ts ("attachment-only message inside a conversation").
const PAGE = `<div data-app-section="ConversationContainer">
  <div aria-label="Email message"><span class="OZZZK">Bob Lin &lt;${ADDRESS}&gt;</span>
    <div aria-label="Message body" id="body">Hi, the minutes from Tuesday are attached. The
      <a id="agenda" href="https://corp.example/agenda">agenda</a> is on the wiki. Thanks!</div>
    <div role="listitem" aria-label="Attached file minutes.pdf" id="att"><button id="attbtn">minutes.pdf</button></div>
  </div></div>`;

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () => fakeBrowser.storage.local.set({ trustedSenders: [ADDRESS] }),
  }));
  // Any verdict for this sender: the tests below check what it decided, so a wrong decision names itself.
  await quietly(until(() => expect(lastVerdict(sent)).toMatchObject({ sender: { address: ADDRESS } })));
  await tick();
});

describe('content.ts: trusted sender on Outlook, attachment card', () => {
  it('reports a safe, allowlisted sender whose attachment still needs a click to open', () => {
    expect(lastVerdict(sent)).toMatchObject({
      verdict: { level: 'safe' },
      sender: { address: ADDRESS, allowlisted: true, warnings: [] },
      attachments: { count: 1, level: 'locked', names: ['minutes.pdf'] },
      trusted: false,
    });
  });

  it('does not pause the links', () => {
    expect($('body').hasAttribute('data-ped-locked')).toBe(false);
    expect($('agenda').getAttribute('href')).toBe('https://corp.example/agenda');
    expect(click($('agenda'))).toBe(false); // same-site link of an unlocked email: goes through natively
  });

  it('locks the attachment card and cancels its click and keyboard activation', () => {
    expect($('att').hasAttribute('data-ped-att-locked'), 'attachment card locked').toBe(true);
    expect(click($('attbtn'))).toBe(true);
    expect(press($('attbtn'), 'Enter')).toBe(true);
    expect(document.getElementById('ped-toast-host')).not.toBeNull(); // "attachment blocked" notice
    expect(navigations(sent)).toEqual([]);
  });
});
