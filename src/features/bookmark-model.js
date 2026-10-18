import { t, ui, msg } from '../core/i18n.js';
import { uid } from '../core/utils.js';

export const BOOKMARK_VERSION = 2;
export const BOOKMARK_KINDS = ['point', 'paragraph', 'range'];
export const bookmarkDefaults = {
  bookmarkMode: 'point', bookmarkBehavior: 'text', bookmarkNavigation: 'list',
  bookmarkWrap: true, bookmarkFollowText: true, bookmarkCopyWithText: false,
  bookmarkConfirmTextDeletion: true, bookmarkConfirmDeletion: true,
  bookmarkDeletedText: 'delete', bookmarkSnapshots: true, bookmarkReopen: 'position',
  bookmarkVisibility: 'hover', bookmarkHighlight: 'jump', bookmarkTitleLength: 56,
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const string = (value, max = 4000) => String(value ?? '').slice(0, max);
export const bookmarkTitle = (text, limit = 56) => {
  const words = string(text).replace(/\s+/gu, ' ').trim();
  if (words.length <= limit) return words;
  const prefix = words.slice(0, limit - 1);
  return `${prefix.slice(0, prefix.lastIndexOf(' ') > limit / 2 ? prefix.lastIndexOf(' ') : prefix.length)}…`;
};

export function textIndex(text = '') {
  text = String(text);
  let offset = 0;
  return text.split('\n').map((line, index) => {
    const block = { id: `line-${index}`, from: offset, to: offset + line.length, text: line };
    offset += line.length + 1;
    return block;
  });
}

export function editorIndex(doc) {
  const blocks = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) blocks.push({ id: node.attrs.blockId, from: pos + 1, to: pos + 1 + node.content.size, text: node.textContent });
  });
  return blocks;
}

export function jsonEditorIndex(doc) {
  const blocks = [];
  const size = node => node.type === 'text' ? (node.text || '').length : node.content ? 2 + node.content.reduce((sum, child) => sum + size(child), 0) : ['paragraph', 'heading', 'codeBlock', 'blockquote'].includes(node.type) ? 2 : 1;
  const text = node => node.type === 'text' ? node.text || '' : (node.content || []).map(text).join('');
  const visit = (node, pos) => {
    if (['paragraph', 'heading', 'codeBlock'].includes(node.type)) blocks.push({ id: node.attrs?.blockId, from: pos + 1, to: pos + size(node) - 1, text: text(node) });
    let offset = pos + 1;
    for (const child of node.content || []) { visit(child, offset); offset += size(child); }
  };
  let pos = 0;
  for (const node of doc?.content || []) { visit(node, pos); pos += size(node); }
  return blocks;
}

export function anchorAt(blocks, from, to = from, kind = 'point', readText = null) {
  const max = blocks.at(-1)?.to ?? 0;
  from = clamp(from, blocks[0]?.from ?? 0, max);
  to = clamp(to, from, max);
  const start = blocks.find(block => from >= block.from && from <= block.to) || blocks.find(block => block.from >= from) || blocks.at(-1);
  const end = [...blocks].reverse().find(block => to >= block.from && to <= block.to) || start;
  if (!start) return null;
  if (kind === 'paragraph') { from = start.from; to = start.to; }
  if (kind === 'point') to = from;
  const quote = kind === 'point' ? '' : readText ? readText(from, to) : blocks.filter(block => block.to >= from && block.from <= to).map(block => block.text.slice(Math.max(0, from - block.from), Math.max(0, to - block.from))).join('\n');
  return {
    kind, from, to, status: 'attached',
    start: { blockId: start.id, offset: from - start.from },
    end: { blockId: kind === 'paragraph' ? start.id : end.id, offset: to - (kind === 'paragraph' ? start.from : end.from) },
    quote, prefix: start.text.slice(Math.max(0, from - start.from - 36), from - start.from),
    suffix: end.text.slice(to - end.from, to - end.from + 36),
  };
}

export function resolveLegacyAnchor(value, blocks, plain = false) {
  if (!blocks.length) return { kind: 'point', from: 0, to: 0, status: 'unresolved', quote: string(value.quote) };
  const quote = string(value.quote);
  const kind = BOOKMARK_KINDS.includes(value.kind) ? value.kind : quote.length > 1 ? 'range' : 'point';
  const block = blocks.find(entry => entry.id === value.start?.blockId);
  const expected = block ? block.from + clamp(value.start.offset, 0, block.to - block.from) : plain ? clamp(value.offset, 0, blocks.at(-1).to) : null;
  if (value.version === BOOKMARK_VERSION && value.anchor && typeof value.anchor === 'object' && !Array.isArray(value.anchor)) return structuredClone(value.anchor);
  const endBlock = blocks.find(entry => entry.id === value.end?.blockId);
  const expectedEnd = endBlock ? endBlock.from + Number(value.end.offset || 0) : (expected ?? 0) + quote.length;
  const candidate = expected === null ? null : anchorAt(blocks, expected, expectedEnd, kind);
  if (expected !== null && (kind === 'point' || !quote || candidate?.quote === quote)) {
    return candidate;
  }
  const matches = [];
  if (quote) for (const entry of blocks) {
    let offset = entry.text.indexOf(quote);
    while (offset >= 0) {
      const score = Number(!!value.prefix && entry.text.slice(0, offset).endsWith(value.prefix)) + Number(!!value.suffix && entry.text.slice(offset + quote.length).startsWith(value.suffix));
      matches.push({ from: entry.from + offset, score });
      offset = entry.text.indexOf(quote, offset + 1);
    }
  }
  matches.sort((a, b) => b.score - a.score);
  if (matches.length === 1 || matches[0]?.score > matches[1]?.score) return anchorAt(blocks, matches[0].from, matches[0].from + quote.length, kind);
  return { kind, from: expected ?? 0, to: expected ?? 0, status: 'unresolved', quote, start: value.start, end: value.end };
}

export function normalizeBookmarks(values = [], blocks = [], { plain = false, ownerKey = '' } = {}) {
  const used = new Set();
  return (Array.isArray(values) ? values : []).filter(value => value && typeof value === 'object').slice(0, 10000).map((value, index) => {
    const oldId = /^[\w.:-]{1,240}$/u.test(value.id || '') ? value.id : uid('bookmark');
    const id = used.has(oldId) ? uid('bookmark') : oldId;
    used.add(id);
    const validParts = Array.isArray(value.parts) ? value.parts.filter(part => part && typeof part === 'object') : [];
    const parts = (validParts.length ? validParts : [{ ...value, anchor: value.version === BOOKMARK_VERSION ? value.anchor : resolveLegacyAnchor(value, blocks, plain) }]).slice(0, 100).map((part, partIndex) => {
      const anchor = part.anchor && typeof part.anchor === 'object' && !Array.isArray(part.anchor) ? structuredClone(part.anchor) : part.anchor ? { kind: 'point', from: 0, to: 0, status: 'unresolved' } : resolveLegacyAnchor(part, blocks, plain);
      if (!BOOKMARK_KINDS.includes(anchor.kind)) anchor.kind = 'point';
      anchor.from = Number.isFinite(Number(anchor.from)) ? Math.max(0, Number(anchor.from)) : 0;
      anchor.to = Number.isFinite(Number(anchor.to)) ? Math.max(anchor.from, Number(anchor.to)) : anchor.from;
      anchor.quote = string(anchor.quote, 200000); anchor.prefix = string(anchor.prefix, 36); anchor.suffix = string(anchor.suffix, 36);
      anchor.status = ['attached', 'unresolved'].includes(anchor.status) ? anchor.status : 'unresolved';
      if (blocks.length && (anchor.from < blocks[0].from || anchor.to > blocks.at(-1).to)) anchor.status = 'unresolved';
      return {
        id: /^[\w.:-]{1,240}$/u.test(part.id || '') ? part.id : `${id}:part:${partIndex}`, title: string(part.title || (anchor.kind === 'point' ? msg`Закладка ${index + 1}` : bookmarkTitle(anchor.quote) || msg`Закладка ${index + 1}`), 160),
        note: string(part.note ?? part.description), color: /^#[\da-f]{6}$/iu.test(part.color || '') ? part.color : '',
        tags: [...new Set((Array.isArray(part.tags) ? part.tags : []).map(tag => string(tag, 40)).filter(Boolean))].slice(0, 20), anchor,
      };
    });
    return { version: BOOKMARK_VERSION, id, ownerKey: ownerKey || value.ownerKey || '', groupId: string(value.groupId || oldId, 240), createdAt: Number(value.createdAt) || Date.now(), order: Number(value.order) || index, parts };
  });
}

export function makeBookmark(anchor, { number = 1, titleLength = 56, ownerKey = '' } = {}) {
  const id = uid('bookmark');
  return { version: BOOKMARK_VERSION, id, groupId: id, ownerKey, createdAt: Date.now(), order: number,
    parts: [{ id: uid('bookmark-part'), title: anchor.kind === 'point' ? msg`Закладка ${number}` : bookmarkTitle(anchor.quote, titleLength) || msg`Закладка ${number}`, note: '', color: '', tags: [], anchor }] };
}

export const bookmarkBounds = bookmark => {
  const anchors = bookmark.parts.map(part => part.anchor).filter(anchor => anchor.status === 'attached');
  return { from: Math.min(...anchors.map(anchor => anchor.from)), to: Math.max(...anchors.map(anchor => anchor.to)) };
};
export const overlapsBookmark = (a, b) => {
  return a.parts.some(({ anchor: x }) => x.status === 'attached' && b.parts.some(({ anchor: y }) => y.status === 'attached' && (x.kind === 'point' || y.kind === 'point' ? x.from <= y.to && y.from <= x.to : x.from < y.to && y.from < x.to)));
};
export const bookmarkSignature = bookmark => JSON.stringify(bookmark.parts.map(({ title, note, color, tags, anchor }) => ({ title, note, color, tags, kind: anchor.kind, quote: anchor.quote, from: anchor.from, to: anchor.to, status: anchor.status })));
export function cloneBookmarks(values, ownerKey) {
  return structuredClone(values).map(value => ({ ...value, id: uid('bookmark'), ownerKey, groupId: value.groupId || value.id, parts: value.parts.map(part => ({ ...part, id: uid('bookmark-part') })) }));
}

export function mapBookmarks(values, mapping, blocks, settings = bookmarkDefaults, readText = null) {
  const deleted = [];
  const bookmarks = structuredClone(values).map(bookmark => {
    bookmark.parts = bookmark.parts.flatMap(part => {
      const old = part.anchor;
      if (old.status !== 'attached') return [part];
      const from = mapping.mapResult(old.from, old.kind === 'point' ? 1 : -1);
      const to = mapping.mapResult(old.to, 1);
      let covered = false, start = old.from, end = old.to;
      for (const step of mapping.maps || [mapping]) {
        step.forEach?.((a, b) => { if (b > a && a <= start && b >= end && end > start) covered = true; });
        start = step.mapResult(start, -1).pos; end = step.mapResult(end, 1).pos;
      }
      const removed = old.kind === 'point' ? !!from.deletedAcross || !!from.deleted : old.to > old.from && (covered || to.pos <= from.pos);
      if (removed) {
        deleted.push({ bookmarkId: bookmark.id, part: structuredClone(part) });
        if (settings.bookmarkDeletedText === 'delete') return [];
        if (settings.bookmarkDeletedText === 'detach') { part.anchor.status = 'unresolved'; return [part]; }
      }
      if (!settings.bookmarkFollowText && !removed) return [part];
      part.anchor = anchorAt(blocks, from.pos, Math.max(from.pos, to.pos), old.kind, readText) || { ...old, status: 'unresolved' };
      return [part];
    });
    return bookmark;
  }).filter(bookmark => bookmark.parts.length);
  return { bookmarks, deleted };
}

export function textChangeMapping(before, after) {
  let from = 0, endBefore = before.length, endAfter = after.length;
  while (from < endBefore && from < endAfter && before[from] === after[from]) from++;
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  return { forEach(fn) { fn(from, endBefore, from, endAfter); }, mapResult(pos, assoc = 1) {
    if (pos < from || pos === from && assoc < 0) return { pos, deleted: false };
    if (pos > endBefore || pos === endBefore && assoc > 0) return { pos: pos + endAfter - endBefore, deleted: false };
    return { pos: assoc < 0 ? from : endAfter, deleted: endBefore > from && (pos > from && pos < endBefore || pos === from && assoc > 0 || pos === endBefore && assoc < 0) };
  } };
}
