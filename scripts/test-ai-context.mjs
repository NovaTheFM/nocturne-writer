import assert from 'node:assert/strict';
import { buildAiContext, collectRelevantLore, estimateContextSize } from '../src/features/ai-context.js';
const state = { lore: { characters: [{ id: 'linked', name: 'Alice', documentIds: ['chapter'] }], locations: [], timeline: [], rules: [{ id: 'rule', title: 'Magic', body: 'Magic requires sunlight' }] } };
const doc = { id: 'chapter', title: 'Test', ast: { blocks: [{ id: 'b', html: 'A scene.' }] } };
assert.equal(collectRelevantLore({ state, doc, query: 'A scene' }).characters.length, 1);
assert.equal(buildAiContext({ state, doc }).rules.length, 1);
const context = buildAiContext({ state, doc: { ...doc, title: 'x'.repeat(10000), description: 'y'.repeat(10000) }, budget: 1500 });
assert.ok(estimateContextSize(context) <= 1500);
console.log('AI context relevance rules and budget tests passed');
