import { Decoration, DecorationSet } from '../vendor/tiptap/nocturne-tiptap.bundle.js';
import { paginationPluginKey } from './nocturne-editor.js';

const DEFAULT_PAGE_HEIGHT = 1123;
const DEFAULT_VERTICAL_PADDING = 96;

export function updateActivePageHighlight(editor, pageShell) {
  const view = editor?.view;
  if (!view?.dom || !pageShell) return;

  const bgContainer = pageShell.querySelector('.page-sheets-bg');
  if (!bgContainer) return;

  const selection = view.state.selection;
  const $anchor = selection.$anchor;
  const depth = $anchor.depth;
  if (depth <= 0) return;

  // Find the top-level block node containing the anchor
  const blockDom = view.nodeDOM($anchor.before(1));
  if (!blockDom) return;

  const editorDom = view.dom;
  const editorRect = editorDom.getBoundingClientRect();
  const rect = blockDom.getBoundingClientRect();
  const blockTop = rect.top - editorRect.top;

  const pageStyle = window.getComputedStyle(pageShell);
  const pageWidth = parseFloat(pageStyle.width) || 794;
  const pageHeight = Math.round(pageWidth * 1.4143577);
  const gap = 60;

  const pageIndex = Math.floor(blockTop / (pageHeight + gap));

  const sheets = bgContainer.querySelectorAll('.page-sheet-bg');
  sheets.forEach((sheet, idx) => {
    if (idx === pageIndex) {
      sheet.classList.add('active');
    } else {
      sheet.classList.remove('active');
    }
  });
}

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
    const currentPluginState = paginationPluginKey.getState(view.state);
    if (currentPluginState?.pageBreaks?.length > 0) {
      view.dispatch(view.state.tr.setMeta(paginationPluginKey, {
        decorations: DecorationSet.empty,
        pageBreaks: [],
      }));
    }

    pageShell.style.minHeight = '';
    const bgContainer = pageShell.querySelector('.page-sheets-bg');
    if (bgContainer) {
      bgContainer.innerHTML = '';
    }

    const pageNumEl = pageShell.querySelector('.page-number');
    if (pageNumEl) {
      pageNumEl.textContent = '1';
      pageNumEl.style.display = 'block';
    }

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

  const currentPluginState = paginationPluginKey.getState(view.state);
  const currentBreaks = currentPluginState?.pageBreaks || [];
  
  // Sort current breaks by position
  const sortedBreaks = [...currentBreaks].sort((a, b) => a.pos - b.pos);

  // Measure clean positions of blocks (accounting for active spacer heights before and inside blocks)
  const blocksData = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    let pos;
    try {
      pos = view.posAtDOM(block);
    } catch (e) {
      continue;
    }

    const blockNode = view.state.tr.doc.nodeAt(pos);
    const nodeSize = blockNode ? blockNode.nodeSize : 0;

    const rect = block.getBoundingClientRect();
    const blockTop = rect.top - editorRect.top;
    const blockBottom = rect.bottom - editorRect.top;

    let totalSpacersBefore = 0;
    let totalSpacersInside = 0;

    sortedBreaks.forEach((brk) => {
      if (brk.pos <= pos) {
        totalSpacersBefore += brk.height;
      } else if (brk.pos < pos + nodeSize) {
        totalSpacersInside += brk.height;
      }
    });

    const cleanTop = blockTop - totalSpacersBefore;
    const cleanBottom = blockBottom - totalSpacersBefore - totalSpacersInside;
    const height = cleanBottom - cleanTop;

    blocksData.push({
      element: block,
      node: blockNode,
      nodeSize,
      index: i,
      pos,
      cleanTop,
      cleanBottom,
      height,
    });
  }

  if (blocksData.length === 0) return [];

  const pageBreaks = [];
  let y = paddingTop;
  let pageIndex = 0;

  function getPageContentBottom(pIdx) {
    return pIdx * (pageHeight + gap) + pageHeight - paddingBottom;
  }

  blocksData.forEach((block, idx) => {
    // Dynamically calculate pageIndex based on current y position
    pageIndex = Math.floor(y / (pageHeight + gap));
    let contentBottom = getPageContentBottom(pageIndex);
    const blockHeight = block.height;
    
    // Spacing between paragraphs
    const prevBlock = blocksData[idx - 1];
    const spacing = prevBlock ? Math.max(0, block.cleanTop - prevBlock.cleanBottom) : 0;
    
    y += spacing;
    // Re-evaluate pageIndex after spacing
    pageIndex = Math.floor(y / (pageHeight + gap));
    contentBottom = getPageContentBottom(pageIndex);

    let blockTop = y;
    let blockBottom = y + blockHeight;

    if (blockBottom > contentBottom) {
      // Overflows!
      const nextPageStart = (pageIndex + 1) * (pageHeight + gap) + paddingTop;
      const currentPageStart = pageIndex * (pageHeight + gap) + paddingTop;

      if (blockTop >= contentBottom - 10) {
        // The block starts near or after the page bottom, push the ENTIRE block to the next page!
        if (y <= currentPageStart + 5) {
          // Already at top of page, let it stay and overflow
          y = blockBottom;
        } else {
          const spacerHeight = nextPageStart - y;
          pageBreaks.push({
            pos: block.pos,
            height: spacerHeight,
            type: 'block',
            index: block.index,
            pageIndex,
            y: blockTop
          });
          y = nextPageStart + blockHeight;
        }
      } else {
        // The block crosses the page bottom. We split it inline!
        const blockNode = block.node;
        if (blockNode && blockNode.isTextblock) {
          const startPos = block.pos + 1; // inside paragraph start
          const endPos = block.pos + blockNode.nodeSize - 1; // inside paragraph end

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

            const charY = coords.bottom - editorRect.top;
            if (charY <= contentBottom) {
              bestPos = mid;
              left = mid + 1;
            } else {
              right = mid - 1;
            }
          }

          if (bestPos > startPos) {
            pageBreaks.push({
              pos: bestPos,
              height: H_spacer,
              type: 'inline',
              index: block.index,
              pageIndex,
              y: contentBottom
            });
            y = nextPageStart + (blockBottom - contentBottom);
          } else {
            // Push entire block
            if (y <= currentPageStart + 5) {
              y = blockBottom;
            } else {
              const spacerHeight = nextPageStart - y;
              pageBreaks.push({
                pos: block.pos,
                height: spacerHeight,
                type: 'block',
                index: block.index,
                pageIndex,
                y: blockTop
              });
              y = nextPageStart + blockHeight;
            }
          }
        } else {
          // Push entire block
          if (y <= currentPageStart + 5) {
            y = blockBottom;
          } else {
            const spacerHeight = nextPageStart - y;
            pageBreaks.push({
              pos: block.pos,
              height: spacerHeight,
              type: 'block',
              index: block.index,
              pageIndex,
              y: blockTop
            });
            y = nextPageStart + blockHeight;
          }
        }
      }
    } else {
      y = blockBottom;
    }
  });

  const isSame = currentBreaks.length === pageBreaks.length &&
                 currentBreaks.every((val, i) => val.pos === pageBreaks[i].pos && Math.abs(val.height - pageBreaks[i].height) < 2);

  if (!isSame) {
    const decorations = [];
    pageBreaks.forEach((brk) => {
      const spacer = Decoration.widget(brk.pos, () => {
        const el = document.createElement('span');
        el.className = 'pm-page-break';
        el.setAttribute('contenteditable', 'false');
        el.style.display = 'block';
        el.style.height = `${brk.height}px`;
        el.style.marginLeft = `-${pageStyle.paddingLeft}`;
        el.style.marginRight = `-${pageStyle.paddingRight}`;
        el.style.pointerEvents = 'none';
        el.style.userSelect = 'none';
        el.style.boxSizing = 'border-box';

        // Calculate dynamic gradient values
        const spacerY = brk.y;
        const pIdx = brk.pageIndex;
        const sheetEnd = (pIdx + 1) * (pageHeight + gap) - gap;
        const gapStart = Math.max(0, sheetEnd - spacerY);
        const gapEnd = Math.min(brk.height, gapStart + gap);

        el.style.background = `linear-gradient(to bottom, 
          var(--bg-page) ${gapStart}px, 
          var(--border) ${gapStart}px, 
          var(--border) ${gapStart + 1}px, 
          var(--bg-deep) ${gapStart + 1}px, 
          var(--bg-deep) ${gapEnd - 1}px, 
          var(--border) ${gapEnd - 1}px, 
          var(--border) ${gapEnd}px, 
          var(--bg-page) ${gapEnd}px
        )`;
        return el;
      }, { key: `break-${brk.pos}`, side: -1 });

      decorations.push(spacer);
    });

    view.dispatch(view.state.tr.setMeta(paginationPluginKey, {
      decorations: DecorationSet.create(view.state.tr.doc, decorations),
      pageBreaks,
    }));
    return [];
  }

  // PAGE BREAKS ARE STABLE - RENDER BACKGROUND SHEETS
  let bgContainer = pageShell.querySelector('.page-sheets-bg');
  if (!bgContainer) {
    bgContainer = document.createElement('div');
    bgContainer.className = 'page-sheets-bg';
    bgContainer.setAttribute('aria-hidden', 'true');
    pageShell.insertBefore(bgContainer, pageShell.firstChild);
  }

  const minPageCount = Math.ceil(editorDom.scrollHeight / (pageHeight + gap));
  const lastBlockPage = Math.floor(y / (pageHeight + gap));
  const pageCount = Math.max(lastBlockPage + 1, minPageCount, 1);
  const shellHeight = (pageCount * pageHeight) + ((pageCount - 1) * gap);
  pageShell.style.minHeight = `${Math.ceil(shellHeight)}px`;

  let existingSheets = bgContainer.querySelectorAll('.page-sheet-bg');
  if (existingSheets.length !== pageCount) {
    bgContainer.replaceChildren();
    for (let i = 0; i < pageCount; i++) {
      const sheet = document.createElement('div');
      sheet.className = 'page-sheet-bg';
      sheet.style.top = `${i * (pageHeight + gap)}px`;
      sheet.style.height = `${pageHeight}px`;
      sheet.style.width = pageStyle.width;
      sheet.style.borderRadius = pageStyle.borderRadius || '4px';
      sheet.style.boxShadow = pageStyle.boxShadow || 'var(--shadow-float)';

      const num = document.createElement('div');
      num.className = 'page-number-bg';
      num.textContent = String(i + 1);
      sheet.appendChild(num);

      bgContainer.appendChild(sheet);
    }
  } else {
    existingSheets.forEach((sheet, i) => {
      sheet.style.top = `${i * (pageHeight + gap)}px`;
      sheet.style.height = `${pageHeight}px`;
      sheet.style.width = pageStyle.width;
      const num = sheet.querySelector('.page-number-bg');
      if (num) num.textContent = String(i + 1);
    });
  }

  // Highlight active page
  updateActivePageHighlight(editor, pageShell);

  const pageNumEl = pageShell.querySelector('.page-number');
  if (pageNumEl) {
    pageNumEl.style.display = 'none';
  }

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
