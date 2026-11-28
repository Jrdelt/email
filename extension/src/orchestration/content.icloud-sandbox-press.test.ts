// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://p55-mail.icloud-sandbox.com/applications/mail2-message/current/en-us/index.html"}
// An iCloud message frame looks up a pressed element among its inline downloads only while its decision is pending
// (a scan is due or the app frame has not answered yet), and extracts the body for that at most once per DOM change.
// Once decided, a press in the body extracts nothing (AGENTS.md: content script idle CPU ~0).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { extractICloudSandbox } from '../adapters/icloud';
import { $, type Msg, bootContent, click, deliver, fire, tick, until } from './harness';

vi.mock('../adapters/icloud', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../adapters/icloud')>();
  return { ...mod, extractICloudSandbox: vi.fn(mod.extractICloudSandbox) };
});

const PAGE = `<p id="text">This week's newsletter: new recipes, garden tips and the club calendar.</p>
  <a id="link" href="https://club.example/calendar">Calendar</a>`;

let sent: Msg[];
const extractions = vi.mocked(extractICloudSandbox);
const press = (el: Element) => {
  fire(el, 'pointerdown');
  fire(el, 'mousedown');
  click(el);
};

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  const report = await until(() => {
    const r = sent.find((m) => m.type === 'icloudBody' && m.active === true);
    expect(r).toBeDefined();
    return r!;
  });
  await deliver({ type: 'icloudLock', locked: false, attachmentsLocked: false, sig: report.sig });
  await tick();
});

describe('content.ts: iCloud message frame, presses in the body', () => {
  it('extracts nothing for presses once the frame is decided', () => {
    extractions.mockClear();
    press($('text'));
    press($('text'));
    expect(extractions).not.toHaveBeenCalled();
  });

  it('extracts once per DOM change while a decision is pending', async () => {
    document.body.append(document.createElement('span'));
    await tick();
    extractions.mockClear();
    press($('text'));
    press($('text'));
    expect(extractions).toHaveBeenCalledTimes(1);
  });
});
