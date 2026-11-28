// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// The blocked-attachment toast names the file it blocked. That name must come from what the lock recorded, never
// from a page-visible attribute: the email can write data-ped-att-name="invoice.pdf" on a download of its own. Here
// a nameless inline download appears while a scan is pending; the press on it is held, the rescan locks it, and the
// toast that follows (from content.ts, then from the lock itself) must not repeat the email's label.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, gmailMessage, settled, tick, until } from './harness';

const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Agenda',
  body: 'Hi team, the agenda for Tuesday is on the wiki. Thanks!',
});

const said: string[] = [];
let sent: Msg[];

beforeAll(async () => {
  (document as Document & { ariaNotify?: (m: string) => void }).ariaNotify = (m) => void said.push(m);
  ({ sent } = await bootContent(PAGE));
  await settled(sent);
});

describe('content.ts: blocked-attachment toast for a download the email labelled itself', () => {
  it('does not name the file after the email-supplied data-ped-att-name', async () => {
    const dl = document.createElement('a');
    dl.id = 'dl';
    dl.setAttribute('download', '');
    dl.setAttribute('href', 'data:application/zip;base64,UEsDBA==');
    dl.setAttribute('data-ped-att-name', 'invoice.pdf');
    dl.append(document.createElement('img')); // no text: the lock records no name for it
    document.querySelector('div.a3s')!.append(dl);
    await tick(); // a scan is now pending
    expect(click($('dl')), 'press held while the scan is pending').toBe(true);
    await until(() => expect(said.some((m) => m.startsWith('Attachment blocked'))).toBe(true));
    expect($('dl').hasAttribute('data-ped-att-locked')).toBe(true);
    expect(click($('dl')), 'click on the locked download').toBe(true);
    const toasts = said.filter((m) => m.startsWith('Attachment blocked'));
    expect(toasts.length).toBeGreaterThanOrEqual(2);
    for (const m of toasts) expect(m).not.toContain('invoice.pdf');
  });
});
