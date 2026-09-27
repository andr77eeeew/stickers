/*
 * Outline icons from Lucide (lucide.dev), the set the dashboard uses.
 *
 * ISC License
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Icons = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // [tag, attributes] pairs copied from lucide 1.32.0.
  const NODES = Object.freeze({
    sparkles: [
      ['path', { d: 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z' }],
      ['path', { d: 'M20 2v4' }],
      ['path', { d: 'M22 4h-4' }],
      ['circle', { cx: '4', cy: '20', r: '2' }]
    ],
    'circle-check': [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'm9 12 2 2 4-4' }]
    ],
    'triangle-alert': [
      ['path', { d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' }],
      ['path', { d: 'M12 9v4' }],
      ['path', { d: 'M12 17h.01' }]
    ],
    'octagon-x': [
      ['path', { d: 'm15 9-6 6' }],
      ['path', { d: 'M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z' }],
      ['path', { d: 'm9 9 6 6' }]
    ],
    info: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'M12 16v-4' }],
      ['path', { d: 'M12 8h.01' }]
    ],
    'refresh-cw': [
      ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
      ['path', { d: 'M21 3v5h-5' }],
      ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
      ['path', { d: 'M8 16H3v5' }]
    ],
    download: [
      ['path', { d: 'M12 15V3' }],
      ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
      ['path', { d: 'm7 10 5 5 5-5' }]
    ],
    'trash-2': [
      ['path', { d: 'M10 11v6' }],
      ['path', { d: 'M14 11v6' }],
      ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }],
      ['path', { d: 'M3 6h18' }],
      ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }]
    ],
    settings: [
      ['path', { d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915' }],
      ['circle', { cx: '12', cy: '12', r: '3' }]
    ],
    plug: [
      ['path', { d: 'M12 22v-5' }],
      ['path', { d: 'M15 8V2' }],
      ['path', { d: 'M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z' }],
      ['path', { d: 'M9 8V2' }]
    ],
    'external-link': [
      ['path', { d: 'M15 3h6v6' }],
      ['path', { d: 'M10 14 21 3' }],
      ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]
    ],
    eraser: [
      ['path', { d: 'M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21' }],
      ['path', { d: 'm5.082 11.09 8.828 8.828' }]
    ],
    'file-search': [
      ['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }],
      ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
      ['circle', { cx: '11.5', cy: '14.5', r: '2.5' }],
      ['path', { d: 'M13.3 16.3 15 18' }]
    ]
  });

  // Icon for a status tone, as in the dashboard's check rows.
  const TONE_ICONS = Object.freeze({
    ok: 'circle-check',
    pending: 'triangle-alert',
    problem: 'octagon-x',
    info: 'info'
  });

  function create(name) {
    const nodes = NODES[name];
    if (!nodes) throw new Error(`Unknown icon "${name}"`);
    const svg = document.createElementNS(SVG_NS, 'svg');
    const attributes = {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false'
    };
    for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
    for (const [tag, nodeAttributes] of nodes) {
      const child = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(nodeAttributes)) child.setAttribute(key, value);
      svg.append(child);
    }
    return svg;
  }

  // <span class="icon" data-icon="name"></span> placeholders in static markup.
  function element(name) {
    const holder = document.createElement('span');
    holder.className = 'icon';
    holder.append(create(name));
    return holder;
  }

  function hydrate(scope) {
    for (const holder of scope.querySelectorAll('[data-icon]')) {
      if (!holder.firstChild) holder.append(create(holder.dataset.icon));
    }
  }

  return { NODES, TONE_ICONS, create, element, hydrate };
});
