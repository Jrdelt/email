// @vitest-environment happy-dom
// A locked attachment must not open by any event the webmail may act on. Webmail controls decide which event opens a
// file: a role=button card can open on keyup (Space), on pointerup/mouseup, from a touch handler, or from its own
// right-click menu ("Download", "Open in new tab"), which is drawn outside the locked card. The Gmail inbox-list
// guard in content.ts refuses all of those; the attachment lock of an opened email must too.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockAttachments, setAttachmentBlockedHandler, unlockAttachments } from './attachmentLock';

const $ = (id: string) => document.getElementById(id)!;

function card() {
  document.body.innerHTML = `<div id="shelf"><div id="card" role="button" tabindex="0" aria-label="invoice.pdf">
    <span id="label">invoice.pdf</span></div></div>`;
  const opened: string[] = [];
  // The webmail's own handlers, bound on the card as Outlook/Gmail do.
  for (const type of ['contextmenu', 'mouseup', 'pointerup', 'keyup', 'touchstart', 'touchend']) {
    $('card').addEventListener(type, (e) => opened.push(e.type === 'keyup' ? `keyup:${(e as KeyboardEvent).key}` : e.type));
  }
  return opened;
}

afterEach(() => {
  unlockAttachments([$('shelf')]);
  setAttachmentBlockedHandler(document, null);
});

describe('attachment lock: every activation path', () => {
  it('keeps mouseup, pointerup and the context menu away from a locked card, and cancels them', () => {
    const opened = card();
    lockAttachments([$('shelf')], new Map([[$('shelf'), 'invoice.pdf']]));
    for (const type of ['mouseup', 'pointerup', 'contextmenu']) {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'contextmenu' ? 2 : 0 });
      $('label').dispatchEvent(ev);
      expect(ev.defaultPrevented, type).toBe(true);
    }
    expect(opened).toEqual([]);
  });

  it('refuses keyup Enter/Space but lets other keys through', () => {
    const opened = card();
    lockAttachments([$('shelf')]);
    for (const key of [' ', 'Enter']) {
      const ev = new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true });
      $('card').dispatchEvent(ev);
      expect(ev.defaultPrevented, key).toBe(true);
    }
    $('card').dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(opened).toEqual(['keyup:Tab']);
  });

  it('keeps touch events away from the card without cancelling them (scrolls that start on it still work)', () => {
    const opened = card();
    lockAttachments([$('shelf')]);
    for (const type of ['touchstart', 'touchend']) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      $('label').dispatchEvent(ev);
      expect(ev.defaultPrevented, type).toBe(false);
    }
    expect(opened).toEqual([]);
  });

  it('explains a refused right-click with the notice and brings the banner back', () => {
    card();
    const onBlocked = vi.fn();
    setAttachmentBlockedHandler(document, onBlocked);
    const said: string[] = [];
    (document as Document & { ariaNotify?: (m: string) => void }).ariaNotify = (m) => void said.push(m);
    lockAttachments([$('shelf')], new Map([[$('shelf'), 'invoice.pdf']]));
    $('label').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(said).toEqual([expect.stringContaining('Attachment blocked (invoice.pdf)')]);
    // mouseup/pointerup belong to a press whose click already explains itself: no second notice.
    $('label').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it('leaves the card alone once unlocked', () => {
    const opened = card();
    lockAttachments([$('shelf')]);
    unlockAttachments([$('shelf')]);
    $('label').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    $('card').dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
    expect(opened).toEqual(['contextmenu', 'keyup: ']);
  });
});
