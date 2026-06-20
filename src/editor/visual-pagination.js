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

  const editorDom = view.dom;
  const editorRect = editorDom.getBoundingClientRect();
  if (editorRect.height === 0) return [];

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
    const docHeight = Math.max(editorDom.scrollHeight, editorRect.height);
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

  const pageBreaks = []; // list of objects: { pos, type, index }

  function getPageContentBottom(pageIdx) {
    return pageIdx * (pageHeight + gap) + pageHeight - paddingBottom;
  }

  blocks.forEach((block, index) => {
    const rect = block.getBoundingClientRect();
    const blockTop = rect.top - editorRect.top;
    const blockBottom = rect.bottom - editorRect.top;

    const pageIndex = Math.floor(blockTop / (pageHeight + gap));
    const contentBottom = getPageContentBottom(pageIndex);

    if (blockBottom > contentBottom) {
      // This block overflows the current page content bottom!
      let pos;
      try {
        pos = view.posAtDOM(block, 0);
      } catch (e) {
        return;
      }

      if (blockTop >= contentBottom - 10) {
        // The block starts near or after the page bottom, push the ENTIRE block to the next page!
        pageBreaks.push({ pos, type: 'block', index });
      } else {
        // The block crosses the page bottom. Split it inline!
        // We find the character position where it overflows using binary search
        const blockNode = view.state.doc.nodeAt(pos);
        if (blockNode) {
          const startPos = pos;
          const endPos = pos + blockNode.nodeSize - 1;
          
          let left = startPos;
          let right = endPos;
          let bestPos = startPos;

          while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            let coords;
            try {
              coords = view.coordsAtPos(mid);
            } catch (e) {
              right = mid - 1;
              continue;
            }

            const y = coords.bottom - editorRect.top;
            if (y <= contentBottom) {
              bestPos = mid;
              left = mid + 1;
            } else {
              right = mid - 1;
            }
          }

          if (bestPos > startPos) {
            pageBreaks.push({ pos: bestPos, type: 'inline', index });
          } else {
            pageBreaks.push({ pos, type: 'block', index });
          }
        }
      }
    }
  });

  // Compare pageBreaks with current plugin state to prevent infinite update loops
  const currentPluginState = paginationPluginKey.getState(view.state);
  const currentBreaks = currentPluginState?.pageBreaks || [];

  const isSame = currentBreaks.length === pageBreaks.length &&
                 currentBreaks.every((val, i) => val.pos === pageBreaks[i].pos);

  if (!isSame) {
    const decorations = [];
    pageBreaks.forEach((brk) => {
      const spacer = Decoration.widget(brk.pos, () => {
        const el = document.createElement('span');
        el.className = 'pm-page-break';
        el.style.display = 'block';
        el.style.height = `${H_spacer}px`;
        el.style.marginLeft = `-${pageStyle.paddingLeft}`;
        el.style.marginRight = `-${pageStyle.paddingRight}`;
        el.style.pointerEvents = 'none';
        el.style.userSelect = 'none';
        el.style.boxSizing = 'border-box';
        return el;
      }, { key: `break-${brk.pos}` });

      decorations.push(spacer);
    });

    // Update decorations in ProseMirror state
    view.dispatch(view.state.tr.setMeta(paginationPluginKey, {
      decorations: DecorationSet.create(view.state.tr.doc, decorations),
      pageBreaks,
    }));
    return [];
  }

  // PAGE BREAKS ARE STABLE - RENDER BACKGROUND SHEETS
  // Make sure we have enough page sheets to cover the entire scroll height of the editor!
  const minPageCount = Math.ceil(editorDom.scrollHeight / (pageHeight + gap));
  const pageCount = Math.max(pageBreaks.length + 1, minPageCount, 1);
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

