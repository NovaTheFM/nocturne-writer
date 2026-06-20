import { Editor, Extension, StarterKit, TextAlign, Underline, Placeholder, Plugin, PluginKey, Decoration, DecorationSet } from '../vendor/tiptap/nocturne-tiptap.bundle.js';
import { ensureTiptapBlockIds, legacyAstToHtml, tiptapJsonToLegacyAst } from './document-adapter.js';
import { calculateVisualPages } from './visual-pagination.js';

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
            return {
              decorations: value.decorations.map(tr.mapping, tr.doc),
              pageBreaks: value.pageBreaks,
            };
          },
        },
        props: {
          decorations(state) {
            return paginationPluginKey.getState(state).decorations;
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

export class NocturneEditorBridge {
  constructor({ onChange, onFocus, onSelectionUpdate, getSettings }) {
    this.instances = new Map();
    this.onChange = onChange;
    this.onFocus = onFocus;
    this.onSelectionUpdate = onSelectionUpdate;
    this.getSettings = getSettings;
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
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          history: { depth: 100 },
        }),
        Underline,
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Placeholder.configure({ placeholder: '' }),
        BlockIdentity,
        NocturnePagination.configure({ bridge: this }),
      ],
      editorProps: {
        attributes: {
          class: 'page-content-prosemirror',
          spellcheck: 'false',
          'data-pane-id': paneId,
          'data-doc-id': doc.id,
        },
        handleDOMEvents: {
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
        doc.pmJson = ensureTiptapBlockIds(updatedEditor.getJSON());
        doc.ast = tiptapJsonToLegacyAst(doc.pmJson);
        this.onChange?.({ paneId, doc, transaction });
        this.scheduleVisualPages(paneId);
      },
      onSelectionUpdate: ({ editor: selectionEditor }) => {
        this.onSelectionUpdate?.({ paneId, editor: selectionEditor });
        this.scheduleVisualPages(paneId);
      },
    });

    const instance = { paneId, docId: doc.id, editor, host, pageShell, overlay };
    this.instances.set(paneId, instance);
    return instance;
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
        flexible: !!settings.flexiblePageHeight,
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
