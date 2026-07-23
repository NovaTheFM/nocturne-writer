import { Editor, Extension, StarterKit, TextAlign, Underline, Placeholder, Plugin, PluginKey, Decoration, DecorationSet, HorizontalRule, TextSelection } from '../vendor/tiptap/nocturne-tiptap.bundle.js';
import { ensureTiptapBlockIds, legacyAstToHtml, tiptapJsonToLegacyAst } from './document-adapter.js';
import { calculateVisualPages, updateActivePageHighlight } from './visual-pagination.js';
import { normalizeTypoToken } from '../core/typos.js';
import { uid } from '../core/utils.js';

export const paginationPluginKey = new PluginKey('nocturnePagination');

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
              bridge.scheduleVisualPages(view.dom.getAttribute('data-pane-id'));
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

function findEntityMatches(text, index) {
  const normalizedText = normalizeTypoToken(text);
  const matches = [];
  let pos = 0;
  while (pos < text.length) {
    const entry = index.find((candidate) => (
      normalizedText.startsWith(candidate.normalized, pos)
      && isEntityBoundary(text[pos - 1])
      && isEntityBoundary(text[pos + candidate.mention.length])
    ));
    if (entry) {
      matches.push({ ...entry, start: pos, end: pos + entry.mention.length });
      pos += entry.mention.length;
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
    
    const buildDecos = (doc, index) => {
      const decos = [];
      if (!index || !index.length) return DecorationSet.empty;
      
      doc.descendants((node, pos) => {
        if (node.isText) {
          const text = node.text || '';
          const matches = findEntityMatches(text, index);
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
      
      return DecorationSet.create(doc, decos);
    };

    return [
      new Plugin({
        key,
        state: {
          init(config, instance) {
            return buildDecos(instance.doc, extension.options.getMentionIndex());
          },
          apply(tr, value, oldState, newState) {
            const forced = tr.getMeta('nocturneEntityMentionsForceUpdate');
            if (tr.docChanged || forced) {
              return buildDecos(newState.doc, extension.options.getMentionIndex());
            }
            return value.map(tr.mapping, tr.doc);
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
});function bridgeFindBestQuoteOffset(text, quote, prefix = '', suffix = '', oldOffset = 0) {
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
    <span class="nocturne-bookmark-house-inner">
      <svg class="nocturne-bookmark-svg" viewBox="0 0 24 28" width="24" height="28">
        <path d="M12,2 L2,12 V24 A2,2 0 0,0 4,26 H20 A2,2 0 0,0 22,24 V12 L12,2 Z" />
      </svg>
      <button class="nocturne-bookmark-delete-btn" type="button" title="Удалить закладку">
        <i class="bx bx-bookmark"></i>
      </button>
    </span>
  `;
  
  const deleteBtn = element.querySelector('.nocturne-bookmark-delete-btn');
  deleteBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    window.nocturneApp?.confirmDeleteBookmark(bookmarkId);
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
        // Keep inline decoration before widget decoration if at same position
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
            if (tr.docChanged || forced) {
              return buildDecos(newState.doc);
            }
            return value.map(tr.mapping, tr.doc);
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
            if ($from.depth === 0) return false;
            const parent = $from.parent;
            const textBefore = parent.textBetween(0, $from.parentOffset, null, '\0');

            // 1. Convert -- to — (Em-dash)
            if (settings.autoReplaceDoubleDash && text === '-' && textBefore.endsWith('-')) {
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

            // 2. Convert space-hyphen-space to space-en-dash-space
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
  constructor({ onChange, onFocus, onSelectionUpdate, getSettings, getMentionIndex, onKeydown, getActiveBookmarkId }) {
    this.instances = new Map();
    this.onChange = onChange;
    this.onFocus = onFocus;
    this.onSelectionUpdate = onSelectionUpdate;
    this.getSettings = getSettings;
    this.getMentionIndex = getMentionIndex;
    this.onKeydown = onKeydown;
    this.getActiveBookmarkId = getActiveBookmarkId;
    this.visualPageRaf = new Map();
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
            console.log("KEYDOWN FIRED", event.key);
            const settings = this.getSettings?.() || {};
            if (settings.typewriterSound && !event.ctrlKey && !event.altKey && !event.metaKey) {
              console.log("PLAYING SOUND");
              this.playTypewriterSound();
            }
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
        doc.pmJson = ensureTiptapBlockIds(updatedEditor.getJSON());
        doc.ast = tiptapJsonToLegacyAst(doc.pmJson);
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
    return instance;
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

  playTypewriterSound() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = this.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    // Soft, rounded click sound (low pitch)
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.04);
    
    // Attack phase (5ms) to prevent speaker popping/cracking, then soft decay
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.06);
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
    cancelAnimationFrame(this.visualPageRaf.get(paneId));
    const raf = requestAnimationFrame(() => {
      const settings = this.getSettings?.() || {};
      calculateVisualPages({
        editor: instance.editor,
        pageShell: instance.pageShell,
        overlay: instance.overlay,
        flexible: !settings.autoPaginate,
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
