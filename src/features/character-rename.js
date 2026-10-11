import { buildSummary, textFromHtml } from '../core/utils.js';
import { tiptapJsonToLegacyAst } from '../editor/document-adapter.js';
import { anchorAt, jsonEditorIndex, normalizeBookmarks, textIndex } from './bookmark-model.js';

const technicalField = /^(?:id|type|scope|status|source|kind|category|color|colorKey|icon|image|encrypted|protectedStore|ownerKey|groupId|reason|characterRoles|attrs|marks|ast|pmJson|bookmarks|fieldBookmarks|start|end|href|src)$|(?:Ids?|URL|Url|Path|Hash)$/;
const characterIdentity = new Set(['name', 'displayName', 'firstName', 'lastName', 'aliases', 'mentionForms']);
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = value => value.toLocaleLowerCase('ru');

export function characterNameReplacement(before, after) {
  const pairs = new Map();
  for (const field of ['displayName', 'name', 'firstName', 'lastName']) {
    const oldName = String(before[field] || '').trim();
    const newName = String(after[field] || (field === 'lastName' ? after.firstName : '') || '').trim();
    if (oldName && oldName !== newName) pairs.set(fold(oldName), { from: oldName, to: newName });
  }
  if (before.mentionForms?.length === after.mentionForms?.length) {
    before.mentionForms?.forEach((from, index) => {
      const to = after.mentionForms[index];
      if (from && to && from !== to) pairs.set(fold(from), { from, to });
    });
  }
  // A new full name can contain an old name component: do not expand it a second time.
  for (const field of ['displayName', 'name']) {
    const name = String(after[field] || '').trim();
    if (name && !pairs.has(fold(name))) pairs.set(fold(name), { from: name, to: name });
  }
  const terms = [...pairs.values()].sort((a, b) => b.from.length - a.from.length);
  const pattern = terms.length ? new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])(?:${terms.map(pair => escapePattern(pair.from).replace(/\s+/g, '\\s+')).join('|')})(?![\\p{L}\\p{M}\\p{N}_])`, 'giu') : null;
  const matches = text => {
    if (!pattern) return [];
    return [...String(text).matchAll(pattern)].flatMap(match => {
      const pair = pairs.get(fold(match[0].replace(/\s+/g, ' '))) || terms.find(term => fold(term.from.replace(/\s+/g, ' ')) === fold(match[0].replace(/\s+/g, ' ')));
      let replacement = pair.to;
      if (match[0] === match[0].toLocaleUpperCase('ru')) replacement = replacement.toLocaleUpperCase('ru');
      else if (match[0] === match[0].toLocaleLowerCase('ru')) replacement = replacement.toLocaleLowerCase('ru');
      return replacement === match[0] ? [] : [{ from: match.index, to: match.index + match[0].length, text: replacement }];
    });
  };
  return { matches, text(value) {
    let result = String(value);
    for (const match of matches(result).reverse()) result = result.slice(0, match.from) + match.text + result.slice(match.to);
    return result;
  } };
}

export function mapRenamePosition(position, edits, assoc = 1) {
  let shift = 0;
  for (const edit of edits) {
    if (position < edit.from) break;
    if (position <= edit.to) {
      if (position === edit.from) return edit.from + shift;
      if (position === edit.to) return edit.from + shift + edit.text.length;
      const fraction = (position - edit.from) * edit.text.length / (edit.to - edit.from);
      return edit.from + shift + (assoc < 0 ? Math.floor(fraction) : Math.ceil(fraction));
    }
    shift += edit.text.length - (edit.to - edit.from);
  }
  return position + shift;
}

function replaceRuns(runs, replacement, edits, base = 0) {
  let offset = 0;
  const indexed = runs.map(run => {
    const item = { ...run, from: offset, to: offset + run.text.length };
    offset = item.to;
    return item;
  });
  const matches = replacement.matches(runs.map(run => run.text).join(''));
  for (const match of [...matches].reverse()) {
    const overlaps = indexed.filter(run => run.to > match.from && run.from < match.to);
    for (const run of overlaps) {
      const from = Math.max(match.from, run.from), to = Math.min(match.to, run.to);
      const a = Math.round((from - match.from) * match.text.length / (match.to - match.from));
      const b = Math.round((to - match.from) * match.text.length / (match.to - match.from));
      run.text = run.text.slice(0, from - run.from) + match.text.slice(a, b) + run.text.slice(to - run.from);
      run.set(run.text);
    }
  }
  edits.push(...matches.map(match => ({ ...match, from: match.from + base, to: match.to + base })));
}

function replaceJson(node, replacement, edits, pos = -1) {
  if (!node?.content) return;
  let offset = pos + 1, runs = [], runStart = offset;
  const flush = () => { replaceRuns(runs, replacement, edits, runStart); runs = []; };
  for (const child of node.content) {
    const size = child.type === 'text' ? (child.text || '').length : child.content ? 2 + jsonContentSize(child) : ['paragraph', 'heading', 'codeBlock'].includes(child.type) ? 2 : 1;
    if (child.type === 'text') {
      if (!runs.length) runStart = offset;
      runs.push({ text: child.text || '', set: text => { child.text = text; } });
    } else { flush(); replaceJson(child, replacement, edits, offset); }
    offset += size;
  }
  flush();
  node.content = node.content.filter(child => child.type !== 'text' || child.text);
}

function jsonContentSize(node) {
  return (node.content || []).reduce((sum, child) => sum + (child.type === 'text' ? (child.text || '').length : child.content ? 2 + jsonContentSize(child) : ['paragraph', 'heading', 'codeBlock'].includes(child.type) ? 2 : 1), 0);
}

function replaceHtml(html, replacement) {
  const root = document.createElement('div'); root.innerHTML = html;
  let runs = [];
  const edits = [];
  const flush = () => { replaceRuns(runs, replacement, edits); runs = []; };
  const visit = node => {
    if (node.nodeType === 3) runs.push({ text: node.nodeValue, set: value => { node.nodeValue = value; } });
    else {
      const block = /^(?:P|DIV|H[1-6]|BLOCKQUOTE|PRE|BR|HR)$/.test(node.nodeName);
      if (block) flush();
      if (!/^(?:SCRIPT|STYLE)$/.test(node.nodeName)) [...node.childNodes].forEach(visit);
      if (block) flush();
    }
  };
  [...root.childNodes].forEach(visit); flush();
  return edits.length ? root.innerHTML : html;
}

function renameBookmarks(values, blocks, edits, replacement) {
  return values.map(bookmark => ({ ...bookmark, parts: bookmark.parts.map(part => {
    const old = part.anchor;
    const anchor = !edits.length ? old : old.status === 'attached'
      ? anchorAt(blocks, mapRenamePosition(old.from, edits, -1), mapRenamePosition(old.to, edits), old.kind) || { ...old, status: 'unresolved' }
      : { ...old, quote: replacement.text(old.quote || ''), prefix: replacement.text(old.prefix || ''), suffix: replacement.text(old.suffix || '') };
    return { ...part, title: replacement.text(part.title), note: replacement.text(part.note), tags: part.tags.map(tag => replacement.text(tag)), anchor };
  }) }));
}

export function renameCharacterReferences(record, replacement, { characterId = '' } = {}) {
  const next = structuredClone(record);
  const visit = (value, character = false) => {
    if (!value || typeof value !== 'object' || value.locked || value.protectedStore) return;
    const richEdits = [];
    let oldBlocks, newBlocks;
    if (value.pmJson) {
      oldBlocks = jsonEditorIndex(value.pmJson);
      replaceJson(value.pmJson, replacement, richEdits);
      newBlocks = jsonEditorIndex(value.pmJson);
      if (richEdits.length) value.ast = tiptapJsonToLegacyAst(value.pmJson);
    } else if (value.ast?.blocks) {
      let pos = 1;
      oldBlocks = []; newBlocks = [];
      for (const block of value.ast.blocks) {
        const oldText = textFromHtml(block.html || '');
        oldBlocks.push({ id: block.id, from: pos, to: pos + oldText.length, text: oldText });
        block.html = replaceHtml(block.html || '', replacement);
        richEdits.push(...replacement.matches(oldText).map(edit => ({ ...edit, from: edit.from + pos, to: edit.to + pos })));
        pos += oldText.length + 2;
      }
      pos = 1;
      for (const block of value.ast.blocks) {
        const text = textFromHtml(block.html || '');
        newBlocks.push({ id: block.id, from: pos, to: pos + text.length, text }); pos += text.length + 2;
      }
    }
    const plainFields = new Map();
    for (const [key, child] of Object.entries(value)) {
      if (technicalField.test(key) || key.startsWith('_')) continue;
      if (character && characterIdentity.has(key)) continue;
      if (typeof child === 'string') { plainFields.set(key, child); value[key] = replacement.text(child); }
      else if (Array.isArray(child)) value[key] = child.map(item => {
        if (typeof item === 'string') return replacement.text(item);
        visit(item, key === 'characters'); return item;
      });
      else visit(child);
    }
    if (value.bookmarks?.length) {
      const plainField = typeof value.body === 'string' ? 'body' : 'text';
      const beforeText = plainFields.get(plainField) || '';
      value.bookmarks = renameBookmarks(normalizeBookmarks(value.bookmarks, oldBlocks || textIndex(beforeText), { plain: !oldBlocks }), newBlocks || textIndex(value[plainField] || ''), oldBlocks ? richEdits.sort((a, b) => a.from - b.from) : replacement.matches(beforeText), replacement);
    }
    for (const [field, values] of Object.entries(value.fieldBookmarks || {})) {
      const before = plainFields.get(field) || String(value[field] || '');
      value.fieldBookmarks[field] = renameBookmarks(normalizeBookmarks(values, textIndex(before), { plain: true }), textIndex(value[field] || ''), replacement.matches(before), replacement);
    }
    if (richEdits.length && value.ast && typeof value.summary === 'string') value.summary = value.description || buildSummary(value.ast);
    // Identity changes are applied explicitly to the edited character, never to namesakes.
    if (character && value.id === characterId) {
      value.aliases = (value.aliases || []).map(alias => replacement.text(alias));
      value.mentionForms = (value.mentionForms || []).map(form => replacement.text(form));
    }
  };
  visit(next);
  return next;
}

export function renameReviewAnchors(mark, doc, replacement) {
  const next = structuredClone(mark);
  for (const field of ['start', 'end']) {
    const anchor = next[field], block = doc?.ast?.blocks?.find(block => block.id === anchor?.blockId);
    if (block) anchor.offset = mapRenamePosition(anchor.offset, replacement.matches(textFromHtml(block.html || '')), field === 'start' ? -1 : 1);
  }
  return next;
}
