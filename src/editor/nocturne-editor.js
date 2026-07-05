import { Editor, Extension, StarterKit, TextAlign, Underline, Placeholder, Plugin, PluginKey, Decoration, DecorationSet, HorizontalRule } from '../vendor/tiptap/nocturne-tiptap.bundle.js';
import { ensureTiptapBlockIds, legacyAstToHtml, tiptapJsonToLegacyAst } from './document-adapter.js';
import { calculateVisualPages, updateActivePageHighlight } from './visual-pagination.js';
import { normalizeTypoToken } from '../core/typos.js';

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
            let decos = paginationState.decorations;
            const { selection } = state;
            const $anchor = selection.$anchor;
            const depth = $anchor.depth;
            if (depth > 0) {
              const start = $anchor.before(depth);
              const end = $anchor.after(depth);
              try {
                const activeBlockDeco = Decoration.node(start, end, { class: 'active-block' });
                decos = decos.add(state.doc, [activeBlockDeco]);
              } catch (e) {
              }
            }
            return decos;
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
          align: rule.action === 'center' ? 'center' : 'right'
        });
        
        if (isEnter) {
          const blockEnd = $pos.after(depth);
          const pType = state.schema.nodes.paragraph;
          const nextParagraph = pType.create();
          tr.insert(blockEnd, nextParagraph);
          const $resolved = tr.doc.resolve(blockEnd + 1);
          const sel = view.state.selection.constructor.near($resolved);
          tr.setSelection(sel);
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
        const $resolved = tr.doc.resolve(blockStart + pmNode.nodeSize + 1);
        const sel = view.state.selection.constructor.near($resolved);
        tr.setSelection(sel);
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
        { align: 'center' },
        rule.customText ? state.schema.text(rule.customText) : []
      );
      const nextParagraph = pType.create();
      tr.replaceWith(blockStart, blockEnd, [separatorParagraph, nextParagraph]);
      const $resolved = tr.doc.resolve(blockStart + separatorParagraph.nodeSize + 1);
      const sel = view.state.selection.constructor.near($resolved);
      tr.setSelection(sel);
    }
    dispatch(tr);
    return true;
  }
  
  return false;
}

export class NocturneEditorBridge {
  constructor({ onChange, onFocus, onSelectionUpdate, getSettings, getMentionIndex, onKeydown }) {
    this.instances = new Map();
    this.onChange = onChange;
    this.onFocus = onFocus;
    this.onSelectionUpdate = onSelectionUpdate;
    this.getSettings = getSettings;
    this.getMentionIndex = getMentionIndex;
    this.onKeydown = onKeydown;
    this.visualPageRaf = new Map();
  }

  mount({ paneId, doc, host, pageShell, overlay, readOnly = false }) {
    if (!paneId || !doc || !host) return null;
    this.destroy(paneId);

    const editor = new Editor({
      element: host,
      editable: !readOnly,
      content: doc.pmJson || legacyAstToHtml(doc.ast),
      extensions: [
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
