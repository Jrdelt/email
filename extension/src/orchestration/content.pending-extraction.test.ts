// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// While a scan is pending (any DOM change starts the 400 ms debounce), a press on something the last scan did not
// see is looked up in a fresh extraction of the page, so that an attachment that just appeared is still held. That
// extraction covers every open message: it must run at most once per DOM change, not on each of the pointerdown,
// mousedown and click of every press, and never for Space/Enter typed into a reply (AGENTS.md: debounce DOM
// mutations, content script idle CPU ~0).
import type { MockInstance } from 'vitest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { gmail } from '../adapters/gmail';
import { $, type Msg, bootContent, click, fire, gmailMessage, press, quietly, settled, tick } from './harness';

const PAGE = `${gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Agenda',
  body: 'Hi team, the agenda for Tuesday is on the wiki. Thanks!',
})}
  <div id="toolbar" role="button">Archive</div>
  <textarea id="reply"></textarea>
  <div id="editor" contenteditable="true">Thanks, see you there</div>`;

let sent: Msg[];
let extractions: MockInstance;

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await quietly(settled(sent));
  extractions = vi.spyOn(gmail, 'extractAll');
});

/** Any DOM change (a hover card, a keystroke in the reply): a scan is now pending. */
const domChange = async () => {
  document.body.append(document.createElement('span'));
  await tick();
};

describe('content.ts: click-time extraction while a scan is pending', () => {
  it('two presses outside any email extract the page once', async () => {
    await domChange();
    extractions.mockClear();
    for (let i = 0; i < 2; i++) {
      fire($('toolbar'), 'pointerdown');
      fire($('toolbar'), 'mousedown');
      click($('toolbar'));
    }
    expect(extractions).toHaveBeenCalledTimes(1);
  });

  it('Space and Enter typed into a reply never extract', async () => {
    await domChange();
    extractions.mockClear();
    for (const key of [' ', 'Enter']) {
      expect(press($('reply'), key)).toBe(false);
      expect(press($('editor'), key)).toBe(false);
    }
    expect(extractions).not.toHaveBeenCalled();
  });

  it('an attachment that appears after a press is still held (the extraction is redone after a DOM change)', async () => {
    await domChange();
    fire($('toolbar'), 'pointerdown');
    const chip = document.createElement('span');
    chip.className = 'aZo';
    chip.textContent = 'invoice.pdf';
    document.querySelector('div.adn')!.append(chip);
    await tick();
    expect(fire(chip, 'mousedown'), 'press on the new attachment held').toBe(true);
    expect(click(chip), 'click on the new attachment held').toBe(true);
  });
});
