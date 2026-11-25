// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C14: Gmail's inbox list shows file buttons on rows of emails that were never opened, so never scanned
// (src/adapters/gmail.ts listAttachmentAt). Every way of opening such a file from the list (click, Enter/Space,
// middle click, and the mousedown / drag that start a download) is cancelled, with a notice to open the email first;
// the rest of the row (its subject) still works. Markup as in src/adapters/extract.test.ts
// "Gmail inbox-list file buttons".
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, fire, press, until, verdictsOf } from './harness';

const PAGE = `<div role="main"><table><tbody>
  <tr class="zA zE" role="row" id="row"><td><span class="yP" email="it@evil.example" name="IT Desk">IT Desk</span></td>
    <td><span class="bog" id="subj">Invoice</span>
      <div class="brc"><div class="brg" role="link" tabindex="0" id="chip"><span id="chiptext">invoice.html</span></div></div>
      <a id="dl" href="https://mail.google.com/mail/u/0/?ui=2&ik=x&attid=0.1&permmsgid=msg-f:1&view=att&disp=safe">invoice.html</a>
    </td></tr></tbody></table></div>`;

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await until(() => expect(verdictsOf(sent)).toEqual([null])); // the list view holds no opened email
});

const toast = () => document.getElementById('ped-toast-host');
/** Dispatch on a fresh page (no notice shown) and report [cancelled, notice shown]. */
const attempt = (dispatch: () => boolean): [boolean, boolean] => {
  toast()?.remove();
  const cancelled = dispatch();
  return [cancelled, toast() !== null];
};

describe('content.ts: Gmail inbox-list file buttons', () => {
  it('cancels a click on a file chip (and on the text inside it) and shows a notice', () => {
    expect(attempt(() => click($('chiptext')))).toEqual([true, true]);
    expect(attempt(() => click($('chip')))).toEqual([true, true]);
  });

  it('cancels Enter and Space on the chip and on a list download link, with a notice', () => {
    expect(attempt(() => press($('chip'), 'Enter'))).toEqual([true, true]);
    expect(attempt(() => press($('chip'), ' '))).toEqual([true, true]);
    expect(attempt(() => press($('dl'), 'Enter'))).toEqual([true, true]);
  });

  it('cancels a middle click with a notice, and mousedown / dragstart silently', () => {
    expect(attempt(() => fire($('dl'), 'auxclick', { button: 1 }))).toEqual([true, true]);
    expect(attempt(() => fire($('chip'), 'mousedown'))).toEqual([true, false]);
    expect(attempt(() => fire($('dl'), 'dragstart'))).toEqual([true, false]);
  });

  it('ignores other keys on the chip and lets a click on the row subject through', () => {
    expect(attempt(() => press($('chip'), 'a'))).toEqual([false, false]);
    expect(attempt(() => click($('subj')))).toEqual([false, false]);
    expect(attempt(() => click($('row')))).toEqual([false, false]);
  });
});
