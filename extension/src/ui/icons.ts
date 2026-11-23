// Inline SVG icon builders using createElementNS only (never innerHTML) so CSP stays strict.
const SVG_NS = 'http://www.w3.org/2000/svg';
let uid = 0;

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

/** Brand emblem: blue gradient security shield + white envelope + emerald check badge. */
export function createLogoSvg(doc: Document, size = 24): SVGSVGElement {
  const s = svgRoot(doc, size);
  const gradId = `ped-shield-${++uid}`;
  const defs = svgEl(doc, 'defs', {});
  const lg = svgEl(doc, 'linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
  lg.append(
    svgEl(doc, 'stop', { offset: '0%', 'stop-color': '#2563eb' }),
    svgEl(doc, 'stop', { offset: '100%', 'stop-color': '#1e3a8a' }),
  );
  defs.append(lg);

  const shield = svgEl(doc, 'path', {
    d: 'M12 2.2 L4.4 5.2 C4 5.4 3.8 5.8 3.8 6.3 C3.8 13.4 6.9 18.8 12 21.8 C17.1 18.8 20.2 13.4 20.2 6.3 C20.2 5.8 20 5.4 19.6 5.2 Z',
    fill: `url(#${gradId})`,
    stroke: '#93c5fd',
    'stroke-opacity': '0.45',
    'stroke-width': '0.8',
  });
  const env = svgEl(doc, 'rect', {
    x: '6.6',
    y: '8.3',
    width: '10.8',
    height: '7.4',
    rx: '1.3',
    fill: '#ffffff',
  });
  const flap = svgEl(doc, 'path', {
    d: 'M7.3 9.2 L12 12.7 L16.7 9.2',
    fill: 'none',
    stroke: '#1e3a8a',
    'stroke-width': '1.25',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  const badge = svgEl(doc, 'circle', {
    cx: '17.6',
    cy: '16.9',
    r: '4',
    fill: '#10b981',
    stroke: '#1e3a8a',
    'stroke-width': '1.2',
  });
  const check = svgEl(doc, 'path', {
    d: 'M15.8 16.9 L17.1 18.2 L19.4 15.6',
    fill: 'none',
    stroke: '#ffffff',
    'stroke-width': '1.3',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });

  s.append(defs, shield, env, flap, badge, check);
  return s;
}

/** Semantic state icon (shield check, warning triangle, or danger shield). */
export function createStatusIcon(doc: Document, kind: 'safe' | 'warning' | 'danger', size = 20): SVGSVGElement {
  const s = svgRoot(doc, size);
  const strokeAttrs = {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.9',
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
      svgEl(doc, 'circle', { cx: '12', cy: '16.8', r: '1', fill: 'currentColor' }),
    );
    return s;
  }

  s.append(
    svgEl(doc, 'path', {
      d: 'M12 2.5 L4.5 5.6 V11.4 C4.5 16.3 7.7 20.2 12 21.7 C16.3 20.2 19.5 16.3 19.5 11.4 V5.6 Z',
      ...strokeAttrs,
    }),
    svgEl(doc, 'path', { d: 'M12 8 V12.6', ...strokeAttrs }),
    svgEl(doc, 'circle', { cx: '12', cy: '15.8', r: '1', fill: 'currentColor' }),
  );
  return s;
}

/** Small padlock icon for the "Links paused" indicator pill. */
export function createLockIcon(doc: Document, size = 12): SVGSVGElement {
  const s = svgRoot(doc, size);
  s.append(
    svgEl(doc, 'path', {
      d: 'M7.5 10.5 V7.5 C7.5 5 9.5 3 12 3 C14.5 3 16.5 5 16.5 7.5 V10.5',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
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
      'stroke-width': '2',
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
