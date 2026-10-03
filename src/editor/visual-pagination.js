import { Decoration, DecorationSet } from '../vendor/tiptap/nocturne-tiptap.bundle.js';
import { paginationPluginKey, PAGE_GAP, PAGE_RATIO } from './pagination-state.js';

function updatePaperSheets(container, count, { pageHeight, gap, pageStyle, motion } = {}) {
  const sheets = [...container.querySelectorAll('.page-sheet-bg')];
  for (let index = 0; index < Math.max(sheets.length, count); index++) {
    let sheet = sheets[index];
    if (index >= count) {
      if (sheet.classList.contains('motion-sheet-exiting')) continue;
      sheet.classList.add('motion-sheet-exiting');
      const generation = sheet.__paperGeneration = (sheet.__paperGeneration || 0) + 1;
      const finish = () => { if (generation === sheet.__paperGeneration && sheet.classList.contains('motion-sheet-exiting')) sheet.remove(); };
      if (motion?.run && !motion.reduce()) motion.run(sheet, [{ opacity: getComputedStyle(sheet).opacity }, { opacity: 0 }], { channel: 'paper', duration: 180 }).finished.then(completed => { if (completed) finish(); });
      else finish();
      continue;
    }
    const appearing = !sheet || sheet.classList.contains('motion-sheet-exiting');
    if (!sheet) {
      sheet = document.createElement('div'); sheet.className = 'page-sheet-bg';
      const number = document.createElement('div'); number.className = 'page-number-bg'; number.textContent = String(index + 1);
      sheet.append(number); container.append(sheet);
    }
    sheet.__paperGeneration = (sheet.__paperGeneration || 0) + 1;
    sheet.classList.remove('motion-sheet-exiting');
    Object.assign(sheet.style, { top: `${index * (pageHeight + gap)}px`, height: `${pageHeight}px`, width: pageStyle.width, borderRadius: pageStyle.borderRadius || '4px', boxShadow: pageStyle.boxShadow || 'var(--shadow-float)' });
    if (appearing && motion?.run) motion.run(sheet, [{ opacity: 0 }, { opacity: 1 }], { channel: 'paper', duration: 240 });
  }
}

export function updateActivePageHighlight(editor, pageShell) {
  if (!editor || editor.isDestroyed || !pageShell) return;
  const sheets = [...pageShell.querySelectorAll('.page-sheet-bg:not(.motion-sheet-exiting)')];
  if (!sheets.length) return;
  try {
    const y = editor.view.coordsAtPos(editor.state.selection.head).top - pageShell.getBoundingClientRect().top;
    const stride = Math.round(pageShell.getBoundingClientRect().width * PAGE_RATIO) + PAGE_GAP;
    const index = Math.max(0, Math.min(sheets.length - 1, Math.floor(y / stride)));
    for (let i = 0; i < sheets.length; i++) sheets[i].classList.toggle('active', i === index);
  } catch { /* A composition can briefly leave the DOM selection ahead of the model. */ }
}

function mirroredNode(node, original, copy) {
  const path = [];
  for (let current = node; current && current !== original; current = current.parentNode) path.push([...current.parentNode.childNodes].indexOf(current));
  return path.reverse().reduce((current, index) => current?.childNodes[index], copy);
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
      const text = dom.textContent;
      const rectAt = index => { range.setStart(dom, index); range.setEnd(dom, Math.min(text.length, index + 1)); return range.getBoundingClientRect(); };
      let start = 0;
      while (start < text.length) {
        const rect = rectAt(start);
        add(pos + 1 + offset + start, rect);
        let left = start + 1, right = text.length;
        while (left < right) {
          const middle = Math.floor((left + right) / 2);
          if (rectAt(middle).top < rect.bottom - 2) left = middle + 1;
          else right = middle;
        }
        start = left;
      }
      offset += text.length;
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
    lines.push({ pos: node.isTextblock ? pos + 1 : pos, top: rect.top - origin, bottom: rect.top - origin + height, type: node.isTextblock ? 'inline' : 'block' });
  }
  return lines;
}

function measureLines(view, pageShell) {
  const copy = view.dom.cloneNode(true), wrapper = view.dom.parentElement.cloneNode(false);
  const width = view.dom.getBoundingClientRect().width, blocks = [];
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock && !(node.isBlock && node.isAtom)) return;
    const original = view.nodeDOM(pos), element = original && mirroredNode(original, view.dom, copy);
    if (element?.nodeType === Node.ELEMENT_NODE) blocks.push({ element, node, pos });
    return false;
  });
  copy.querySelectorAll('.ProseMirror-widget').forEach(widget => widget.remove());
  for (const element of [copy, ...copy.querySelectorAll('*')]) element.style.contentVisibility = 'visible';
  Object.assign(copy.style, { minHeight: '0', height: 'auto', width: `${width}px` });
  Object.assign(wrapper.style, { position: 'fixed', left: '-100000px', top: '0', width: `${width}px`, minHeight: '0', height: 'auto', margin: '0', padding: '0', visibility: 'hidden', pointerEvents: 'none', overflow: 'visible' });
  wrapper.setAttribute('aria-hidden', 'true'); wrapper.inert = true;
  wrapper.append(copy); pageShell.append(wrapper);
  try {
    const origin = copy.getBoundingClientRect().top;
    return blocks.flatMap(({ element, node, pos }) => blockLines(element, node, pos, origin));
  } finally { wrapper.remove(); }
}

function setBreaks(view, pageBreaks) {
  const current = paginationPluginKey.getState(view.state)?.pageBreaks || [];
  if (current.length === pageBreaks.length && current.every((item, index) => item.pos === pageBreaks[index].pos && item.type === pageBreaks[index].type && Math.abs(item.height - pageBreaks[index].height) < .5)) return;
  const decorations = pageBreaks.map(item => Decoration.widget(item.pos, () => {
    const spacer = document.createElement('span'); spacer.className = 'pm-page-break-widget';
    spacer.contentEditable = 'false'; spacer.setAttribute('aria-hidden', 'true');
    spacer.style.setProperty('--spacer-height', `${item.height}px`);
    return spacer;
  }, { key: `page-break-${item.pos}-${item.height}`, side: -1, ignoreSelection: true }));
  view.dispatch(view.state.tr.setMeta(paginationPluginKey, { decorations: DecorationSet.create(view.state.doc, decorations), pageBreaks }).setMeta('addToHistory', false));
}

export function calculateVisualPages({ editor, pageShell, overlay, flexible = false, motion }) {
  if (!editor || editor.isDestroyed || !pageShell?.isConnected) return [];
  const view = editor.view;
  if (view.composing || !view.dom.getBoundingClientRect().width) return [];
  const pageStyle = getComputedStyle(pageShell), pageHeight = Math.round(pageShell.getBoundingClientRect().width * PAGE_RATIO);
  const paddingTop = parseFloat(pageStyle.paddingTop) || 0, paddingBottom = parseFloat(pageStyle.paddingBottom) || 0;
  let backgrounds = pageShell.querySelector('.page-sheets-bg');
  const number = pageShell.querySelector('.page-number');
  if (flexible) {
    setBreaks(view, []); pageShell.style.minHeight = '';
    if (backgrounds) updatePaperSheets(backgrounds, 0, { motion });
    if (number) { number.textContent = '1'; number.style.display = 'block'; }
    if (overlay) overlay.style.height = '0px';
    return [{ page: 1, y: 0 }];
  }
  const origin = view.dom.getBoundingClientRect().top - pageShell.getBoundingClientRect().top;
  const stride = pageHeight + PAGE_GAP, lines = measureLines(view, pageShell), pageBreaks = [];
  let shift = 0, pageIndex = 0;
  for (const line of lines) {
    const bottom = origin + line.bottom + shift;
    if (bottom > pageIndex * stride + pageHeight - paddingBottom + .5) {
      pageIndex++;
      const height = Math.max(0, pageIndex * stride + paddingTop - origin - line.top - shift);
      if (height > .5) { pageBreaks.push({ pos: line.pos, type: line.type, height }); shift += height; }
    }
  }
  setBreaks(view, pageBreaks);
  if (!backgrounds) {
    backgrounds = document.createElement('div'); backgrounds.className = 'page-sheets-bg'; backgrounds.setAttribute('aria-hidden', 'true');
    pageShell.prepend(backgrounds);
  }
  const count = pageIndex + 1;
  pageShell.style.minHeight = `${count * pageHeight + (count - 1) * PAGE_GAP}px`;
  updatePaperSheets(backgrounds, count, { pageHeight, gap: PAGE_GAP, pageStyle, motion });
  updateActivePageHighlight(editor, pageShell);
  if (number) number.style.display = 'none';
  if (overlay) overlay.style.height = '0px';
  return Array.from({ length: count }, (_, index) => ({ page: index + 1, y: index * stride }));
}
