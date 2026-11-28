// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// A click on an external link right after an email opens, while the sender's own domain lookup is still running,
// is held for the destination's lookup (and the sender's verdict). If the sender lookup brings a domain warning
// during that wait, the email is locked (AGENTS.md: a domain warning pauses every link), so the held click must
// not open afterwards, whatever the destination's lookup says or however long it takes.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, gmailMessage, navigations, tick, until } from './harness';

const DAY = 86_400_000;
const intelFor = (domain: string, over: { rdap?: object; dns?: object } = {}) => ({
  domain,
  checkedAt: new Date().toISOString(),
  rdap: { status: 'ok', registered: new Date(Date.now() - 900 * DAY).toISOString() },
  dns: { status: 'ok', mx: ['mx.example.net'], nxdomain: false },
  reputation: { status: 'ok', source: 'URIBL', listed: [] },
  ...over,
});
const nxdomain = (domain: string) =>
  intelFor(domain, { rdap: { status: 'notfound' }, dns: { status: 'ok', mx: [], nxdomain: true } });

// Every lookup is held until the test answers it (`answers` keeps the latest one per domain, `calls` all of them).
const answers = new Map<string, (intel: unknown) => void>();
const calls = new Map<string, ((intel: unknown) => void)[]>();
const held = (domain: unknown) =>
  new Promise((resolve) => {
    answers.set(String(domain), resolve);
    calls.set(String(domain), [...(calls.get(String(domain)) ?? []), resolve]);
  });
const lookupsOf = (domain: string) => calls.get(domain) ?? [];

const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Form',
  body: `Hi, please fill in the <a id="link" href="https://contoso.example/form">form</a> by Friday.`,
});
const NEXT = gmailMessage({
  name: 'Sam Rivera',
  email: 'sam@fabrikam.example',
  subject: 'Survey',
  body: `Hi, the <a id="link2" href="https://tailspin.example/survey">survey</a> closes on Monday.`,
});
const THIRD = gmailMessage({
  name: 'Kim Abercrombie',
  email: 'kim@adatum.example',
  subject: 'Report',
  body: `Hi, the <a id="link3" href="https://wingtip.example/report">report</a> is ready.`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, { intel: held }));
});

const body = () => document.querySelector<HTMLElement>('div.a3s')!;
const toast = () => document.getElementById('ped-toast-host');

describe('content.ts: a held click after the sender lookup locks the email', () => {
  it('does not open when the destination lookup answers after the lock', async () => {
    await until(() => expect(answers.has('northwind.example')).toBe(true));
    expect(body().hasAttribute('data-ped-locked')).toBe(false);
    const mark = sent.length;
    expect(click($('link'))).toBe(true);
    await until(() => expect(answers.has('contoso.example')).toBe(true));

    answers.get('northwind.example')!(nxdomain('northwind.example'));
    await until(() => expect(body().hasAttribute('data-ped-locked')).toBe(true));
    answers.get('contoso.example')!(intelFor('contoso.example')); // an established destination
    for (let i = 0; i < 5; i++) await tick();

    expect(navigations(sent, mark)).toEqual([]);
    expect(toast(), '"link paused" notice').not.toBeNull();
  });

  it('does not open when the destination lookup never answers', async () => {
    toast()?.remove();
    document.body.innerHTML = NEXT; // the webmail shows another conversation
    await until(() => expect(answers.has('fabrikam.example')).toBe(true));
    expect(body().hasAttribute('data-ped-locked')).toBe(false);
    const mark = sent.length;
    expect(click($('link2'))).toBe(true);
    await until(() => expect(answers.has('tailspin.example')).toBe(true));

    answers.get('fabrikam.example')!(nxdomain('fabrikam.example'));
    await until(() => expect(body().hasAttribute('data-ped-locked')).toBe(true));
    // The notice comes as soon as the lock lands, without waiting out the destination lookup.
    await until(() => expect(toast(), '"link paused" notice').not.toBeNull(), 1000);
    await new Promise((resolve) => setTimeout(resolve, 2700)); // past the longest click-time wait
    expect(navigations(sent, mark)).toEqual([]);
  }, 10_000);

  it('follows a rescan of the thread to the sender lookup that renders', async () => {
    toast()?.remove();
    document.body.innerHTML = THIRD;
    await until(() => expect(lookupsOf('adatum.example')).toHaveLength(1));
    const mark = sent.length;
    expect(click($('link3'))).toBe(true);
    await until(() => expect(lookupsOf('wingtip.example')).toHaveLength(1));
    answers.get('wingtip.example')!(intelFor('wingtip.example')); // an established destination

    // The webmail updates the open message (same sender): the rescan starts its own lookup of the sender domain.
    body().append(' (updated)');
    await until(() => expect(lookupsOf('adatum.example')).toHaveLength(2));
    // The replaced scan's lookup answers first. That scan is stale and renders nothing, so the click keeps waiting.
    lookupsOf('adatum.example')[0]!(nxdomain('adatum.example'));
    for (let i = 0; i < 5; i++) await tick();
    expect(navigations(sent, mark)).toEqual([]);

    lookupsOf('adatum.example')[1]!(nxdomain('adatum.example'));
    await until(() => expect(body().hasAttribute('data-ped-locked')).toBe(true));
    await until(() => expect(toast(), '"link paused" notice').not.toBeNull());
    expect(navigations(sent, mark)).toEqual([]);
  });
});
