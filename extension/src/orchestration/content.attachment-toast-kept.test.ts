// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// An untrusted email whose body scores safe, with an inline PDF: its links stay open, its attachment is blocked.
// The user dismisses the attachment notice and then clicks the PDF. The click is refused with the "Attachment
// blocked" toast and the banner comes back (a re-render). That re-render unlocks the links of every message whose
// links are not paused, which removed the toast it had just explained the click with: nothing at the click point
// said why nothing happened. Only lifting a lock that was in place may take the toast away.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, captureBanner, click, gmailMessage, quietly, settled, tick, until } from './harness';

const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Meeting minutes',
  body: `Hi team, the minutes from Tuesday's meeting are attached. The
    <a id="agenda" href="https://northwind.example/agenda">agenda</a> is on the wiki. Thanks!
    <a id="dl" download="minutes.pdf" href="data:application/pdf;base64,JVBERi0xLjQK">minutes.pdf</a>`,
});

const banner = captureBanner();
let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await quietly(settled(sent));
});

const toastShown = () => document.getElementById('ped-toast-host') !== null;

describe('content.ts: the blocked-attachment toast after the notice was dismissed', () => {
  it('shows an attachment notice with only the PDF locked', () => {
    expect(banner.text()).toContain('Attachments blocked.');
    expect($('dl').hasAttribute('data-ped-att-locked')).toBe(true);
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(false);
  });

  it('keeps the toast when the click on the PDF brings the banner back', async () => {
    banner.button('Dismiss notice (attachments stay blocked)').click();
    expect(banner.root()).toBeNull();
    expect(click($('dl'))).toBe(true);
    await until(() => expect(banner.text()).toContain('Attachments blocked.'));
    await tick();
    expect(toastShown()).toBe(true);
  });
});
