// Inline SVG icon builders using createElementNS only (never innerHTML) so CSP stays strict.
import { SVG_NS } from '../dom';

function svgRoot(doc: Document, size: number, viewBox = '0 0 24 24'): SVGSVGElement {
  const s = doc.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  return s;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** Neo-brutalist brand emblem: offset black shadow, mint tile, white envelope, coral check seal. */
export function createLogoSvg(doc: Document, size = 28): SVGSVGElement {
  const s = svgRoot(doc, size, '0 0 28 28');
  s.append(
    svgEl(doc, 'rect', { x: '4', y: '4', width: '19.5', height: '19.5', rx: '4.6', fill: '#111111' }),
    svgEl(doc, 'rect', {
      x: '2',
      y: '2',
      width: '19.5',
      height: '19.5',
      rx: '4.6',
      fill: '#26d08c',
      stroke: '#111111',
      'stroke-width': '1.9',
    }),
    svgEl(doc, 'rect', {
      x: '5.5',
      y: '7.5',
      width: '12.5',
      height: '8.5',
      rx: '1.5',
      fill: '#ffffff',
      stroke: '#111111',
      'stroke-width': '1.6',
    }),
    svgEl(doc, 'path', {
      d: 'M6.2 8.4 L11.75 12.6 L17.3 8.4',
      fill: 'none',
      stroke: '#111111',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
    svgEl(doc, 'circle', { cx: '21.3', cy: '21.3', r: '4.7', fill: '#111111' }),
    svgEl(doc, 'circle', {
      cx: '20.5',
      cy: '20.5',
      r: '4.7',
      fill: '#ff563f',
      stroke: '#111111',
      'stroke-width': '1.7',
    }),
    svgEl(doc, 'path', {
      d: 'M18.6 20.6 L19.9 21.9 L22.5 19.2',
      fill: 'none',
      stroke: '#ffffff',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );
  return s;
}

/** Bold geometric status icons (shield check, warning triangle, or danger shield). */
export function createStatusIcon(doc: Document, kind: 'safe' | 'warning' | 'danger', size = 22): SVGSVGElement {
  const s = svgRoot(doc, size);
  const strokeAttrs = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2.2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };

  if (kind === 'safe') {
    s.append(
      svgEl(doc, 'path', {
        d: 'M12 2.5 L4.5 5.6 V11.4 C4.5 16.3 7.7 20.2 12 21.7 C16.3 20.2 19.5 16.3 19.5 11.4 V5.6 Z',
        ...strokeAttrs,
      }),
      svgEl(doc, 'path', { d: 'M8.8 12.1 L11 14.3 L15.4 9.8', ...strokeAttrs }),
    );
    return s;
  }

  if (kind === 'warning') {
    s.append(
      svgEl(doc, 'path', {
        d: 'M10.4 4.1 L2.8 17.5 C2.2 18.6 3 20 4.3 20 H19.7 C21 20 21.8 18.6 21.2 17.5 L13.6 4.1 C12.9 2.9 11.1 2.9 10.4 4.1 Z',
        ...strokeAttrs,
      }),
      svgEl(doc, 'path', { d: 'M12 9.2 V13.6', ...strokeAttrs }),
      svgEl(doc, 'circle', { cx: '12', cy: '16.9', r: '1.1', fill: 'currentColor' }),
    );
    return s;
  }

  s.append(
    svgEl(doc, 'path', {
      d: 'M12 2.5 L4.5 5.6 V11.4 C4.5 16.3 7.7 20.2 12 21.7 C16.3 20.2 19.5 16.3 19.5 11.4 V5.6 Z',
      ...strokeAttrs,
    }),
    svgEl(doc, 'path', { d: 'M12 8 V12.6', ...strokeAttrs }),
    svgEl(doc, 'circle', { cx: '12', cy: '15.9', r: '1.1', fill: 'currentColor' }),
  );
  return s;
}

/** Small padlock icon for paused-links indicator pills. */
export function createLockIcon(doc: Document, size = 12): SVGSVGElement {
  const s = svgRoot(doc, size);
  s.append(
    svgEl(doc, 'path', {
      d: 'M7.5 10.5 V7.5 C7.5 5 9.5 3 12 3 C14.5 3 16.5 5 16.5 7.5 V10.5',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2.2',
      'stroke-linecap': 'round',
    }),
    svgEl(doc, 'rect', {
      x: '5',
      y: '10.5',
      width: '14',
      height: '10.5',
      rx: '2.5',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2.2',
    }),
  );
  return s;
}

/** Crisp close (X) icon for dismissing the banner. */
export function createCloseIcon(doc: Document, size = 14): SVGSVGElement {
  const s = svgRoot(doc, size);
  s.append(
    svgEl(doc, 'path', {
      d: 'M6 6 L18 18 M18 6 L6 18',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2.2',
      'stroke-linecap': 'round',
    }),
  );
  return s;
}
