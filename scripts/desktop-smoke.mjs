import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = process.env.NOCTURNE_SMOKE_URL || 'http://localhost:5173';

async function waitForServer(url, timeoutMs = 15_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Nocturne server did not respond at ${url}: ${lastError?.message || 'timeout'}`);
}

async function startServerIfNeeded() {
  try {
    await waitForServer(BASE_URL, 800);
    return null;
  } catch {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
    await waitForServer(BASE_URL);
    return child;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runAppSmoke(page) {
  return page.evaluate(async () => {
    const assertInPage = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const app = window.nocturneApp;
    assertInPage(app, 'window.nocturneApp is missing');

    await app.createDoc(app.defaultFolderId(), `Smoke ${Date.now()}`, 'desktop smoke');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const editable = document.querySelector('.page-content') || document.querySelector('.editor-page [contenteditable="true"]');
    const getBlock = () => editable?.querySelector('[data-block-id]') || editable;
    assertInPage(editable && getBlock(), 'editor surface was not rendered');
    const doc = app.getFocusedDoc();
    assertInPage(doc, 'focused document missing after createDoc');

    const setEditorContent = (html) => {
      const pmEditor = app.nocturneEditor?.getByElement(editable);
      if (pmEditor) {
        pmEditor.commands.setContent(html);
      } else {
        getBlock().innerHTML = html;
        app.editorInput(editable, { inputType: 'insertText', data: ' ' });
      }
    };

    setEditorContent('<p>alpha beta gamma</p>');
    await app.draftWrites.get(doc.id);
    const liveDraft = await app.db.get('drafts', doc.id);
    assertInPage(liveDraft && JSON.stringify(liveDraft).includes('alpha beta gamma'), 'live draft was not written to IndexedDB');
    await app.saveDocById(doc.id, { silent: true });
    assertInPage(!await app.db.get('drafts', doc.id), 'live draft was not cleared after IndexedDB save');
    const stored = await app.db.get('docs', doc.id);
    assertInPage(stored && JSON.stringify(stored.ast).includes('alpha beta gamma'), 'IndexedDB save did not persist editor text');

    const selectWord = (word) => {
      const pmEditor = app.nocturneEditor?.getByElement(editable);
      const currentBlock = getBlock();
      if (pmEditor) {
        let found = false;
        pmEditor.state.doc.descendants((node, pos) => {
          if (node.isText) {
            const index = node.text.indexOf(word);
            if (index >= 0) {
              const from = pos + index;
              const to = from + word.length;
              pmEditor.commands.setTextSelection({ from, to });
              app.selectionSnapshot = {
                range: null,
                caret: null,
                paneId: editable.dataset.paneId || editable.closest('.workspace-pane')?.dataset.paneId || 'primary',
                docId: editable.dataset.docId,
                text: word,
              };
              found = true;
              return false;
            }
          }
        });
        return found;
      }

      const walker = document.createTreeWalker(currentBlock, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const index = node.nodeValue.indexOf(word);
        if (index >= 0) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + word.length);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          app.selectionSnapshot = {
            range: range.cloneRange(),
            caret: null,
            paneId: editable.dataset.paneId || editable.closest('.workspace-pane')?.dataset.paneId || 'primary',
            docId: editable.dataset.docId,
            text: word,
          };
          return true;
        }
      }
      return false;
    };

    setEditorContent('<p>alpha beta gamma</p>');
    selectWord('beta');
    app.runEditorCommand('bold');
    assertInPage(/<strong>beta<\/strong>/.test(getBlock().innerHTML), 'bold wrap failed');
    selectWord('beta');
    app.runEditorCommand('bold');
    assertInPage(!/<strong>beta<\/strong>/.test(getBlock().innerHTML), 'bold unwrap failed');
    selectWord('beta');
    app.runEditorCommand('italic');
    assertInPage(/<em>beta<\/em>/.test(getBlock().innerHTML), 'italic failed');
    setEditorContent('<p>alpha beta gamma</p>');
    selectWord('beta');
    app.runEditorCommand('underline');
    assertInPage(/<u>beta<\/u>/.test(getBlock().innerHTML), 'underline failed');
    setEditorContent('<p>alpha beta gamma</p>');
    selectWord('beta');
    app.runEditorCommand('strikeThrough');
    assertInPage(/<s>beta<\/s>/.test(getBlock().innerHTML), 'strike failed');
    setEditorContent('<p>alpha beta gamma</p>');
    selectWord('beta');
    app.runEditorCommand('bold');
    selectWord('beta');
    app.runEditorCommand('italic');
    assertInPage(/<em><strong>beta<\/strong><\/em>|<strong><em>beta<\/em><\/strong>/.test(getBlock().innerHTML), 'nested bold+italic failed');

    const validWriting = await app.parseAiProtocolWithRepair(
      JSON.stringify({ type: 'writing', thinking: 'Готово.', mode: 'replace-selection', text: 'Исправленный текст.' }),
      '',
      {},
      { kind: 'style' },
    );
    assertInPage(validWriting.ok && validWriting.writing?.text === 'Исправленный текст.', 'valid AI writing JSON failed');

    const validReview = await app.parseAiProtocolWithRepair(
      JSON.stringify({ type: 'review', thinking: 'Проверка завершена.', issues: [{ verdict: 'issue', category: 'grammar', quote: 'alpha', reason: 'Тестовая ошибка.', replacement: 'alpha', severity: 'low' }] }),
      '',
      {},
      { kind: 'proofread' },
    );
    assertInPage(validReview.ok && Array.isArray(validReview.review), 'valid AI review JSON failed');

    const originalStreamAi = app.streamAi.bind(app);
    app.streamAi = async (_prompt, onChunk) => onChunk(JSON.stringify({ type: 'writing', thinking: 'Переформатировано.', mode: 'replace-selection', text: 'Безопасный текст.' }));
    const repaired = await app.parseAiProtocolWithRepair('<NOCTURNE_PROTOCOL><REQUEST_TYPE>REFORMAT</REQUEST_TYPE></NOCTURNE_PROTOCOL>', '', {}, { kind: 'style' });
    app.streamAi = originalStreamAi;
    assertInPage(repaired.ok && repaired.writing?.text === 'Безопасный текст.', 'invalid AI protocol was not repaired to JSON');

    const styleReview = app.validateParsedAiProtocol(app.parseAiJsonResponse(JSON.stringify({ type: 'review', thinking: '', issues: [] })), 'style');
    assertInPage(!!styleReview, 'legacy style rewriting must reject review protocol');
    const wrongType = app.validateParsedAiProtocol(app.parseAiJsonResponse(JSON.stringify({ type: 'writing', thinking: '', mode: 'replace-block', text: 'Unapproved text' })), 'proofread');
    assertInPage(!!wrongType, 'wrong AI response type was not rejected');

    // TEST: Typo replacement live DOM update without leaving document
    setEditorContent('<p>тут сдесь ошибка в слове</p>');
    app.updateTypoHighlights();
    const typoMatch = app.typoMatchIndex.find((m) => m.rawText === 'сдесь');
    assertInPage(typoMatch, 'typo "сдесь" was not indexed by speller');
    const applied = app.applyTypoReplacement(typoMatch);
    assertInPage(applied, 'applyTypoReplacement returned false');
    const liveTextAfterReplace = getBlock().textContent || getBlock().innerText;
    assertInPage(liveTextAfterReplace.includes('здесь'), 'applyTypoReplacement failed to update DOM live without leaving document');

    // TEST: Multiple identical typos - replacing 1 does NOT clear error state for remaining identical typos
    setEditorContent('<p>сдесь мы сидим и сдесь мы едим</p>');
    app.updateTypoHighlights();
    const matchesBefore = app.typoMatchIndex.filter((m) => m.rawText === 'сдесь');
    assertInPage(matchesBefore.length === 2, 'multiple typos "сдесь" were not indexed');
    app.applyTypoReplacement(matchesBefore[0]);
    const matchesAfter = app.typoMatchIndex.filter((m) => m.rawText === 'сдесь');
    assertInPage(matchesAfter.length === 1, 'remaining identical typo lost its error state after replacing first one');

    // TEST: Typo hover highlight using CSS.highlights
    setEditorContent('<p>тут сдесь снова</p>');
    app.updateTypoHighlights();
    const typoMatch2 = app.typoMatchIndex.find((m) => m.rawText === 'сдесь');
    if (typoMatch2) {
      const fakeEvent = {
        target: editable,
        clientX: 100,
        clientY: 100,
      };
      app.findTypoMatchAtPoint = () => typoMatch2;
      app.handleTypoMouseMove(fakeEvent);
      assertInPage(CSS.highlights.has('typo-hover'), 'CSS highlight "typo-hover" was not set on mouseover');
      app.clearTypoHoverState();
      assertInPage(!CSS.highlights.has('typo-hover'), 'CSS highlight "typo-hover" was not cleared');
    }
    const contradictoryReview = app.validateParsedAiProtocol(
      app.parseAiJsonResponse(JSON.stringify({ type: 'review', thinking: 'Найдено несколько механических опечаток.', issues: [] })),
      'proofread',
    );
    assertInPage(/нашла ошибки|issues/i.test(contradictoryReview), 'contradictory empty AI review was not rejected');
    const noReplacementReview = app.validateParsedAiProtocol(
      app.parseAiJsonResponse(JSON.stringify({
        type: 'review',
        thinking: 'Найдена механическая опечатка.',
        issues: [{ verdict: 'issue', category: 'orthography', quote: 'прекраасный', reason: 'Лишняя буква.', replacement: '', severity: 'medium' }],
      })),
      'proofread',
    );
    assertInPage(/replacement|замен/i.test(noReplacementReview), 'proofread issue without replacement was not rejected');

    app.streamAi = async (_prompt, onChunk) => onChunk(JSON.stringify({
      type: 'review',
      thinking: 'Найдена механическая опечатка.',
      issues: [{ verdict: 'issue', category: 'orthography', quote: 'прекраасный', reason: 'В слове лишняя буква «а».', replacement: 'прекрасный', severity: 'medium' }],
    }));
    const repairedReview = await app.parseAiProtocolWithRepair(
      JSON.stringify({ type: 'review', thinking: 'Найдено несколько механических опечаток.', issues: [] }),
      '',
      {},
      { kind: 'proofread' },
    );
    app.streamAi = originalStreamAi;
    assertInPage(repairedReview.ok && repairedReview.review?.[0]?.replacement === 'прекрасный', 'contradictory proofread review was not repaired into actionable issue');

    const currentText = getBlock().textContent;
    const unsafeInserted = app.insertSuggestion('<NOCTURNE_PROTOCOL></NOCTURNE_PROTOCOL>', {
      ok: true,
      doc,
      paneId: 'primary',
      target: { docId: doc.id, blockId: doc.ast.blocks[0].id, blockIndex: 0, startOffset: 0, endOffset: 5, selectedText: currentText.slice(0, 5), targetBlockText: currentText, mode: 'replace-selection' },
      kind: 'style',
      mode: 'replace-selection',
      silent: true,
    });
    assertInPage(!unsafeInserted, 'unsafe AI suggestion was accepted');

    const dump = await app.buildNocturneDump({ plaintextE2e: false });
    app.validateProjectDump(dump);
    const stats = app.dumpPreviewStats(dump);
    assertInPage(stats.docs > 0, 'dump stats did not include docs');
    const mergeReport = await app.importProjectDump(dump, { mode: 'merge' });
    assertInPage(mergeReport.docs >= stats.docs, 'dump merge did not report imported docs');

    app.state.lore.characters.push(app.normalizeCharacter({ id: `smoke-char-${Date.now()}`, firstName: 'Тест', lastName: 'Персонаж', body: 'Smoke body' }, app.state.lore.characters.length));
    app.state.lore.locations.push(app.normalizeLocation({ id: `smoke-loc-${Date.now()}`, name: 'Тестовая локация', body: 'Smoke body' }, app.state.lore.locations.length));
    app.state.lore.timeline.push(app.normalizeTimelineEvent({ id: `smoke-time-${Date.now()}`, date: 'День 1', title: 'Тестовое событие', body: 'Smoke body', subEvents: [{ id: `smoke-sub-${Date.now()}`, date: 'День 1', title: 'Подсобытие', body: 'Smoke' }] }, app.state.lore.timeline.length));
    await app.saveLore();
    const lore = await app.db.get('lore', 'world');
    assertInPage(lore.characters.length && lore.locations.length && lore.timeline.length, 'KB/lore save failed');

    app.createFloatingNote({ title: 'Smoke note', body: 'note body' });
    assertInPage(app.state.floatingNotes.length > 0, 'floating note was not created');

    app.openAboutModal();
    assertInPage(!!document.querySelector('.about-modal'), 'about modal did not open');
    document.getElementById('form-overlay')?.classList.remove('active');
    app.openSyncPanel();
    assertInPage(!!document.querySelector('.sync-center-modal'), 'sync center did not open');
    document.getElementById('form-overlay')?.classList.remove('active');
    app.openSettingsTab('visual');
    assertInPage(!!document.querySelector('[data-accent-picker]'), 'accent picker was not rendered');
    assertInPage(app.setAccentColor('#38BDF8'), 'valid accent color was rejected');
    const hex = document.querySelector('[data-accent-hex]');
    hex.value = 'NOPE';
    app.handleAccentInput(hex);
    assertInPage(document.querySelector('[data-accent-picker]').classList.contains('invalid'), 'invalid accent was not marked');
    assertInPage(app.state.settings.accent === '#38BDF8', 'invalid accent changed settings');
    assertInPage(app.commandPalette.buildCommands().some((item) => item.id === 'about-app'), 'about command is missing');

    return {
      docs: app.state.docs.length,
      lore: {
        characters: app.state.lore.characters.length,
        locations: app.state.lore.locations.length,
        timeline: app.state.lore.timeline.length,
      },
      accent: app.state.settings.accent,
    };
  });
}

async function main() {
  const server = await startServerIfNeeded();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 25_000 });
    await page.waitForFunction(() => !!window.nocturneApp?.state?.workspace, { timeout: 25_000 });
    const result = await runAppSmoke(page);
    await page.evaluate(() => window.nocturneApp.openSettingsTab('visual'));
    await page.waitForFunction(() => {
      const preloader = document.getElementById('preloader');
      if (!preloader) return true;
      const style = getComputedStyle(preloader);
      return preloader.classList.contains('hidden') && style.pointerEvents === 'none' && style.visibility === 'hidden';
    }, { timeout: 10_000 });
    await mkdir(path.join(ROOT, 'release', 'qa'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, 'release', 'qa', 'desktop-settings-accent.png'), fullPage: false });
    assert(errors.length === 0, `Console/page errors: ${errors.join('\n')}`);
    console.log(JSON.stringify({ ok: true, result, screenshot: 'release/qa/desktop-settings-accent.png' }, null, 2));
  } finally {
    await context.close();
    await browser.close();
    if (server) server.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
