import { Decoration, DecorationSet } from '../vendor/tiptap/nocturne-tiptap.bundle.js';
import { paginationPluginKey } from './nocturne-editor.js';

const DEFAULT_PAGE_HEIGHT = 1123;
const DEFAULT_VERTICAL_PADDING = 96;

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
  let view;
  try { view = editor?.view; } catch (e) { return; }
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

  const pageWidth = pageShell.clientWidth || 794;
  const pageHeight = Math.round(pageWidth * 1.4143577);
  const gap = 60;

  const pageIndex = Math.floor(blockTop / (pageHeight + gap));

  const currentActive = bgContainer.querySelector('.page-sheet-bg.active');
  const sheets = bgContainer.querySelectorAll('.page-sheet-bg:not(.motion-sheet-exiting)');
  const targetSheet = sheets[pageIndex];
  if (currentActive !== targetSheet) {
    if (currentActive) currentActive.classList.remove('active');
    if (targetSheet) targetSheet.classList.add('active');
  }
}

export function calculateVisualPages({ editor, pageShell, overlay, flexible = false, motion }) {
  let view;
  try { view = editor?.view; } catch (e) { return []; }
  if (!view?.dom || !pageShell) return [];

  const pageStyle = window.getComputedStyle(pageShell);
  const pageWidth = parseFloat(pageStyle.width) || 794;
  const pageHeight = Math.round(pageWidth * 1.4143577);
  const paddingTop = parseFloat(pageStyle.paddingTop) || DEFAULT_VERTICAL_PADDING;
  const paddingBottom = parseFloat(pageStyle.paddingBottom) || DEFAULT_VERTICAL_PADDING;
  const gap = 60; // margin gap between pages
  
  const fontSize = parseFloat(pageStyle.fontSize) || 16;
  const lineHeightStr = pageStyle.lineHeight;
  const lineHeight = lineHeightStr === 'normal' ? 1.5 : parseFloat(lineHeightStr);
  const gridStepPixels = isNaN(lineHeight) ? fontSize * 1.5 : (lineHeightStr.includes('px') ? lineHeight : fontSize * lineHeight);
  
  const contentPageHeight = Math.max(120, pageHeight - paddingTop - paddingBottom);
  const H_spacer = Math.ceil((paddingBottom + gap + paddingTop) / gridStepPixels) * gridStepPixels;

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
      updatePaperSheets(bgContainer, 0, { motion });
    }

    const pageNumEl = pageShell.querySelector('.page-number');
    if (pageNumEl) {
      pageNumEl.textContent = '1';
      pageNumEl.style.display = 'block';
    }

    if (overlay) {
      overlay.style.height = '0px';
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
    const cleanBottom = blockBottom - totalSpacersBefore;
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

  function findSplitPos(startPos, endPos, contentBottom, blockIndex) {
    let left = startPos;
    let right = endPos;
    let best = -1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      let charY;
      try {
        charY = view.coordsAtPos(mid).bottom - editorRect.top;
      } catch (e) {
        charY = contentBottom + 1; // force left search if measurement fails
      }

      if (charY <= contentBottom) {
        best = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    return best;
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
      let nextPageStart = (pageIndex + 1) * (pageHeight + gap) + paddingTop;
      let currentPageStart = pageIndex * (pageHeight + gap) + paddingTop;

      if (blockTop >= contentBottom - 10) {
        // The block starts near or after the page bottom, push the ENTIRE block to the next page!
        if (y <= currentPageStart + 5) {
          // Already at top of page, let it stay and overflow
          y = blockBottom;
        } else {
          const spacerHeight = nextPageStart - y;
          const snappedSpacer = Math.ceil(spacerHeight / gridStepPixels) * gridStepPixels;
          pageBreaks.push({
            pos: block.pos,
            height: snappedSpacer,
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
          let currentBlockY = y;
          let remainingHeight = blockHeight;
          let currentStartPos = block.pos + 1;
          const endPos = block.pos + blockNode.nodeSize - 1;

          while (currentBlockY + remainingHeight > contentBottom) {
            const splitPos = findSplitPos(currentStartPos, endPos, contentBottom, block.index);
            if (splitPos > currentStartPos && splitPos < endPos) {
              pageBreaks.push({
                pos: splitPos,
                height: H_spacer,
                type: 'inline',
                index: block.index,
                pageIndex,
                y: contentBottom
              });

              let splitY;
              try {
                splitY = view.coordsAtPos(splitPos).bottom - editorRect.top;
              } catch (e) {
                splitY = contentBottom;
              }
              const usedHeight = Math.max(0, splitY - currentBlockY);
              remainingHeight = Math.max(0, remainingHeight - usedHeight);

              currentBlockY = nextPageStart;
              currentStartPos = splitPos;
              pageIndex++;
              contentBottom = getPageContentBottom(pageIndex);
              nextPageStart = (pageIndex + 1) * (pageHeight + gap) + paddingTop;
            } else {
              // Push the remaining part of the block to the next page
              if (currentStartPos === block.pos + 1) {
                if (currentBlockY <= currentPageStart + 5) {
                  currentBlockY = currentBlockY + remainingHeight;
                  remainingHeight = 0;
                } else {
                  const spacerHeight = nextPageStart - currentBlockY;
                  const snappedSpacer = Math.ceil(spacerHeight / gridStepPixels) * gridStepPixels;
                  pageBreaks.push({
                    pos: block.pos,
                    height: snappedSpacer,
                    type: 'block',
                    index: block.index,
                    pageIndex,
                    y: currentBlockY
                  });
                  currentBlockY = nextPageStart;
                }
              } else {
                const inlineSpacerHeight = nextPageStart - currentBlockY;
                const snappedInlineSpacer = Math.ceil(inlineSpacerHeight / gridStepPixels) * gridStepPixels;
                pageBreaks.push({
                  pos: currentStartPos,
                  height: snappedInlineSpacer,
                  type: 'inline',
                  index: block.index,
                  pageIndex,
                  y: currentBlockY
                });
                currentBlockY = nextPageStart;
              }
              pageIndex++;
              contentBottom = getPageContentBottom(pageIndex);
              nextPageStart = (pageIndex + 1) * (pageHeight + gap) + paddingTop;
            }
          }
          y = currentBlockY + remainingHeight;
        } else {
          // Push entire block
          if (y <= currentPageStart + 5) {
            y = blockBottom;
          } else {
            const spacerHeight = nextPageStart - y;
            const snappedSpacer = Math.ceil(spacerHeight / gridStepPixels) * gridStepPixels;
            pageBreaks.push({
              pos: block.pos,
              height: snappedSpacer,
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
    const blockBreaks = new Map();
    pageBreaks.forEach(brk => {
      if (!blockBreaks.has(brk.index)) blockBreaks.set(brk.index, []);
      blockBreaks.get(brk.index).push(brk);
    });

    blockBreaks.forEach((breaks, blockIndex) => {
      const blockData = blocksData.find(b => b.index === blockIndex);
      if (!blockData) return;

      let totalMarginBottom = 0;
      let accumulatedTop = 0;
      breaks.sort((a, b) => a.pos - b.pos);

      for (let i = 0; i < breaks.length; i++) {
        const brk = breaks[i];
        if (brk.type === 'block') {
           decorations.push(Decoration.node(blockData.pos, blockData.pos + blockData.node.nodeSize, {
             style: `margin-top: ${brk.height}px;`
           }));
        } else {
           accumulatedTop += brk.height;
           totalMarginBottom += brk.height;
           const startPos = brk.pos;
           const endPos = (i + 1 < breaks.length && breaks[i+1].type === 'inline') 
              ? breaks[i+1].pos 
              : blockData.pos + blockData.node.nodeSize - 1;

           if (startPos < endPos) {
             const spacer = document.createElement('span');
             spacer.className = 'pm-page-break-widget';
             spacer.contentEditable = 'false';
             spacer.style.setProperty('--spacer-height', `${accumulatedTop}px`);
             decorations.push(Decoration.widget(startPos, spacer, { key: `inline-${brk.index}-${startPos}`, side: -1 }));
           }
        }
      }

      if (totalMarginBottom > 0) {
        decorations.push(Decoration.node(blockData.pos, blockData.pos + blockData.node.nodeSize, {
          style: `margin-bottom: ${totalMarginBottom}px;`
        }));
      }
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

  updatePaperSheets(bgContainer, pageCount, { pageHeight, gap, pageStyle, motion });

  // Highlight active page
  updateActivePageHighlight(editor, pageShell);

  const pageNumEl = pageShell.querySelector('.page-number');
  if (pageNumEl) {
    pageNumEl.style.display = 'none';
  }

  if (overlay) {
    overlay.style.height = '0px';
  }

  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push({ page: i + 1, y: i * (pageHeight + gap) });
  }
  return pages;
}
