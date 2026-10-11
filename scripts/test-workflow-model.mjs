import assert from 'node:assert/strict';
import test from 'node:test';
import { diffText, findManuscriptText } from '../src/features/manuscript-search.js';
import { workflowDefaults, validateWorkflowSettings } from '../src/features/workflow-settings.js';

function referenceDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next[j + 1] = a[i] === b[j] ? row[j] : Math.min(row[j + 1], next[j]) + 1;
    row = next;
  }
  return row[b.length];
}

test('separated edits preserve all unchanged characters in counts and previews', () => {
  let seed = 41;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed; };
  for (let iteration = 0; iteration < 200; iteration++) {
    const text = () => Array.from({ length: random() % 25 }, () => 'abc абв'[random() % 7]).join('');
    const before = text(), after = text(), diff = diffText(before, after);
    assert.equal(diff.approximate, false);
    assert.equal(diff.added + diff.removed, referenceDistance(before, after));
    assert.equal(diff.segments.filter(part => part.type !== 'added').map(part => part.text).join(''), before);
    assert.equal(diff.segments.filter(part => part.type !== 'removed').map(part => part.text).join(''), after);
  }
});
test('large replacements have a bounded comparison and retain the complete texts', () => {
  const diff = diffText('a'.repeat(20000), 'b'.repeat(20000));
  assert.equal(diff.approximate, true); assert.equal(diff.removed, 20000); assert.equal(diff.added, 20000);
  assert.equal(diffText('', 'b'.repeat(20000)).approximate, false);
});
test('search folds yo, preserves real offsets, accepts inflections and exact word boundaries', () => {
  assert.deepEqual(findManuscriptText('Дом ёлка домовой Ёлка', 'елка', { foldYo: true }).map(match => match.start), [4, 17]);
  assert.equal(findManuscriptText('дом домовой', 'дом', { wholeWords: true }).length, 1);
  assert.equal(findManuscriptText('Анна встретила Анну.', 'Анна', { inflections: true }).length, 2);
  assert.equal(findManuscriptText('Ёлка', 'елка').length, 0);
});
test('workflow settings reject unknown modes and clamp numeric limits', () => {
  const result = validateWorkflowSettings({ ...workflowDefaults, historyTimerKeep: -5, historyLimitMB: Infinity, historyOpenMode: 'invalid' });
  assert.equal(result.historyTimerKeep, 1); assert.equal(result.historyLimitMB, 50); assert.equal(result.historyOpenMode, 'text');
});
