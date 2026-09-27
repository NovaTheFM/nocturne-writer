import assert from 'node:assert/strict';
import { ensureTiptapBlockIds, legacyAstToHtml, plainTextFromTiptapJson, tiptapJsonToLegacyAst } from '../src/editor/document-adapter.js';

const legacy = {
  type: 'doc',
  blocks: [
    { id: 'b1', type: 'heading', align: 'center', html: 'Title' },
    { id: 'b2', type: 'paragraph', align: 'left', html: 'A <strong>bold</strong> line' },
  ],
};

const legacyHtml = legacyAstToHtml(legacy);
assert.match(legacyHtml, /<h2 data-block-id="b1" style="text-align:center">Title<\/h2>/);
assert.match(legacyHtml, /<p data-block-id="b2">A <strong>bold<\/strong> line<\/p>/);

const pmJson = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2, textAlign: 'center', blockId: 'b1' }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      attrs: { blockId: 'b2' },
      content: [
        { type: 'text', text: 'A ' },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' line' },
      ],
    },
  ],
};

const ast = tiptapJsonToLegacyAst(pmJson);
assert.equal(ast.blocks.length, 2);
assert.deepEqual(ast.blocks[0], { id: 'b1', type: 'heading', align: 'center', html: 'Title' });
assert.deepEqual(ast.blocks[1], { id: 'b2', type: 'paragraph', align: 'left', html: 'A <strong>bold</strong> line' });
assert.equal(plainTextFromTiptapJson(pmJson), 'Title\n\nA bold line');

const withIds = ensureTiptapBlockIds({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Draft' }] }] });
assert.match(withIds.content[0].attrs.blockId, /^block-/);

const structured = tiptapJsonToLegacyAst({ type: 'doc', content: [
  { type: 'heading', attrs: { blockId: 'h3', level: 3 }, content: [{ type: 'text', text: 'Subheading' }] },
  { type: 'blockquote', attrs: { blockId: 'q' }, content: [
    { type: 'paragraph', attrs: { blockId: 'q1' }, content: [{ type: 'text', text: 'First paragraph' }] },
    { type: 'paragraph', attrs: { blockId: 'q2' }, content: [{ type: 'text', text: 'Second paragraph' }] },
  ] },
  { type: 'horizontalRule', attrs: { blockId: 'divider' } },
] });
assert.match(legacyAstToHtml(structured), /<h3/);
assert.match(legacyAstToHtml(structured), /First paragraph<\/p><p[^>]*>Second paragraph/);
assert.match(legacyAstToHtml(structured), /<hr/);

console.log('editor adapter tests passed');
