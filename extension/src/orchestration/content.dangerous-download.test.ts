// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C2 companion: the same safe-scoring email, but its inline download is named invoice.pdf.html (a disguised
// double extension). A dangerous attachment is a warning, and any warning pauses every link in the email
// (AGENTS.md "Lock links and attachments"), so here the links are locked as well as the download.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, gmailMessage, lastVerdict, settled } from './harness';

const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Invoice',
  body: `Hi, please find the invoice for last month attached. The
    <a id="agenda" href="https://northwind.example/billing">billing page</a> has the details. Thanks!
    <a id="dl" download="invoice.pdf.html" href="data:text/html,x">invoice</a>`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await settled(sent);
});

describe('content.ts: safe-scoring email with a dangerous inline download in Gmail', () => {
  it('reports a safe body with a dangerous attachment', () => {
    expect(lastVerdict(sent)).toMatchObject({
      verdict: { level: 'safe' },
      attachments: { count: 1, level: 'danger', names: ['invoice.pdf.html'] },
      trusted: false,
    });
  });

  it('pauses the links too, and blocks the download', () => {
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(true);
    expect($('agenda').hasAttribute('href')).toBe(false);
    expect(click($('agenda'))).toBe(true);
    expect($('dl').hasAttribute('data-ped-att-locked')).toBe(true);
    expect($('dl').hasAttribute('href')).toBe(false);
    expect(click($('dl'))).toBe(true);
    expect(sent.some((m) => m.type === 'openSafeLink' || m.type === 'openWarning')).toBe(false);
  });
});
