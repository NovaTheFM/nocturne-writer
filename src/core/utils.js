export const uid = (prefix = 'id') => `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function stripAnalysisMarkup(root) {
  root.querySelectorAll('br[data-soft-empty-line],[data-soft-caret],.soft-caret,.soft-empty-line').forEach((node) => node.remove());
  root.querySelectorAll('.entity-link,.syntax-dialogue,.syntax-thought,.weak-word,.sentence-long,.sentence-short,.sentence-current,.ai-suggestion,.search-hit,.mention-hit,[data-search-hit],[data-analysis],[data-suggestion-id]').forEach((node) => {
    const text = document.createTextNode(cleanAnalysisResidue(node.textContent).replace(/\uFEFF/g, ''));
    node.replaceWith(text);
  });
  root.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = String(attr.value || '');
      if (/^on/i.test(name) || name === 'style' || name === 'srcdoc') {
        node.removeAttribute(attr.name);
        return;
      }
      if (['href', 'src', 'xlink:href'].includes(name) && (/^\s*javascript:/i.test(value) || /^\s*data:/i.test(value))) {
        node.removeAttribute(attr.name);
        return;
      }
      if (/^(class|data-analysis|data-suggestion-id|data-search-hit)$/i.test(attr.name) && /(?:sentence-|syntax-|weak-word|entity-link|ai-suggestion|search-hit|mention-hit)/i.test(attr.value)) {
        node.removeAttribute(attr.name);
      }
    });
  });
}

const ALLOWED_EDITOR_TAGS = new Set(['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'SPAN', 'PRE', 'CODE', 'HR']);
const DROP_WITH_CONTENT_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION']);

export function sanitizeHtmlTree(root) {
  [...root.querySelectorAll('*')].forEach((node) => {
    if (DROP_WITH_CONTENT_TAGS.has(node.tagName)) {
      node.remove();
      return;
    }
    if (!ALLOWED_EDITOR_TAGS.has(node.tagName)) {
      node.replaceWith(...node.childNodes);
      return;
    }
    [...node.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name === 'data-block-id' && /^[\w.:-]{1,240}$/u.test(attr.value)) return;
      if (name === 'class') {
        if (/(?:sentence-|syntax-|weak-word|entity-link|ai-suggestion|search-hit|mention-hit)/iu.test(attr.value)) node.removeAttribute(attr.name);
        return;
      }
      node.removeAttribute(attr.name);
    });
  });
}

export function textFromHtml(html = '') {
  const div = document.createElement('div');
  div.innerHTML = html;
  sanitizeHtmlTree(div);
  stripAnalysisMarkup(div);
  return cleanAnalysisResidue(div.textContent || '');
}

export function normalizeHtml(html = '') {
  const div = document.createElement('div');
  div.innerHTML = String(html || '').replace(/\u200B/g, '');
  sanitizeHtmlTree(div);
  stripAnalysisMarkup(div);
  let cleaned = div.innerHTML;
  cleaned = cleaned.replace(/<\/?span[^>]*>/gi, '');
  cleaned = cleanAnalysisResidue(cleaned);
  if (!cleaned.trim() && !/<br\s*\/?>/i.test(cleaned)) return '<br>';
  return cleaned;
}

export function parseBlocksFromEditable(editable) {
  const clone = editable.cloneNode(true);
  stripAnalysisMarkup(clone);
  const nodes = [...clone.querySelectorAll('[data-block-id], p, h1, h2, h3, blockquote')].filter((node) => {
    if (node.classList?.contains('page-break') || node.classList?.contains('page-number')) return false;
    const tag = node.tagName.toUpperCase();
    return node.textContent.trim() || node.querySelector('br') || ['P', 'BLOCKQUOTE', 'H1', 'H2', 'H3'].includes(tag);
  });
  if (!nodes.length) return [{ id: uid('block'), type: 'paragraph', html: '<br>', align: 'left' }];
  return nodes.map((node) => {
    const tag = node.tagName.toLowerCase();
    const type = tag === 'h1' || tag === 'h2' || tag === 'h3' ? 'heading' : tag === 'blockquote' ? 'quote' : 'paragraph';
    const align = node.style.textAlign || node.getAttribute('align') || 'left';
    return { id: node.dataset.blockId || uid('block'), type, align, html: normalizeHtml(node.innerHTML || node.textContent) || '<br>' };
  });
}

export function blockText(block) {
  return textFromHtml(block.html || '');
}

export function docText(ast) {
  return (ast?.blocks || []).map(blockText).join('\n\n');
}

export function countWords(text = '') {
  return (text.trim().match(/[\p{L}0-9]+(?:[’'\-][\p{L}0-9]+)?/gu) || []).length;
}

export function buildSummary(ast) {
  const text = docText(ast).replace(/\s+/g, ' ').trim();
  if (!text) return 'Пустая глава.';
  const sentences = text.match(/[^.!?…]+[.!?…]?/g) || [text];
  return sentences.slice(0, 2).join(' ').slice(0, 180);
}

export function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const int = parseInt(full, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

export function applySmartPunctuation(text = '') {
  return text
    .replace(/--/g, '—')
    .replace(/\.\.\./g, '…')
    .replace(/"([^"]+)"/g, '«$1»');
}

export function applySmartPunctuationToHtml(html = '') {
  const div = document.createElement('div');
  div.innerHTML = html;
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    node.textContent = applySmartPunctuation(cleanAnalysisResidue(node.textContent));
    node = walker.nextNode();
  }
  return cleanAnalysisResidue(div.innerHTML);
}

export function cleanAnalysisResidue(value = '') {
  return String(value)
    .replace(/\u200B/g, '')
    .replace(/\uFEFF/g, '')
    .replace(/\s(?:class|data-analysis|data-suggestion-id|data-search-hit|data-soft-caret|data-soft-empty-line)=["'][^"']*(?:sentence-|syntax-|weak-word|entity-link|ai-suggestion|search-hit|mention-hit|soft-caret|soft-empty-line)[^"']*["']/giu, '')
    .replace(/<\/?span\b[^>]*(?:sentence-short|sentence-long|sentence-current|syntax-dialogue|syntax-thought|weak-word|entity-link|ai-suggestion|search-hit|mention-hit|data-analysis|data-suggestion-id|data-search-hit)[^>]*>/giu, '')
    .replace(/<span\b[^>]*>\s*<\/span>/giu, '')
    .replace(/^\s*(?:&gt;|>)(?=\s|$)/gm, '');
}

export const CLEAN_ANALYSIS_RESIDUE_EXAMPLES = [
  { input: '<span class="search-hit">текст</span><strong>жирный</strong>', expected: 'текст<strong>жирный</strong>' },
  { input: '<span data-analysis="readability" class="sentence-long">Фраза</span>', expected: 'Фраза' },
];

export function sentenceParts(text = '') {
  return text.match(/[^.!?…]+[.!?…]?|\s+/g) || [text];
}

export function parseTimelineRank(date = '') {
  const match = String(date).match(/(?:год|г\.?)\s*(-?\d+)/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
export function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
