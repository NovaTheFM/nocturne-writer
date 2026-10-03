import { Extension, Plugin, PluginKey, Decoration, DecorationSet } from '../vendor/tiptap/nocturne-tiptap.bundle.js';

export const writerAnalysisKey = new PluginKey('nocturneWriterAnalysis');
const weakWords = /(?<![\p{L}\p{N}_])(очень|сильно|быстро|внезапно|просто|как будто|словно бы|являлся|был сделан)(?![\p{L}\p{N}_])/giu;

function decorations(doc, settings) {
  if (!settings.writerSyntax && !settings.showDontTell && (!settings.dialogueLens || settings.dialogueLens === 'off')) return DecorationSet.empty;
  const result = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock || node.type.name === 'heading' || node.type.name === 'codeBlock') return;
    const text = node.textBetween(0, node.content.size, '\n', '\ufffc');
    const add = (start, end, cls) => { if (end > start) result.push(Decoration.inline(pos + 1 + start, pos + 1 + end, { class: cls })); };
    const dialogue = [...text.matchAll(/«[^»]+»|"[^"]+"/gu)];
    if (settings.writerSyntax || settings.dialogueLens !== 'off') for (const match of dialogue) add(match.index, match.index + match[0].length, 'syntax-dialogue');
    if (settings.writerSyntax) for (const match of text.matchAll(/\([^)]{3,}\)/gu)) add(match.index, match.index + match[0].length, 'syntax-thought');
    if (settings.showDontTell) for (const match of text.matchAll(weakWords)) add(match.index, match.index + match[0].length, 'weak-word');
    if (settings.dialogueLens === 'dialogues') {
      let start = 0;
      for (const match of dialogue) { add(start, match.index, 'syntax-description'); start = match.index + match[0].length; }
      add(start, text.length, 'syntax-description');
    }
    return false;
  });
  return DecorationSet.create(doc, result);
}

export const NocturneWriterAnalysis = Extension.create({
  name: 'nocturneWriterAnalysis',
  addOptions: () => ({ getSettings: () => ({}) }),
  addProseMirrorPlugins() {
    const getSettings = this.options.getSettings;
    return [new Plugin({
      key: writerAnalysisKey,
      state: {
        init: (_, state) => decorations(state.doc, getSettings()),
        apply: (tr, previous) => tr.docChanged || tr.getMeta(writerAnalysisKey) ? decorations(tr.doc, getSettings()) : previous.map(tr.mapping, tr.doc),
      },
      props: { decorations: state => writerAnalysisKey.getState(state) },
    })];
  },
});
