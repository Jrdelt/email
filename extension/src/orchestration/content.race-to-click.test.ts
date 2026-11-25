// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C3: the 400 ms race-to-click gate in entrypoints/content.ts. On a harmless email, a click made before the first
// debounced scan has run is still held (nothing is known about the email yet); the scan is run at once and, as it
// finds nothing, the held click is released through the background (openSafeLink). Once scanning is idle, the
// same click goes through natively: the hold came from the gate, not from a lock.
// The phishing case (held click dropped after the scan locks the email) is in content.phishing.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, gmailMessage, lastVerdict, settled, until, verdictsOf } from './harness';

const HREF = 'https://northwind.example/agenda';
const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Agenda',
  body: `Hi team, the <a id="link" href="${HREF}">agenda</a> for Tuesday is on the wiki. Thanks!`,
});

let sent: Msg[];
let verdictsBeforeEarlyClick: number;
let earlyClickCancelled: boolean;

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  verdictsBeforeEarlyClick = verdictsOf(sent).length;
  earlyClickCancelled = click($('link'));
});

const opened = () => sent.filter((m) => m.type === 'openSafeLink');

describe('content.ts: race-to-click gate', () => {
  it('holds a click dispatched before the first scan has run', () => {
    expect(verdictsBeforeEarlyClick).toBe(0);
    expect(earlyClickCancelled).toBe(true);
  });

  it('releases the held click through the background once the scan finds the email safe', async () => {
    await until(() => expect(opened()).toEqual([{ type: 'openSafeLink', href: HREF, active: true }]));
    await settled(sent);
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, trusted: false });
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(false);
    expect(sent.some((m) => m.type === 'openWarning')).toBe(false);
  });

  it('lets the same click through natively once scanning is idle', () => {
    expect(click($('link'))).toBe(false);
    expect(opened()).toHaveLength(1); // not routed through the background again
  });
});
