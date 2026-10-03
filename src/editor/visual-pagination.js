import { Decoration, DecorationSet } from '../vendor/tiptap/nocturne-tiptap.bundle.js';
import { paginationPluginKey, PAGE_GAP, PAGE_RATIO } from './pagination-state.js';
import { beginViewportPagination, calculateViewportPagination, clearViewportPagination, normalizePaginationCopy, viewportPaginationActive } from './viewport-pagination.js';

const measurementCache = new WeakMap();

function updatePaperSheets(container, count, { pageHeight, gap, pageStyle, motion } = {}) {
  const sheets = [...container.querySelectorAll('.page-sheet-bg')];
  const animate = motion?.run && !motion.reduce();
  const scroll = container.closest('.editor-scroll-area'), viewport = animate ? scroll?.getBoundingClientRect() : null;
  const origin = animate && viewport ? container.getBoundingClientRect().top : 0;
  const oldStride = parseFloat(container.style.getPropertyValue('--paper-stride')) || pageHeight + gap;
  const stride = pageHeight ? pageHeight + gap : oldStride, overscan = Math.max(oldStride, stride);
  const visible = index => !viewport || [oldStride, stride].some(step => {
    const top = origin + index * step; return top + overscan >= viewport.top - overscan && top <= viewport.bottom + overscan;
  });
  const opacity = new Map(animate ? sheets.flatMap((sheet, index) => {
    const exiting = sheet.classList.contains('motion-sheet-exiting');
    return visible(index) && ((index >= count && !exiting) || (index < count && exiting)) ? [[sheet, getComputedStyle(sheet).opacity]] : [];
  }) : []);
  if (pageStyle) {
    const values = { '--paper-height': `${pageHeight}px`, '--paper-stride': `${pageHeight + gap}px`, '--paper-width': pageStyle.width, '--paper-radius': pageStyle.borderRadius || '4px', '--paper-shadow': pageStyle.boxShadow || 'var(--shadow-float)' };
    for (const [property, value] of Object.entries(values)) if (container.style.getPropertyValue(property) !== value) container.style.setProperty(property, value);
  }
  for (let index = 0; index < Math.max(sheets.length, count); index++) {
    let sheet = sheets[index];
    if (index >= count) {
      if (sheet.classList.contains('motion-sheet-exiting')) continue;
      sheet.classList.add('motion-sheet-exiting');
      const generation = sheet.__paperGeneration = (sheet.__paperGeneration || 0) + 1;
      const finish = () => { if (generation === sheet.__paperGeneration && sheet.classList.contains('motion-sheet-exiting')) sheet.remove(); };
      if (animate && visible(index)) motion.run(sheet, [{ opacity: opacity.get(sheet) }, { opacity: 0 }], { channel: 'paper', duration: 180, startFromCurrent: false }).finished.then(completed => { if (completed) finish(); });
      else finish();
      continue;
    }
    const reviving = sheet?.classList.contains('motion-sheet-exiting'), appearing = !sheet || reviving;
    if (!sheet) {
      sheet = document.createElement('div'); sheet.className = 'page-sheet-bg';
      const number = document.createElement('div'); number.className = 'page-number-bg'; number.textContent = String(index + 1);
      sheet.append(number); container.append(sheet);
    }
    sheet.__paperGeneration = (sheet.__paperGeneration || 0) + 1;
    if (sheet.classList.contains('motion-sheet-exiting')) sheet.classList.remove('motion-sheet-exiting');
    if (sheet.style.getPropertyValue('--paper-index') !== String(index)) sheet.style.setProperty('--paper-index', String(index));
    if (appearing && motion?.run && ((animate && visible(index)) || reviving)) motion.run(sheet, [{ opacity: opacity.get(sheet) ?? (reviving ? 1 : 0) }, { opacity: 1 }], { channel: 'paper', duration: animate && visible(index) ? 240 : 0, startFromCurrent: false });
  }
}

export function updateActivePageHighlight(editor, pageShell) {
  if (!editor || editor.isDestroyed || !pageShell) return;
  const viewport = paginationPluginKey.getState(editor.state)?.viewport;
  if (viewport && (editor.state.selection.head < viewport.from || editor.state.selection.head > viewport.to)) return;
  const sheets = [...pageShell.querySelectorAll('.page-sheet-bg:not(.motion-sheet-exiting)')];
  if (!sheets.length) return;
  try {
    const y = editor.view.coordsAtPos(editor.state.selection.head).top - pageShell.getBoundingClientRect().top;
    const stride = Math.round(pageShell.getBoundingClientRect().width * PAGE_RATIO) + PAGE_GAP;
    const index = Math.max(0, Math.min(sheets.length - 1, Math.floor(y / stride)));
    const active = sheets[index];
    for (const sheet of pageShell.querySelectorAll('.page-sheet-bg.active:not(.motion-sheet-exiting)')) if (sheet !== active) sheet.classList.remove('active');
    if (!active.classList.contains('active')) active.classList.add('active');
  } catch { /* A composition can briefly leave the DOM selection ahead of the model. */ }
}

function blockLines(element, node, pos, origin) {
  const lines = [], range = document.createRange();
  let offset = 0;
  const add = (from, rect) => {
    if (!rect.height) return;
    const last = lines.at(-1), top = rect.top - origin, bottom = rect.bottom - origin;
    if (last && top < last.bottom - 2 && bottom > last.top + 2) { last.top = Math.min(last.top, top); last.bottom = Math.max(last.bottom, bottom); }
    else lines.push({ pos: from, top, bottom, type: 'inline' });
  };
  function scan(dom) {
    if (dom.nodeType === Node.TEXT_NODE) {
      const length = dom.length, startPos = pos + 1 + offset;
      range.selectNodeContents(dom);
      for (const rect of range.getClientRects()) {
        add(() => {
          let left = 0, right = length;
          while (left < right) {
            const middle = Math.floor((left + right) / 2);
            range.setStart(dom, middle); range.setEnd(dom, Math.min(length, middle + 1));
            if (range.getBoundingClientRect().bottom <= rect.top + 2) left = middle + 1;
            else right = middle;
          }
          return startPos + left;
        }, rect);
      }
      offset += length;
    } else if (dom.nodeName === 'BR') {
      range.selectNode(dom);
      add(pos + 1 + offset, range.getBoundingClientRect());
      if (!dom.classList.contains('ProseMirror-trailingBreak')) offset++;
    } else for (const child of dom.childNodes) scan(child);
  }
  scan(element);
  if (!lines.length) {
    const rect = element.getBoundingClientRect();
    const height = Math.min(rect.height, parseFloat(getComputedStyle(element).lineHeight) || rect.height);
    lines.push({ pos: node.isTextblock ? pos + 1 : pos, top: rect.top - origin, bottom: rect.top - origin + height, type: node.isTextblock ? 'inline' : 'block', marginTop: parseFloat(getComputedStyle(element).marginTop) || 0 });
  }
  return lines;
}

function createMeasurement(view) {
  const copy = view.dom.cloneNode(true), wrapper = view.dom.parentElement.cloneNode(false), blocks = [];
  const mirrored = new WeakMap([[view.dom, copy]]), originalWalker = document.createTreeWalker(view.dom, NodeFilter.SHOW_ELEMENT), copyWalker = document.createTreeWalker(copy, NodeFilter.SHOW_ELEMENT);
  let element;
  while ((element = originalWalker.nextNode())) mirrored.set(element, copyWalker.nextNode());
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock && !(node.isBlock && node.isAtom)) return;
    const original = view.nodeDOM(pos), element = original && mirrored.get(original);
    if (element?.nodeType === Node.ELEMENT_NODE) blocks.push({ element, node, pos });
    return false;
  });
  normalizePaginationCopy(copy);
  for (const element of copy.querySelectorAll('[style]')) if (element.style.textIndent === '0px' && view.dom.closest('.indent-paragraphs')) element.style.removeProperty('text-indent');
  return { copy, wrapper, blocks };
}

function measureLines(view, pageShell, consume) {
  const resizing = document.body.classList.contains('resizing-workspace');
  // Pagination metadata changes every frame; only content and other decorations invalidate the hidden copy.
  const pluginStates = view.state.plugins.filter(plugin => plugin.key !== paginationPluginKey.key).map(plugin => plugin.getState(view.state));
  const appShell = pageShell.closest('.app-shell');
  const signature = [view.dom.className, view.dom.style.cssText, view.dom.parentElement.className, view.dom.parentElement.style.cssText, appShell?.className, appShell?.style.cssText, document.body.className].join('\n');
  let cached = measurementCache.get(view);
  if (cached && (cached.doc !== view.state.doc || cached.signature !== signature || cached.pluginStates.length !== pluginStates.length || cached.pluginStates.some((state, index) => state !== pluginStates[index]))) { clearMeasurement(view); cached = null; }
  const measurement = cached || createMeasurement(view);
  if (resizing && !cached) {
    const { wrapper, copy } = measurement;
    wrapper.classList.remove('page-content'); wrapper.classList.add('pagination-measure');
    for (const element of [wrapper, copy, ...copy.querySelectorAll('[id], [data-block-id], [data-source-block-id], [data-doc-id], [data-pane-id]')]) {
      for (const attr of ['id', 'data-block-id', 'data-source-block-id', 'data-doc-id', 'data-pane-id']) element.removeAttribute(attr);
      element.classList.remove('active-block');
    }
    copy.contentEditable = 'false';
    measurementCache.set(view, { ...measurement, doc: view.state.doc, signature, pluginStates });
  }
  const { copy, wrapper, blocks } = measurement, width = view.dom.getBoundingClientRect().width;
  Object.assign(copy.style, { minHeight: '0', height: 'auto', width: `${width}px` });
  Object.assign(wrapper.style, { position: 'fixed', left: '-100000px', top: '0', width: `${width}px`, minHeight: '0', height: 'auto', margin: '0', padding: '0', visibility: 'hidden', pointerEvents: 'none', overflow: 'visible' });
  wrapper.setAttribute('aria-hidden', 'true'); wrapper.inert = true;
  if (copy.parentNode !== wrapper) wrapper.append(copy);
  if (wrapper.parentNode !== pageShell) pageShell.append(wrapper);
  let complete = false;
  try {
    const origin = copy.getBoundingClientRect().top;
    const result = consume(blocks.flatMap(({ element, node, pos }) => blockLines(element, node, pos, origin)));
    complete = true; return result;
  } finally { if (!resizing || !complete) { wrapper.remove(); measurementCache.delete(view); } }
}

function clearMeasurement(view) {
  measurementCache.get(view)?.wrapper.remove();
  measurementCache.delete(view);
}

function setBreaks(view, pageBreaks, extra = [], viewport = null) {
  const current = paginationPluginKey.getState(view.state);
  const decorations = pageBreaks.map(item => {
    const attrs = { 'data-pagination-break': '', style: `--page-spacer-height:${item.height}px;` };
    const $pos = view.state.doc.resolve(item.pos);
    if (item.type === 'block') {
      attrs.class = 'pm-page-start-atom';
      attrs.style += `--page-original-margin:${item.marginTop || 0}px;`;
      return Decoration.node(item.pos, item.pos + $pos.nodeAfter.nodeSize, attrs);
    }
    if (!$pos.nodeAfter) {
      if ($pos.nodeBefore) {
        attrs.class = 'pm-page-end-empty';
        attrs.nodeName = 'span';
        return Decoration.inline(item.pos - $pos.nodeBefore.nodeSize, item.pos, attrs);
      }
      attrs.class = 'pm-page-start-empty';
      return Decoration.node($pos.before(), $pos.after(), attrs);
    }
    const next = $pos.nodeAfter;
    const length = next.isText ? String.fromCodePoint(next.text.codePointAt(0)).length : next.nodeSize;
    attrs.class = 'pm-page-start-inline';
    attrs.nodeName = 'span';
    return Decoration.inline(item.pos, item.pos + length, attrs);
  });
  const set = DecorationSet.create(view.state.doc, [...decorations, ...extra]);
  if (current && current.decorations.eq(set) && current.pageBreaks.length === pageBreaks.length && current.pageBreaks.every((item, index) => item.pos === pageBreaks[index].pos && item.type === pageBreaks[index].type && Math.abs(item.height - pageBreaks[index].height) < .5)) return;
  view.dispatch(view.state.tr.setMeta(paginationPluginKey, { decorations: set, pageBreaks, viewport }).setMeta('addToHistory', false));
}

export function beginVisualResize(editor, pageShell) { if (editor && !editor.isDestroyed) beginViewportPagination(editor.view, pageShell); }

export function disposeVisualPagination(editor) { if (editor && !editor.isDestroyed) { clearMeasurement(editor.view); clearViewportPagination(editor.view); } }

export function calculateVisualPages({ editor, pageShell, overlay, flexible = false, motion }) {
  if (!editor || editor.isDestroyed || !pageShell?.isConnected) return [];
  const view = editor.view;
  if (view.composing || !view.dom.getBoundingClientRect().width) return [];
  const computed = getComputedStyle(pageShell), pageHeight = Math.round(pageShell.getBoundingClientRect().width * PAGE_RATIO);
  const paddingTop = parseFloat(computed.paddingTop) || 0, paddingBottom = parseFloat(computed.paddingBottom) || 0;
  const pageStyle = { width: computed.width, borderRadius: computed.borderRadius, boxShadow: computed.boxShadow };
  let backgrounds = pageShell.querySelector('.page-sheets-bg');
  const number = pageShell.querySelector('.page-number');
  if (flexible) {
    clearMeasurement(view);
    clearViewportPagination(view);
    setBreaks(view, []); pageShell.style.minHeight = '';
    if (backgrounds) updatePaperSheets(backgrounds, 0, { motion });
    if (number) { number.textContent = '1'; number.style.display = 'block'; }
    if (overlay) overlay.style.height = '0px';
    return [{ page: 1, y: 0 }];
  }
  const origin = view.dom.getBoundingClientRect().top - pageShell.getBoundingClientRect().top;
  const stride = pageHeight + PAGE_GAP, pageBreaks = [];
  const resizing = document.body.classList.contains('resizing-workspace');
  const partial = resizing ? calculateViewportPagination(view, pageShell, { pageHeight, paddingTop, paddingBottom }, blockLines) : null;
  let anchor;
  if (!partial && paginationPluginKey.getState(view.state)?.viewport) {
    const scroll = pageShell.closest('.editor-scroll-area'), bounds = scroll.getBoundingClientRect();
    const point = view.posAtCoords({ left: view.dom.getBoundingClientRect().left + 12, top: bounds.top + 15 });
    const viewport = paginationPluginKey.getState(view.state).viewport;
    if (point && point.pos >= viewport.from && point.pos <= viewport.to) anchor = { scroll, pos: point.pos, top: view.coordsAtPos(point.pos).top };
  }
  if (!resizing) clearViewportPagination(view);
  let shift = 0, pageIndex = 0;
  if (!partial) measureLines(view, pageShell, lines => {
    for (const line of lines) {
      const bottom = origin + line.bottom + shift;
      if (bottom > pageIndex * stride + pageHeight - paddingBottom + .5) {
        pageIndex++;
        const height = Math.max(0, pageIndex * stride + paddingTop - origin - line.top - shift);
        if (height > .5) { pageBreaks.push({ pos: typeof line.pos === 'function' ? line.pos() : line.pos, type: line.type, height, ...(line.type === 'block' ? { marginTop: line.marginTop } : {}) }); shift += height; }
      }
    }
  });
  if (!backgrounds) {
    backgrounds = document.createElement('div'); backgrounds.className = 'page-sheets-bg'; backgrounds.setAttribute('aria-hidden', 'true');
    pageShell.prepend(backgrounds);
  }
  const count = partial ? partial.count : pageIndex + 1;
  pageShell.style.minHeight = `${count * pageHeight + (count - 1) * PAGE_GAP}px`;
  updatePaperSheets(backgrounds, count, { pageHeight, gap: PAGE_GAP, pageStyle, motion });
  setBreaks(view, partial ? partial.pageBreaks : pageBreaks, partial?.decorations, partial?.viewport);
  if (anchor) {
    const behavior = anchor.scroll.style.scrollBehavior; anchor.scroll.style.scrollBehavior = 'auto';
    anchor.scroll.scrollTop += view.coordsAtPos(anchor.pos).top - anchor.top;
    anchor.scroll.style.scrollBehavior = behavior;
  }
  updateActivePageHighlight(editor, pageShell);
  if (number) number.style.display = 'none';
  if (overlay) overlay.style.height = '0px';
  if (resizing && !partial && !viewportPaginationActive(view)) {
    beginViewportPagination(view, pageShell);
    if (viewportPaginationActive(view)) return calculateVisualPages({ editor, pageShell, overlay, flexible, motion });
  }
  return Array.from({ length: count }, (_, index) => ({ page: index + 1, y: index * stride }));
}
