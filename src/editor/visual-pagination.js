const DEFAULT_PAGE_HEIGHT = 1123;
const DEFAULT_VERTICAL_PADDING = 96;

export function calculateVisualPages({ editor, pageShell, overlay, flexible = false }) {
  if (!editor?.view?.dom || !pageShell || !overlay) return [];

  const pageStyle = window.getComputedStyle(pageShell);
  const pageHeight = parseFloat(pageStyle.height) || DEFAULT_PAGE_HEIGHT;
  const paddingTop = parseFloat(pageStyle.paddingTop) || DEFAULT_VERTICAL_PADDING;
  const paddingBottom = parseFloat(pageStyle.paddingBottom) || DEFAULT_VERTICAL_PADDING;
  const contentPageHeight = Math.max(120, pageHeight - paddingTop - paddingBottom);
  const editorDom = editor.view.dom;
  const docHeight = Math.max(editorDom.scrollHeight, editorDom.getBoundingClientRect().height, contentPageHeight);
  const pageCount = flexible ? 1 : Math.max(1, Math.ceil(docHeight / contentPageHeight));
  const shellHeight = flexible ? docHeight + paddingTop + paddingBottom : (pageCount * contentPageHeight) + paddingTop + paddingBottom;

  pageShell.style.minHeight = `${Math.ceil(shellHeight)}px`;
  overlay.style.height = `${Math.ceil(docHeight)}px`;
  overlay.replaceChildren();

  const pages = [{ page: 1, y: 0 }];
  if (flexible) return pages;

  for (let index = 1; index < pageCount; index += 1) {
    const y = index * contentPageHeight;
    const divider = document.createElement('div');
    divider.className = 'page-divider';
    divider.style.transform = `translateY(${Math.round(y)}px)`;
    divider.dataset.page = String(index + 1);

    const number = document.createElement('div');
    number.className = 'visual-page-number';
    number.textContent = String(index + 1);
    number.style.transform = `translateY(${Math.max(0, Math.round(y + contentPageHeight - 36))}px)`;

    overlay.append(divider, number);
    pages.push({ page: index + 1, y });
  }

  return pages;
}
