// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS, inlineAttachmentsIn } from './extract';

const body = (html: string) => {
  document.body.innerHTML = `<div id="m">${html}</div>`;
  return document.getElementById('m')!;
};

describe('inlineAttachmentsIn', () => {
  it('finds image-map, SVG xlink:href and whitespace/newline-obfuscated data: downloads', () => {
    const m = body(`
      <img usemap="#map"><map name="map"><area id="area" download="invoice.html" href="data:text/html;base64,AA=="></map>
      <svg><a id="svg" xlink:href="data:application/octet-stream;base64,AA=="><rect width="5" height="5"/></a></svg>
      <a id="space" href=" data:text/html,x">invoice</a>
      <a id="newline" href="da&#10;ta:text/html,x">statement</a>
      <a id="blob" href="BLOB:https://x.example/1">blob</a>
      <a id="plain" href="https://example.org/page">read more</a>`);
    const ids = inlineAttachmentsIn(m).map((a) => a.element.id);
    expect(ids).toEqual(['area', 'svg', 'space', 'newline', 'blob']);
  });

  it('still finds downloads whose href was stashed by a lock', () => {
    const m = body('<a id="s" data-ped-href="data:text/html,x">x</a><a id="t" data-ped-att-download="a.html">y</a>');
    expect(inlineAttachmentsIn(m).map((a) => a.element.id)).toEqual(['s', 't']);
  });

  it('locks the whole body instead of leaving downloads past the cap live', () => {
    const decoys = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => `<a download="p${i}.jpg" href="data:image/jpeg,AA">p</a>`).join('');
    const m = body(`${decoys}<a id="evil" download="invoice.html" href="data:text/html,x">invoice</a>`);
    const found = inlineAttachmentsIn(m);
    expect(found).toHaveLength(MAX_ATTACHMENTS + 1);
    expect(found[found.length - 1]!.element).toBe(m);
  });
});
