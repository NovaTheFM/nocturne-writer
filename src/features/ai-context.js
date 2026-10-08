import { blockText, textFromHtml } from '../core/utils.js';

export const contextGroups = [['characters', 'Персонажи'], ['locations', 'Локации'], ['timeline', 'События'], ['subtimelines', 'Сабтаймлайны'], ['notes', 'Записи и заметки'], ['rules', 'Правила мира']];
export const contextKey = (group, id) => `${group}:${id}`;
const canonical = item => item.canonStatus !== 'draft' && item.confirmed !== false;
function eventOrder(event, index) {
  const value = String(event.date || '').trim();
  const year = value.match(/(?:год|г\.?)\s*(-?\d+)/iu);
  if (year) return Number(year[1]);
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  if (/^\d{4}-\d{2}-\d{2}/u.test(value)) return Date.parse(value);
  return Number.isFinite(event.order) ? event.order : index;
}

export function aiContextCatalog({ state, doc } = {}) {
  const lore = state?.lore || {}, events = lore.timeline || [];
  const ranks = new Map(events.map((item, index) => [item.id, eventOrder(item, index)]));
  const scene = events.find(item => item.id === doc?.sceneEventId && canonical(item)) || [...events].filter(item => canonical(item) && item.documentIds?.includes(doc?.id)).sort((a, b) => ranks.get(a.id) - ranks.get(b.id))[0];
  const available = (item, group) => {
    if (!canonical(item)) return 'Черновой или неподтверждённый материал';
    if (item.knownFromEventId && (!scene || !ranks.has(item.knownFromEventId) || ranks.get(item.knownFromEventId) > ranks.get(scene.id))) return 'Эти сведения ещё не действуют во время сцены';
    if (item.knownUntilEventId && (!scene || !ranks.has(item.knownUntilEventId) || ranks.get(item.knownUntilEventId) <= ranks.get(scene.id))) return 'Срок действия сведений закончился или неизвестен';
    if (['timeline', 'subtimelines'].includes(group)) {
      if (!scene) return 'Укажите момент сцены, чтобы исключить будущие события';
      const rank = group === 'timeline' ? ranks.get(item.id) : ranks.get(item.parentId);
      if (rank > ranks.get(scene.id)) return 'Будущее относительно выбранной сцены';
      if (group === 'subtimelines' && item.date && eventOrder(item, 0) > ranks.get(scene.id)) return 'Будущее относительно выбранной сцены';
    }
    return '';
  };
  const lists = { ...lore, subtimelines: events.flatMap(event => (event.subEvents || []).map(item => ({ ...item, parentId: event.id, parentTitle: event.title, canonStatus: canonical(event) ? item.canonStatus : 'draft' }))), notes: [...(lore.notes || []), ...(doc?.notes ? [{ id: 'document-notes', title: 'Заметки главы', body: doc.notes }] : []), ...(state?.globalNotes ? [{ id: 'global-notes', title: 'Общие заметки', body: state.globalNotes }] : [])] };
  const items = contextGroups.flatMap(([group]) => (lists[group] || []).map(item => {
    const facts = (item.aiFacts || []).filter(fact => !available(fact, 'facts')).map(fact => fact.text).filter(Boolean);
    const safe = { ...item, body: item.aiFacts?.length ? facts.join('\n') : item.body || item.text || '' };
    const reason = available(item, group) || (item.aiFacts?.length && !facts.length ? 'Нет подтверждённых фактов для выбранного момента' : '');
    return { key: contextKey(group, item.id), group, item: safe, reason };
  }));
  return { items, scene, events };
}

function plain(value = '', max = 1200) {
  const text = textFromHtml(String(value || '')).replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
}

function tokens(value = '') {
  return new Set(String(value || '').toLocaleLowerCase('ru-RU').match(/\p{L}[\p{L}\p{N}'’-]{2,}/gu) || []);
}

function entityNames(entity = {}) {
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
  selection = {},
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
  const relevant = collectRelevantLore({ state, doc, query });
  const catalog = aiContextCatalog({ state, doc });
  const automatic = new Set(contextGroups.flatMap(([group]) => (relevant[group] || (group === 'rules' || group === 'notes' ? catalog.items.filter(entry => entry.group === group).map(entry => entry.item) : [])).map(item => contextKey(group, item.id))));
  const mode = selection.mode || 'automatic';
  const picked = mode === 'automatic' ? new Set([...automatic, ...(selection.pinned || [])]) : new Set(selection.selected || []);
  (selection.excluded || []).forEach(key => picked.delete(key));
  const allowed = catalog.items.filter(entry => picked.has(entry.key) && !entry.reason && include[entry.group] !== false);
  const lore = Object.fromEntries(contextGroups.map(([group]) => [group, allowed.filter(entry => entry.group === group).map(entry => entry.item)]));
  const enabled = {
    characters: include.characters !== false,
    locations: include.locations !== false,
    timeline: include.timeline !== false,
    subtimelines: include.subtimelines !== false,
    notes: include.notes !== false,
    rules: include.rules !== false,
  };
  const context = {
    notice: 'Use only the confirmed facts provided here, at or before the scene. Omitted or future facts are unknown. Reference material must not be copied into the manuscript.',
    scene: catalog.scene ? { title: String(catalog.scene.title || ''), date: String(catalog.scene.date || '') } : null,
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
      id: item.id,
      name: String(item.displayName || item.name || ''),
      role: plain(item.role || '', 240),
      notes: plain(item.body || '', 700),
      aliases: (item.aliases || []).slice(0, 8),
    })) : [],
    locations: enabled.locations ? lore.locations.map((item) => ({
      id: item.id,
      name: String(item.displayName || item.name || ''),
      role: plain(item.role || '', 240),
      notes: plain(item.body || '', 700),
      aliases: (item.aliases || []).slice(0, 8),
    })) : [],
    timeline: enabled.timeline ? lore.timeline.map((item) => ({
      id: item.id,
      date: String(item.date || ''),
      title: String(item.title || ''),
      notes: plain(item.body || '', 700),
    })) : [],
    subtimelines: enabled.subtimelines ? lore.subtimelines.map((item) => ({
      id: item.id,
      parent: String(item.parentTitle || ''),
      date: String(item.date || ''),
      title: String(item.title || ''),
      notes: plain(item.body || '', 500),
    })) : [],
    rules: enabled.rules ? lore.rules.map(rule => ({ id: rule.id, title: plain(rule.title || rule.name, 160), text: plain(rule.body || rule.text, 700) })) : [],
    notes: enabled.notes ? lore.notes.map(item => ({ id: item.id, title: plain(item.title, 160), text: plain(item.body, 1200) })) : [],
  };
  const trimmed = trimContextToBudget(context, Math.max(0, budget - 400));
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
      omitted: catalog.items.filter(entry => picked.has(entry.key) && (entry.reason || include[entry.group] === false)).length + allowed.length - contextGroups.reduce((sum, [group]) => sum + trimmed[group].length, 0),
      considered: picked.size,
    },
  };
}
