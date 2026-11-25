// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C13 counterpart: the same kind of trusted sender on Gmail, whose adapter reads Gmail's sender verification
// (authSignals: no "couldn't verify" badge, no unexpected "via" relay here). Sender trust then covers the whole email,
// so its inline download is NOT attachment-locked, unlike on Outlook (content.trusted-outlook-attachment.test.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, fakeBrowser, gmailMessage, lastVerdict, until } from './harness';

const ADDRESS = 'jordan@northwind.example';
const DATA_PDF = 'data:application/pdf;base64,JVBERi0xLjQK';
const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: ADDRESS,
  subject: 'Meeting minutes',
  body: `Hi team, the minutes from Tuesday's meeting are attached.
    <a id="dl" download="minutes.pdf" href="${DATA_PDF}">minutes.pdf</a>`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () => fakeBrowser.storage.local.set({ trustedSenders: [ADDRESS] }),
  }));
  await until(() => expect(lastVerdict(sent)).toMatchObject({ trusted: true }));
});

describe('content.ts: trusted sender on Gmail, inline download', () => {
  it('trusts the email as a whole: safe verdict, no attachment notice', () => {
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, sender: { address: ADDRESS }, trusted: true });
    expect(lastVerdict(sent)!.attachments).toBeUndefined();
    expect(document.getElementById('ped-banner-host')).toBeNull();
  });

  it('leaves the inline download usable', () => {
    const dl = $('dl');
    expect(dl.hasAttribute('data-ped-att-locked')).toBe(false);
    expect(dl.getAttribute('href')).toBe(DATA_PDF);
    expect(dl.getAttribute('download')).toBe('minutes.pdf');
    expect(click(dl)).toBe(false);
  });
});
