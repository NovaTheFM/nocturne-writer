import { Decoration } from '../vendor/tiptap/nocturne-tiptap.bundle.js';
import { paginationPluginKey, PAGE_GAP } from './pagination-state.js';

const sessions = new WeakMap();

function typography(view) {
  const style = getComputedStyle(view.dom);
  return [style.fontFamily, style.fontSize, style.lineHeight, style.letterSpacing, view.dom.closest('.app-shell')?.className].join('|');
}

export function normalizePaginationCopy(copy) {
  copy.querySelectorAll('.ProseMirror-widget').forEach(widget => widget.remove());
  for (const element of [copy, ...copy.querySelectorAll('*')]) {
    for (const attr of ['id', 'data-block-id', 'data-source-block-id', 'data-doc-id', 'data-pane-id', 'data-viewport-hidden']) element.removeAttribute(attr);
    element.classList.remove('active-block', 'pm-viewport-hidden');
    if (element.hasAttribute('data-pagination-break')) {
      element.removeAttribute('data-pagination-break');
      element.classList.remove('pm-page-start-inline', 'pm-page-start-empty', 'pm-page-start-atom', 'pm-page-end-empty');
      element.style.removeProperty('--page-spacer-height'); element.style.removeProperty('--page-original-margin');
    }
    element.style.contentVisibility = 'visible';
  }
}

export function beginViewportPagination(view, shell) {
  if (sessions.has(view) || view.composing) return;
  const current = paginationPluginKey.getState(view.state);
  if (!current || current.pageBreaks.length < 10) return;
  const doc = view.state.doc, blocks = [];
  doc.forEach((node, pos) => {
    if (!node.isTextblock) return;
    const element = view.nodeDOM(pos);
    if (element instanceof HTMLElement) blocks.push({ node, pos, element });
  });
  const paragraph = blocks.length === 1 && doc.childCount === 1 && blocks[0].node.type.name === 'paragraph';
  if (!paragraph && (blocks.length !== doc.childCount || blocks.some(block => block.node.content.size > 8000))) return;
  const stride = parseFloat(shell.querySelector('.page-sheets-bg')?.style.getPropertyValue('--paper-stride'));
  if (!stride) return;
  const origin = view.dom.getBoundingClientRect().top;
  if (!paragraph) for (const block of blocks) { const rect = block.element.getBoundingClientRect(); block.top = rect.top - origin; block.height = rect.height; }
  const chunks = paragraph ? [1, ...current.pageBreaks.map(item => item.pos), doc.content.size - 1] : null;
  sessions.set(view, { doc, signature: typography(view), blocks, chunks, stride, totalHeight: view.dom.getBoundingClientRect().height, mode: paragraph ? 'paragraph' : 'blocks' });
}

function placeholder(pos, height, key, side = -1) {
  return Decoration.widget(pos, () => {
    const span = document.createElement('span'); span.className = 'pm-viewport-placeholder';
    span.style.height = `${Math.max(0, height)}px`; span.setAttribute('aria-hidden', 'true'); span.contentEditable = 'false'; span.inert = true;
    return span;
  }, { key: `${key}:${height}`, side, ignoreSelection: true });
}

function hide(from, to, node = false) {
  const attrs = { class: 'pm-viewport-hidden', 'data-viewport-hidden': '' };
  return node ? Decoration.node(from, to, attrs) : Decoration.inline(from, to, { ...attrs, nodeName: 'span' });
}

function measure(view, shell, blocks, from, to, paragraph, indent, scan, consume) {
  const copy = view.dom.cloneNode(false), wrapper = view.dom.parentElement.cloneNode(false), measured = [];
  wrapper.classList.remove('page-content'); wrapper.classList.add('pagination-measure');
  for (const block of blocks) {
    let element;
    if (paragraph) {
      const range = document.createRange(), start = view.domAtPos(from, 1), end = view.domAtPos(to, -1);
      range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
      let fragment = range.cloneContents(), ancestor = range.commonAncestorContainer;
      if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentElement;
      while (ancestor && ancestor !== block.element && block.element.contains(ancestor)) {
        const parent = ancestor.cloneNode(false); parent.append(fragment); fragment = parent; ancestor = ancestor.parentElement;
      }
      element = block.element.cloneNode(false); element.append(fragment);
      element.style.textIndent = indent;
    } else element = block.element.cloneNode(true);
    normalizePaginationCopy(element); copy.append(element);
    measured.push({ element, node: block.node, pos: paragraph ? from - 1 : block.pos });
  }
  normalizePaginationCopy(copy); wrapper.removeAttribute('id'); copy.contentEditable = 'false';
  const width = view.dom.getBoundingClientRect().width;
  Object.assign(copy.style, { minHeight: '0', height: 'auto', width: `${width}px` });
  Object.assign(wrapper.style, { position: 'fixed', left: '-100000px', top: '0', width: `${width}px`, height: 'auto', minHeight: '0', margin: '0', padding: '0', visibility: 'hidden', pointerEvents: 'none' });
  wrapper.setAttribute('aria-hidden', 'true'); wrapper.inert = true; wrapper.append(copy); shell.append(wrapper);
  try {
    const origin = copy.getBoundingClientRect().top;
    return consume(measured.flatMap(block => scan(block.element, block.node, block.pos, origin)), copy.getBoundingClientRect().height);
  } finally { wrapper.remove(); }
}

function paginate(lines, origin, initialPage, { stride, pageHeight, paddingTop, paddingBottom }) {
  const breaks = []; let shift = 0, page = initialPage;
  for (const line of lines) {
    const top = origin + line.top + shift, bottom = origin + line.bottom + shift;
    if (top < page * stride + paddingTop - .5 || bottom > page * stride + pageHeight - paddingBottom + .5) {
      if (bottom > page * stride + pageHeight - paddingBottom + .5) page++;
      const height = Math.max(0, page * stride + paddingTop - origin - line.top - shift);
      if (height > .5) { breaks.push({ pos: typeof line.pos === 'function' ? line.pos() : line.pos, type: line.type, height }); shift += height; }
    }
  }
  return { breaks, shift, page };
}

export function calculateViewportPagination(view, shell, dimensions, scan) {
  const session = sessions.get(view);
  if (!session) return null;
  if (session.doc !== view.state.doc || session.signature !== typography(view)) { sessions.delete(view); return null; }
  const scroll = shell.closest('.editor-scroll-area'), viewport = scroll.getBoundingClientRect(), origin = view.dom.getBoundingClientRect().top - shell.getBoundingClientRect().top;
  const { pageHeight, paddingTop, paddingBottom } = dimensions, stride = pageHeight + PAGE_GAP;
  const viewportTop = viewport.top - shell.getBoundingClientRect().top;
  const firstPage = Math.max(0, Math.floor(viewportTop / stride) - 2), lastPage = Math.ceil((viewportTop + viewport.height) / stride) + 2;
  const extra = [];
  let from, to, blocks, base, first, last;
  if (session.mode === 'paragraph') {
    first = Math.min(session.chunks.length - 2, firstPage); last = Math.min(session.chunks.length - 1, Math.max(first + 1, lastPage));
    from = session.chunks[first]; to = session.chunks[last]; blocks = session.blocks; base = origin + first * stride;
    if (from > 1) { extra.push(hide(1, from), placeholder(1, first * stride, 'prefix')); extra.push(Decoration.node(0, view.state.doc.content.size, { style: 'text-indent:0px;' })); }
  } else {
    const scale = stride / session.stride;
    first = session.blocks.findIndex(block => block.top * scale + block.height * scale >= viewportTop - origin - 2 * stride);
    if (first < 0) first = session.blocks.length - 1;
    last = first + 1;
    while (last < session.blocks.length && session.blocks[last].top * scale < viewportTop - origin + viewport.height + 2 * stride) last++;
    blocks = session.blocks.slice(first, last); from = blocks[0].pos; to = blocks.at(-1).pos + blocks.at(-1).node.nodeSize;
    const prefix = blocks[0].top * scale;
    base = origin + prefix;
    for (const block of session.blocks.slice(0, first)) extra.push(hide(block.pos, block.pos + block.node.nodeSize, true));
    for (const block of session.blocks.slice(last)) extra.push(hide(block.pos, block.pos + block.node.nodeSize, true));
    if (first) extra.push(placeholder(0, prefix, 'prefix'));
  }
  const indent = first ? '0px' : shell.closest('.indent-paragraphs') ? '2.2em' : getComputedStyle(blocks[0].element).textIndent;
  const layout = measure(view, shell, blocks, from, to, session.mode === 'paragraph', indent, scan, (lines, naturalHeight) => ({ ...paginate(lines, base, Math.max(0, Math.floor(base / stride)), { stride, pageHeight, paddingTop, paddingBottom }), naturalHeight }));
  let count;
  if (session.mode === 'paragraph') {
    const boundaries = layout.breaks.map(item => item.pos).filter(pos => pos > from && pos < to);
    const windowPages = boundaries.length + 1, remaining = session.chunks.length - 1 - last;
    count = first + windowPages + remaining;
    if (remaining) {
      extra.push(hide(to, view.state.doc.content.size - 1));
      extra.push(placeholder(to, windowPages * stride - layout.naturalHeight - layout.shift + (remaining - 1) * stride + pageHeight - paddingTop - paddingBottom, 'suffix', 1));
    }
    session.chunks.splice(first, last - first + 1, from, ...boundaries, to);
  } else {
    const scale = stride / session.stride, suffix = Math.max(0, session.totalHeight - session.blocks[last - 1].top - session.blocks[last - 1].height) * scale;
    if (last < session.blocks.length) extra.push(placeholder(view.state.doc.content.size, suffix, 'suffix', 1));
    count = Math.max(layout.page + 1, Math.ceil((base + layout.naturalHeight + layout.shift + suffix + paddingBottom) / stride));
  }
  return { count, pageBreaks: layout.breaks, decorations: extra, viewport: { from, to } };
}

export function clearViewportPagination(view) { sessions.delete(view); }

export function viewportPaginationActive(view) { return sessions.has(view); }

export function revealViewportSelection(view, shell) {
  return revealViewportPosition(view, shell, view.state.selection.head);
}

export function revealViewportPosition(view, shell, position) {
  const session = sessions.get(view), window = paginationPluginKey.getState(view.state)?.viewport, pos = Math.max(1, Math.min(position, view.state.doc.content.size - 1));
  if (!session || !window || (pos >= window.from && (pos < window.to || window.to === view.state.doc.content.size - 1))) return false;
  const scroll = shell.closest('.editor-scroll-area'), viewport = scroll.getBoundingClientRect(), origin = view.dom.getBoundingClientRect().top;
  const stride = parseFloat(shell.querySelector('.page-sheets-bg').style.getPropertyValue('--paper-stride'));
  const index = session.mode === 'paragraph' ? Math.max(0, session.chunks.findLastIndex(from => from <= pos) - (pos === session.chunks.at(-1) ? 1 : 0)) : Math.max(0, session.blocks.findLastIndex(block => block.pos <= pos));
  const y = session.mode === 'paragraph' ? index * stride : session.blocks[index].top * stride / session.stride;
  const behavior = scroll.style.scrollBehavior;
  scroll.style.scrollBehavior = 'auto';
  scroll.scrollTop += origin + y - viewport.top - Math.min(100, viewport.height / 4);
  scroll.style.scrollBehavior = behavior;
  return true;
}
