import { Extension, Plugin, PluginKey, Step, StepResult, StepMap, DOMSerializer, closeHistory } from '../vendor/tiptap/nocturne-tiptap.bundle.js';
import { anchorAt, editorIndex, normalizeBookmarks, mapBookmarks, cloneBookmarks } from '../features/bookmark-model.js';

export const bookmarkPluginKey = new PluginKey('nocturneBookmarksV2');
const clipboardType = 'application/x-nocturne-bookmarks';

// A document-neutral step lets ProseMirror undo bookmarks together with text edits.
export class BookmarkStep extends Step {
  constructor(before, after) { super(); this.before = structuredClone(before); this.after = structuredClone(after); }
  apply(doc) { return StepResult.ok(doc); }
  invert() { return new BookmarkStep(this.after, this.before); }
  map() { return this; }
  getMap() { return StepMap.empty; }
  toJSON() { return { stepType: 'nocturneBookmarksV2', before: this.before, after: this.after }; }
  static fromJSON(schema, json) { return new BookmarkStep(json.before, json.after); }
}
Step.jsonID('nocturneBookmarksV2', BookmarkStep);

export function bookmarkTransaction(editor, values) {
  return closeHistory(editor.state.tr).step(new BookmarkStep(bookmarkPluginKey.getState(editor.state), values));
}

export const BookmarkExtension = Extension.create({
  name: 'nocturneBookmarksV2',
  addOptions() { return { getBookmarks: () => [], getSettings: () => ({}), onChange: () => {}, confirmDeletion: async () => true, draw: () => {}, clear: () => {} }; },
  addProseMirrorPlugins() {
    const options = this.options;
    let waiting = false;
    const mapped = (values, tr) => mapBookmarks(values, tr.mapping, editorIndex(tr.doc), options.getSettings(), (from, to) => tr.doc.textBetween(from, to, '\n'));
    return [new Plugin({
      key: bookmarkPluginKey,
      state: {
        init(_, state) { return normalizeBookmarks(options.getBookmarks(), editorIndex(state.doc)); },
        apply(tr, values) {
          const step = [...tr.steps].reverse().find(value => value instanceof BookmarkStep);
          if (step) return structuredClone(step.after);
          if (!tr.docChanged) return values;
          return mapped(values, tr).bookmarks;
        },
      },
      filterTransaction(tr, state) {
        if (!tr.docChanged || tr.getMeta('bookmarkDeletionApproved') || tr.steps.every(step => step instanceof BookmarkStep) || Object.keys(tr.meta).some(key => key.startsWith('history$'))) return true;
        if (waiting) return false;
        const settings = options.getSettings();
        const projection = mapped(bookmarkPluginKey.getState(state), tr);
        if (!projection.deleted.length || !settings.bookmarkConfirmTextDeletion || settings.bookmarkDeletedText !== 'delete') return true;
        waiting = true;
        const editor = this.spec.bookmarkEditor;
        queueMicrotask(async () => {
          try {
            const accepted = await options.confirmDeletion(projection.deleted);
            if (accepted && editor?.view && editor.state.doc.eq(state.doc)) editor.view.dispatch(tr.setMeta('bookmarkDeletionApproved', true));
          } finally { waiting = false; }
        });
        return false;
      },
      appendTransaction(transactions, oldState, newState) {
        if (!transactions.some(tr => tr.docChanged) || transactions.some(tr => tr.steps.some(step => step instanceof BookmarkStep))) return null;
        const before = bookmarkPluginKey.getState(oldState), after = bookmarkPluginKey.getState(newState);
        if (JSON.stringify(before) === JSON.stringify(after)) return null;
        return newState.tr.step(new BookmarkStep(before, after));
      },
      view(view) {
        const plugin = bookmarkPluginKey.get(view.state);
        plugin.spec.bookmarkEditor = { get state() { return view.state; }, view };
        const update = () => { options.onChange(bookmarkPluginKey.getState(view.state)); options.draw(view); };
        update();
        return { update, destroy: () => options.clear() };
      },
      props: {
        handleDOMEvents: {
          copy(view, event) { return copy(view, event, false); },
          cut(view, event) { return copy(view, event, true); },
        },
        handlePaste(view, event, slice) {
          if (!options.getSettings().bookmarkCopyWithText) return false;
          let data;
          try { const raw = event.clipboardData?.getData(clipboardType); if (!raw || raw.length > 1000000) return false; data = JSON.parse(raw); } catch { return false; }
          if (data?.version !== 2 || !Array.isArray(data.bookmarks)) return false;
          const from = view.state.selection.from;
          const tr = view.state.tr.replaceSelection(slice);
          const projection = mapped(bookmarkPluginKey.getState(view.state), tr), values = projection.bookmarks;
          const pasted = cloneBookmarks(normalizeBookmarks(data.bookmarks).slice(0, 100), '');
          for (const bookmark of pasted) for (const part of bookmark.parts) {
            part.anchor.from = Math.max(from, Math.min(tr.doc.content.size, from + part.anchor.from));
            part.anchor.to = Math.max(part.anchor.from, Math.min(tr.doc.content.size, from + part.anchor.to));
          }
          const blocks = editorIndex(tr.doc);
          const anchored = pasted.map(bookmark => ({ ...bookmark, parts: bookmark.parts.map(part => ({ ...part, anchor: anchorAt(blocks, part.anchor.from, part.anchor.to, part.anchor.kind, (from, to) => tr.doc.textBetween(from, to, '\n')) })) }));
          tr.step(new BookmarkStep(bookmarkPluginKey.getState(view.state), [...values, ...anchored]));
          view.dispatch(tr); event.preventDefault(); return true;
        },
      },
    })];
    function copy(view, event, cut) {
      if (!options.getSettings().bookmarkCopyWithText || view.state.selection.empty || !event.clipboardData) return false;
      const { from, to } = view.state.selection;
      const selected = structuredClone(bookmarkPluginKey.getState(view.state)).flatMap(bookmark => {
        bookmark.parts = bookmark.parts.filter(part => part.anchor.status === 'attached' && part.anchor.to >= from && part.anchor.from <= to);
        for (const part of bookmark.parts) { part.anchor.from = Math.max(from, part.anchor.from) - from; part.anchor.to = Math.min(to, part.anchor.to) - from; }
        return bookmark.parts.length ? [bookmark] : [];
      });
      const fragment = DOMSerializer.fromSchema(view.state.schema).serializeFragment(view.state.selection.content().content);
      const container = document.createElement('div'); container.append(fragment);
      event.clipboardData.setData('text/plain', view.state.doc.textBetween(from, to, '\n'));
      event.clipboardData.setData('text/html', container.innerHTML);
      event.clipboardData.setData(clipboardType, JSON.stringify({ version: 2, bookmarks: selected }));
      event.preventDefault();
      if (cut) view.dispatch(view.state.tr.deleteSelection());
      return true;
    }
  },
});
