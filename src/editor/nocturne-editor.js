import { Editor, Extension, StarterKit, TextAlign, Underline, Placeholder, Plugin, PluginKey, Decoration, DecorationSet, HorizontalRule, TextSelection } from '../vendor/tiptap/nocturne-tiptap.bundle.js';
import { ensureTiptapBlockIds, legacyAstToHtml, tiptapJsonToLegacyAst } from './document-adapter.js';
import { calculateVisualPages, updateActivePageHighlight } from './visual-pagination.js';
import { NocturneWriterAnalysis, writerAnalysisKey } from './writer-analysis.js';
import { paginationPluginKey } from './pagination-state.js';
import { normalizeTypoToken } from '../core/typos.js';
import { uid, buildSummary } from '../core/utils.js';

export { paginationPluginKey };
export const activeBlockPluginKey = new PluginKey('nocturneActiveBlock');

const NocturneActiveBlock = Extension.create({
  name: 'nocturneActiveBlock',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: activeBlockPluginKey,
        props: {
          decorations(state) {
            const { $from } = state.selection;
            if (!$from || $from.depth < 1) return DecorationSet.empty;
            try {
              const start = $from.before(1);
              const end = $from.after(1);
              const dec = Decoration.node(start, end, { class: 'active-block' });
              return DecorationSet.create(state.doc, [dec]);
            } catch (e) {
              return DecorationSet.empty;
            }
          },
        },
      }),
    ];
  },
});

const NocturnePagination = Extension.create({
  name: 'nocturnePagination',
  addProseMirrorPlugins() {
    const bridge = this.options.bridge;
    return [
      new Plugin({
        key: paginationPluginKey,
        state: {
          init() {
            return {
              decorations: DecorationSet.empty,
              pageBreaks: [],
            };
          },
          apply(tr, value) {
            const meta = tr.getMeta(paginationPluginKey);
            if (meta) {
              return meta;
            }
            const mappedBreaks = value.pageBreaks.map(brk => {
              try {
                return { ...brk, pos: tr.mapping.map(brk.pos) };
              } catch (e) {
                return brk;
              }
            });
            return {
              decorations: value.decorations.map(tr.mapping, tr.doc),
              pageBreaks: mappedBreaks,
            };
          },
        },
        props: {
          decorations(state) {
            const paginationState = paginationPluginKey.getState(state);
            return paginationState.decorations;
          },
        },
        view(editorView) {
          return {
            update(view, prevState) {
              if (view.state.doc !== prevState.doc) bridge.scheduleVisualPages(view.dom.getAttribute('data-pane-id'));
            },
          };
        },
      }),
    ];
  },
});

const BlockIdentity = Extension.create({
  name: 'nocturneBlockIdentity',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'blockquote'],
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-block-id'),
            renderHTML: (attributes) => attributes.blockId ? { 'data-block-id': attributes.blockId } : {},
          },
        },
      },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('nocturneBlockIdentity'),
        appendTransaction(transactions, oldState, newState) {
          if (!transactions.some(tr => tr.docChanged)) {
            return;
          }
          if (oldState.doc.childCount === newState.doc.childCount && !transactions.some(tr => tr.steps.some(s => s.toJSON?.()?.stepType === 'replace' && (s.from !== s.to || s.slice?.content?.length > 1)))) {
            return;
          }
          let tr = newState.tr;
          let modified = false;
          const seenIds = new Set();
          newState.doc.descendants((node, pos) => {
            if (['paragraph', 'heading', 'blockquote'].includes(node.type.name)) {
              const id = node.attrs.blockId;
              if (!id || seenIds.has(id)) {
                const newId = uid('block');
                tr = tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  blockId: newId,
                });
                modified = true;
                seenIds.add(newId);
              } else {
                seenIds.add(id);
              }
            }
          });
          if (modified) {
            return tr;
          }
        },
      }),
    ];
  },
});

function isEntityBoundary(char) {
  return !char || !/[\p{L}\p{N}_]/u.test(char);
}

function buildEntityLookupMap(index) {
  const map = new Map();
  if (!index || !index.length) return map;
  for (let i = 0; i < index.length; i++) {
    const item = index[i];
    const firstChar = item.normalized ? item.normalized[0] : '';
    if (firstChar) {
      if (!map.has(firstChar)) map.set(firstChar, []);
      map.get(firstChar).push(item);
    }
  }
  return map;
}

function findEntityMatches(text, index, lookupMap = null) {
  if (!text || !index || !index.length) return [];
  const normalizedText = normalizeTypoToken(text);
  const matches = [];
  const map = lookupMap || buildEntityLookupMap(index);
  const len = text.length;
  let pos = 0;

  while (pos < len) {
    if (!isEntityBoundary(text[pos - 1])) {
      while (pos < len && !isEntityBoundary(text[pos])) {
        pos++;
      }
      pos++;
      continue;
    }

    const firstChar = normalizedText[pos];
    const candidates = map.get(firstChar);
    let matched = null;

    if (candidates && candidates.length > 0) {
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const mLen = candidate.mention.length;
        if (pos + mLen <= len &&
            normalizedText.startsWith(candidate.normalized, pos) &&
            isEntityBoundary(text[pos + mLen])) {
          matched = candidate;
          break;
        }
      }
    }

    if (matched) {
      matches.push({ ...matched, start: pos, end: pos + matched.mention.length });
      pos += matched.mention.length;
    } else {
      pos += 1;
    }
  }
  return matches;
}

const NocturneEntityMentions = Extension.create({
  name: 'nocturneEntityMentions',
  addOptions() {
    return {
      getMentionIndex: () => [],
    };
  },
  addProseMirrorPlugins() {
    const extension = this;
    const key = new PluginKey('nocturneEntityMentions');
    let cachedMentionIndex = null;
    let cachedLookupMap = null;

    const getIndexAndMap = () => {
      const index = extension.options.getMentionIndex() || [];
      if (index !== cachedMentionIndex) {
        cachedMentionIndex = index;
        cachedLookupMap = buildEntityLookupMap(index);
      }
      return { index: cachedMentionIndex, lookupMap: cachedLookupMap };
    };

    const scanNodeForDecos = (doc, fromPos, toPos, index, lookupMap) => {
      const decos = [];
      doc.nodesBetween(fromPos, toPos, (node, pos) => {
        if (node.isText) {
          const text = node.text || '';
          const matches = findEntityMatches(text, index, lookupMap);
          matches.forEach((match) => {
            const from = pos + match.start;
            const to = pos + match.end;

            const attrs = {
              class: match.type === 'family-group' ? 'entity-link entity-family-link' : 'entity-link',
              tabindex: '0',
            };

            if (match.type === 'family-group') {
              attrs['data-entity-kind'] = 'family';
              attrs['data-family-name'] = match.familyName;
              attrs['data-entity-label'] = `Семья ${match.familyName}`;
              attrs['aria-label'] = `Семья ${match.familyName}`;
            } else {
              attrs['data-entity-kind'] = match.kind;
              attrs['data-entity-id'] = match.entity.id;
              attrs['data-entity-label'] = match.entity.displayName || match.entity.name;
              attrs['aria-label'] = match.entity.displayName || match.entity.name;
            }

            decos.push(Decoration.inline(from, to, attrs));
          });
        }
      });
      return decos;
    };

    const buildFullDecos = (doc) => {
      const { index, lookupMap } = getIndexAndMap();
      if (!index || !index.length) return DecorationSet.empty;
      const decos = scanNodeForDecos(doc, 0, doc.content.size, index, lookupMap);
      return DecorationSet.create(doc, decos);
    };

    return [
      new Plugin({
        key,
        state: {
          init(config, instance) {
            return buildFullDecos(instance.doc);
          },
          apply(tr, value, oldState, newState) {
            const forced = tr.getMeta('nocturneEntityMentionsForceUpdate');
            if (forced) {
              return buildFullDecos(newState.doc);
            }
            if (!tr.docChanged) {
              return value;
            }

            const { index, lookupMap } = getIndexAndMap();
            if (!index || !index.length) {
              return DecorationSet.empty;
            }

            let decos = value.map(tr.mapping, newState.doc);

            tr.steps.forEach(step => {
              step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
                const docSize = newState.doc.content.size;
                if (docSize <= 0) return;
                const safeStart = Math.max(0, Math.min(newStart, docSize));
                const safeEnd = Math.max(0, Math.min(newEnd, docSize));
                const $from = newState.doc.resolve(safeStart);
                const $to = newState.doc.resolve(safeEnd);
                const blockStart = $from.start($from.depth);
                const blockEnd = $to.end($to.depth);

                decos = decos.remove(decos.find(blockStart, blockEnd));

                const newBlockDecos = scanNodeForDecos(newState.doc, blockStart, blockEnd, index, lookupMap);
                if (newBlockDecos.length > 0) {
                  decos = decos.add(newState.doc, newBlockDecos);
                }
              });
            });

            return decos;
          },
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
      }),
    ];
  },
});

function bridgeFindBestQuoteOffset(text, quote, prefix = '', suffix = '', oldOffset = 0) {
  if (!quote) return -1;
  const matches = [];
  let index = text.indexOf(quote);
  while (index >= 0) {
    let score = 0;
    const before = text.slice(Math.max(0, index - String(prefix).length), index);
    const after = text.slice(index + quote.length, index + quote.length + String(suffix).length);
    if (prefix && before.endsWith(prefix)) score += prefix.length;
    if (suffix && after.startsWith(suffix)) score += suffix.length;
    matches.push({ index, score, distance: Math.abs(index - Number(oldOffset || 0)) });
    index = text.indexOf(quote, index + Math.max(1, quote.length));
  }
  if (!matches.length) return -1;
  matches.sort((a, b) => b.score - a.score || a.distance - b.distance);
  if (matches.length > 1 && matches[0].score === matches[1].score && matches[0].score === 0) return -1;
  return matches[0].index;
}

const createHouseWidget = (bookmarkId, isActive) => {
  const element = document.createElement('span');
  element.className = isActive ? 'nocturne-bookmark-house active' : 'nocturne-bookmark-house';
  element.setAttribute('data-bookmark-id', bookmarkId);
  element.innerHTML = `
    <button class="nocturne-bookmark-house-inner" type="button" aria-label="Перейти к закладке">
      <svg class="nocturne-bookmark-svg" viewBox="0 0 40 46" aria-hidden="true"><path d="M20 2 37 17v22a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V17Z" /></svg>
      <i class="bx bxs-bookmark" aria-hidden="true"></i>
    </button>
  `;
  const button = element.querySelector('button');
  button.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const paneId = element.closest('.workspace-pane')?.dataset.paneId;
    if (paneId) window.nocturneApp?.activateBookmark(paneId, bookmarkId);
  });
  return element;
};

const NocturneBookmarks = Extension.create({
  name: 'nocturneBookmarks',
  addOptions() {
    return {
      getBookmarks: () => [],
      getActiveBookmarkId: () => null,
    };
  },
  addProseMirrorPlugins() {
    const extension = this;
    const key = new PluginKey('nocturneBookmarks');
    
    const buildDecos = (doc) => {
      const decos = [];
      const bookmarks = extension.options.getBookmarks() || [];
      if (!bookmarks.length) return DecorationSet.empty;
      const activeId = extension.options.getActiveBookmarkId() || null;
      
      bookmarks.forEach((b) => {
        let startPos = -1;
        let endPos = -1;
        
        doc.descendants((node, pos) => {
          if (node.attrs?.blockId === b.start?.blockId) {
            const text = node.textContent || '';
            let localOffset = b.start?.offset || 0;
            if (b.quote) {
              const found = bridgeFindBestQuoteOffset(text, b.quote, b.prefix, b.suffix);
              if (found >= 0) localOffset = found;
            }
            startPos = pos + 1 + Math.max(0, Math.min(text.length, localOffset));
            endPos = startPos + (b.quote ? b.quote.length : 0);
            return false;
          }
        });
        
        if (startPos >= 0 && endPos >= startPos) {
          const isActive = b.id === activeId;
          const rangeClass = isActive ? 'nocturne-bookmark-range active' : 'nocturne-bookmark-range';
          
          decos.push(Decoration.inline(startPos, endPos, {
            class: rangeClass,
            'data-bookmark-id': b.id
          }));
          
          decos.push(Decoration.widget(startPos, () => createHouseWidget(b.id, isActive), {
            side: -1,
            ignoreSelection: true
          }));
        }
      });
      
      decos.sort((a, b) => {
        if (a.from !== b.from) return a.from - b.from;
        return a.isInline ? -1 : 1;
      });
      return DecorationSet.create(doc, decos);
    };

    return [
      new Plugin({
        key,
        state: {
          init(config, instance) {
            return buildDecos(instance.doc);
          },
          apply(tr, value, oldState, newState) {
            const forced = tr.getMeta('nocturneBookmarksForceUpdate');
            if (forced) {
              return buildDecos(newState.doc);
            }
            return value.map(tr.mapping, newState.doc);
          }
        },
        props: {
          decorations(state) {
            return key.getState(state);
          }
        }
      })
    ];
  }
});

const NocturneAutoformat = Extension.create({
  name: 'nocturneAutoformat',
  addOptions() {
    return {
      getSettings: () => ({}),
    };
  },
  addProseMirrorPlugins() {
    const extension = this;
    let lastDoubleDashReplacement = null;

    return [
      new Plugin({
        key: new PluginKey('nocturneAutoformat'),
        props: {
          handleTextInput(view, from, to, text) {
            const settings = extension.options.getSettings() || {};
            const state = view.state;
            const $from = state.selection.$from;
            if ($from.depth === 0 || view.composing || from !== to || $from.parent.type.name === 'codeBlock' || state.storedMarks?.some(mark => mark.type.name === 'code') || $from.marks().some(mark => mark.type.name === 'code')) return false;
            const parent = $from.parent;
            const textBefore = parent.textBetween(0, $from.parentOffset, null, '\0');

            if ((settings.autoReplaceDoubleDash || settings.smartPunctuation) && text === '-' && textBefore.endsWith('-')) {
              const start = $from.pos - 1;
              const tr = state.tr.insertText('—', start, $from.pos);
              view.dispatch(tr);
              const newPos = view.state.selection.from;
              lastDoubleDashReplacement = {
                pos: newPos,
                timestamp: Date.now()
              };
              return true; // handled
            }

            if (settings.smartPunctuation && text === '.' && textBefore.endsWith('..')) {
              view.dispatch(state.tr.insertText('…', from - 2, to));
              return true;
            }
            if (settings.smartPunctuation && text === '"') {
              const opening = !textBefore || /[\s([{—–-]$/u.test(textBefore);
              view.dispatch(state.tr.insertText(opening ? '«' : '»', from, to));
              return true;
            }

            if (settings.autoReplaceEnDash && text === ' ' && textBefore.endsWith(' -')) {
              const start = $from.pos - 1; // position of '-'
              const tr = state.tr.insertText('–', start, $from.pos);
              view.dispatch(tr);
              return false; // let Prosemirror insert the typed space after '–'
            }

            return false;
          },
          handleKeyDown(view, event) {
            if (event.key === 'Backspace') {
              const state = view.state;
              const { selection } = state;
              if (selection.empty && lastDoubleDashReplacement) {
                const pos = selection.from;
                const timeDiff = Date.now() - lastDoubleDashReplacement.timestamp;
                if (pos === lastDoubleDashReplacement.pos && timeDiff < 10000) {
                  const $from = selection.$from;
                  const textBefore = $from.parent.textBetween(0, $from.parentOffset, null, '\0');
                  if (textBefore.endsWith('—')) {
                    event.preventDefault();
                    const tr = state.tr.insertText('--', pos - 1, pos);
                    view.dispatch(tr);
                    lastDoubleDashReplacement = null;
                    return true;
                  }
                }
              }
              lastDoubleDashReplacement = null;
            }
            return false;
          }
        }
      })
    ];
  }
});

const NocturneInputRules = Extension.create({
  name: 'nocturneInputRules',
  addOptions() {
    return {
      getRules: () => [],
    };
  },
  addProseMirrorPlugins() {
    const extension = this;
    return [
      new Plugin({
        key: new PluginKey('nocturneInputRules'),
        props: {
          handleTextInput(view, from, to, text) {
            if (text !== ' ') return false;
            const state = view.state;
            const $from = state.selection.$from;
            if ($from.depth === 0) return false;
            const parent = $from.parent;
            const textBefore = parent.textBetween(0, $from.parentOffset, null, '\0');
            const rules = extension.options.getRules() || [];
            for (const rule of rules) {
              if (!rule.enabled || !rule.trigger) continue;
              if (textBefore === rule.trigger) {
                const start = $from.pos - rule.trigger.length;
                return executeRuleAction(view, rule, start, $from.pos, false);
              }
            }
            return false;
          },
          handleKeyDown(view, event) {
            if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
            const state = view.state;
            const $from = state.selection.$from;
            if ($from.depth === 0) return false;
            const parent = $from.parent;
            const textBefore = parent.textBetween(0, $from.parentOffset, null, '\0');
            const rules = extension.options.getRules() || [];
            for (const rule of rules) {
              if (!rule.enabled || !rule.trigger) continue;
              if (textBefore === rule.trigger) {
                const start = $from.pos - rule.trigger.length;
                return executeRuleAction(view, rule, start, $from.pos, true);
              }
            }
            return false;
          }
        }
      })
    ];
  }
});

function executeRuleAction(view, rule, from, to, isEnter = false) {
  const { state, dispatch } = view;
  const tr = state.tr;
  
  if (rule.action === 'center' || rule.action === 'align-right') {
    const $pos = tr.doc.resolve(from);
    const depth = $pos.depth;
    if (depth > 0) {
      const node = $pos.node(depth);
      if (node && (node.type.name === 'paragraph' || node.type.name === 'heading')) {
        tr.setNodeMarkup($pos.before(depth), null, {
          ...node.attrs,
          textAlign: rule.action === 'center' ? 'center' : 'right'
        });
        
        if (isEnter) {
          const blockEnd = $pos.after(depth);
          const pType = state.schema.nodes.paragraph;
          const nextParagraph = pType.create();
          tr.insert(blockEnd, nextParagraph);
          const targetPos = Math.min(blockEnd + 1, tr.doc.content.size - 1);
          tr.setSelection(TextSelection.create(tr.doc, targetPos));
        }
      }
    }
    dispatch(tr);
    return true;
  }
  
  // For other actions (headings, separators), delete the trigger first
  tr.delete(from, to);
  
  if (rule.action === 'heading-2' || rule.action === 'heading-3') {
    const type = state.schema.nodes.heading;
    if (type) {
      const level = rule.action === 'heading-2' ? 2 : 3;
      const $pos = tr.doc.resolve(from);
      const depth = $pos.depth;
      if (depth > 0) {
        const node = $pos.node(depth);
        tr.setNodeMarkup($pos.before(depth), type, {
          ...node.attrs,
          level
        });
      }
    }
    dispatch(tr);
    return true;
  }
  
  if (rule.action === 'separator') {
    const type = state.schema.nodes.horizontalRule;
    if (type) {
      const $pos = tr.doc.resolve(from);
      const depth = $pos.depth;
      if (depth > 0) {
        const blockStart = $pos.before(depth);
        const blockEnd = $pos.after(depth);
        const pmNode = type.create();
        const pType = state.schema.nodes.paragraph;
        const nextParagraph = pType.create();
        tr.replaceWith(blockStart, blockEnd, [pmNode, nextParagraph]);
        const targetPos = Math.min(blockStart + pmNode.nodeSize + 1, tr.doc.content.size - 1);
        tr.setSelection(TextSelection.create(tr.doc, targetPos));
      }
    }
    dispatch(tr);
    return true;
  }
  
  if (rule.action === 'custom-text') {
    const $pos = tr.doc.resolve(from);
    const depth = $pos.depth;
    if (depth > 0) {
      const blockStart = $pos.before(depth);
      const blockEnd = $pos.after(depth);
      const pType = state.schema.nodes.paragraph;
      const separatorParagraph = pType.create(
        { textAlign: 'center' },
        rule.customText ? state.schema.text(rule.customText) : []
      );
      const nextParagraph = pType.create();
      tr.replaceWith(blockStart, blockEnd, [separatorParagraph, nextParagraph]);
      const targetPos = Math.min(blockStart + separatorParagraph.nodeSize + 1, tr.doc.content.size - 1);
      tr.setSelection(TextSelection.create(tr.doc, targetPos));
    }
    dispatch(tr);
    return true;
  }
  
  return false;
}

export class NocturneEditorBridge {
  constructor({ onChange, onFocus, onSelectionUpdate, getSettings, getDoc, getMentionIndex, onKeydown, getActiveBookmarkId, motion }) {
    this.instances = new Map();
    this.onChange = onChange;
    this.onFocus = onFocus;
    this.onSelectionUpdate = onSelectionUpdate;
    this.getSettings = getSettings;
    this.getDoc = getDoc;
    this.getMentionIndex = getMentionIndex;
    this.onKeydown = onKeydown;
    this.getActiveBookmarkId = getActiveBookmarkId;
    this.visualPageRaf = new Map();
    this.motion = motion;
  }

  mount({ paneId, doc, host, pageShell, overlay, readOnly = false }) {
    if (!paneId || !doc || !host) return null;
    this.destroy(paneId);
    if (doc.pmJson) {
      doc.pmJson = ensureTiptapBlockIds(doc.pmJson);
    }

    const editor = new Editor({
      element: host,
      editable: !readOnly,
      content: doc.pmJson || legacyAstToHtml(doc.ast),
      extensions: [
        NocturneAutoformat.configure({
          getSettings: () => this.getSettings?.() || {}
        }),
        NocturneInputRules.configure({
          getRules: () => {
            const settings = this.getSettings?.() || {};
            return settings.customInputRules || [];
          }
        }),
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          history: { depth: 100 },
          horizontalRule: false,
          bulletList: false,
          orderedList: false,
          underline: false,
        }),
        HorizontalRule.extend({
          addInputRules() {
            return [];
          }
        }),
        Underline,
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Placeholder.configure({ placeholder: '' }),
        NocturneActiveBlock,
        NocturneWriterAnalysis.configure({ getSettings: () => this.getSettings?.() || {} }),
        BlockIdentity,
        NocturnePagination.configure({ bridge: this }),
        NocturneEntityMentions.configure({
          getMentionIndex: () => this.getMentionIndex?.() || [],
        }),
        NocturneBookmarks.configure({
          getBookmarks: () => doc.bookmarks || [],
          getActiveBookmarkId: () => this.getActiveBookmarkId?.(paneId) || null,
        }),
      ],
      editorProps: {
        attributes: {
          class: 'page-content-prosemirror',
          spellcheck: 'false',
          'data-pane-id': paneId,
          'data-doc-id': doc.id,
        },
        handleDOMEvents: {
          keydown: (view, event) => {
            this.onKeydown?.(event);
            return false;
          },
          focus: () => {
            this.onFocus?.(paneId);
            return false;
          },
          compositionend: () => {
            this.scheduleVisualPages(paneId);
            return false;
          },
        },
      },
      onCreate: () => this.scheduleVisualPages(paneId),
      onUpdate: ({ editor: updatedEditor, transaction }) => {
        if (transaction && !transaction.docChanged) {
          return;
        }
        doc._needsModelSync = true;
        this.onChange?.({ paneId, doc, transaction });
        this.scheduleVisualPages(paneId);
        
        const settings = this.getSettings?.() || {};
        if (settings.typewriterMode) {
          const instance = [...this.instances.values()].find((inst) => inst.editor === updatedEditor);
          if (instance) this.applyTypewriterScroll(updatedEditor, instance);
        }
      },
      onSelectionUpdate: ({ editor: selectionEditor }) => {
        const instance = [...this.instances.values()].find((inst) => inst.editor === selectionEditor);
        if (instance) {
          updateActivePageHighlight(selectionEditor, instance.pageShell);
          const settings = this.getSettings?.() || {};
          if (settings.typewriterMode) {
            instance.pageShell.style.paddingBottom = '50vh';
            // Scroll logic removed from here so it only triggers when actually typing!
          } else {
            instance.pageShell.style.paddingBottom = '';
          }
        }
        this.onSelectionUpdate?.({ paneId, editor: selectionEditor });
      },
    });

    const instance = { paneId, docId: doc.id, editor, host, pageShell, overlay };
    this.instances.set(paneId, instance);
    let measuredWidth = pageShell.getBoundingClientRect().width;
    instance.resizeObserver = new ResizeObserver(() => {
      const width = pageShell.getBoundingClientRect().width;
      if (Math.abs(width - measuredWidth) > .5) { measuredWidth = width; this.scheduleVisualPages(paneId); }
    });
    instance.resizeObserver.observe(pageShell);
    instance.onFontsLoaded = () => this.scheduleVisualPages(paneId);
    document.fonts.addEventListener('loadingdone', instance.onFontsLoaded);
    document.fonts.ready.then(() => { if (this.instances.get(paneId) === instance) this.scheduleVisualPages(paneId); });
    return instance;
  }

  syncDocFromEditor(paneId) {
    const instance = this.instances.get(paneId);
    if (!instance?.editor) return null;
    const doc = this.getDoc?.(instance.docId);
    if (doc) {
      doc.pmJson = ensureTiptapBlockIds(instance.editor.getJSON());
      doc.ast = tiptapJsonToLegacyAst(doc.pmJson);
      doc.summary = doc.description || buildSummary(doc.ast);
      doc._needsModelSync = false;
      return doc;
    }
    return null;
  }

  updateAnalysis() {
    for (const { editor, paneId } of this.instances.values()) {
      editor.view.dispatch(editor.state.tr.setMeta(writerAnalysisKey, true).setMeta('addToHistory', false));
      this.scheduleVisualPages(paneId);
    }
  }

  syncDocFromEditorByDocId(docId) {
    const instance = [...this.instances.values()].find(inst => inst.docId === docId);
    if (instance) {
      return this.syncDocFromEditor(instance.paneId);
    }
    return null;
  }

  applyDocumentContent(doc, { ast = null, pmJson = null } = {}) {
    if (ast) doc.ast = structuredClone(ast);
    if (pmJson) doc.pmJson = ensureTiptapBlockIds(pmJson);
    else delete doc.pmJson;
    const instances = [...this.instances.values()].filter(instance => instance.docId === doc.id);
    for (const instance of instances) {
      instance.editor.commands.setContent(doc.pmJson || legacyAstToHtml(doc.ast), { emitUpdate: false });
      this.scheduleVisualPages(instance.paneId);
    }
    if (instances.length) this.syncDocFromEditor(instances[0].paneId);
    doc._needsModelSync = false;
    return doc;
  }

  applyTypewriterScroll(editor, instance) {
    if (!editor.view.state.selection.empty) return;

    requestAnimationFrame(() => {
      const { view } = editor;
      const coords = view.coordsAtPos(view.state.selection.head);
      const scrollContainer = instance.pageShell.closest('.editor-scroll-area') || instance.pageShell.parentElement;
      
      if (scrollContainer && coords) {
        const scRect = scrollContainer.getBoundingClientRect();
        const targetCenterY = scRect.top + (scRect.height / 2) - 20;
        
        const currentScroll = scrollContainer._twFloatScrollTop ?? scrollContainer.scrollTop;
        const targetScrollTop = Math.round(currentScroll + coords.top - targetCenterY);
        
        if (!scrollContainer._twAnim && Math.abs(currentScroll - targetScrollTop) < 15) {
          return;
        }
        
        scrollContainer._twTargetScrollTop = targetScrollTop;
        
        if (scrollContainer._twAnim) {
          return;
        }
        
        if (scrollContainer.style.scrollBehavior !== 'auto') {
          scrollContainer._twOriginalScrollBehavior = scrollContainer.style.scrollBehavior;
          scrollContainer.style.scrollBehavior = 'auto';
        }
        
        scrollContainer._twFloatScrollTop = currentScroll;
        let lastTime = performance.now();
        
        const animate = (time) => {
          const dt = Math.min(0.05, (time - lastTime) / 1000);
          lastTime = time;
          
          const current = scrollContainer._twFloatScrollTop;
          const target = scrollContainer._twTargetScrollTop;
          const diff = target - current;
          const absDiff = Math.abs(diff);
          
          if (absDiff < 0.5) {
            scrollContainer.scrollTop = target;
            if (scrollContainer._twOriginalScrollBehavior !== undefined) {
              scrollContainer.style.scrollBehavior = scrollContainer._twOriginalScrollBehavior;
              delete scrollContainer._twOriginalScrollBehavior;
            }
            scrollContainer._twFloatScrollTop = null;
            scrollContainer._twAnim = null;
            return;
          }
          
          const lambda = 12 + Math.min(8, Math.max(0, (absDiff - 50) / 150) * 8);
          const factor = 1 - Math.exp(-dt * lambda);
          
          const next = current + diff * factor;
          scrollContainer._twFloatScrollTop = next;
          scrollContainer.scrollTop = Math.round(next);
          
          scrollContainer._twAnim = requestAnimationFrame(animate);
        };
        
        scrollContainer._twAnim = requestAnimationFrame(animate);
      }
    });
  }

  setEditable(paneId, editable) {
    const instance = this.instances.get(paneId);
    if (instance) {
      instance.editor.setOptions({ editable });
    }
  }

  destroy(paneId) {
    const instance = this.instances.get(paneId);
    if (!instance) return;
    cancelAnimationFrame(this.visualPageRaf.get(paneId));
    this.visualPageRaf.delete(paneId);
    instance.resizeObserver?.disconnect();
    document.fonts.removeEventListener('loadingdone', instance.onFontsLoaded);
    instance.editor.destroy();
    this.instances.delete(paneId);
  }

  destroyMissing(activePaneIds = []) {
    const active = new Set(activePaneIds);
    [...this.instances.keys()].forEach((paneId) => {
      if (!active.has(paneId)) this.destroy(paneId);
    });
  }

  get(paneId) {
    return this.instances.get(paneId)?.editor || null;
  }

  getByDocId(docId) {
    return [...this.instances.values()].find((instance) => instance.docId === docId)?.editor || null;
  }

  getByElement(element) {
    const host = element?.closest?.('.page-content');
    if (!host) return null;
    return [...this.instances.values()].find((instance) => instance.host === host)?.editor || null;
  }

  scheduleVisualPages(paneId) {
    const instance = this.instances.get(paneId);
    if (!instance) return;
    if (document.body.classList.contains('resizing-workspace')) return;
    cancelAnimationFrame(this.visualPageRaf.get(paneId));
    const raf = requestAnimationFrame(() => {
      this.visualPageRaf.delete(paneId);
      if (instance.editor.isDestroyed || instance.editor.view.composing) return;
      const settings = this.getSettings?.() || {};
      calculateVisualPages({
        editor: instance.editor,
        pageShell: instance.pageShell,
        overlay: instance.overlay,
        flexible: !settings.autoPaginate,
        motion: this.motion,
      });
      this.onVisualPagesCalculated?.({ paneId, editor: instance.editor });
    });
    this.visualPageRaf.set(paneId, raf);
  }

  runCommand(paneId, command, value = null) {
    const editor = this.get(paneId);
    if (!editor) return false;
    const chain = editor.chain().focus();
    if (command === 'bold') return chain.toggleBold().run();
    if (command === 'italic') return chain.toggleItalic().run();
    if (command === 'underline') return chain.toggleUnderline().run();
    if (command === 'strikeThrough') return chain.toggleStrike().run();
    if (command === 'undo') return editor.commands.undo();
    if (command === 'redo') return editor.commands.redo();
    if (command === 'justifyLeft') return chain.setTextAlign('left').run();
    if (command === 'justifyCenter') return chain.setTextAlign('center').run();
    if (command === 'justifyFull') return chain.setTextAlign('justify').run();
    if (command === 'formatBlock') {
      if (value === 'heading') return chain.toggleHeading({ level: 2 }).run();
      if (value === 'quote') return chain.toggleBlockquote().run();
      return chain.setParagraph().run();
    }
    return false;
  }

  insertText(paneId, text) {
    const editor = this.get(paneId);
    if (!editor) return false;
    return editor.chain().focus().insertContent(text).run();
  }
}
