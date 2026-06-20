import { Decoration, DecorationSet } from '../vendor/tiptap/nocturne-tiptap.bundle.js';
import { paginationPluginKey } from './nocturne-editor.js';

const DEFAULT_PAGE_HEIGHT = 1123;
const DEFAULT_VERTICAL_PADDING = 96;

export function calculateVisualPages({ editor, pageShell, overlay, flexible = false }) {
  const view = editor?.view;
  if (!view?.dom || !pageShell) return [];

  const pageStyle = window.getComputedStyle(pageShell);
  const pageWidth = parseFloat(pageStyle.width) || 794;
  const pageHeight = Math.round(pageWidth * 1.4143577);
  const paddingTop = parseFloat(pageStyle.paddingTop) || DEFAULT_VERTICAL_PADDING;
  const paddingBottom = parseFloat(pageStyle.paddingBottom) || DEFAULT_VERTICAL_PADDING;
  const gap = 60; // margin gap between pages
  const contentPageHeight = Math.max(120, pageHeight - paddingTop - paddingBottom);
  const H_spacer = paddingBottom + gap + paddingTop;

  if (flexible) {
    // 1. Clear any pagination decorations if they exist
    const currentPluginState = paginationPluginKey.getState(view.state);
    if (currentPluginState?.pageBreaks?.length > 0) {
      view.dispatch(view.state.tr.setMeta(paginationPluginKey, {
        decorations: DecorationSet.empty,
        pageBreaks: [],
      }));
    }

    // 2. Adjust pageShell minHeight to fit content
    const editorDom = view.dom;
    const docHeight = Math.max(editorDom.scrollHeight, editorDom.getBoundingClientRect().height);
    const shellHeight = docHeight + paddingTop + paddingBottom;
    pageShell.style.minHeight = `${Math.ceil(shellHeight)}px`;

    // 3. Remove background sheets
    const bgContainer = pageShell.querySelector('.page-sheets-bg');
    if (bgContainer) {
      bgContainer.innerHTML = '';
    }

    // 4. Reset standard page number visibility
    const pageNumEl = pageShell.querySelector('.page-number');
    if (pageNumEl) {
      pageNumEl.textContent = '1';
      pageNumEl.style.display = 'block';
    }

    // 5. Hide old overlay (just in case)
    if (overlay) {
      overlay.style.height = '0px';
      overlay.replaceChildren();
    }

    return [{ page: 1, y: 0 }];
  }

  // FIXED HEIGHT PAGINATION
  // Find all top-level blocks inside the editor DOM
  const blocks = Array.from(view.dom.children).filter(
    (el) => el.tagName === 'P' || el.tagName === 'H2' || el.tagName === 'BLOCKQUOTE'
  );

  let current_page_y = 0;
  const pageBreaks = []; // indices of blocks *before* which we need to insert a page break

  blocks.forEach((block, index) => {
    const blockHeight = block.offsetHeight;
    const blockStyle = window.getComputedStyle(block);
    const marginBottom = parseFloat(blockStyle.marginBottom) || 0;
    const blockFullHeight = blockHeight + marginBottom;

    if (current_page_y + blockFullHeight > contentPageHeight) {
      if (current_page_y > 0) {
        pageBreaks.push(index);
        current_page_y = blockFullHeight;
      } else {
        // It's the first block on the page, keep it here even if it overflows
        current_page_y = blockFullHeight;
      }
    } else {
      current_page_y += blockFullHeight;
    }
  });

  // Compare pageBreaks with current plugin state to prevent infinite update loops
  const currentPluginState = paginationPluginKey.getState(view.state);
  const currentBreaks = currentPluginState?.pageBreaks || [];

  const isSame = currentBreaks.length === pageBreaks.length &&
                 currentBreaks.every((val, i) => val === pageBreaks[i]);

  if (!isSame) {
    const decorations = [];
    pageBreaks.forEach((blockIndex) => {
      const block = blocks[blockIndex];
      const pos = view.posAtDOM(block, 0);

      const spacer = Decoration.widget(pos, () => {
        const el = document.createElement('div');
        el.className = 'pm-page-break';
        el.contentEditable = 'false';
        el.style.height = `${H_spacer}px`;
        el.style.marginLeft = `-${pageStyle.paddingLeft}`;
        el.style.marginRight = `-${pageStyle.paddingRight}`;
        el.style.pointerEvents = 'none';
        el.style.userSelect = 'none';
        el.style.boxSizing = 'border-box';
        return el;
      }, { key: `break-${blockIndex}` });

      decorations.push(spacer);
    });

    // Update pagination decorations in ProseMirror state
    view.dispatch(view.state.tr.setMeta(paginationPluginKey, {
      decorations: DecorationSet.create(view.state.tr.doc, decorations),
      pageBreaks,
    }));
    return [];
  }

  // PAGE BREAKS ARE STABLE - RENDER BACKGROUND SHEETS
  const pageCount = pageBreaks.length + 1;
  const shellHeight = (pageCount * pageHeight) + ((pageCount - 1) * gap);
  pageShell.style.minHeight = `${Math.ceil(shellHeight)}px`;

  // Get or create backgrounds container inside pageShell
  let bgContainer = pageShell.querySelector('.page-sheets-bg');
  if (!bgContainer) {
    bgContainer = document.createElement('div');
    bgContainer.className = 'page-sheets-bg';
    bgContainer.setAttribute('aria-hidden', 'true');
    pageShell.insertBefore(bgContainer, pageShell.firstChild);
  }

  bgContainer.replaceChildren();
  for (let i = 0; i < pageCount; i++) {
    const sheet = document.createElement('div');
    sheet.className = 'page-sheet-bg';
    sheet.style.top = `${i * (pageHeight + gap)}px`;
    sheet.style.height = `${pageHeight}px`;
    sheet.style.width = pageStyle.width;
    sheet.style.borderRadius = pageStyle.borderRadius || '4px';
    sheet.style.boxShadow = pageStyle.boxShadow || 'var(--shadow-float)';

    // Page number
    const num = document.createElement('div');
    num.className = 'page-number-bg';
    num.textContent = String(i + 1);
    sheet.appendChild(num);

    bgContainer.appendChild(sheet);
  }

  // Hide the default page number element
  const pageNumEl = pageShell.querySelector('.page-number');
  if (pageNumEl) {
    pageNumEl.style.display = 'none';
  }

  // Clear visual overlays
  if (overlay) {
    overlay.style.height = '0px';
    overlay.replaceChildren();
  }

  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push({ page: i + 1, y: i * (pageHeight + gap) });
  }
  return pages;
}

