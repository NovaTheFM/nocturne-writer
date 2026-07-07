import { escapeHtml, uid } from '../core/utils.js';

const INLINE_MARK_TAGS = {
  bold: ['strong', 'b'],
  italic: ['em', 'i'],
  underline: ['u'],
  strike: ['s', 'strike'],
};

export function legacyAstToHtml(ast = { blocks: [] }) {
  const blocks = Array.isArray(ast?.blocks) ? ast.blocks : [];
  if (!blocks.length) return '<p><br></p>';
  return blocks.map((block) => {
    const attrs = [
      `data-block-id="${escapeHtml(block.id || uid('block'))}"`,
      block.align && block.align !== 'left' ? `style="text-align:${escapeHtml(block.align)}"` : '',
    ].filter(Boolean).join(' ');
    const html = String(block.html || '<br>');
    if (block.type === 'heading') return `<h2 ${attrs}>${html}</h2>`;
    if (block.type === 'quote') return `<blockquote ${attrs}>${html}</blockquote>`;
    return `<p ${attrs}>${html}</p>`;
  }).join('');
}

export function tiptapJsonToLegacyAst(pmJson = null) {
  const content = Array.isArray(pmJson?.content) ? pmJson.content : [];
  const blocks = content.flatMap((node) => jsonNodeToLegacyBlocks(node));
  return {
    type: 'doc',
    blocks: blocks.length ? blocks : [{ id: uid('block'), type: 'paragraph', align: 'left', html: '<br>' }],
  };
}

export function ensureTiptapBlockIds(pmJson = null) {
  if (!pmJson || typeof pmJson !== 'object') return pmJson;
  const copy = structuredClone(pmJson);
  let index = 0;
  const seenIds = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (['paragraph', 'heading', 'blockquote'].includes(node.type)) {
      node.attrs = { ...(node.attrs || {}) };
      if (!node.attrs.blockId || seenIds.has(node.attrs.blockId)) {
        node.attrs.blockId = uid('block');
      }
      seenIds.add(node.attrs.blockId);
      node.attrs.blockOrder = index;
      index += 1;
    }
    (node.content || []).forEach(visit);
  };
  visit(copy);
  return copy;
}

export function plainTextFromTiptapJson(pmJson = null) {
  const parts = [];
  walkTiptapNode(pmJson, (node) => {
    if (node.type === 'text') parts.push(node.text || '');
    if (node.type === 'hardBreak') parts.push('\n');
    if (isBlockNode(node) && parts.length && !parts.at(-1).endsWith('\n\n')) parts.push('\n\n');
  });
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function jsonNodeToLegacyBlocks(node) {
  if (!node || typeof node !== 'object') return [];
  if (node.type === 'blockquote') {
    const quoteText = inlineHtmlFromChildren(node.content || []);
    if (quoteText) return [legacyBlock('quote', node, quoteText)];
    return (node.content || []).flatMap((child) => jsonNodeToLegacyBlocks({ ...child, type: 'blockquote' }));
  }
  if (node.type === 'heading') return [legacyBlock('heading', node, inlineHtmlFromChildren(node.content || []))];
  if (node.type === 'paragraph') return [legacyBlock('paragraph', node, inlineHtmlFromChildren(node.content || []))];
  if (isBlockNode(node)) return [legacyBlock('paragraph', node, inlineHtmlFromChildren(node.content || []))];
  return [];
}

function legacyBlock(type, node, html) {
  return {
    id: String(node.attrs?.blockId || node.attrs?.id || uid('block')),
    type,
    align: node.attrs?.textAlign || node.attrs?.align || 'left',
    html: html || '<br>',
  };
}

function inlineHtmlFromChildren(children = []) {
  const html = children.map((child) => inlineHtmlFromNode(child)).join('');
  return html.trim() ? html : '<br>';
}

function inlineHtmlFromNode(node) {
  if (!node) return '';
  if (node.type === 'hardBreak') return '<br>';
  if (node.type !== 'text') return inlineHtmlFromChildren(node.content || []);
  let value = escapeHtml(node.text || '');
  (node.marks || []).forEach((mark) => {
    if (mark.type === 'bold') value = `<strong>${value}</strong>`;
    if (mark.type === 'italic') value = `<em>${value}</em>`;
    if (mark.type === 'underline') value = `<u>${value}</u>`;
    if (mark.type === 'strike') value = `<s>${value}</s>`;
  });
  return value;
}

function walkTiptapNode(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  (node.content || []).forEach((child) => walkTiptapNode(child, visit));
}

function isBlockNode(node) {
  return ['paragraph', 'heading', 'blockquote', 'codeBlock', 'horizontalRule'].includes(node?.type);
}

export function inlineTagNamesForMark(markType) {
  return INLINE_MARK_TAGS[markType] || [];
}
