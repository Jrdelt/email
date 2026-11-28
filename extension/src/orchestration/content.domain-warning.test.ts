// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C8: domain warnings. The email's body scores safe and it is shown unlocked while its sender's domain is looked
// up; when the lookup answers with a warning (src/domainIntel.ts intelWarnings: the domain does not exist, or was
// registered days ago), the re-rendered verdict pauses every link (AGENTS.md: a domain/spam warning locks links).
// Both answers are held back by the test, so the unlocked state before them is observable.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, gmailMessage, lastVerdict, navigations, tick, until } from './harness';

const DAY = 86_400_000;
const intelFor = (domain: string, over: { rdap?: object; dns?: object }) => ({
  domain,
  checkedAt: new Date().toISOString(),
  rdap: { status: 'ok', registered: new Date(Date.now() - 900 * DAY).toISOString() },
  dns: { status: 'ok', mx: ['mx.example.net'], nxdomain: false },
  ...over,
});
const NXDOMAIN = intelFor('northwind.example', {
  rdap: { status: 'notfound' },
  dns: { status: 'ok', mx: [], nxdomain: true },
});
const BRAND_NEW = intelFor('fabrikam.example', {
  rdap: { status: 'ok', registered: new Date(Date.now() - 3 * DAY).toISOString() },
});

const answers = new Map<string, (intel: unknown) => void>();
const held = (domain: unknown) => new Promise((resolve) => answers.set(String(domain), resolve));

const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Agenda',
  body: `Hi team, the <a id="link" href="https://northwind.example/agenda">agenda</a> for Tuesday is on the wiki.`,
});
const NEXT = gmailMessage({
  name: 'Sam Rivera',
  email: 'sam@fabrikam.example',
  subject: 'Minutes',
  body: `Hi, the <a id="link2" href="https://fabrikam.example/minutes">minutes</a> are on the wiki.`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, { intel: held }));
});

const body = () => document.querySelector<HTMLElement>('div.a3s')!;

describe('content.ts: sender domain warnings lock a safe-scoring email', () => {
  it('shows the email unlocked while the sender lookup is pending', async () => {
    await until(() => expect(answers.has('northwind.example')).toBe(true));
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, intel: 'loading', trusted: false });
    expect(body().hasAttribute('data-ped-locked')).toBe(false);
    expect($('link').getAttribute('href')).toBe('https://northwind.example/agenda');
  });

  it('locks the email once the lookup reports that the sender domain does not exist', async () => {
    answers.get('northwind.example')!(NXDOMAIN);
    await until(() => expect(body().hasAttribute('data-ped-locked')).toBe(true));
    expect(lastVerdict(sent)).toMatchObject({
      verdict: { level: 'safe' }, // the body itself still scores safe: the lock comes from the domain warning
      intel: { domain: 'northwind.example' },
      trusted: false,
    });
    expect(document.getElementById('ped-banner-host')).not.toBeNull();
    expect($('link').hasAttribute('href')).toBe(false);
    expect(click($('link'))).toBe(true);
    await tick();
    expect(navigations(sent)).toEqual([]);
  });

  it('locks the next email once its lookup reports a domain registered days ago', async () => {
    document.body.innerHTML = NEXT; // the webmail shows another conversation
    await until(() => expect(answers.has('fabrikam.example')).toBe(true));
    expect(lastVerdict(sent)).toMatchObject({ sender: { address: 'sam@fabrikam.example' }, intel: 'loading' });
    expect(body().hasAttribute('data-ped-locked')).toBe(false);
    answers.get('fabrikam.example')!(BRAND_NEW);
    await until(() => expect(body().hasAttribute('data-ped-locked')).toBe(true));
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, intel: { domain: 'fabrikam.example' } });
    expect($('link2').hasAttribute('href')).toBe(false);
  });
});
