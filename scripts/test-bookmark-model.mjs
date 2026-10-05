import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorAt, bookmarkDefaults, bookmarkSignature, bookmarkTitle, cloneBookmarks, jsonEditorIndex, makeBookmark, mapBookmarks, normalizeBookmarks, overlapsBookmark, textChangeMapping, textIndex } from '../src/features/bookmark-model.js';

test('malformed imported bookmarks keep recoverable records without invalid coordinates', () => {
  const values = normalizeBookmarks([null, { version: 2, id: 'bad', parts: [null, { anchor: 'invalid' }, { anchor: { from: Infinity, to: NaN } }] }], textIndex('Text'));
  assert.equal(values.length, 1); assert.equal(values[0].parts.length, 2);
  for (const part of values[0].parts) { assert.equal(part.anchor.status, 'unresolved'); assert.ok(Number.isFinite(part.anchor.from)); assert.ok(Number.isFinite(part.anchor.to)); }
});

test('a point is an exact position without a quoted or inserted character', () => {
  const anchor = anchorAt(textIndex('А😀Б'), 3, 3, 'point');
  assert.equal(anchor.from, 3); assert.equal(anchor.to, 3); assert.equal(anchor.quote, '');
  const bookmark = makeBookmark(anchor, { number: 4 }); assert.equal(bookmark.parts[0].title, 'Закладка 4');
});
test('a range retains both paragraphs and a paragraph expands to its boundaries', () => {
  const blocks = textIndex('Первая строка\nВторая строка');
  const range = anchorAt(blocks, 4, 20, 'range');
  assert.equal(range.start.blockId, 'line-0'); assert.equal(range.end.blockId, 'line-1'); assert.equal(range.quote, 'ая строка\nВторая');
  const paragraph = anchorAt(blocks, 17, 17, 'paragraph'); assert.equal(paragraph.from, 14); assert.equal(paragraph.to, 27);
});
test('inserting before a bookmark follows the original text', () => {
  const before = 'abcdef', after = 'XXabcdef';
  const bookmark = makeBookmark(anchorAt(textIndex(before), 3, 3, 'point'));
  const result = mapBookmarks([bookmark], textChangeMapping(before, after), textIndex(after));
  assert.equal(result.bookmarks[0].parts[0].anchor.from, 5); assert.equal(bookmark.parts[0].anchor.from, 3);
});
test('partially deleting a range keeps its surviving text and fully deleting moves it out', () => {
  const before = 'one two three', bookmark = makeBookmark(anchorAt(textIndex(before), 4, 7, 'range'));
  const partial = mapBookmarks([bookmark], textChangeMapping(before, 'one to three'), textIndex('one to three'));
  assert.equal(partial.bookmarks.length, 1); assert.equal(partial.bookmarks[0].parts[0].anchor.quote, 'to');
  const full = mapBookmarks([bookmark], textChangeMapping(before, 'one  three'), textIndex('one  three'));
  assert.equal(full.bookmarks.length, 0); assert.equal(full.deleted.length, 1);
});
test('deleted point supports trash, detached and nearest policies', () => {
  const before = 'abcdef', after = 'abef', values = [makeBookmark(anchorAt(textIndex(before), 3, 3, 'point'))];
  const project = policy => mapBookmarks(values, textChangeMapping(before, after), textIndex(after), { ...bookmarkDefaults, bookmarkDeletedText: policy });
  assert.equal(project('delete').bookmarks.length, 0);
  assert.equal(project('detach').bookmarks[0].parts[0].anchor.status, 'unresolved');
  assert.equal(project('nearest').bookmarks[0].parts[0].anchor.from, 2);
});
test('legacy anchors migrate only when their location is reliable', () => {
  const blocks = [{ id: 'a', from: 1, to: 16, text: 'same and same!!' }];
  const migrated = normalizeBookmarks([{ id: 'old', quote: 'same', start: { blockId: 'a', offset: 0 } }], blocks);
  assert.equal(migrated[0].parts[0].anchor.status, 'attached');
  const missing = normalizeBookmarks([{ id: 'lost', quote: 'same' }], blocks);
  assert.equal(missing[0].parts[0].anchor.status, 'unresolved');
  assert.equal(normalizeBookmarks(migrated, blocks)[0].parts[0].anchor.from, migrated[0].parts[0].anchor.from);
});
test('copies get independent IDs and remain grouped until their content differs', () => {
  const original = makeBookmark(anchorAt(textIndex('long text'), 0, 4, 'range'));
  const copy = cloneBookmarks([original], 'new')[0];
  assert.notEqual(original.id, copy.id); assert.notEqual(original.parts[0].id, copy.parts[0].id); assert.equal(original.groupId, copy.groupId);
  assert.equal(bookmarkSignature(original), bookmarkSignature(copy)); copy.parts[0].note = 'own note';
  assert.notEqual(bookmarkSignature(original), bookmarkSignature(copy)); assert.equal(original.parts[0].note, '');
});
test('stack intersections and capped automatic titles are deterministic', () => {
  const blocks = textIndex('a b c d e f g h i j k l m n o p');
  const a = makeBookmark(anchorAt(blocks, 0, 6, 'range')), b = makeBookmark(anchorAt(blocks, 5, 10, 'range'));
  assert.equal(overlapsBookmark(a, b), true);
  assert.ok(bookmarkTitle(blocks[0].text, 20).length <= 20);
});
test('JSON document offsets account for nested blocks and non-text nodes', () => {
  const blocks = jsonEditorIndex({ content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: 'abc' }] }, { type: 'blockquote', content: [{ type: 'paragraph', attrs: { blockId: 'p2' }, content: [{ type: 'text', text: 'xy' }] }] }] });
  assert.deepEqual(blocks.map(block => [block.id, block.from, block.to]), [['p1', 1, 4], ['p2', 7, 9]]);
});
test('replacing an entire marked fragment removes its original anchor', () => {
  const before = 'one two three', after = 'one NEW three', bookmark = makeBookmark(anchorAt(textIndex(before), 4, 7, 'range'));
  const result = mapBookmarks([bookmark], textChangeMapping(before, after), textIndex(after));
  assert.equal(result.bookmarks.length, 0); assert.equal(result.deleted.length, 1);
});
test('adjacent fragments and gaps inside a folded bookmark do not overlap', () => {
  const blocks = textIndex('abcdefghijk'), a = makeBookmark(anchorAt(blocks, 0, 3, 'range')), b = makeBookmark(anchorAt(blocks, 3, 6, 'range'));
  assert.equal(overlapsBookmark(a, b), false);
  a.parts.push(...makeBookmark(anchorAt(blocks, 8, 10, 'range')).parts);
  assert.equal(overlapsBookmark(a, makeBookmark(anchorAt(blocks, 5, 6, 'range'))), false);
});
