// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C17: an email with more distinct links than are scored (src/adapters/extract.ts MAX_LINKS). Every link the scan
// samples is harmless, but the rest could not be checked, so the email fails closed (entrypoints/content.ts
// withTooManyLinks): an "unchecked" verdict with its links paused, never a safe one that leaves them open.
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_LINKS } from '../adapters/extract';
import {
  $,
  type Msg,
  bootContent,
  click,
  gmailMessage,
  lastVerdict,
  lookups,
  navigations,
  quietly,
  settled,
} from './harness';

const COUNT = MAX_LINKS + 1;
const link = (i: number) => `<a id="i${i}" href="https://northwind.example/item/${i}">Item ${i}</a>`;
const LINKS = Array.from({ length: COUNT }, (_, i) => link(i));
const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Catalogue',
  body: `Hi, this season's catalogue:
    ${LINKS.join(' ')}`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await quietly(settled(sent));
});

const body = () => document.querySelector<HTMLElement>('div.a3s')!;

describe('content.ts: email with more links than are checked', () => {
  it('reports an unchecked verdict for the too many links, not a safe one', () => {
    expect(lastVerdict(sent)).toMatchObject({
      verdict: {
        level: 'suspicious',
        unchecked: true,
        reasons: ['This email has too many links to check them all, so its links are paused'],
      },
      sender: { address: 'jordan@northwind.example', warnings: [] },
      trusted: false,
    });
    expect(lookups(sent)).toEqual(['northwind.example']);
  });

  it('pauses the links, also the ones that were never sampled', () => {
    expect(body().hasAttribute('data-ped-locked'), 'body locked').toBe(true);
    for (const id of ['i0', `i${COUNT - 1}`]) {
      expect($(id).hasAttribute('href'), id).toBe(false);
      expect(click($(id)), id).toBe(true);
    }
    expect(navigations(sent)).toEqual([]);
  });
});
