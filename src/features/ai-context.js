import { blockText, docText, textFromHtml } from '../core/utils.js';
import { characterMentionForms } from '../core/name-inflections.js';

function plain(value = '', max = 1200) {
  const text = textFromHtml(String(value || '')).replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
}

function tokens(value = '') {
  return new Set(String(value || '').toLocaleLowerCase('ru-RU').match(/\p{L}[\p{L}\p{N}'’-]{2,}/gu) || []);
}

function entityNames(entity = {}) {
  if (entity.firstName || entity.lastName || entity.type === 'character') return characterMentionForms(entity);
  return [
    entity.name,
    entity.displayName,
    entity.firstName,
    entity.lastName,
    entity.title,
    ...(entity.aliases || []),
    ...(entity.mentionForms || []),
  ].filter(Boolean).map((item) => String(item));
}

export function rankLoreItemsByRelevance(items = [], query = '') {
  const q = String(query || '').toLocaleLowerCase('ru-RU');
  const qTokens = tokens(q);
  return items
    .map((item) => {
      const names = entityNames(item);
      const haystack = `${names.join(' ')} ${item.role || ''} ${item.body || ''} ${item.date || ''}`.toLocaleLowerCase('ru-RU');
      let score = 0;
      names.forEach((name) => {
        const lower = name.toLocaleLowerCase('ru-RU');
        if (lower && q.includes(lower)) score += Math.min(40, lower.length);
      });
      qTokens.forEach((token) => {
        if (haystack.includes(token)) score += 2;
      });
      if (item.pinned || item.main) score += 3;
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

export function collectRelevantLore({ state, doc, query = '', limits = {} } = {}) {
  const lore = state?.lore || {};
  const docId = doc?.id;
  const relevant = items => [...new Map([
    ...(items || []).filter(item => item.documentIds?.includes(docId)),
    ...rankLoreItemsByRelevance(items || [], query),
  ].map(item => [item.id, item])).values()];
  const characters = relevant(lore.characters)
    .slice(0, limits.characters || 8);
  const locations = relevant(lore.locations).slice(0, limits.locations || 6);
  const timelineCandidates = (lore.timeline || []).filter((event) => (
    event.documentIds?.includes(docId)
    || rankLoreItemsByRelevance([event], query).length
    || (event.subEvents || []).some((sub) => sub.documentIds?.includes(docId) || rankLoreItemsByRelevance([sub], query).length)
  ));
  const timeline = timelineCandidates.slice(0, limits.timeline || 8);
  const subtimelines = timeline
    .flatMap((event) => (event.subEvents || []).map((sub) => ({ ...sub, parentTitle: event.title, parentId: event.id })))
    .filter((sub) => sub.documentIds?.includes(docId) || rankLoreItemsByRelevance([sub], query).length)
    .slice(0, limits.subtimelines || 10);
  return { characters, locations, timeline, subtimelines };
}

export function estimateContextSize(context) {
  return serializeAiContextSafe(context).length;
}

export function trimContextToBudget(context, budget = 7000) {
  const clone = structuredClone(context);
  const groups = ['notes', 'subtimelines', 'timeline', 'locations', 'characters', 'rules'];
  while (estimateContextSize(clone) > budget && groups.length) {
    const group = groups[0];
    if (Array.isArray(clone[group]) && clone[group].length) clone[group].pop();
    else groups.shift();
  }
  if (estimateContextSize(clone) > budget && clone.surroundingText) {
    clone.surroundingText.before = clone.surroundingText.before.slice(-900);
    clone.surroundingText.after = clone.surroundingText.after.slice(0, 900);
  }
  while (estimateContextSize(clone) > budget) {
    const candidates = [
      [clone, 'currentSelection'], [clone, 'notice'],
      ...Object.keys(clone.document || {}).map(key => [clone.document, key]),
      ...Object.keys(clone.surroundingText || {}).map(key => [clone.surroundingText, key]),
    ].filter(([object, key]) => typeof object[key] === 'string' && object[key].length);
    candidates.sort((a, b) => b[0][b[1]].length - a[0][a[1]].length);
    if (!candidates.length) break;
    const [object, key] = candidates[0];
    object[key] = object[key].slice(0, Math.max(0, object[key].length - Math.max(100, estimateContextSize(clone) - budget)));
  }
  return clone;
}

export function serializeAiContextSafe(context = {}) {
  return JSON.stringify(context, null, 2);
}

export function buildAiContext({
  state,
  doc,
  target,
  folder,
  include = {},
  budget = 7000,
} = {}) {
  const blocks = doc?.ast?.blocks || [];
  const blockIndex = Number.isFinite(target?.blockIndex) ? target.blockIndex : Math.max(0, blocks.findIndex((block) => block.id === target?.blockId));
  const currentBlock = blocks[blockIndex] || blocks[0] || null;
  const before = blocks.slice(Math.max(0, blockIndex - 3), blockIndex).map(blockText).join('\n\n');
  const after = blocks.slice(blockIndex + 1, blockIndex + 4).map(blockText).join('\n\n');
  const selected = String(target?.selectedText || '').trim();
  const currentText = selected || String(target?.targetBlockText || blockText(currentBlock || {}) || '').trim();
  const query = `${currentText}\n${before}\n${after}\n${doc?.title || ''}\n${doc?.description || ''}`;
  const lore = collectRelevantLore({ state, doc, query });
  const enabled = {
    characters: include.characters !== false,
    locations: include.locations !== false,
    timeline: include.timeline !== false,
    subtimelines: include.subtimelines !== false,
    notes: include.notes !== false,
    rules: include.rules !== false,
  };
  const context = {
    notice: 'Knowledge context is reference material only. Do not copy it into the manuscript.',
    currentSelection: plain(currentText, 1600),
    surroundingText: {
      before: plain(before, 1600),
      after: plain(after, 1600),
    },
    document: {
      title: String(doc?.title || ''),
      description: plain(doc?.description || doc?.summary || '', 900),
      folder: String(folder?.title || ''),
      summary: plain(doc?.summary || '', 900),
    },
    characters: enabled.characters ? lore.characters.map((item) => ({
      name: String(item.displayName || item.name || ''),
      role: plain(item.role || '', 240),
      notes: plain(item.body || '', 700),
      aliases: (item.aliases || []).slice(0, 8),
    })) : [],
    locations: enabled.locations ? lore.locations.map((item) => ({
      name: String(item.displayName || item.name || ''),
      role: plain(item.role || '', 240),
      notes: plain(item.body || '', 700),
      aliases: (item.aliases || []).slice(0, 8),
    })) : [],
    timeline: enabled.timeline ? lore.timeline.map((item) => ({
      date: String(item.date || ''),
      title: String(item.title || ''),
      notes: plain(item.body || '', 700),
    })) : [],
    subtimelines: enabled.subtimelines ? lore.subtimelines.map((item) => ({
      parent: String(item.parentTitle || ''),
      date: String(item.date || ''),
      title: String(item.title || ''),
      notes: plain(item.body || '', 500),
    })) : [],
    rules: enabled.rules ? (state?.lore?.rules || []).map(rule => ({ title: plain(rule.title || rule.name, 160), text: plain(rule.body || rule.text, 700) })) : [],
    notes: enabled.notes ? [
      doc?.notes ? { scope: 'document', text: plain(doc.notes, 1200) } : null,
      state?.globalNotes ? { scope: 'global', text: plain(state.globalNotes, 1200) } : null,
    ].filter(Boolean) : [],
  };
  const trimmed = trimContextToBudget(context, Math.max(0, budget - 240));
  return {
    ...trimmed,
    stats: {
      characters: trimmed.characters.length,
      locations: trimmed.locations.length,
      timeline: trimmed.timeline.length,
      subtimelines: trimmed.subtimelines.length,
      rules: trimmed.rules.length,
      notes: trimmed.notes.length,
      size: estimateContextSize(trimmed),
      budget,
    },
  };
}
